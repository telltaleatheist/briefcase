import * as fs from 'fs';
import * as path from 'path';
import { startFakeCrucible, startNotCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { autoConnectLocal, type AutoConnectDeps } from '../../src/crucible/auto-connect.service';
import { REGISTRY_FILE } from '../../src/crucible/registry';
import { pairingHost, pairingLineFor, tempDir } from './helpers';
import { harness } from './harness';

describe('auto-connect: adopting the Crucible on this computer', () => {
  let fake: FakeCrucible;
  beforeEach(async () => {
    fake = await startFakeCrucible({ name: 'crucible@owens-mac-studio' });
  });
  afterEach(() => fake.close());

  const line = (): string => pairingLineFor('crucible@owens-mac-studio', fake.url, fake.token);

  it('adopts the pairing when no registry exists yet, under the name the server calls itself', async () => {
    const h = harness(pairingHost(line()));
    expect(await h.autoConnect.run()).toBe('crucible@owens-mac-studio');
    expect(h.registry.list()).toEqual([expect.objectContaining({ name: 'crucible@owens-mac-studio', url: fake.url, tokenMasked: `****${fake.token.slice(-4)}` })]);
    expect(h.registry.getWithToken('crucible@owens-mac-studio').token).toBe(fake.token);
    expect(h.emitted).toEqual([{ reason: 'added', server: 'crucible@owens-mac-studio' }]);
  });

  it('adopts only when the registry is ABSENT: an existing empty one may be a deliberate removal', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, REGISTRY_FILE), JSON.stringify({ servers: [] }));
    const h = harness(pairingHost(line()), dir);
    expect(await h.autoConnect.run()).toBeNull();
    expect(h.registry.list()).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it('after an install it adopts even when a registry exists, and returns an existing row at that address', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, REGISTRY_FILE), JSON.stringify({ servers: [] }));
    const h = harness(pairingHost(line()), dir);
    expect(await h.autoConnect.run(true)).toBe('crucible@owens-mac-studio');
    expect(await h.autoConnect.run(true)).toBe('crucible@owens-mac-studio');
    expect(h.registry.list()).toHaveLength(1);
  });

  it('does nothing with no pairing file, and refuses by name after an install that published none', async () => {
    const h = harness(pairingHost(null));
    expect(await h.autoConnect.run()).toBeNull();
    await expect(h.autoConnect.run(true)).rejects.toThrow(/did not publish how to reach it/);
    expect(h.registry.exists()).toBe(false);
  });

  it('refuses a pairing whose token the server does not accept, and writes nothing', async () => {
    const h = harness(pairingHost(pairingLineFor('crucible@owens-mac-studio', fake.url, 'stale-token-0000')));
    await expect(h.autoConnect.run()).rejects.toThrow();
    expect(h.registry.exists()).toBe(false);
  });

  it('refuses a pairing that points at something that is not a Crucible', async () => {
    const router = await startNotCrucible();
    try {
      const h = harness(pairingHost(pairingLineFor('crucible@owens-mac-studio', router.url, fake.token)));
      await expect(h.autoConnect.run()).rejects.toThrow();
      expect(h.registry.exists()).toBe(false);
    } finally {
      await router.close();
    }
  });

  it('refuses a pairing when the server answering is a different Crucible', async () => {
    const h = harness(pairingHost(pairingLineFor('crucible@some-other-mac', fake.url, fake.token)));
    await expect(h.autoConnect.run()).rejects.toThrow(/not the "crucible@some-other-mac"/);
    expect(h.registry.exists()).toBe(false);
  });

  it('never blocks boot: onApplicationBootstrap returns at once even when the Crucible never answers', async () => {
    fake.inject({ stallMs: 60_000 });
    const h = harness(pairingHost(line()));
    h.autoConnect.retryDelaysMs = [];
    // Ordering, not a stopwatch: the hook has returned while its attempt is still out.
    expect(h.autoConnect.onApplicationBootstrap()).toBeUndefined();
    let over = false;
    void h.autoConnect.whenIdle().then(() => { over = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(over).toBe(false);
    h.autoConnect.onApplicationShutdown();
  });

  it('retries while nothing answers and no registry exists, then connects when the service comes up', async () => {
    const h = harness(pairingHost(line()));
    h.autoConnect.retryDelaysMs = [50, 50];
    fake.faults.connectDelay = [{ match: { path: '/v1/info' }, ms: 10, times: 1 }];
    h.autoConnect.onApplicationBootstrap();
    await h.autoConnect.whenIdle(); // the attempts are over, whatever they concluded
    h.autoConnect.onApplicationShutdown();
    expect(h.registry.names()).toEqual(['crucible@owens-mac-studio']);
  });

  it('the pure rule: re-reads the registry after verifying, so a row that landed meanwhile wins', async () => {
    const rows: Array<{ name: string; url: string }> = [];
    const deps: AutoConnectDeps = {
      registryExists: () => false,
      pairing: () => ({ name: 'crucible@x', url: 'http://127.0.0.1:7100', token: 't' }),
      list: () => rows,
      verify: async () => { rows.push({ name: 'added-meanwhile', url: 'http://127.0.0.1:7100/' }); },
      add: () => { throw new Error('must not add'); },
    };
    expect(await autoConnectLocal(false, deps)).toBe('added-meanwhile');
  });
});
