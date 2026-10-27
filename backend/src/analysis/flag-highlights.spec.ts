import { describe, expect, it } from '@jest/globals';
import {
  findHighlights,
  highlightReason,
  highlightsSystemPrompt,
  highlightTool,
  highlightWindows,
  HIGHLIGHT_MAX_SPAN_SECONDS,
  padHighlights,
  perWindowTokens,
  planTranscript,
  wholeTranscriptTokens,
  withMargin,
  type HighlightMarker,
  type HighlightToolState,
} from './flag-highlights';
import { buildWindowQuestion } from './prompts/flag-highlights-prompts';
import { claudeCodec, nativeCodec, tagCodec, type ChatMessage, type ToolCallCodec, type TransportReply } from '../tool-harness';
import type { RankedSentence } from './flag-windows';

/** The flag stage's finder: windows, the tool's guards, padding, and how the transcript is sent. */

/** `n` sentences, `every` seconds apart, each `every` long, with distinct words. */
function sentences(n: number, every = 10): RankedSentence[] {
  return Array.from({ length: n }, (_u, i) => ({ start: i * every, end: (i + 1) * every, text: `sentence number ${i} says word${i} alpha${i} beta${i} gamma${i}.` }));
}

const quote = (i: number) => `sentence number ${i} says word${i}`;
const tail = (i: number) => `alpha${i} beta${i} gamma${i}`;
const CATS = [{ name: 'hate', description: 'Hostility.' }, { name: 'conspiracy', description: 'Plots.' }, { name: 'off', enabled: false }];

describe('highlightWindows', () => {
  it('cuts the sentences into stretches of at most the window, never splitting a sentence', () => {
    const s = sentences(200); // 2,000 s
    const w = highlightWindows(s, 900);
    expect(w).toEqual([{ from: 0, to: 89 }, { from: 90, to: 179 }, { from: 180, to: 199 }]);
    expect(highlightWindows([{ start: 0, end: 2000, text: 'one long one' }], 900)).toEqual([{ from: 0, to: 0 }]);
  });

  it('a margin is whole sentences within a minute on each side, clipped at the ends', () => {
    const s = sentences(200);
    expect(withMargin(s, { from: 90, to: 179 }, 60)).toEqual({ from: 84, to: 185 });
    expect(withMargin(s, { from: 0, to: 89 }, 60)).toEqual({ from: 0, to: 95 });
  });
});

describe('planTranscript: the whole transcript when it fits, else one stretch per question', () => {
  const s = sentences(1200); // 200 minutes, ~50 characters a sentence
  it('whole when the context holds it', () => {
    const plan = planTranscript(s, 20000, 200000)!;
    expect(plan.mode).toBe('whole');
    expect(plan.windowSeconds).toBe(900);
    expect(plan.neededTokens).toBe(wholeTranscriptTokens(20000, s));
  });

  it('per stretch when it does not, at 15 minutes when that fits', () => {
    const plan = planTranscript(s, 20000, 32768)!;
    expect(plan.mode).toBe('window');
    expect(plan.windowSeconds).toBe(900);
    expect(perWindowTokens(20000, s, 900)).toBeLessThanOrEqual(32768);
  });

  it('smaller stretches for a small context; null when not even 3 minutes fit', () => {
    const small = planTranscript(s, 20000, perWindowTokens(20000, s, 225))!;
    expect(small.mode).toBe('window');
    expect(small.windowSeconds).toBeLessThan(900);
    expect(planTranscript(s, 20000, 8000)).toBeNull();
  });
});

