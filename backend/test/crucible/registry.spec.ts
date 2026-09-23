import * as fs from 'fs';
import * as path from 'path';
import { ServerRegistry, maskToken, originKey, validateServerName, REGISTRY_FILE } from '../../src/crucible/registry';
import { Routing, ROUTING_FILE } from '../../src/crucible/routing';
import { CrucibleRegistryError, CrucibleRoutingError } from '../../src/crucible/errors';
import { CrucibleRegistryService } from '../../src/crucible/registry.service';
import { tempDir } from './helpers';

const TOKEN_A = 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1234';
const TOKEN_B = 'tok-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-5678';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

describe('ServerRegistry', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, REGISTRY_FILE);
  });

  it('reads a missing file as an empty registry, and says it does not exist yet', () => {
    const registry = new ServerRegistry(file);
    expect(registry.exists()).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('writes temp-then-rename, 0600, and leaves no temp file behind', () => {
    const registry = new ServerRegistry(file);
    registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    expect(fs.readdirSync(dir)).toEqual([REGISTRY_FILE]);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.servers[0]).toMatchObject({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  });

  it('never lists a token: rows carry ****<last 4> only', () => {
    const registry = new ServerRegistry(file);
    registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    const listed = registry.list();
    expect(listed[0]!.tokenMasked).toBe('****1234');
    expect(JSON.stringify(listed)).not.toContain(TOKEN_A);
    expect(maskToken(TOKEN_B)).toBe('****5678');
  });

  it('hands the token out by exact name only, and refuses an unknown name by listing what it knows', () => {
    const registry = new ServerRegistry(file);
    registry.add({ name: 'Mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    expect(registry.get('Mac').token).toBe(TOKEN_A);
    expect(codeOf(() => registry.get('mac'))).toBe('unknown_server');
    expect(() => registry.get('pc')).toThrow(/known: Mac/);
  });

  it('refuses a duplicate name (case-insensitive) and a second row on the same address', () => {
    const registry = new ServerRegistry(file);
    registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    expect(codeOf(() => registry.add({ name: 'MAC', url: 'http://10.0.0.2:7100', token: TOKEN_B }))).toBe('duplicate_server');
    expect(codeOf(() => registry.add({ name: 'pc', url: 'http://127.0.0.1:7100/', token: TOKEN_B }))).toBe('duplicate_server');
    expect(originKey('http://LOCALHOST:7100/')).toBe(originKey('http://localhost:7100'));
    expect(originKey('http://localhost')).toBe('http://localhost:80');
  });

  it('refuses a URL with no scheme or with /v1, and an empty token', () => {
    const registry = new ServerRegistry(file);
    expect(codeOf(() => registry.add({ name: 'a', url: '10.0.0.2:7100', token: TOKEN_A }))).toBe('invalid_url');
    expect(codeOf(() => registry.add({ name: 'a', url: 'http://10.0.0.2:7100/v1', token: TOKEN_A }))).toBe('invalid_url');
    expect(codeOf(() => registry.add({ name: 'a', url: 'http://10.0.0.2:7100', token: '  ' }))).toBe('empty_token');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('validates names at the door: colons, slashes, control characters, double spaces, length', () => {
    expect(validateServerName('  crucible@owens-mac-studio ')).toBe('crucible@owens-mac-studio');
    expect(validateServerName('3090 Ti')).toBe('3090 Ti');
    for (const bad of ['', 'gpu:mac', 'a/b', 'a\\b', 'tab\there', 'two  spaces', 'x'.repeat(49)]) {
      expect(codeOf(() => validateServerName(bad))).toBe('invalid_name');
    }
  });

  it('refuses a corrupt file and never overwrites it', () => {
    fs.writeFileSync(file, '{ not json');
    const registry = new ServerRegistry(file);
    expect(codeOf(() => registry.list())).toBe('corrupt_registry');
    expect(codeOf(() => registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A }))).toBe('corrupt_registry');
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'mac', url: 'http://x:1' }] }));
    expect(() => registry.list()).toThrow(CrucibleRegistryError);
  });

  it('removes a server, and refuses to remove one it does not have', () => {
    const registry = new ServerRegistry(file);
    registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    expect(registry.remove('mac').name).toBe('mac');
    expect(registry.list()).toEqual([]);
    expect(registry.exists()).toBe(true);
    expect(codeOf(() => registry.remove('mac'))).toBe('unknown_server');
  });
});

