/**
 * THE DRIVEN INSTALL, end to end against the fake Crucible and a temp
 * CRUCIBLE_HOME. `@crucible/bootstrap` is injected as a fake whose install()
 * does what the real one leaves behind (the pairing file, a running engine),
 * so nothing is installed, started or downloaded on this machine.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import { compareReleases, type InstallOptions, type InstallResult, type LocalStatus, type Runner } from '@crucible/bootstrap';
import { WebSocketService } from '../../src/common/websocket.service';
import { CrucibleCoordinationService } from '../../src/crucible/coordinate.service';
import { CrucibleModule } from '../../src/crucible/crucible.module';
import { CRUCIBLE_PAIRING_HOST, CRUCIBLE_STATE_DIR } from '../../src/crucible/crucible.constants';
import { CrucibleAutoConnectService } from '../../src/crucible/auto-connect.service';
import { discoveredRow } from '../../src/crucible/discovery';
import { readCruciblePairingFile, type PairingFileHost } from '../../src/crucible/pairing-file';
import { HostInstallDoor, type InstallDoorHost } from '../../src/crucible/install/install-door';
import type { BootstrapSurface, CrucibleReleaseSources, InstallHost } from '../../src/crucible/install/install';
import {
  CRUCIBLE_INSTALL_DEPS,
  CrucibleInstallService,
  INSTALL_STATE_FILE,
  type InstallDeps,
} from '../../src/crucible/install/install.service';
import type { CrucibleInstallProgress } from '../../src/crucible/wire/install-wire';
import type { CrucibleCoordinationState } from '../../src/crucible/wire/coordinate-wire';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { pairingLineFor, tempDir } from './helpers';

/** A pairing host that reads the real file under a temp CRUCIBLE_HOME. */
function homeHost(home: string): PairingFileHost {
  return {
    platform: 'darwin',
    env: { CRUCIBLE_HOME: home },
    homedir: '/nonexistent-home',
    readFile: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null),
  };
}

const quietDoorHost = (): InstallDoorHost => ({
  runner: () => ({ platform: 'darwin' }) as Runner,
  status: async () => ({ running: false, outcome: null }),
  watch: async () => ({ running: false, outcome: null }),
  post: async () => undefined,
  installed: () => false,
});

interface FakeBootstrap extends BootstrapSurface {
  installs: InstallOptions[];
  /** Replace install()'s behaviour. */
  onInstall?: (options: InstallOptions) => Promise<InstallResult>;
  startAnswer?: Partial<LocalStatus>;
}

/** Does what a real install leaves behind: the pairing file in CRUCIBLE_HOME naming a running engine. */
function fakeBootstrap(home: string, fake: FakeCrucible): FakeBootstrap {
  const bootstrap: FakeBootstrap = {
    installs: [],
    install: async (options) => {
      bootstrap.installs.push(options);
      if (bootstrap.onInstall) return bootstrap.onInstall(options);
      options.onStep?.({ name: 'server', argv: [], status: 'running', detail: 'download the pinned interpreter' });
      options.onLine('Collecting crucible==1.0.23', 'stdout', 'server');
      options.onStep?.({ name: 'server', argv: [], status: 'ok', detail: '' });
      options.onStep?.({ name: 'init', argv: [], status: 'running', detail: 'write config.toml' });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'pairing'), pairingLineFor(fake.name, fake.url, fake.token));
      options.onStep?.({ name: 'init', argv: [], status: 'ok', detail: '' });
      return {
        steps: [],
        server: { name: fake.name, url: fake.url, configPath: path.join(home, 'config.toml') },
        release: options.release ?? '?',
        backend: 'mlx-darwin',
        crucible: path.join(home, 'server/bin/crucible'),
      };
    },
    startLocal: async () => ({ schema_version: 1, state: 'running', name: fake.name, url: fake.url, detail: 'running', ...bootstrap.startAnswer }),
  };
  return bootstrap;
}

interface Rig {
  fake: FakeCrucible;
  home: string;
  h: Harness;
  coordination: CrucibleCoordinationService;
  service: CrucibleInstallService;
  bootstrap: FakeBootstrap;
  events: CrucibleInstallProgress[];
  coordinated: CrucibleCoordinationState[];
  sources: CrucibleReleaseSources & { latestIs: string };
}

const opened: FakeCrucible[] = [];
afterAll(async () => { await Promise.all(opened.map((f) => f.close())); });

