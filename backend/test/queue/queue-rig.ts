/**
 * A QueueManagerService wired by hand over stubs: media operations that are
 * gated promises (so a spec decides when a download or an analysis finishes
 * and can count how many ran at once), a two-library manager, a recording
 * event bus, the lanes (a scripted StubLanes, or the real CrucibleLanesService
 * against the fake Crucible) and the readiness gate (a scripted StubReadiness,
 * or the real one).
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';
import { QueueManagerService } from '../../src/queue/queue-manager.service';
import {
  asrTarget,
  CLOUD_LANE,
  gpuLaneOf,
  type TranscribePlaceAnswer,
  type CrucibleLanesService,
  type LanePlacement,
  type LanesStatus,
  type LaneTaskView,
  type PlaceAnswer,
} from '../../src/queue/crucible-lanes';
import { crucibleTargetOf, type CrucibleTarget } from '../../src/crucible/llm/target';
import { CrucibleParkedError } from '../../src/crucible/llm/errors';
import type { Task, TaskResult } from '../../src/common/interfaces/task.interface';
import type { WhisperRoute } from '../../src/media/whisper.service';
import { CrucibleRequiredError, type CrucibleReadinessService } from '../../src/crucible/readiness.service';
import type { CrucibleReadinessView } from '../../src/crucible/wire/readiness-wire';

Logger.overrideLogger(false);

export interface Gate<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until `check` holds (polling the event loop), or throw after `ms`. */
export async function until(check: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

/** Media operations whose every call is recorded and, for the long ones, gated. */
export class StubMedia {
  readonly calls: Array<{ op: string; arg: string; taskId: string }> = [];
  running = 0;
  maxRunning = 0;
  runningDownloads = 0;
  maxDownloads = 0;
  /** When set, each call to this op waits for a gate the spec resolves (keyed by taskId). */
  readonly gated = new Set<string>();
  readonly gates = new Map<string, Gate<TaskResult>>();
  /** A fixed delay for ungated long ops. */
  delayMs = 5;
  /** Replaces analyzeVideo's body (runs inside the task's Crucible run when admitted to a lane). */
  analyze?: (videoId: string, options: Record<string, unknown>, taskId: string) => Promise<TaskResult>;
  /** Replaces transcribeVideo's body (P5): sees the route the queue placed it on. */
  transcribe?: (videoId: string, taskId: string, route: WhisperRoute | undefined) => Promise<TaskResult>;
  /** The route every transcribeVideo call was given, in call order (P5). */
  readonly transcribeRoutes: Array<{ taskId: string; route: WhisperRoute | undefined }> = [];
  private nextVideo = 1;

  private async op(op: string, arg: string, taskId: string, result: () => TaskResult): Promise<TaskResult> {
    this.calls.push({ op, arg, taskId });
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    if (op === 'download') {
      this.runningDownloads++;
      this.maxDownloads = Math.max(this.maxDownloads, this.runningDownloads);
    }
    try {
      if (this.gated.has(op)) {
        const g = gate<TaskResult>();
        this.gates.set(`${op}:${taskId}`, g);
        return await g.promise;
      }
      await tick(this.delayMs);
      return result();
    } finally {
      this.running--;
      if (op === 'download') this.runningDownloads--;
    }
  }

  release(op: string, taskId: string, result: TaskResult = { success: true, data: {} }): void {
    const g = this.gates.get(`${op}:${taskId}`);
    if (!g) throw new Error(`no gate for ${op}:${taskId}`);
    this.gates.delete(`${op}:${taskId}`);
    g.resolve(result);
  }

  getVideoInfo = (url: string, taskId: string) => this.op('get-info', url, taskId, () => ({ success: true, data: { title: url } }));
  downloadVideo = (url: string, _o: unknown, taskId: string) => this.op('download', url, taskId, () => ({ success: true, data: { videoPath: `/tmp/${encodeURIComponent(url)}.mp4`, title: url } }));
  importToLibrary = (p: string, _o: unknown, taskId: string) => this.op('import', p, taskId, () => ({ success: true, data: { videoId: `v${this.nextVideo++}` } }));
  transcribeVideo = (id: string, taskId: string, route?: WhisperRoute): Promise<TaskResult> => {
    this.transcribeRoutes.push({ taskId, route });
    if (this.transcribe) {
      this.calls.push({ op: 'transcribe', arg: id, taskId });
      return this.transcribe(id, taskId, route);
    }
    return this.op('transcribe', id, taskId, () => ({ success: true, data: { transcriptPath: '/tmp/t.srt' } }));
  };
  normalizeAudio = (id: string, _o: unknown, taskId: string) => this.op('normalize-audio', id, taskId, () => ({ success: true, data: {} }));
  fixAspectRatio = (id: string, _o: unknown, taskId: string) => this.op('fix-aspect-ratio', id, taskId, () => ({ success: true, data: {} }));
  processVideo = (id: string, _o: unknown, taskId: string) => this.op('process-video', id, taskId, () => ({ success: true, data: {} }));
  analyzeVideo = (id: string, options: Record<string, unknown>, taskId: string): Promise<TaskResult> => {
    if (this.analyze) {
      this.calls.push({ op: 'analyze', arg: id, taskId });
      return this.analyze(id, options, taskId);
    }
    return this.op('analyze', id, taskId, () => ({ success: true, data: { sectionsCount: 1 } }));
  };
  analyzeWebpage = (id: string, _o: unknown, taskId: string) => this.op('analyze-webpage', id, taskId, () => ({ success: true, data: {} }));
  regenerateThumbnail = async () => undefined;
  refreshVideoDimensions = async () => undefined;
  setVideoFlag = async () => undefined;

  started(op: string): string[] {
    return this.calls.filter((c) => c.op === op).map((c) => c.taskId);
  }
}

export class StubLibraries {
  active = 'lib-a';
  readonly switched: string[] = [];
  getActiveLibrary() { return { id: this.active, clipsFolderPath: `/tmp/${this.active}` }; }
  getAllLibraries() { return [this.getActiveLibrary(), { id: 'lib-b', clipsFolderPath: '/tmp/lib-b' }]; }
  async switchLibrary(id: string) { this.switched.push(id); this.active = id; return true; }
}

/**
 * The lanes, scripted: which server a model lands on, who is busy, what is
 * resident, and whether the reservation parks. Records every admission.
 */
export class StubLanes {
  ready: Promise<void> = Promise.resolve();
  offset = 0;
  now = (): number => Date.now() + this.offset;
  /** model → server; upstream models go to the cloud lane on `cloudServer`. */
  serverOf = new Map<string, string>();
  cloudServer = 'mac';
  /** A wait answer for a model (no venue). */
  waitFor = new Map<string, string>();
  /** server → holder sentence at the preflight. */
  busy = new Map<string, string>();
  /** server → holder sentence at the reservation (the door's 409). */
  doorBusy = new Map<string, string>();
  /**
   * P5: where a transcribe goes. `{server, model}` for a GPU lane (the
   * default: mac's large-v3), or `{wait: reason}` when no server can take it
   * (the task parks: there is no other transcriber).
   */
  transcribeTo: { server: string; model: string } | { wait: string } = { server: 'mac', model: 'qwen3-asr-1.7b' };
  placeTranscribeCalls = 0;
  /** server → holder sentence at the asr (job-lane) preflight. */
  jobBusy = new Map<string, string>();
  resident = new Map<string, string>();
  readonly admitted: Array<{ jobId: string; lane: string; model: string }> = [];
  readonly signals = new Map<string, AbortSignal>();
  readonly activity = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  placeCalls = 0;

  onServersChanged(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  serversChanged() { for (const l of this.listeners) l(); }
  targetOf(task: Task): CrucibleTarget {
    const o = (task.options ?? {}) as { aiModel?: string; aiProvider?: string };
    return crucibleTargetOf(o.aiProvider, o.aiModel ?? '');
  }
  widthOf(lane: string) { return lane === CLOUD_LANE ? 2 : 1; }
  async place(target: CrucibleTarget): Promise<PlaceAnswer> {
    this.placeCalls++;
    const wait = this.waitFor.get(target.model);
    if (wait !== undefined) return { kind: 'wait', reason: wait };
    if (target.route === 'upstream') return { kind: 'lane', placement: { lane: CLOUD_LANE, server: this.cloudServer, target } };
    const server = this.serverOf.get(target.model) ?? 'mac';
    return { kind: 'lane', placement: { lane: gpuLaneOf(server), server, target } };
  }
  async placeTranscribe(): Promise<TranscribePlaceAnswer> {
    this.placeTranscribeCalls++;
    const to = this.transcribeTo;
    if ('wait' in to) return { kind: 'wait', reason: to.wait };
    return { kind: 'lane', placement: { lane: gpuLaneOf(to.server), server: to.server, target: asrTarget(to.model) } };
  }
  async preflightJob(server: string) { return this.jobBusy.get(server) ?? null; }
  async residentOn(server: string) { return this.resident.get(server) ?? null; }
  async preflight(server: string) { return this.busy.get(server) ?? null; }
  forgetActivity() { /* nothing cached */ }
  async runAdmitted<T>(admission: LanePlacement & { signal: AbortSignal; localId: string; onActivity: () => void }, fn: () => Promise<T>): Promise<T> {
    this.admitted.push({ jobId: admission.localId, lane: admission.lane, model: admission.target.model });
    this.signals.set(admission.localId, admission.signal);
    this.activity.set(admission.localId, admission.onActivity);
    const line = this.doorBusy.get(admission.server);
    if (line !== undefined) throw new CrucibleParkedError(admission.server, line);
    return fn();
  }
  async lanesStatus(running: LaneTaskView[]): Promise<LanesStatus> {
    return { lanes: running.length ? [] : [], timestamp: new Date().toISOString() };
  }
  setPaused() { /* recorded by specs that need it */ }
}

/**
 * The readiness gate, scripted: `ready` (the default), or a view whose state
 * refuses or parks. Records what the queue told it about waiting AI work.
 */
export class StubReadiness {
  view: CrucibleReadinessView = {
    state: 'ready', reason: 'Crucible on mac is ready.', action: null, server: 'mac', busy: null,
    progress: null, declined: false, aiWaiting: 0, at: new Date(0).toISOString(),
  };
  readonly waiting: number[] = [];
  assertCalls = 0;
  private readonly listeners = new Set<(view: CrucibleReadinessView) => void>();
  current() { return this.view; }
  set(view: Partial<CrucibleReadinessView>) {
    this.view = { ...this.view, ...view };
    for (const l of this.listeners) l(this.view);
  }
  onChange(listener: (view: CrucibleReadinessView) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  assertCanQueue(what: string) {
    this.assertCalls++;
    const v = this.view;
    if (v.state === 'ready' || v.state === 'starting' || (v.state === 'unreachable' && !v.declined)) return;
    throw new CrucibleRequiredError(what, v);
  }
  assertReadyNow(what: string) { if (this.view.state !== 'ready') throw new CrucibleRequiredError(what, this.view); }
  noteAiWaiting(count: number) { this.waiting.push(count); }
}

export interface Rig {
  qm: QueueManagerService;
  media: StubMedia;
  libraries: StubLibraries;
  emitter: EventEmitter2;
  events: Array<{ name: string; data: Record<string, any> }>;
  db: Record<string, jest.Mock>;
  readiness: StubReadiness | CrucibleReadinessService;
}

export function makeRig(lanes: StubLanes | CrucibleLanesService = new StubLanes(), readiness: StubReadiness | CrucibleReadinessService = new StubReadiness()): Rig {
  const media = new StubMedia();
  const libraries = new StubLibraries();
  const emitter = new EventEmitter2();
  const events: Rig['events'] = [];
  const eventService = {
    emit: (name: string, data: Record<string, any>) => { events.push({ name, data }); },
    emitTaskProgress: jest.fn(),
    emitVideoPathUpdated: jest.fn(),
  };
  const db = {
    findVideoByUrl: jest.fn(() => null),
    updateVideoSourceUrl: jest.fn(),
    updateLastProcessedDate: jest.fn(),
    updateVideoMetadata: jest.fn(),
    getTranscript: jest.fn(() => null),
    deleteTranscript: jest.fn(),
    findVideoById: jest.fn(() => null),
    getVideoById: jest.fn(() => null),
  };
  const qm = new QueueManagerService(
    media as never,
    eventService as never,
    libraries as never,
    db as never,
    emitter,
    {} as never,
    {} as never,
    {} as never,
    lanes as never,
    readiness as never,
  );
  return { qm, media, libraries, emitter, events, db, readiness };
}

export function analyzeJob(videoId: string, aiModel: string, extra: Record<string, unknown> = {}) {
  return {
    videoId,
    displayName: `video ${videoId}`,
    tasks: [{ type: 'analyze', options: { aiModel } } as Task],
    ...extra,
  };
}

export function transcribeJob(videoId: string, options: Record<string, unknown> = {}) {
  return { videoId, displayName: `video ${videoId}`, tasks: [{ type: 'transcribe', options } as Task] };
}

export function downloadJob(url: string, withAnalyze?: string) {
  const tasks: Task[] = [
    { type: 'download', options: {} } as Task,
    { type: 'import', options: {} } as Task,
  ];
  if (withAnalyze) tasks.push({ type: 'analyze', options: { aiModel: withAnalyze } } as Task);
  return { url, displayName: url, tasks };
}
