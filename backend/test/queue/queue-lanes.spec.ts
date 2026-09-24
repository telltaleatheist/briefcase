/**
 * The queue's Crucible lanes (migration plan §7, P4), over scripted lanes:
 * lane assignment, parking and re-admission, the same-model preference and
 * its starvation guard, the stall watchdog, cancel in every state, the
 * library guard, restart semantics, and (P7) the readiness gate at the door:
 * lanes are the only place AI work runs.
 */
import { LANE_STALL_MS, STARVATION_MS } from '../../src/queue/crucible-lanes';
import { CrucibleRequiredError } from '../../src/crucible/readiness.service';
import { analyzeJob, downloadJob, makeRig, StubLanes, StubReadiness, tick, transcribeJob, until, type Rig } from './queue-rig';

const LOCAL_9B = 'local:qwen3.5-9b';
const LOCAL_4B = 'local:qwen3.5-4b';
const CLAUDE = 'claude:claude-sonnet-5';

function gatedRig(lanes?: StubLanes): Rig {
  const rig = makeRig(lanes);
  rig.media.gated.add('analyze');
  return rig;
}

afterEach(() => jest.useRealTimers());

describe('the readiness gate at the door (P7)', () => {
  it('a job that needs Crucible is refused BY NAME when it could never run (nothing to connect to); nothing is queued', () => {
    const readiness = new StubReadiness();
    readiness.set({ state: 'not-installed', reason: 'Crucible is not installed.', action: 'install', server: null });
    const rig = makeRig(new StubLanes(), readiness);
    expect(() => rig.qm.addJob(analyzeJob('v1', LOCAL_9B))).toThrow(CrucibleRequiredError);
    expect(() => rig.qm.addJob(transcribeJob('v2'))).toThrow(/Transcription needs Crucible\. Crucible is not installed\./);
    expect(rig.qm.getAllJobs()).toHaveLength(0);
    rig.qm.onModuleDestroy();
  });

  it('a job with no AI task never asks the gate, whatever Crucible is doing', async () => {
    const readiness = new StubReadiness();
    readiness.set({ state: 'not-configured', reason: 'Every Crucible server is paused.', action: 'connect', server: null });
    const rig = makeRig(new StubLanes(), readiness);
    const id = rig.qm.addJob(downloadJob('https://example.com/a'));
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(readiness.assertCalls).toBe(0);
    rig.qm.onModuleDestroy();
  });

  it('a registered server that is merely down (or starting) is not a refusal: the work is accepted and parks', async () => {
    const readiness = new StubReadiness();
    readiness.set({ state: 'unreachable', reason: "Crucible on mac isn't answering.", action: 'connect', server: null });
    const lanes = new StubLanes();
    lanes.waitFor.set('qwen3.5-9b', "Crucible on mac isn't answering.");
    const rig = makeRig(lanes, readiness);
    rig.qm.onModuleInit();
    const id = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    // The queue told readiness AI work is waiting (the moment it asks, or starts the Crucible here).
    expect(readiness.waiting.at(-1)).toBe(1);
    // Crucible back: parked work is asked again at once.
    lanes.waitFor.clear();
    readiness.set({ state: 'ready', reason: 'Crucible on mac is ready.', action: null, server: 'mac' });
    await until(() => rig.media.started('analyze').includes(id));
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    rig.qm.onModuleDestroy();
  });

  it('declined (the user said "Not now"): a job that needs Crucible is refused, so nothing parks for ever', () => {
    const readiness = new StubReadiness();
    readiness.set({ state: 'unreachable', reason: 'Crucible is stopped on this computer.', action: 'start', declined: true, server: null });
    const rig = makeRig(new StubLanes(), readiness);
    expect(() => rig.qm.addJob(analyzeJob('v1', LOCAL_9B))).toThrow(CrucibleRequiredError);
    rig.qm.onModuleDestroy();
  });

  it('a staged (paused) job is checked when it is started: all or none', () => {
    const readiness = new StubReadiness();
    const rig = makeRig(new StubLanes(), readiness);
    const staged = rig.qm.addJob(analyzeJob('v1', LOCAL_9B), { paused: true });
    const plain = rig.qm.addJob(downloadJob('https://example.com/b'), { paused: true });
    readiness.set({ state: 'not-installed', reason: 'Crucible is not installed.', action: 'install', server: null });
    expect(() => rig.qm.startJobs([staged, plain])).toThrow(CrucibleRequiredError);
    expect(rig.qm.getJob(staged)?.status).toBe('paused');
    expect(rig.qm.getJob(plain)?.status).toBe('paused');
    expect(rig.qm.startJobs([plain])).toBe(1);
    rig.qm.onModuleDestroy();
  });

  it('AI tasks run only on lanes: there is no AI pool, and none is ever in the main pool', async () => {
    const rig = gatedRig(new StubLanes());
    const a = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.media.started('analyze').length === 1);
    expect(rig.qm.getLanePool().get(a)?.pool).toBe('lane');
    expect([...rig.qm.getMainPool().values()].some((t) => t.type === 'analyze')).toBe(false);
    rig.media.release('analyze', a);
    await until(() => rig.qm.getJob(a)?.status === 'completed');
  });
});

