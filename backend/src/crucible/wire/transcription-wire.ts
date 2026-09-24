/**
 * `/crucible/transcription`: what Settings › Transcription and the setup
 * wizard read and write (P5). Shared with the renderer through `@crucible-wire`.
 * No token, ever.
 */
import type { ServerReach } from './settings-wire';

/**
 * Transcription is Crucible's `asr` job and nothing else (P7 removed the
 * offline whisper-cli transcriber and the `translate` option).
 */
export interface TranscriptionSettingWire {
  /** A registered server name, or null for the best-ranked running one that offers asr. */
  server: string | null;
  /** A Crucible asr model id, or null for the most accurate one installed. */
  model: string | null;
}

export interface TranscriptionModelRow {
  id: string;
  installed: boolean;
  /** 0 = most accurate; null when the model is not on Briefcase's declared ladder. */
  rank: number | null;
}

export interface TranscriptionServerView {
  name: string;
  enabled: boolean;
  reach: ServerReach | null;
  /** `mlx-darwin`, `cuda-linux`, or null when the server could not be read. */
  backend: string | null;
  offersAsr: boolean;
  /** This backend's asr models, most accurate first. */
  models: TranscriptionModelRow[];
  /** The model a job would name when the setting names none. */
  recommended: string | null;
  /** A more accurate model the server offers but has not downloaded. */
  betterNotInstalled: string | null;
  /** Why this server can't transcribe right now, or null. */
  unavailable: string | null;
}

/** Where a transcription queued now would run, or why it would wait (park). */
export type TranscriptionRouteWire =
  | { kind: 'crucible'; server: string; model: string }
  | { kind: 'none'; reason: string };

export interface TranscriptionView {
  setting: TranscriptionSettingWire;
  /** False when nobody has saved a transcription setting yet. */
  explicit: boolean;
  ignored: string | null;
  servers: TranscriptionServerView[];
  /** Where a transcription queued now would run. */
  route: TranscriptionRouteWire;
}
