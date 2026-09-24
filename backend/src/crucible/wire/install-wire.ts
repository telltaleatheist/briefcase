/**
 * What crosses to the renderer about INSTALLING a Crucible on this computer,
 * and about the one setup face the wizard shows.
 *
 * Ported from BookForge's shared/crucible/install-wire.ts. Type-only, and the
 * renderer imports it through `@crucible-wire/*`, so nothing here may import a
 * Node module or `@crucible/bootstrap`. A refusal crosses the wire verbatim:
 * the refusing owner's code, message, command and detail.
 */
import type { DiscoveredCrucibleRow } from './settings-wire';

/** The three platforms the sequence differs by, and a word for the rest. */
export type InstallPlatform = 'win32' | 'darwin' | 'linux' | 'other';

/**
 * The name of a failed install: the bootstrap package's own `BootstrapRefusalCode`
 * (carried verbatim), or one of the few only this app meets:
 *
 *  - `install_failed`: the installer threw something that is not a refusal;
 *  - `install_older_than_running` / `crucible_already_latest`: the never-older gate;
 *  - `not_hostable`: an Intel Mac, or Linux without NVIDIA;
 *  - `host_install_running`: a second press while one install runs.
 *
 * A plain string on the wire, because this file is compiled into the renderer,
 * which cannot resolve the package's types.
 */
export type CrucibleHostRefusalCode = string;

/** A named refusal, in the package's own shape. */
export interface CrucibleHostRefusal {
  code: CrucibleHostRefusalCode;
  message: string;
  /** The exact line to run, or null when nothing can be typed. Never a guess. */
  command: string | null;
  /** Verbatim evidence (a stderr tail, a status line), or null. */
  detail: string | null;
}

/** The card, as the machine reports it. Only NVIDIA is measured; Apple silicon is not sized. */
export interface CrucibleGpuFacts {
  vendor: 'nvidia' | 'apple';
  name: string;
  vramBytes: number;
}

/** What this app measured about the machine, and nothing it did not. */
export interface CrucibleHostFacts {
  platform: InstallPlatform;
  /** The raw `process.platform`. */
  platformName: string;
  arch: string;
  gpu: CrucibleGpuFacts | null;
  /** Is there already a Crucible on this computer (its pairing file), and is it registered? */
  discovered: DiscoveredCrucibleRow;
  /** One named refusal per thing that stops an install here. */
  refusals: CrucibleHostRefusal[];
}

/** Could a Crucible live here. `unknown` is drawn as the install face. */
export type CrucibleHostability = 'yes' | 'no' | 'unknown';

/** One step of the sequence, for a screen that lists them before they run. */
export interface CrucibleInstallStep {
  title: string;
  detail: string;
  /** True only where this app has verified it (a pairing file already here). */
  done: boolean;
}

/** Everything the install face draws, in one read. Composing it installs nothing. */
export interface CrucibleInstallPlan {
  platform: InstallPlatform;
  host: CrucibleHostFacts;
  /** One sentence about this machine, from the facts above. */
  machine: string;
  hostable: CrucibleHostability;
  /** Why, whichever way it went. Always set. */
  hostableWhy: string;
  steps: CrucibleInstallStep[];
  /** Crucible's README, the argument behind the sequence. */
  readme: string;
}

/**
 * ONE EVENT OF A RUNNING INSTALL, on Socket.IO `crucible.install-progress`.
 * The package's own shapes, forwarded; the awaited call answers only the ending.
 */
export type CrucibleInstallProgress =
  | { kind: 'step'; step: string; index: number | null; total: number | null; status: string; detail: string }
  | { kind: 'progress'; file: string; done: number; total: number | null }
  /** The Windows WSL state table's answer for this machine, verbatim. */
  | { kind: 'state'; code: string; sentence: string; action: string }
  | { kind: 'line'; step: string; stream: 'stdout' | 'stderr'; text: string }
  /** It finished. The token is not here; the pairing file is. `connectedAs` is the registry row. */
  | { kind: 'done'; server: { name: string; url: string; configPath: string }; release: string; backend: string; connectedAs: string | null }
  | { kind: 'failed'; refusal: CrucibleHostRefusal };

export const CRUCIBLE_INSTALL_PROGRESS = 'crucible.install-progress';

/** `crucible-install-state.json`: where the last install got to, so a relaunch shows the right face. */
export interface CrucibleInstallRecord {
  state: 'running' | 'done' | 'failed';
  /** The release being installed, once the gate chose one. */
  release: string | null;
  /** The last step the package reported. */
  step: string | null;
  startedAt: string;
  finishedAt: string | null;
  refusal: CrucibleHostRefusal | null;
}

/** GET /crucible/install: is one running in this process, and what did the last one come to? */
export interface CrucibleInstallStatus {
  running: boolean;
  /**
   * The record on disk. `state: 'running'` with `running: false` is an install
   * this process did not finish (the app quit or crashed mid-install): pressing
   * Install again resumes it, because the package's steps are idempotent.
   */
  last: CrucibleInstallRecord | null;
  interrupted: boolean;
  /** Every event of the install in this process, oldest first (capped), for a panel opened late. */
  events: CrucibleInstallProgress[];
}

/** The never-older gate's answer, asked without installing anything. */
export type CrucibleReleaseCheck =
  | { action: 'install'; latest: string; running: null }
  | { action: 'upgrade'; latest: string; running: string }
  | { action: 'none'; code: 'crucible_already_latest' | 'install_older_than_running'; latest: string; running: string; message: string }
  | { action: 'unknown'; refusal: CrucibleHostRefusal };

/** The SDK's eight local states. */
export type CrucibleLocalState =
  | 'absent' | 'running' | 'stopped' | 'unreachable' | 'wrong_service' | 'unauthorized' | 'unhealthy' | 'broken';

/** GET /crucible/local/presence: the local engine as its own control says, plus what to tell a person. */
export interface CrucibleEnginePresence {
  state: CrucibleLocalState;
  detail: string;
  /** One sentence for a person, or null when there is nothing worth saying. */
  message: string | null;
  /** True when pressing Start is the actual repair. */
  offerStart: boolean;
}

export interface CrucibleEngineStartOutcome {
  started: boolean;
  detail: string;
  /** The registry row the engine was adopted as after it started, or null. */
  connectedAs: string | null;
}

/**
 * The ONE face the wizard's engine step shows (INTEGRATING-AN-APP.md §4.5):
 *
 *  - `connected`: the registry has at least one server;
 *  - `adopt`: no registry row for it, but a Crucible is on this computer;
 *  - `install`: nothing here, and this machine can host one;
 *  - `connect-only`: nothing here, and it cannot (Intel Mac, Linux without NVIDIA).
 */
export type CrucibleSetupFace = 'connected' | 'adopt' | 'install' | 'connect-only';

/** GET /crucible/setup: everything the engine step draws, in one read. */
export interface CrucibleSetupView {
  face: CrucibleSetupFace;
  /** Registered server names, in the order they were added. */
  servers: string[];
  discovered: DiscoveredCrucibleRow;
  plan: CrucibleInstallPlan;
  install: CrucibleInstallStatus;
  /** True while the first-run wizard holds coordination back. */
  coordinationHeld: boolean;
}
