/**
 * transcript.json → SRT (P5): the reader, the cue rules (overlaps, empty
 * segments, hours), and byte-compatibility with the SRT readers downstream
 * already use on whisper.cpp's output.
 */
import { alignWordsToText, groupTranscriptCues, readCrucibleTranscript, renderSrt, srtTimestamp, transcriptToSrt } from '../../src/crucible/asr/crucible-transcript';
import { parseSrt } from '../../src/scorer/flags/eval/flag-eval';

function doc(segments: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'mlx-whisper-large-v3', revision: '49e6aa28', language: 'en', language_requested: 'auto', duration_s: 61.2, segments, ...extra,
  };
}

/**
 * AnalysisService.parseSrtToSegments / MediaOperationsService.parseSrtToSegments,
 * rule for rule (both private): blocks split on a blank line, line 1 the
 * timestamp with TWO-digit hours, lines 2+ the text.
 */
function analysisParse(srt: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  for (const block of srt.replace(/\r\n/g, '\n').split('\n\n').filter((b) => b.trim())) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) continue;
    const t = (i: number): number => +m[i] * 3600 + +m[i + 1] * 60 + +m[i + 2] + +m[i + 3] / 1000;
    out.push({ start: t(1), end: t(5), text: lines.slice(2).join(' ') });
  }
  return out;
}

/** The transcript viewer's and transcript search's timestamp line (frontend). */
const VIEWER_LINE = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/;

