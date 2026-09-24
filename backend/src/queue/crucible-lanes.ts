/**
 * THE QUEUE'S CRUCIBLE LANES (migration plan §7, P4).
 *
 * Under `aiVia: 'crucible'` the AI pool of one is replaced by lanes:
 *
 *   gpu:<server>   one per ENABLED registered server, width 1: an analysis
 *                  whose model is a local model on that server. The card holds
 *                  one resident model, so one task at a time, holding one lease
 *                  for its whole run (a video is atomic on its card).
 *   cloud          one, width 2: an analysis whose model is an upstream
 *                  (`anthropic/…`, `openai/…`, `ollama/…`). It holds no card;
 *                  rate limits come back as 429 + Retry-After.
 *
 * The main pool (5) is not touched: downloads, imports and every other non-AI
 * task never read anything in this file. A `transcribe` (P5) is placed here:
 * a GPU lane when the venue rule puts it on Crucible (its reservation is the
 * asr submit), else back to the main pool as a whisper-cli task. Under `aiVia: 'direct'`
 * the queue keeps today's AI pool exactly (QueueManagerService.processQueue).
 *
 * This service DECIDES; the queue (queue-manager.service.ts) holds the slots.
 *
 *   place(target)            venue-decision.ts: which lane, or wait/fail
 *   preflight(server, target) a read of /v1/activity (cached 2 s): the
 *                            holder's sentence when someone else holds the
 *                            card, else null. A display and a preflight, never
 *                            permission: the door decides (a 409 at the
 *                            reservation parks the task too).
 *   residentOn(server)       what is on the card, for the same-model preference
 *   runAdmitted(...)         the reservation: one Crucible run (withRun) that
 *                            loads and leases the task's model on the chosen
 *                            server BEFORE the task's own work starts, holds it
 *                            (heartbeaten) across every call, and releases it
 *                            when the task settles. A busy card, a silent
 *                            server or no server anywhere in the run throws
 *                            `CrucibleParkedError`, which the queue parks on.
 *   sweep(...)               in-flight-sweep.ts over the ledger, at startup
 *                            (awaited by the lanes, never by the main pool) and
 *                            at quit (8 s deadline).
 */
import { BeforeApplicationShutdown, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { Activity } from '@crucible/client';
import { CrucibleClientFactory } from '../crucible/client-factory';
import { CRUCIBLE_IN_FLIGHT_LEDGER } from '../crucible/crucible.constants';
import { CrucibleServersService } from '../crucible/crucible-servers.service';
import { InFlightLedger } from '../crucible/in-flight-ledger';
import {
  QUIT_SWEEP_DEADLINE_MS,
  STARTUP_SWEEP_DEADLINE_MS,
  sweepCrucibleInFlight,
  type SweepReport,
  type SweepTiming,
} from '../crucible/in-flight-sweep';
import { resolveAiVia, type AiVia } from '../crucible/llm/ai-via';
import { CrucibleChatService } from '../crucible/llm/crucible-chat.service';
import { CrucibleBusyError, CrucibleChatError, CrucibleParkedError } from '../crucible/llm/errors';
import { crucibleTargetOf, type CrucibleTarget } from '../crucible/llm/target';
import { CrucibleProbeService } from '../crucible/probe';
import { CrucibleRegistryService } from '../crucible/registry.service';
import { decideVenue, type VenueAnswer } from '../crucible/venue-decision';
import type { ServerReach } from '../crucible/wire/settings-wire';
import type { Task } from '../common/interfaces/task.interface';
import { CrucibleTranscriptionService } from '../crucible/asr/crucible-transcription.service';

export const GPU_LANE_WIDTH = 1;
export const CLOUD_LANE_WIDTH = 2;
export const CLOUD_LANE = 'cloud';
/** §7.2: /v1/activity is read at most this often per server. */
export const ACTIVITY_CACHE_MS = 2_000;
/** §7.5: a Crucible task with no progress, no load event and no answered chat for this long is stalled. */
export const LANE_STALL_MS = 15 * 60_000;
/** §7.3: past this, a waiting task goes first whatever its model, so nothing starves. */
export const STARVATION_MS = 10 * 60_000;
/** §7.2 step 4: a parked task is asked again after 5 s, doubling to 60 s. */
export const PARK_FIRST_MS = 5_000;
export const PARK_MAX_MS = 60_000;

/**
 * The task types that go to lanes. `transcribe` (P5) goes to a GPU lane when
 * the venue rule puts it on Crucible; otherwise it is handed to the main pool
 * as a whisper-cli task (capped there, see QueueManagerService).
 */
export const LANE_TASK_TYPES: ReadonlySet<string> = new Set(['analyze', 'analyze-webpage', 'transcribe']);

/** The asr model a transcribe placement names, in the shape the lanes carry every target in. */
export function asrTarget(model: string): CrucibleTarget {
  return { model, route: 'local', upstream: null, bareModel: model };
}

export type TranscribePlaceAnswer =
  | { kind: 'lane'; placement: LanePlacement }
  | { kind: 'cli'; reason: string; warning: string | null };

export function gpuLaneOf(server: string): string {
  return `gpu:${server}`;
}

export function parkDelayMs(parkCount: number): number {
  return Math.min(PARK_MAX_MS, PARK_FIRST_MS * 2 ** Math.max(0, parkCount - 1));
}

export interface LanePlacement {
  lane: string;
  server: string;
  target: CrucibleTarget;
}

export type PlaceAnswer =
  | { kind: 'lane'; placement: LanePlacement }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string };

