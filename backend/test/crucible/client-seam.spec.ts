/**
 * The client factory is the ONLY place a token meets the SDK, the engine hop is
 * followed once and cached, and a dead socket is classified as the wire.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleClient, CrucibleServerError, CrucibleUnreachable } from '@crucible/client';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { EngineResolver, RESOLVE_TTL_MS, EngineResolveError } from '../../src/crucible/engine-resolve';
import { crucibleUnavailableCause, isTransportFailure, transportFailureCause } from '../../src/crucible/transport-failure';
import { CRUCIBLE_CLIENT_NAME } from '../../src/crucible/client-factory';
import { harness } from './harness';

const SRC = path.resolve(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [full] : [];
  });
}

describe('the client factory seam', () => {
  it('is the only file in the backend that constructs a CrucibleClient', () => {
    const constructing = sourceFiles(SRC).filter((file) => /new\s+CrucibleClient\s*\(/.test(fs.readFileSync(file, 'utf8')));
    expect(constructing.map((file) => path.relative(SRC, file))).toEqual([path.join('crucible', 'client-factory.ts')]);
  });

  it('names itself briefcase to every server', async () => {
    expect(CRUCIBLE_CLIENT_NAME).toBe('briefcase');
    const fake = await startFakeCrucible();
    try {
      const h = harness();
      h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
      const client = await h.factory.clientFor('mac');
      await client.health();
      const health = fake.requestsTo('/v1/health')[0]!;
      expect(health.headers['x-crucible-client']).toBe('briefcase');
      expect(String(health.headers['user-agent'])).toContain('briefcase');
    } finally {
      await fake.close();
    }
  });

  it('reads the token at call time, so a server removed and re-added is reached with its new token', async () => {
    const first = await startFakeCrucible();
    const second = await startFakeCrucible();
    try {
      const h = harness();
      h.registry.add({ name: 'pc', url: first.url, token: first.token });
      await (await h.factory.clientFor('pc')).health();
      h.registry.remove('pc');
      h.registry.add({ name: 'pc', url: second.url, token: second.token });
      await (await h.factory.clientFor('pc')).health();
      expect(second.requestsTo('/v1/health')).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('engine resolution', () => {
  let engine: FakeCrucible;
  let orchestrator: FakeCrucible;
  const make = (url: string, token: string) => new CrucibleClient({ url, token, clientName: 'spec' });
  beforeEach(async () => {
    engine = await startFakeCrucible({ name: 'crucible@pc-wsl' });
    orchestrator = await startFakeCrucible({ role: 'orchestrator', token: engine.token, engine: { url: engine.url } });
  });
  afterEach(async () => {
    await engine.close();
    await orchestrator.close();
  });

  it('answers the address itself for an engine, and follows an orchestrator once', async () => {
    const resolver = new EngineResolver(make);
    const direct = await resolver.resolve({ name: 'e', url: engine.url, token: engine.token });
    expect(direct).toMatchObject({ url: engine.url, through: null });
    const hopped = await resolver.resolve({ name: 'o', url: orchestrator.url, token: engine.token });
    expect(hopped.url).toBe(engine.url);
    expect(hopped.through?.url).toBe(engine.url);
    expect(hopped.info.role).toBe('engine');
  });

  it('refuses a chain: an orchestrator whose engine is another orchestrator', async () => {
    const outer = await startFakeCrucible({ role: 'orchestrator', token: engine.token, engine: { url: orchestrator.url } });
    try {
      const resolver = new EngineResolver(make);
      await expect(resolver.resolve({ name: 'x', url: outer.url, token: engine.token }))
        .rejects.toThrow(EngineResolveError);
    } finally {
      await outer.close();
    }
  });

  it('caches for 60 s by name and url, shares concurrent requests, and forgets on demand', async () => {
    let now = 5_000_000;
    const resolver = new EngineResolver(make, () => now);
    const entry = { name: 'o', url: orchestrator.url, token: engine.token };
    await Promise.all([resolver.resolve(entry), resolver.resolve(entry), resolver.resolve(entry)]);
    expect(orchestrator.requestsTo('/v1/info')).toHaveLength(1);
    await resolver.resolve(entry);
    expect(orchestrator.requestsTo('/v1/info')).toHaveLength(1);
    now += RESOLVE_TTL_MS + 1;
    await resolver.resolve(entry);
    expect(orchestrator.requestsTo('/v1/info')).toHaveLength(2);
    resolver.forget('o');
    await resolver.resolve(entry);
    expect(orchestrator.requestsTo('/v1/info')).toHaveLength(3);
  });
});

describe('transport failure classification', () => {
  function withCause(message: string, code?: string): Error {
    const err = new TypeError(message);
    (err as { cause?: unknown }).cause = code === undefined ? undefined : { code, message: `${code} happened` };
    return err;
  }

  it('recognises undici\'s mid-response and pre-response deaths, and the transport errnos', () => {
    expect(transportFailureCause(withCause('terminated', 'ECONNRESET'))).toBe('terminated (ECONNRESET)');
    expect(transportFailureCause(withCause('fetch failed', 'UND_ERR_CONNECT_TIMEOUT'))).toBe('fetch failed (UND_ERR_CONNECT_TIMEOUT)');
    expect(transportFailureCause(withCause('terminated'))).toBe('terminated');
    const refused = new Error('connect failed');
    (refused as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    expect(isTransportFailure(refused)).toBe(true);
  });

  it('does not mistake a programming error for the wire', () => {
    expect(isTransportFailure(new TypeError('x is not a function'))).toBe(false);
    expect(isTransportFailure('terminated')).toBe(false);
    expect(isTransportFailure(new Error('boom'))).toBe(false);
  });

  it('counts an unreachable server and a 5xx as "not now"', () => {
    expect(crucibleUnavailableCause(new CrucibleUnreachable('http://x:1', 'connect ECONNREFUSED'))).toMatch(/unreachable/);
    expect(crucibleUnavailableCause(new CrucibleServerError(503, 'chat_queue_full', 'full'))).toBe('HTTP 503: full');
    expect(crucibleUnavailableCause(new Error('boom'))).toBeNull();
  });

  it('classifies a socket the fake destroys mid-answer as the wire', async () => {
    const fake = await startFakeCrucible({ faults: { resetAfterBytes: [{ match: { path: '/v1/health' }, afterBytes: 20 }] } });
    try {
      const client = new CrucibleClient({ url: fake.url, token: fake.token, clientName: 'spec' });
      const err = await client.health().then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      expect(crucibleUnavailableCause(err)).not.toBeNull();
    } finally {
      await fake.close();
    }
  });
});
