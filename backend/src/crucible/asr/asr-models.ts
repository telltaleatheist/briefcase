/**
 * WHICH CRUCIBLE ASR MODEL, AND HOW TO ASK FOR IT (migration plan §6.6, P5).
 *
 * Salvaged from the reference branch (`ref/crucible-transcription-wip`,
 * bbb7ef6 `asr-models.ts`), which ported it from BookForge. Changed here: the
 * rows are filtered to the ENGINE the host's backend runs (a live mlx-darwin
 * server lists every `faster-whisper-*` id too, uninstalled, with an empty
 * revision), and the error type is this module's.
 *
 * Crucible ships two whisper engines, one per backend: `faster-whisper-*` on
 * `cuda-linux` (CTranslate2, no Metal) and `mlx-whisper-*` on `mlx-darwin`.
 * Different weights, different library: the id prefix says which one made a
 * transcript, and nothing here maps one onto the other.
 *
 * ACCURACY ORDER IS DECLARED, NOT INFERRED. `/v1/info`'s asr rows carry id,
 * revision, installed, resident and a VRAM figure, nothing about accuracy, and
 * VRAM is not a proxy for it. So the ladder is written down here, keyed on the
 * size after the engine prefix, most accurate first. An id the server offers
 * that is not on the ladder can still be picked by hand; it is never chosen
 * automatically, because ranking an unknown model would be a guess.
 *
 * THE VAD RULE. All three asr params are required and the server defaults
 * none of them. `vad_filter` is decided per engine: faster-whisper ships
 * Silero VAD (BookForge sends true); mlx-whisper has no VAD and the server
 * REFUSES `vad_filter: true` for it (`vad_unsupported_by_engine`). An id with
 * neither prefix is refused rather than sent with a guess.
 */
import type { ServerInfo } from '@crucible/client';

/** Sizes, most accurate first. Keyed on what follows the engine prefix. */
export const ASR_ACCURACY_LADDER: readonly string[] = [
  'large-v3',
  'large-v3-turbo',
  'distil-large-v3',
  'medium',
  'small',
  'base',
  'tiny',
];

export const FASTER_WHISPER_PREFIX = 'faster-whisper-';
export const MLX_WHISPER_PREFIX = 'mlx-whisper-';

export type AsrEngine = 'faster-whisper' | 'mlx-whisper';

/** A transcription Crucible cannot do as asked, refused by name before anything is sent. */
export class CrucibleAsrRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CrucibleAsrRefused';
  }
}

export function asrEngineOf(modelId: string): AsrEngine | null {
  if (modelId.startsWith(FASTER_WHISPER_PREFIX)) return 'faster-whisper';
  if (modelId.startsWith(MLX_WHISPER_PREFIX)) return 'mlx-whisper';
  return null;
}

/** The engine a host backend runs, or null for a backend with no whisper (an orchestrator, an unknown one). */
export function asrEngineForBackend(backend: string | null | undefined): AsrEngine | null {
  if (backend === 'mlx-darwin') return 'mlx-whisper';
  if (backend === 'cuda-linux') return 'faster-whisper';
  return null;
}

/**
 * `vad_filter` for this model: true on faster-whisper, false on mlx-whisper
 * (it has no voice-activity detector and the server refuses true by name).
 */
export function vadFilterFor(modelId: string): boolean {
  const engine = asrEngineOf(modelId);
  if (engine === 'faster-whisper') return true;
  if (engine === 'mlx-whisper') return false;
  throw new CrucibleAsrRefused(
    'crucible_asr_engine_unknown',
    `"${modelId}" is neither a faster-whisper-* nor an mlx-whisper-* model, so whether its engine has `
      + 'a voice-activity filter is unknown and vad_filter would be a guess. Pick a model the server lists.',
  );
}

export function asrSizeOf(modelId: string): string | null {
  if (modelId.startsWith(FASTER_WHISPER_PREFIX)) return modelId.slice(FASTER_WHISPER_PREFIX.length);
  if (modelId.startsWith(MLX_WHISPER_PREFIX)) return modelId.slice(MLX_WHISPER_PREFIX.length);
  return null;
}

