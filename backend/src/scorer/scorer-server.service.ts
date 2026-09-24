/**
 * Scorer Server Service — lifecycle of the scorer's OWN llama-server.
 *
 * Separate from LlamaBridge/LlamaManager (the chat model on port 8081, 8k ctx):
 * the scorer needs a different binary (Qwen3.5 needs llama.cpp >= b10964), a
 * large context (whole transcripts as state), context checkpoints, and no
 * generation-oriented flags. Sharing the chat bridge would mean either
 * restarting the chat server with scorer flags or forking its hardcoded args,
 * so this is its own small process owner:
 *
 *   - dynamic free port on 127.0.0.1
 *   - readiness via GET /health (200), not log sniffing
 *   - idle shutdown (app-config scorerIdleMinutes, default 5), held off while
 *     any decide/generate/lease is in flight
 *   - clean stop (SIGTERM, SIGKILL after 5 s) on demand and on module destroy
 *   - one engine call at a time (--parallel 1: interleaving two callers would
 *     also thrash the prompt cache the priming relies on)
 *
 * Nothing starts at boot: the first decide()/generate()/ensureReady() starts it.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { ScorerDecider } from './scorer-decide';
import { ScorerEngine } from './scorer-engine';
import {
  MIN_SCORER_LLAMA_BUILD,
  ScorerBinary,
  ScorerConfig,
  buildScorerArgs,
  loadScorerConfig,
  parseLlamaBuild,
  resolveScorerBinary,
} from './scorer-config';
import {
  ChatMessage,
  DecideOptions,
  DecideRequest,
  DecideResponse,
  GenerateOptions,
  GenerateResult,
  ScorerError,
} from './scorer.types';

export interface ScorerServerStatus {
  running: boolean;
  ready: boolean;
  port: number | null;
  pid: number | null;
  binary: string | null;
  binarySource: ScorerBinary['source'] | null;
  model: string | null;
  vision: boolean;
  buildInfo: string | null;
  uptimeMs: number | null;
}

/**
 * What a lease holder can call: THE SCORER SEAM. The app's own llama-server
 * (this file) and Crucible's decision door (crucible-scorer.service.ts) both
 * serve it, so chapters and flags never know which transport answered.
 */
export interface ScorerHandle {
  decide(req: DecideRequest, options?: DecideOptions): Promise<DecideResponse>;
  generate(messages: ChatMessage[] | string, options: GenerateOptions): Promise<GenerateResult>;
  /** The model the decisions are read from, as the engine names it. */
  readonly model: string;
  /** Tokens `text` is on this model (chunk planning). */
  countTokens(text: string, signal?: AbortSignal): Promise<number>;
  /** The own llama-server only: its decider (builder/props, for prompt sizing and the smoke). */
  decider?(): Promise<ScorerDecider>;
}

/** Ask the OS for a free port on 127.0.0.1 (released immediately; llama-server binds it next). */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a port'))));
    });
  });
}

