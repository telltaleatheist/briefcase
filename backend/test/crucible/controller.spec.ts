/**
 * The HTTP door, end to end over a real Nest app and a real fake Crucible.
 * Above all: NO RESPONSE CARRIES A TOKEN, whatever the route.
 */
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { CrucibleModule } from '../../src/crucible/crucible.module';
import { CRUCIBLE_CLIPBOARD, CRUCIBLE_PAIRING_HOST, CRUCIBLE_STATE_DIR } from '../../src/crucible/crucible.constants';
import { CrucibleAutoConnectService } from '../../src/crucible/auto-connect.service';
import { WebSocketService } from '../../src/common/websocket.service';
import { pairingHost, pairingLineFor, tempDir } from './helpers';
import type { PairingFileHost } from '../../src/crucible/pairing-file';
import { PROBE_TIMEOUT_MS } from '../../src/crucible/probe';

const emitted: unknown[] = [];

@Global()
@Module({
  providers: [{
    provide: WebSocketService,
    useValue: {
      emitCrucibleServersChanged: (p: unknown) => emitted.push(p),
      emitCrucibleCoordination: () => undefined,
      emitCrucibleInstallProgress: () => undefined,
      emitCrucibleInstallDoor: () => undefined,
      emitCrucibleReadiness: () => undefined,
    },
  }],
  exports: [WebSocketService],
})
class WebSocketStubModule {}

