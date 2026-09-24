import { describe, expect, it } from '@jest/globals';

import { PLUG, assignInstructions, clip, outlinePrompt, plugStatement } from './snap-prompts';
import {
  LOG_FLOOR,
  OutlineError,
  REJECTED,
  assignOptions,
  assignQuestions,
  boundaries,
  confirmPlugs,
  logRow,
  parseOutline,
  pathPieces,
  piecesToChapters,
  toAnalysisChapters,
} from './segmenter';

describe('outline prompt and parsing', () => {
  it('builds the segment.py prompt verbatim', () => {
    expect(outlinePrompt('One.\nTwo.')).toBe(
      'Here is a transcript of a video.\n\nOne.\nTwo.\n\nList the sections of this video in the order they happen. ' +
        'A new section starts wherever the video moves to a different subject, story, clip, ad or aside. ' +
        'Write one short, specific label per line (at most 25 lines), with no numbering and nothing else.',
    );
  });

  it('strips bullets, drops empties, dedupes case-insensitively and keeps order', () => {
    const content = '- Intro and greeting\n\n* The tax story \n• intro and greeting\n\tListener mail\t\n  -  \nThe Tax Story';
    expect(parseOutline(content)).toEqual(['Intro and greeting', 'The tax story', 'Listener mail']);
  });

  it('handles \\r\\n and strips trailing bullet characters like Python strip()', () => {
    expect(parseOutline('Alpha -\r\nBeta*\r\n')).toEqual(['Alpha', 'Beta']);
  });

  it('caps at max items after de-duplication', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
    const items = parseOutline(['Item 0', ...lines].join('\n'));
    expect(items).toHaveLength(25);
    expect(items[0]).toBe('Item 0');
    expect(items[24]).toBe('Item 24');
    expect(parseOutline(lines.join('\n'), 3)).toEqual(['Item 0', 'Item 1', 'Item 2']);
  });

  it('defensively removes numbering and markdown bold, and clips long labels', () => {
    const long = 'x'.repeat(200);
    expect(parseOutline(`1. **Opening**\n2) The 1990s recap\n${long}`)).toEqual([
      'Opening',
      'The 1990s recap',
      'x'.repeat(119) + '…',
    ]);
  });

  it('a one-item outline is an answer (a single-topic video), not an error', () => {
    expect(parseOutline('Only one\nonly ONE\n')).toEqual(['Only one']);
  });

  it('throws OutlineError only when no item is usable', () => {
    expect(() => parseOutline('')).toThrow(OutlineError);
    expect(() => parseOutline('  \n - \n**\n')).toThrow(/no items/);
  });
});

describe('assign questions', () => {
  it('matches segment.py text exactly, quoting the sentence and the one before it', () => {
    expect(assignInstructions('Now to the weather.', 'That was the news.')).toBe(
      'Sentence from the transcript above: "Now to the weather."\n' +
        '(The sentence just before it: "That was the news.")\n' +
        'Which section of the video is this sentence part of?',
    );
  });

  it('clips the sentence at 300 and the previous one at 200 code points with an ellipsis', () => {
    const s = 'a'.repeat(301);
    const p = 'b'.repeat(250);
    const q = assignInstructions(s, p);
    expect(q).toContain(`"${'a'.repeat(299)}…"`);
    expect(q).toContain(`"${'b'.repeat(199)}…"`);
    expect(clip('a'.repeat(300), 300)).toBe('a'.repeat(300));
    expect(clip('😀'.repeat(5), 3)).toBe('😀😀…');
  });

  it('uses "(start of the video)" for the first sentence, or the chunk predecessor', () => {
    const opts = assignOptions(['Intro', 'Main', PLUG]);
    expect(opts).toEqual([
      { name: 'section 1', description: 'Intro' },
      { name: 'section 2', description: 'Main' },
      { name: 'section 3', description: PLUG },
    ]);
    const texts = ['First one here.', 'Second one here.'];
    const qs = assignQuestions(texts, 0, 2, opts);
    expect(qs.map((q) => q.name)).toEqual(['s0', 's1']);
    expect(qs[0].instructions).toContain('(The sentence just before it: "(start of the video)")');
    expect(qs[1].instructions).toContain('(The sentence just before it: "First one here.")');
    expect(qs[0].options).toBe(opts);
    const mid = assignQuestions(texts, 0, 1, opts, 'Earlier sentence.');
    expect(mid[0].instructions).toContain('(The sentence just before it: "Earlier sentence.")');
  });

  it('floors log P at log(1e-12)', () => {
    expect(logRow([Math.log(0.5), -40, -Infinity])).toEqual([Math.log(0.5), LOG_FLOOR, LOG_FLOOR]);
  });

  it('builds the plug statement verbatim, passage clipped at 700', () => {
    expect(plugStatement(['Use code X.', 'Thanks to our sponsor.'])).toBe(
      'Passage from the transcript above: "Use code X. Thanks to our sponsor."\n' +
        'In this passage the speaker is advertising or promoting something: a sponsor, their own Patreon, ' +
        'merch, a book, or asking viewers to subscribe, follow or support them.',
    );
    expect(plugStatement(['z'.repeat(800)])).toContain(`"${'z'.repeat(699)}…"`);
  });
});

