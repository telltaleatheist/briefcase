import { describe, expect, it } from '@jest/globals';
import { LAST_ROUND_NOTE, runToolLoop, ToolLoopAborted } from './loop';
import { replayHistory } from './history';
import type { ChatMessage, ChatTransport, Tool, ToolLoopEvent } from './types';

/** The loop: replies, calls run by their tools, results back, bounded rounds, errors told to the model, abort. */

const tag = (name: string, args: unknown) => `<tool_use>\n${JSON.stringify({ name, arguments: args })}\n</tool_use>`;

function scripted(replies: string[]): ChatTransport & { sent: ChatMessage[][] } {
  const sent: ChatMessage[][] = [];
  const transport: ChatTransport = async (messages) => {
    sent.push(messages);
    const text = replies[sent.length - 1];
    if (text === undefined) throw new Error(`the script has no reply ${sent.length}`);
    return { text, usage: { n: sent.length } };
  };
  return Object.assign(transport, { sent });
}

const lastSent = (t: { sent: ChatMessage[][] }) => {
  const turn = t.sent[t.sent.length - 1];
  return turn[turn.length - 1].content;
};

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
  runToolLoop({ transport, tools: [square], system: 'SYSTEM', userMessage: 'Q', ...extra });

describe('runToolLoop', () => {
  it('a reply with no call is the answer: one model call, no rounds', async () => {
    const t = scripted(['Plain answer.']);
    const result = await run(t);
    expect(result).toEqual({ finalText: 'Plain answer.', toolCalls: [], trace: [{ role: 'assistant', content: 'Plain answer.' }], usage: [{ n: 1 }], rounds: 0 });
    expect(t.sent[0][0].content.startsWith('SYSTEM\n\n# Tools')).toBe(true);
    expect(t.sent[0].map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('calls are run, results go back as a user turn, the final prose is the answer, and events say so', async () => {
    const t = scripted([`Let me work it out. ${tag('square', { n: 3 })}${tag('square', { n: 4 })}`, '9 and 16.']);
    const events: ToolLoopEvent[] = [];
    const result = await run(t, { onEvent: (e) => events.push(e) });
    expect(result.finalText).toBe('Let me work it out.\n\n9 and 16.');
    expect(result.toolCalls).toEqual([
      { name: 'square', args: { n: 3 }, ok: true, content: '9', data: 9 },
      { name: 'square', args: { n: 4 }, ok: true, content: '16', data: 16 },
    ]);
    expect(lastSent(t)).toBe('<tool_result>\n9\n</tool_result>\n<tool_result>\n16\n</tool_result>');
    expect(result.trace.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(result.rounds).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['model-call', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'model-call', 'done']);
  });

  it('errors go back to the model, which may call again: unreadable, unknown tool, a tool that throws', async () => {
    const t = scripted(['<tool_use>{"name": </tool_use>', tag('cube', { n: 2 }), tag('square', { n: 'two' }), tag('square', { n: 2 }), 'Four.']);
    const result = await run(t, { maxRounds: 5 });
    const results = t.sent.slice(1).map((s) => s[s.length - 1].content);
    expect(results[0]).toBe("<tool_result>\ncouldn't read that tool call: it is not a JSON object\n</tool_result>");
    expect(results[1]).toBe('<tool_result>\nthere is no tool named "cube"; the tools are: square\n</tool_result>');
    expect(results[2]).toBe("<tool_result>\ncouldn't run square: n must be a number\n</tool_result>");
    expect(result.toolCalls.map((c) => c.ok)).toEqual([false, false, false, true]);
    expect(result.finalText).toBe('Four.');
  });

  it('stops after maxRounds: the last results say so, and calls in the last reply are not run', async () => {
    const t = scripted([`One. ${tag('square', { n: 1 })}`, `Two. ${tag('square', { n: 2 })}`, `Three. ${tag('square', { n: 3 })}`]);
    const result = await run(t, { maxRounds: 2 });
    expect(t.sent).toHaveLength(3);
    expect(lastSent(t)).toBe(`<tool_result>\n4\n</tool_result>\n${LAST_ROUND_NOTE}`);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.rounds).toBe(2);
    expect(result.finalText).toBe('One.\n\nTwo.\n\nThree.');
  });

  it('a last reply of only calls: the answer is the earlier prose', async () => {
    const result = await run(scripted([`Working. ${tag('square', { n: 1 })}`, tag('square', { n: 2 })]), { maxRounds: 1 });
    expect(result.finalText).toBe('Working.');
  });

  it('the answer keeps the prose written before a call, then the prose after the results', async () => {
    const result = await run(scripted([`Here are the squares:\n${tag('square', { n: 3 })}`, 'Those are all of them.']));
    expect(result.finalText).toBe('Here are the squares:\n\nThose are all of them.');
  });

  it('no tools: no tools section, and tags are not run', async () => {
    const t = scripted(['Hi.']);
    await runToolLoop({ transport: t, tools: [], system: 'SYSTEM', userMessage: 'Q' });
    expect(t.sent[0][0].content).toBe('SYSTEM');
  });

  it('an abort before or during the loop rejects with ToolLoopAborted, and the signal reaches transport and tool', async () => {
    const before = new AbortController();
    before.abort();
    await expect(run(scripted(['x']), { signal: before.signal })).rejects.toBeInstanceOf(ToolLoopAborted);

    const during = new AbortController();
    let seen: AbortSignal | undefined;
    const slow: Tool = {
      name: 'slow', description: '', parameters: {},
      async execute(_args, ctx) {
        seen = ctx.signal;
        during.abort(new Error('user left'));
        return { content: 'late' };
      },
    };
    const t = scripted([tag('slow', {}), 'never']);
    const aborted = runToolLoop({ transport: t, tools: [slow], system: 'S', userMessage: 'Q', signal: during.signal });
    await expect(aborted).rejects.toThrow('user left');
    expect(seen).toBe(during.signal);
    expect(t.sent).toHaveLength(1);
  });

  it('replayed history sits between the system prompt and the user message', async () => {
    const t = scripted(['Again: 9.']);
    const first = await run(scripted([tag('square', { n: 3 }), 'Nine.']));
    await run(t, { history: replayHistory([{ userMessage: 'Square 3', trace: first.trace }]), userMessage: 'And again?' });
    expect(t.sent[0].slice(1).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Square 3'],
      ['assistant', tag('square', { n: 3 })],
      ['user', '<tool_result>\n9\n</tool_result>'],
      ['assistant', 'Nine.'],
      ['user', 'And again?'],
    ]);
  });
});
