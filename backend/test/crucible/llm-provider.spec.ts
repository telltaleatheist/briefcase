/**
 * AIProviderService.generateText on the Crucible road, against the fake: every
 * provider, every generateText caller's call shape, cost and cancel, a whole
 * analysis run holding one lease, and the direct road left exactly as it was.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AIProviderService, type AIGenerateOverrides, type AIProviderConfig } from '../../src/analysis/ai-provider.service';
import { AIAnalysisService } from '../../src/analysis/ai-analysis.service';
import { AnalysisCancelledError } from '../../src/analysis/cancellation';
import type { AITaskKind } from '../../src/analysis/model-utils';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { AI_VIA_ENV } from '../../src/crucible/llm/ai-via';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CLOUD_FORBIDDEN_KEYS } from '../../src/crucible/llm/target';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { tempDir } from './helpers';

const FLAG_SCHEMA = { type: 'object', properties: { flags: { type: 'array' } }, required: ['flags'] };
const noLlama = { isAvailable: () => false } as never;

const savedEnv = { ...process.env };
let fake: FakeCrucible;
let h: Harness;
let chat: CrucibleChatService;
let provider: AIProviderService;

beforeEach(async () => {
  process.env = { ...savedEnv, APPDATA: tempDir('ai-appdata-'), [AI_VIA_ENV]: 'crucible', BRIEFCASE_PLACE_MODEL: '' };
  fake = await startFakeCrucible({
    // dots-ocr is the live Mac catalog's page reader: 3B, text+image. It must never be picked for placement.
    models: [{ id: 'dots-ocr', paramsB: 3, modalities: ['text', 'image'] }, { id: 'qwen3.5-9b', paramsB: 9 }, { id: 'qwen3.5-4b', paramsB: 4 }],
    upstreams: { anthropic: { key: 'sk-ant-9999' }, openai: { key: 'sk-oa-8888' }, ollama: { url: 'http://127.0.0.1:11434' } },
  });
  h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  chat = new CrucibleChatService(new CrucibleServersService(h.registry, h.factory), h.factory, h.probes);
  provider = new AIProviderService(noLlama, chat);
});
afterEach(async () => {
  process.env = savedEnv;
  await fake.close();
});

describe('generateText through Crucible: the provider mapping', () => {
  it.each<[AIProviderConfig['provider'], string, string, boolean]>([
    ['claude', 'claude-sonnet-5', 'anthropic/claude-sonnet-5', false],
    ['openai', 'gpt-5.1', 'openai/gpt-5.1', false],
    ['ollama', 'qwen3.5:4b', 'ollama/qwen3.5:4b', true],
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

  it('prices cloud usage as the direct road does, and local/ollama as free', async () => {
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
  { site: 'chapter-detection boundary placement', task: 'boundary', overrides: { numCtx: 8192, format: 'json' }, local: { temperature: 0, response_format: { type: 'json_object' } } },
  { site: 'ai-analysis chapter', task: 'chapter', overrides: {}, local: { temperature: 0.15 } },
  { site: 'ai-analysis flags discovery', task: 'flags', overrides: { format: FLAG_SCHEMA, numCtx: 16384 }, local: { temperature: 0.15, response_format: { type: 'json_schema', json_schema: { name: 'flags', schema: FLAG_SCHEMA } } } },
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

  it('library insights with a cloud provider and no apiKey works (it failed on the direct road)', async () => {
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

  it('the small-placement model comes from the Crucible catalog', async () => {
    await expect(provider.smallLocalCrucibleModel()).resolves.toBe('local:qwen3.5-4b');
    await expect(provider.crucibleContextWindow('qwen3.5-9b')).resolves.toBe(32768);
  });
});

describe('the direct road is untouched', () => {
  it('BRIEFCASE_AI_VIA=direct: Claude still needs its local key and nothing reaches Crucible', async () => {
    process.env[AI_VIA_ENV] = 'direct';
    expect(provider.via()).toBe('direct');
    await expect(provider.generateText('p', { provider: 'claude', model: 'c' }, 'title')).rejects.toThrow('Claude API key is required');
    await expect(provider.generateText('p', { provider: 'openai', model: 'g' }, 'title')).rejects.toThrow('OpenAI API key is required');
    await expect(provider.generateText('p', { provider: 'local', model: 'x' }, 'title')).rejects.toThrow(/Local AI model not available/);
    expect(fake.requests.filter((r) => r.path.startsWith('/v1/'))).toHaveLength(0);
  });

  it('without the Crucible service (a hand-built provider) it is always direct', () => {
    expect(new AIProviderService(noLlama).via()).toBe('direct');
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

  function analysis(): AIAnalysisService {
    const detection = { detectBoundaries: async () => ({ boundaries: [0, 60], placeCalls: 0, scorer: 'lexical' }) };
    const nli = {
      captureThreshold: 0.2, rescueFloor: 0.15, unavailable: null,
      isAvailable: async () => true, rankWindows: async () => [], stop: () => undefined,
      userFacingUnavailableMessage: (r: string) => r,
    };
    return new AIAnalysisService(provider, {} as never, {} as never, detection as never, nli as never, undefined, undefined);
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

  it('REGRESSION: an ollama/ model through Crucible is chunked for Ollama\'s default context (Crucible can\'t send num_ctx), said once', async () => {
    await fake.close();
    fake = await startFakeCrucible({
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
    expect(fake.chatBodies().some((b) => 'num_ctx' in b || 'options' in b)).toBe(false);
    // Said once, not per run or per chunk.
    expect([...logged, ...warned].filter((m) => /Ollama's default context/.test(m))).toHaveLength(1);
  });

  it('zero successful chapters throws, never completes empty, and still releases the lease', async () => {
    fake.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 500, code: 'engine_failed' }];
    await expect(analysis().analyzeTranscript(options())).rejects.toThrow(/engine_failed/);
    expect(fake.leases.taken.length).toBeGreaterThan(0);
    expect(fake.leases.released).toEqual(fake.leases.taken.map((l) => l.leaseId));
    expect(fs.existsSync(path.join(process.env.APPDATA!, 'briefcase', 'api-keys.json'))).toBe(false);
  }, 30_000);
});
