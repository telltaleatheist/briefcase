/**
 * The queue's transcribe routing (P5, migration plan §7.1): a transcription on
 * Crucible takes its server's GPU lane and reserves with the asr submit (a 409
 * there parks it); an infrastructure failure re-routes it to whisper-cli in the
 * main pool with a warning; a cancel never does; whisper-cli transcribes are
 * capped at 2 of the main pool's 5; and under the direct road nothing changed.
 */
import { CrucibleAsrCancelled, CrucibleAsrUnavailable } from '../../src/crucible/asr/crucible-asr-job';
import { CrucibleParkedError } from '../../src/crucible/llm/errors';
import type { TaskResult } from '../../src/common/interfaces/task.interface';
import type { WhisperRoute } from '../../src/media/whisper.service';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleLanesService } from '../../src/queue/crucible-lanes';
import { startFakeCrucible, unusedLoopbackUrl } from '../fake-crucible/fake-crucible';
import { harness } from '../crucible/harness';
import { analyzeJob, downloadJob, gate, makeRig, StubLanes, tick, transcribeJob, until, type Gate, type Rig } from './queue-rig';

const ASR = 'mlx-whisper-large-v3';
const OK: TaskResult = { success: true, data: { transcriptPath: '/tmp/t.srt' } };

afterEach(() => jest.useRealTimers());

/** transcribeVideo calls held open until the spec resolves them, one gate per call. */
function gatedTranscribes(rig: Rig) {
  const calls: Array<{ taskId: string; route: WhisperRoute | undefined; gate: Gate<TaskResult | Error> }> = [];
  let running = 0;
  let maxRunning = 0;
  rig.media.transcribe = async (_id, _o, taskId, route) => {
    const g = gate<TaskResult | Error>();
    calls.push({ taskId, route, gate: g });
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      const outcome = await g.promise;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } finally {
      running--;
    }
  };
  return {
    calls,
    get running() { return running; },
    get maxRunning() { return maxRunning; },
    of: (taskId: string) => calls.filter((c) => c.taskId === taskId),
    finish: (taskId: string, outcome: TaskResult | Error = OK) => {
      const call = calls.filter((c) => c.taskId === taskId).at(-1);
      if (!call) throw new Error(`no transcribe call for ${taskId}`);
      call.gate.resolve(outcome);
    },
  };
}

function crucibleRig(): { rig: Rig; lanes: StubLanes; t: ReturnType<typeof gatedTranscribes> } {
  const lanes = new StubLanes();
  lanes.transcribeTo = { server: 'mac', model: ASR };
  const rig = makeRig(lanes);
  return { rig, lanes, t: gatedTranscribes(rig) };
}

describe('direct road: transcription exactly as before, capped at 2', () => {
  it('with no lanes, transcribes run in the main pool with NO route (WhisperService decides), two at a time', async () => {
    const rig = makeRig();
    const t = gatedTranscribes(rig);
    const ids = ['v1', 'v2', 'v3', 'v4'].map((v) => rig.qm.addJob(transcribeJob(v)));
    await until(() => t.calls.length === 2);
    await tick(20);
    expect(t.calls).toHaveLength(2);
    expect(t.calls.every((c) => c.route === undefined)).toBe(true);
    expect([...rig.qm.getMainPool().values()].every((a) => a.type === 'transcribe')).toBe(true);
    // Other main-pool work is not held up by the cap.
    const norm = rig.qm.addJob({ videoId: 'v9', tasks: [{ type: 'normalize-audio', options: {} } as never] });
    await until(() => rig.qm.getJob(norm)?.status === 'completed');
    t.finish(ids[0]);
    await until(() => t.calls.length === 3);
    for (const id of ids.slice(1)) {
      await until(() => t.of(id).length === 1);
      t.finish(id);
    }
    await until(() => ids.every((id) => rig.qm.getJob(id)?.status === 'completed'));
    expect(t.maxRunning).toBe(2);
  });

  it("with lanes present but aiVia 'direct', transcribes never ask the lanes", async () => {
    const lanes = new StubLanes();
    lanes.modeValue = 'direct';
    const rig = makeRig(lanes);
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(lanes.placeTranscribeCalls).toBe(0);
    expect(rig.media.transcribeRoutes).toEqual([{ taskId: id, route: undefined }]);
  });
});

