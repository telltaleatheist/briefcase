/**
 * Whether a video has speech worth analyzing, read from its transcript.
 *
 * Some clips have no spoken words: music, ambient sound, silence. The
 * transcriber still hands back something. The real case: a 31.4-second clip
 * of a televangelist dancing to music came back as one cue,
 * "00:00:00,160 --> 00:00:01,996 I want to be a man" (a stray lyric). Sent to
 * the model, that made a chapter titled "I cannot list the sections of a video
 * transcript that has not been provided", a padded description and tags. Such
 * a video gets the no-speech placeholder instead, with no model calls.
 *
 * The rule. A video has NO speech when:
 *   - its transcript has no words at all; or
 *   - it has only a few words (fewer than 20) AND the cues holding them cover
 *     less than 20% of the video's duration.
 *
 * The coverage test is what keeps real short clips analyzed: a 3-second clip
 * with one sentence has few words, but its cue covers most of its length. The
 * real case above is 6 words in 1.8 s of 31.4 s (6%): no speech.
 *
 * With no known duration only the first rule applies. The last cue's end is no
 * stand-in for the duration (a stray lyric at the start would then cover the
 * whole "video"), so a few words with no duration to weigh them against are
 * taken as speech, and the video is analyzed as it always was.
 *
 * Pure: no I/O, no Nest.
 */

/** Fewer words than this can be a stray lyric or a mis-heard sound. */
export const FEW_WORDS = 20;
/** Few words whose cues cover less than this share of the video are not speech. */
export const MIN_SPOKEN_SHARE = 0.2;

export interface SpeechCue {
  start: number;
  end: number;
  text: string;
}

export interface SpeechPresence {
  speech: boolean;
  /** Words in the transcript, sound tags like "[Music]" not counted. */
  words: number;
  /** Seconds covered by the cues that hold words. */
  spokenSeconds: number;
}

/**
 * Sound tags an ASR writes for what it hears that is not speech ("[Music]",
 * "[Applause]", "♪"). They describe the absence of speech, so they are no words.
 */
const SOUND_TAGS = /\[[^\]]*\]|[♪♫]/g;
const WORD = /[\p{L}\p{N}]+/gu;

function countWords(text: string): number {
  return (text.replace(SOUND_TAGS, ' ').match(WORD) ?? []).length;
}

export function speechPresence(cues: readonly SpeechCue[], durationSeconds?: number | null): SpeechPresence {
  let words = 0;
  let spokenSeconds = 0;
  for (const cue of cues) {
    const n = countWords(cue.text ?? '');
    if (n === 0) continue;
    words += n;
    spokenSeconds += Math.max(0, cue.end - cue.start);
  }
  const known = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0;
  const speech =
    words > 0 && !(known && words < FEW_WORDS && spokenSeconds < MIN_SPOKEN_SHARE * durationSeconds!);
  return { speech, words, spokenSeconds };
}
