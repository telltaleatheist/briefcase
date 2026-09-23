/**
 * WHAT A CRUCIBLE SERVER SAYS ABOUT ITSELF, as a named outcome.
 *
 * Ported from BookForge's electron/crucible/probe.ts. `ping` is
 * unauthenticated and `info` is not, so the pair tells apart:
 *
 *   nothing there             → `unreachable`
 *   something, not a Crucible → `not_a_crucible`
 *   a Crucible, bad token     → `wrong_token`
 *   a Crucible, other API     → `version_mismatch`
 *   a Crucible                → `ok`, with its facts
 *
 * Every probe carries a clock (5 s per call): a sleeping Mac answers nothing
 * for minutes, and a Test button that hangs is worse than one that says so.
 *
 * `ok` is not permission to submit. It says the address answers; whether the
 * lane is free is settled at the door by `POST /v1/jobs` (P4). `busyLine` is a
 * display, read from `/v1/activity`, which is a preflight and never a lock.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  CrucibleAuthError,
  CrucibleNotACrucible,
  CrucibleUnreachable,
  CrucibleVersionError,
  type Activity,
  type CrucibleClient,
  type Ping,
} from '@crucible/client';
import { CrucibleClientFactory } from './client-factory';
import { CrucibleRegistryService } from './registry.service';
import { EngineResolveError, type ResolvedEngine } from './engine-resolve';
import { transportFailureCause } from './transport-failure';
import type {
  CapabilityFact,
  CrucibleProbeAnswer,
  CrucibleProbeResult,
  ServerFacts,
  ServerReach,
} from './wire/settings-wire';

/** The oldest Crucible Briefcase routes work to. Older servers are shown as "needs update". */
export const MIN_CRUCIBLE = '1.0.23';
/** The clock on each probe call. */
export const PROBE_TIMEOUT_MS = 5_000;
/** How long a probe answers `reach()` before it is asked again. The Test button bypasses it. */
export const PROBE_CACHE_MS = 10_000;

type Failure = Exclude<CrucibleProbeResult, { outcome: 'ok' }>;

/** `a` compared with `b` as dotted release numbers: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const pb = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError');
}

/**
 * One failure as the outcome a row shows. Every branch names what to fix; the
 * last keeps the message it was given rather than inventing one.
 */
