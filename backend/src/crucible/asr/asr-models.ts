/**
 * THE TRANSCRIBER: Qwen3-ASR-0.6B, and how to ask for it.
 *
 * Briefcase transcribes with Qwen3-ASR and nothing else (the user, 2026-09-24:
 * "switch fully over to the qwen asr model"), at 0.6B, the fastest on each
 * machine ("we dont need exact text with ums and uhs here, we just need it
 * fast"; Crucible 1.0.32):
 *
 *   mlx-darwin   qwen3-asr-0.6b-mlx  the mlx-audio port, Mac only: ~21 s per
 *                                    10 min against ~98 s for the official
 *                                    package, a few fillers fewer.
 *   otherwise    qwen3-asr-0.6b      vLLM on cuda-linux (one id on every backend).
 *
 * Both run the forced aligner, `qwen3-aligner`, for word timestamps. There is
 * no model choice and no whisper: a server that does not offer the model, or
 * has not downloaded it or its aligner, is a transcription that WAITS with the
 * reason (the venue rule), never one made with another model.
 *
 * THE PARAMS (the server defaults none of them):
 *   language          REQUIRED, one of the aligner's eleven; "auto" is refused
 *                     (Qwen cannot detect). Briefcase has no language setting,
 *                     so an unstated language is English.
 *   vad_filter        false (neither engine has one; true is refused).
 *   word_timestamps   true: a Qwen segment is one piece of up to 180 s, and
 *                     the aligner's words are what cut it into cues
 *                     (crucible-transcript.ts).
 *   context           optional: what is known about the video, for the
 *                     spelling of names (asr-context.ts). Absent when nothing is.
 *   speech_only       true on a server that has it (Crucible 1.0.50+): the
 *                     server cuts silence and music out with a speech detector
 *                     before Qwen hears them and keeps the original timeline, so
 *                     an opening music bed is not transcribed as invented words
 *                     (the user, 2026-09-27: "we should pass in that flag so i
 *                     dont have to trim stuff before pulling it in anymore").
 *                     Crucible's own default is off until it is measured; its
 *                     tuning knobs are left at the server's defaults. An older
 *                     server refuses the field, so it is sent only to one that
 *                     states 1.0.50 or later.
 */
import type { ServerInfo } from '@crucible/client';
import { compareVersions } from '../probe';

/** The asr model Briefcase uses, and the Mac's faster build of it. */
export const QWEN_ASR_MODEL = 'qwen3-asr-0.6b';
export const QWEN_ASR_MODEL_MAC = 'qwen3-asr-0.6b-mlx';

/** The model for a host's backend: the MLX build on a Mac, the one id everywhere else. */
export function qwenAsrModelFor(backend: string | null): string {
  return backend === 'mlx-darwin' ? QWEN_ASR_MODEL_MAC : QWEN_ASR_MODEL;
}
/** Its forced aligner (an `align` model), which word timestamps need installed. */
export const QWEN_ALIGNER_MODEL = 'qwen3-aligner';

/** The languages Qwen3-ASR takes: its aligner's eleven. Anything else is refused by the server. */
export const QWEN_ASR_LANGUAGES: ReadonlySet<string> = new Set(['en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'yue']);

/** The language a job names when none is stated: the videos this app transcribes are English. */
export const QWEN_DEFAULT_LANGUAGE = 'en';

/** A transcription Crucible cannot do as asked, refused by name before anything is sent. */
export class CrucibleAsrRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CrucibleAsrRefused';
  }
}

/** The asr params the server requires. */
export interface AsrParams {
  readonly language: string;
  readonly vad_filter: boolean;
  readonly word_timestamps: boolean;
  readonly context?: string;
  readonly speech_only?: boolean;
}

/** The first Crucible whose asr job takes `speech_only`. */
export const SPEECH_ONLY_MIN_VERSION = '1.0.50';

/** Whether a server stating `version` takes `speech_only`. An unstated version is not assumed to. */
export function takesSpeechOnly(version: string | null | undefined): boolean {
  return typeof version === 'string' && version !== '' && compareVersions(version, SPEECH_ONLY_MIN_VERSION) >= 0;
}