describe('the add_marker tool and its guards', () => {
  const s = sentences(200);
  const state = (): HighlightToolState => ({ sentences: s, categoryNames: ['hate', 'conspiracy'], placed: [] });
  const call = (tool: ReturnType<typeof highlightTool>, args: Record<string, unknown>) => tool.execute(args, {});

  it('places a quoted moment at its sentences\' times and records it', async () => {
    const st = state();
    const tool = highlightTool(st, { from: 90, to: 179 });
    const result = await call(tool, { title: 'A', category: 'Hate', why: 'w', first_words: quote(100), last_words: tail(103) });
    expect(result.data).toEqual({ from: 100, to: 103, start: 1000, end: 1040, title: 'A', category: 'hate', why: 'w' });
    expect(result.content).toBe('placed "A" at 00:16:40–00:17:20');
    expect(st.placed).toHaveLength(1);
  });

  it('refuses words found minutes apart (more than 8), a moment mostly on top of one placed, and one outside the stretch', async () => {
    const big = sentences(200, 6); // the stretch's margin reaches far enough to test the span guard
    const st: HighlightToolState = { sentences: big, categoryNames: ['hate'], placed: [] };
    const tool = highlightTool(st, { from: 0, to: 199 }, { from: 0, to: 199 });
    const far = await call(tool, { title: 'Far', category: 'hate', why: '', first_words: quote(1), last_words: tail(1 + HIGHLIGHT_MAX_SPAN_SECONDS / 6 + 2) });
    expect(far.data).toBeUndefined();
    expect(far.content).toMatch(/minutes apart/);
    await call(tool, { title: 'First', category: 'hate', why: '', first_words: quote(10), last_words: tail(19) });
    const twin = await call(tool, { title: 'Again', category: 'hate', why: '', first_words: quote(12), last_words: tail(20) });
    expect(twin.data).toBeUndefined();
    expect(twin.content).toMatch(/"First" is already placed/);
    const beside = await call(tool, { title: 'Beside', category: 'hate', why: '', first_words: quote(18), last_words: tail(30) });
    expect(beside.data).toBeDefined();

    const st2 = state();
    const narrow = highlightTool(st2, { from: 90, to: 120 }, { from: 0, to: 199 });
    const outside = await call(narrow, { title: 'Out', category: 'hate', why: '', first_words: quote(150), last_words: tail(152) });
    expect(outside.content).toMatch(/outside this stretch/);
  });

  it('quotes are found only in the stretch and its margin; an unknown category or missing words are refused by name', async () => {
    const tool = highlightTool(state(), { from: 90, to: 120 });
    expect((await call(tool, { title: 'Elsewhere', category: 'hate', why: '', first_words: quote(5), last_words: tail(6) })).content).toMatch(/could not find/);
    await expect(call(tool, { title: 'X', category: 'violence', why: '', first_words: quote(95), last_words: tail(96) })).rejects.toThrow(/not a category; use one of: hate, conspiracy/);
    await expect(call(tool, { title: 'X', category: 'hate' })).rejects.toThrow(/no first_words, last_words/);
  });

  it('the tool definition is the same for every stretch (the prompt cache holds)', () => {
    const st = state();
    const a = highlightTool(st, { from: 0, to: 10 });
    const b = highlightTool(st, { from: 90, to: 179 });
    expect(JSON.stringify([a.name, a.description, a.parameters])).toBe(JSON.stringify([b.name, b.description, b.parameters]));
  });
});

describe('padHighlights', () => {
  const s = sentences(100, 5); // 5-second sentences
  const marker = (from: number, to: number): HighlightMarker => ({ from, to, start: s[from].start, end: s[to].end, title: 't', category: 'hate', why: '' });

  it('a short marker grows to 30 s by whole sentences, leaning on the lead-in (two before for each one after)', () => {
    const [p] = padHighlights([marker(50, 50)], s);
    expect(p.end - p.start).toBeGreaterThanOrEqual(30);
    expect(50 - p.from).toBe(4);
    expect(p.to - 50).toBe(1);
  });

  it('never into a neighbour, never past the ends; a long marker is left as it is', () => {
    const out = padHighlights([marker(20, 20), marker(21, 21), marker(0, 0), marker(60, 80)], s);
    expect(out.map((m) => [m.from, m.to])).toEqual([[0, 5], [15, 20], [21, 26], [60, 80]]);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
  });
});

/** A scripted model: each reply is text in the codec's format, or a function of the request. */
function scripted(replies: Array<string | ((messages: ChatMessage[]) => TransportReply)>) {
  const requests: ChatMessage[][] = [];
  const transport = async (messages: ChatMessage[]) => {
    requests.push(messages);
    const next = replies[requests.length - 1] ?? 'Nothing more here.';
    return typeof next === 'string' ? { text: next } : next(messages);
  };
  return { transport, requests };
}
const invoke = (args: Record<string, string>) =>
  `<function_calls>\n<invoke name="add_marker">\n${Object.entries(args).map(([k, v]) => `<parameter name="${k}">${v}</parameter>`).join('\n')}\n</invoke>\n</function_calls>`;

