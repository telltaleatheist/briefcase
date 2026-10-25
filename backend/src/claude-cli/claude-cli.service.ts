/**
 * TEMPORARY: CLAUDE CODE AS A MODEL (`claude-cli:<id>`), the user's own
 * exception (2026-10-25) to "all AI goes through Crucible". Everything it
 * needs is in this file; the routing branches that read it are each marked
 * "TEMPORARY (claude-cli)" (grep that to remove it):
 *
 *   analysis/ai-provider.service.ts   generateText, testProvider
 *   video-chat/video-chat.service.ts  ask (readiness), answer, refusalOf
 *   video-chat/video-chat-transport.ts claudeCliTransport
 *   queue/crucible-lanes.ts           targetOf, place, runAdmitted
 *   crucible/llm/crucible-ai.service.ts the picker group and its resolve
 *   library/library.controller.ts     insights (readiness)
 *   analysis/model-utils.ts, analysis/analysis.controller.ts  the provider name
 *   crucible/llm/crucible-llm.module.ts  provides this service
 *   frontend: ai-model-select, ask-panel, ai-model-value
 * plus `| 'claude-cli'` in the aiProvider type unions.
 *
 * WHAT IT IS. `claude -p`, the Claude Code CLI already installed and logged in
 * on this computer, spawned without a shell (args as an array, the prompt on
 * stdin), with no tools, no MCP servers, no settings, no saved session, and
 * the caller's system prompt in place of Claude Code's own. Its JSON result's
 * `.result` (or `.structured_output`, for a JSON Schema) and `.usage` are read.
 * No sampling parameter is ever sent (there is no flag for one anyway).
 *
 * WHAT IT IS NOT. Never a fallback: it runs only when the user picked a
 * `claude-cli:` model, never because Crucible is down. A choice of it skips
 * Crucible entirely (no run, no session, no readiness); a whole pipeline that
 * also needs Crucible (transcription, the snap scorer) is still gated on it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractJsonFromResponse } from '../analysis/json-utils';
import type { CrucibleTarget } from '../crucible/llm/target';
import type { AiOptionGroup } from '../crucible/wire/ai-wire';

/** The stored provider: `claude-cli:<model id>`. */
export const CLAUDE_CLI_PROVIDER = 'claude-cli';

/** The models offered, in the picker's order. */
export const CLAUDE_CLI_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (Claude Code)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (Claude Code)' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (Claude Code)' },
];

/** One answer may take a long while (a long transcript on Opus): killed past this. */
export const CLAUDE_CLI_TIMEOUT_MS = 15 * 60_000;

/**
 * The model id a stored choice names when it is a claude-cli choice, else
 * null. `model` may carry its own `claude-cli:` prefix.
 */
export function claudeCliModelOf(provider: string | undefined | null, model: string | undefined | null): string | null {
  const bare = (model ?? '').trim();
  const prefixed = /^claude-cli:(.+)$/i.exec(bare);
  if (prefixed) return prefixed[1].trim() || null;
  if ((provider ?? '').trim().toLowerCase() === CLAUDE_CLI_PROVIDER) return bare || null;
  return null;
}

/** The picker group, after every Crucible group. */
export function claudeCliGroup(): AiOptionGroup {
  return {
    kind: 'claude-cli',
    label: 'Claude Code (this computer)',
    error: null,
    options: CLAUDE_CLI_MODELS.map((m) => ({
      value: `${CLAUDE_CLI_PROVIDER}:${m.id}`, label: m.label, group: 'claude-cli' as const, sizeB: null, resident: null, serverChoice: false,
    })),
  };
}

/**
 * The queue's stand-in target for a claude-cli choice: not a Crucible model,
 * so the lanes place it as a cloud task and load nothing (crucible-lanes.ts).
 */
export function claudeCliTarget(id: string): CrucibleTarget {
  return { model: `${CLAUDE_CLI_PROVIDER}/${id}`, route: 'upstream', upstream: null, bareModel: id };
}

export function isClaudeCliTarget(target: Pick<CrucibleTarget, 'model'>): boolean {
  return target.model.startsWith(`${CLAUDE_CLI_PROVIDER}/`);
}

