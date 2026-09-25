/**
 * transcript.json → SRT (migration plan §6.6 step 5).
 *
 * A Crucible `asr` job hands back `transcript.json` (crucible
 * docs/PHASE4-AUDIO.md §3, PHASE25-QWEN-ASR.md §2): segments in ABSOLUTE time,
 * window overlaps already removed, words attached when `word_timestamps` was
 * asked for. A Qwen3-ASR segment is one piece of up to 180 s, so Briefcase
 * always asks for words, and its cues are cut from them (alignWordsToText). Everything downstream in Briefcase reads an SRT (transcript search, the
 * editor, analysis, snap), so this is the one place that turns one into the
 * other, and the SRT it writes is the shape whisper.cpp writes:
 *
 *   <n>\n<HH:MM:SS,mmm> --> <HH:MM:SS,mmm>\n<text>\n\n
 *
 * which is what `AnalysisService.parseSrtToSegments` (blocks split on a blank
 * line, line 1 the timestamp, two-digit hours) and the frontend readers need.
 *
 * Salvaged from the reference branch (bbb7ef6, ported there from BookForge's
 * electron/crucible/asr.ts). Changed here:
 *  - the metadata fields past `segments`, `model` and `language` are read
 *    leniently (a transcript is not lost over a missing `revision`), the
 *    segments strictly;
 *  - an overlapping cue is DROPPED only when it lies inside the kept one (a
 *    true boundary duplicate); one that overlaps and runs on is kept with its
 *    start moved to the kept cue's end. BookForge dropped every cue starting
 *    0.1 s inside the previous one, which for a video transcript loses words;
 *  - a cue's text is one line (no blank line can split an SRT block);
 *  - hours are at least two digits (`100:00:00,000` past 99 h, never wrapped).
 */
import { CrucibleAsrRefused } from './asr-models';

export interface TranscriptWord {
  readonly start: number;
  readonly end: number;
  readonly word: string;
}

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words?: readonly TranscriptWord[];
}

/** The document Crucible's `asr` job writes. */
export interface CrucibleTranscript {
  readonly model: string;
  readonly revision: string;
  readonly language: string;
  readonly languageRequested: string;
  readonly durationS: number | null;
  readonly segments: readonly TranscriptSegment[];
}

export interface TranscriptCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Sentence-final punctuation (full-width too), with closing quotes/brackets after the mark. BookForge's, plus 。！？. */
const SENTENCE_END_RE = /[.!?…。！？]["”’')\]」』]*$/u;
/** A cue that grew this long without punctuation is flushed. BookForge's `_MAX_CUE_CHARS`. */
const MAX_CUE_CHARS = 240;
/** Two cues overlapping by less than this are not an overlap (whisper's timestamps jitter). */
const OVERLAP_TOLERANCE_S = 0.1;

function unreadable(message: string): CrucibleAsrRefused {
  return new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `transcript.json from Crucible is unreadable: ${message}`);
}

function num(obj: Record<string, unknown>, key: string, where: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unreadable(`${where}.${key} is not a number`);
  return value;
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw unreadable(`${where}.${key} is not a string`);
  return value;
}