describe('lanes: assignment', () => {
  it('a local model goes to its server’s GPU lane, one at a time per server; two servers run side by side', async () => {
    const lanes = new StubLanes();
    lanes.serverOf.set('qwen3.5-4b', 'pc');
    const rig = gatedRig(lanes);
    const mac1 = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    const mac2 = rig.qm.addJob(analyzeJob('v2', LOCAL_9B));
    const pc1 = rig.qm.addJob(analyzeJob('v3', LOCAL_4B));
    await until(() => rig.media.started('analyze').length === 2);
    await tick(20);
    expect(rig.media.started('analyze').sort()).toEqual([mac1, pc1].sort());
    expect([...rig.qm.getLanePool().values()].map((t) => t.lane).sort()).toEqual(['gpu:mac', 'gpu:pc']);
    // The second mac task WAITS for the lane; it is not parked (nobody else holds the card).
    expect(rig.qm.getJob(mac2)).toMatchObject({ status: 'pending' });
    expect(rig.qm.getJob(mac2)?.parkedReason).toBeUndefined();
    rig.media.release('analyze', mac1);
    await until(() => rig.media.started('analyze').includes(mac2));
    expect(rig.qm.getJob(mac2)).toMatchObject({ lane: 'gpu:mac', venue: 'mac' });
    rig.media.release('analyze', mac2);
    rig.media.release('analyze', pc1);
    await until(() => rig.qm.getJob(mac2)?.status === 'completed' && rig.qm.getJob(pc1)?.status === 'completed');
  });

  it('upstream models run two wide on the cloud lane, alongside a busy GPU lane', async () => {
    const lanes = new StubLanes();
    lanes.busy.set('mac', 'Crucible is busy: bookforge, tts 40% done');
    const rig = gatedRig(lanes);
    const gpu = rig.qm.addJob(analyzeJob('v0', LOCAL_9B));
    const c1 = rig.qm.addJob(analyzeJob('v1', CLAUDE));
    const c2 = rig.qm.addJob(analyzeJob('v2', CLAUDE));
    const c3 = rig.qm.addJob(analyzeJob('v3', CLAUDE));
    await until(() => rig.media.started('analyze').length === 2);
    await tick(20);
    expect(rig.media.started('analyze').sort()).toEqual([c1, c2].sort());
    expect(rig.qm.getJob(gpu)?.parkedReason).toBe('Crucible is busy: bookforge, tts 40% done');
    expect(rig.qm.getJob(c3)?.parkedReason).toBeUndefined();
    rig.media.release('analyze', c1);
    await until(() => rig.media.started('analyze').includes(c3));
    expect(lanes.admitted.find((a) => a.jobId === c3)).toMatchObject({ lane: 'cloud', model: 'anthropic/claude-sonnet-5' });
    rig.media.release('analyze', c2);
    rig.media.release('analyze', c3);
    rig.qm.onModuleDestroy();
  });

  it('a model that is not one fails at once, by name; a model with no venue waits with the reason', async () => {
    const lanes = new StubLanes();
    lanes.waitFor.set('anthropic/claude-sonnet-5', 'No running Crucible server has Claude configured. Add it in Settings › Crucible Servers.');
    const rig = gatedRig(lanes);
    const bad = rig.qm.addJob({ videoId: 'v1', tasks: [{ type: 'analyze', options: { aiModel: 'x', aiProvider: 'bogus' } } as never] });
    const waiting = rig.qm.addJob(analyzeJob('v2', CLAUDE));
    await until(() => rig.qm.getJob(bad)?.status === 'failed' && rig.qm.getJob(waiting)?.parkedReason !== undefined);
    expect(rig.qm.getJob(bad)?.error).toMatch(/not an AI provider/);
    expect(rig.qm.getJob(waiting)).toMatchObject({ status: 'pending', parkedReason: expect.stringMatching(/Claude configured/) });
    rig.qm.onModuleDestroy();
  });
});