describe('transcript.json → SRT', () => {
  it('writes whisper.cpp’s shape exactly: index, HH:MM:SS,mmm --> HH:MM:SS,mmm, one text line, a blank line', () => {
    const { srt, cues } = transcriptToSrt(doc([
      { start: 0, end: 4.2, text: ' Welcome back to the show.' },
      { start: 4.2, end: 9.8, text: ' Today we\n are   talking. ' },
    ]));
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:04,200\nWelcome back to the show.\n\n'
      + '2\n00:00:04,200 --> 00:00:09,800\nToday we are talking.\n\n',
    );
    expect(cues).toBe(2);
    expect(srt).not.toContain('\r');
  });

  it('drops empty and whitespace-only segments, and renumbers without gaps', () => {
    const { srt, cues } = transcriptToSrt(doc([
      { start: 0, end: 1, text: 'One.' },
      { start: 1, end: 2, text: '' },
      { start: 2, end: 3, text: '   \n ' },
      { start: 3, end: 4, text: 'Two.' },
    ]));
    expect(cues).toBe(2);
    expect(srt.split('\n\n').filter(Boolean).map((b) => b.split('\n')[0])).toEqual(['1', '2']);
  });

  it('a transcript with no speech is an empty SRT, as whisper.cpp writes for silence', () => {
    expect(transcriptToSrt(doc([]))).toMatchObject({ srt: '', cues: 0 });
  });

  describe('overlaps', () => {
    it('a cue inside the kept one is a boundary duplicate and is dropped', () => {
      const cues = groupTranscriptCues([
        { start: 10, end: 15, text: 'kept' },
        { start: 12, end: 14.5, text: 'duplicate from the next window' },
        { start: 15, end: 16, text: 'next' },
      ]);
      expect(cues.map((c) => c.text)).toEqual(['kept', 'next']);
    });

    it('a cue that overlaps and runs on is kept, starting where the kept one ends (no words lost)', () => {
      const cues = groupTranscriptCues([
        { start: 10, end: 15, text: 'first' },
        { start: 14, end: 18, text: 'second' },
      ]);
      expect(cues).toEqual([{ start: 10, end: 15, text: 'first' }, { start: 15, end: 18, text: 'second' }]);
    });

    it('jitter within 0.1 s is not an overlap; out-of-order segments are sorted', () => {
      const cues = groupTranscriptCues([
        { start: 5, end: 6, text: 'b' },
        { start: 0, end: 5.05, text: 'a' },
      ]);
      expect(cues).toEqual([{ start: 0, end: 5.05, text: 'a' }, { start: 5, end: 6, text: 'b' }]);
    });

    it('an end before its start is clamped to the start', () => {
      expect(groupTranscriptCues([{ start: 3, end: 2, text: 'x' }])).toEqual([{ start: 3, end: 3, text: 'x' }]);
    });
  });

  it('with word timings, words group into sentence cues (BookForge’s rule)', () => {
    const cues = groupTranscriptCues([
      { start: 0, end: 2.2, text: 'x', words: [
        { start: 0, end: 0.5, word: ' Hello' }, { start: 0.5, end: 1, word: ' there.' },
        { start: 1.2, end: 1.6, word: ' How' }, { start: 1.6, end: 2.2, word: ' are' },
      ] },
      { start: 2.3, end: 3.5, text: 'y', words: [{ start: 2.3, end: 3.5, word: ' you?' }] },
    ]);
    expect(cues).toEqual([{ start: 0, end: 1, text: 'Hello there.' }, { start: 1.2, end: 3.5, text: 'How are you?' }]);
  });

  describe('long hours', () => {
    it('times past 10 h and rounding that carries', () => {
      expect(srtTimestamp(0)).toBe('00:00:00,000');
      expect(srtTimestamp(59.9996)).toBe('00:01:00,000');
      expect(srtTimestamp(10 * 3600 + 0.5)).toBe('10:00:00,500');
      expect(srtTimestamp(23 * 3600 + 59 * 60 + 59.999)).toBe('23:59:59,999');
      expect(srtTimestamp(-1)).toBe('00:00:00,000');
    });

    it('an 11-hour transcript parses back to the same seconds downstream', () => {
      const { srt } = transcriptToSrt(doc([{ start: 11 * 3600 + 2.25, end: 11 * 3600 + 7.5, text: 'Late.' }]));
      expect(analysisParse(srt)).toEqual([{ start: 39602.25, end: 39607.5, text: 'Late.' }]);
    });

    it('past 99 h the hours widen rather than wrap', () => {
      expect(srtTimestamp(100 * 3600)).toBe('100:00:00,000');
    });
  });

  describe('byte-compatible with what downstream parsers expect', () => {
    const SEGMENTS = [
      { start: 0, end: 4.2, text: ' Welcome back to the show.' },
      { start: 4.2, end: 9.8, text: ' Today we are talking about the news.' },
      { start: 3605.5, end: 3610.25, text: ' Thanks for watching.' },
    ];
    const expected = [
      { start: 0, end: 4.2, text: 'Welcome back to the show.' },
      { start: 4.2, end: 9.8, text: 'Today we are talking about the news.' },
      { start: 3605.5, end: 3610.25, text: 'Thanks for watching.' },
    ];

    it('the analysis pipeline’s parser (and snap/flag-eval’s parseSrt) reads every cue back exactly', () => {
      const { srt } = transcriptToSrt(doc(SEGMENTS));
      expect(analysisParse(srt)).toEqual(expected);
      expect(parseSrt(srt)).toEqual(expected);
    });

    it('the transcript viewer and search find a timestamp line per cue', () => {
      const { srt } = transcriptToSrt(doc(SEGMENTS));
      expect(srt.split('\n').filter((l) => VIEWER_LINE.test(l))).toHaveLength(3);
    });

    it('renders the same bytes whisper.cpp writes for the same cues', () => {
      // whisper.cpp's output_srt: "<i>\n<t0> --> <t1>\n<text>\n\n" per segment.
      const whisperCpp = '1\n00:00:00,000 --> 00:00:04,200\nWelcome back to the show.\n\n'
        + '2\n00:00:04,200 --> 00:00:09,800\nToday we are talking about the news.\n\n'
        + '3\n01:00:05,500 --> 01:00:10,250\nThanks for watching.\n\n';
      expect(renderSrt(expected)).toBe(whisperCpp);
      expect(transcriptToSrt(doc(SEGMENTS)).srt).toBe(whisperCpp);
    });
  });

  describe('the reader', () => {
    it('refuses a segment missing or mistyping a field, by name', () => {
      expect(() => readCrucibleTranscript(doc([{ start: 0, text: 'x' }]))).toThrow(/segments\[0\]\.end is not a number/);
      expect(() => readCrucibleTranscript(doc([{ start: 0, end: 1, text: 2 }]))).toThrow(/segments\[0\]\.text is not a string/);
      expect(() => readCrucibleTranscript(doc([{ start: 0, end: 1, text: 'x', words: 'no' }]))).toThrow(/words is not a list/);
      expect(() => readCrucibleTranscript([])).toThrow(/not an object/);
      expect(() => readCrucibleTranscript({ ...doc([]), segments: undefined })).toThrow(/no segments list/);
    });

    it('reads the metadata leniently: a missing revision is not a lost transcript', () => {
      const d = doc([{ start: 0, end: 1, text: 'x' }]);
      delete d['revision'];
      delete d['language_requested'];
      expect(readCrucibleTranscript(d)).toMatchObject({ model: 'mlx-whisper-large-v3', revision: '', language: 'en', languageRequested: '', durationS: 61.2 });
    });

    it('words: null is no words', () => {
      expect(readCrucibleTranscript(doc([{ start: 0, end: 1, text: 'x', words: null }])).segments[0].words).toBeUndefined();
    });
  });
});

