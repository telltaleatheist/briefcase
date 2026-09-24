/**
 * THE ONE SOURCE OF ANALYSIS-MODEL OPTIONS (model-options.ts): what a picker
 * lists, grouped as the server presents it, and what a stored choice is
 * among the options. Pinned as pure functions against the Mac Studio's real
 * answers (Crucible 1.0.27, read 2026-09-24: `GET /v1/models`,
 * `local_model_choices.analysis`, the `analysis` capability row, no upstream
 * configured), and end to end through CrucibleAiService against the fake.
 */
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleAiService } from '../../src/crucible/llm/crucible-ai.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import {
  buildAnalysisOptions,
  groupLabel,
  isPickableUpstreamModel,
  optionValueOf,
  optionValues,
  resolveStoredModel,
  type AnalysisOptionFacts,
  type OptionModel,
} from '../../src/crucible/llm/model-options';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness } from './harness';
import { pairingHost, pairingLineFor } from './helpers';

function row(id: string, paramsB: number | null, extra: Partial<OptionModel> = {}): OptionModel {
  return {
    id, family: id.split('-')[0], paramsB, modalities: ['text'], backendSupported: true, installed: true,
    contextDefault: 16384, maxModelLen: 16384, resident: false, loadable: true, reason: null, weightsOf: null, ...extra,
  };
}

/** The Mac Studio's /v1/models, 1.0.27, as served. */
const MAC_MODELS: OptionModel[] = [
  row('dots-ocr', 3, { modalities: ['text', 'image'], contextDefault: 32768, maxModelLen: 32768 }),
  row('qwen3.5-0.8b', 0.8, { modalities: ['text', 'image'], contextDefault: 8192, maxModelLen: 8192 }),
  row('qwen3.5-2b', 2, { modalities: ['text', 'image'] }),
  row('qwen3.5-4b', 4, { modalities: ['text', 'image'] }),
  row('qwen3.5-9b', 9),
  row('qwen3.5-9b-vl', 9, {
    modalities: ['text', 'image'], backendSupported: false, installed: false, loadable: false, weightsOf: 'qwen3.5-9b', maxModelLen: null,
    reason: "qwen3.5-9b-vl.toml has no mlx-darwin block; it declares ['cuda-linux', 'llama-windows']",
  }),
  row('qwen3.8-27b-4bit', 27, { contextDefault: 98304, maxModelLen: 98304 }),
  row('qwen3.8-27b-4bit-vl', 27, {
    modalities: ['text', 'image'], backendSupported: false, installed: false, loadable: false, weightsOf: 'qwen3.8-27b-4bit', maxModelLen: null,
    reason: "qwen3.8-27b-4bit-vl.toml has no mlx-darwin block; it declares ['cuda-linux', 'llama-windows']",
  }),
  row('qwen3.8-27b-8bit', 27, { contextDefault: 12288, maxModelLen: 12288 }),
];

function macFacts(extra: Partial<AnalysisOptionFacts> = {}): AnalysisOptionFacts {
  return {
    server: 'owens-mac-studio',
    local: true,
    models: MAC_MODELS,
    classCandidates: ['qwen3.8-27b-8bit', 'qwen3.8-27b-4bit', 'qwen3.5-9b'],
    pageReaders: ['dots-ocr'],
    ceilings: new Map([['qwen3.8-27b-8bit', 131072], ['qwen3.8-27b-4bit', 131072], ['qwen3.5-9b', 131072]]),
    analysis: { selected: 'qwen3.8-27b-8bit', route: 'local', enabled: true },
    upstreams: { anthropic: { configured: false }, openai: { configured: false }, ollama: { configured: false } },
    listings: {},
    ...extra,
  };
}

/** A PC on the LAN with every upstream configured. */
function everyUpstream(extra: Partial<AnalysisOptionFacts> = {}): AnalysisOptionFacts {
  return macFacts({
    server: 'owens-pc',
    local: false,
    upstreams: { anthropic: { configured: true }, openai: { configured: true }, ollama: { configured: true } },
    listings: {
      anthropic: { ids: ['claude-sonnet-5', 'claude-haiku-5'], error: null },
      openai: { ids: ['gpt-5.1', 'text-embedding-3-small', 'gpt-4o-realtime-preview', 'o4-mini'], error: null },
      ollama: { ids: ['qwen3:14b', 'nomic-embed-text:latest', 'gemma3:27b'], error: null },
    },
    ...extra,
  });
}

