// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DEFAULT_SCORER_MODEL_FILE,
  SCORER_MODELS,
  isScorerModelFile,
  isScorerModelId,
  scorerModelComponents,
} from '../config/model-catalog';
import { ComponentManagerService } from '../components/component-manager.service';
import { LlamaManager } from '../bridges/llama-manager';
import {
  DEFAULT_SCORER_CONTEXT,
  SCORER_BINARY_ENV,
  ScorerBinary,
  ScorerConfig,
  buildScorerArgs,
  loadScorerConfig,
  parseLlamaBuild,
  resolveScorerBinary,
} from './scorer-config';
import { FetchLike, ScorerEngine } from './scorer-engine';
import { ScorerServerService, findFreePort } from './scorer-server.service';
import { ScorerError } from './scorer.types';

/**
 * Scorer server lifecycle, configuration and catalog. Nothing here spawns a
 * process or loads a model: the service's spawn/engine seams are overridden
 * with a fake child process and a fake llama-server fetch.
 */

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-spec-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================ config

describe('loadScorerConfig', () => {
  it('defaults: Qwen3.5-9B-BF16.gguf in <configDir>/models, 64k context, 5 min idle', () => {
    const cfg = loadScorerConfig({ configDir: '/cfg', readFile: () => null });
    expect(cfg.modelsDir).toBe('/cfg/models');
    expect(cfg.modelPath).toBe(path.join('/cfg/models', DEFAULT_SCORER_MODEL_FILE));
    expect(cfg.contextSize).toBe(DEFAULT_SCORER_CONTEXT);
    expect(cfg.contextSize).toBe(65536);
    expect(cfg.idleTimeoutMs).toBe(5 * 60_000);
    expect(cfg.mmprojPath).toBeUndefined();
    expect(cfg.llamaServerOverride).toBeUndefined();
  });

  it('reads scorerModel / scorerMmproj / scorerContextSize / scorerLlamaServer, and never defaultLocalModel', () => {
    const cfg = loadScorerConfig({
      configDir: '/cfg',
      readFile: () =>
        JSON.stringify({
          defaultLocalModel: 'cogito-8b',
          scorerModel: 'Other.gguf',
          scorerMmproj: '/abs/mmproj.gguf',
          scorerContextSize: 32768,
          scorerLlamaServer: '/opt/llama/llama-server',
          scorerIdleMinutes: 1,
        }),
    });
    expect(cfg.modelPath).toBe('/cfg/models/Other.gguf');
    expect(cfg.mmprojPath).toBe('/abs/mmproj.gguf');
    expect(cfg.contextSize).toBe(32768);
    expect(cfg.llamaServerOverride).toBe('/opt/llama/llama-server');
    expect(cfg.idleTimeoutMs).toBe(60_000);

    const onlyChat = loadScorerConfig({ configDir: '/cfg', readFile: () => JSON.stringify({ defaultLocalModel: 'cogito-8b' }) });
    expect(path.basename(onlyChat.modelPath)).toBe(DEFAULT_SCORER_MODEL_FILE);
  });

  it('unreadable config falls back to the defaults', () => {
    const cfg = loadScorerConfig({ configDir: '/cfg', readFile: () => '{not json' });
    expect(path.basename(cfg.modelPath)).toBe(DEFAULT_SCORER_MODEL_FILE);
  });
});

describe('resolveScorerBinary', () => {
  const bundled = () => ({ path: '/app/utilities/bin/llama-server-arm64', libraryPath: '/app/utilities/bin' });
  const existing = (...paths: string[]) => (p: string) => paths.includes(p);

  it('env override beats app-config beats Homebrew beats bundled', () => {
    const all = existing('/env/llama-server', '/cfg/llama-server', '/opt/homebrew/bin/llama-server', bundled().path);
    const base = { exists: all, platform: 'darwin' as NodeJS.Platform, bundled };
    expect(resolveScorerBinary('/cfg/llama-server', { ...base, env: { [SCORER_BINARY_ENV]: '/env/llama-server' } })).toEqual({
      path: '/env/llama-server',
      source: 'env',
    });
    expect(resolveScorerBinary('/cfg/llama-server', { ...base, env: {} })).toEqual({ path: '/cfg/llama-server', source: 'config' });
    expect(resolveScorerBinary(undefined, { ...base, env: {} })).toEqual({ path: '/opt/homebrew/bin/llama-server', source: 'homebrew' });
    expect(
      resolveScorerBinary(undefined, { ...base, env: {}, exists: existing(bundled().path) }),
    ).toEqual({ path: bundled().path, source: 'bundled', libraryPath: '/app/utilities/bin' });
  });

  it('an explicit override that does not exist is an error, never a silent fall-through', () => {
    const base = { exists: existing('/opt/homebrew/bin/llama-server'), platform: 'darwin' as NodeJS.Platform, bundled };
    expect(() => resolveScorerBinary(undefined, { ...base, env: { [SCORER_BINARY_ENV]: '/missing' } })).toThrow(/missing/);
    expect(() => resolveScorerBinary('/missing', { ...base, env: {} })).toThrow(/scorerLlamaServer/);
  });

  it('no binary anywhere is an error that says what to do', () => {
    expect(() => resolveScorerBinary(undefined, { env: {}, exists: () => false, platform: 'darwin', bundled })).toThrow(
      /BRIEFCASE_SCORER_LLAMA_SERVER/,
    );
  });
});