/** An L matrix from preferred items: 0.999 on the preferred, the rest shared (~7.6 nats a unit at m = 3). */
function matrix(prefs: number[], m: number): number[][] {
  return prefs.map((j) => Array.from({ length: m }, (_, k) => Math.log(k === j ? 0.999 : 0.001 / (m - 1))));
}

describe('confirmPlugs', () => {
  // items: 0 = topic A, 1 = topic B, 2 = plug
  const prefs = [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1];

  it('keeps a confirmed ad stretch and asks about it once', async () => {
    const asked: Array<[number, number]> = [];
    const { path, verdicts } = await confirmPlugs(matrix(prefs, 3), 2, 20, async (a, b) => {
      asked.push([a, b]);
      return 0.9;
    });
    expect(asked).toEqual([[8, 16]]);
    expect(verdicts).toEqual([{ start: 8, end: 16, p: 0.9 }]);
    expect(path).toEqual(prefs);
  });

  it('re-runs without the ad option when a stretch is rejected, and does not mutate L', async () => {
    const L = matrix(prefs, 3);
    // Units 8-15, second choice: topic A for the first half, B for the second.
    for (let i = 8; i < 12; i++) L[i][0] = Math.log(0.0009);
    for (let i = 12; i < 16; i++) L[i][1] = Math.log(0.0009);
    const asked: Array<[number, number]> = [];
    const res = await confirmPlugs(L, 2, 20, async (a, b) => {
      asked.push([a, b]);
      return 0.2;
    });
    expect(asked).toEqual([[8, 16]]);
    expect(res.path.includes(2)).toBe(false);
    expect(res.logProbs[10][2]).toBe(REJECTED);
    expect(L[10][2]).toBe(Math.log(0.999));
    expect(boundaries(res.path)).toHaveLength(1);
  });

  it('asks about a new plug run that appears after a rejection, never the same run twice', async () => {
    // Two ad-ish stretches; the first is rejected, the second confirmed.
    const p2 = [0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
    const asked: string[] = [];
    const res = await confirmPlugs(matrix(p2, 3), 2, 20, async (a, b) => {
      asked.push(`${a}-${b}`);
      return a === 6 ? 0.1 : 0.95;
    });
    expect(asked).toEqual(['6-12', '18-24']);
    expect(res.verdicts.map((v) => v.p)).toEqual([0.1, 0.95]);
    expect(res.path.slice(6, 12).every((j) => j === 0)).toBe(true);
    expect(res.path.slice(18, 24).every((j) => j === 2)).toBe(true);
  });
});

describe('path to chapters', () => {
  const units = Array.from({ length: 10 }, (_, i) => ({ start: 5 + i * 10, end: 14 + i * 10, text: `u${i}` }));
  const items = ['Intro', 'Main topic', PLUG];

  it('starts the first chapter at 0, ends at the next start, and the last at the transcript end', () => {
    const path = [0, 0, 0, 2, 2, 1, 1, 1, 1, 1];
    const ch = piecesToChapters(pathPieces(path, items, 2, 0, 0), units);
    expect(ch).toEqual([
      { startSeconds: 0, endSeconds: 35, title: 'Intro', label: 'Intro', sentenceRange: [0, 3], isAd: false },
      { startSeconds: 35, endSeconds: 55, title: 'Sponsor / self-promotion', label: PLUG, sentenceRange: [3, 5], isAd: true },
      { startSeconds: 55, endSeconds: 104, title: 'Main topic', label: 'Main topic', sentenceRange: [5, 10], isAd: false },
    ]);
    expect(piecesToChapters(pathPieces(path, items, 2, 0, 0), units, 120)[2].endSeconds).toBe(120);
  });

  it('titles a returning subject "(continued)"', () => {
    const path = [1, 1, 1, 0, 0, 0, 1, 1, 1, 1];
    const titles = piecesToChapters(pathPieces(path, items, 2, 0, 0), units).map((c) => c.title);
    expect(titles).toEqual(['Main topic', 'Intro', 'Main topic (continued)']);
  });

  it('maps to the ai-analysis Chapter shape with HH:MM:SS times', () => {
    const ch = piecesToChapters(pathPieces([0, 0, 0, 0, 0, 1, 1, 1, 1, 1], items, 2, 0, 0), units, 3725);
    expect(toAnalysisChapters(ch)).toEqual([
      { sequence: 1, start_time: '00:00:00', end_time: '00:00:55', title: 'Intro' },
      { sequence: 2, start_time: '00:00:55', end_time: '01:02:05', title: 'Main topic' },
    ]);
  });
});