export interface ClaudeCliMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A conversation as one `-p` prompt: system messages become the system prompt;
 * one user turn is sent as it is; a longer history is flattened with USER /
 * ASSISTANT labels, ending with an instruction to reply to the last USER turn.
 */
export function flattenConversation(messages: readonly ClaudeCliMessage[]): { system: string | null; prompt: string } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 1 && turns[0].role === 'user') return { system: system || null, prompt: turns[0].content };
  const prompt = turns.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n')
    + '\n\nReply as the assistant to the last USER turn.';
  return { system: system || null, prompt };
}

/** The `claude` arguments for one call (checked against `claude --help`, 2.1.296). */
export function claudeCliArgs(options: { model: string; systemPromptFile: string | null; jsonSchema?: Record<string, unknown> }): string[] {
  return [
    '-p',
    '--model', options.model,
    ...(options.systemPromptFile === null ? [] : ['--system-prompt-file', options.systemPromptFile]),
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--setting-sources', '',
    '--output-format', 'json',
    ...(options.jsonSchema === undefined ? [] : ['--json-schema', JSON.stringify(options.jsonSchema)]),
  ];
}

export type ClaudeCliErrorCode = 'not_installed' | 'failed' | 'bad_output' | 'timeout' | 'cancelled';

export class ClaudeCliError extends Error {
  constructor(readonly code: ClaudeCliErrorCode, message: string) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

export interface ClaudeCliRequest {
  model: string;
  /** The conversation (system messages become the system prompt). */
  messages: readonly ClaudeCliMessage[];
  /** 'json': a JSON object is asked for in the prompt and lifted from the reply; a schema goes to `--json-schema`. */
  format?: 'json' | Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ClaudeCliResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** The CLI's own estimate (informational; a subscription is not billed by it). */
  costUsd: number | null;
  /** The API's stop reason (`end_turn`, `max_tokens`, …), or null. */
  stopReason: string | null;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** Where `claude` may be when the app's PATH is a GUI app's (no nvm, no ~/.local/bin). */
function candidateBinaries(): string[] {
  const home = os.homedir();
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin');
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvm).sort().reverse()) dirs.push(path.join(nvm, v, 'bin'));
  } catch {
    // no nvm
  }
  return dirs.map((d) => path.join(d, name));
}