/** `p`, or ScorerError('cancelled') as soon as `signal` aborts (p is left to settle on its own). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new ScorerError('cancelled', 'cancelled while the scorer was starting'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ScorerError('cancelled', 'cancelled while the scorer was starting'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const STARTUP_TIMEOUT_MS = 5 * 60_000; // an 18 GB BF16 load from a cold disk
const HEALTH_POLL_MS = 500;
const STOP_GRACE_MS = 5000;
const LOG_TAIL_CHARS = 4000;

@Injectable()
export class ScorerServerService implements OnModuleDestroy {
  private readonly logger = new Logger(ScorerServerService.name);

  private proc: ChildProcess | null = null;
  private ready = false;
  private port: number | null = null;
  private startedAt: number | null = null;
  private binary: ScorerBinary | null = null;
  private config: ScorerConfig | null = null;
  private engine: ScorerEngine | null = null;
  private deciderPromise: Promise<ScorerDecider> | null = null;
  private startPromise: Promise<ScorerEngine> | null = null;
  /** An in-flight stop: the old process may still be exiting after state was cleared. */
  private stopping: Promise<void> | null = null;
  private logTail = '';
  private buildInfo: string | null = null;

  private idleTimer: NodeJS.Timeout | null = null;
  private inUse = 0;
  private queue: Promise<unknown> = Promise.resolve();

  // ------------------------------------------------------------------ public API

  getStatus(): ScorerServerStatus {
    return {
      running: this.proc !== null,
      ready: this.ready,
      port: this.port,
      pid: this.proc?.pid ?? null,
      binary: this.binary?.path ?? null,
      binarySource: this.binary?.source ?? null,
      model: this.config ? path.basename(this.config.modelPath) : null,
      vision: !!this.config?.mmprojPath,
      buildInfo: this.buildInfo,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  /** True when the configured scorer model file is on disk (does not check the binary). */
  isModelAvailable(): boolean {
    const cfg = this.loadConfig();
    return fs.existsSync(cfg.modelPath);
  }

  /**
   * Can the scorer be started at all? Checks the configured model file and that
   * a llama-server binary resolves, WITHOUT starting anything. A binary that is
   * too old for the model (the bundled b7482) still reports available here and
   * fails at start, which the caller handles the same way (fall back + warn).
   */
  availability(): { available: true; binarySource: ScorerBinary['source'] } | { available: false; reason: string } {
    try {
      if (this.proc && this.ready) return { available: true, binarySource: this.binary?.source ?? 'env' };
      const cfg = this.loadConfig();
      if (!fs.existsSync(cfg.modelPath)) {
        return { available: false, reason: `scorer model not found: ${cfg.modelPath}` };
      }
      const binary = this.resolveBinary(cfg);
      return { available: true, binarySource: binary.source };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  /** Start the server if needed and wait until GET /health answers 200. */
  async ensureReady(): Promise<ScorerEngine> {
    if (this.proc && this.ready && this.engine) return this.engine;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  /** One /v1/decide-equivalent call (see ScorerDecider.decide). */
  decide(req: DecideRequest, options: DecideOptions = {}): Promise<DecideResponse> {
    return this.use(async () => (await this.getDecider()).decide(req, options));
  }

  /** One plain text generation from the scorer model: thinking off, temperature 0. */
  generate(messages: ChatMessage[] | string, options: GenerateOptions): Promise<GenerateResult> {
    const msgs: ChatMessage[] = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
    return this.use(async () => (await this.ensureReady()).generate(msgs, options));
  }

  /**
   * Hold the server for a multi-call job (e.g. a whole chaptering pass) so the
   * idle timer cannot stop it between calls. Calls through the handle are still
   * serialized with other callers.
   */
  async withScorer<T>(fn: (scorer: ScorerHandle) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.acquire();
    try {
      // A cold start is minutes of model load; a cancel must not wait it out.
      // The start itself carries on (another caller may share it) and, with no
      // lease left, the idle timer stops it once it is up.
      await untilAborted(this.ensureReady(), signal);
      const decider = await untilAborted(this.getDecider(), signal);
      return await fn({
        decide: (req, options) => this.decide(req, options),
        generate: (messages, options) => this.generate(messages, options),
        model: decider.model,
        countTokens: async (text, sig) => (await decider.engine.tokenize(text, sig)).length,
        decider: () => this.getDecider(),
      });
    } finally {
      this.release();
    }
  }

  /**
   * Stop the server (idempotent). Resolves when the process has exited (or been
   * SIGKILLed and exited). State is cleared at once, but the old process can
   * take up to the kill grace to go; `stopping` tracks that so start() waits
   * for it and there is never more than one 18 GB scorer resident.
   */
  async stop(): Promise<void> {
    this.clearIdleTimer();
    const proc = this.proc;
    this.resetState();
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const prev = this.stopping;
      const tracked: Promise<void> = Promise.all([prev, this.killAndWait(proc)]).then(() => {
        if (this.stopping === tracked) this.stopping = null;
      });
      this.stopping = tracked;
    }
    if (this.stopping) await this.stopping;
  }

  /**
   * Stop the server now unless someone holds it (a lease or an engine call in
   * flight). For a caller about to load another large local model, which should
   * not have to share memory with the scorer for the idle window.
   * Resolves true when nothing is left running.
   */
  async stopIfIdle(): Promise<boolean> {
    if (this.inUse > 0 || this.startPromise) return false;
    await this.stop();
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** SIGTERM, SIGKILL after the grace, and resolve once the process has exited. */
  private killAndWait(proc: ChildProcess): Promise<void> {
    this.logger.log(`Stopping scorer llama-server (pid ${proc.pid})`);
    return new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | null = null;
      let giveUpTimer: NodeJS.Timeout | null = null;
      const done = () => {
        if (killTimer) clearTimeout(killTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        resolve();
      };
      proc.once('exit', done);
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        // SIGKILL cannot be ignored, but never hang a stop on a lost 'exit' event.
        giveUpTimer = setTimeout(done, this.stopGraceMs());
      }, this.stopGraceMs());
      if (process.platform === 'win32' && proc.pid) {
        try {
          require('child_process').execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          proc.kill('SIGKILL');
        }
      } else {
        proc.kill('SIGTERM');
      }
    });
  }

  // ------------------------------------------------------------------ overridable seams (tests)

  protected loadConfig(): ScorerConfig {
    return loadScorerConfig();
  }

  protected resolveBinary(config: ScorerConfig): ScorerBinary {
    return resolveScorerBinary(config.llamaServerOverride);
  }

  protected findPort(): Promise<number> {
    return findFreePort();
  }

  protected spawnServer(binary: ScorerBinary, args: string[]): ChildProcess {
    const env = { ...process.env };
    if (binary.libraryPath) {
      env.DYLD_LIBRARY_PATH = `${binary.libraryPath}:${env.DYLD_LIBRARY_PATH || ''}`;
    }
    const options: Parameters<typeof spawn>[2] = { env, stdio: ['ignore', 'pipe', 'pipe'] };
    if (process.platform === 'win32') options.cwd = path.dirname(binary.path); // DLL lookup
    return spawn(binary.path, args, options);
  }

  protected createEngine(baseUrl: string): ScorerEngine {
    return new ScorerEngine(baseUrl);
  }

  protected healthPollMs(): number {
    return HEALTH_POLL_MS;
  }

  protected startupTimeoutMs(): number {
    return STARTUP_TIMEOUT_MS;
  }

  protected stopGraceMs(): number {
    return STOP_GRACE_MS;
  }

  // ------------------------------------------------------------------ internals

  private getDecider(): Promise<ScorerDecider> {
    if (!this.deciderPromise) {
      const p = this.ensureReady().then((engine) => ScorerDecider.create(engine));
      this.deciderPromise = p;
      // A failed build is not cached; the next call tries again.
      p.catch(() => {
        if (this.deciderPromise === p) this.deciderPromise = null;
      });
    }
    return this.deciderPromise;
  }

  /** Serialize engine work and hold off the idle shutdown while it runs. */
  private use<T>(work: () => Promise<T>): Promise<T> {
    this.acquire();
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run.finally(() => this.release());
  }

  private acquire(): void {
    this.inUse++;
    this.clearIdleTimer();
  }

  private release(): void {
    this.inUse = Math.max(0, this.inUse - 1);
    if (this.inUse === 0) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.proc) return;
    const ms = this.config?.idleTimeoutMs ?? 5 * 60_000;
    this.idleTimer = setTimeout(() => {
      if (this.inUse === 0) {
        this.logger.log('Scorer idle timeout reached - stopping llama-server to free memory');
        void this.stop();
      }
    }, ms);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private resetState(): void {
    this.proc = null;
    this.ready = false;
    this.port = null;
    this.startedAt = null;
    this.engine = null;
    this.deciderPromise = null;
    this.buildInfo = null;
  }

  private async start(): Promise<ScorerEngine> {
    // Also covers the idle timer's un-awaited stop(): its process can still be
    // exiting (up to the kill grace), and spawning now would put two scorers in memory.
    if (this.proc || this.stopping) await this.stop();

    const config = this.loadConfig();
    this.config = config;
    if (!fs.existsSync(config.modelPath)) {
      throw new ScorerError(
        'engine_unreachable',
        `scorer model not found: ${config.modelPath} (install the scorer model component, or set app-config scorerModel)`,
      );
    }
    if (config.mmprojPath && !fs.existsSync(config.mmprojPath)) {
      throw new ScorerError('engine_unreachable', `scorer vision projector not found: ${config.mmprojPath}`);
    }
    const binary = this.resolveBinary(config);
    this.binary = binary;
    const port = await this.findPort();
    const args = buildScorerArgs({
      modelPath: config.modelPath,
      port,
      contextSize: config.contextSize,
      mmprojPath: config.mmprojPath,
    });

    this.logger.log(`Starting scorer llama-server (${binary.source}): ${binary.path}`);
    this.logger.log(`Args: ${args.join(' ')}`);
    if (binary.source === 'bundled') {
      this.logger.warn(
        `Using the app's own llama-server; it may predate b${MIN_SCORER_LLAMA_BUILD} and fail to load Qwen3.5 ` +
          `(set BRIEFCASE_SCORER_LLAMA_SERVER or install Homebrew llama.cpp).`,
      );
    }

    this.logTail = '';
    const proc = this.spawnServer(binary, args);
    this.proc = proc;
    this.port = port;
    this.startedAt = Date.now();

    let exited: string | null = null;
    const onData = (d: Buffer) => {
      this.logTail = (this.logTail + d.toString()).slice(-LOG_TAIL_CHARS);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) => {
      exited = `spawn error: ${err.message}`;
      this.logger.error(`Scorer llama-server ${exited}`);
      if (this.proc === proc) this.resetState();
    });
    proc.on('exit', (code, sig) => {
      exited = `exited with code ${code}${sig ? ` (${sig})` : ''}`;
      this.logger.log(`Scorer llama-server ${exited}`);
      if (this.proc === proc) {
        this.clearIdleTimer();
        this.resetState();
      }
    });

    const engine = this.createEngine(`http://127.0.0.1:${port}`);
    const deadline = Date.now() + this.startupTimeoutMs();
    for (;;) {
      if (exited) {
        throw new ScorerError(
          'engine_unreachable',
          `scorer llama-server ${exited} during startup. Last output: ${this.logTail.slice(-800)}`,
        );
      }
      if (this.proc !== proc) throw new ScorerError('engine_unreachable', 'scorer llama-server was stopped during startup');
      try {
        await engine.health();
        break;
      } catch {
        // 503 while loading, or refused before it binds: keep polling
      }
      if (Date.now() > deadline) {
        const tail = this.logTail.slice(-800);
        await this.stop();
        throw new ScorerError(
          'engine_timeout',
          `scorer llama-server not healthy within ${Math.round(this.startupTimeoutMs() / 1000)} s. Last output: ${tail}`,
        );
      }
      await new Promise((r) => setTimeout(r, this.healthPollMs()));
    }

    this.engine = engine;
    this.ready = true;
    this.logger.log(`Scorer llama-server ready on port ${port} (${Math.round((Date.now() - this.startedAt!) / 1000)} s)`);
    try {
      const props = await engine.props();
      this.buildInfo = props.buildInfo ?? null;
      const build = parseLlamaBuild(props.buildInfo);
      if (build !== null && build < MIN_SCORER_LLAMA_BUILD) {
        this.logger.warn(`Scorer llama-server is build ${build}; Qwen3.5 needs >= b${MIN_SCORER_LLAMA_BUILD}`);
      }
    } catch (err) {
      this.logger.warn(`Could not read scorer /props: ${(err as Error).message}`);
    }
    if (this.inUse === 0) this.armIdleTimer();
    return engine;
  }
}
