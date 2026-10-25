import { describe, expect, it } from '@jest/globals';
import { LAST_ROUND_NOTE, runToolLoop } from './loop';
import { replayHistory } from './history';
import { nativeCodec, NOT_RUN_RESULT } from './native-codec';
import { tagCodec, toolUseBlock } from './tag-codec';
import type { ChatMessage, ChatTransport, NativeToolCall, Tool, TransportOptions, TransportReply } from './types';

/** The native format: tools as definitions, structured calls read, `tool` results by id, and either format's trace replayed into the other. */

const call = (id: string, name: string, args: unknown): NativeToolCall => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });

function scripted(replies: TransportReply[]): ChatTransport & { sent: ChatMessage[][]; opts: TransportOptions[] } {
  const sent: ChatMessage[][] = [];
  const opts: TransportOptions[] = [];
  const transport: ChatTransport = async (messages, o) => {
    sent.push(messages.map((m) => ({ ...m })));
    opts.push(o);
    const reply = replies[sent.length - 1];
    if (reply === undefined) throw new Error(`the script has no reply ${sent.length}`);
    return { ...reply, usage: { n: sent.length } };
  };
  return Object.assign(transport, { sent, opts });
}

const square: Tool<{ n: number }, number> = {
  name: 'square',
  description: 'Square a number.',
  parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
  async execute({ n }) {
    if (typeof n !== 'number') throw new Error('n must be a number');
    return { content: `${n * n}`, data: n * n };
  },
};

const run = (transport: ChatTransport, extra: Partial<Parameters<typeof runToolLoop>[0]> = {}) =>
  runToolLoop({ transport, tools: [square], system: 'SYSTEM', userMessage: 'Q', codec: nativeCodec, ...extra });

