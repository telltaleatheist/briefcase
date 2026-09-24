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

describe('Routing (the one selected server)', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(tempDir(), ROUTING_FILE);
  });

  it('with no record: the only server is selected; with several, none is, and selectedServer() refuses by name', () => {
    const routing = new Routing(file);
    expect(routing.view(['mac'])).toEqual({ servers: [{ name: 'mac', selected: true }], selected: 'mac', missing: null });
    expect(routing.selectedServer(['mac'])).toBe('mac');
    expect(routing.view(['mac', 'pc']).selected).toBeNull();
    expect(() => routing.selectedServer(['mac', 'pc'])).toThrow(/No Crucible server is selected/);
    expect(() => routing.selectedServer([])).toThrow(expect.objectContaining({ code: 'no_selected_server' }));
  });

  it('selects one server, refusing a name it does not know', () => {
    const routing = new Routing(file);
    const view = routing.select('pc', ['mac', 'pc']);
    expect(view.servers).toEqual([{ name: 'mac', selected: false }, { name: 'pc', selected: true }]);
    expect(routing.selectedServer(['mac', 'pc'])).toBe('pc');
    expect(() => routing.select('ghost', ['mac', 'pc'])).toThrow(expect.objectContaining({ code: 'unknown_server' }));
  });

  it('the first server added is selected; a later one is not, even when the first was only implied', () => {
    const routing = new Routing(file);
    routing.added('mac', ['mac']);
    expect(routing.read()).toEqual({ selected: 'mac', recorded: true });
    routing.added('pc', ['mac', 'pc']);
    expect(routing.selectedServer(['mac', 'pc'])).toBe('mac');

    const implied = new Routing(path.join(tempDir(), ROUTING_FILE));
    expect(implied.view(['mac']).selected).toBe('mac');
    implied.added('pc', ['mac', 'pc']);
    expect(implied.selectedServer(['mac', 'pc'])).toBe('mac');
  });

  it('never picks another server on its own: removing the selected one leaves none selected, and a vanished one is reported', () => {
    const routing = new Routing(file);
    routing.select('pc', ['mac', 'pc']);
    routing.removed('pc');
    expect(routing.view(['mac'])).toEqual({ servers: [{ name: 'mac', selected: false }], selected: null, missing: null });
    expect(() => routing.selectedServer(['mac'])).toThrow(/No Crucible server is selected/);

    routing.select('mac', ['mac']);
    expect(routing.view(['pc'])).toEqual({ servers: [{ name: 'pc', selected: false }], selected: null, missing: 'mac' });
    expect(() => routing.selectedServer(['pc'])).toThrow(/"mac" isn't connected any more/);
  });

  it('reads the older ranked record as its first running server, and refuses a corrupt one', () => {
    fs.writeFileSync(file, JSON.stringify({ order: ['mac', 'pc'], disabled: ['mac'], newJobsWaitFor: 'any' }));
    expect(new Routing(file).read()).toEqual({ selected: 'pc', recorded: false });
    expect(new Routing(file).selectedServer(['mac', 'pc'])).toBe('pc');
    fs.writeFileSync(file, JSON.stringify({ order: 'mac', disabled: [] }));
    expect(() => new Routing(file).read()).toThrow(CrucibleRoutingError);
    fs.writeFileSync(file, JSON.stringify({ selected: 7 }));
    expect(() => new Routing(file).read()).toThrow(expect.objectContaining({ code: 'corrupt_routing' }));
  });
});

describe('CrucibleRegistryService', () => {
  it('survives a restart: the selection and removals are read back by a new instance over the same dir', () => {
    const dir = tempDir();
    const first = new CrucibleRegistryService(dir);
    first.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    first.add({ name: 'pc', url: 'http://10.0.0.2:7100', token: TOKEN_B });
    first.add({ name: 'droplet', url: 'https://droplet.example:7100', token: TOKEN_B });
    expect(first.selected()).toBe('mac');
    first.select('pc');
    first.remove('mac');

    const second = new CrucibleRegistryService(dir);
    expect(second.list().map((r) => r.name)).toEqual(['pc', 'droplet']);
    expect(second.routingView()).toEqual({
      servers: [{ name: 'pc', selected: true }, { name: 'droplet', selected: false }], selected: 'pc', missing: null,
    });
    expect(second.selected()).toBe('pc');
  });

  it('announces every write on crucible.servers-changed and to in-process listeners', () => {
    const emitted: unknown[] = [];
    const heard: unknown[] = [];
    const service = new CrucibleRegistryService(tempDir(), { emitCrucibleServersChanged: (p: unknown) => emitted.push(p) } as never);
    service.onChange((c) => heard.push(c));
    service.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
    service.add({ name: 'pc', url: 'http://10.0.0.2:7100', token: TOKEN_B });
    service.select('pc');
    service.remove('mac');
    expect(emitted.map((p) => (p as { reason: string }).reason)).toEqual(['added', 'added', 'selected', 'removed']);
    expect(heard).toEqual(emitted);
    expect(JSON.stringify(emitted)).not.toContain(TOKEN_A);
  });
});
