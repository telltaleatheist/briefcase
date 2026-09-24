/**
 * The queue with the REAL lanes against the fake Crucible (migration plan §7,
 * P4): the reservation (load + lease before the task starts, released after),
 * the ledger around it, parking on a busy card at the preflight, at the door
 * and inside the run, re-admission when the card frees, cancel mid-run, the
 * lane strip and the Running/Paused switch, and the download regression:
 * twenty downloads with Crucible unreachable run exactly as before.
 */
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { isCancellation } from '../../src/analysis/cancellation';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleLanesService } from '../../src/queue/crucible-lanes';
import type { TaskResult } from '../../src/common/interfaces/task.interface';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from '../crucible/harness';
import { tempDir } from '../crucible/helpers';
import { analyzeJob, downloadJob, gate, makeRig, StubReadiness, tick, until, type Rig } from './queue-rig';

const savedEnv = { ...process.env };
const BUSY = { client: 'bookforge crucible-client/1.0.6', type: 'tts', progress: 0.4 };

let fake: FakeCrucible;
let h: Harness;
let ledger: InFlightLedger;
let chat: CrucibleChatService;
let lanes: CrucibleLanesService;
let provider: AIProviderService;
let offset = 0;

async function wire(url?: string): Promise<void> {
  h = harness();
  h.registry.add({ name: 'mac', url: url ?? fake.url, token: fake.token });
  ledger = InFlightLedger.inDir(h.dir, () => undefined);
  const servers = new CrucibleServersService(h.registry, h.factory);
  chat = new CrucibleChatService(servers, h.factory, h.probes, ledger);
  const transcription = new CrucibleTranscriptionService(servers, h.probes, h.factory, ledger);
  transcription.configDir = () => h.dir;
  lanes = new CrucibleLanesService(servers, h.probes, chat, h.factory, h.registry, transcription, ledger);
  lanes.now = () => Date.now() + offset;
  lanes.sweepTiming = { confirmForMs: 200, pollEveryMs: 20 };
  provider = new AIProviderService(chat);
}

/** An analysis body that makes real calls through the provider, as ai-analysis does. */
function analysisThatCalls(models: string[], hooks: { between?: () => Promise<void> | void; seen?: string[][]; signal?: AbortSignal } = {}) {
  return async (): Promise<TaskResult> => {
    try {
      for (const [i, model] of models.entries()) {
        if (i > 0) await hooks.between?.();
        hooks.seen?.push(ledger.read().map((r) => `${r.kind}:${r.model}`));
        await provider.generateText('prompt', { provider: 'local', model }, 'chapter', { signal: hooks.signal });
      }
      return { success: true, data: { sectionsCount: 1 } };
    } catch (error) {
      // media-operations' own rule: a cancellation (and a park) is a result, not a throw.
      if (isCancellation(error)) return { success: false, error: 'Analysis cancelled' };
      return { success: false, error: (error as Error).message };
    }
  };
}

