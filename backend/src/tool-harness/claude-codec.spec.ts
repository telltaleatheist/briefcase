import { describe, expect, it } from '@jest/globals';
import { claudeCodec, functionCallsBlock } from './claude-codec';
import { nativeCodec } from './native-codec';
import { runToolLoop } from './loop';
import type { ChatMessage, Tool } from './types';

/** Claude's own tool-call format: tools and calls in the <function_calls> shape it was trained on. */

const invoke = (name: string, params: Record<string, string>) =>
  `<invoke name="${name}">\n${Object.entries(params).map(([k, v]) => `<parameter name="${k}">${v}</parameter>`).join('\n')}\n</invoke>`;
const calls = (...invokes: string[]) => `<function_calls>\n${invokes.join('\n')}\n</function_calls>`;

const tool: Tool = {
  name: 'add_marker',
  description: 'Place a marker.',
  parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  async execute(args) {
    return { content: `placed "${String(args['title'])}"`, data: args };
  },
};

describe('claudeCodec.toolsPrompt', () => {
  it("describes the tools and the call format as Claude's own", () => {
    const prompt = claudeCodec.toolsPrompt([tool]);
    expect(prompt).toContain('<function_calls>\n<invoke name="$FUNCTION_NAME">\n<parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</parameter>');
    expect(prompt).toContain(`<functions>\n<function>${JSON.stringify({ description: 'Place a marker.', name: 'add_marker', parameters: tool.parameters })}</function>\n</functions>`);
    expect(claudeCodec.definitions).toBeUndefined();
  });

  it('is the same text every time for the same tools (the prompt cache holds)', () => {
    expect(claudeCodec.toolsPrompt([tool])).toBe(claudeCodec.toolsPrompt([{ ...tool }]));
  });
});

describe('claudeCodec.parse', () => {
  it('no calls: all prose', () => {
    expect(claudeCodec.parse('Just an answer.')).toEqual({ prose: 'Just an answer.', calls: [] });
  });

  it('a block of several invokes, in order, cut from the prose', () => {
    const parsed = claudeCodec.parse(`Marking two.\n\n${calls(invoke('add_marker', { title: 'A' }), invoke('add_marker', { title: 'B "quoted"' }))}\n\nDone.`);
    expect(parsed).toEqual({
      prose: 'Marking two.\n\nDone.',
      calls: [{ ok: true, name: 'add_marker', args: { title: 'A' } }, { ok: true, name: 'add_marker', args: { title: 'B "quoted"' } }],
    });
  });

  it('a parameter is a string unless its text is a JSON object or array', () => {
    const parsed = claudeCodec.parse(calls(invoke('a', { n: '42', flag: 'true', list: '[1, 2]', obj: '{"k": "v"}', text: '  padded  ' })));
    expect(parsed.calls).toEqual([{ ok: true, name: 'a', args: { n: '42', flag: 'true', list: [1, 2], obj: { k: 'v' }, text: 'padded' } }]);
  });

  it('a block cut off at the end still counts, and a tag cut partway is never prose', () => {
    expect(claudeCodec.parse('Placing.\n<function_calls>\n<invoke name="add_marker">\n<parameter name="title">Cut')).toEqual({
      prose: 'Placing.', calls: [{ ok: true, name: 'add_marker', args: { title: 'Cut' } }],
    });
    expect(claudeCodec.parse('Placing.\n<function_calls>\n<inv')).toEqual({ prose: 'Placing.', calls: [] });
    expect(claudeCodec.parse('Placing.\n<function_calls>\n<invoke name="add_ma')).toEqual({ prose: 'Placing.', calls: [] });
    expect(claudeCodec.parse('Placing. <')).toEqual({ prose: 'Placing.', calls: [] });
    expect(claudeCodec.parse('So a < b')).toEqual({ prose: 'So a < b', calls: [] });
  });

  it('<tool_use> tags are still read as calls', () => {
    const parsed = claudeCodec.parse(`Here.\n<tool_use>\n${JSON.stringify({ name: 'a', arguments: { x: 1 } })}\n</tool_use>`);
    expect(parsed).toEqual({ prose: 'Here.', calls: [{ ok: true, name: 'a', args: { x: 1 } }] });
  });
});

describe('claudeCodec.results', () => {
  it('one <function_results> turn per round, each result named; an unreadable call is an <error>; the note after', () => {
    const [turn] = claudeCodec.results([{ ok: true, name: 'add_marker', args: {} }, { ok: false, reason: 'bad' }], ['placed "A"', "couldn't read that tool call: bad"], 'Finish now.');
    expect(turn).toEqual({
      role: 'user',
      content: '<function_results>\n<result>\n<tool_name>add_marker</tool_name>\n<stdout>\nplaced "A"\n</stdout>\n</result>\n'
        + "<error>\ncouldn't read that tool call: bad\n</error>\n</function_results>\n\nFinish now.",
    });
  });
});