/** Position on the ladder (0 = most accurate), or null when the id is not on it. */
export function asrAccuracyRank(modelId: string): number | null {
  const size = asrSizeOf(modelId);
  if (size === null) return null;
  const rank = ASR_ACCURACY_LADDER.indexOf(size);
  return rank < 0 ? null : rank;
}

/** One asr row, as much of `/v1/info`'s descriptor as choosing needs. */
export interface AsrRow {
  readonly id: string;
  readonly installed: boolean;
  readonly resident: boolean;
}

export interface AsrModelView extends AsrRow {
  /** 0 = most accurate; null = not on the declared ladder (pickable, never auto-chosen). */
  readonly rank: number | null;
}

export interface AsrChoice {
  /** Every offered row, most accurate first, off-ladder ids last in the server's order. */
  readonly models: readonly AsrModelView[];
  /** The most accurate INSTALLED model on the ladder, or null. */
  readonly recommended: string | null;
  /** The most accurate model offered at all, when it is NOT installed (worth pulling), else null. */
  readonly betterNotInstalled: string | null;
}

/**
 * Rank a server's asr rows and pick the default: the most accurate INSTALLED
 * model (a job on an uninstalled model is refused `model_not_installed`, so
 * recommending one would recommend a failure).
 */
export function chooseAsrModel(rows: readonly AsrRow[]): AsrChoice {
  const views: AsrModelView[] = rows.map((row) => ({ ...row, rank: asrAccuracyRank(row.id) }));
  const ranked = views.filter((v) => v.rank !== null).sort((a, b) => (a.rank as number) - (b.rank as number));
  const unranked = views.filter((v) => v.rank === null);
  const recommended = ranked.find((v) => v.installed)?.id ?? null;
  const best = ranked[0];
  const betterNotInstalled = best !== undefined && !best.installed ? best.id : null;
  return { models: [...ranked, ...unranked], recommended, betterNotInstalled };
}

/** What a server's `/v1/info` says about asr: its backend, whether it offers asr, and its rows for that backend's engine. */
export interface AsrOffer {
  readonly backend: string;
  /** `asr` is an installed job type with at least one row for this backend's engine. */
  readonly offersAsr: boolean;
  readonly choice: AsrChoice;
}

/**
 * Read `/v1/info` for asr. Rows of the OTHER engine are dropped: a live
 * mlx-darwin server lists `faster-whisper-*` too (uninstalled, no revision),
 * and offering them would offer a model the host cannot run.
 */
export function asrOfferOf(info: ServerInfo): AsrOffer {
  const backend = info.host.backend;
  const engine = asrEngineForBackend(backend);
  const capability = info.capabilities.find((c) => c.jobType === 'asr') as { models?: unknown } | undefined;
  const raw = Array.isArray(capability?.models) ? (capability!.models as unknown[]) : [];
  const rows: AsrRow[] = [];
  for (const entry of raw) {
    const row = entry as { id?: unknown; installed?: unknown; resident?: unknown };
    if (typeof row?.id !== 'string') continue;
    const rowEngine = asrEngineOf(row.id);
    if (engine !== null && rowEngine !== null && rowEngine !== engine) continue;
    rows.push({ id: row.id, installed: row.installed === true, resident: row.resident === true });
  }
  const offersAsr = info.jobTypes.includes('asr') && capability !== undefined && rows.length > 0;
  return { backend, offersAsr, choice: chooseAsrModel(rows) };
}

/**
 * The language to send. Crucible spells auto-detect as the VALUE `"auto"`.
 * The ISO 639-2 "not known" sentinels and an empty value mean exactly that;
 * everything else is sent lower-cased and the server checks it against
 * whisper's own list (refusing an unknown code by name before queueing).
 */
export function crucibleAsrLanguage(language: string | undefined | null): string {
  const raw = (language ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'auto' || raw === 'und' || raw === 'undetermined' || raw === 'unknown' || raw === 'mul') {
    return 'auto';
  }
  return raw;
}
