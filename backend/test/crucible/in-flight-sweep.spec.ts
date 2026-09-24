/**
 * The in-flight ledger and the quit/startup sweep (migration plan §7.4),
 * against the fake Crucible: rows written right after the server admits a
 * load or a lease (never for a refusal), settled when they settle; the sweep
 * cancels and releases only what Briefcase recorded, unloads only a model
 * Briefcase loaded and nobody else holds, keeps an unreachable server's rows,
 * and never runs past its deadline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger, parseInFlightLedger, serializeInFlightLedger } from '../../src/crucible/in-flight-ledger';
import { cardHeldBy, sweepCrucibleInFlight } from '../../src/crucible/in-flight-sweep';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleBusyError } from '../../src/crucible/llm/errors';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { tempDir } from './helpers';

const FAST = { confirmForMs: 300, pollEveryMs: 20 };

let fake: FakeCrucible;
let h: Harness;
let ledger: InFlightLedger;

function deps() {
  return { ledger, clientFor: (name: string) => h.factory.clientFor(name, { timeoutMs: 2_000 }), log: () => undefined };
}

beforeEach(async () => {
  fake = await startFakeCrucible({ models: [{ id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.5-4b', paramsB: 4 }] });
  h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  ledger = InFlightLedger.inDir(h.dir, () => undefined);
});
afterEach(() => fake.close());

describe('the ledger file', () => {
  it('reads a missing or corrupt file as empty, and drops half rows by name', () => {
    expect(ledger.read()).toEqual([]);
    fs.writeFileSync(ledger.file, '{not json');
    expect(ledger.read()).toEqual([]);
    const warned: string[] = [];
    expect(parseInFlightLedger(JSON.stringify({ rows: [{ server: 'mac', kind: 'job' }, { server: 'mac', kind: 'lease', id: 'l1' }] }), (w) => warned.push(w)))
      .toEqual([{ server: 'mac', kind: 'lease', id: 'l1', jobType: 'lease', model: null, localId: '', at: '' }]);
    expect(warned).toHaveLength(1);
  });

  it('records, replaces by server+kind+id, and settles idempotently', () => {
    ledger.record({ server: 'mac', kind: 'job', id: 'job-1', jobType: 'load-model', model: 'm', localId: 'q1' });
    ledger.record({ server: 'pc', kind: 'job', id: 'job-1', jobType: 'load-model', model: 'm', localId: 'q2' });
    ledger.record({ server: 'mac', kind: 'job', id: 'job-1', jobType: 'load-model', model: 'm', localId: 'q3' });
    expect(ledger.read().map((r) => [r.server, r.localId])).toEqual([['pc', 'q2'], ['mac', 'q3']]);
    ledger.settle('mac', 'job', 'job-1');
    ledger.settle('mac', 'job', 'job-1');
    expect(ledger.read().map((r) => r.server)).toEqual(['pc']);
    expect(serializeInFlightLedger(ledger.read())).toContain('"rows"');
  });
});

describe('the chat service writes the ledger', () => {
  function chat(): CrucibleChatService {
    const service = new CrucibleChatService(new CrucibleServersService(h.registry, h.factory), h.factory, h.probes, ledger);
    service.heartbeatMs = 1_000;
    return service;
  }

  it('a load job and its lease are written after the server admits them, and settled when the run ends', async () => {
    const service = chat();
    const seen: string[][] = [];
    await service.withRun(async () => {
      await service.withModel('mac', 'qwen3.5-9b', async () => {
        seen.push(ledger.read().map((r) => `${r.kind}:${r.id}:${r.localId}`));
      });
    }, { localId: 'queue-job-7' });
    expect(seen).toEqual([['lease:lease-1:queue-job-7']]);
    expect(ledger.read()).toEqual([]);
    expect(fake.leases.released).toEqual(['lease-1']);
  });

  it('a refused load writes nothing: the row comes after the admit, never before', async () => {
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
    const service = chat();
    const failure = await service.withRun(() => service.withModel('mac', 'qwen3.5-9b', async () => undefined)).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleBusyError);
    expect(ledger.read()).toEqual([]);
  });

  it('a load in progress is on the ledger, as a job, until it settles', async () => {
    fake.inject({ holdLoads: true });
    const service = chat();
    const controller = new AbortController();
    const run = service.withRun(() => service.withModel('mac', 'qwen3.5-9b', async () => undefined, { signal: controller.signal })).catch((e) => e);
    for (let i = 0; i < 100 && ledger.read().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ledger.read()).toMatchObject([{ server: 'mac', kind: 'job', id: 'job-1', jobType: 'load-model', model: 'qwen3.5-9b' }]);
    controller.abort();
    await run;
    for (let i = 0; i < 100 && ledger.read().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ledger.read()).toEqual([]);
  });
});

describe('the sweep', () => {
  it('startup: cancels our orphaned load, releases our lease, and unloads the model we loaded when nothing else holds it', async () => {
    // What a kill mid-run leaves: our lease on the resident model, and a load of ours still on the lane.
    fake.inject({ holdLoads: true });
    const client = await h.factory.clientFor('mac');
    const lease = await (async () => {
      const loadId = await client.loadModel('qwen3.5-4b');
      return loadId;
    })();
    fake.setResident('qwen3.5-9b');
    const held = await client.lease('qwen3.5-9b', { act: 'analysis', ttlSeconds: 120 });
    ledger.record({ server: 'mac', kind: 'job', id: lease, jobType: 'load-model', model: 'qwen3.5-4b', localId: 'q1' });
    ledger.record({ server: 'mac', kind: 'lease', id: held.leaseId, jobType: 'lease', model: 'qwen3.5-9b', localId: 'q1' });

    const report = await sweepCrucibleInFlight(deps(), { reason: 'startup', deadlineMs: 5_000, timing: FAST });
    expect(report.rows.map((r) => r.outcome).sort()).toEqual(['cancelled', 'released']);
    expect(fake.jobs.find((j) => j.jobId === lease)?.status).toBe('cancelled');
    expect(fake.openLease()).toBeNull();
    expect(report.servers[0]).toMatchObject({ server: 'mac', unloaded: 'qwen3.5-9b' });
    expect(fake.jobs.some((j) => j.type === 'unload-model' && j.model === 'qwen3.5-9b')).toBe(true);
    expect(report.kept).toEqual([]);
    expect(ledger.read()).toEqual([]);
  });

  it("never touches another app's lease or model: only rows we recorded are given back", async () => {
    fake.leaseAsOther('qwen3.5-9b', 'bookforge crucible-client/1.0.6');
    const foreign = fake.openLease()!;
    // Our stale row names a lease the server no longer has.
    ledger.record({ server: 'mac', kind: 'lease', id: 'lease-ours-gone', jobType: 'lease', model: 'qwen3.5-9b', localId: 'q1' });
    const report = await sweepCrucibleInFlight(deps(), { reason: 'quit', deadlineMs: 5_000, timing: FAST });
    expect(report.rows.map((r) => r.outcome)).toEqual(['gone']);
    expect(fake.openLease()).toEqual(foreign);
    expect(fake.leases.released).toEqual(['lease-ours-gone']);
    expect(fake.resident()).toBe('qwen3.5-9b');
    expect(fake.jobs.some((j) => j.type === 'unload-model')).toBe(false);
    expect(report.servers[0].note).toMatch(/leaving it alone/);
  });

  it('never unloads a model Briefcase did not load, even on an idle card', async () => {
    fake.setResident('qwen3.5-4b');
    ledger.record({ server: 'mac', kind: 'lease', id: 'lease-x', jobType: 'lease', model: 'qwen3.5-9b', localId: 'q1' });
    await sweepCrucibleInFlight(deps(), { reason: 'quit', deadlineMs: 5_000, timing: FAST });
    expect(fake.resident()).toBe('qwen3.5-4b');
    expect(fake.jobs.some((j) => j.type === 'unload-model')).toBe(false);
  });

  it('with nothing recorded, it asks no server anything', async () => {
    const report = await sweepCrucibleInFlight(deps(), { reason: 'startup', deadlineMs: 5_000 });
    expect(report.rows).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it("an unreachable server's rows stay for the next start", async () => {
    h.registry.add({ name: 'pc', url: await unusedLoopbackUrl(), token: 'x'.repeat(43) });
    ledger.record({ server: 'pc', kind: 'lease', id: 'lease-pc', jobType: 'lease', model: 'm', localId: 'q1' });
    const report = await sweepCrucibleInFlight(deps(), { reason: 'quit', deadlineMs: 5_000, timing: FAST });
    expect(report.rows[0].outcome).not.toMatch(/released|gone|cancelled/);
    expect(report.kept.map((r) => r.id)).toEqual(['lease-pc']);
  });

  it('never runs past its deadline; what it did not finish stays in the ledger', async () => {
    fake.inject({ stallMs: 3_000 });
    ledger.record({ server: 'mac', kind: 'lease', id: 'lease-slow', jobType: 'lease', model: 'm', localId: 'q1' });
    const started = Date.now();
    const report = await sweepCrucibleInFlight(deps(), { reason: 'quit', deadlineMs: 200, timing: FAST });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(report.timedOut).toBe(true);
    expect(ledger.read().map((r) => r.id)).toEqual(['lease-slow']);
    fake.inject({});
  });

  it('cardHeldBy: a lease of ours is not a holder; anyone else is', async () => {
    fake.leaseAsOther('qwen3.5-9b', 'foundry');
    const activity = await (await h.factory.clientFor('mac')).activity();
    expect(cardHeldBy(activity, new Set())).toMatch(/a lease held by foundry/);
    expect(cardHeldBy(activity, new Set([activity.lease!.leaseId]))).toBeNull();
  });

  it('a server that does not count its open chats (1.0.25: activity.chat is informational) is not read as free: nothing is unloaded', async () => {
    fake.setOmit({ 'GET /v1/activity': ['chat'] });
    const client = await h.factory.clientFor('mac');
    fake.setResident('qwen3.5-9b');
    const held = await client.lease('qwen3.5-9b', { act: 'analysis', ttlSeconds: 120 });
    ledger.record({ server: 'mac', kind: 'lease', id: held.leaseId, jobType: 'lease', model: 'qwen3.5-9b', localId: 'q1' });
    const report = await sweepCrucibleInFlight(deps(), { reason: 'quit', deadlineMs: 5_000, timing: FAST });
    expect(report.rows.map((r) => r.outcome)).toEqual(['released']);
    expect(fake.resident()).toBe('qwen3.5-9b');
    expect(fake.jobs.some((j) => j.type === 'unload-model')).toBe(false);
    expect(report.servers[0].note).toMatch(/does not count/);
    fake.setOmit({});
  });
});

it('the ledger lives in the Briefcase config dir under its documented name', () => {
  const dir = tempDir();
  expect(InFlightLedger.inDir(dir).file).toBe(path.join(dir, 'crucible-in-flight.json'));
});