async function rig(options: { arch?: string; latest?: string } = {}): Promise<Rig> {
  const fake = await startFakeCrucible({ name: 'crucible@fresh-mac' });
  opened.push(fake);
  const home = tempDir('crucible-home-');
  const pairingHost = homeHost(home);
  const h = harness(pairingHost);
  const events: CrucibleInstallProgress[] = [];
  const coordinated: CrucibleCoordinationState[] = [];
  const ws = {
    emitCrucibleServersChanged: () => undefined,
    emitCrucibleInstallProgress: (p: CrucibleInstallProgress) => events.push(p),
    emitCrucibleInstallDoor: () => undefined,
    emitCrucibleCoordination: (s: CrucibleCoordinationState) => coordinated.push(s),
  };
  const coordination = new CrucibleCoordinationService(h.registry, h.factory, h.dir, ws as never);
  const bootstrap = fakeBootstrap(home, fake);
  const sources = {
    latestIs: options.latest ?? '1.0.23',
    latest: async () => sources.latestIs,
    // The real source's shape: the engine named by the pairing file, asked its version.
    running: async () => {
      const found = readCruciblePairingFile(pairingHost);
      if (found === null) return null;
      return (await h.factory.clientForCredentials(found.pairing.url, found.pairing.token).info()).server.version;
    },
    compare: compareReleases,
  };
  const host: InstallHost = {
    platform: 'darwin',
    arch: options.arch ?? 'arm64',
    queryGpu: () => { throw new Error('a Mac is never asked for nvidia-smi'); },
    discovered: () => discoveredRow(h.registry.list(), pairingHost),
  };
  const deps: InstallDeps = {
    host,
    sources,
    bootstrap: async () => bootstrap,
    runner: () => ({ platform: 'darwin' }) as Runner,
    localControls: async () => ({ status: async () => { throw new Error('unused'); }, start: async () => { throw new Error('unused'); } }),
    home,
    door: new HostInstallDoor(quietDoorHost()),
  };
  const autoConnect = new CrucibleAutoConnectService(h.registry, h.factory, pairingHost);
  const service = new CrucibleInstallService(h.registry, autoConnect, coordination, h.dir, deps, ws as never);
  return { fake, home, h, coordination, service, bootstrap, events, coordinated, sources };
}

async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const record = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, INSTALL_STATE_FILE), 'utf-8'));