describe('Qwen3-ASR: a 180 s piece cut into cues by its aligner words', () => {
  /** The aligner's items: no punctuation, times in absolute seconds, one per `step` seconds from `at`. */
  const aligned = (items: string[], at = 0, step = 0.5) =>
    items.map((word, i) => ({ start: at + i * step, end: at + i * step + 0.4, word, probability: null }));

  it('gives each word the punctuated text it ends: contractions, hyphens and a dash', () => {
    const words = alignWordsToText({
      start: 0, end: 10,
      text: "Well, I don't know — it's a well-known fact. Right?",
      words: aligned(['Well', 'I', 'don', 't', 'know', 'it', 's', 'a', 'well', 'known', 'fact', 'Right']),
    });
    expect(words.map((w) => w.word)).toEqual([
      ' Well,', ' I', '', " don't", ' know —', '', " it's", ' a', '', ' well-known', ' fact.', ' Right?',
    ]);
    // Every word keeps its own time.
    expect(words.map((w) => w.start)).toEqual(aligned(['x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x']).map((w) => w.start));
  });

  it('a word the text does not have adds no text; the text around it is kept in order', () => {
    const words = alignWordsToText({ start: 0, end: 3, text: 'We went home.', words: aligned(['We', 'uh', 'went', 'home']) });
    expect(words.map((w) => w.word).join('')).toBe(' We went home.');
  });

  it('a language written without spaces: each sentence goes to the word it ends on', () => {
    const words = alignWordsToText({ start: 0, end: 3, text: '今天天气很好。明天下雨。', words: aligned(['今天', '天气', '很', '好', '明天', '下雨']) });
    expect(words.map((w) => w.word)).toEqual(['', '', '', ' 今天天气很好。', '', ' 明天下雨。']);
  });

  it('text that does not line up with the words at all keeps the words themselves, unpunctuated', () => {
    const words = alignWordsToText({ start: 0, end: 2, text: 'Something else entirely.', words: aligned(['we', 'went', 'home']) });
    expect(words.map((w) => w.word)).toEqual([' we', ' went', ' home']);
  });

  it('a Qwen transcript becomes sentence cues at the aligner\'s times, not one 180 s cue', () => {
    const parsed = {
      model: 'qwen3-asr-1.7b', revision: '7278e1e7', language: 'en', language_requested: 'en', duration_s: 180,
      segments: [{
        start: 0, end: 180,
        text: 'Welcome back everybody. Today we are talking about pasta. Let us begin.',
        words: aligned(['Welcome', 'back', 'everybody', 'Today', 'we', 'are', 'talking', 'about', 'pasta', 'Let', 'us', 'begin'], 10, 1),
      }],
    };
    const { srt, cues } = transcriptToSrt(parsed);
    expect(cues).toBe(3);
    expect(analysisParse(srt)).toEqual([
      { start: 10, end: 12.4, text: 'Welcome back everybody.' },
      { start: 13, end: 18.4, text: 'Today we are talking about pasta.' },
      { start: 19, end: 21.4, text: 'Let us begin.' },
    ]);
  });

  it('a whisper transcript is unchanged: its own words are already spaced and punctuated', () => {
    const { srt } = transcriptToSrt(doc([{
      start: 0, end: 4, text: ' Hi there. Bye.',
      words: [{ start: 0, end: 1, word: ' Hi' }, { start: 1, end: 2, word: ' there.' }, { start: 2, end: 3, word: ' Bye.' }],
    }]));
    expect(analysisParse(srt).map((c) => c.text)).toEqual(['Hi there.', 'Bye.']);
  });
});