function optStr(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Read `transcript.json` (already JSON-parsed). The segments are read
 * strictly: a segment with no `end` is a server that changed, and an SRT
 * built around it would be a transcript with a hole.
 */
export function readCrucibleTranscript(parsed: unknown): CrucibleTranscript {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw unreadable('it is not an object');
  const doc = parsed as Record<string, unknown>;
  const rawSegments = doc['segments'];
  if (!Array.isArray(rawSegments)) throw unreadable('it has no segments list');
  const segments: TranscriptSegment[] = rawSegments.map((raw, i) => {
    const where = `segments[${i}]`;
    if (typeof raw !== 'object' || raw === null) throw unreadable(`${where} is not an object`);
    const seg = raw as Record<string, unknown>;
    const row: { start: number; end: number; text: string; words?: TranscriptWord[] } = {
      start: num(seg, 'start', where),
      end: num(seg, 'end', where),
      text: str(seg, 'text', where),
    };
    if ('words' in seg && seg['words'] !== null && seg['words'] !== undefined) {
      const rawWords = seg['words'];
      if (!Array.isArray(rawWords)) throw unreadable(`${where}.words is not a list`);
      row.words = rawWords.map((w, j) => {
        const wwhere = `${where}.words[${j}]`;
        if (typeof w !== 'object' || w === null) throw unreadable(`${wwhere} is not an object`);
        const word = w as Record<string, unknown>;
        return { start: num(word, 'start', wwhere), end: num(word, 'end', wwhere), word: str(word, 'word', wwhere) };
      });
    }
    return row;
  });
  const duration = doc['duration_s'];
  return {
    model: str(doc, 'model', 'transcript'),
    revision: optStr(doc, 'revision'),
    language: str(doc, 'language', 'transcript'),
    languageRequested: optStr(doc, 'language_requested'),
    durationS: typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
    segments,
  };
}

/** How far past the last matched character an aligner word may be found (characters of letters and digits). */
const ALIGN_LOOKAHEAD_CHARS = 40;

/** Letters and digits only, lower-cased: the one spelling an aligner word and a text token are compared in. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * A Qwen segment's aligner words, each given the PUNCTUATED text it covers.
 *
 * Qwen3-ASR's segment is one piece of up to 180 s; its `text` carries the
 * punctuation and its `words` (the aligner's items) carry the times, without
 * punctuation and not always split where the text is ("don't" may be "don" and
 * "t"). The two are matched character by character on their letters and digits:
 * each word is found in the text's letter stream at or just past the last one,
 * and each text token goes to the word holding its last letter, so "don't."
 * lands on "t" and ends a sentence there. A token with no letters ("—") goes
 * with the word before it. A word with no token (its letters were another
 * word's token) keeps its time and adds no text.
 *
 * A language written without spaces matches the same way (the letter streams
 * are compared, not the tokens), its text split after each 。！？ so every
 * sentence is its own token. When the text does not line up with the words at
 * all (fewer than half of them found), the words' own text is used,
 * unpunctuated, so the cues still carry every word at its time.
 */
export function alignWordsToText(segment: TranscriptSegment): TranscriptWord[] {
  const words = segment.words ?? [];
  // Tokens: split on spaces, and after a full-width sentence end (a language written without spaces).
  const tokens = segment.text.split(/\s+|(?<=[。！？])/u).filter((t) => t !== '');
  let stream = '';
  const tokenLast: number[] = [];
  for (const token of tokens) {
    stream += bare(token);
    tokenLast.push(stream.length - 1);
  }
  const wordOfChar = new Array<number>(stream.length).fill(-1);
  let cursor = 0;
  let found = 0;
  words.forEach((w, j) => {
    const key = bare(w.word);
    if (key === '') return;
    const at = stream.indexOf(key, cursor);
    if (at < 0 || at - cursor > ALIGN_LOOKAHEAD_CHARS) return;
    for (let c = at; c < at + key.length; c++) wordOfChar[c] = j;
    cursor = at + key.length;
    found++;
  });
  if (words.length > 0 && found * 2 < words.length) {
    return words.map((w) => ({ start: w.start, end: w.end, word: ` ${w.word.trim()}` }));
  }

  const texts: string[][] = words.map(() => []);
  let previous = 0;
  tokens.forEach((token, i) => {
    const last = tokenLast[i];
    // A token with letters goes to the word holding its last one; an unmatched stretch rides with the word before.
    const owner = last >= 0 && (i === 0 || last > tokenLast[i - 1]) ? wordOfChar[last] : -1;
    const j = owner >= 0 ? owner : previous;
    texts[j]?.push(token);
    previous = j;
  });
  return words.map((w, j) => ({ start: w.start, end: w.end, word: texts[j].length > 0 ? ` ${texts[j].join(' ')}` : '' }));
}

/** One line of cue text: every run of whitespace (newlines included) folded to a space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Segments → cues. With word timings, words accumulate into a cue that ends at
 * a word carrying sentence-final punctuation or once the cue holds 240
 * characters (BookForge's grouping). A segment with no words is one cue of its
 * own text. Empty text is never a cue. Then the cues are ordered by start and
 * overlaps resolved: a cue inside the kept one is a boundary duplicate and is
 * dropped; one that overlaps and runs on starts where the kept one ends.
 */
export function groupTranscriptCues(segments: readonly TranscriptSegment[]): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let words: string[] = [];
  let start: number | null = null;
  let end: number | null = null;
  const flush = (): void => {
    if (words.length > 0 && start !== null && end !== null) {
      const text = oneLine(words.join(''));
      if (text !== '') cues.push({ start, end: Math.max(start, end), text });
    }
    words = [];
    start = null;
    end = null;
  };
  for (const segment of segments) {
    if (segment.words !== undefined && segment.words.length > 0) {
      // Qwen's aligner words carry no punctuation: give them the segment text's first.
      const timed = alignWordsToText(segment);
      for (const w of timed) {
        if (start === null) start = w.start;
        end = w.end;
        words.push(w.word);
        const chars = words.reduce((n, x) => n + x.length, 0);
        if ((w.word.trim() !== '' && SENTENCE_END_RE.test(w.word.trim())) || chars >= MAX_CUE_CHARS) flush();
      }
    } else {
      flush();
      const text = oneLine(segment.text);
      if (text !== '') cues.push({ start: segment.start, end: Math.max(segment.start, segment.end), text });
    }
  }
  flush();

  const ordered = cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.start - b.cue.start || a.index - b.index)
    .map(({ cue }) => cue);
  const kept: TranscriptCue[] = [];
  for (const cue of ordered) {
    const last = kept[kept.length - 1];
    if (last === undefined || cue.start >= last.end - OVERLAP_TOLERANCE_S) {
      kept.push(cue);
      continue;
    }
    if (cue.end <= last.end + OVERLAP_TOLERANCE_S) continue; // inside the kept cue: a boundary duplicate
    kept.push({ start: last.end, end: cue.end, text: cue.text });
  }
  return kept;
}

/**
 * `HH:MM:SS,mmm`, rounded to the millisecond FIRST and then split, so 59.9996 s
 * carries into the minute rather than printing `00:00:60,000`. Hours are at
 * least two digits and never wrap.
 */
export function srtTimestamp(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** SRT text: sequential 1-based indices, a blank line after every cue, `\n` line endings. */
export function renderSrt(cues: readonly TranscriptCue[]): string {
  let out = '';
  cues.forEach((cue, i) => {
    out += `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n\n`;
  });
  return out;
}

/** The transcript's plain text: each cue's text on its own line (what transcript search indexes). */
export function renderPlainText(cues: readonly TranscriptCue[]): string {
  return cues.map((cue) => cue.text).join('\n');
}

/**
 * `transcript.json` (parsed) → SRT text, its plain text and its cue count.
 *
 * A transcript with no speech is an EMPTY SRT, not a refusal: a library holds
 * music videos and silent clips, for which "no speech" is the true
 * transcript.
 */
export function transcriptToSrt(parsed: unknown): { srt: string; plainText: string; cues: number; transcript: CrucibleTranscript } {
  const transcript = readCrucibleTranscript(parsed);
  const cues = groupTranscriptCues(transcript.segments);
  return { srt: renderSrt(cues), plainText: renderPlainText(cues), cues: cues.length, transcript };
}
