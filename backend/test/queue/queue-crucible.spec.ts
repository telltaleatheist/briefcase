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
import { AI_VIA_ENV } from '../../src/crucible/llm/ai-via';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleLanesService } from '../../src/queue/crucible-lanes';
import type { TaskResult } from '../../src/common/interfaces/task.interface';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from '../crucible/harness';
import { tempDir } from '../crucible/helpers';
import { analyzeJob, downloadJob, gate, makeRig, tick, until, type Rig } from './queue-rig';

const noLlama = { isAvailable: () => false } as never;
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
  lanes = new CrucibleLanesService(servers, h.probes, chat, h.factory, h.registry, ledger);
  lanes.via = () => 'crucible';
  lanes.now = () => Date.now() + offset;
  lanes.sweepTiming = { confirmForMs: 200, pollEveryMs: 20 };
  provider = new AIProviderService(noLlama, chat);
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
  process.env = { ...savedEnv, APPDATA: tempDir('queue-appdata-'), [AI_VIA_ENV]: 'crucible', BRIEFCASE_PLACE_MODEL: '' };
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
  it('draws one GPU lane per server and the cloud lane; the switch pauses a server and paused work re-decides', async () => {
    await wire();
    fake.inject({ serverBusy: BUSY });
    const rig = makeRig(lanes);
    rig.qm.onModuleInit();
    let status = await rig.qm.getLanesStatus();
    expect(status.mode).toBe('crucible');
    expect(status.lanes.map((l) => [l.id, l.label, l.state, l.width])).toEqual([
      ['gpu:mac', 'GPU · mac', 'busy', 1],
      ['cloud', 'Cloud', 'ready', 2],
    ]);
    expect(status.lanes[0].detail).toBe('Crucible is busy: bookforge, tts 40% done');

    const id = rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
    await until(() => rig.qm.getJob(id)?.parkedReason !== undefined);
    rig.qm.setServerPaused('mac', true);
    status = await rig.qm.getLanesStatus();
    expect(status.lanes[0]).toMatchObject({ state: 'paused', waiting: 1 });
    await until(() => /paused/.test(rig.qm.getJob(id)?.parkedReason ?? ''));
    rig.qm.setServerPaused('mac', false);
    expect((await rig.qm.getLanesStatus()).lanes[0].state).not.toBe('paused');
    rig.qm.onModuleDestroy();
  });

  it("under aiVia 'direct' there are no lanes", async () => {
    await wire();
    lanes.via = () => 'direct';
    const rig = makeRig(lanes);
    expect(await rig.qm.getLanesStatus()).toMatchObject({ mode: 'direct', lanes: [] });
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
    const crucibleRig = makeRig(lanes);
    const withCrucible = await run(crucibleRig);
    expect(crucibleRig.media.maxDownloads).toBe(5);
    expect(crucibleRig.media.started('download')).toHaveLength(20);
    expect(crucibleRig.media.started('import')).toHaveLength(20);

    // Same queue on the direct road, no lanes at all: the same concurrency.
    const directRig = makeRig();
    directRig.media.gated.add('analyze');
    const direct = await run(directRig);
    expect(directRig.media.maxDownloads).toBe(5);
    // No new waits: within noise of the direct road.
    expect(withCrucible.ms).toBeLessThan(direct.ms * 2 + 200);

    // Now let the lanes run: every analysis parks, none fails, none runs.
    sweepDone();
    await until(() => withCrucible.ids.every((id) => crucibleRig.qm.getJob(id)?.parkedReason !== undefined), 10_000, 'every analysis to park');
    for (const id of withCrucible.ids) {
      expect(crucibleRig.qm.getJob(id)).toMatchObject({ status: 'pending', parkedReason: "Crucible on mac isn't answering." });
    }
    expect(crucibleRig.media.started('analyze')).toHaveLength(0);
    expect(crucibleRig.events.some((e) => e.name === 'task.failed')).toBe(false);
    crucibleRig.qm.onModuleDestroy();
    directRig.qm.onModuleDestroy();
  }, 30_000);

  // P5: a transcribe IS placed by the lanes now (placeTranscribe); with no
  // transcription service it is whisper-cli in the main pool, and never an LLM venue.
  it('non-AI tasks (normalize, transcribe, process-video) never ask for an LLM venue, and run in the main pool', async () => {
    await wire(await unusedLoopbackUrl());
    const spy = jest.spyOn(lanes, 'place');
    const rig = makeRig(lanes);
    const ids = ['normalize-audio', 'transcribe', 'process-video'].map((type) =>
      rig.qm.addJob({ videoId: `v-${type}`, tasks: [{ type, options: {} } as never] }));
    await until(() => ids.every((id) => rig.qm.getJob(id)?.status === 'completed'));
    await tick(20);
    expect(spy).not.toHaveBeenCalled();
    expect([...rig.qm.getMainPool().values()]).toHaveLength(0);
  });
});
