/**
 * The one-time copy of Briefcase's own keys onto a Crucible, and the AI pane's
 * model list. The file is deleted only after the server's read-back shows each
 * key's hint, and only when the server is the Crucible on THIS computer.
 * Nothing is ever pushed without the call.
 */
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleAiService, hintMatches, optionValueOf } from '../../src/crucible/llm/crucible-ai.service';
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

describe('the AI pane\'s model list, from the connected server', () => {
  let fake: FakeCrucible;
  afterEach(() => fake.close());

  it('local catalog models plus configured upstreams, as Briefcase provider:model values', async () => {
    fake = await startFakeCrucible({
      models: [{ id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.8-27b', paramsB: 27, installed: false }, { id: 'cuda-only', paramsB: 7, backendSupported: false }],
      upstreams: { anthropic: { key: 'sk-ant-1234' }, openai: { key: 'sk-oa-5678' } },
      upstreamModels: { anthropic: ['claude-sonnet-5', 'claude-haiku-5'], openai: ['gpt-5.1', 'text-embedding-3-small', 'gpt-4o-realtime-preview', 'o4-mini'] },
    });
    const h = harness();
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const servers = new CrucibleServersService(h.registry, h.factory);
    const ai = new CrucibleAiService(servers, h.probes, h.settings, new CrucibleChatService(servers, h.factory, h.probes), new FakeKeys({}) as never, pairingHost(null));
    const view = await ai.models();
    expect(view.server).toBe('mac');
    expect(view.models.map((m) => [m.value, m.provider, m.installed ?? null])).toEqual([
      ['local:qwen3.5-9b', 'local', true],
      ['local:qwen3.8-27b', 'local', false],
      ['claude:claude-sonnet-5', 'claude', null],
      ['claude:claude-haiku-5', 'claude', null],
      ['openai:gpt-5.1', 'openai', null],
      ['openai:o4-mini', 'openai', null],
    ]);
    expect(view.upstreams?.anthropic).toEqual({ configured: true, keyHint: '…1234' });
    expect(view.analysisDefault).toBe('local:qwen3.5-9b');
    expect(JSON.stringify(view)).not.toContain('sk-ant-1234');
  });

  it('with no server answering, says why instead of listing nothing silently', async () => {
    fake = await startFakeCrucible();
    const h = harness();
    const servers = new CrucibleServersService(h.registry, h.factory);
    const ai = new CrucibleAiService(servers, h.probes, h.settings, new CrucibleChatService(servers, h.factory, h.probes), new FakeKeys({}) as never, pairingHost(null));
    const view = await ai.models();
    expect(view.server).toBeNull();
    expect(view.unavailable).toMatch(/No Crucible server is connected/);
  });

  it('optionValueOf maps Crucible strings back to the stored format', () => {
    expect(optionValueOf('anthropic/claude-x')).toBe('claude:claude-x');
    expect(optionValueOf('ollama/qwen3.5:4b')).toBe('ollama:qwen3.5:4b');
    expect(optionValueOf('qwen3.5-9b')).toBe('local:qwen3.5-9b');
  });
});
