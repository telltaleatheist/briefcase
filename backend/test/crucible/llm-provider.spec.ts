/**
 * AIProviderService.generateText on Crucible (the only road since P7), against
 * the fake: every provider, every generateText caller's call shape, cost and
 * cancel, and a whole analysis run holding one lease.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AIProviderService, type AIGenerateOverrides, type AIProviderConfig } from '../../src/analysis/ai-provider.service';
import { AIAnalysisService } from '../../src/analysis/ai-analysis.service';
import { AnalysisCancelledError } from '../../src/analysis/cancellation';
import type { AITaskKind } from '../../src/analysis/model-utils';
import type { SnapStageResult } from '../../src/scorer/snap-analysis.service';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CLOUD_FORBIDDEN_KEYS } from '../../src/crucible/llm/target';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { tempDir } from './helpers';

const FLAG_SCHEMA = { type: 'object', properties: { flags: { type: 'array' } }, required: ['flags'] };

const savedEnv = { ...process.env };
let fake: FakeCrucible;
let h: Harness;
let chat: CrucibleChatService;
let provider: AIProviderService;

beforeEach(async () => {
  process.env = { ...savedEnv, APPDATA: tempDir('ai-appdata-') };
  fake = await startFakeCrucible({
    // dots-ocr is the live Mac catalog's page reader: 3B, text+image.
    models: [{ id: 'dots-ocr', paramsB: 3, modalities: ['text', 'image'] }, { id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.5-4b', paramsB: 4 }],
    upstreams: { anthropic: { key: 'sk-ant-9999' }, openai: { key: 'sk-oa-8888' }, ollama: { url: 'http://127.0.0.1:11434' } },
  });
  h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  chat = new CrucibleChatService(new CrucibleServersService(h.registry, h.factory), h.factory, h.probes);
  provider = new AIProviderService(chat);
});
afterEach(async () => {
  process.env = savedEnv;
  await fake.close();
});

describe('generateText through Crucible: the provider mapping', () => {
  it.each<[AIProviderConfig['provider'], string, string, boolean]>([
    ['claude', 'claude-sonnet-5', 'anthropic/claude-sonnet-5', false],
    ['openai', 'gpt-5.1', 'openai/gpt-5.1', false],
    // An Ollama model this server has no model of its own for stays on the ollama/ upstream;
    // one it has (qwen3.5-4b is installed here) runs as that local model (ollama-map.ts).
    ['ollama', 'qwen3:14b', 'ollama/qwen3:14b', true],
    ['ollama', 'qwen3.5:4b', 'qwen3.5-4b', true],
    ['local', 'qwen3.5-9b', 'qwen3.5-9b', true],
  ])('%s:%s → %s (temperature sent: %s)', async (prov, model, crucibleModel, sendsTemperature) => {
    // No apiKey and no ollamaEndpoint: the serving Crucible holds both.
    const response = await provider.generateText('prompt', { provider: prov, model }, 'chapter');
    expect(response).toMatchObject({ text: '{"ok":true}', provider: prov, model, inputTokens: 11, outputTokens: 7 });
    const body = fake.chatBodies().at(-1)!;
    expect(body['model']).toBe(crucibleModel);
    if (sendsTemperature) expect(body['temperature']).toBe(0.15);
    else for (const key of CLOUD_FORBIDDEN_KEYS) expect(body).not.toHaveProperty(key);
  });

  it('prices cloud usage, and local/ollama as free', async () => {
    const claude = await provider.generateText('p', { provider: 'claude', model: 'claude-sonnet-4-20250514' }, 'title');
    expect(claude.estimatedCost).toBeCloseTo((11 / 1e6) * 3 + (7 / 1e6) * 15, 10);
    const local = await provider.generateText('p', { provider: 'local', model: 'qwen3.5-9b' }, 'title');
    expect(local.estimatedCost).toBe(0);
  });

  it('local:<m> is a Crucible catalog model now, not the removed llama runtime', async () => {
    await provider.generateText('p', { provider: 'local', model: 'qwen3.5-4b' }, 'tags');
    expect(fake.jobs.map((j) => j.model)).toEqual(['qwen3.5-4b']);
  });
});

/**
 * One row per generateText call site, with the overrides that site passes
 * (grep `generateText(` in analysis/ and library/). What the body must carry
 * for a local model, and what it must NOT carry for Claude.
 */