beforeEach(async () => {
  offset = 0;
  process.env = { ...savedEnv, APPDATA: tempDir('queue-appdata-') };
  fake = await startFakeCrucible({ models: [{ id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.5-4b', paramsB: 4 }], upstreams: { anthropic: { key: 'sk-ant-9999' } } });
});
afterEach(async () => {
  process.env = savedEnv;
  await fake.close();
});

function reask(rig: Rig): void {
  offset += 120_000;
  (rig.qm as any).processQueue();
}

describe('the reservation', () => {
  it('loads and leases the model on its server before the task starts, holds it across the run, releases it after', async () => {
    await wire();
    const rig = makeRig(lanes);
    const seen: string[][] = [];
    rig.media.analyze = analysisThatCalls(['qwen3.5-9b', 'qwen3.5-9b'], { seen });
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    // The load (with its lease) happened before the task started, once.
    expect(fake.jobs.map((j) => [j.type, j.model, (j.params as any).lease?.act])).toEqual([['load-model', 'qwen3.5-9b', 'analysis']]);
    const startedAt = rig.events.findIndex((e) => e.name === 'task.started');
    expect(rig.events[startedAt].data).toMatchObject({ jobId: id, pool: 'lane', lane: 'gpu:mac', venue: 'mac' });
    // Inside the run the lease was on the ledger; after it, released and gone.
    expect(seen).toEqual([['lease:qwen3.5-9b'], ['lease:qwen3.5-9b']]);
    expect(fake.leases.released).toEqual(['lease-1']);
    expect(fake.openLease()).toBeNull();
    expect(ledger.read()).toEqual([]);
    expect(rig.qm.getJob(id)).toMatchObject({ lane: 'gpu:mac', venue: 'mac' });
  });
});

describe('an ollama: choice the server has a model of its own for', () => {
  it('is placed on the GPU lane as that local model, loaded and leased before the task, and every call runs on it', async () => {
    await wire();
    const rig = makeRig(lanes);
    rig.media.analyze = async (): Promise<TaskResult> => {
      await provider.generateText('prompt', { provider: 'ollama', model: 'qwen3.5:9b' }, 'chapter');
      await provider.generateText('prompt', { provider: 'ollama', model: 'qwen3.5:9b' }, 'flags');
      return { success: true, data: { sectionsCount: 1 } };
    };
    const id = rig.qm.addJob(analyzeJob('v1', 'ollama:qwen3.5:9b'));
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.qm.getJob(id)).toMatchObject({ lane: 'gpu:mac', venue: 'mac' });
    expect(fake.jobs.map((j) => [j.type, j.model])).toEqual([['load-model', 'qwen3.5-9b']]);
    expect(fake.chatBodies().map((b) => b['model'])).toEqual(['qwen3.5-9b', 'qwen3.5-9b']);
    expect(fake.leases.taken).toHaveLength(1);
    expect(fake.leases.released).toEqual([fake.leases.taken[0].leaseId]);
  });
});

describe('parking against the fake', () => {
  it("parks on the holder's sentence when another app has the card, and starts by itself when it frees", async () => {
    await wire();
    fake.inject({ serverBusy: BUSY });
    const rig = makeRig(lanes);
    rig.media.analyze = analysisThatCalls(['qwen3.5-9b']);
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: 'Crucible is busy: bookforge, tts 40% done' });
    expect(fake.jobs).toHaveLength(0); // the preflight saved a doomed load
    expect(rig.qm.hasActiveTasks()).toBe(false);
    fake.inject({});
    lanes.forgetActivity();
    reask(rig);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it("a 409 leased at the door parks with the lease holder's line", async () => {
    await wire();
    fake.leaseAsOther('qwen3.5-4b', 'foundry');
    const rig = makeRig(lanes);
    jest.spyOn(lanes, 'preflight').mockResolvedValue(null); // the door is the one that says no
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    expect(rig.qm.getJob(id)?.parkedReason).toMatch(/leased|foundry/);
    expect(rig.qm.getLanePool().size).toBe(0);
    expect(rig.media.started('analyze')).toHaveLength(0);
    rig.qm.onModuleDestroy();
  });

  it('a busy card met INSIDE the run (a second model) parks the task, releases its lease, and keeps nothing', async () => {
    await wire();
    const rig = makeRig(lanes);
    let runs = 0;
    rig.media.analyze = async () => {
      runs++;
      return analysisThatCalls(['qwen3.5-9b', 'qwen3.5-4b'], {
        between: () => { if (runs === 1) fake.inject({ serverBusy: BUSY }); },
      })();
    };
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    // The door's own sentence (the SDK's busyLine for the 409 on the second load).
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: expect.stringMatching(/bookforge.*tts.*40% done/) });
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
    expect(fake.openLease()).toBeNull();
    expect(ledger.read()).toEqual([]);
    fake.inject({});
    lanes.forgetActivity();
    reask(rig);
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(runs).toBe(2);
  });

  it("an unreachable server parks with \"isn't answering\"", async () => {
    await wire(await unusedLoopbackUrl());
    const rig = makeRig(lanes);
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    expect(rig.qm.getJob(id)?.parkedReason).toBe("Crucible on mac isn't answering.");
    rig.qm.onModuleDestroy();
  });
});

describe('REGRESSION: a load whose event stream is lost', () => {
  it('parks the lane task ("isn\'t answering") instead of failing the analysis', async () => {
    await wire();
    chat.loadStreamRetry = { firstMs: 10, maxMs: 20, budgetMs: 60 };
    fake.faults.resetAfterBytes = [{ match: { method: 'GET', path: /\/v1\/jobs\/[^/]+\/events$/ }, afterBytes: 0 }];
    const rig = makeRig(lanes);
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined || rig.qm.getJob(id)?.status === 'failed');
    expect(rig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: "Crucible on mac isn't answering." });
    rig.qm.onModuleDestroy();
  });
});