/** One running task, as a lane row shows it. */
export interface LaneTaskView {
  jobId: string;
  title: string;
  model: string;
  lane: string;
}

/** One lane, as the queue tab's lane strip draws it (SYSTEM_STATUS lanes / `queue.lanes`). */
export interface LaneView {
  id: string;
  kind: 'gpu' | 'cloud';
  label: string;
  server: string | null;
  state: 'ready' | 'busy' | 'unreachable' | 'paused' | 'unavailable';
  /** The holder's sentence while busy, or why the server is unavailable. */
  detail: string | null;
  residentModel: string | null;
  width: number;
  running: LaneTaskView[];
  /** Tasks parked or waiting for this lane. */
  waiting: number;
}

export interface LanesStatus {
  mode: AiVia;
  lanes: LaneView[];
  timestamp: string;
}

function shortClient(client: string | null | undefined): string {
  if (!client) return 'another app';
  return client.split(/\s+/)[0] || client;
}

/**
 * The holder's sentence when someone OTHER than us has the server's JOB lane
 * (a job running or queued, a claim, a streaming session), else null. PURE.
 *
 * For an `asr` job. A lease is NOT in the way of one: Crucible refuses a lease
 * only to jobs that would change the card's contents, and asr is not one of
 * them (SDK `CrucibleLeased`). The door still decides: a 409 at the submit parks.
 */
export function busyLineForJob(activity: Activity, ours: ReadonlySet<string>): string | null {
  const job = [...activity.running, ...activity.queued].find((j) => !ours.has(j.jobId));
  if (job !== undefined) {
    return `Crucible is busy: ${shortClient(job.client)}, ${job.type} ${Math.round(job.progress * 100)}% done`;
  }
  if (activity.claim !== null) return `Crucible is busy: ${shortClient(activity.claim.heldBy)} holds the card`;
  if (activity.streaming !== null) return 'Crucible is busy: a streaming session holds the card';
  return null;
}

/**
 * The holder's sentence when someone OTHER than us holds `server`'s card in a
 * way that a load of `target` would be refused, else null. PURE.
 *
 * A lease on the model we want is not in the way: the chat door serves the
 * resident model to anyone, and the reservation chats under that lease (P3).
 */
export function busyLineFor(activity: Activity, ours: ReadonlySet<string>, target: CrucibleTarget): string | null {
  const job = [...activity.running, ...activity.queued].find((j) => !ours.has(j.jobId));
  if (job !== undefined) {
    return `Crucible is busy: ${shortClient(job.client)}, ${job.type} ${Math.round(job.progress * 100)}% done`;
  }
  if (activity.claim !== null) return `Crucible is busy: ${shortClient(activity.claim.heldBy)} holds the card`;
  if (activity.streaming !== null) return 'Crucible is busy: a streaming session holds the card';
  const lease = activity.lease;
  if (lease !== null && !ours.has(lease.leaseId)) {
    const sameModel = target.route === 'local' && activity.resident?.id === target.model;
    if (!sameModel) {
      return `Crucible is busy: ${shortClient(lease.client)} has ${activity.resident?.id ?? 'the card'} leased for ${lease.act}`;
    }
  }
  return null;
}

