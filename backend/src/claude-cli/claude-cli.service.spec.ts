import { beforeAll, describe, expect, it } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { PassThrough } from 'stream';
import {
  ClaudeCliError,
  ClaudeCliService,
  claudeCliArgs,
  claudeCliGroup,
  claudeCliModelOf,
  claudeCliTarget,
  flattenConversation,
  isClaudeCliTarget,
} from './claude-cli.service';
import { AIProviderService } from '../analysis/ai-provider.service';
import { AnalysisCancelledError } from '../analysis/cancellation';

/**
 * TEMPORARY (claude-cli): the local Claude Code CLI as a model, the user's
 * exception to Crucible-only AI. The child process is a fake: what was
 * spawned, with which args, what crossed on stdin, and what it prints.
 */

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (sig?: string) => boolean;
  killed: string[];
  input: Promise<string>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = [];
  child.kill = (sig = 'SIGTERM') => {
    child.killed.push(sig);
    setImmediate(() => child.emit('close', null, sig));
    return true;
  };
  const chunks: Buffer[] = [];
  child.stdin.on('data', (c: Buffer) => chunks.push(c));
  child.input = new Promise((resolve) => child.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8'))));
  return child;
}

/** A service whose spawn records each call and hands the test the child to drive. */
function harness(binary: string | null = '/usr/local/bin/claude') {
  const service = new ClaudeCliService();
  const spawned: Array<{ command: string; args: string[]; options: any; child: FakeChild; systemPrompt: string | null }> = [];
  service.resolveBinary = () => binary;
  service.spawnImpl = ((command: string, args: readonly string[], options: any) => {
    const child = fakeChild();
    const at = args.indexOf('--system-prompt-file');
    const systemPrompt = at >= 0 ? fs.readFileSync(args[at + 1], 'utf-8') : null;
    spawned.push({ command, args: [...args], options, child, systemPrompt });
    return child as any;
  }) as any;
  return { service, spawned };
}

const json = (o: unknown) => JSON.stringify(o);
const ok = (result: string, extra: Record<string, unknown> = {}) => json({
  type: 'result', subtype: 'success', is_error: false, result, stop_reason: 'end_turn', total_cost_usd: 0.0012,
  usage: { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 20, output_tokens: 42 }, ...extra,
});

/** Let the service reach its spawn, then answer. */
async function answer(spawned: ReturnType<typeof harness>['spawned'], stdout: string, code = 0, stderr = '') {
  for (let i = 0; i < 50 && spawned.length === 0; i++) await new Promise((r) => setImmediate(r));
  const { child } = spawned[spawned.length - 1];
  await child.input;
  if (stdout) child.stdout.write(stdout);
  if (stderr) child.stderr.write(stderr);
  child.emit('close', code, null);
}