describe('claudeCodec in the loop', () => {
  it('a Claude-format answer places its markers and ends on the reply without calls', async () => {
    const replies = [`Found it. ${calls(invoke('add_marker', { title: 'Trump' }))}`, 'It is "Trump".'];
    const sent: ChatMessage[][] = [];
    const result = await runToolLoop({
      transport: async (messages) => { sent.push(messages); return { text: replies[sent.length - 1] }; },
      tools: [tool], system: 'SYS', userMessage: 'Where?', codec: claudeCodec,
    });
    expect(result.finalText).toBe('Found it.\n\nIt is "Trump".');
    expect(result.toolCalls.map((c) => c.data)).toEqual([{ title: 'Trump' }]);
    expect(sent[0][0].content.startsWith('SYS\n\nIn this environment you have access to a set of tools')).toBe(true);
    expect(sent[1].at(-1)?.content).toContain('<tool_name>add_marker</tool_name>\n<stdout>\nplaced "Trump"\n</stdout>');
  });
});

describe('claudeCodec.replay', () => {
  it("its own trace replays as it is", () => {
    const trace: ChatMessage[] = [
      { role: 'assistant', content: `Here. ${calls(invoke('add_marker', { title: 'A' }))}` },
      { role: 'user', content: claudeCodec.responses([{ name: 'add_marker', content: 'placed "A"' }]) },
      { role: 'assistant', content: 'Done.' },
    ];
    expect(claudeCodec.replay(trace, 0)).toEqual(trace);
  });

  it('a native trace: calls become an <invoke> block after the text, the tool messages one named results turn', () => {
    const trace: ChatMessage[] = [
      { role: 'assistant', content: 'Here.', toolCalls: [{ id: 'c1', name: 'add_marker', arguments: '{"title":"A","n":2}' }, { id: 'c2', name: 'add_marker', arguments: '{"title":"B"}' }] },
      { role: 'tool', toolCallId: 'c1', content: 'placed "A"' },
      { role: 'tool', toolCallId: 'c2', content: 'placed "B"' },
      { role: 'assistant', content: 'Done.' },
    ];
    expect(claudeCodec.replay(trace, 0)).toEqual([
      { role: 'assistant', content: `Here.\n${functionCallsBlock([{ name: 'add_marker', args: { title: 'A', n: 2 } }, { name: 'add_marker', args: { title: 'B' } }])}` },
      { role: 'user', content: claudeCodec.responses([{ name: 'add_marker', content: 'placed "A"' }, { name: 'add_marker', content: 'placed "B"' }]) },
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(functionCallsBlock([{ name: 'a', args: { title: 'A', n: 2 } }])).toBe('<function_calls>\n<invoke name="a">\n<parameter name="title">A</parameter>\n<parameter name="n">2</parameter>\n</invoke>\n</function_calls>');
  });

  it('a tag trace: <tool_use> blocks become an <invoke> block, the <tool_result> turn a results turn; an unreadable call is dropped', () => {
    const trace: ChatMessage[] = [
      { role: 'assistant', content: `Here.\n<tool_use>\n{"name": "add_marker", "arguments": {"title": "A"}}\n</tool_use>\n<tool_use>\n{"name":\n</tool_use>` },
      { role: 'user', content: "<tool_result>\nplaced \"A\"\n</tool_result>\n<tool_result>\ncouldn't read that tool call\n</tool_result>\nNo more tool calls." },
      { role: 'assistant', content: 'Done.' },
    ];
    expect(claudeCodec.replay(trace, 0)).toEqual([
      { role: 'assistant', content: `Here.\n${functionCallsBlock([{ name: 'add_marker', args: { title: 'A' } }])}` },
      { role: 'user', content: claudeCodec.responses([{ name: 'add_marker', content: 'placed "A"' }], 'No more tool calls.') },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('a tag reply whose calls were never answered (past maxRounds): its prose alone', () => {
    const trace: ChatMessage[] = [{ role: 'assistant', content: 'Last.\n<tool_use>\n{"name": "add_marker", "arguments": {}}\n</tool_use>' }];
    expect(claudeCodec.replay(trace, 0)).toEqual([{ role: 'assistant', content: 'Last.' }]);
  });

  it('native replay reads a Claude-format trace back into structured calls', () => {
    const trace: ChatMessage[] = [
      { role: 'assistant', content: `Here. ${calls(invoke('add_marker', { title: 'A' }))}` },
      { role: 'user', content: claudeCodec.responses([{ name: 'add_marker', content: 'placed "A"' }]) },
      { role: 'assistant', content: 'Done.' },
    ];
    expect(nativeCodec.replay(trace, 3)).toEqual([
      { role: 'assistant', content: 'Here.', toolCalls: [{ id: 'replay_3_0', name: 'add_marker', arguments: '{"title":"A"}' }] },
      { role: 'tool', toolCallId: 'replay_3_0', content: 'placed "A"' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});
