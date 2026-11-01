import { describe, expect, it } from '@jest/globals';
import { LAST_ROUND_NOTE, repeatedCallResult, runToolLoop, ToolLoopAborted, ToolLoopContextFull } from './loop';
import { nativeCodec } from './native-codec';
import { replayHistory } from './history';
import type { ChatMessage, ChatTransport, Tool, ToolLoopEvent } from './types';

/** The loop: replies, calls run by their tools, results back, the round ceiling, repeats, errors told to the model, abort, and the context budget. */

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
    expect(result).toEqual({ finalText: 'Plain answer.', toolCalls: [], trace: [{ role: 'assistant', content: 'Plain answer.' }], usage: [{ n: 1 }], rounds: 0, cuts: 0 });
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

  it('runs until a reply makes no call: many rounds under a high ceiling, no last-round note before it', async () => {
    const replies = Array.from({ length: 12 }, (_u, i) => tag('square', { n: i + 1 }));
    const t = scripted([...replies, 'Done.']);
    const result = await run(t, { maxRounds: 100 });
    expect(result.rounds).toBe(12);
    expect(result.finalText).toBe('Done.');
    expect(t.sent.every((turn) => !turn.some((m) => m.content.includes(LAST_ROUND_NOTE)))).toBe(true);
  });

  it('an identical call whose result the model still has is not run again: it is told so, pointedly', async () => {
    let runs = 0;
    const counted: Tool<{ n: number }, number> = { ...square, async execute(args, ctx) { runs += 1; return square.execute(args, ctx); } };
    // The same call again, with its keys in another order, and beside a new one.
    const t = scripted([tag('square', { n: 3 }), `${tag('square', { n: 3 })}${tag('square', { n: 4 })}`, 'Nine and sixteen.']);
    const result = await runToolLoop({ transport: t, tools: [counted], system: 'S', userMessage: 'Q' });
    expect(runs).toBe(2);
    expect(result.toolCalls.map((c) => [c.ok, c.content])).toEqual([[true, '9'], [false, repeatedCallResult('square')], [true, '16']]);
    const keys: Tool = { name: 'pair', description: '', parameters: {}, async execute() { runs += 1; return { content: 'ok' }; } };
    runs = 0;
    await runToolLoop({ transport: scripted([tag('pair', { a: 1, b: 2 }), tag('pair', { b: 2, a: 1 }), 'x']), tools: [keys], system: 'S', userMessage: 'Q' });
    expect(runs).toBe(1);
  });

  it("the host's note follows every round's results, read after the round ran", async () => {
    let calls = 0;
    const t = scripted([tag('square', { n: 2 }), tag('square', { n: 5 }), 'End.']);
    await run(t, { resultsNote: () => `after ${(calls += 1)} round(s)` });
    expect(t.sent[1][t.sent[1].length - 1].content).toBe('<tool_result>\n4\n</tool_result>\nafter 1 round(s)');
    expect(t.sent[2][t.sent[2].length - 1].content).toBe('<tool_result>\n25\n</tool_result>\nafter 2 round(s)');
  });

  describe('the context budget', () => {
    /** A page tool: 1,000 characters a page, droppable first; a search-like one, dropped next; and a marker tool whose results are never dropped. */
    const page: Tool<{ n: number }> = {
      name: 'page', description: '', parameters: {}, dropOrder: 0,
      async execute({ n }) { return { content: `page ${n} ${'x'.repeat(990)}` }; },
    };
    const hit: Tool<{ q: string }> = {
      name: 'hit', description: '', parameters: {}, dropOrder: 1,
      async execute({ q }) { return { content: `hit ${q} ${'y'.repeat(190)}` }; },
    };
    const mark: Tool<{ n: number }> = { name: 'mark', description: '', parameters: {}, async execute({ n }) { return { content: `marked ${n}` }; } };
    const size = (messages: ChatMessage[]) => messages.reduce((sum, m) => sum + m.content.length, 0);

    async function reading(pages: number, budget: number, extra: Partial<Parameters<typeof runToolLoop>[0]> = {}) {
      const replies = Array.from({ length: pages }, (_u, i) => `${tag('page', { n: i + 1 })}${tag('mark', { n: i + 1 })}`);
      const t = scripted([...replies, 'Read it all.']);
      const result = await runToolLoop({
        transport: t, tools: [page, hit, mark], system: 'S', userMessage: 'Q', maxRounds: 100,
        context: { tokens: budget, charsPerToken: 1, droppedNote: '[dropped]' }, ...extra,
      });
      return { t, result };
    }

    it('never sends a request over the budget: the oldest pages are dropped, the markers kept', async () => {
      const { t, result } = await reading(12, 5000);
      expect(t.sent.every((messages) => size(messages) <= 5000)).toBe(true);
      expect(result.cuts).toBeGreaterThan(0);
      const last = t.sent[t.sent.length - 1].map((m) => m.content).join('\n');
      expect(last).toContain('page 12 ');
      expect(last).not.toContain('page 1 ');
      for (let n = 1; n <= 12; n++) expect(last).toContain(`marked ${n}`);
      expect(last).toContain('[dropped]');
    });

    it('cuts deep, in one step: several old rounds at once, then requests only append until the next cut', async () => {
      const { t, result } = await reading(12, 5000);
      // Between cuts every request starts with the one before it, byte for byte.
      let appendOnly = 0;
      for (let i = 1; i < t.sent.length; i++) {
        const before = t.sent[i - 1];
        const same = before.every((m, k) => t.sent[i][k]?.content === m.content);
        if (same) appendOnly += 1;
      }
      expect(appendOnly).toBe(t.sent.length - 1 - result.cuts);
      // Fewer cuts than rounds: each one dropped several pages.
      expect(result.cuts).toBeLessThan(12 / 2);
      const droppedAtFirstCut = (() => {
        for (const messages of t.sent) {
          const n = messages.filter((m) => m.content.includes('[dropped]')).length;
          if (n > 0) return messages.map((m) => m.content).join('').split('[dropped]').length - 1;
        }
        return 0;
      })();
      expect(droppedAtFirstCut).toBeGreaterThan(1);
    });

    it('pages go before searches: a search survives while an older page is dropped', async () => {
      const t = scripted([tag('hit', { q: 'a' }), tag('page', { n: 1 }), tag('page', { n: 2 }), tag('page', { n: 3 }), tag('page', { n: 4 }), 'Done.']);
      await runToolLoop({ transport: t, tools: [page, hit, mark], system: 'S', userMessage: 'Q', maxRounds: 100, context: { tokens: 5000, charsPerToken: 1 } });
      const last = t.sent[t.sent.length - 1].map((m) => m.content).join('\n');
      expect(last).toContain('hit a ');
      expect(last).not.toContain('page 1 ');
    });

    it('a dropped page can be read again: the identical call then runs', async () => {
      let runs = 0;
      const counted: Tool<{ n: number }> = { ...page, async execute(args, ctx) { runs += 1; return page.execute(args, ctx); } };
      const t = scripted([tag('page', { n: 1 }), tag('page', { n: 2 }), tag('page', { n: 3 }), tag('page', { n: 4 }), tag('page', { n: 1 }), 'Done.']);
      const result = await runToolLoop({ transport: t, tools: [counted], system: 'S', userMessage: 'Q', maxRounds: 100, context: { tokens: 3200, charsPerToken: 1 } });
      expect(runs).toBe(5);
      expect(result.toolCalls.every((c) => c.ok)).toBe(true);
    });

    it("the stored trace keeps droppable results only as the note; markers' results whole", async () => {
      const { result } = await reading(2, 100_000);
      const text = result.trace.map((m) => m.content).join('\n');
      expect(text).not.toContain('page 1 ');
      expect(text).toContain('[dropped]');
      expect(text).toContain('marked 2');
    });

    it('measures with the reported usage, and estimates only what was added since', async () => {
      const sent: ChatMessage[][] = [];
      const replies = [tag('page', { n: 1 }), tag('page', { n: 2 }), 'Done.'];
      // The model API counts this conversation as far bigger than its characters: the loop believes it.
      const transport: ChatTransport = async (messages) => {
        sent.push(messages);
        return { text: replies[sent.length - 1], usage: { prompt: sent.length === 1 ? 1300 : 99999, completion: 10 } };
      };
      await expect(runToolLoop({
        transport, tools: [page], system: 'S', userMessage: 'Q',
        context: { tokens: 1500, charsPerToken: 1, usageTokens: (u) => u as { prompt: number; completion: number } },
      })).rejects.toBeInstanceOf(ToolLoopContextFull);
      // Under the characters alone the second request (about 500) would have gone; measured, 1300 + 10 + ~430 did not.
      expect(sent).toHaveLength(1);
    });

    it('nothing left to drop and still over: ToolLoopContextFull, never an oversized request', async () => {
      const t = scripted([tag('mark', { n: 1 }), tag('mark', { n: 2 }), 'x']);
      await expect(runToolLoop({ transport: t, tools: [mark], system: 'S'.repeat(500), userMessage: 'Q', context: { tokens: 560, charsPerToken: 1 } }))
        .rejects.toBeInstanceOf(ToolLoopContextFull);
      expect(t.sent.every((messages) => size(messages) <= 560)).toBe(true);
    });

    it('native: a dropped result is its tool message with the note, the call id kept', async () => {
      const sent: ChatMessage[][] = [];
      const calls = [1, 2, 3, 4].map((n) => ({ text: '', toolCalls: [{ id: `c${n}`, name: 'page', arguments: JSON.stringify({ n }) }] }));
      const transport: ChatTransport = async (messages) => {
        sent.push(messages);
        return calls[sent.length - 1] ?? { text: 'Done.' };
      };
      await runToolLoop({ transport, tools: [page], system: 'S', userMessage: 'Q', codec: nativeCodec, maxRounds: 100, context: { tokens: 3200, charsPerToken: 1, droppedNote: '[dropped]' } });
      const last = sent[sent.length - 1];
      expect(last.find((m) => m.role === 'tool' && m.toolCallId === 'c1')?.content).toBe('[dropped]');
      expect(last.find((m) => m.role === 'tool' && m.toolCallId === 'c4')?.content).toMatch(/^page 4 /);
    });
  });
});
