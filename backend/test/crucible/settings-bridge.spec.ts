import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { patchOf } from '../../src/crucible/settings-bridge.service';
import { harness, type Harness } from './harness';

describe('the settings bridge: one server\'s own settings, keys write-only', () => {
  let fake: FakeCrucible;
  let h: Harness;
  beforeEach(async () => {
    fake = await startFakeCrucible({ upstreams: { anthropic: { key: 'sk-ant-secret-1111' } } });
    h = harness();
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  });
  afterEach(() => fake.close());

  it('reads the document with hints, never keys', async () => {
    const view = await h.settings.get('mac');
    expect(view.upstreams.anthropic).toEqual({ configured: true, keyHint: '…1111' });
    expect(view.upstreams.openai).toEqual({ configured: false, keyHint: null });
    expect(view.routes['analysis']).toEqual({ route: 'local', model: 'qwen3.5-9b' });
    expect(JSON.stringify(view)).not.toContain('sk-ant-secret-1111');
  });

  it('writes a key to THAT server and answers with its hint', async () => {
    const view = await h.settings.put('mac', { upstreams: { openai: { key: 'sk-openai-2222' } }, routes: { analysis: 'openai/gpt-x' } });
    expect(fake.settingsPuts).toEqual([{ upstreams: { openai: { key: 'sk-openai-2222' } }, routes: { analysis: 'openai/gpt-x' } }]);
    expect(view.upstreams.openai).toEqual({ configured: true, keyHint: '…2222' });
    expect(view.routes['analysis']).toEqual({ route: 'upstream', model: 'openai/gpt-x' });
    expect(JSON.stringify(view)).not.toContain('sk-openai-2222');
  });

  it('tests an upstream through the server, and reports an unconfigured one as an answer', async () => {
    expect(await h.settings.testUpstream('mac', 'anthropic', {})).toEqual({ ok: true, models: ['anthropic-model-a', 'anthropic-model-b'] });
    expect(await h.settings.testUpstream('mac', 'openai', {})).toMatchObject({ ok: false, code: 'upstream_unconfigured' });
    expect(await h.settings.testUpstream('mac', 'openai', { key: 'sk-try' })).toMatchObject({ ok: true });
  });

  it('refuses a patch it does not understand, and an upstream that does not exist', async () => {
    expect(() => patchOf({ desktopAllowanceBytes: 1 })).toThrow(/not a setting Briefcase changes/);
    expect(() => patchOf({ upstreams: { gemini: { key: 'x' } } })).toThrow(/not an upstream/);
    await expect(h.settings.testUpstream('mac', 'gemini', {})).rejects.toThrow(/not an upstream/);
    expect(fake.settingsPuts).toEqual([]);
  });
});