describe('ClaudeCliService (TEMPORARY claude-cli)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('reads a claude-cli choice from either spelling, and nothing else', () => {
    expect(claudeCliModelOf(undefined, 'claude-cli:claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(claudeCliModelOf('claude-cli', 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(claudeCliModelOf('claude', 'claude-sonnet-4-5')).toBeNull();
    expect(claudeCliModelOf('local', 'max-27b')).toBeNull();
    expect(claudeCliModelOf(undefined, 'claude:claude-cli')).toBeNull();
    expect(isClaudeCliTarget(claudeCliTarget('claude-haiku-5-5'))).toBe(true);
    expect(isClaudeCliTarget({ model: 'anthropic/claude-sonnet-4-5' })).toBe(false);
  });

  it('offers the three models in a group of their own', () => {
    const group = claudeCliGroup();
    expect(group.kind).toBe('claude-cli');
    expect(group.options.map((o) => [o.value, o.label])).toEqual([
      ['claude-cli:claude-sonnet-5-5', 'Sonnet 5.5 (Claude Code)'],
      ['claude-cli:claude-opus-5-5', 'Opus 5.5 (Claude Code)'],
      ['claude-cli:claude-haiku-5-5', 'Haiku 5.5 (Claude Code)'],
    ]);
  });

  it('builds the args: no tools, no MCP, no settings, no session, JSON out, a schema when asked', () => {
    expect(claudeCliArgs({ model: 'claude-haiku-5-5', systemPromptFile: '/tmp/s.txt' })).toEqual([
      '-p', '--model', 'claude-haiku-5-5', '--system-prompt-file', '/tmp/s.txt', '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--setting-sources', '', '--output-format', 'json',
    ]);
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const args = claudeCliArgs({ model: 'm', systemPromptFile: null, jsonSchema: schema });
    expect(args).not.toContain('--system-prompt-file');
    expect(args.slice(-2)).toEqual(['--json-schema', JSON.stringify(schema)]);
    for (const banned of ['--temperature', '--top-p', '--max-tokens']) expect(args).not.toContain(banned);
  });

  it('flattens a conversation with USER / ASSISTANT labels, and sends one user turn as it is', () => {
    expect(flattenConversation([{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }])).toEqual({ system: 'S', prompt: 'Q' });
    expect(flattenConversation([
      { role: 'system', content: 'S' }, { role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' },
    ])).toEqual({
      system: 'S',
      prompt: 'USER:\none\n\nASSISTANT:\ntwo\n\nUSER:\nthree\n\nReply as the assistant to the last USER turn.',
    });
    expect(flattenConversation([{ role: 'user', content: 'Q' }]).system).toBeNull();
  });

  it('spawns without a shell, the prompt on stdin, the system prompt in a temp file it deletes, and reads .result and .usage', async () => {
    const { service, spawned } = harness();
    const call = service.complete({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Bye?' }],
    });
    await answer(spawned, ok('Goodbye.'));
    const result = await call;
    const [{ command, args, options, child, systemPrompt }] = spawned;
    expect(command).toBe('/usr/local/bin/claude');
    expect(options.shell).toBeUndefined();
    expect(args.slice(0, 3)).toEqual(['-p', '--model', 'claude-sonnet-5-5']);
    expect(systemPrompt).toBe('You are terse.');
    const file = args[args.indexOf('--system-prompt-file') + 1];
    expect(file).toMatch(/briefcase-claude-cli-.+\.txt$/);
    expect(fs.existsSync(file)).toBe(false);
    expect(await child.input).toBe('USER:\nHi\n\nASSISTANT:\nHello\n\nUSER:\nBye?\n\nReply as the assistant to the last USER turn.');
    expect(result).toEqual({ text: 'Goodbye.', usage: { inputTokens: 1025, outputTokens: 42 }, costUsd: 0.0012, stopReason: 'end_turn' });
  });

  it('a schema goes to --json-schema and the structured output is the text', async () => {
    const { service, spawned } = harness();
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const call = service.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Name a cat.' }], format: schema });
    await answer(spawned, ok('{"name":"Miso"}', { structured_output: { name: 'Miso' } }));
    expect((await call).text).toBe('{"name":"Miso"}');
    expect(spawned[0].args).toContain('--json-schema');
  });

  it("'json' asks for the object in the prompt and lifts it out of a fenced reply", async () => {
    const { service, spawned } = harness();
    const call = service.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Tags?' }], format: 'json' });
    await answer(spawned, ok('Here:\n```json\n{"topics":["a"]}\n```'));
    expect((await call).text).toBe('{"topics":["a"]}');
    expect(await spawned[0].child.input).toMatch(/Tags\?\n\nReply with only the JSON object/);
    expect(spawned[0].args).not.toContain('--json-schema');
  });

  it('kills the child when the signal fires, and says it was cancelled', async () => {
    const { service, spawned } = harness();
    const stop = new AbortController();
    const call = service.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Long one' }], signal: stop.signal });
    for (let i = 0; i < 50 && spawned.length === 0; i++) await new Promise((r) => setImmediate(r));
    stop.abort();
    await expect(call).rejects.toMatchObject({ code: 'cancelled' });
    expect(spawned[0].child.killed).toEqual(['SIGTERM']);
  });

  it('a non-zero exit is a named failure, with the result or stderr', async () => {
    const { service, spawned } = harness();
    const call = service.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] });
    await answer(spawned, '', 1, 'Error: Invalid model name');
    await expect(call).rejects.toThrow(/exited with code 1: Error: Invalid model name/);

    const again = harness();
    const second = again.service.complete({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] });
    await answer(again.spawned, json({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }), 1);
    await expect(second).rejects.toThrow(/Not logged in/);
  });

  it('output that is not a JSON result, or an is_error result, is a failure', async () => {
    const { service, spawned } = harness();
    const call = service.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    await answer(spawned, 'plain text');
    await expect(call).rejects.toMatchObject({ code: 'bad_output' });

    const again = harness();
    const second = again.service.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    await answer(again.spawned, json({ is_error: true, result: 'API Error: 529 overloaded' }));
    await expect(second).rejects.toThrow(/529 overloaded/);
  });

  it('no binary, or a spawn that finds none, is not_installed', async () => {
    await expect(harness(null).service.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'not_installed' });
    const { service } = harness();
    service.spawnImpl = (() => {
      const child = fakeChild();
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })));
      return child as any;
    }) as any;
    const error = await service.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(error).toBeInstanceOf(ClaudeCliError);
    expect(error.code).toBe('not_installed');
  });
});