const resolve = (value: string, facts: AnalysisOptionFacts) => resolveStoredModel(value, facts, optionValues(buildAnalysisOptions(facts).groups));

describe('the analysis options a server offers', () => {
  it('a server with no upstream (the Mac as it is): only its analysis candidates that can load, under "On this Crucible"', () => {
    const built = buildAnalysisOptions(macFacts());
    expect(built.groups.map((g) => g.label)).toEqual(['On this Crucible']);
    expect(built.groups[0].options.map((o) => [o.value, o.detail])).toEqual([
      ['local:qwen3.8-27b-8bit', "27B, Crucible's pick for analysis"],
      ['local:qwen3.8-27b-4bit', '27B'],
      ['local:qwen3.5-9b', '9B'],
    ]);
    expect(built.analysisDefault).toBe('local:qwen3.8-27b-8bit');
    // No Claude, OpenAI or Ollama group at all: nothing the server does not offer.
    expect(JSON.stringify(built)).not.toMatch(/claude|openai|ollama/i);
  });

  it('a candidate the server cannot load is left out; a resident one says so', () => {
    const facts = macFacts({
      classCandidates: ['qwen3.8-27b-8bit', 'qwen3.5-9b-vl', 'qwen3.5-9b'],
      models: MAC_MODELS.map((m) => (m.id === 'qwen3.5-9b' ? { ...m, resident: true, loadable: false } : m)),
    });
    const options = buildAnalysisOptions(facts).groups[0].options;
    expect(options.map((o) => o.value)).toEqual(['local:qwen3.8-27b-8bit', 'local:qwen3.5-9b']);
    expect(options[1].detail).toBe('9B, loaded now');
  });

  it('a server with every upstream: its own models, then Claude, OpenAI and Ollama via Crucible, named for the server when it is not this computer', () => {
    const built = buildAnalysisOptions(everyUpstream());
    expect(built.groups.map((g) => [g.kind, g.label, g.options.map((o) => o.value)])).toEqual([
      ['server', 'On owens-pc', ['local:qwen3.8-27b-8bit', 'local:qwen3.8-27b-4bit', 'local:qwen3.5-9b']],
      ['anthropic', 'Claude via Crucible on owens-pc', ['claude:claude-sonnet-5', 'claude:claude-haiku-5']],
      ['openai', 'OpenAI via Crucible on owens-pc', ['openai:gpt-5.1', 'openai:o4-mini']],
      ['ollama', 'Ollama via Crucible on owens-pc', ['ollama:qwen3:14b', 'ollama:gemma3:27b']],
    ]);
    // Upstream models state no size: none is invented.
    expect(built.groups[1].options[0]).toMatchObject({ sizeB: null, resident: null, detail: '' });
  });

  it('an upstream routed as the analysis pick is marked; a listing failure is the group\'s error, not an empty silence', () => {
    const built = buildAnalysisOptions(everyUpstream({
      analysis: { selected: 'anthropic/claude-sonnet-5', route: 'upstream', enabled: true },
      listings: { anthropic: { ids: ['claude-sonnet-5'], error: null }, openai: { ids: null, error: 'The key was refused (401).' }, ollama: { ids: [], error: null } },
    }));
    expect(built.analysisDefault).toBe('claude:claude-sonnet-5');
    expect(built.groups[1].options[0]).toMatchObject({ serverChoice: true, detail: "Crucible's pick for analysis" });
    expect(built.groups[2]).toMatchObject({ kind: 'openai', options: [], error: 'The key was refused (401).' });
  });

  it('an unconfigured or unoffered upstream adds nothing', () => {
    const built = buildAnalysisOptions(macFacts({
      upstreams: { anthropic: { configured: true }, openai: null, ollama: { configured: false } },
      listings: { anthropic: { ids: ['claude-sonnet-5'], error: null } },
    }));
    expect(built.groups.map((g) => g.kind)).toEqual(['server', 'anthropic']);
  });

  it('a server that states no candidates: its loadable text models that are not page readers, with unstated sizes shown as unknown', () => {
    const built = buildAnalysisOptions(macFacts({
      classCandidates: null,
      models: MAC_MODELS.map((m) => ({ ...m, paramsB: null })),
    }));
    expect(built.groups[0].options.map((o) => o.value)).toEqual([
      'local:qwen3.5-0.8b', 'local:qwen3.5-2b', 'local:qwen3.5-4b', 'local:qwen3.5-9b', 'local:qwen3.8-27b-4bit', 'local:qwen3.8-27b-8bit',
    ]);
    expect(built.groups[0].options[0].detail).toBe('size unknown');
  });

  it('labels, values and the upstream filter', () => {
    expect(groupLabel('server', 'mac', true)).toBe('On this Crucible');
    expect(groupLabel('ollama', 'mac', true)).toBe('Ollama via Crucible');
    expect(optionValueOf('anthropic/claude-x')).toBe('claude:claude-x');
    expect(optionValueOf('ollama/qwen3.5:4b')).toBe('ollama:qwen3.5:4b');
    expect(optionValueOf('qwen3.5-9b')).toBe('local:qwen3.5-9b');
    expect(isPickableUpstreamModel('openai', 'text-embedding-3-small')).toBe(false);
    expect(isPickableUpstreamModel('ollama', 'nomic-embed-text:latest')).toBe(false);
  });
});