describe('buildScorerArgs', () => {
  it("is snap's serve command line with a dynamic port", () => {
    expect(buildScorerArgs({ modelPath: '/m/Q.gguf', port: 51234, contextSize: 65536 })).toEqual([
      '-m', '/m/Q.gguf',
      '--alias', 'scorer',
      '-ngl', '99',
      '-c', '65536',
      '-fa', 'on',
      '--host', '127.0.0.1',
      '--port', '51234',
      '--parallel', '1',
      '--ctx-checkpoints', '32',
      '--jinja',
      '--no-webui',
    ]);
  });

  it('adds --mmproj only when configured', () => {
    const args = buildScorerArgs({ modelPath: '/m/Q.gguf', port: 1, contextSize: 8, mmprojPath: '/m/mmproj.gguf' });
    expect(args.slice(-2)).toEqual(['--mmproj', '/m/mmproj.gguf']);
  });

  it('parses the llama.cpp build from /props build_info', () => {
    expect(parseLlamaBuild('b10964-3f2a1b')).toBe(10964);
    expect(parseLlamaBuild('7482 (abc)')).toBe(7482);
    expect(parseLlamaBuild(undefined)).toBeNull();
  });
});

// ============================================================================ catalog

describe('scorer model catalog', () => {
  it('is a llama-model component for the official Hugging Face file', () => {
    const [model] = scorerModelComponents();
    expect(model.kind).toBe('llama-model');
    expect(model.id).toBe(SCORER_MODELS[0].id);
    const art = model.artifacts.find((a) => a.platform === 'darwin')!;
    expect(art.url).toBe('https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-BF16.gguf');
    expect(art.file).toBe('Qwen3.5-9B-BF16.gguf');
    expect(art.entry).toBe('Qwen3.5-9B-BF16.gguf');
    expect(art.bytes).toBe(17920697312);
  });

  it('recognises scorer ids and files (never chat models)', () => {
    for (const m of SCORER_MODELS) {
      expect(isScorerModelId(m.id)).toBe(true);
      expect(isScorerModelFile(m.filename)).toBe(true);
    }
    expect(isScorerModelId('cogito-8b')).toBe(false);
    expect(isScorerModelFile('cogito-v1-preview-llama-8B-Q6_K.gguf')).toBe(false);
    expect(isScorerModelFile('mmproj-F16.gguf')).toBe(true);
    expect(isScorerModelFile('Custom-Scorer.gguf', ['Custom-Scorer.gguf'])).toBe(true);
    expect(isScorerModelFile('Custom-Scorer.gguf', ['/abs/path/Custom-Scorer.gguf'])).toBe(true);
  });

  it("every scorer id starts with 'scorer-' (the frontend's isChatModelComponent keeps them out of the setup wizard by it)", () => {
    for (const c of scorerModelComponents()) expect(c.id.startsWith('scorer-')).toBe(true);
  });

  it('installing a scorer model never sets defaultLocalModel; a chat model still does', () => {
    const self = { configDir: tmp, logger: { log() {}, warn() {} } };
    const setDefault = (ComponentManagerService.prototype as any).setDefaultLocalModelIfUnset;
    const configPath = path.join(tmp, 'app-config.json');

    setDefault.call(self, SCORER_MODELS[0].id);
    expect(fs.existsSync(configPath)).toBe(false);

    setDefault.call(self, 'cogito-8b');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).defaultLocalModel).toBe('cogito-8b');
  });

  it("LlamaManager's chat fallback skips the scorer model in the shared models dir", () => {
    const modelsDir = path.join(tmp, 'models');
    fs.mkdirSync(modelsDir);
    fs.writeFileSync(path.join(modelsDir, DEFAULT_SCORER_MODEL_FILE), '');
    const picked: string[] = [];
    const self = {
      modelsDir,
      llama: { setModelPath: (p: string) => picked.push(p), setGpuLayers() {} },
      computeGpuLayers: () => 99,
      logger: { log() {} },
    };
    const resolveModel = (LlamaManager.prototype as any).resolveModel;

    expect(resolveModel.call(self)).toBe(false); // only the scorer model: no chat model
    expect(picked).toEqual([]);

    fs.writeFileSync(path.join(modelsDir, 'cogito-v1-preview-llama-8B-Q6_K.gguf'), '');
    expect(resolveModel.call(self)).toBe(true);
    expect(picked).toEqual([path.join(modelsDir, 'cogito-v1-preview-llama-8B-Q6_K.gguf')]);
  });
});

