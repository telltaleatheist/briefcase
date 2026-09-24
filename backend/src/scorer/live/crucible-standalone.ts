/**
 * The app's own Crucible services for the scorer's LIVE tools (snap-smoke.ts,
 * flags/eval/flag-eval.ts), wired by hand as CrucibleModule wires them. Since
 * P7 Crucible's decision door is the only transport the scorer has.
 *
 * INTERRUPTED, A TOOL GIVES BACK WHAT IT HOLDS. A standalone tool has no Nest
 * app and so no quit path of its own: before {@link releaseOnInterrupt}, ctrl-C
 * (or `pkill -INT`) killed it on Node's default action, no `finally` ran, and
 * the scorer's lease stayed held on the server until its TTL ran out, blocking
 * the card for everyone else. Now the tool's chat service records every load
 * and lease in a PRIVATE in-flight ledger (never the app's: a sweep of the
 * app's ledger would release the running app's own leases), and a signal
 * aborts the run, lets it unwind (its own `finally` releases; the app's quit
 * does the same, crucible-lanes.ts), sweeps that
 * ledger with the app's own quit sweep (in-flight-sweep.ts: release, and
 * unload only a model our rows name and nobody else is using), bounded, then
 * exits non-zero. A second signal exits at once.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';
import { CrucibleClientFactory } from '../../crucible/client-factory';
import { CrucibleServersService } from '../../crucible/crucible-servers.service';
import type { CrucibleClient } from '@crucible/client';
import { InFlightLedger } from '../../crucible/in-flight-ledger';
import { chatsInFlight, sweepCrucibleInFlight, type SweepTiming } from '../../crucible/in-flight-sweep';
import { CrucibleChatService } from '../../crucible/llm/crucible-chat.service';
import { readCruciblePairingFile } from '../../crucible/pairing-file';
import { CrucibleProbeService } from '../../crucible/probe';
import { CrucibleRegistryService } from '../../crucible/registry.service';
import { CrucibleScorerService } from '../crucible-scorer.service';

/**
 * The app's own Crucible services, wired by hand as CrucibleModule wires them:
 * NAME from Briefcase's registry, or this machine's Crucible read from its
 * pairing file into a throwaway registry (nothing of the user's is written).
 */
export interface StandaloneCrucible {
  scorer: CrucibleScorerService;
  chat: CrucibleChatService;
  server: string | null;
  factory: CrucibleClientFactory;
  /** This process's own record of what it holds (a temp file; never the app's ledger). */
  ledger: InFlightLedger;
}

export function crucibleServices(which: string | true): StandaloneCrucible {
  let dir: string;
  let server: string | null = null;
  if (which === true) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-live-crucible-'));
  } else {
    dir = getBriefcaseConfigDir();
    server = which;
  }
  const registry = new CrucibleRegistryService(dir);
  if (which === true) {
    const reading = readCruciblePairingFile();
    if (reading === null) throw new Error('no Crucible on this machine (~/.crucible/pairing is missing); pass --crucible NAME');
    registry.add({ name: 'local', url: reading.pairing.url, token: reading.pairing.token });
    server = 'local';
  } else if (!registry.names().includes(which)) {
    throw new Error(`no Crucible server named "${which}" in ${dir} (have: ${registry.names().join(', ') || 'none'})`);
  }
  const factory = new CrucibleClientFactory(registry);
  const probes = new CrucibleProbeService(factory, registry);
  const servers = new CrucibleServersService(registry, factory);
  const ledger = InFlightLedger.inDir(fs.mkdtempSync(path.join(os.tmpdir(), 'snap-live-ledger-')));
  const chat = new CrucibleChatService(servers, factory, probes, ledger);
  return { scorer: new CrucibleScorerService(chat, servers), chat, server, factory, ledger };
}

// ── interrupted: give back, then exit ─────────────────────────────────────

/** How long an interrupted run may take to unwind (its own finally releases what it holds). */
export const INTERRUPT_UNWIND_MS = 2_000;
/** The sweep's ceiling afterwards: an unreachable server costs at most this. */
export const INTERRUPT_RELEASE_MS = 4_000;
/** Each request the sweep makes gives up after this (a silent server must not hang the exit). */
export const INTERRUPT_REQUEST_TIMEOUT_MS = 2_000;

const SIGNAL_NUMBERS: Record<string, number> = { SIGINT: 2, SIGTERM: 15 };
/** The shell's convention: 128 + the signal's number. Never 0. */
export function exitCodeOf(signal: string): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 1);
}

/** Set by the first signal: main's own settling then leaves the exit to the release. */
let interrupting = false;

export interface InterruptDeps {
  ledger: InFlightLedger;
  /** Wait (bounded) for the aborted runs to unwind: CrucibleChatService.runsSettled. */
  runsSettled(ms: number): Promise<boolean>;
  /** A client for the sweep; give it a short request timeout. */
  clientFor(server: string): Promise<CrucibleClient>;
  exit(code: number): void;
  log(line: string): void;
  proc?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
  signals?: readonly NodeJS.Signals[];
  unwindMs?: number;
  releaseMs?: number;
  timing?: SweepTiming;
}

