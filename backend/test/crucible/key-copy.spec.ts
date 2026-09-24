/**
 * The one-time copy of Briefcase's own keys onto a Crucible, and the AI pane's
 * model list. The file is deleted only after the server's read-back shows each
 * key's hint, and only when the server is the Crucible on THIS computer.
 * Nothing is ever pushed without the call. (The model options are
 * model-options.spec.ts.)
 */
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleAiService, hintMatches } from '../../src/crucible/llm/crucible-ai.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import type { PairingFileHost } from '../../src/crucible/pairing-file';
import { startFakeCrucible, type FakeCrucible, type FakeCrucibleOptions } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { pairingHost, pairingLineFor } from './helpers';

/** ApiKeysService's two methods the copy uses, over memory: the real one would touch the user's own file. */
class FakeKeys {
  deleted = false;
  constructor(private keys: { claude?: string; openai?: string }) {}
  keysForCopy(): { claude?: string; openai?: string } {
    return { ...this.keys };
  }
  forgetKeysAndDeleteFile(): void {
    this.keys = {};
    this.deleted = true;
  }
}

describe('copying Briefcase\'s keys to a Crucible', () => {
  let fake: FakeCrucible;
  let h: Harness;

  async function setup(keys: { claude?: string; openai?: string }, local: boolean, options: FakeCrucibleOptions = {}) {
    fake = await startFakeCrucible({ name: 'crucible@mac', ...options });
    const host: PairingFileHost = pairingHost(local ? pairingLineFor('crucible@mac', fake.url, fake.token) : null);
    h = harness(host);
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const servers = new CrucibleServersService(h.registry, h.factory);
    const chat = new CrucibleChatService(servers, h.factory, h.probes);
    const apiKeys = new FakeKeys(keys);
    const ai = new CrucibleAiService(servers, h.probes, h.settings, chat, apiKeys as never, host);
    return { ai, apiKeys };
  }
  afterEach(() => fake.close());

  it('local server: writes both keys, confirms both hints on read-back, then deletes the file', async () => {
    const { ai, apiKeys } = await setup({ claude: 'sk-ant-aaaa1111', openai: 'sk-oa-bbbb2222' }, true);
    expect(ai.legacyKeys()).toEqual({ claude: true, openai: true, localServer: 'mac' });
    const outcome = await ai.copyKeys('mac');
    expect(outcome).toMatchObject({ copied: ['anthropic', 'openai'], alreadyThere: [], skipped: [], deletedLocalFile: true, keptBecause: null });
    expect(fake.settingsPuts).toEqual([{ upstreams: { anthropic: { key: 'sk-ant-aaaa1111' }, openai: { key: 'sk-oa-bbbb2222' } } }]);
    expect(apiKeys.deleted).toBe(true);
    // The read-back happened after the write.
    const order = fake.requests.filter((r) => r.path === '/v1/settings').map((r) => r.method);
    expect(order).toEqual(['GET', 'PUT', 'GET']);
  });

  it('a remote server: copies when asked, but Briefcase keeps its own file', async () => {
    const { ai, apiKeys } = await setup({ claude: 'sk-ant-aaaa1111' }, false);
    expect(ai.legacyKeys().localServer).toBeNull();
    const outcome = await ai.copyKeys('mac');
    expect(outcome).toMatchObject({ copied: ['anthropic'], deletedLocalFile: false });
    expect(outcome.keptBecause).toMatch(/not the Crucible on this computer/);
    expect(apiKeys.deleted).toBe(false);
  });

  it('a different key already on the server is left alone, and the file is kept', async () => {
    const { ai, apiKeys } = await setup({ claude: 'sk-ant-aaaa1111' }, true, { upstreams: { anthropic: { key: 'sk-ant-other-9999' } } });
    const outcome = await ai.copyKeys('mac');
    expect(outcome.copied).toEqual([]);
    expect(outcome.skipped).toEqual([{ upstream: 'anthropic', reason: expect.stringMatching(/different Claude key \(…9999\)/) }]);
    expect(fake.settingsPuts).toEqual([]);
    expect(outcome.deletedLocalFile).toBe(false);
    expect(apiKeys.deleted).toBe(false);
  });

  it('the same key already there counts as confirmed: nothing written, file deleted', async () => {
    const { ai, apiKeys } = await setup({ claude: 'sk-ant-aaaa1111' }, true, { upstreams: { anthropic: { key: 'sk-ant-aaaa1111' } } });
    const outcome = await ai.copyKeys('mac');
    expect(outcome).toMatchObject({ copied: [], alreadyThere: ['anthropic'], deletedLocalFile: true });
    expect(fake.settingsPuts).toEqual([]);
    expect(apiKeys.deleted).toBe(true);
  });

  it('a failed write keeps the file', async () => {
    const { ai, apiKeys } = await setup({ openai: 'sk-oa-bbbb2222' }, true, {
      faults: { refuse: [{ match: { method: 'PUT', path: '/v1/settings' }, status: 500, code: 'settings_write_failed' }] },
    });
    await expect(ai.copyKeys('mac')).rejects.toThrow();
    expect(apiKeys.deleted).toBe(false);
  });

  it('nothing to copy, or an unknown server, is refused by name', async () => {
    const { ai } = await setup({}, true);
    await expect(ai.copyKeys('mac')).rejects.toMatchObject({ code: 'nothing_to_copy' });
    await expect(ai.copyKeys('nope')).rejects.toMatchObject({ code: 'unknown_server' });
  });

  it('is never automatic: building the service writes nothing', async () => {
    await setup({ claude: 'sk-ant-aaaa1111' }, true);
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.settingsPuts).toEqual([]);
  });

  it('hintMatches reads the server\'s ellipsis hint', () => {
    expect(hintMatches('…1111', 'sk-ant-aaaa1111')).toBe(true);
    expect(hintMatches('…1111', 'sk-ant-aaaa2222')).toBe(false);
    expect(hintMatches(null, 'x')).toBe(false);
  });
});