// ============================================================================ lifecycle

class FakeProc extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills: string[] = [];
  kill(sig: NodeJS.Signals = 'SIGTERM') {
    this.kills.push(sig);
    setImmediate(() => {
      this.signalCode = sig;
      this.emit('exit', null, sig);
    });
    return true;
  }
  die(code: number) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** A tiny llama-server fetch: /health answers 503 `loadingPolls` times, then 200. */
function fakeServerFetch(loadingPolls: number): { fetch: FetchLike; health: () => number } {
  let health = 0;
  const qwen = (m: any[], g: boolean) =>
    m.map((x) => `<|im_start|>${x.role}\n${x.content.trim()}<|im_end|>\n`).join('') +
    (g ? '<|im_start|>assistant\n<think>\n\n</think>\n\n' : '');
  const fetch: FetchLike = async (url, init) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status });
    if (p === '/health') return ++health <= loadingPolls ? json(503, { error: { message: 'Loading model' } }) : json(200, { status: 'ok' });
    if (p === '/props') {
      return json(200, {
        model_path: '/m/Qwen3.5-9B-BF16.gguf', modalities: { vision: false }, media_marker: '<__media_x__>',
        chat_template: 'tmpl', bos_token: '', eos_token: '<|im_end|>', build_info: 'b10964-abc',
      });
    }
    if (p === '/tokenize') return json(200, { tokens: [body.content.charCodeAt(0)] });
    if (p === '/apply-template') return json(200, { prompt: qwen(body.messages, body.add_generation_prompt) });
    if (p === '/completion') {
      const top = [
        { id: 65, token: 'A', logprob: Math.log(0.8) },
        { id: 66, token: 'B', logprob: Math.log(0.15) },
      ];
      return json(200, {
        tokens_evaluated: 10, tokens_cached: 11, timings: { prompt_ms: 3, prompt_n: 10, cache_n: 0 },
        completion_probabilities: [{ ...top[0], top_logprobs: top }],
      });
    }
    return json(404, {});
  };
  return { fetch, health: () => health };
}

class TestScorerServer extends ScorerServerService {
  spawned: Array<{ binary: ScorerBinary; args: string[]; proc: FakeProc }> = [];
  server = fakeServerFetch(2);
  constructor(
    private readonly cfg: ScorerConfig,
    private readonly onSpawn?: (proc: FakeProc) => void,
  ) {
    super();
  }
  protected loadConfig() {
    return this.cfg;
  }
  protected resolveBinary(): ScorerBinary {
    return { path: '/opt/homebrew/bin/llama-server', source: 'homebrew' };
  }
  protected findPort() {
    return Promise.resolve(50123);
  }
  protected spawnServer(binary: ScorerBinary, args: string[]) {
    const proc = new FakeProc();
    this.spawned.push({ binary, args, proc });
    this.onSpawn?.(proc);
    return proc as unknown as ChildProcess;
  }
  protected createEngine(baseUrl: string) {
    return new ScorerEngine(baseUrl, { fetchImpl: this.server.fetch, retryDelaysMs: [0, 0] });
  }
  protected healthPollMs() {
    return 1;
  }
  protected startupTimeoutMs() {
    return 2000;
  }
}