@Injectable()
export class CrucibleLanesService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('CrucibleLanes');
  private readonly activityCache = new Map<string, { at: number; activity: Activity | null }>();

  /** Settles when the startup sweep has run. The lanes await it; the main pool never does. */
  ready: Promise<void> = Promise.resolve();

  /** Replaceable by a spec: the clock, the road, the sweep's per-server timing. */
  now: () => number = Date.now;
  via: () => AiVia = () => resolveAiVia().via;
  sweepTiming: SweepTiming | undefined;
  startupDeadlineMs = STARTUP_SWEEP_DEADLINE_MS;
  quitDeadlineMs = QUIT_SWEEP_DEADLINE_MS;

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly probes: CrucibleProbeService,
    private readonly chat: CrucibleChatService,
    private readonly factory: CrucibleClientFactory,
    private readonly registry: CrucibleRegistryService,
    @Optional() @Inject(CRUCIBLE_IN_FLIGHT_LEDGER) private readonly ledger?: InFlightLedger,
    /** P5: the transcription venue rule. Absent: every transcribe is whisper-cli in the main pool. */
    @Optional() private readonly transcription?: CrucibleTranscriptionService,
  ) {
    registry.onChange((change) => {
      if (change.server !== null) this.activityCache.delete(change.server);
      else this.activityCache.clear();
    });
  }

  onModuleInit(): void {
    this.ready = this.sweep('startup: giving back what the last run left on a Crucible card', this.startupDeadlineMs)
      .then(() => undefined, () => undefined);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.sweep('quitting', this.quitDeadlineMs);
  }

  /** 'crucible' when AI tasks go to lanes, 'direct' for today's AI pool. */
  mode(): AiVia {
    try {
      return this.via();
    } catch {
      return 'direct';
    }
  }

  /** Subscribe to registry changes (add, remove, rank, pause): parked work is asked again at once. */
  onServersChanged(listener: () => void): () => void {
    return this.registry.onChange(() => listener());
  }

  /** The Crucible target of an AI task's primary model. Throws a named error for a model that is not one. */
  targetOf(task: Task): CrucibleTarget {
    const options = (task.options ?? {}) as { aiModel?: string; aiProvider?: string };
    return crucibleTargetOf(options.aiProvider, options.aiModel ?? '');
  }

  widthOf(lane: string): number {
    return lane === CLOUD_LANE ? CLOUD_LANE_WIDTH : GPU_LANE_WIDTH;
  }

  async place(target: CrucibleTarget): Promise<PlaceAnswer> {
    const answer: VenueAnswer = await decideVenue(target, {
      enabled: () => this.servers.ranked(),
      reach: async (server) => {
        const probe = await this.probes.reach(server);
        return { reach: probe.reach, message: probe.probe.outcome === 'ok' ? undefined : probe.probe.message };
      },
      canServe: (server, t) => this.chat.canServe(server, t),
    });
    if (answer.kind !== 'venue') return answer;
    const lane = target.route === 'upstream' ? CLOUD_LANE : gpuLaneOf(answer.server);
    return { kind: 'lane', placement: { lane, server: answer.server, target } };
  }

  /**
   * Where a transcribe task runs (P5): a GPU lane when the venue rule puts it
   * on Crucible, else whisper-cli in the main pool, with the warning to put on
   * the task when that is a fallback. Never 'wait': a transcription always has
   * whisper-cli to fall back to (the user's rule, 2026-09-23).
   */
  async placeTranscribe(task: Task): Promise<TranscribePlaceAnswer> {
    if (this.transcription === undefined) return { kind: 'cli', reason: 'Crucible transcription is not available in this build.', warning: null };
    const translate = (task.options as { translate?: unknown } | undefined)?.translate === true;
    const route = await this.transcription.route({ translate });
    if (route.kind === 'cli') return route;
    return { kind: 'lane', placement: { lane: gpuLaneOf(route.server), server: route.server, target: asrTarget(route.model) } };
  }

  /** The holder's sentence when another client has `server`'s job lane, else null (the asr preflight). */
  async preflightJob(server: string): Promise<string | null> {
    const activity = await this.activity(server);
    if (activity === null) return null;
    return busyLineForJob(activity, this.ledger?.idsOn(server) ?? new Set());
  }

  /** `/v1/activity` on `server`, cached {@link ACTIVITY_CACHE_MS}; null when it cannot be read. */
  async activity(server: string): Promise<Activity | null> {
    const cached = this.activityCache.get(server);
    if (cached !== undefined && this.now() - cached.at < ACTIVITY_CACHE_MS) return cached.activity;
    let activity: Activity | null = null;
    try {
      const client = await this.factory.clientFor(server, { timeoutMs: 5_000 });
      activity = await client.activity();
    } catch {
      activity = null;
    }
    this.activityCache.set(server, { at: this.now(), activity });
    return activity;
  }

  forgetActivity(server?: string): void {
    if (server === undefined) this.activityCache.clear();
    else this.activityCache.delete(server);
  }

  /** The holder's sentence when another client holds the card, else null (§7.2 step 2). */
  async preflight(server: string, target: CrucibleTarget): Promise<string | null> {
    const activity = await this.activity(server);
    if (activity === null) return null;
    return busyLineFor(activity, this.ledger?.idsOn(server) ?? new Set(), target);
  }

  async residentOn(server: string): Promise<string | null> {
    return (await this.activity(server))?.resident?.id ?? null;
  }

  /**
   * THE RESERVATION, then the task. One Crucible run: load + lease the
   * target on `server` (a local model), pin the venue, run `fn` inside it,
   * release in the run's finally. Anything that means "not now" becomes
   * `CrucibleParkedError`: a busy card at the reservation, a server that stops
   * answering, and a park chosen by a call inside the task (which the task
   * reports as an unsuccessful result, since media-ops turns errors into
   * results).
   */
  async runAdmitted<T>(
    admission: LanePlacement & { signal: AbortSignal; localId: string; onActivity: () => void },
    fn: () => Promise<T>,
  ): Promise<T> {
    const { server, target, signal } = admission;
    return this.chat.withRun(async () => {
      let reserved = false;
      try {
        return await this.chat.withModel(server, target.model, async () => {
          reserved = true;
          const result = await fn();
          const parked = this.chat.parkedInRun();
          const ok = typeof result === 'object' && result !== null && (result as { success?: unknown }).success === true;
          if (parked !== null && !ok) throw new CrucibleParkedError(parked.server ?? server, parked.reason);
          return result;
        }, { signal });
      } catch (err) {
        if (!reserved && err instanceof CrucibleBusyError) throw new CrucibleParkedError(err.server, err.busyLine);
        if (!reserved && err instanceof CrucibleChatError && err.code === 'unreachable') {
          throw new CrucibleParkedError(server, `Crucible on ${server} isn't answering.`);
        }
        throw err;
      } finally {
        this.activityCache.delete(server);
      }
    }, { parkOnBusy: true, onActivity: admission.onActivity, localId: admission.localId });
  }

  /** Give back what the ledger lists. Never throws. */
  async sweep(reason: string, deadlineMs: number, server?: string): Promise<SweepReport | null> {
    if (this.ledger === undefined) return null;
    try {
      return await sweepCrucibleInFlight({
        ledger: this.ledger,
        clientFor: (name) => this.factory.clientFor(name, { timeoutMs: 5_000 }),
        log: (line) => this.logger.log(line),
      }, { reason, deadlineMs, ...(server === undefined ? {} : { server }), ...(this.sweepTiming ? { timing: this.sweepTiming } : {}) });
    } catch (err) {
      this.logger.warn(`The Crucible sweep failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Every lane as the queue tab draws it: one GPU lane per registered server
   * (a paused one shown paused), then the cloud lane. `running` and `waiting`
   * come from the queue.
   */
  async lanesStatus(running: LaneTaskView[], waitingByLane: Map<string, number>): Promise<LanesStatus> {
    const mode = this.mode();
    const lanes: LaneView[] = [];
    if (mode === 'crucible') {
      let rows: Array<{ name: string; enabled: boolean }> = [];
      try {
        rows = this.servers.routing().ranked;
      } catch {
        rows = [];
      }
      for (const row of rows) {
        const id = gpuLaneOf(row.name);
        let state: LaneView['state'] = 'paused';
        let detail: string | null = null;
        let residentModel: string | null = null;
        if (row.enabled) {
          const probe = await this.probes.reach(row.name).catch(() => null);
          const reach: ServerReach = probe?.reach ?? 'unreachable';
          if (reach === 'ready' || reach === 'busy') {
            const activity = await this.activity(row.name);
            residentModel = activity?.resident?.id ?? null;
            const ours = this.ledger?.idsOn(row.name) ?? new Set<string>();
            const busy = activity === null ? null : busyLineFor(activity, ours, { model: '', route: 'upstream', upstream: null, bareModel: '' });
            state = busy === null ? 'ready' : 'busy';
            detail = busy;
          } else {
            state = reach === 'unreachable' ? 'unreachable' : 'unavailable';
            detail = probe !== null && probe.probe.outcome !== 'ok' ? probe.probe.message : `Crucible on ${row.name} isn't answering.`;
          }
        }
        lanes.push({
          id, kind: 'gpu', label: `GPU · ${row.name}`, server: row.name, state, detail, residentModel,
          width: GPU_LANE_WIDTH, running: running.filter((t) => t.lane === id), waiting: waitingByLane.get(id) ?? 0,
        });
      }
      lanes.push({
        id: CLOUD_LANE, kind: 'cloud', label: 'Cloud', server: null, state: 'ready', detail: null, residentModel: null,
        width: CLOUD_LANE_WIDTH, running: running.filter((t) => t.lane === CLOUD_LANE), waiting: waitingByLane.get(CLOUD_LANE) ?? 0,
      });
    }
    return { mode, lanes, timestamp: new Date(this.now()).toISOString() };
  }

  /** Running/Paused, the routing record's per-server switch (P1). */
  setPaused(server: string, paused: boolean): void {
    if (paused) this.servers.pause(server);
    else this.servers.resume(server);
  }
}
