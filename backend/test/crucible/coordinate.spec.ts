/**
 * COORDINATION against the fake Crucible: read three documents, post
 * Briefcase's module only when something is missing, follow it, and hold it
 * all back while the first-run wizard is open.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CrucibleCoordinationService,
  SETTLE_POLL_ATTEMPTS,
  missingForBriefcase,
} from '../../src/crucible/coordinate.service';
import { FIRST_RUN_MARKER } from '../../src/crucible/first-run';
import type { CrucibleCoordinationState } from '../../src/crucible/wire/coordinate-wire';
import { startFakeCrucible, stockedForBriefcase, type FakeCrucible, type FakeCrucibleOptions } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';

interface Rig {
  fake: FakeCrucible;
  h: Harness;
  service: CrucibleCoordinationService;
  states: CrucibleCoordinationState[];
  sleeps: number[];
}

const open: FakeCrucible[] = [];

async function rig(options: FakeCrucibleOptions = {}): Promise<Rig> {
  const fake = await startFakeCrucible({ name: 'crucible@here', ...options });
  open.push(fake);
  const h = harness();
  const states: CrucibleCoordinationState[] = [];
  const ws = { emitCrucibleServersChanged: () => undefined, emitCrucibleCoordination: (s: CrucibleCoordinationState) => states.push(s) };
  const service = new CrucibleCoordinationService(h.registry, h.factory, h.dir, ws as never);
  const sleeps: number[] = [];
  service.deps = { sleep: async (ms) => { sleeps.push(ms); }, now: () => '2026-09-23T12:00:00Z' };
  h.registry.add({ name: 'here', url: fake.url, token: fake.token });
  return { fake, h, service, states, sleeps };
}

const posts = (fake: FakeCrucible) => fake.requestsTo('/v1/tasks', 'POST');

afterAll(async () => {
  await Promise.all(open.map((f) => f.close()));
});

describe('coordination', () => {
  it('a stocked server: three reads, and NOTHING is posted', async () => {
    const { fake, service } = await rig(stockedForBriefcase());
    const state = await service.request('here', 'a spec asked');
    expect(state).toMatchObject({ phase: 'stocked', unmet: [] });
    expect(posts(fake)).toHaveLength(0);
    expect(fake.requestsTo('/v1/info', 'GET').length).toBeGreaterThan(0);
    expect(fake.requestsTo('/v1/catalog', 'GET')).toHaveLength(1);
    expect(fake.requestsTo('/v1/capability', 'GET')).toHaveLength(1);
  });

  it('a bare service: posts the module ONCE, filtered to the backend with `backends` stripped, and follows it to done', async () => {
    const { fake, service, states } = await rig();
    const state = await service.request('here', 'it was installed');
    expect(state.phase).toBe('preparing');
    if (state.phase !== 'preparing') throw new Error('unreachable');
    expect(state.progress.state).toBe('done');
    expect(state.missing.map((m) => (m.what === 'job-type' ? m.jobType : m.id))).toEqual(['llm', 'asr', 'qwen3.5-9b', 'mlx-whisper-large-v3']);

    expect(posts(fake)).toHaveLength(1);
    const body = posts(fake)[0].body as { type: string; module: Record<string, unknown> };
    expect(body.type).toBe('module');
    expect(body.module).toEqual({
      name: 'briefcase',
      version: expect.stringMatching(/^1\.0\.23\+/),
      job_types: [{ type: 'llm' }, { type: 'asr' }],
      needs: [{ class: 'analysis' }],
      subjects: [{ kind: 'model', id: 'mlx-whisper-large-v3' }],
    });
    // Progress was pushed along the way.
    expect(states.some((s) => s.phase === 'preparing' && s.progress.bytes !== null)).toBe(true);

    // The next connect finds it stocked and posts nothing more.
    expect(await service.request('here', 'again')).toMatchObject({ phase: 'stocked' });
    expect(posts(fake)).toHaveLength(1);
  });

  it('on a cuda-linux server it asks for the faster-whisper transcriber instead', async () => {
    const { fake, service } = await rig({
      backend: 'cuda-linux',
      catalog: [
        { kind: 'model', id: 'qwen3.5-9b', jobType: 'llm', installed: true },
        { kind: 'model', id: 'faster-whisper-large-v3', jobType: 'asr', installed: false },
      ],
      installedJobTypes: ['echo', 'llm', 'asr'],
    });
    await service.request('here', 'spec');
    expect((posts(fake)[0].body as { module: { subjects: unknown } }).module.subjects).toEqual([{ kind: 'model', id: 'faster-whisper-large-v3' }]);
  });

  it('two calls at once make ONE run and one post', async () => {
    const { fake, service } = await rig();
    const [a, b] = await Promise.all([service.request('here', 'added'), service.request('here', 'startup')]);
    expect(a).toBe(b);
    expect(posts(fake)).toHaveLength(1);
  });

  it('a class the engine has switched off is UNMET, not missing, and not a download', async () => {
    const stocked = stockedForBriefcase();
    const { fake, service } = await rig({ ...stocked, disabledClasses: { analysis: 'needs 20 GB, this Mac has 16' } });
    const state = await service.request('here', 'spec');
    expect(state).toMatchObject({ phase: 'stocked', unmet: [{ class: 'analysis', reason: 'needs 20 GB, this Mac has 16' }] });
    expect(posts(fake)).toHaveLength(0);
  });

  it('task_busy: FOLLOWS the other app\'s task, never re-posts over it, then reads again and posts its own', async () => {
    const { fake, service, states } = await rig();
    fake.inject({ taskBusy: { type: 'module', finishAfterMs: 50 } });
    const state = await service.request('here', 'spec');
    expect(states.some((s) => s.phase === 'preparing' && s.followed && s.progress.taskId === 'task-foreign')).toBe(true);
    // The foreign task finishing freed the slot but did not stock Briefcase: it read again and posted.
    expect(state).toMatchObject({ phase: 'preparing', followed: false, progress: { state: 'done' } });
    expect(posts(fake)).toHaveLength(2);
  });

  it('server_busy with a holder: a WAIT naming the holder verbatim, then it posts once the card settles', async () => {
    const { fake, service, states, sleeps } = await rig();
    fake.inject({ cardHeld: { fact: 'a lease', who: "held by bookforge — tts, higgs-v3", times: 1 } });
    const state = await service.request('here', 'spec');
    const waiting = states.find((s) => s.phase === 'waiting');
    expect(waiting).toMatchObject({ holder: { fact: 'a lease', who: 'held by bookforge — tts, higgs-v3' }, attempts: 1, stopped: false });
    expect(sleeps).toEqual([20_000]);
    expect(state).toMatchObject({ phase: 'preparing', progress: { state: 'done' } });
  });

  it('a card held for ever: the wait STOPS after its budget, still naming the holder', async () => {
    const { fake, service, sleeps } = await rig();
    fake.inject({ cardHeld: { fact: 'a job', who: 'foundry — pages 12% done' } });
    const state = await service.request('here', 'spec');
    expect(state).toMatchObject({ phase: 'waiting', stopped: true, holder: { who: 'foundry — pages 12% done' } });
    expect(sleeps.length).toBe(SETTLE_POLL_ATTEMPTS);
  });

  it('a refusal about the request fails ONCE by name and is never posted again this session', async () => {
    const { fake, service } = await rig({ catalog: [{ kind: 'model', id: 'qwen3.5-9b', jobType: 'llm', installed: true }] });
    const first = await service.request('here', 'spec');
    expect(first).toMatchObject({ phase: 'refused', code: 'unknown_subject' });
    const second = await service.request('here', 'spec');
    expect(second).toMatchObject({ phase: 'refused', code: 'unknown_subject' });
    expect(posts(fake)).toHaveLength(1);
  });

  it('a failed module task is a state that names the step\'s code, not an exception', async () => {
    const { service } = await rig({ failModuleWith: { code: 'env_install_failed', message: 'pip exited 1' } });
    expect(await service.request('here', 'spec')).toMatchObject({
      phase: 'preparing', progress: { state: 'failed', error: { code: 'env_install_failed', message: 'pip exited 1' } },
    });
  });

  it('a server that is not the selected one is asked nothing', async () => {
    const { fake, h, service } = await rig();
    h.registry.add({ name: 'elsewhere', url: 'http://127.0.0.1:9', token: 'tok-elsewhere' });
    h.registry.select('elsewhere');
    h.registry.remove('elsewhere');
    const before = fake.requests.length;
    expect(await service.request('here', 'spec')).toMatchObject({ phase: 'unreachable', message: expect.stringContaining('not the selected server') });
    expect(fake.requests.length).toBe(before);
    // ...and coordinateAll skips it.
    expect(await service.coordinateAll('startup')).toEqual([]);
  });

  it('a server that does not answer: unreachable, nothing posted, never thrown', async () => {
    const { fake, service } = await rig();
    await fake.close();
    expect(await service.request('here', 'spec')).toMatchObject({ phase: 'unreachable' });
  });
});

describe('the first-run hold', () => {
  it('while held: deferred, and the server is asked NOTHING; finishing releases it and coordinates', async () => {
    const { fake, h, service } = await rig();
    service.holdForFirstRun();
    expect(fs.existsSync(path.join(h.dir, FIRST_RUN_MARKER))).toBe(true);
    expect(service.held).toBe(true);

    expect(await service.request('here', 'it was added')).toEqual({ server: 'here', phase: 'deferred', reason: 'first-run' });
    expect(await service.coordinateAll('startup')).toEqual([{ server: 'here', phase: 'deferred', reason: 'first-run' }]);
    expect(fake.requests).toHaveLength(0);

    const finished = service.finishFirstRun();
    expect(finished).toEqual({ released: true, coordinating: ['here'] });
    expect(service.held).toBe(false);
    // Not awaited by the wizard: the run settles on its own.
    const deadline = Date.now() + 5_000;
    while (!(service.all()['here']?.phase === 'preparing' && (service.all()['here'] as { progress: { state: string } }).progress.state === 'done')) {
      if (Date.now() > deadline) throw new Error(`coordination did not finish: ${JSON.stringify(service.all()['here'])}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(posts(fake)).toHaveLength(1);
  });

  it('the hold survives a restart: a new service over the same directory is still held', async () => {
    const { h, service } = await rig();
    service.holdForFirstRun();
    const again = new CrucibleCoordinationService(h.registry, h.factory, h.dir);
    expect(again.held).toBe(true);
    expect(again.finishFirstRun().released).toBe(true);
    expect(service.held).toBe(false);
  });

  it('finishing with no hold is harmless', async () => {
    const { service } = await rig(stockedForBriefcase());
    expect(service.finishFirstRun().released).toBe(false);
  });

  it('a server added beside the selected one is asked nothing; selecting it coordinates it, on the registry\'s own announcement', async () => {
    const { fake, h, service } = await rig(stockedForBriefcase());
    service.onApplicationBootstrap();
    try {
      const other = await startFakeCrucible({ name: 'crucible@pc', backend: 'cuda-linux' });
      open.push(other);
      h.registry.add({ name: 'pc', url: other.url, token: other.token });
      await new Promise((r) => setTimeout(r, 100));
      expect(service.all()['pc']).toBeUndefined();
      expect(other.requests).toHaveLength(0);
      h.registry.select('pc');
      const deadline = Date.now() + 5_000;
      while (service.all()['pc'] === undefined || service.all()['pc'].phase === 'checking') {
        if (Date.now() > deadline) throw new Error('not coordinated');
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(other.requestsTo('/v1/catalog').length).toBe(1);
      expect(fake.requestsTo('/v1/tasks', 'POST')).toHaveLength(0);
    } finally {
      service.onApplicationShutdown();
    }
  });
});

describe('missingForBriefcase', () => {
  const capability = (route: 'local' | 'upstream', selected: string) => ({
    backendKind: 'mlx-darwin',
    classes: [{ capability: 'analysis', enabled: true, selected, reason: 'fits', shortfallBytes: 0, route, work: null, contextCeilings: null }],
  });
  const row = (id: string, installed: boolean, kind: 'model' | 'engine' = 'model', jobType = 'llm') => ({
    kind, id, name: null, jobType, installed, installedBytes: null, expectedBytes: null, floors: [], license: null, source: 'hf', resident: false, sharesWeightsOf: null, missingFiles: null,
  });

  it('a class routed upstream needs no weights', () => {
    const { missing } = missingForBriefcase(['llm', 'asr'], [row('mlx-whisper-large-v3', true, 'model', 'asr')], capability('upstream', 'anthropic/claude-sonnet-5'));
    expect(missing).toEqual([]);
  });

  it('a class with no row in the capability record is unmet, with the absence as the reason', () => {
    const { unmet } = missingForBriefcase(['llm', 'asr'], [], { backendKind: 'mlx-darwin', classes: [] });
    expect(unmet[0].class).toBe('analysis');
  });

  it('an engine binary a local selection needs is missing when not installed', () => {
    const { missing } = missingForBriefcase(
      ['llm'],
      [row('qwen3.5-9b-gguf', true), row('llama-cpp', false, 'engine')],
      { backendKind: 'llama-windows', classes: [{ capability: 'analysis', enabled: true, selected: 'qwen3.5-9b-gguf', reason: 'fits', shortfallBytes: 0, route: 'local', work: null, contextCeilings: null }] },
    );
    expect(missing).toEqual([expect.objectContaining({ what: 'subject', kind: 'engine', id: 'llama-cpp' })]);
  });
});