describe('lanes: parking', () => {
  it('a busy card at the preflight parks the task with the holder’s sentence; it is re-admitted when the server frees', async () => {
    const lanes = new StubLanes();
    lanes.busy.set('mac', 'Crucible is busy: bookforge, tts 40% done');
    const rig = gatedRig(lanes);
    const id = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    const job = rig.qm.getJob(id)!;
    expect(job).toMatchObject({ status: 'pending', parkedReason: 'Crucible is busy: bookforge, tts 40% done', parkedServer: 'mac', parkCount: 1 });
    expect(job.parkedUntil! - lanes.now()).toBeGreaterThan(4000);
    expect(rig.qm.getLanePool().size).toBe(0);
    expect(rig.qm.hasActiveTasks()).toBe(false);
    expect(rig.events.filter((e) => e.name === 'task.parked')).toEqual([
      { name: 'task.parked', data: expect.objectContaining({ jobId: id, reason: 'Crucible is busy: bookforge, tts 40% done', server: 'mac' }) },
    ]);
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);

    // Asked again before the backoff: still parked, and not re-announced.
    (rig.qm as any).processQueue();
    await rig.qm.settleAdmission();
    expect(rig.media.started('analyze')).toHaveLength(0);

    // Still busy at the next ask: parked again, with a longer backoff.
    lanes.offset += 6_000;
    (rig.qm as any).processQueue();
    await rig.qm.settleAdmission();
    expect(rig.qm.getJob(id)?.parkCount).toBe(2);
    expect(rig.qm.getJob(id)!.parkedUntil! - lanes.now()).toBeGreaterThan(9000);
    expect(rig.events.filter((e) => e.name === 'task.parked')).toHaveLength(1);

    // The server frees; the next ask admits it.
    lanes.busy.delete('mac');
    lanes.offset += 11_000;
    (rig.qm as any).processQueue();
    await until(() => rig.media.started('analyze').includes(id));
    expect(rig.qm.getJob(id)?.parkedReason).toBeUndefined();
    expect(rig.events.some((e) => e.name === 'task.unparked' && e.data.jobId === id)).toBe(true);
    rig.media.release('analyze', id);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it('a 409 at the door (the reservation) parks too, freeing the lane, and a registry change re-asks at once', async () => {
    const lanes = new StubLanes();
    lanes.doorBusy.set('mac', 'leased: foundry, translate');
    const rig = gatedRig(lanes);
    rig.qm.onModuleInit(); // subscribes to registry changes
    const id = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.qm.getJob(id)?.parkedReason === 'leased: foundry, translate');
    await until(() => rig.qm.getLanePool().size === 0);
    expect(rig.qm.getJob(id)?.status).toBe('pending');
    expect(rig.media.started('analyze')).toHaveLength(0);
    lanes.doorBusy.delete('mac');
    lanes.serversChanged();
    await until(() => rig.media.started('analyze').includes(id));
    rig.media.release('analyze', id);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    rig.qm.onModuleDestroy();
  });

  it('a park chosen inside the run (unparkable result) returns the task to waiting, never failed', async () => {
    const lanes = new StubLanes();
    const rig = makeRig(lanes);
    let calls = 0;
    const { CrucibleParkedError } = await import('../../src/crucible/llm/errors');
    // The first run parks from inside (as a busy card on a second model would);
    // the second runs to the end.
    lanes.runAdmitted = (async (admission: any, fn: () => Promise<any>) => {
      lanes.admitted.push({ jobId: admission.localId, lane: admission.lane, model: admission.target.model });
      calls++;
      if (calls === 1) {
        await fn();
        throw new CrucibleParkedError('mac', 'Crucible is busy: bookforge, align 10% done');
      }
      return fn();
    }) as any;
    const id = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: 'Crucible is busy: bookforge, align 10% done' });
    lanes.offset += 6_000;
    (rig.qm as any).processQueue();
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(calls).toBe(2);
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it('a parked task holds no slot: other lanes and the main pool run on, and a library switch is not blocked', async () => {
    const lanes = new StubLanes();
    lanes.busy.set('mac', 'Crucible is busy: bookforge, tts 40% done');
    const rig = makeRig(lanes);
    rig.media.gated.add('download');
    const parked = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.qm.getJob(parked)?.parkedReason !== undefined);
    expect(rig.qm.hasActiveTasks()).toBe(false);

    // A download for ANOTHER library starts at once: the parked task pins nothing.
    const dl = rig.qm.addJob({ ...downloadJob('https://example.com/a'), libraryId: 'lib-b' });
    await until(() => rig.media.started('download').includes(dl));
    expect(rig.libraries.switched).toEqual(['lib-b']);
    // The parked task was pinned to the library it was admitted under.
    expect(rig.qm.getJob(parked)?.libraryId).toBe('lib-a');

    // The server frees while lib-b's download is still running: the parked
    // task must NOT start (it would switch the shared DB under the download).
    lanes.busy.delete('mac');
    lanes.offset += 6_000;
    (rig.qm as any).processQueue();
    await rig.qm.settleAdmission();
    await tick(20);
    expect(rig.media.started('analyze')).toHaveLength(0);

    // The download drains; the parked task resumes into ITS library.
    rig.media.release('download', dl, { success: true, data: { videoPath: '/tmp/a.mp4' } });
    await until(() => rig.media.started('analyze').includes(parked));
    expect(rig.libraries.switched).toEqual(['lib-b', 'lib-a']);
    rig.qm.onModuleDestroy();
  });
});