const CALL_SITES: Array<{ site: string; task?: AITaskKind; overrides: AIGenerateOverrides; local: Record<string, unknown> }> = [
  { site: 'ai-analysis chapter', task: 'chapter', overrides: {}, local: { temperature: 0.15 } },
  { site: 'ai-analysis flag verify', task: 'flags', overrides: { format: FLAG_SCHEMA }, local: { temperature: 0.15, response_format: { type: 'json_schema', json_schema: { name: 'flags', schema: FLAG_SCHEMA } } } },
  { site: 'ai-analysis description body', task: 'description', overrides: { temperature: 0.2 }, local: { temperature: 0.2 } },
  { site: 'ai-analysis tags', task: 'tags', overrides: { format: FLAG_SCHEMA }, local: { temperature: 0.15, response_format: { type: 'json_schema', json_schema: { name: 'tags', schema: FLAG_SCHEMA } } } },
  { site: 'ai-analysis title', task: 'title', overrides: {}, local: { temperature: 0.4 } },
  { site: 'ai-analysis title from webpage', task: 'title', overrides: {}, local: { temperature: 0.4 } },
  { site: 'library insights (no task, no apiKey)', task: undefined, overrides: {}, local: { temperature: 0.2 } },
];

describe('every generateText call site, through Crucible', () => {
  it.each(CALL_SITES)('$site', async ({ task, overrides, local }) => {
    const controller = new AbortController();
    await provider.generateText('p', { provider: 'local', model: 'qwen3.5-9b' }, task, { ...overrides, signal: controller.signal });
    const localBody = fake.chatBodies().at(-1)!;
    expect(localBody).toMatchObject(local);
    expect(localBody).not.toHaveProperty('num_ctx');
    expect(localBody).not.toHaveProperty('options');
    expect(localBody).not.toHaveProperty('chat_template_kwargs');

    await provider.generateText('p', { provider: 'claude', model: 'claude-sonnet-5' }, task, overrides);
    const cloud = fake.chatBodies().at(-1)!;
    expect(Object.keys(cloud).sort()).toEqual(['messages', 'model', 'stream']);
  });

  it('library insights with a cloud provider and no apiKey works (the serving Crucible holds the key)', async () => {
    const response = await provider.generateText('insights', { provider: 'claude', model: 'claude-sonnet-5' });
    expect(response.text).toBe('{"ok":true}');
  });

  it('test connection makes no billed call: an upstream is checked by configuration, a local model by the catalog', async () => {
    await expect(provider.testProvider({ provider: 'claude', model: 'claude-sonnet-5' })).resolves.toEqual({ success: true });
    await expect(provider.testProvider({ provider: 'local', model: 'qwen3.5-9b' })).resolves.toEqual({ success: true });
    await expect(provider.testProvider({ provider: 'local', model: 'nope' })).resolves.toMatchObject({ success: false });
    expect(fake.chatBodies()).toHaveLength(0);
  });

  it('a cancelled call is an AnalysisCancelledError, never a provider failure', async () => {
    fake.inject({ chatDelayMs: 5_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await expect(provider.generateText('p', { provider: 'claude', model: 'c' }, 'chapter', { signal: controller.signal }))
      .rejects.toBeInstanceOf(AnalysisCancelledError);
  });

  it('a server refusal surfaces with its code and sentence', async () => {
    await fake.close();
    fake = await startFakeCrucible({ models: [{ id: 'qwen3.5-9b', paramsB: 9 }] });
    h.registry.remove('mac');
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    await expect(provider.generateText('p', { provider: 'openai', model: 'gpt-5.1' }, 'title')).rejects.toThrow(/upstream_unconfigured/);
  });

  it('a local model\'s analysis window is the context the server states for it, capped at 32K', async () => {
    await expect(provider.crucibleContextWindow('qwen3.5-9b')).resolves.toBe(32768);
  });
});

describe('a whole analysis through Crucible', () => {
  const LINES = [
    'Welcome back everybody, today we are making pasta.',
    'Start with a big pot of well salted water.',
    'Now let us talk about summer travel plans.',
    'We are going to the coast this year.',
  ];
  const SEGMENTS = LINES.map((text, i) => ({ start: i * 30, end: i * 30 + 30, text }));

  /** The snap engine's scorer stage, faked: two chapters, nothing ranked for flags. The LLM stages are what is under test. */
  function analysis(): AIAnalysisService {
    const snap = {
      run: async (): Promise<SnapStageResult> => ({
        transcript: null,
        model: 'qwen3.5-9b',
        timings: { startMs: 0, prepareMs: 0, chaptersMs: 0, flagsMs: 0, totalMs: 0 },
        labelMassGated: { chapters: 0, flags: 0, refine: 0, total: 0 },
        chapters: {
          chapters: [
            { startSeconds: 0, endSeconds: 60, title: 'Pasta', label: 'Pasta', sentenceRange: [0, 2], isAd: false },
            { startSeconds: 60, endSeconds: 120, title: 'Travel', label: 'Travel', sentenceRange: [2, 4], isAd: false },
          ],
          outline: ['Pasta', 'Travel'], chunks: [], seams: [], timings: { outlineMs: 0, assignMs: 0, adsMs: 0, totalMs: 0 },
        },
        chapterTree: null,
        flags: { windows: [], overflow: [], spans: [], ratingMap: {} as never, plan: [], notes: [], stats: { units: 4, spans: 0, verifyBudget: 0 } as never } as never,
      }),
    };
    return new AIAnalysisService(provider, snap as never, undefined);
  }

  function options(model = 'qwen3.5-9b') {
    const out = path.join(tempDir('analysis-out-'), 'analysis.txt');
    return { provider: 'local' as const, model, transcript: LINES.join(' '), segments: SEGMENTS, outputFile: out, categories: [{ name: 'misinformation' } as never] };
  }

  it('loads once, holds one lease for the whole run, and releases it at the end', async () => {
    await fake.close();
    fake = await startFakeCrucible({
      models: [{ id: 'qwen3.5-9b', paramsB: 9 }],
      chatReplies: { '*': '{"title":"A chapter","summary":"About it.","verdict":"skip","flags":[],"people":[],"topics":["cooking"],"hook":"Hook.","body":"Body.","description":"Desc.","tags":["x"]}' },
    });
    h.registry.remove('mac');
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const result = await analysis().analyzeTranscript(options());
    expect(result.chapters.length).toBeGreaterThan(0);
    expect(fake.jobs.filter((j) => j.type === 'load-model')).toHaveLength(1);
    expect(fake.leases.taken).toHaveLength(1);
    expect(fake.leases.released).toEqual([fake.leases.taken[0].leaseId]);
    expect(fake.chatBodies().length).toBeGreaterThan(1);
    expect(fake.chatBodies().every((b) => b['model'] === 'qwen3.5-9b')).toBe(true);
  });

  it('REGRESSION (the version gate): an ollama/ model through a Crucible older than 1.0.24 is chunked for Ollama\'s default context (it can\'t send num_ctx), said once', async () => {
    await fake.close();
    fake = await startFakeCrucible({
      version: '1.0.23',
      models: [{ id: 'qwen3.5-9b', paramsB: 9 }],
      upstreams: { ollama: { url: 'http://127.0.0.1:11434' } },
      chatReplies: { '*': '{"title":"A chapter","summary":"About it.","verdict":"skip","flags":[],"people":[],"topics":["cooking"],"hook":"Hook.","body":"Body.","description":"Desc.","tags":["x"]}' },
    });
    h.registry.remove('mac');
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const logged: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(function (this: unknown, message: unknown) { logged.push(String(message)); });
    const warned: string[] = [];
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(function (this: unknown, message: unknown) { warned.push(String(message)); });
    try {
      const service = analysis();
      await service.analyzeTranscript({ ...options('qwen3:14b'), provider: 'ollama' as never });
      await service.analyzeTranscript({ ...options('qwen3:14b'), provider: 'ollama' as never });
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
    const limits = logged.filter((m) => m.startsWith('[Model Limits] effective ctx='));
    expect(limits).toHaveLength(2);
    expect(limits.every((m) => m.startsWith('[Model Limits] effective ctx=4096:'))).toBe(true);
    expect(fake.chatBodies().every((b) => b['model'] === 'ollama/qwen3:14b')).toBe(true);
    expect(fake.chatBodies().some((b) => 'num_ctx' in b || 'options' in b || 'context_tokens' in b)).toBe(false);
    // Said once, not per run or per chunk.
    expect([...logged, ...warned].filter((m) => /Ollama's default context/.test(m))).toHaveLength(1);
  });

  it('an ollama: choice the server has a model of its own for runs AS that model: loaded, leased, sized at its context, the stored config untouched', async () => {
    await fake.close();
    // The Mac's real catalog: the 27B 8-bit is served at 12K, the 4-bit at 98K, and dots-ocr reads pages.
    fake = await startFakeCrucible({
      models: [
        { id: 'dots-ocr', paramsB: 3, modalities: ['text', 'image'] },
        { id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 },
        { id: 'qwen3.8-27b-4bit', paramsB: 27, contextDefault: 98304, maxModelLen: 98304 },
        { id: 'qwen3.8-27b-8bit', paramsB: 27, contextDefault: 12288, maxModelLen: 12288 },
      ],
      upstreams: { ollama: { url: 'http://127.0.0.1:11434' } },
      chatReplies: { '*': '{"title":"A chapter","summary":"About it.","verdict":"skip","flags":[],"people":[],"topics":["cooking"],"hook":"Hook.","body":"Body.","description":"Desc.","tags":["x"]}' },
    });
    h.registry.remove('mac');
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const logged: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(function (this: unknown, message: unknown) { logged.push(String(message)); });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(function (this: unknown, message: unknown) { logged.push(String(message)); });
    const opts = { ...options('qwen3.8:27b'), provider: 'ollama' as never };
    try {
      const service = analysis();
      await service.analyzeTranscript(opts);
      await service.analyzeTranscript(opts);
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(fake.chatBodies().length).toBeGreaterThan(1);
    // 1.0.24: the host's ceiling says the 8-bit serves 32K when loaded at it, so
    // precision wins (ollama-map.ts rule 4) and the load states the context.
    expect(fake.chatBodies().every((b) => b['model'] === 'qwen3.8-27b-8bit')).toBe(true);
    // Loaded once (the second run finds it resident at 32K), leased and released per run.
    expect(fake.jobs.filter((j) => j.type === 'load-model').map((j) => [j.model, j.params['context']])).toEqual([['qwen3.8-27b-8bit', 32768]]);
    expect(fake.leases.taken).toHaveLength(2);
    expect(fake.leases.released).toEqual(fake.leases.taken.map((l) => l.leaseId));
    // Sized at the local model's context (capped at the 32K analysis window), not Ollama's 4K.
    const limits = logged.filter((m) => m.startsWith('[Model Limits] effective ctx='));
    expect(limits).toHaveLength(2);
    expect(limits.every((m) => m.startsWith('[Model Limits] effective ctx=32768:'))).toBe(true);
    expect(logged.some((m) => /Ollama's default context/.test(m))).toBe(false);
    // Said once per model, not per call or per run.
    expect(logged.filter((m) => /ollama\/qwen3\.8:27b runs as qwen3\.8-27b-8bit, this server's own copy of that model, loaded at 32768 tokens/.test(m))).toHaveLength(1);
    // The choice itself is unchanged: still ollama:qwen3.8:27b.
    expect(opts).toMatchObject({ provider: 'ollama', model: 'qwen3.8:27b' });
  });

  it('without a host ceiling that reaches 32K, the Mac keeps the 4-bit at its served 98K', async () => {
    await fake.close();
    fake = await startFakeCrucible({
      contextCeilings: { 'qwen3.8-27b-8bit': 12288, 'qwen3.8-27b-4bit': 98304, 'qwen3.5-9b': 16384 },
      models: [
        { id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 },
        { id: 'qwen3.8-27b-4bit', paramsB: 27, contextDefault: 98304, maxModelLen: 98304 },
        { id: 'qwen3.8-27b-8bit', paramsB: 27, contextDefault: 12288, maxModelLen: 12288 },
      ],
      upstreams: { ollama: { url: 'http://127.0.0.1:11434' } },
      chatReplies: { '*': '{"title":"A chapter","summary":"About it.","verdict":"skip","flags":[],"people":[],"topics":["cooking"],"hook":"Hook.","body":"Body.","description":"Desc.","tags":["x"]}' },
    });
    h.registry.remove('mac');
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await analysis().analyzeTranscript({ ...options('qwen3.8:27b'), provider: 'ollama' as never });
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(fake.chatBodies().every((b) => b['model'] === 'qwen3.8-27b-4bit')).toBe(true);
    expect(fake.jobs.filter((j) => j.type === 'load-model').map((j) => [j.model, j.params['context']])).toEqual([['qwen3.8-27b-4bit', undefined]]);
  });

  it('an ollama: choice with no match on the server stays on the ollama/ upstream, sized for Ollama, the window sent as context_tokens (1.0.24)', async () => {
    await fake.close();
    fake = await startFakeCrucible({
      // The 27B is known but not downloaded here: no match.
      models: [{ id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.8-27b-4bit', paramsB: 27, installed: false, contextDefault: 98304 }],
      upstreams: { ollama: { url: 'http://127.0.0.1:11434' } },
      chatReplies: { '*': '{"title":"A chapter","summary":"About it.","verdict":"skip","flags":[],"people":[],"topics":["cooking"],"hook":"Hook.","body":"Body.","description":"Desc.","tags":["x"]}' },
    });
    h.registry.remove('mac');
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const logged: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(function (this: unknown, message: unknown) { logged.push(String(message)); });
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(function (this: unknown, message: unknown) { logged.push(String(message)); });
    try {
      await analysis().analyzeTranscript({ ...options('qwen3.8:27b'), provider: 'ollama' as never });
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
    expect(fake.chatBodies().every((b) => b['model'] === 'ollama/qwen3.8:27b')).toBe(true);
    expect(fake.jobs.filter((j) => j.type === 'load-model')).toHaveLength(0);
    const limits = logged.filter((m) => m.startsWith('[Model Limits] effective ctx='));
    expect(limits).toHaveLength(1);
    // numCtxMaxForModel('qwen3.8:27b'): the window requested as context_tokens.
    expect(limits[0]).toMatch(/^\[Model Limits\] effective ctx=12288:/);
    expect(logged.some((m) => /Ollama's default context/.test(m))).toBe(false);
    // Every call states its window, bucketed and capped.
    const windows = fake.chatBodies().map((b) => b['context_tokens']);
    expect(windows.every((w) => typeof w === 'number' && w >= 4096 && w <= 12288 && (w as number) % 4096 === 0)).toBe(true);
    // The server's X-Crucible-Context is logged once for the model.
    expect(logged.filter((m) => /ollama\/qwen3\.8:27b runs with .*"source":"request"/.test(m))).toHaveLength(1);
    expect(logged.filter((m) => /no Crucible server has that model of its own/.test(m))).toHaveLength(1);
  });

  it('zero successful chapters throws, never completes empty, and still releases the lease', async () => {
    fake.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 500, code: 'engine_failed' }];
    await expect(analysis().analyzeTranscript(options())).rejects.toThrow(/engine_failed/);
    expect(fake.leases.taken.length).toBeGreaterThan(0);
    expect(fake.leases.released).toEqual(fake.leases.taken.map((l) => l.leaseId));
    expect(fs.existsSync(path.join(process.env.APPDATA!, 'briefcase', 'api-keys.json'))).toBe(false);
  }, 30_000);
});
