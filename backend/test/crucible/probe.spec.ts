import { startFakeCrucible, startNotCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { compareVersions, reachOf, PROBE_CACHE_MS } from '../../src/crucible/probe';
import { harness, type Harness } from './harness';

describe('probe: the four outcomes, told apart', () => {
  let fake: FakeCrucible;
  let h: Harness;
  beforeEach(async () => {
    fake = await startFakeCrucible({ name: 'crucible@spec-mac', version: '1.0.24', backend: 'mlx-darwin' });
    h = harness();
  });
  afterEach(() => fake.close());

  it('ok: a Crucible that accepts the token answers with its facts, ready', async () => {
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const answer = await h.probes.test('mac');
    expect(answer.reach).toBe('ready');
    expect(answer.probe).toMatchObject({
      outcome: 'ok',
      facts: {
        serverName: 'crucible@spec-mac', version: '1.0.24', apiVersion: 1, backend: 'mlx-darwin',
        busyLine: null, needsUpdate: false, engineUrl: null,
      },
    });
    // What the server does for Briefcase: chat (the analysis class) and transcription (asr).
    if (answer.probe.outcome === 'ok') {
      expect(answer.probe.facts.capabilities?.map((c) => c.capability)).toEqual(['analysis', 'asr']);
    }
    // ping unauthenticated, then info with the token and the API header, named 'briefcase'.
    const ping = fake.requestsTo('/v1/ping')[0]!;
    expect(ping.headers['authorization']).toBeUndefined();
    const info = fake.requestsTo('/v1/info')[0]!;
    expect(info.headers['authorization']).toBe(`Bearer ${fake.token}`);
    expect(info.headers['x-crucible-api']).toBe('1');
    expect(info.headers['x-crucible-client']).toBe('briefcase');
  });

  it('bad token: a Crucible that refuses the token is wrong_token, not unreachable', async () => {
    h.registry.add({ name: 'mac', url: fake.url, token: 'not-the-token-0000' });
    const answer = await h.probes.test('mac');
    expect(answer.reach).toBe('bad_token');
    expect(answer.probe.outcome).toBe('wrong_token');
    expect(JSON.stringify(answer)).not.toContain('not-the-token-0000');
  });

  it('nothing there: a port nobody listens on is unreachable', async () => {
    h.registry.add({ name: 'gone', url: await unusedLoopbackUrl(), token: fake.token });
    const answer = await h.probes.test('gone');
    expect(answer.reach).toBe('unreachable');
    expect(answer.probe.outcome).toBe('unreachable');
  });

  it('not a Crucible: something answered, and it is a router page', async () => {
    const router = await startNotCrucible();
    try {
      h.registry.add({ name: 'router', url: router.url, token: fake.token });
      const answer = await h.probes.test('router');
      expect(answer.reach).toBe('not_crucible');
      expect(answer.probe.outcome).toBe('not_a_crucible');
    } finally {
      await router.close();
    }
  });

  it('another API version is version_mismatch', async () => {
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    fake.inject({ apiVersion2: true });
    const answer = await h.probes.test('mac');
    expect(answer.probe.outcome).toBe('version_mismatch');
  });

  it('busy: a held lane is ok with the holder\'s sentence', async () => {
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.62 } });
    const answer = await h.probes.test('mac');
    expect(answer.reach).toBe('busy');
    expect(answer.probe.outcome === 'ok' && answer.probe.facts.busyLine).toBe('busy: bookforge, tts 62% done');
  });

  it('a machine that answers nothing is unreachable within the probe clock, not a hang', async () => {
    h.registry.add({ name: 'asleep', url: fake.url, token: fake.token });
    fake.inject({ stallMs: 60_000 });
    const started = Date.now();
    const answer = await h.probes.test('asleep');
    expect(answer.probe.outcome).toBe('unreachable');
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it('marks a server older than MIN_CRUCIBLE as needing an update', async () => {
    const old = await startFakeCrucible({ version: '1.0.9' });
    try {
      h.registry.add({ name: 'old', url: old.url, token: old.token });
      const answer = await h.probes.test('old');
      expect(answer.probe.outcome === 'ok' && answer.probe.facts.needsUpdate).toBe(true);
    } finally {
      await old.close();
    }
    expect(compareVersions('1.0.23', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.23', '1.0.23')).toBe(0);
    expect(compareVersions('0.9.99', '1.0.0')).toBeLessThan(0);
  });

  it('an unknown name is a named refusal, not a throw', async () => {
    const answer = await h.probes.test('ghost');
    expect(answer.probe).toMatchObject({ outcome: 'refused' });
    expect(reachOf(answer.probe)).toBe('refused');
  });

  it('reach() answers from a 10 s cache; test() always asks again', async () => {
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    let now = 1_000_000;
    h.probes.now = () => now;
    await h.probes.reach('mac');
    await h.probes.reach('mac');
    expect(fake.requestsTo('/v1/ping')).toHaveLength(1);
    now += PROBE_CACHE_MS + 1;
    await h.probes.reach('mac');
    expect(fake.requestsTo('/v1/ping')).toHaveLength(2);
    await h.probes.test('mac');
    expect(fake.requestsTo('/v1/ping')).toHaveLength(3);
  });

  it('follows an orchestrator to its engine once, with the same token', async () => {
    const orchestrator = await startFakeCrucible({ role: 'orchestrator', token: fake.token, engine: { url: fake.url, name: 'crucible@spec-mac', backend: 'mlx-darwin' } });
    try {
      h.registry.add({ name: 'pc', url: orchestrator.url, token: fake.token });
      const answer = await h.probes.test('pc');
      expect(answer.probe).toMatchObject({ outcome: 'ok', facts: { backend: 'mlx-darwin', engineUrl: fake.url } });
      // Activity is read from the engine, never the orchestrator.
      expect(fake.requestsTo('/v1/activity')).toHaveLength(1);
      expect(orchestrator.requestsTo('/v1/activity')).toHaveLength(0);
    } finally {
      await orchestrator.close();
    }
  });

  it('refuses an orchestrator that manages no engine, by name', async () => {
    const orchestrator = await startFakeCrucible({ role: 'orchestrator', engine: null });
    try {
      h.registry.add({ name: 'pc', url: orchestrator.url, token: orchestrator.token });
      const answer = await h.probes.test('pc');
      expect(answer.probe.outcome).toBe('refused');
      expect(answer.probe.outcome !== 'ok' && answer.probe.message).toMatch(/crucible_orchestrator_has_no_engine/);
    } finally {
      await orchestrator.close();
    }
  });
});