function configWithModel(extra: Partial<ScorerConfig> = {}): ScorerConfig {
  const modelsDir = path.join(tmp, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const modelPath = path.join(modelsDir, DEFAULT_SCORER_MODEL_FILE);
  fs.writeFileSync(modelPath, '');
  return { configDir: tmp, modelsDir, modelPath, contextSize: 65536, idleTimeoutMs: 60_000, ...extra };
}

describe('ScorerServerService lifecycle', () => {
  it('spawns once for concurrent callers and is ready after /health answers 200', async () => {
    const svc = new TestScorerServer(configWithModel());
    const [a, b] = await Promise.all([svc.ensureReady(), svc.ensureReady()]);
    expect(a).toBe(b);
    expect(svc.spawned).toHaveLength(1);
    expect(svc.server.health()).toBe(3); // two 503s while loading, then 200
    expect(svc.spawned[0].args).toEqual(expect.arrayContaining(['--port', '50123', '--ctx-checkpoints', '32', '-c', '65536']));
    expect(a.baseUrl).toBe('http://127.0.0.1:50123');
    const status = svc.getStatus();
    expect(status).toMatchObject({ running: true, ready: true, port: 50123, pid: 4242, binarySource: 'homebrew', buildInfo: 'b10964-abc' });
    await svc.stop();
  });

  it('decide() goes through the managed server', async () => {
    const svc = new TestScorerServer(configWithModel());
    const res = await svc.decide({ state: 'x', questions: [{ type: 'yesno', name: 'q', instructions: 'It is x' }] });
    const q = res.answers.q;
    if (q.type !== 'yesno') throw new Error('expected yesno');
    expect(q.p).toBeCloseTo(0.8 / 0.95, 10);
    await svc.stop();
  });

  it('stop() sends SIGTERM and clears state; a later call starts a fresh server', async () => {
    const svc = new TestScorerServer(configWithModel());
    await svc.ensureReady();
    const first = svc.spawned[0].proc;
    await svc.stop();
    expect(first.kills).toEqual(['SIGTERM']);
    expect(svc.getStatus()).toMatchObject({ running: false, ready: false, port: null });
    await svc.ensureReady();
    expect(svc.spawned).toHaveLength(2);
    await svc.stop();
  });

  it('shuts down after the idle timeout, but not while a lease is held', async () => {
    const svc = new TestScorerServer(configWithModel({ idleTimeoutMs: 30 }));
    await svc.withScorer(async (s) => {
      await s.decide({ state: 'x', questions: [{ type: 'yesno', name: 'q', instructions: 'It is x' }] });
      await new Promise((r) => setTimeout(r, 80)); // longer than the idle timeout
      expect(svc.getStatus().running).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(svc.spawned[0].proc.kills).toEqual(['SIGTERM']);
    expect(svc.getStatus().running).toBe(false);
  });

  it('a process that exits during startup is engine_unreachable with its last output', async () => {
    const svc = new TestScorerServer(configWithModel(), (proc) => {
      setImmediate(() => {
        proc.stderr.emit('data', Buffer.from('error: unknown model architecture: qwen35\n'));
        proc.die(1);
      });
    });
    svc.server = fakeServerFetch(1_000_000); // never healthy
    try {
      await svc.ensureReady();
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ScorerError);
      expect((e as ScorerError).code).toBe('engine_unreachable');
      expect((e as Error).message).toContain('unknown model architecture');
    }
    expect(svc.getStatus().running).toBe(false);
  });

  it('refuses to start without the model file, naming the path', async () => {
    const svc = new TestScorerServer({ ...configWithModel(), modelPath: path.join(tmp, 'models', 'absent.gguf') });
    await expect(svc.ensureReady()).rejects.toThrow(/absent\.gguf/);
    expect(svc.spawned).toHaveLength(0);
  });

  it('availability(): names a missing model, and reports the binary source without spawning', () => {
    const missing = new TestScorerServer({ ...configWithModel(), modelPath: path.join(tmp, 'models', 'absent.gguf') });
    const no = missing.availability();
    expect(no.available).toBe(false);
    expect(!no.available && no.reason).toMatch(/absent\.gguf/);
    const ok = new TestScorerServer(configWithModel()).availability();
    expect(ok).toEqual({ available: true, binarySource: 'homebrew' });
    class NoBinary extends TestScorerServer {
      protected resolveBinary(): ScorerBinary {
        throw new Error('No llama-server for the scorer');
      }
    }
    const nb = new NoBinary(configWithModel()).availability();
    expect(nb.available).toBe(false);
    expect(!nb.available && nb.reason).toMatch(/No llama-server/);
    expect(missing.spawned).toHaveLength(0);
  });

  it('findFreePort returns a bindable port', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