export function failureOutcome(err: unknown, at: string): Failure {
  if (isTimeout(err)) {
    return {
      outcome: 'unreachable',
      message: `${at} did not answer within ${PROBE_TIMEOUT_MS / 1000} s. It may be asleep, off, or not reachable from this computer.`,
    };
  }
  if (err instanceof CrucibleUnreachable || transportFailureCause(err) !== null) {
    return {
      outcome: 'unreachable',
      message: `Nothing answered at ${at}. Check the address, that Crucible is running there, and that this computer can reach it.`,
    };
  }
  if (err instanceof CrucibleNotACrucible) {
    return {
      outcome: 'not_a_crucible',
      message: `${at} answered, but it is not a Crucible. Check the address: it is the base URL, without /v1.`,
    };
  }
  if (err instanceof CrucibleAuthError) {
    return {
      outcome: 'wrong_token',
      message: `${at} is a Crucible and refused this computer's access key (${err.serverMessage}). Remove it and connect again.`,
    };
  }
  if (err instanceof CrucibleVersionError) {
    return {
      outcome: 'version_mismatch',
      message: `${at} speaks Crucible API version ${err.serverApiVersion ?? 'unknown'}; Briefcase speaks `
        + `${err.clientApiVersion}. Update whichever is older.`,
    };
  }
  if (err instanceof EngineResolveError) return { outcome: 'refused', message: err.message };
  return { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
}

/** The holder of the card, in one sentence, or null when the lane accepts work. */
export function busyLineOf(activity: Activity): string | null {
  if (activity.slots.accelerated.acceptsWork) return null;
  const job = activity.running[0];
  if (job !== undefined) {
    return `busy: ${job.client ?? 'another app'}, ${job.type} ${Math.round(job.progress * 100)}% done`;
  }
  return 'busy: the GPU is not accepting work right now';
}

export function reachOf(result: CrucibleProbeResult): ServerReach {
  switch (result.outcome) {
    case 'ok': return result.facts.busyLine === null ? 'ready' : 'busy';
    case 'unreachable': return 'unreachable';
    case 'wrong_token': return 'bad_token';
    case 'not_a_crucible': return 'not_crucible';
    case 'version_mismatch': return 'version_mismatch';
    default: return 'refused';
  }
}

/** What one probe needs, so the same steps serve a registered server and unregistered credentials. */
export interface ProbeSteps {
  /** Unauthenticated ping at the address as given. */
  ping(): Promise<Ping>;
  /** `info` at the address, plus the one orchestrator hop. */
  resolve(): Promise<ResolvedEngine>;
  /** A clocked client on the resolved engine, for activity and capability. */
  engine(resolved: ResolvedEngine): Promise<CrucibleClient> | CrucibleClient;
}

/** ping, then info (through the hop), then activity and capability on the engine. */
export async function probeWith(steps: ProbeSteps, at: string): Promise<CrucibleProbeResult> {
  let resolved: ResolvedEngine;
  try {
    const pong = await steps.ping();
    if (pong.apiVersion !== 1) {
      return {
        outcome: 'version_mismatch',
        message: `${at} speaks Crucible API version ${pong.apiVersion}; Briefcase speaks 1. Update whichever is older.`,
      };
    }
    resolved = await steps.resolve();
  } catch (err) {
    return failureOutcome(err, at);
  }
  const info = resolved.info;
  if (info.server.apiVersion !== 1) {
    return {
      outcome: 'version_mismatch',
      message: `${at} speaks Crucible API version ${info.server.apiVersion}; Briefcase speaks 1. Update whichever is older.`,
    };
  }
  const engine = await steps.engine(resolved);
  let busyLine: string | null = null;
  let resident: string | null = null;
  try {
    const activity = await engine.activity();
    busyLine = busyLineOf(activity);
    resident = activity.resident?.id ?? null;
  } catch (err) {
    // The activity read is a display. A server that cannot answer it is still a server.
    const failure = failureOutcome(err, at);
    if (failure.outcome === 'wrong_token' || failure.outcome === 'unreachable') return failure;
  }
  let capabilities: CapabilityFact[] | null = null;
  try {
    const record = await engine.capability({ timeoutMs: PROBE_TIMEOUT_MS });
    capabilities = record.classes
      .filter((row) => row.capability === 'analysis' || row.capability === 'asr')
      .map((row) => ({
        capability: row.capability as 'analysis' | 'asr',
        enabled: row.enabled,
        selected: row.selected,
        route: row.route,
        reason: row.reason,
      }));
  } catch {
    // capability_undecided (503) or an older server: the facts say "not decided".
    capabilities = null;
  }
  const facts: ServerFacts = {
    serverName: info.server.name,
    version: info.server.version,
    apiVersion: info.server.apiVersion,
    platform: info.host.platform,
    arch: info.host.arch,
    backend: info.host.backend,
    gpu: { vendor: info.host.gpu.vendor, name: info.host.gpu.name, vramBytes: info.host.gpu.vramBytes },
    jobTypes: [...info.jobTypes],
    busyLine,
    resident,
    needsUpdate: compareVersions(info.server.version, MIN_CRUCIBLE) < 0,
    engineUrl: resolved.through === null ? null : resolved.url,
    capabilities,
  };
  return { outcome: 'ok', facts };
}

/**
 * Probes with a 10 s cache for `reach()` (the pane's first paint, and P4's
 * queue), and a fresh `test()` for the Test button. The cache is dropped for a
 * server whenever the registry changes.
 */
@Injectable()
export class CrucibleProbeService {
  private readonly logger = new Logger('CrucibleProbe');
  private readonly cache = new Map<string, CrucibleProbeAnswer>();
  private readonly inFlight = new Map<string, Promise<CrucibleProbeAnswer>>();

  /** The clock, replaceable by a spec. */
  now: () => number = Date.now;

  constructor(
    private readonly factory: CrucibleClientFactory,
    private readonly registry: CrucibleRegistryService,
  ) {
    registry.onChange((change) => {
      if (change.server === null) return;
      this.cache.delete(change.server);
    });
  }

  /** A probe no older than {@link PROBE_CACHE_MS}. */
  async reach(name: string): Promise<CrucibleProbeAnswer> {
    const cached = this.cache.get(name);
    if (cached !== undefined && this.now() - cached.at < PROBE_CACHE_MS) return cached;
    return this.test(name, false);
  }

  /** A probe taken now. `fresh` also drops the cached orchestrator hop. */
  async test(name: string, fresh = true): Promise<CrucibleProbeAnswer> {
    const running = this.inFlight.get(name);
    if (running !== undefined && !fresh) return running;
    const request = this.probeRegistered(name, fresh).finally(() => {
      if (this.inFlight.get(name) === request) this.inFlight.delete(name);
    });
    this.inFlight.set(name, request);
    return request;
  }

  private async probeRegistered(name: string, fresh: boolean): Promise<CrucibleProbeAnswer> {
    let result: CrucibleProbeResult;
    try {
      if (fresh) this.factory.forgetResolved(name);
      const address = this.factory.addressClientFor(name, { timeoutMs: PROBE_TIMEOUT_MS });
      result = await probeWith({
        ping: () => address.ping({ timeoutMs: PROBE_TIMEOUT_MS }),
        resolve: () => this.factory.resolve(name),
        engine: () => this.factory.clientFor(name, { timeoutMs: PROBE_TIMEOUT_MS }),
      }, `"${name}" (${address.url})`);
    } catch (err) {
      // An unknown name or a corrupt registry: each is already a named refusal.
      result = { outcome: 'refused', message: err instanceof Error ? err.message : String(err) };
    }
    const answer: CrucibleProbeAnswer = { server: name, reach: reachOf(result), probe: result, at: this.now() };
    if (this.registry.names().includes(name)) this.cache.set(name, answer);
    if (result.outcome !== 'ok') this.logger.debug(`Probe of "${name}": ${result.outcome}`);
    return answer;
  }

  /** A probe of credentials that are not registered yet. Never cached. */
  async probeCredentials(url: string, token: string, at = url): Promise<CrucibleProbeResult> {
    const address = this.factory.clientForCredentials(url, token, { timeoutMs: PROBE_TIMEOUT_MS });
    return probeWith({
      ping: () => address.ping({ timeoutMs: PROBE_TIMEOUT_MS }),
      resolve: () => this.factory.resolveCredentials(url, token),
      engine: (resolved) => this.factory.clientForCredentials(resolved.url, token, { timeoutMs: PROBE_TIMEOUT_MS }),
    }, at);
  }
}
