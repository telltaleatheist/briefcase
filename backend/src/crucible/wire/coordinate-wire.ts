/**
 * COORDINATION: making sure a server has what Briefcase needs, and saying
 * where that got to.
 *
 * Ported from BookForge's shared/crucible/coordinate-wire.ts. Coordination
 * READS `/v1/info`, `/v1/catalog` and `/v1/capability`, and posts Briefcase's
 * module only when something is missing (INTEGRATING-AN-APP.md §4.6). Every
 * state is pushed on Socket.IO `crucible.coordination`.
 *
 * Type-only; the renderer imports it through `@crucible-wire/*`.
 */

/**
 * A class Briefcase asked for that this engine does not serve, in the engine's
 * own words. Mirrors the SDK's capability row / UnmetNeed: `reason` is
 * informational there, null when the server gave none.
 */
export interface CrucibleUnmetClass {
  readonly class: string;
  readonly reason: string | null;
}

export type CrucibleMissingEntry =
  /** A job type whose environment this server has not installed. */
  | { readonly what: 'job-type'; readonly jobType: string }
  /** Weights this server has not pulled. `expectedBytes` null is "not declared", never 0. */
  | {
      readonly what: 'subject';
      readonly kind: string;
      readonly id: string;
      readonly name: string | null;
      readonly jobType: string | null;
      readonly expectedBytes: number | null;
      readonly inCatalog: boolean;
    }
  /** The weights a class resolves to on THIS engine, not pulled yet. */
  | {
      readonly what: 'class';
      readonly class: string;
      readonly id: string;
      readonly kind: string | null;
      readonly name: string | null;
      readonly jobType: string | null;
      readonly expectedBytes: number | null;
      readonly inCatalog: boolean;
    };

/**
 * One module task's progress, off `GET /v1/tasks/{id}/events`. Mirrors the
 * SDK's TaskStepData / TaskBytesProgress (this file may not import the SDK):
 * their informational fields are null where the server did not state them.
 */
export interface CrucibleModuleProgress {
  readonly server: string;
  readonly taskId: string;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly step: { readonly name: string | null; readonly index: number | null; readonly total: number | null } | null;
  /** An install's line (pip's text); not load-bearing. */
  readonly line: string | null;
  /** A pull's byte counts. */
  readonly bytes: { readonly done: number; readonly total: number | null; readonly file: string | null } | null;
  readonly skipped: string | null;
  /** What the `reload` step said became reachable. */
  readonly jobTypes: readonly string[] | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  /** The task document's `unmet`, read once after the stream; null when it could not be read. */
  readonly unmet: readonly CrucibleUnmetClass[] | null;
}

/** Who holds the card, in the server's own words. Shown verbatim, never as a failure. */
export interface CrucibleCoordinationHolder {
  /** `a job`, `a lease`, `the claim` or `a chat`. Always stated. */
  readonly fact: string;
  /** Who, in the server's words; null when it did not name them (the SDK's CrucibleCardHeld.who). */
  readonly who: string | null;
}

export type CrucibleCoordinationState =
  /** Held back until the first-run wizard finishes, so the user decides before any pull. */
  | { readonly server: string; readonly phase: 'deferred'; readonly reason: 'first-run' }
  /** Reading the three documents. No task, no card. */
  | { readonly server: string; readonly phase: 'checking' }
  /** Nothing is missing. Nothing was posted. `unmet` may still have rows. */
  | { readonly server: string; readonly phase: 'stocked'; readonly checkedAt: string; readonly unmet: readonly CrucibleUnmetClass[] }
  /** The module task is running: posted by us, or somebody else's that we joined (`followed`). */
  | {
      readonly server: string;
      readonly phase: 'preparing';
      readonly missing: readonly CrucibleMissingEntry[];
      readonly unmet: readonly CrucibleUnmetClass[];
      readonly progress: CrucibleModuleProgress;
      readonly followed: boolean;
    }
  /** `409 server_busy`: the card is held. A wait with the holder named, never a failure. */
  | {
      readonly server: string;
      readonly phase: 'waiting';
      readonly missing: readonly CrucibleMissingEntry[];
      readonly unmet: readonly CrucibleUnmetClass[];
      readonly holder: CrucibleCoordinationHolder;
      readonly attempts: number;
      /** The wait gave up asking; the next connect starts it again. */
      readonly stopped: boolean;
    }
  /** A refusal about the REQUEST (`invalid_module`, `unknown_subject`). Once, by name, remembered. */
  | { readonly server: string; readonly phase: 'refused'; readonly code: string; readonly message: string }
  /** Nothing answered, it answered something else, or it is paused. Nothing was posted. */
  | { readonly server: string; readonly phase: 'unreachable'; readonly message: string };

export type CrucibleCoordinationMap = Readonly<Record<string, CrucibleCoordinationState>>;

export const CRUCIBLE_COORDINATION = 'crucible.coordination';