describe('findHighlights', () => {
  const s = sentences(200); // 2,000 s: three stretches of 15 minutes
  const input = (mode: 'whole' | 'window') => ({ sentences: s, categories: CATS, videoTitle: 'Test video', plan: { mode, windowSeconds: 900 } });

  it('one fresh question per stretch over one system prompt; markers padded and in time order', async () => {
    const { transport, requests } = scripted([
      `<candidates>1. something</candidates>\n${invoke({ title: 'Late', category: 'conspiracy', why: 'a plot', first_words: quote(60), last_words: tail(61) })}`,
      'Late',
      'Nothing clip-worthy in this stretch.',
      invoke({ title: 'Early', category: 'hate', why: 'hostile', first_words: quote(185), last_words: tail(190) }),
      'Early',
    ]);
    const result = await findHighlights(input('whole'), { transport, codec: claudeCodec });
    expect(result.windows).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.markers.map((m) => [m.title, m.category, m.start, m.end])).toEqual([['Late', 'conspiracy', 590, 620], ['Early', 'hate', 1850, 1910]]);
    // Every question has the same system prompt, the whole transcript in it, and no history from the stretches before.
    const firstOf = requests.filter((r) => r.length === 2);
    expect(firstOf).toHaveLength(3);
    expect(new Set(firstOf.map((r) => r[0].content)).size).toBe(1);
    expect(firstOf[0][0].content).toContain('TRANSCRIPT:\n' + s[0].text);
    expect(firstOf[0][0].content).toContain('- hate: Hostility.');
    expect(firstOf[0][0].content).not.toContain('- off');
    expect(firstOf[1][1].content).toContain(`from the sentence "${s[90].text}" to the sentence "${s[179].text}"`);
    expect(firstOf[1][1].content).not.toContain('STRETCH:');
  });

  it('per stretch: no transcript in the system prompt; each question carries its stretch and a minute each side', async () => {
    const { transport, requests } = scripted([]);
    await findHighlights(input('window'), { transport, codec: claudeCodec });
    expect(requests[0][0].content).not.toContain('TRANSCRIPT:');
    const second = requests[1][1].content;
    expect(second).toContain(`STRETCH:\n${s[90].text}`);
    expect(second).toContain(`CONTEXT BEFORE THE STRETCH`);
    expect(second).toContain(s[84].text);
    expect(second).not.toContain(s[83].text);
    expect(second).toContain(s[185].text);
  });

  it('each codec: tags and native calls are read the same way', async () => {
    for (const codec of [tagCodec, nativeCodec] as ToolCallCodec[]) {
      const args = { title: 'T', category: 'hate', why: 'w', first_words: quote(10), last_words: tail(12) };
      const reply = codec === nativeCodec
        ? { text: '', toolCalls: [{ id: 'c1', name: 'add_marker', arguments: JSON.stringify(args) }] }
        : { text: `<tool_use>\n${JSON.stringify({ name: 'add_marker', arguments: args })}\n</tool_use>` };
      const { transport } = scripted([() => reply, 'done']);
      const result = await findHighlights(input('whole'), { transport, codec });
      expect(result.markers.map((m) => m.title)).toEqual(['T']);
    }
  });

  it('a failed stretch is named and skipped; every stretch failing throws; a stop stops it as it is', async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 1) throw new Error('model fell over');
      return { text: 'nothing' };
    };
    const result = await findHighlights(input('whole'), { transport: flaky, codec: claudeCodec });
    expect(result.failed).toEqual([expect.stringMatching(/^stretch 1 \(00:00:00-00:15:00\): model fell over$/)]);
    await expect(findHighlights(input('whole'), { transport: async () => { throw new Error('down'); }, codec: claudeCodec }))
      .rejects.toThrow(/all 3 failed. Last failure: stretch 3 .*: down/);
    const stop = new Error('parked');
    await expect(findHighlights(input('whole'), { transport: async () => { throw stop; }, codec: claudeCodec, stops: (e) => e === stop }))
      .rejects.toBe(stop);
  });

  it('no enabled category or no sentences: nothing asked', async () => {
    const { transport, requests } = scripted([]);
    expect((await findHighlights({ ...input('whole'), categories: [{ name: 'x', enabled: false }] }, { transport, codec: claudeCodec })).markers).toEqual([]);
    expect((await findHighlights({ ...input('whole'), sentences: [] }, { transport, codec: claudeCodec })).windows).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('a range run: only the range\'s sentences are asked about, and markers stay on the real timeline', async () => {
    const range = s.slice(100, 150); // 1000-1500 s
    const { transport, requests } = scripted([invoke({ title: 'In range', category: 'hate', why: '', first_words: quote(120), last_words: tail(125) }), 'ok']);
    const result = await findHighlights({ ...input('whole'), sentences: range }, { transport, codec: claudeCodec });
    expect(result.windows).toBe(1);
    expect(result.markers.map((m) => [m.start, m.end])).toEqual([[1200, 1260]]);
    expect(requests[0][0].content).not.toContain(s[99].text);
  });
});

describe('prompts and rows', () => {
  it('the system prompt has the categories and the examples, and the scan names this stretch', () => {
    const prompt = highlightsSystemPrompt({ sentences: sentences(3), categories: CATS, videoTitle: 'V' }, 'window');
    expect(prompt).toContain('The video is "V". Its transcript is sent with each question');
    expect(prompt).toContain('A 23-second clip of a self-styled prophet');
    expect(prompt).toContain('go through this stretch once');
    expect(buildWindowQuestion({ first: 'a', last: 'b', minutes: 14.6, parts: 3 })).toContain('the video is split into 3 parts');
  });

  it('a row\'s reason is the title, then why', () => {
    expect(highlightReason({ title: 'Calls them demons', why: 'Dehumanizes voters.' })).toBe('Calls them demons — Dehumanizes voters.');
    expect(highlightReason({ title: 'Just a title', why: '' })).toBe('Just a title');
  });
});