describe('AIProviderService routing (TEMPORARY claude-cli)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  /** A CrucibleChatService any touch of which fails the test. */
  function untouchableChat(touched: string[]) {
    return new Proxy({}, {
      get: (_t, name) => {
        if (name === 'then') return undefined;
        return () => {
          touched.push(String(name));
          throw new Error(`CrucibleChatService.${String(name)} was called`);
        };
      },
    }) as any;
  }

  it('a claude-cli choice never touches CrucibleChatService and sends no sampling parameter', async () => {
    const touched: string[] = [];
    const calls: any[] = [];
    const cli = { complete: async (req: any) => { calls.push(req); return { text: '{"title":"A"}', usage: { inputTokens: 10, outputTokens: 3 }, costUsd: 0.001, stopReason: 'end_turn' }; } };
    const provider = new AIProviderService(untouchableChat(touched), cli as any);
    const schema = { type: 'object' };
    const response = await provider.generateText('Title this.', { provider: 'claude-cli', model: 'claude-haiku-5-5' }, 'title', { format: schema, temperature: 0.4, maxTokens: 100 });
    expect(touched).toEqual([]);
    expect(calls).toEqual([{ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Title this.' }], format: schema }]);
    expect(response).toMatchObject({ text: '{"title":"A"}', inputTokens: 10, outputTokens: 3, provider: 'claude-cli', model: 'claude-haiku-5-5', doneReason: 'stop' });

    // The prefix inside the model string is read too.
    await provider.generateText('Again.', { provider: 'local', model: 'claude-cli:claude-opus-5-5' } as any, 'description');
    expect(touched).toEqual([]);
    expect(calls[1].model).toBe('claude-opus-5-5');
  });

  it('a cancelled claude-cli call is an AnalysisCancelledError', async () => {
    const stop = new AbortController();
    const cli = { complete: async () => { stop.abort(); throw new ClaudeCliError('cancelled', 'cancelled'); } };
    const provider = new AIProviderService(untouchableChat([]), cli as any);
    await expect(provider.generateText('x', { provider: 'claude-cli', model: 'claude-haiku-5-5' }, 'tags', { signal: stop.signal }))
      .rejects.toBeInstanceOf(AnalysisCancelledError);
  });

  it('testProvider asks only whether the binary is there', async () => {
    const provider = new AIProviderService(untouchableChat([]), { available: () => false } as any);
    expect(await provider.testProvider({ provider: 'claude-cli', model: 'claude-haiku-5-5' })).toMatchObject({ success: false });
  });
});

describe('the queue lanes and the picker (TEMPORARY claude-cli)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('a claude-cli analysis is a cloud-lane task: no upstream needed, nothing loaded, the run still opened', async () => {
    const { CrucibleLanesService, CLOUD_LANE } = await import('../queue/crucible-lanes');
    const touched: string[] = [];
    const chat = {
      effectiveTarget: () => { touched.push('effectiveTarget'); throw new Error('no'); },
      canServe: () => { touched.push('canServe'); return Promise.resolve(false); },
      withModel: () => { touched.push('withModel'); throw new Error('no'); },
      withRun: (fn: () => Promise<unknown>) => { touched.push('withRun'); return fn(); },
      parkedInRun: () => null,
    };
    const lanes = new CrucibleLanesService(
      { selected: () => 'mac' } as any,
      { reach: async () => ({ reach: 'ready', probe: { outcome: 'ok' } }) } as any,
      chat as any, {} as any, { onChange: () => () => undefined } as any, {} as any,
    );
    const target = lanes.targetOf({ options: { aiProvider: 'claude-cli', aiModel: 'claude-sonnet-5-5' } } as any);
    expect(target.model).toBe('claude-cli/claude-sonnet-5-5');
    const placed = await lanes.place(target);
    expect(placed).toEqual({ kind: 'lane', placement: { lane: CLOUD_LANE, server: 'mac', target } });
    const result = await lanes.runAdmitted({ lane: CLOUD_LANE, server: 'mac', target, signal: new AbortController().signal, localId: 'j1', onActivity: () => undefined }, async () => ({ success: true }));
    expect(result).toEqual({ success: true });
    expect(touched).toEqual(['withRun']);
  });

  it('the AI options list the Claude Code group last, with or without a Crucible, and resolve its values', async () => {
    const { CrucibleAiService } = await import('../crucible/llm/crucible-ai.service');
    const service = new CrucibleAiService({ selected: () => { throw new Error('No Crucible server is set up.'); } } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const view = await service.models(undefined, ['claude-cli:claude-opus-5-5', 'local:max-27b']);
    expect(view.groups.map((g) => g.kind)).toEqual(['claude-cli']);
    expect(view.analysisDefault).toBeNull();
    expect(view.resolved).toEqual([
      { value: 'claude-cli:claude-opus-5-5', option: 'claude-cli:claude-opus-5-5', note: null, unavailable: null },
      { value: 'local:max-27b', option: null, note: null, unavailable: 'No Crucible server is set up.' },
    ]);
  });
});