/**
 * The params for a Qwen job in `requested` (a language code, or anything
 * meaning "not stated"). Refused by name, before anything is sent, for a
 * language Qwen does not take.
 */
export function qwenAsrParams(
  requested: string | undefined | null,
  context?: string | null,
  options: { speechOnly?: boolean } = {},
): AsrParams {
  const raw = (requested ?? '').trim().toLowerCase();
  const unstated = raw === '' || raw === 'auto' || raw === 'und' || raw === 'undetermined' || raw === 'unknown' || raw === 'mul';
  const language = unstated ? QWEN_DEFAULT_LANGUAGE : raw;
  if (!QWEN_ASR_LANGUAGES.has(language)) {
    throw new CrucibleAsrRefused(
      'crucible_asr_language_unsupported',
      `Qwen3-ASR transcribes ${[...QWEN_ASR_LANGUAGES].join(', ')}; "${language}" is not one of them.`,
    );
  }
  return {
    language,
    vad_filter: false,
    word_timestamps: true,
    ...(context ? { context } : {}),
    ...(options.speechOnly ? { speech_only: true } : {}),
  };
}

/** One model row of `/v1/info`, as much as the venue rule needs. */
export interface AsrModelState {
  /** The server lists it at all (a pre-1.0.29 server does not list Qwen). */
  readonly offered: boolean;
  readonly installed: boolean;
}

/** What a server's `/v1/info` says about transcribing with Qwen. */
export interface AsrOffer {
  /** The host's backend, or null when `/v1/info` did not state it. */
  readonly backend: string | null;
  /** `asr` is an installed job type on it. */
  readonly offersAsr: boolean;
  /** The model Briefcase uses on this host (qwenAsrModelFor), and its standing. */
  readonly model: string;
  readonly qwen: AsrModelState;
  /** The aligner, from the `align` capability's rows. */
  readonly aligner: AsrModelState;
  /** The server takes `speech_only` (it states 1.0.50 or later). */
  readonly speechOnly: boolean;
}

function modelState(info: ServerInfo, jobType: string, id: string): AsrModelState {
  const capability = info.capabilities.find((c) => c.jobType === jobType) as { models?: unknown } | undefined;
  const rows = Array.isArray(capability?.models) ? (capability!.models as unknown[]) : [];
  const row = rows.find((r) => (r as { id?: unknown })?.id === id) as { installed?: unknown } | undefined;
  return { offered: row !== undefined, installed: row?.installed === true };
}

/** Read `/v1/info` for Qwen transcription: the asr job type, the model, and its aligner. */
export function asrOfferOf(info: ServerInfo): AsrOffer {
  const model = qwenAsrModelFor(info.host.backend);
  return {
    backend: info.host.backend,
    offersAsr: info.jobTypes.includes('asr'),
    model,
    qwen: modelState(info, 'asr', model),
    aligner: modelState(info, 'align', QWEN_ALIGNER_MODEL),
    speechOnly: takesSpeechOnly(info.server?.version),
  };
}

/**
 * Why `server` can't transcribe with Qwen right now, or null when it can. The
 * one sentence the venue rule parks on and the Settings pane shows.
 */
export function qwenUnavailable(server: string, offer: AsrOffer): string | null {
  const at = `Crucible on ${server}`;
  if (!offer.offersAsr) return `${at} has no transcription engine.`;
  if (!offer.qwen.offered) return `${at} does not offer ${offer.model}. Update it to Crucible 1.0.32 or later.`;
  if (!offer.qwen.installed) return `${at} has not downloaded ${offer.model} yet.`;
  if (!offer.aligner.offered) return `${at} does not offer ${QWEN_ALIGNER_MODEL}, which Qwen's word timings need.`;
  if (!offer.aligner.installed) return `${at} has not downloaded ${QWEN_ALIGNER_MODEL} (Qwen's word timings) yet.`;
  return null;
}
