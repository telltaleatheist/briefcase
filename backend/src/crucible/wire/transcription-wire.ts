/**
 * `/crucible/transcription`: what Settings › Transcription and the setup
 * wizard read and write (P5). Shared with the renderer through `@crucible-wire`.
 * No token, ever.
 */
import type { ServerReach } from './settings-wire';

/** A model's standing on the server: listed at all, and downloaded. */
export interface TranscriptionModelState {
  offered: boolean;
  installed: boolean;
}

/**
 * The selected server, as transcription sees it. Transcription is Crucible's
 * `asr` job with Qwen3-ASR-1.7B and nothing else.
 */
export interface TranscriptionServerView {
  name: string;
  reach: ServerReach | null;
  /** `mlx-darwin`, `cuda-linux`, or null when the server could not be read. */
  backend: string | null;
  /** Qwen3-ASR and its aligner on it; null when the server could not be read. */
  qwen: TranscriptionModelState | null;
  aligner: TranscriptionModelState | null;
  /** Why this server can't transcribe right now, or null. */
  unavailable: string | null;
}

/** Where a transcription queued now would run, or why it would wait (park). */
export type TranscriptionRouteWire =
  | { kind: 'crucible'; server: string; model: string }
  | { kind: 'none'; reason: string };

export interface TranscriptionView {
  /** The one model Briefcase transcribes with, and the aligner it needs. */
  model: string;
  aligner: string;
  /** The selected Crucible server; null when none is selected. */
  server: TranscriptionServerView | null;
  /** Where a transcription queued now would run. */
  route: TranscriptionRouteWire;
}