describe('cancel against the fake', () => {
  it('cancelling a running lane task aborts its chat, releases its lease and empties the ledger', async () => {
    await wire();
    fake.inject({ chatDelayMs: 5_000 });
    const rig = makeRig(lanes);
    const cancelled = gate<void>();
    // ai-analysis's own wiring: job.cancel-requested aborts the run's signal.
    const controller = new AbortController();
    rig.emitter.on('job.cancel-requested', () => controller.abort());
    rig.media.analyze = async () => {
      const result = await analysisThatCalls(['qwen3.5-9b'], { signal: controller.signal })();
      cancelled.resolve();
      return result;
    };
    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => fake.chatBodies().length === 1);
    expect(ledger.read()).toHaveLength(1);
    const active = rig.qm.getLanePool().get(id)!;
    rig.qm.cancelJob(id);
    expect(active.abort!.signal.aborted).toBe(true);
    await until(() => fake.openLease() === null, 2_000, 'the lease to be released');
    expect(rig.qm.getJob(id)?.status).toBe('cancelled');
    await cancelled.promise;
    await until(() => ledger.read().length === 0);
  }, 15_000);
});

describe('the lane strip', () => {
  it('draws the selected server\'s GPU lane and the cloud lane; a busy server keeps its work waiting there, and only selecting another server moves it', async () => {
    await wire();
    h.registry.add({ name: 'pc', url: 'http://127.0.0.1:9', token: 'tok-pc-0000000000000000' });
    fake.inject({ serverBusy: BUSY });
    const rig = makeRig(lanes);
    rig.qm.onModuleInit();
    let status = await rig.qm.getLanesStatus();
    expect(status.lanes.map((l) => [l.id, l.label, l.state, l.width])).toEqual([
      ['gpu:mac', 'GPU · mac', 'busy', 1],
      ['cloud', 'Cloud', 'ready', 2],
    ]);
    expect(status.lanes[0].detail).toBe('Crucible is busy: bookforge, tts 40% done');

    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    // Busy: it waits for mac. pc is registered, answers nothing, and is never tried.
    expect(rig.qm.getJob(id)?.venue).toBe('mac');
    status = await rig.qm.getLanesStatus();
    expect(status.lanes[0]).toMatchObject({ id: 'gpu:mac', waiting: 1 });

    h.registry.select('pc');
    await until(() => /Crucible on pc isn't answering/.test(rig.qm.getJob(id)?.parkedReason ?? ''));
    status = await rig.qm.getLanesStatus();
    expect(status.lanes.map((l) => l.id)).toEqual(['gpu:pc', 'cloud']);
    rig.qm.onModuleDestroy();
  });

  it('with no server registered there are no lanes to draw (and nothing else runs AI)', async () => {
    await wire();
    h.registry.remove('mac');
    const rig = makeRig(lanes);
    expect(await rig.qm.getLanesStatus()).toMatchObject({ lanes: [expect.objectContaining({ id: 'cloud' })] });
  });
});

describe('startup and quit sweeps through the lanes service', () => {
  it('startup gives back what a killed run left before any lane admits; quit gives back what a run still holds', async () => {
    await wire();
    const client = await h.factory.clientFor('mac');
    fake.setResident('qwen3.5-9b');
    const left = await client.lease('qwen3.5-9b', { act: 'analysis', ttlSeconds: 120 });
    ledger.record({ server: 'mac', kind: 'lease', id: left.leaseId, jobType: 'lease', model: 'qwen3.5-9b', localId: 'old' });
    lanes.onModuleInit();
    await lanes.ready;
    expect(fake.openLease()).toBeNull();
    expect(ledger.read()).toEqual([]);

    const again = await client.lease('qwen3.5-4b', { act: 'analysis', ttlSeconds: 120 }).catch(() => null);
    fake.setResident('qwen3.5-4b');
    const held = again ?? await client.lease('qwen3.5-4b', { act: 'analysis', ttlSeconds: 120 });
    ledger.record({ server: 'mac', kind: 'lease', id: held.leaseId, jobType: 'lease', model: 'qwen3.5-4b', localId: 'q' });
    await lanes.beforeApplicationShutdown();
    expect(fake.openLease()).toBeNull();
    expect(ledger.read()).toEqual([]);
  });
});

describe('REGRESSION: the quit sweep runs once', () => {
  it('beforeApplicationShutdown asked twice (two shutdown paths) sweeps once', async () => {
    await wire();
    const sweep = jest.spyOn(lanes, 'sweep');
    await Promise.all([lanes.beforeApplicationShutdown(), lanes.beforeApplicationShutdown()]);
    await lanes.beforeApplicationShutdown();
    expect(sweep.mock.calls.filter(([reason]) => reason === 'quitting')).toHaveLength(1);
  });
});

describe('REGRESSION: downloads, imports and processing are untouched', () => {
  async function run(rig: Rig): Promise<{ ms: number; ids: string[] }> {
    rig.media.delayMs = 15;
    const started = Date.now();
    const ids = Array.from({ length: 20 }, (_, i) => rig.qm.addJob(downloadJob(`https://example.com/v${i}`, 'local:qwen3.5-9b')));
    await until(() => ids.every((id) => rig.qm.getJob(id)?.currentTaskIndex === 2), 10_000, 'every download and import');
    return { ms: Date.now() - started, ids };
  }

  it('20 queued downloads with Crucible unreachable finish at the main pool’s 5-wide concurrency, and their analyses park with a reason', async () => {
    await wire(await unusedLoopbackUrl());
    // A startup sweep still running must not hold the main pool.
    let sweepDone!: () => void;
    lanes.ready = new Promise<void>((resolve) => { sweepDone = resolve; });
    const unreachable = new StubReadiness();
    unreachable.set({ state: 'unreachable', reason: "Crucible on mac isn't answering.", action: 'connect', server: null });
    const crucibleRig = makeRig(lanes, unreachable);
    const withCrucible = await run(crucibleRig);
    expect(crucibleRig.media.maxDownloads).toBe(5);
    expect(crucibleRig.media.started('download')).toHaveLength(20);
    expect(crucibleRig.media.started('import')).toHaveLength(20);

    // The same downloads with no AI task at all: the same concurrency, and no new waits.
    const plainRig = makeRig(lanes, unreachable);
    plainRig.media.delayMs = 15;
    const t0 = Date.now();
    const plain = Array.from({ length: 20 }, (_, i) => plainRig.qm.addJob(downloadJob(`https://example.com/p${i}`)));
    await until(() => plain.every((id) => plainRig.qm.getJob(id)?.status === 'completed'), 10_000, 'every plain download');
    const plainMs = Date.now() - t0;
    expect(plainRig.media.maxDownloads).toBe(5);
    expect(withCrucible.ms).toBeLessThan(plainMs * 2 + 200);

    // Now let the lanes run: every analysis parks, none fails, none runs.
    sweepDone();
    await until(() => withCrucible.ids.every((id) => crucibleRig.qm.getJob(id)?.parkedReason !== undefined), 10_000, 'every analysis to park');
    for (const id of withCrucible.ids) {
      expect(crucibleRig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: "Crucible on mac isn't answering." });
    }
    expect(crucibleRig.media.started('analyze')).toHaveLength(0);
    expect(crucibleRig.events.some((e) => e.name === 'task.failed')).toBe(false);
    crucibleRig.qm.onModuleDestroy();
    plainRig.qm.onModuleDestroy();
  }, 30_000);

  it('non-AI tasks (normalize, process-video) never ask for a venue and run in the main pool; a transcribe parks on Crucible, never elsewhere', async () => {
    await wire(await unusedLoopbackUrl());
    const place = jest.spyOn(lanes, 'place');
    const rig = makeRig(lanes);
    const ids = ['normalize-audio', 'process-video'].map((type) =>
      rig.qm.addJob({ videoId: `v-${type}`, tasks: [{ type, options: {} } as never] }));
    const transcribe = rig.qm.addJob({ videoId: 'v-t', tasks: [{ type: 'transcribe', options: {} } as never] });
    await until(() => ids.every((id) => rig.qm.getJob(id)?.status === 'completed'));
    await until(() => rig.qm.getJob(transcribe)?.parkedReason !== undefined);
    await tick(20);
    expect(place).not.toHaveBeenCalled();
    expect(rig.media.started('transcribe')).toHaveLength(0);
    expect(rig.qm.getJob(transcribe)).toMatchObject({ status: 'pending', parkedReason: expect.stringMatching(/isn't answering/) });
    expect([...rig.qm.getMainPool().values()]).toHaveLength(0);
    rig.qm.onModuleDestroy();
  });
});