describe('runToolLoop with the native codec', () => {
  it('one call: the tools go as definitions (not in the prompt), the result goes back as a tool message by id', async () => {
    const t = scripted([{ text: '', toolCalls: [call('toolu_01', 'square', { n: 3 })] }, { text: 'Nine.' }]);
    const result = await run(t);
    expect(t.sent[0][0]).toEqual({ role: 'system', content: 'SYSTEM' });
    expect(t.opts[0].tools).toEqual([{ type: 'function', function: { name: 'square', description: 'Square a number.', parameters: square.parameters } }]);
    expect(t.sent[1].slice(2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [call('toolu_01', 'square', { n: 3 })] },
      { role: 'tool', toolCallId: 'toolu_01', content: '9' },
    ]);
    expect(result.finalText).toBe('Nine.');
    expect(result.toolCalls).toEqual([{ name: 'square', args: { n: 3 }, ok: true, content: '9', data: 9 }]);
    expect(result.trace.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(result.rounds).toBe(1);
  });

  it('several calls in one reply: each run in order, each answered under its own id; prose before the calls stays', async () => {
    const t = scripted([{ text: 'Working on it.', toolCalls: [call('a-1', 'square', { n: 3 }), call('chatcmpl-tool-2', 'square', { n: 4 })] }, { text: '9 and 16.' }]);
    const result = await run(t);
    expect(t.sent[1].slice(3)).toEqual([
      { role: 'tool', toolCallId: 'a-1', content: '9' },
      { role: 'tool', toolCallId: 'chatcmpl-tool-2', content: '16' },
    ]);
    expect(result.finalText).toBe('Working on it.\n\n9 and 16.');
    expect(result.toolCalls.map((c) => c.data)).toEqual([9, 16]);
  });

  it('arguments that are not JSON, or not an object, are answered with why, and the model may call again', async () => {
    const t = scripted([
      { text: '', toolCalls: [call('c1', 'square', '{"n": 3'), call('c2', 'square', '[3]')] },
      { text: '', toolCalls: [call('c3', 'square', '{"n": 3}')] },
      { text: 'Nine.' },
    ]);
    const result = await run(t);
    const [bad, notObject] = t.sent[1].slice(3);
    expect(bad).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    expect(bad.content).toMatch(/^couldn't read that tool call: its arguments are not valid JSON/);
    expect(notObject).toEqual({ role: 'tool', toolCallId: 'c2', content: 'couldn\'t read that tool call: "arguments" is not a JSON object' });
    expect(result.toolCalls.map((c) => c.ok)).toEqual([false, false, true]);
    expect(result.finalText).toBe('Nine.');
  });

  it('an unknown tool is answered with the tools there are; empty arguments read as {}', async () => {
    const t = scripted([{ text: '', toolCalls: [call('c1', 'cube', { n: 2 }), call('c2', 'square', '')] }, { text: 'Done.' }]);
    const result = await run(t);
    expect(t.sent[1].slice(3)).toEqual([
      { role: 'tool', toolCallId: 'c1', content: 'there is no tool named "cube"; the tools are: square' },
      { role: 'tool', toolCallId: 'c2', content: "couldn't run square: n must be a number" },
    ]);
    expect(result.toolCalls.map((c) => [c.name, c.ok])).toEqual([['cube', false], ['square', false]]);
  });

  it('stops after maxRounds: the last result carries the note, and the last reply\'s calls are answered "not run" in the trace', async () => {
    const t = scripted([
      { text: 'One.', toolCalls: [call('c1', 'square', { n: 1 })] },
      { text: 'Two.', toolCalls: [call('c2', 'square', { n: 2 })] },
      { text: 'Three.', toolCalls: [call('c3', 'square', { n: 3 })] },
    ]);
    const result = await run(t, { maxRounds: 2 });
    expect(t.sent).toHaveLength(3);
    expect(t.sent[2][t.sent[2].length - 1]).toEqual({ role: 'tool', toolCallId: 'c2', content: `4\n\n${LAST_ROUND_NOTE}` });
    expect(result.toolCalls).toHaveLength(2);
    expect(result.rounds).toBe(2);
    expect(result.finalText).toBe('One.\n\nTwo.\n\nThree.');
    expect(result.trace.slice(-2)).toEqual([
      { role: 'assistant', content: 'Three.', toolCalls: [call('c3', 'square', { n: 3 })] },
      { role: 'tool', toolCallId: 'c3', content: NOT_RUN_RESULT },
    ]);
  });

  it('no tools: no definitions are sent', async () => {
    const t = scripted([{ text: 'Hi.' }]);
    await runToolLoop({ transport: t, tools: [], system: 'SYSTEM', userMessage: 'Q', codec: nativeCodec });
    expect(t.opts[0].tools).toBeUndefined();
  });

  it('the tag codec sends no definitions', async () => {
    const t = scripted([{ text: 'Hi.' }]);
    await run(t, { codec: tagCodec });
    expect(t.opts[0].tools).toBeUndefined();
    expect(t.sent[0][0].content.startsWith('SYSTEM\n\n# Tools')).toBe(true);
  });
});

describe('replaying a trace in either format', () => {
  const tagTrace = (): ChatMessage[] => [
    { role: 'assistant', content: `Here: ${toolUseBlock('square', { n: 3 })}\n<tool_use>{"name": </tool_use>` },
    { role: 'user', content: `<tool_result>\n9\n</tool_result>\n<tool_result>\ncouldn't read that tool call: it is not a JSON object\n</tool_result>\n${LAST_ROUND_NOTE}` },
    { role: 'assistant', content: `Nine. ${toolUseBlock('square', { n: 4 })}` },
  ];

  it('an old tag-format turn replays as native: calls with made-up ids, results as tool messages, unreadable and unrun calls dropped, no tags left', async () => {
    const history = replayHistory([{ userMessage: 'Square 3', trace: tagTrace() }, { userMessage: 'Again', trace: tagTrace() }], nativeCodec);
    expect(history.slice(0, 4)).toEqual([
      { role: 'user', content: 'Square 3' },
      { role: 'assistant', content: 'Here:', toolCalls: [{ id: 'replay_0_0', name: 'square', arguments: '{"n":3}' }] },
      { role: 'tool', toolCallId: 'replay_0_0', content: `9\n\n${LAST_ROUND_NOTE}` },
      { role: 'assistant', content: 'Nine.' },
    ]);
    expect(history[5].toolCalls?.[0].id).toBe('replay_1_0');
    expect(history.some((m) => /<\/?tool_(use|result)>/.test(m.content))).toBe(false);

    // And the replayed turn is sent as it is in the next native answer.
    const t = scripted([{ text: 'Yes.' }]);
    await run(t, { history, userMessage: 'And?' });
    expect(t.sent[0].slice(1, 5)).toEqual(history.slice(0, 4));
  });

  it('a native trace passes through native replay untouched, and replays as tags for the tag codec', async () => {
    const first = await run(scripted([{ text: 'Here:', toolCalls: [call('toolu_9', 'square', { n: 3 })] }, { text: 'Nine.' }]));
    expect(nativeCodec.replay(first.trace, 0)).toEqual(first.trace);
    expect(replayHistory([{ userMessage: 'Square 3', trace: first.trace }]).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Square 3'],
      ['assistant', `Here:\n${toolUseBlock('square', { n: 3 })}`],
      ['user', '<tool_result>\n9\n</tool_result>'],
      ['assistant', 'Nine.'],
    ]);
  });

  it('a tag trace replays unchanged for the tag codec', () => {
    expect(tagCodec.replay(tagTrace(), 0)).toEqual(tagTrace());
  });
});