describe('what a stored choice is among the options', () => {
  it('an option as stored is itself', () => {
    expect(resolve('local:qwen3.5-9b', macFacts())).toEqual({ value: 'local:qwen3.5-9b', option: 'local:qwen3.5-9b', note: null, unavailable: null });
  });

  it('a legacy Ollama tag is the server\'s own copy of that model, the one the analysis runs (ollama-map)', () => {
    expect(resolve('ollama:qwen3.8:27b', macFacts())).toEqual({
      value: 'ollama:qwen3.8:27b',
      option: 'local:qwen3.8-27b-8bit',
      note: "Saved as qwen3.8:27b (Ollama). It runs as qwen3.8-27b-8bit, owens-mac-studio's own copy of that model.",
      unavailable: null,
    });
    expect(resolve('ollama:qwen3.5:9b', macFacts()).option).toBe('local:qwen3.5-9b');
  });

  it('an Ollama tag with no copy of its own stays on the server\'s Ollama when it lists it', () => {
    expect(resolve('ollama:qwen3:14b', everyUpstream())).toMatchObject({ option: 'ollama:qwen3:14b', unavailable: null });
  });

  it('the other legacy spellings are read the way the analysis reads them', () => {
    const facts = everyUpstream();
    expect(resolve('anthropic/claude-sonnet-5', facts)).toMatchObject({ option: 'claude:claude-sonnet-5', note: 'Saved as anthropic/claude-sonnet-5.' });
    expect(resolve('crucible:qwen3.5-9b', facts)).toMatchObject({ option: 'local:qwen3.5-9b' });
    expect(resolve('qwen3.5-9b', facts)).toMatchObject({ option: 'local:qwen3.5-9b' });
    expect(resolve('', facts)).toEqual({ value: '', option: null, note: null, unavailable: null });
  });

  it('a saved value the server offers nothing for is unavailable, with the reason, never another model', () => {
    const mac = macFacts();
    expect(resolve('claude:claude-sonnet-5', mac)).toMatchObject({
      option: null, unavailable: 'Claude is not set up on owens-mac-studio. Add it in Settings › AI Analysis, or pick another model.',
    });
    expect(resolve('ollama:qwen3:14b', mac)).toMatchObject({
      option: null, unavailable: 'owens-mac-studio has no model of its own for qwen3:14b, and Ollama is not set up on it. Pick one of its models.',
    });
    // The retired built-in llama runtime's models, as `local:` still spells them.
    expect(resolve('local:cogito-v1-preview-llama-8b', mac)).toMatchObject({
      option: null, unavailable: 'owens-mac-studio has no model called cogito-v1-preview-llama-8b. Pick one it offers.',
    });
    expect(resolve('local:qwen3.5-9b-vl', mac).unavailable).toBe(
      "qwen3.5-9b-vl can't run on owens-mac-studio: qwen3.5-9b-vl.toml has no mlx-darwin block; it declares ['cuda-linux', 'llama-windows']",
    );
    expect(resolve('local:qwen3.5-4b', mac).unavailable).toBe('owens-mac-studio does not offer qwen3.5-4b for analysis. Pick one it offers.');
    expect(resolve('openai:gpt-4o', everyUpstream()).unavailable).toBe("owens-pc's OpenAI does not list gpt-4o. Pick one it lists.");
    // A provider Briefcase does not know is read as a model name, which the server does not have.
    expect(resolve('gemini:pro', mac).unavailable).toBe('owens-mac-studio has no model called gemini:pro. Pick one it offers.');
  });
});