describe('lanes: the same-model preference', () => {
  it('prefers the task whose model is already on the card, until the oldest has waited 10 minutes', async () => {
    const lanes = new StubLanes();
    lanes.resident.set('mac', 'qwen3.5-4b');
    const rig = gatedRig(lanes);
    // Queued paused, then started together: one admission pass sees both.
    const first = rig.qm.addJob(analyzeJob('v1', LOCAL_9B), { paused: true });
    const second = rig.qm.addJob(analyzeJob('v2', LOCAL_4B), { paused: true });
    rig.qm.startJobs([first, second]);
    await until(() => rig.media.started('analyze').length === 1);
    expect(rig.media.started('analyze')).toEqual([second]);
    rig.media.release('analyze', second);
    await until(() => rig.media.started('analyze').includes(first));
    rig.media.release('analyze', first);
    await until(() => rig.qm.getJob(first)?.status === 'completed');
  });

  it('the starvation guard: past 10 minutes of waiting, FIFO wins', async () => {
    const lanes = new StubLanes();
    lanes.resident.set('mac', 'qwen3.5-4b');
    const rig = gatedRig(lanes);
    const first = rig.qm.addJob(analyzeJob('v1', LOCAL_9B), { paused: true });
    const second = rig.qm.addJob(analyzeJob('v2', LOCAL_4B), { paused: true });
    // The first has been runnable for 11 minutes.
    for (const id of [first, second]) Object.assign(rig.qm.getJob(id)!, { aiWaitingIndex: 0, aiWaitingSince: lanes.now() });
    rig.qm.getJob(first)!.aiWaitingSince = lanes.now() - (STARVATION_MS + 60_000);
    rig.qm.startJobs([first, second]);
    await until(() => rig.media.started('analyze').length === 1);
    expect(rig.media.started('analyze')).toEqual([first]);
    rig.media.release('analyze', first);
    await until(() => rig.media.started('analyze').includes(second));
    rig.media.release('analyze', second);
    rig.qm.onModuleDestroy();
  });
});

