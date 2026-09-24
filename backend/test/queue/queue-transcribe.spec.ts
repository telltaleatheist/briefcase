/**
 * The queue's transcribe routing (P5; since P7 Crucible is the only
 * transcriber): a transcription takes its server's GPU lane and reserves with
 * the asr submit (a 409 there parks it); a server that stops answering or
 * loses the stream parks it too; no server that can take it parks it with the
 * reason; a cancel is a cancel; and nothing ever runs a transcription in the
 * main pool.
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
  rig.media.transcribe = async (_id, taskId, route) => {
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
  // StubLanes places a transcribe on mac's GPU lane by default.
  const lanes = new StubLanes();
  lanes.transcribeTo = { server: 'mac', model: ASR };
  const rig = makeRig(lanes);
  return { rig, lanes, t: gatedTranscribes(rig) };
}

describe('Crucible venue: a GPU lane, reserved by the asr submit', () => {
  it('takes its server’s lane with a crucible route, and never loads or leases a model', async () => {
    const { rig, lanes, t } = crucibleRig();
    const a = rig.qm.addJob(transcribeJob('v1'));
    const b = rig.qm.addJob(transcribeJob('v2'));
    await until(() => t.calls.length === 1);
    await tick(20);
    expect(t.calls).toHaveLength(1); // the lane is one wide
    const route = t.calls[0].route as Extract<WhisperRoute, { kind: 'crucible' }>;
    expect(route).toMatchObject({ kind: 'crucible', server: 'mac', model: ASR });
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

  it('Crucible unreachable at the submit, or the stream lost: PARKED with the reason and asked again, never run elsewhere', async () => {
    for (const code of ['crucible_unreachable', 'crucible_stream_lost']) {
      const { rig, lanes, t } = crucibleRig();
      const id = rig.qm.addJob(transcribeJob('v1'));
      await until(() => t.calls.length === 1);
      const reason = `Crucible on mac could not be reached for the upload (${code}).`;
      t.finish(id, new CrucibleAsrUnavailable(code, 'mac', reason));
      await until(() => rig.qm.getJob(id)?.parkedReason === reason);
      expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedServer: 'mac' });
      expect(rig.qm.getLanePool().size).toBe(0);
      expect(rig.qm.getMainPool().size).toBe(0);
      lanes.offset += 6_000;
      (rig.qm as any).processQueue();
      await until(() => t.calls.length === 2);
      expect(t.calls[1].route).toMatchObject({ kind: 'crucible', server: 'mac' });
      t.finish(id);
      await until(() => rig.qm.getJob(id)?.status === 'completed');
      expect(rig.qm.getJob(id)?.warnings).toBeUndefined();
      expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
      rig.qm.onModuleDestroy();
    }
  });

  it('a misconfigured server (a refused token) fails the task by name: waiting would hide it', async () => {
    const { rig, t } = crucibleRig();
    rig.media.transcribe = async () => ({ success: false, error: "Crucible on mac refused this computer's token (unauthorized). Pair it again in Settings › Crucible Servers." });
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => rig.qm.getJob(id)?.status === 'failed');
    expect(rig.qm.getJob(id)?.error).toMatch(/Pair it again/);
    expect(t.calls).toHaveLength(0);
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

describe('no server that can transcribe', () => {
  it('the venue rule says none: the transcription PARKS with the reason, holding no slot, and runs when a server can take it', async () => {
    const lanes = new StubLanes();
    lanes.transcribeTo = { wait: 'Crucible on mac has no transcription engine.' };
    const rig = makeRig(lanes);
    const t = gatedTranscribes(rig);
    const id = rig.qm.addJob(transcribeJob('v1'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: 'Crucible on mac has no transcription engine.' });
    expect(t.calls).toHaveLength(0);
    expect(rig.qm.hasActiveTasks()).toBe(false);
    lanes.transcribeTo = { server: 'mac', model: ASR };
    lanes.offset += 6_000;
    (rig.qm as any).processQueue();
    await until(() => t.calls.length === 1);
    t.finish(id);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
  });

  it('REGRESSION: downloads stay 5 wide, and a download → import → transcribe chain waits for Crucible, never blocking the downloads', async () => {
    const lanes = new StubLanes();
    lanes.transcribeTo = { wait: 'No Crucible server is connected.' };
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
    await until(() => ids.every((id) => rig.qm.getJob(id)?.parkedReason === 'No Crucible server is connected.'), 5000);
    expect(rig.media.started('import').sort()).toEqual([...ids].sort());
    expect(rig.media.started('transcribe')).toEqual([]);
    rig.qm.onModuleDestroy();
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
    const chat = new CrucibleChatService(servers, h.factory, h.probes, ledger);
    const lanes = new CrucibleLanesService(servers, h.probes, chat, h.factory, h.registry, transcription, ledger);
    return { fake, lanes };
  }

  it('placeTranscribe: a server with asr is a GPU lane with its best model', async () => {
    const { fake, lanes } = await realLanes();
    try {
      expect(await lanes.placeTranscribe()).toEqual({
        kind: 'lane', placement: { lane: 'gpu:mac', server: 'mac', target: { model: ASR, route: 'local', upstream: null, bareModel: ASR } },
      });
    } finally {
      await fake.close();
    }
  });

  it('placeTranscribe: an unreachable server is a wait (the task parks) with the reason', async () => {
    const { fake, lanes } = await realLanes(await unusedLoopbackUrl());
    try {
      expect(await lanes.placeTranscribe()).toMatchObject({
        kind: 'wait', reason: expect.stringMatching(/Crucible on mac isn't answering/),
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
