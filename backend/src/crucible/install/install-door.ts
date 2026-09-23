/**
 * THE ONE SEAM BETWEEN BRIEFCASE AND THE WINDOWS HOST'S INSTALL DOOR.
 *
 * Ported from BookForge's electron/crucible/install-door.ts (crucible
 * docs/PHASE19-AUTOMATIC-WSL.md §2.6). The door is three verbs, which
 * `@crucible/bootstrap` wraps as `installStatus()`, `watchInstall()` and
 * `requestHostInstall()`. On a Windows machine that can host WSL2 the tray
 * moves the engine to Linux by itself; Briefcase watches, and offers Try again.
 *
 * What is this file's own work:
 *  1. FAN-OUT: one `watchInstall()` in flight, any number of subscribers.
 *  2. THE TERMINAL EVENT comes from the OUTCOME (the file the tray writes),
 *     never from a mid-stream `failed` frame, which is one step's news.
 *  3. NOT ASKING A DOOR THAT IS NOT THERE: off Windows, or with no host pack,
 *     the answer is `{running: false, outcome: null}` from a file test.
 */
import {
  TERMINAL_OUTCOME_STATES,
  hostInstalled,
  installStatus,
  requestHostInstall,
  watchInstall,
  type HostEvent,
  type Runner,
  type WslOutcome,
} from '@crucible/bootstrap';
import type {
  CrucibleInstallDoorEvent,
  CrucibleInstallDoorStatus,
  CrucibleInstallOutcome,
} from '../wire/install-door-wire';
import { crucibleProcessRunner } from './host-runner';

/** Compiles only while the SDK's outcome is assignable to the wire's copy of it. */
const asAppOutcome = (outcome: WslOutcome): CrucibleInstallOutcome => outcome;

/** Is this outcome one the app stops waiting on? The SDK's list: `failed` is retried once by the tray. */
export function installOutcomeIsTerminal(outcome: CrucibleInstallOutcome | null): boolean {
  return outcome !== null && TERMINAL_OUTCOME_STATES.includes(outcome.state);
}

/** The world the door reads, injectable so a spec drives every branch without a socket. */
export interface InstallDoorHost {
  runner(): Runner;
  status(runner: Runner): Promise<{ running: boolean; outcome: WslOutcome | null }>;
  watch(sinks: { onEvent: (event: HostEvent) => void; decisionWaitMs?: number }, runner: Runner): Promise<{ running: boolean; outcome: WslOutcome | null }>;
  post(release: string, runner: Runner): Promise<void>;
  /** Is there a host pack on this machine at all? A file test, not a ping. */
  installed(runner: Runner): boolean;
}

export function processInstallDoorHost(): InstallDoorHost {
  return {
    runner: crucibleProcessRunner,
    status: (runner) => installStatus({}, runner),
    watch: (sinks, runner) => watchInstall(sinks, runner),
    post: async (release, runner) => {
      // The host installs the same bare service Briefcase's own install asks for.
      await requestHostInstall({ release, jobTypes: ['echo'] }, runner);
    },
    installed: hostInstalled,
  };
}

function appEvent(event: HostEvent): CrucibleInstallDoorEvent | null {
  switch (event.event) {
    case 'step':
      return { event: 'step', name: event.data.name, index: event.data.index, total: event.data.total, detail: '' };
    case 'progress':
      return { event: 'progress', file: event.data.file, bytes_done: event.data.bytes_done, bytes_total: event.data.bytes_total };
    case 'state':
      return { event: 'state', code: event.data.code, sentence: event.data.sentence, action: event.data.action };
    case 'line':
      return { event: 'line', step: '', stream: event.data.stream, text: event.data.text };
    default:
      // `done`/`failed` frames are news about a sequence; the terminal event comes from the outcome.
      return null;
  }
}

/** The door, over the SDK. One per backend process (a Nest provider). */
export class HostInstallDoor {
  private readonly watchers = new Set<(event: CrucibleInstallDoorEvent) => void>();
  private following: Promise<void> | null = null;
  private step = '';

  constructor(private readonly host: InstallDoorHost = processInstallDoorHost()) {}

  async status(): Promise<CrucibleInstallDoorStatus> {
    const runner = this.host.runner();
    if (runner.platform !== 'win32' || !this.host.installed(runner)) return { running: false, outcome: null };
    const status = await this.host.status(runner);
    return { running: status.running, outcome: status.outcome === null ? null : asAppOutcome(status.outcome) };
  }

  /** Subscribe to this machine's move. Attaches to one in flight; returns at once on a quiet machine. */
  watch(onEvent: (event: CrucibleInstallDoorEvent) => void): () => void {
    this.watchers.add(onEvent);
    void this.follow(0);
    return () => { this.watchers.delete(onEvent); };
  }

  /** `POST /install`: Try again, retrying the release the outcome names (never an upgrade by stealth). */
  async start(): Promise<void> {
    const runner = this.host.runner();
    if (runner.platform !== 'win32' || !this.host.installed(runner)) {
      throw Object.assign(new Error('host_not_installed: there is no Crucible host on this computer, so there is no engine setup to try again. Install Crucible first.'), { code: 'host_not_installed' });
    }
    const status = await this.host.status(runner);
    if (status.outcome === null) {
      throw Object.assign(new Error('no_install_outcome: this computer has not recorded an engine setup, so there is nothing to try again.'), { code: 'no_install_outcome' });
    }
    try {
      await this.host.post(status.outcome.release, runner);
    } catch (err) {
      // 409: it is already happening, which is what the person wanted.
      if ((err as { code?: unknown }).code !== 'host_install_running') throw err;
    }
    void this.follow();
  }

  private async follow(decisionWaitMs?: number): Promise<void> {
    if (this.following !== null) return this.following;
    const runner = this.host.runner();
    if (runner.platform !== 'win32' || !this.host.installed(runner)) return;
    this.following = (async () => {
      try {
        const status = await this.host.watch({
          onEvent: (event) => this.relay(event),
          ...(decisionWaitMs === undefined ? {} : { decisionWaitMs }),
        }, runner);
        if (status.outcome === null) return;
        const outcome = asAppOutcome(status.outcome);
        this.emit(outcome.state === 'done' ? { event: 'done', outcome } : { event: 'error', outcome });
      } catch {
        // A door that stopped answering mid-watch: the next subscriber or Try again asks again.
      } finally {
        this.following = null;
      }
    })();
    return this.following;
  }

  private relay(event: HostEvent): void {
    if (event.event === 'step') this.step = event.data.name;
    const translated = appEvent(event);
    if (translated === null) return;
    this.emit(translated.event === 'line' ? { ...translated, step: this.step } : translated);
  }

  private emit(event: CrucibleInstallDoorEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }
}