describe('Crucible venue: a GPU lane, reserved by the asr submit', () => {
  it('takes its server’s lane with a crucible route (fallback deferred to the queue), and never loads or leases a model', async () => {
    const { rig, lanes, t } = crucibleRig();
    const a = rig.qm.addJob(transcribeJob('v1'));
    const b = rig.qm.addJob(transcribeJob('v2'));
    await until(() => t.calls.length === 1);
    await tick(20);
    expect(t.calls).toHaveLength(1); // the lane is one wide
    const route = t.calls[0].route as Extract<WhisperRoute, { kind: 'crucible' }>;
    expect(route).toMatchObject({ kind: 'crucible', server: 'mac', model: ASR, fallback: 'defer' });
    expect(route.signal).toBeInstanceOf(AbortSignal);
    expect(lanes.admitted).toEqual([]); // no load-model, no lease: the submit is the reservation
    expect([...rig.qm.getLanePool().values()]).toEqual([expect.objectContaining({ jobId: a, lane: 'gpu:mac', model: ASR, type: 'transcribe' })]);
    expect(rig.qm.getMainPool().size).toBe(0);
    expect(rig.qm.getJob(b)).toMatchObject({ status: 'pending', lane: 'gpu:mac' });
    expect(rig.qm.getJob(b)?.parkedReason).toBeUndefined();
    t.finish(a);
    await until(() => t.of(b).length === 1);
    t.finish(b);
    await until(() => rig.qm.getJob(b)?.status === 'completed');
    expect(rig.qm.getJob(a)?.warnings).toBeUndefined();
  });

  it('shares the lane with analyses on the same server: one at a time', async () => {
    const { rig, t } = crucibleRig();
    rig.media.gated.add('analyze');
    const tr = rig.qm.addJob(transcribeJob('v1'));
    const an = rig.qm.addJob(analyzeJob('v2', 'local:qwen3.5-9b'));
    await until(() => t.calls.length === 1);
    await tick(20);
    expect(rig.media.started('analyze')).toEqual([]);
    t.finish(tr);
    await until(() => rig.media.started('analyze').includes(an));
    rig.media.release('analyze', an);
    await until(() => rig.qm.getJob(an)?.status === 'completed');
  });

  it('another client on the job lane at the preflight: parked with the holder’s sentence, admitted when it frees', async () => {
    const { rig, lanes, t } = crucibleRig();
    lanes.jobBusy.set('mac', 'Crucible is busy: bookforge, tts 40% done');
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: 'Crucible is busy: bookforge, tts 40% done', parkedServer: 'mac' });
    expect(t.calls).toHaveLength(0);
    lanes.jobBusy.delete('mac');
    lanes.offset += 6_000;
    (rig.qm as any).processQueue();
    await until(() => t.calls.length === 1);
    t.finish(id);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it('a 409 at the asr submit parks the task and frees the lane; it is never a failure', async () => {
    const { rig, lanes, t } = crucibleRig();
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => t.calls.length === 1);
    t.finish(id, new CrucibleParkedError('mac', 'Crucible is busy: foundry, rvc 10% done'));
    await until(() => rig.qm.getJob(id)?.parkedReason === 'Crucible is busy: foundry, rvc 10% done');
    await until(() => rig.qm.getLanePool().size === 0);
    expect(rig.qm.getJob(id)?.status).toBe('pending');
    expect(rig.qm.hasActiveTasks()).toBe(false);
    lanes.offset += 6_000;
    (rig.qm as any).processQueue();
    await until(() => t.calls.length === 2);
    expect(t.calls[1].route).toMatchObject({ kind: 'crucible', server: 'mac' });
    t.finish(id);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it('Crucible unreachable at the submit: re-routed to whisper-cli in the main pool, and the job carries the warning', async () => {
    const { rig, t } = crucibleRig();
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => t.calls.length === 1);
    t.finish(id, new CrucibleAsrUnavailable('crucible_unreachable', 'mac', "Crucible on mac could not be reached for the upload (connect ECONNREFUSED)."));
    await until(() => t.calls.length === 2);
    const warning = 'Transcribed with the offline transcriber (whisper) because crucible on mac could not be reached for the upload (connect ECONNREFUSED).';
    expect(t.calls[1].route).toEqual({ kind: 'cli', warning });
    expect(rig.qm.getLanePool().size).toBe(0);
    expect([...rig.qm.getMainPool().values()]).toEqual([expect.objectContaining({ jobId: id, type: 'transcribe', pool: 'main' })]);
    expect(rig.qm.getJob(id)?.lane).toBeUndefined();
    // WhisperService puts the route's warning on the result; the queue collects it onto the job.
    t.finish(id, { ...OK, warnings: [warning] });
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.qm.getJob(id)?.warnings).toEqual([warning]);
  });

  it('a cancel mid-file aborts the task’s signal and NEVER falls back', async () => {
    const { rig, t } = crucibleRig();
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => t.calls.length === 1);
    const route = t.calls[0].route as Extract<WhisperRoute, { kind: 'crucible' }>;
    route.signal!.addEventListener('abort', () => t.finish(id, new CrucibleAsrCancelled('mac', 'job-1', 'The transcription was cancelled.')));
    expect(rig.qm.cancelJob(id)).toBe(true);
    expect(route.signal!.aborted).toBe(true);
    await tick(30);
    expect(rig.qm.getJob(id)?.status).toBe('cancelled');
    expect(t.calls).toHaveLength(1);
    expect(rig.qm.getLanePool().size).toBe(0);
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it('a job the server ran and failed fails the task with its message (no fallback)', async () => {
    const { rig, t } = crucibleRig();
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => t.calls.length === 1);
    t.finish(id, { success: false, error: 'Crucible on mac could not transcribe this video (asr_window_failed): window 2 failed' });
    await until(() => rig.qm.getJob(id)?.status === 'failed');
    expect(rig.qm.getJob(id)?.error).toMatch(/window 2 failed/);
    expect(t.calls).toHaveLength(1);
  });
});