async function appWith(host: PairingFileHost, clipboard: string[], retry: number[] = []): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [WebSocketStubModule, CrucibleModule] })
    .overrideProvider(CRUCIBLE_STATE_DIR).useValue(tempDir())
    .overrideProvider(CRUCIBLE_PAIRING_HOST).useValue(host)
    .overrideProvider(CRUCIBLE_CLIPBOARD).useValue(async (text: string) => { clipboard.push(text); })
    .compile();
  moduleRef.get(CrucibleAutoConnectService).retryDelaysMs = retry;
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('CrucibleController', () => {
  let fake: FakeCrucible;
  let other: FakeCrucible;
  let app: INestApplication;
  let clipboard: string[];
  const bodies: string[] = [];

  /** Every response body, kept so the last test can assert no token ever crossed. */
  function http() {
    const agent = request(app.getHttpServer());
    const keep = (r: request.Response) => { bodies.push(r.text); return r; };
    return {
      get: (url: string) => agent.get(url).then(keep),
      post: (url: string, body: object = {}) => agent.post(url).send(body).then(keep),
      put: (url: string, body: object) => agent.put(url).send(body).then(keep),
      del: (url: string) => agent.delete(url).then(keep),
    };
  }

  beforeAll(async () => {
    fake = await startFakeCrucible({ name: 'crucible@owens-mac-studio', upstreams: { anthropic: { key: 'sk-ant-never-shown-4321' } } });
    other = await startFakeCrucible({ name: 'crucible@owens-pc', backend: 'cuda-linux' });
    clipboard = [];
    app = await appWith(pairingHost(pairingLineFor('crucible@owens-mac-studio', fake.url, fake.token)), clipboard);
  });

  afterAll(async () => {
    await app.close();
    await fake.close();
    await other.close();
  });

  it('adopts the Crucible on this computer at boot, without being asked', async () => {
    // The adoption is fire-and-forget after boot. Wait for it to be OVER, not
    // for a wall-clock guess: under a loaded run a 5 s poll could end before
    // it did, and every later test that names this row then failed with it.
    // Its one probe is bounded by PROBE_TIMEOUT_MS, which is also Jest's default
    // test budget, so this test's budget is set from that bound, not raced by it.
    await app.get(CrucibleAutoConnectService).whenIdle();
    const view = (await http().get('/crucible/servers')).body;
    expect(view.servers[0]).toMatchObject({ name: 'crucible@owens-mac-studio', url: fake.url, tokenMasked: `****${fake.token.slice(-4)}` });
    expect(view.routing).toEqual({ ranked: [{ name: 'crucible@owens-mac-studio', enabled: true }], unknown: [] });
    expect(view.discovered).toMatchObject({ present: true, registeredAs: 'crucible@owens-mac-studio' });
    expect(emitted).toContainEqual({ reason: 'added', server: 'crucible@owens-mac-studio' });
  }, 2 * PROBE_TIMEOUT_MS);

  it('probes (cached) and tests (fresh) a row', async () => {
    const name = encodeURIComponent('crucible@owens-mac-studio');
    const probe = await http().get(`/crucible/servers/${name}/probe`);
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ server: 'crucible@owens-mac-studio', reach: 'ready', probe: { outcome: 'ok', facts: { version: '1.0.24' } } });
    const test = await http().post(`/crucible/servers/${name}/test`);
    expect(test.body.reach).toBe('ready');
  });

  it('adds a server by connect code, previewing it first with the token masked', async () => {
    const line = pairingLineFor('crucible@owens-pc', other.url, other.token).trim();
    const preview = await http().post('/crucible/connect-code/parse', { connectCode: line });
    expect(preview.body).toEqual({ ok: true, name: 'crucible@owens-pc', url: other.url, tokenMasked: `****${other.token.slice(-4)}` });
    const added = await http().post('/crucible/servers', { connectCode: line, name: 'PC' });
    expect(added.status).toBe(201);
    expect(added.body.server).toMatchObject({ name: 'PC', url: other.url });
    const again = await http().post('/crucible/servers', { connectCode: line });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('duplicate_server');
    const bad = await http().post('/crucible/servers', { connectCode: 'not a code' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_pairing');
  });

  it('re-ranks, pauses and resumes, and refuses an incomplete order', async () => {
    const reordered = await http().put('/crucible/routing', { order: ['PC', 'crucible@owens-mac-studio'] });
    expect(reordered.body.ranked.map((r: { name: string }) => r.name)).toEqual(['PC', 'crucible@owens-mac-studio']);
    const paused = await http().post('/crucible/servers/PC/pause');
    expect(paused.body.ranked[0]).toEqual({ name: 'PC', enabled: false });
    const resumed = await http().post('/crucible/servers/PC/resume');
    expect(resumed.body.ranked[0]).toEqual({ name: 'PC', enabled: true });
    const viaDisabled = await http().put('/crucible/routing', { disabled: ['crucible@owens-mac-studio'] });
    expect(viaDisabled.body.ranked).toEqual([{ name: 'PC', enabled: true }, { name: 'crucible@owens-mac-studio', enabled: false }]);
    const incomplete = await http().put('/crucible/routing', { order: ['PC'] });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('incomplete_order');
    expect(emitted).toContainEqual({ reason: 'paused', server: 'PC' });
  });

  it('pairs by address: start, poll, and the server is registered', async () => {
    const third = await startFakeCrucible({ name: 'crucible@droplet' });
    try {
      const start = await http().post('/crucible/pair/start', { address: third.url });
      expect(start.status).toBe(201);
      expect(start.body).toMatchObject({ name: 'crucible@droplet', approvalRequired: false });
      const poll = await http().post('/crucible/pair/poll', { requestId: start.body.requestId });
      expect(poll.body).toEqual({ status: 'approved', name: 'crucible@droplet' });
      const gone = await http().post('/crucible/pair/poll', { requestId: start.body.requestId });
      expect(gone.status).toBe(410);
      const removed = await http().del(`/crucible/servers/${encodeURIComponent('crucible@droplet')}`);
      expect(removed.body.removed.name).toBe('crucible@droplet');
      const cancelled = await http().post('/crucible/pair/cancel', { requestId: 'nope' });
      expect(cancelled.body).toEqual({ cancelled: true });
      const noAddress = await http().post('/crucible/pair/start', {});
      expect(noAddress.status).toBe(400);
    } finally {
      await third.close();
    }
  });

  it('copies connect codes through the backend clipboard, answering with the token elided', async () => {
    const copied = await http().post('/crucible/servers/PC/connect-code/copy');
    expect(copied.body.copied).toMatch(/#\*\*\*\*$/);
    expect(clipboard[0]).toContain(encodeURIComponent(other.token));
    const local = await http().post('/crucible/connect-code/copy');
    expect(local.body.copied).toMatch(/^crucible:\/\/crucible%40owens-mac-studio@/);
  });

  it('proxies that server\'s settings with hints only, and tests an upstream', async () => {
    const name = encodeURIComponent('crucible@owens-mac-studio');
    const settings = await http().get(`/crucible/servers/${name}/settings`);
    expect(settings.body.upstreams.anthropic).toEqual({ configured: true, keyHint: '…4321' });
    const put = await http().put(`/crucible/servers/${name}/settings`, { upstreams: { openai: { key: 'sk-openai-typed-8765' } } });
    expect(put.body.upstreams.openai).toEqual({ configured: true, keyHint: '…8765' });
    const tested = await http().post(`/crucible/servers/${name}/settings/upstreams/anthropic/test`, {});
    expect(tested.body).toMatchObject({ ok: true });
    const unknown = await http().put(`/crucible/servers/${name}/settings`, { bogus: true });
    expect(unknown.status).toBe(400);
  });

  it('shapes failures: unknown server 404, unreachable server a named probe outcome', async () => {
    expect((await http().del('/crucible/servers/ghost')).status).toBe(404);
    expect((await http().post('/crucible/servers/ghost/pause')).body.code).toBe('unknown_server');
    await other.close();
    const test = await http().post('/crucible/servers/PC/test');
    expect(test.body).toMatchObject({ reach: 'unreachable', probe: { outcome: 'unreachable' } });
    const settings = await http().get('/crucible/servers/PC/settings');
    expect(settings.status).toBe(502);
    expect(settings.body.code).toBe('unreachable');
    other = await startFakeCrucible();
  });

  it('never put a Crucible token, an upstream key or a device code in any response', () => {
    const all = bodies.join('\n');
    expect(bodies.length).toBeGreaterThan(20);
    for (const secret of [fake.token, 'sk-ant-never-shown-4321', 'sk-openai-typed-8765']) {
      expect(all).not.toContain(secret);
      expect(all).not.toContain(encodeURIComponent(secret));
    }
    expect(all).not.toMatch(/device_code|deviceCode/);
  });
});

describe('boot tolerance', () => {
  it('app.init() does not wait for a Crucible that never answers', async () => {
    const asleep = await startFakeCrucible();
    asleep.inject({ stallMs: 60_000 });
    const app = await appWith(pairingHost(pairingLineFor('crucible@asleep', asleep.url, asleep.token)), []);
    try {
      // Ordering, not a stopwatch: init has returned while the boot adoption
      // is still out (the server stalls for 60 s), so init did not wait on it.
      let adoptionOver = false;
      void app.get(CrucibleAutoConnectService).whenIdle().then(() => { adoptionOver = true; });
      await Promise.resolve();
      expect(adoptionOver).toBe(false);
      const list = await request(app.getHttpServer()).get('/crucible/servers');
      expect(list.status).toBe(200);
      expect(list.body.servers).toEqual([]);
    } finally {
      await app.close();
      await asleep.close();
    }
  });

  it('with no Crucible at all, the list answers and offers nothing', async () => {
    const app = await appWith(pairingHost(null), []);
    try {
      const list = await request(app.getHttpServer()).get('/crucible/servers');
      expect(list.body).toMatchObject({ servers: [], discovered: { present: false, code: 'no_local_config' } });
    } finally {
      await app.close();
    }
  });
});
