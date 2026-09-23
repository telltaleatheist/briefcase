/**
 * THE WINDOWS HOST'S INSTALL DOOR, as the renderer reads it.
 *
 * Ported from BookForge's shared/crucible/install-door-wire.ts (crucible
 * docs/PHASE19-AUTOMATIC-WSL.md §2.2, §2.6). On a Windows machine that can host
 * WSL2 the faster Linux engine arrives by itself: the tray decides and runs the
 * move. The app WATCHES it and offers the one control a person can press (Try
 * again). Off Windows there is no move, and every status is `{running: false,
 * outcome: null}`.
 *
 * Type-only: the renderer imports this through `@crucible-wire/*`. The outcome
 * is the SDK's `WslOutcome` field for field, held to it at compile time by
 * `install/install-door.ts`.
 */

/** The five terminal-or-waiting states the tray writes (§2.2). */
export type CrucibleInstallOutcomeState = 'done' | 'reboot-pending' | 'cannot' | 'failed' | 'declined';

/** `wsl-outcome.json`, verbatim. `code` and `sentence` are null on done and declined. */
export interface CrucibleInstallOutcome {
  state: CrucibleInstallOutcomeState;
  code: string | null;
  sentence: string | null;
  at: string;
  release: string;
  attempts: number;
}

/** One ndjson event off `GET /install/events`, on Socket.IO `crucible.install-door`. */
export type CrucibleInstallDoorEvent =
  | { event: 'state'; code: string; sentence: string; action: string }
  | { event: 'step'; name: string; index: number | null; total: number | null; detail: string }
  | { event: 'progress'; file: string; bytes_done: number; bytes_total: number | null }
  | { event: 'line'; step: string; stream: 'stdout' | 'stderr'; text: string }
  | { event: 'done'; outcome: CrucibleInstallOutcome }
  | { event: 'error'; outcome: CrucibleInstallOutcome };

/** `GET /install`: is a move running, and what did the last one come to? */
export interface CrucibleInstallDoorStatus {
  running: boolean;
  outcome: CrucibleInstallOutcome | null;
}

export const CRUCIBLE_INSTALL_DOOR = 'crucible.install-door';