@Injectable()
export class ClaudeCliService {
  private readonly logger = new Logger('ClaudeCli');
  /** Replaced in specs. */
  spawnImpl: SpawnFn = spawn as unknown as SpawnFn;
  /** Replaced in specs; null when no `claude` is found. */
  resolveBinary: () => string | null = () => {
    const explicit = process.env['BRIEFCASE_CLAUDE_CLI'];
    if (explicit) return explicit;
    for (const candidate of candidateBinaries()) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // next
      }
    }
    return null;
  };

  /** True when a `claude` binary is found on this computer. */
  available(): boolean {
    return this.resolveBinary() !== null;
  }

  /** One `claude -p` call. */
  async complete(request: ClaudeCliRequest): Promise<ClaudeCliResult> {
    const signal = request.signal;
    if (signal?.aborted) throw new ClaudeCliError('cancelled', 'The Claude Code call was cancelled.');
    const binary = this.resolveBinary();
    if (binary === null) {
      throw new ClaudeCliError('not_installed', 'The Claude Code CLI (claude) was not found on this computer. Install it and log in, or pick another model.');
    }
    const { system, prompt: flat } = flattenConversation(request.messages);
    const schema = request.format !== undefined && request.format !== 'json' ? request.format : undefined;
    const prompt = request.format === 'json' ? `${flat}\n\nReply with only the JSON object: no prose and no code fence.` : flat;

    let systemPromptFile: string | null = null;
    if (system !== null) {
      systemPromptFile = path.join(os.tmpdir(), `briefcase-claude-cli-${randomUUID()}.txt`);
      await fs.promises.writeFile(systemPromptFile, system, { encoding: 'utf-8', mode: 0o600 });
    }
    try {
      const args = claudeCliArgs({ model: request.model, systemPromptFile, ...(schema === undefined ? {} : { jsonSchema: schema }) });
      const stdout = await this.run(binary, args, prompt, signal, request.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS, request.model);
      const result = this.parse(stdout, request.model, schema !== undefined);
      if (request.format === 'json') result.text = extractJsonFromResponse(result.text) ?? result.text;
      return result;
    } finally {
      if (systemPromptFile !== null) await fs.promises.unlink(systemPromptFile).catch(() => undefined);
    }
  }

  private run(binary: string, args: string[], stdin: string, signal: AbortSignal | undefined, timeoutMs: number, model: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // No shell: the args cross as they are, the prompt on stdin. Run from the
        // temp dir so no project's CLAUDE.md is read.
        child = this.spawnImpl(binary, args, { cwd: os.tmpdir(), env: process.env, stdio: 'pipe' } as SpawnOptionsWithoutStdio);
      } catch (err) {
        reject(this.spawnFailure(err as NodeJS.ErrnoException, binary));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const kill = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          // gone already
        }
      };
      const onAbort = (): void => {
        kill();
        finish(() => reject(new ClaudeCliError('cancelled', 'The Claude Code call was cancelled.')));
      };
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new ClaudeCliError('timeout', `Claude Code (${model}) did not answer within ${Math.round(timeoutMs / 60_000)} min.`)));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(this.spawnFailure(e, binary))));
      child.on('close', (code: number | null, killedBy: NodeJS.Signals | null) => {
        const stdout = Buffer.concat(out).toString('utf-8');
        const stderr = Buffer.concat(err).toString('utf-8').trim();
        if (code === 0) {
          finish(() => resolve(stdout));
          return;
        }
        // A failed call still prints its JSON result (is_error) when it got that far.
        let said: string | null = null;
        try {
          const json = JSON.parse(stdout) as { result?: unknown };
          if (typeof json.result === 'string' && json.result.trim()) said = json.result.trim();
        } catch {
          said = null;
        }
        const why = said ?? (stderr.slice(-600) || stdout.trim().slice(-600) || (killedBy ? `killed by ${killedBy}` : 'no output'));
        finish(() => reject(new ClaudeCliError('failed', `Claude Code (${model}) exited with code ${code ?? killedBy}: ${why}`)));
      });
      // A child that dies before reading its stdin must not crash the backend (EPIPE).
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin, 'utf-8');
    });
  }

  private spawnFailure(error: NodeJS.ErrnoException, binary: string): ClaudeCliError {
    if (error?.code === 'ENOENT') {
      return new ClaudeCliError('not_installed', `The Claude Code CLI was not found at ${binary}. Install it and log in, or pick another model.`);
    }
    return new ClaudeCliError('failed', `Claude Code could not be started (${binary}): ${error?.message ?? String(error)}`);
  }

  private parse(stdout: string, model: string, structured: boolean): ClaudeCliResult {
    let json: {
      result?: unknown; structured_output?: unknown; is_error?: unknown; subtype?: unknown; stop_reason?: unknown; total_cost_usd?: unknown;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new ClaudeCliError('bad_output', `Claude Code (${model}) did not print a JSON result: ${stdout.trim().slice(0, 300) || 'nothing'}`);
    }
    if (json === null || typeof json !== 'object') throw new ClaudeCliError('bad_output', `Claude Code (${model}) printed ${String(json)}, not a JSON result.`);
    if (json.is_error === true) {
      throw new ClaudeCliError('failed', `Claude Code (${model}): ${typeof json.result === 'string' && json.result ? json.result : String(json.subtype ?? 'error')}`);
    }
    let text: string;
    if (structured && json.structured_output !== undefined && json.structured_output !== null) text = JSON.stringify(json.structured_output);
    else if (typeof json.result === 'string') text = json.result;
    else throw new ClaudeCliError('bad_output', `Claude Code (${model}) returned no result text.`);
    const u = json.usage;
    const usage = u && typeof u === 'object'
      ? {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
      }
      : null;
    if (usage) this.logger.log(`${model}: ${usage.inputTokens} input + ${usage.outputTokens} output tokens`);
    return {
      text,
      usage,
      costUsd: typeof json.total_cost_usd === 'number' ? json.total_cost_usd : null,
      stopReason: typeof json.stop_reason === 'string' ? json.stop_reason : null,
    };
  }
}