describe('lanes: the stall watchdog', () => {
  it('fails a lane task after 15 minutes with no progress, aborting its run; chat activity keeps it alive', async () => {
    const lanes = new StubLanes();
    const rig = gatedRig(lanes);
    const id = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    await until(() => rig.media.started('analyze').includes(id));
    const active = rig.qm.getLanePool().get(id)!;
    const cancelRequests: string[] = [];
    rig.emitter.on('job.cancel-requested', (e: { jobId: string }) => cancelRequests.push(e.jobId));

    // Long-running but alive: the run reports an answered chat.
    active.startedAt = new Date(Date.now() - 3 * 60 * 60_000);
    active.lastProgressAt = new Date(Date.now() - (LANE_STALL_MS + 60_000));
    lanes.activity.get(id)!();
    (rig.qm as any).checkForStuckTasks();
    expect(rig.qm.getJob(id)?.status).toBe('processing');

    // Silent past the stall window: failed as stalled, run aborted, lane freed.
    active.lastProgressAt = new Date(Date.now() - (LANE_STALL_MS + 60_000));
    (rig.qm as any).checkForStuckTasks();
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Stalled: no progress from Crucible on mac/) });
    expect(lanes.signals.get(id)?.aborted).toBe(true);
    expect(cancelRequests).toEqual([id]);
    expect(rig.qm.getLanePool().size).toBe(0);
    rig.media.release('analyze', id, { success: false, error: 'Analysis cancelled' });
    await tick(10);
    expect(rig.events.filter((e) => e.name === 'task.failed')).toHaveLength(1);
    rig.qm.onModuleDestroy();
  });
});

describe('lanes: cancel', () => {
  it('cancels a queued, a parked and a running lane task', async () => {
    const lanes = new StubLanes();
    lanes.serverOf.set('qwen3.5-4b', 'pc');
    lanes.busy.set('pc', 'Crucible is busy: bookforge, tts 40% done');
    const rig = gatedRig(lanes);
    const cancelRequests: string[] = [];
    rig.emitter.on('job.cancel-requested', (e: { jobId: string }) => cancelRequests.push(e.jobId));
    const running = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    const queued = rig.qm.addJob(analyzeJob('v2', LOCAL_9B));
    const parked = rig.qm.addJob(analyzeJob('v3', LOCAL_4B));
    await until(() => rig.media.started('analyze').includes(running) && rig.qm.getJob(parked)?.parkedReason !== undefined);

    expect(rig.qm.cancelJob(queued)).toBe(true);
    expect(rig.qm.cancelJob(parked)).toBe(true);
    expect(rig.qm.getJob(parked)?.parkedReason).toBeUndefined();
    expect(rig.qm.cancelJob(running)).toBe(true);
    expect(lanes.signals.get(running)?.aborted).toBe(true);
    expect(cancelRequests).toEqual([running]);
    expect(rig.qm.getLanePool().size).toBe(0);
    for (const id of [running, queued, parked]) expect(rig.qm.getJob(id)?.status).toBe('cancelled');

    rig.media.release('analyze', running, { success: false, error: 'Analysis cancelled' });
    lanes.busy.delete('pc');
    lanes.offset += 120_000;
    (rig.qm as any).processQueue();
    await rig.qm.settleAdmission();
    await tick(20);
    expect(rig.media.started('analyze')).toEqual([running]);
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
    rig.qm.clearCompletedJobs();
    expect(rig.qm.getAllJobs()).toHaveLength(0);
  });
});

describe('restart semantics and the startup sweep', () => {
  it('the lanes wait for the startup sweep; the main pool never does', async () => {
    const lanes = new StubLanes();
    let finishSweep!: () => void;
    lanes.ready = new Promise<void>((r) => { finishSweep = r; });
    const rig = makeRig(lanes);
    const ai = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    const dl = rig.qm.addJob(downloadJob('https://example.com/a'));
    await until(() => rig.qm.getJob(dl)?.status === 'completed');
    expect(rig.media.started('analyze')).toHaveLength(0);
    expect(lanes.placeCalls).toBe(0);
    finishSweep();
    await until(() => rig.qm.getJob(ai)?.status === 'completed');
  });

  it('quitting aborts every lane run (its lease is released in the run) and, as today, nothing is persisted', async () => {
    const lanes = new StubLanes();
    const rig = gatedRig(lanes);
    const id = rig.qm.addJob(analyzeJob('v1', LOCAL_9B));
    const waiting = rig.qm.addJob(analyzeJob('v2', LOCAL_9B));
    await until(() => rig.media.started('analyze').includes(id));
    rig.qm.onModuleDestroy();
    expect(lanes.signals.get(id)?.aborted).toBe(true);
    expect(rig.qm.getAllJobs()).toHaveLength(0);
    expect(rig.qm.hasActiveTasks()).toBe(false);
    // A fresh process starts with an empty queue: the running and the waiting
    // analysis are gone, exactly as every queued task is after a restart today.
    const next = makeRig(new StubLanes());
    expect(next.qm.getAllJobs()).toHaveLength(0);
    expect(next.qm.getJob(waiting)).toBeUndefined();
  });
});