export interface StandaloneInterrupt {
  /** Aborted by the first signal: hand it to withScorer (and anything else long). */
  readonly signal: AbortSignal;
  interrupted(): boolean;
  /** The handler itself (a spec drives it directly; the process drives it by signal). */
  handle(signal: string): Promise<void>;
  /** Remove the signal listeners. */
  dispose(): void;
}

/**
 * On SIGINT/SIGTERM: abort, let the run unwind (bounded), sweep this
 * process's ledger (bounded), exit 128+signal. A second signal exits at once.
 */
export function releaseOnInterrupt(deps: InterruptDeps): StandaloneInterrupt {
  const controller = new AbortController();
  const proc = deps.proc ?? process;
  const signals = deps.signals ?? ['SIGINT', 'SIGTERM'];
  const unwindMs = deps.unwindMs ?? INTERRUPT_UNWIND_MS;
  const releaseMs = deps.releaseMs ?? INTERRUPT_RELEASE_MS;
  let first: Promise<void> | null = null;

  const handle = (signal: string): Promise<void> => {
    const code = exitCodeOf(signal);
    if (first !== null) {
      deps.log(`${signal} again: exiting now, without waiting for the release`);
      deps.exit(code);
      return first;
    }
    interrupting = true;
    first = (async () => {
      deps.log(`${signal}: stopping the run and giving back what it holds on Crucible (${signal} again to exit at once)`);
      // Never kept alive past this, whatever hangs: the timer is ref'd on purpose.
      const hard = setTimeout(() => {
        deps.log(`the release is still running after ${Math.round((unwindMs + releaseMs) / 100) / 10} s; exiting`);
        deps.exit(code);
      }, unwindMs + releaseMs + 500);
      try {
        controller.abort();
        // Each run releases what it holds in its own finally; the sweep is for what it could not.
        if (!await deps.runsSettled(unwindMs)) deps.log(`the run is still unwinding after ${unwindMs} ms; sweeping what it recorded`);
        const report = await sweepCrucibleInFlight(
          { ledger: deps.ledger, clientFor: deps.clientFor, log: deps.log },
          { reason: `interrupted (${signal})`, deadlineMs: releaseMs, ...(deps.timing ? { timing: deps.timing } : {}) },
        );
        if (report.kept.length > 0) {
          deps.log(`could not give back ${report.kept.length} hold(s): ${report.kept.map((r) => `${r.kind} ${r.id} on "${r.server}"`).join(', ')} (it expires on its own)`);
        }
      } catch (err) {
        deps.log(`giving back after ${signal} failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(hard);
      }
      deps.exit(code);
    })();
    return first;
  };

  const listeners = signals.map((s) => [s, () => void handle(s)] as const);
  for (const [s, fn] of listeners) proc.on(s, fn);
  return {
    signal: controller.signal,
    interrupted: () => first !== null,
    handle,
    dispose: () => { for (const [s, fn] of listeners) proc.removeListener(s, fn); },
  };
}

/** {@link releaseOnInterrupt} for a tool's own process, over its {@link crucibleServices}. */
export function interruptible(services: Pick<StandaloneCrucible, 'ledger' | 'factory' | 'chat'>): StandaloneInterrupt {
  return releaseOnInterrupt({
    ledger: services.ledger,
    runsSettled: (ms) => services.chat.runsSettled(ms),
    clientFor: (name) => services.factory.clientFor(name, { timeoutMs: INTERRUPT_REQUEST_TIMEOUT_MS }),
    exit: (code) => process.exit(code),
    log: (line) => console.error(`# [interrupt] ${line}`),
  });
}

/**
 * A tool's exit: main's code (a void main just ends), or 1 on a throw — unless
 * a signal is already giving back what the run held, which exits by itself
 * when it is done.
 */
export function exitStandalone(main: Promise<number | void>): void {
  main.then(
    (code) => { if (!interrupting && typeof code === 'number') process.exit(code); },
    (err) => {
      if (interrupting) return;
      console.error(err instanceof Error ? err.stack || err.message : err);
      process.exit(1);
    },
  );
}

/** /v1/activity's answer to "is the card someone else's?": null when free, else the sentence. */
export async function cardHeldByOther(factory: CrucibleClientFactory, server: string): Promise<string | null> {
  const activity = await (await factory.clientFor(server)).activity();
  const mine = (client: string | null | undefined) => client === 'briefcase';
  if (activity.lease && !mine(activity.lease.client)) return `a lease by ${activity.lease.client ?? 'another client'} (${activity.lease.act})`;
  const running = activity.running.filter((j) => !mine(j.client));
  if (running.length) return `running ${running.map((j) => `${j.client ?? '?'}'s ${j.type}`).join(', ')}`;
  const queued = activity.queued.filter((j) => !mine(j.client));
  if (queued.length) return `queued ${queued.map((j) => `${j.client ?? '?'}'s ${j.type}`).join(', ')}`;
  const chats = chatsInFlight(activity);
  if (chats === null) return 'chats the server does not count (it states no chat activity)';
  if (chats > 0) return `${chats} chat(s) in flight`;
  return null;
}