describe('whisper-cli venue under the lanes', () => {
  it('the venue rule’s whisper-cli answer goes to the main pool with its warning, capped at 2 of 5', async () => {
    const lanes = new StubLanes();
    lanes.transcribeTo = { cli: 'Transcribed with the offline transcriber (whisper) because Crucible on mac has no transcription engine.' };
    const rig = makeRig(lanes);
    const t = gatedTranscribes(rig);
    const ids = ['v1', 'v2', 'v3'].map((v) => rig.qm.addJob(transcribeJob(v)));
    await until(() => t.calls.length === 2);
    await tick(20);
    expect(t.calls).toHaveLength(2);
    expect(t.calls.every((c) => c.route?.kind === 'cli' && (c.route as { warning: string }).warning.includes('no transcription engine'))).toBe(true);
    expect(rig.qm.getLanePool().size).toBe(0);
    for (const id of ids) {
      await until(() => t.of(id).length === 1);
      t.finish(id);
    }
    await until(() => ids.every((id) => rig.qm.getJob(id)?.status === 'completed'));
    expect(t.maxRunning).toBe(2);
  });

  it('a translate transcription is placed once per pass with its own flag', async () => {
    const lanes = new StubLanes();
    const rig = makeRig(lanes);
    const id = rig.qm.addJob(transcribeJob('v1', { translate: true }));
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.media.transcribeRoutes).toEqual([{ taskId: id, route: { kind: 'cli', warning: null } }]);
  });

  it('REGRESSION: downloads stay 5 wide, and a download → import → transcribe chain completes on whisper-cli', async () => {
    const lanes = new StubLanes();
    const rig = makeRig(lanes);
    rig.media.gated.add('download');
    const ids = Array.from({ length: 7 }, (_, i) => rig.qm.addJob({ ...downloadJob(`https://x/${i}`), tasks: [...downloadJob(`https://x/${i}`).tasks, { type: 'transcribe', options: {} } as never] }));
    await until(() => rig.media.started('download').length === 5);
    await tick(20);
    expect(rig.media.maxDownloads).toBe(5);
    for (const id of ids) {
      await until(() => rig.media.gates.has(`download:${id}`));
      rig.media.release('download', id, { success: true, data: { videoPath: `/tmp/${id}.mp4` } });
    }
    await until(() => ids.every((id) => rig.qm.getJob(id)?.status === 'completed'), 5000);
    expect(rig.media.started('transcribe').sort()).toEqual([...ids].sort());
    expect(rig.media.transcribeRoutes.every((r) => r.route?.kind === 'cli')).toBe(true);
  });
});