describe('Routing (rank and Running/Paused)', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(tempDir(), ROUTING_FILE);
  });

  it('with no record, ranks servers in registry order, all Running; a new server lands at the bottom', () => {
    const routing = new Routing(file);
    expect(routing.view(['mac', 'pc']).ranked).toEqual([{ name: 'mac', enabled: true }, { name: 'pc', enabled: true }]);
    routing.setOrder(['pc', 'mac'], ['mac', 'pc']);
    expect(routing.view(['mac', 'pc', 'droplet']).ranked.map((r) => r.name)).toEqual(['pc', 'mac', 'droplet']);
  });

  it('refuses an order that drops, repeats or invents a server', () => {
    const routing = new Routing(file);
    const known = ['mac', 'pc'];
    expect(() => routing.setOrder(['mac'], known)).toThrow(expect.objectContaining({ code: 'incomplete_order' }));
    expect(() => routing.setOrder(['mac', 'mac', 'pc'], known)).toThrow(expect.objectContaining({ code: 'duplicate_in_order' }));
    expect(() => routing.setOrder(['mac', 'pc', 'ghost'], known)).toThrow(expect.objectContaining({ code: 'unknown_server' }));
  });

  it('pauses and resumes, and ranked() refuses by name when nothing is Running', () => {
    const routing = new Routing(file);
    const known = ['mac', 'pc'];
    routing.setEnabled('mac', false, known);
    expect(routing.view(known).ranked).toEqual([{ name: 'mac', enabled: false }, { name: 'pc', enabled: true }]);
    expect(routing.ranked(known).map((r) => r.name)).toEqual(['pc']);
    routing.setEnabled('pc', false, known);
    expect(() => routing.ranked(known)).toThrow(/Every Crucible server is paused/);
    expect(() => routing.ranked([])).toThrow(expect.objectContaining({ code: 'no_enabled_server' }));
    routing.setEnabled('mac', true, known);
    expect(routing.ranked(known).map((r) => r.name)).toEqual(['mac']);
  });

  it('reports a removed server as unknown instead of pruning it, and forgets it only on request', () => {
    const routing = new Routing(file);
    routing.setOrder(['pc', 'mac'], ['mac', 'pc']);
    routing.setEnabled('pc', false, ['mac', 'pc']);
    const view = routing.view(['mac']);
    expect(view.ranked).toEqual([{ name: 'mac', enabled: true }]);
    expect(view.unknown).toEqual(['pc']);
    // Re-added under the same name: its rank and its pause come back.
    expect(routing.view(['mac', 'pc']).ranked).toEqual([{ name: 'pc', enabled: false }, { name: 'mac', enabled: true }]);
    expect(() => routing.forget('mac', ['mac'])).toThrow(expect.objectContaining({ code: 'server_is_known' }));
    expect(routing.forget('pc', ['mac']).unknown).toEqual([]);
  });

  it('refuses a corrupt record and reads BookForge\'s extra key without complaint', () => {
    fs.writeFileSync(file, JSON.stringify({ order: 'mac', disabled: [] }));
    expect(() => new Routing(file).read()).toThrow(CrucibleRoutingError);
    fs.writeFileSync(file, JSON.stringify({ order: ['mac'], disabled: [], newJobsWaitFor: 'any' }));
    expect(new Routing(file).read()).toEqual({ order: ['mac'], disabled: [] });
  });
});

describe('CrucibleRegistryService', () => {
  it('survives a restart: pause, rank and removal are read back by a new instance over the same dir', () => {
    const dir = tempDir();
    const first = new CrucibleRegistryService(dir);
    first.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    first.add({ name: 'pc', url: 'http://10.0.0.2:7100', token: TOKEN_B });
    first.add({ name: 'droplet', url: 'https://droplet.example:7100', token: TOKEN_B });
    first.setOrder(['pc', 'droplet', 'mac']);
    first.setEnabled('droplet', false);
    first.remove('mac');

    const second = new CrucibleRegistryService(dir);
    expect(second.list().map((r) => r.name)).toEqual(['pc', 'droplet']);
    expect(second.routingView().ranked).toEqual([{ name: 'pc', enabled: true }, { name: 'droplet', enabled: false }]);
    expect(second.routingView().unknown).toEqual(['mac']);
    expect(second.rankedEnabled().map((r) => r.name)).toEqual(['pc']);
  });

  it('announces every write on crucible.servers-changed and to in-process listeners', () => {
    const emitted: unknown[] = [];
    const heard: unknown[] = [];
    const service = new CrucibleRegistryService(tempDir(), { emitCrucibleServersChanged: (p: unknown) => emitted.push(p) } as never);
    service.onChange((c) => heard.push(c));
    service.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    service.setEnabled('mac', false);
    service.setEnabled('mac', true);
    service.setOrder(['mac']);
    service.remove('mac');
    service.forgetRoutingName('mac');
    expect(emitted.map((p) => (p as { reason: string }).reason)).toEqual(['added', 'paused', 'resumed', 'order', 'removed', 'forgotten']);
    expect(heard).toEqual(emitted);
    expect(JSON.stringify(emitted)).not.toContain(TOKEN_A);
  });
});