describe('CrucibleAiService.models, end to end against the fake', () => {
  let fake: FakeCrucible;
  afterEach(() => fake?.close());

  async function service(options: Parameters<typeof startFakeCrucible>[0], local = true) {
    fake = await startFakeCrucible({ name: 'crucible@mac', ...options });
    const host = pairingHost(local ? pairingLineFor('crucible@mac', fake.url, fake.token) : null);
    const h = harness(host);
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const servers = new CrucibleServersService(h.registry, h.factory);
    return new CrucibleAiService(servers, h.probes, h.settings, new CrucibleChatService(servers, h.factory, h.probes), { keysForCopy: () => ({}) } as never, host);
  }

  it('no upstream configured: the server\'s own models only, and a Claude choice resolved as unavailable', async () => {
    const ai = await service({
      models: [{ id: 'dots-ocr', paramsB: 3, modalities: ['text', 'image'] }, { id: 'qwen3.5-9b', paramsB: 9 }, { id: 'cuda-only', paramsB: 7, backendSupported: false }],
    });
    const view = await ai.models(undefined, ['claude:claude-sonnet-5', 'local:qwen3.5-9b']);
    expect(view).toMatchObject({ server: 'mac', local: true, unavailable: null, analysisDefault: 'local:qwen3.5-9b' });
    expect(view.groups.map((g) => [g.label, g.options.map((o) => o.value)])).toEqual([['On this Crucible', ['local:qwen3.5-9b']]]);
    expect(view.resolved.map((r) => [r.value, r.option, r.unavailable !== null])).toEqual([
      ['claude:claude-sonnet-5', null, true],
      ['local:qwen3.5-9b', 'local:qwen3.5-9b', false],
    ]);
  });

  it('every upstream configured, on a server that is not this computer\'s: every group, named for it; no key crosses', async () => {
    const ai = await service({
      models: [{ id: 'qwen3.5-9b', paramsB: 9 }],
      upstreams: { anthropic: { key: 'sk-ant-1234' }, openai: { key: 'sk-oa-5678' }, ollama: { url: 'http://127.0.0.1:11434' } },
      upstreamModels: { anthropic: ['claude-sonnet-5'], openai: ['gpt-5.1', 'text-embedding-3-small'], ollama: ['qwen3:14b'] },
    }, false);
    const view = await ai.models(undefined, ['ollama:qwen3.5:9b']);
    expect(view.local).toBe(false);
    expect(view.groups.map((g) => [g.label, g.options.map((o) => o.value)])).toEqual([
      ['On mac', ['local:qwen3.5-9b']],
      ['Claude via Crucible on mac', ['claude:claude-sonnet-5']],
      ['OpenAI via Crucible on mac', ['openai:gpt-5.1']],
      ['Ollama via Crucible on mac', ['ollama:qwen3:14b']],
    ]);
    expect(view.resolved[0]).toMatchObject({ value: 'ollama:qwen3.5:9b', option: 'local:qwen3.5-9b' });
    expect(view.upstreams?.anthropic).toEqual({ configured: true, keyHint: '…1234' });
    expect(JSON.stringify(view)).not.toContain('sk-ant-1234');
  });

  it('only the analysis class\'s candidates are offered, as the server names them', async () => {
    const ai = await service({
      models: [{ id: 'qwen3.5-2b', paramsB: 2 }, { id: 'qwen3.5-9b', paramsB: 9 }],
      localModelChoices: { analysis: ['qwen3.5-9b'] },
    });
    const view = await ai.models(undefined, ['local:qwen3.5-2b']);
    expect(view.groups[0].options.map((o) => o.value)).toEqual(['local:qwen3.5-9b']);
    expect(view.resolved[0].unavailable).toBe('mac does not offer qwen3.5-2b for analysis. Pick one it offers.');
  });

  it('with no server answering: no options, the reason, and every asked value unavailable with it', async () => {
    fake = await startFakeCrucible();
    const h = harness();
    const servers = new CrucibleServersService(h.registry, h.factory);
    const ai = new CrucibleAiService(servers, h.probes, h.settings, new CrucibleChatService(servers, h.factory, h.probes), { keysForCopy: () => ({}) } as never, pairingHost(null));
    const view = await ai.models(undefined, ['local:qwen3.5-9b']);
    expect(view.server).toBeNull();
    expect(view.groups).toEqual([]);
    expect(view.unavailable).toMatch(/No Crucible server is connected/);
    expect(view.resolved).toEqual([{ value: 'local:qwen3.5-9b', option: null, note: null, unavailable: view.unavailable }]);
  });
});