describe('the real lanes against the fake Crucible', () => {
  async function realLanes(url?: string, fakeOptions: Parameters<typeof startFakeCrucible>[0] = {}) {
    const fake = await startFakeCrucible({ installedJobTypes: ['echo', 'llm', 'asr'], asrInstalled: [ASR], ...fakeOptions });
    const h = harness();
    h.registry.add({ name: 'mac', url: url ?? fake.url, token: fake.token });
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const servers = new CrucibleServersService(h.registry, h.factory);
    const transcription = new CrucibleTranscriptionService(servers, h.probes, h.factory, ledger);
    transcription.configDir = () => h.dir;
    transcription.aiVia = () => 'crucible';
    const chat = new CrucibleChatService(servers, h.factory, h.probes, ledger);
    const lanes = new CrucibleLanesService(servers, h.probes, chat, h.factory, h.registry, ledger, transcription);
    lanes.via = () => 'crucible';
    return { fake, lanes };
  }

  it('placeTranscribe: a server with asr is a GPU lane with its best model; translate is whisper-cli', async () => {
    const { fake, lanes } = await realLanes();
    try {
      expect(await lanes.placeTranscribe({ type: 'transcribe', options: {} } as never)).toEqual({
        kind: 'lane', placement: { lane: 'gpu:mac', server: 'mac', target: { model: ASR, route: 'local', upstream: null, bareModel: ASR } },
      });
      expect(await lanes.placeTranscribe({ type: 'transcribe', options: { translate: true } } as never)).toMatchObject({ kind: 'cli', warning: null });
    } finally {
      await fake.close();
    }
  });

  it('placeTranscribe: an unreachable server is whisper-cli WITH a warning (never a wait)', async () => {
    const { fake, lanes } = await realLanes(await unusedLoopbackUrl());
    try {
      expect(await lanes.placeTranscribe({ type: 'transcribe', options: {} } as never)).toMatchObject({
        kind: 'cli', warning: expect.stringMatching(/Crucible on mac isn't answering/),
      });
    } finally {
      await fake.close();
    }
  });

  it('the asr preflight: another client’s LEASE is not in the way (asr leaves the card alone); its running job is', async () => {
    const { fake, lanes } = await realLanes(undefined, { models: [{ id: 'qwen3.5-9b', paramsB: 9 }] });
    try {
      fake.leaseAsOther('qwen3.5-9b', 'bookforge crucible-client/1.0.6');
      expect(await lanes.preflightJob('mac')).toBeNull();
      lanes.forgetActivity('mac');
      fake.inject({ serverBusy: { client: 'foundry crucible-client/1.0.2', type: 'rvc', progress: 0.25 } });
      expect(await lanes.preflightJob('mac')).toBe('Crucible is busy: foundry, rvc 25% done');
    } finally {
      await fake.close();
    }
  });
});
