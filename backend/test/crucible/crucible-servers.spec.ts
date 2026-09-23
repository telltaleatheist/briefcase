/**
 * The CrucibleServersService seam, whose three signatures other branches
 * build on: list() with no token, get() with one, clientFor() named
 * 'briefcase' and bound to the engine.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleClient } from '@crucible/client';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { REGISTRY_FILE } from '../../src/crucible/registry';
import { harness } from './harness';

describe('CrucibleServersService', () => {
  let fake: FakeCrucible;
  beforeEach(async () => {
    fake = await startFakeCrucible();
  });
  afterEach(() => fake.close());

  it('list(): {name, url, added} and nothing else', () => {
    const h = harness();
    const servers = new CrucibleServersService(h.registry, h.factory);
    servers.add({ name: 'mac', url: fake.url, token: fake.token });
    const listed = servers.list();
    expect(listed).toEqual([{ name: 'mac', url: fake.url, added: expect.any(String) }]);
    expect(Object.keys(listed[0]!).sort()).toEqual(['added', 'name', 'url']);
  });

  it('get(name): {name, url, token}, and refuses an unknown name by code', () => {
    const h = harness();
    const servers = new CrucibleServersService(h.registry, h.factory);
    servers.add({ name: 'mac', url: fake.url, token: fake.token });
    expect(servers.get('mac')).toEqual({ name: 'mac', url: fake.url, token: fake.token });
    expect(() => servers.get('pc')).toThrow(expect.objectContaining({ code: 'unknown_server' }));
  });

  it('clientFor(name): a CrucibleClient that names itself briefcase', async () => {
    const h = harness();
    const servers = new CrucibleServersService(h.registry, h.factory);
    servers.add({ name: 'mac', url: fake.url, token: fake.token });
    const client = await servers.clientFor('mac');
    expect(client).toBeInstanceOf(CrucibleClient);
    await client.health();
    expect(fake.requestsTo('/v1/health')[0]!.headers['x-crucible-client']).toBe('briefcase');
  });

  it('keeps BookForge\'s file: <userData>/crucible-servers.json, {servers: [{name, url, token, added}]}', () => {
    const h = harness();
    const servers = new CrucibleServersService(h.registry, h.factory);
    servers.add({ name: 'mac', url: fake.url, token: fake.token });
    servers.pause('mac');
    const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, REGISTRY_FILE), 'utf8'));
    expect(Object.keys(onDisk)).toEqual(['servers']);
    expect(Object.keys(onDisk.servers[0]).sort()).toEqual(['added', 'name', 'token', 'url']);
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'crucible-routing.json'), 'utf8'))).toEqual({ order: [], disabled: ['mac'] });
    expect(servers.routing().ranked).toEqual([{ name: 'mac', enabled: false }]);
    servers.resume('mac');
    expect(servers.ranked()).toEqual([{ name: 'mac', enabled: true }]);
  });
});