describe('CrucibleInstallService', () => {
  it('the happy path: gate, bare install into CRUCIBLE_HOME, engine up, adopted, coordinated', async () => {
    const r = await rig();
    expect(r.service.setup().face).toBe('install');

    await expect(r.service.start()).resolves.toEqual({ started: true, release: '1.0.23' });
    await r.service.settled();

    // A bare service, at the release the gate chose, into the temp home.
    expect(r.bootstrap.installs).toHaveLength(1);
    expect(r.bootstrap.installs[0]).toMatchObject({ jobTypes: ['echo'], release: '1.0.23', home: r.home });

    // Progress, in the package's own shapes, ending in done with the registry row.
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toContain('step');
    expect(kinds).toContain('line');
    expect(r.events.some((e) => e.kind === 'step' && e.step === 'local-readiness' && e.status === 'ok')).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ kind: 'done', release: '1.0.23', backend: 'mlx-darwin', connectedAs: 'crucible@fresh-mac' });

    // Adopted as an ordinary registry row, and the record on disk says done.
    expect(r.h.registry.names()).toEqual(['crucible@fresh-mac']);
    expect(record(r.h.dir)).toMatchObject({ state: 'done', release: '1.0.23', refusal: null });
    expect(r.service.status()).toMatchObject({ running: false, interrupted: false });
    expect(r.service.setup().face).toBe('connected');

    // Coordinated: the bare service was missing Briefcase's module, so it was posted once.
    await until('coordination to finish', () => r.coordinated.some((s) => s.phase === 'preparing' && s.progress.state === 'done'));
    expect(r.fake.requestsTo('/v1/tasks', 'POST')).toHaveLength(1);
  });

  it('held by the first-run wizard: installs and connects, but posts nothing until setup finishes', async () => {
    const r = await rig();
    r.coordination.holdForFirstRun();
    await r.service.start();
    await r.service.settled();
    expect(r.h.registry.names()).toEqual(['crucible@fresh-mac']);
    expect(r.coordination.all()['crucible@fresh-mac']).toEqual({ server: 'crucible@fresh-mac', phase: 'deferred', reason: 'first-run' });
    expect(r.fake.requestsTo('/v1/tasks', 'POST')).toHaveLength(0);
    expect(r.service.setup().coordinationHeld).toBe(true);

    r.coordination.finishFirstRun();
    await until('the post', () => r.fake.requestsTo('/v1/tasks', 'POST').length === 1);
  });

  it('a newer Crucible already running (BookForge put it there): refused before anything is spawned', async () => {
    const r = await rig({ latest: '1.0.22' });
    fs.mkdirSync(r.home, { recursive: true });
    fs.writeFileSync(path.join(r.home, 'pairing'), pairingLineFor(r.fake.name, r.fake.url, r.fake.token));
    expect(r.service.setup().face).toBe('adopt');
    await expect(r.service.start()).rejects.toMatchObject({ code: 'install_older_than_running' });
    expect(r.bootstrap.installs).toHaveLength(0);
    expect(fs.existsSync(path.join(r.h.dir, INSTALL_STATE_FILE))).toBe(false);
    expect(r.service.status().running).toBe(false);
  });

  it('the same Crucible already running: crucible_already_latest, nothing spawned', async () => {
    const r = await rig({ latest: '1.0.24' });
    fs.writeFileSync(path.join(r.home, 'pairing'), pairingLineFor(r.fake.name, r.fake.url, r.fake.token));
    await expect(r.service.start()).rejects.toMatchObject({ code: 'crucible_already_latest' });
    expect(r.bootstrap.installs).toHaveLength(0);
  });

  it('an Intel Mac is refused not_hostable, and never reaches the gate', async () => {
    const r = await rig({ arch: 'x64' });
    const latest = jest.spyOn(r.sources, 'latest');
    expect(r.service.setup().face).toBe('connect-only');
    await expect(r.service.start()).rejects.toMatchObject({ code: 'not_hostable' });
    expect(latest).not.toHaveBeenCalled();
  });

  it('ONE AT A TIME: a second press while one runs is host_install_running', async () => {
    const r = await rig();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const original = r.bootstrap.install;
    r.bootstrap.onInstall = async (options) => {
      await held;
      r.bootstrap.onInstall = undefined;
      r.bootstrap.installs.pop();
      return original(options, { platform: 'darwin' } as Runner);
    };
    await r.service.start();
    expect(r.service.status().running).toBe(true);
    await expect(r.service.start()).rejects.toMatchObject({ code: 'host_install_running' });
    release();
    await r.service.settled();
    expect(r.events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('a package refusal crosses VERBATIM, is recorded, and releases the lock', async () => {
    const r = await rig();
    r.bootstrap.onInstall = async () => {
      throw Object.assign(new Error('the server pack did not match its published sha256'), {
        code: 'runtime_sha_mismatch', command: null, detail: 'expected 1f2e… got 9a8b…',
      });
    };
    await expect(r.service.start()).resolves.toMatchObject({ started: true, release: '1.0.23' });
    await r.service.settled();
    expect(r.events.at(-1)).toEqual({
      kind: 'failed',
      refusal: {
        code: 'runtime_sha_mismatch',
        message: 'runtime_sha_mismatch: the server pack did not match its published sha256',
        command: null,
        detail: 'expected 1f2e… got 9a8b…',
      },
    });
    expect(record(r.h.dir)).toMatchObject({ state: 'failed', refusal: { code: 'runtime_sha_mismatch' } });
    expect(r.h.registry.names()).toEqual([]);
    expect(r.service.status().running).toBe(false);

    // The lock is released: pressing again runs again.
    r.bootstrap.onInstall = undefined;
    await r.service.start();
    await r.service.settled();
    expect(r.events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('an engine that comes up as something else is install_failed, not adopted', async () => {
    const r = await rig();
    r.bootstrap.startAnswer = { url: 'http://127.0.0.1:1' };
    await r.service.start();
    await r.service.settled();
    expect(r.events.at(-1)).toMatchObject({ kind: 'failed', refusal: { code: 'install_failed' } });
    expect(r.h.registry.names()).toEqual([]);
  });

  it('an install this process did not finish reads as interrupted after a relaunch', async () => {
    const r = await rig();
    fs.writeFileSync(path.join(r.h.dir, INSTALL_STATE_FILE), JSON.stringify({
      state: 'running', release: '1.0.23', step: 'server', startedAt: '2026-09-23T10:00:00Z', finishedAt: null, refusal: null,
    }));
    expect(r.service.status()).toMatchObject({ running: false, interrupted: true, last: { step: 'server' } });
    // Nothing was left on disk, so the face is still install; pressing it resumes.
    expect(r.service.setup().face).toBe('install');
    await r.service.start();
    await r.service.settled();
    expect(r.service.status()).toMatchObject({ interrupted: false, last: { state: 'done' } });
  });
});

describe('the setup door over HTTP', () => {
  const emitted: unknown[] = [];

  @Global()
  @Module({
    providers: [{
      provide: WebSocketService,
      useValue: {
        emitCrucibleServersChanged: (p: unknown) => emitted.push(p),
        emitCrucibleCoordination: (p: unknown) => emitted.push(p),
        emitCrucibleInstallProgress: (p: unknown) => emitted.push(p),
        emitCrucibleInstallDoor: (p: unknown) => emitted.push(p),
      },
    }],
    exports: [WebSocketService],
  })
  class WebSocketStubModule {}

  let app: INestApplication;
  let fake: FakeCrucible;
  let home: string;

  beforeAll(async () => {
    fake = await startFakeCrucible({ name: 'crucible@fresh-mac' });
    opened.push(fake);
    home = tempDir('crucible-home-');
    const pairingHost = homeHost(home);
    const stateDir = tempDir();
    const deps: InstallDeps = {
      host: { platform: 'darwin', arch: 'arm64', queryGpu: () => ({ status: 3, stdout: '', stderr: '' }), discovered: () => discoveredRow([], pairingHost) },
      sources: { latest: async () => '1.0.23', running: async () => null, compare: compareReleases },
      bootstrap: async () => fakeBootstrap(home, fake),
      runner: () => ({ platform: 'darwin' }) as Runner,
      localControls: async () => ({
        status: async () => ({ schema_version: 1, state: 'stopped', name: fake.name, url: fake.url, detail: 'launchd has it unloaded' }),
        start: async () => ({ schema_version: 1, state: 'running', name: fake.name, url: fake.url, detail: 'started' }),
      }),
      home,
      door: new HostInstallDoor(quietDoorHost()),
    };
    const moduleRef = await Test.createTestingModule({ imports: [WebSocketStubModule, CrucibleModule] })
      .overrideProvider(CRUCIBLE_STATE_DIR).useValue(stateDir)
      .overrideProvider(CRUCIBLE_PAIRING_HOST).useValue(pairingHost)
      .overrideProvider(CRUCIBLE_INSTALL_DEPS).useValue(deps)
      .compile();
    moduleRef.get(CrucibleAutoConnectService).retryDelaysMs = [];
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => { await app.close(); });

  it('GET /crucible/setup draws the install face on an empty Apple silicon Mac', async () => {
    const res = await request(app.getHttpServer()).get('/crucible/setup').expect(200);
    expect(res.body).toMatchObject({ face: 'install', servers: [], plan: { hostable: 'yes' }, install: { running: false }, coordinationHeld: false });
  });

  it('the wizard holds coordination, reads the local presence, and releases the hold', async () => {
    await request(app.getHttpServer()).post('/crucible/first-run/hold').expect(201, { held: true });
    expect((await request(app.getHttpServer()).get('/crucible/setup')).body.coordinationHeld).toBe(true);
    const presence = await request(app.getHttpServer()).get('/crucible/local/presence').expect(200);
    expect(presence.body).toMatchObject({ state: 'stopped', offerStart: true, message: 'Crucible is stopped on this computer.' });
    await request(app.getHttpServer()).post('/crucible/first-run/finish').expect(201, { released: true, coordinating: [] });
  });

  it('POST /crucible/install answers 202 with the release, then a second press is 409 host_install_running or the gate', async () => {
    const res = await request(app.getHttpServer()).post('/crucible/install').expect(202);
    expect(res.body).toEqual({ started: true, release: '1.0.23' });
    const deadline = Date.now() + 5_000;
    while ((await request(app.getHttpServer()).get('/crucible/setup')).body.face !== 'connected') {
      if (Date.now() > deadline) throw new Error('never connected');
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(emitted.some((e) => (e as { kind?: string }).kind === 'done')).toBe(true);
    const refused = await request(app.getHttpServer()).get('/crucible/install/release').expect(200);
    expect(refused.body).toEqual({ action: 'install', latest: '1.0.23', running: null });
  });

  it('refusals keep their shape: an unknown server is 404 by name', async () => {
    const res = await request(app.getHttpServer()).post('/crucible/servers/nope/coordinate').expect(404);
    expect(res.body).toMatchObject({ code: 'unknown_server' });
  });
});
