/**
 * CrucibleChatService against the fake Crucible: venue by rank, load-model +
 * lease + heartbeat + release, model_not_resident recovery, chat_queue_full
 * with Retry-After, the typed busy error on 409, cancel mid-request and
 * mid-load, and exactly what each body carried.
 */
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleBusyError, CrucibleChatCancelled, CrucibleChatError, CrucibleNoVenueError } from '../../src/crucible/llm/errors';
import { CLOUD_FORBIDDEN_KEYS } from '../../src/crucible/llm/target';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible, type FakeCrucibleOptions } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';

function chatService(h: Harness): CrucibleChatService {
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes);
  chat.heartbeatMs = 40;
  return chat;
}

const MODELS: FakeCrucibleOptions['models'] = [
  { id: 'qwen3.5-9b', paramsB: 9 },
  { id: 'qwen3.5-4b', paramsB: 4 },
  { id: 'qwen3.8-27b', paramsB: 27, installed: false },
];

describe('CrucibleChatService: one server', () => {
  let fake: FakeCrucible;
  let h: Harness;
  let chat: CrucibleChatService;

  async function start(options: FakeCrucibleOptions = {}): Promise<void> {
    fake = await startFakeCrucible({ models: MODELS, upstreams: { anthropic: { key: 'sk-ant-9999' }, openai: { key: 'sk-oa-8888' }, ollama: { url: 'http://127.0.0.1:11434' } }, ...options });
    h = harness();
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    chat = chatService(h);
  }
  afterEach(() => fake.close());

  it('an upstream is forwarded as is: no load, no lease, the act header, usage and the sampling audit', async () => {
    await start();
    const result = await chat.chat({ model: 'claude:claude-sonnet-5', prompt: 'hello', temperature: 0.4, maxTokens: 50, responseFormat: 'json' });
    expect(result).toMatchObject({ text: '{"ok":true}', server: 'mac', model: 'anthropic/claude-sonnet-5', finishReason: 'stop' });
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(result.sampling?.['max_tokens']).toBe('upstream default 4096');
    const [body] = fake.chatBodies();
    for (const key of CLOUD_FORBIDDEN_KEYS) expect(body).not.toHaveProperty(key);
    expect(body).not.toHaveProperty('response_format');
    expect(fake.requestsTo('/v1/openai/chat/completions')[0].headers['x-crucible-act']).toBe('analysis');
    expect(fake.jobs).toHaveLength(0);
    expect(fake.leases.taken).toHaveLength(0);
  });

  it('an unconfigured upstream is a clear error naming the fix', async () => {
    await start({ upstreams: {} });
    const failure = await chat.chat({ model: 'openai/gpt-5.1', prompt: 'x' }).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleChatError);
    expect(failure).toMatchObject({ code: 'upstream_unconfigured', status: 409 });
    expect(failure.message).toMatch(/Settings › AI/);
  });

  it('a local model that is not resident is loaded first (outside a run: no lease)', async () => {
    await start();
    const result = await chat.chat({ model: 'local:qwen3.5-9b', prompt: 'x', temperature: 0.15, responseFormat: 'json' });
    expect(result.text).toBe('{"ok":true}');
    expect(fake.jobs.map((j) => [j.type, j.model, j.params])).toEqual([['load-model', 'qwen3.5-9b', {}]]);
    expect(fake.resident()).toBe('qwen3.5-9b');
    expect(fake.chatBodies()[0]).toMatchObject({ model: 'qwen3.5-9b', temperature: 0.15, response_format: { type: 'json_object' } });
    expect(fake.chatBodies()[0]).not.toHaveProperty('chat_template_kwargs');
  });

  it('withModel: load with a lease, heartbeat it, release it when the run ends', async () => {
    await start();
    await chat.withModel(undefined, 'qwen3.5-9b', async (held) => {
      expect(held).toMatchObject({ server: 'mac', model: 'qwen3.5-9b' });
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'one' });
      await new Promise((r) => setTimeout(r, 130));
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'two' });
      expect(chat.heldInRun()).toEqual([{ server: 'mac', model: 'qwen3.5-9b', leaseId: 'lease-1' }]);
    });
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0].params).toEqual({ lease: { act: 'analysis', ttl_seconds: 120 } });
    expect(fake.leases.taken).toEqual([{ leaseId: 'lease-1', model: 'qwen3.5-9b', act: 'analysis', ttlSeconds: 120 }]);
    expect(fake.requestsTo('/v1/leases/lease-1/heartbeat').length).toBeGreaterThanOrEqual(2);
    expect(fake.leases.released).toEqual(['lease-1']);
    expect(fake.openLease()).toBeNull();
  });

  it('an already-resident model is leased without a load', async () => {
    await start({ resident: 'qwen3.5-9b' });
    await chat.withRun(() => chat.chat({ model: 'qwen3.5-9b', prompt: 'x' }));
    expect(fake.jobs).toHaveLength(0);
    expect(fake.leases.taken.map((l) => l.model)).toEqual(['qwen3.5-9b']);
    expect(fake.leases.released).toEqual(['lease-1']);
  });

  it('a run that switches models releases the first lease before loading the second', async () => {
    await start();
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      await chat.chat({ model: 'qwen3.5-4b', prompt: 'b' });
    });
    expect(fake.jobs.map((j) => j.model)).toEqual(['qwen3.5-9b', 'qwen3.5-4b']);
    expect(fake.leases.released).toEqual(['lease-1', 'lease-2']);
  });

  it('model_not_resident mid-run (another load evicted it): re-load once, retry, and carry on', async () => {
    await start();
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      fake.setResident('qwen3.5-4b'); // someone else's load; drops our lease
      const again = await chat.chat({ model: 'qwen3.5-9b', prompt: 'b' });
      expect(again.text).toBe('{"ok":true}');
    });
    expect(fake.jobs.map((j) => j.model)).toEqual(['qwen3.5-9b', 'qwen3.5-9b']);
    expect(fake.requestsTo('/v1/openai/chat/completions').map((r) => r.fault ?? 'ok')).toHaveLength(3);
  });

  it('a lost lease (heartbeat unknown_lease) is re-taken before the next chat', async () => {
    await start();
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      fake.expireLease();
      await new Promise((r) => setTimeout(r, 100));
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'b' });
    });
    expect(fake.leases.taken.map((l) => l.leaseId)).toEqual(['lease-1', 'lease-2']);
    expect(fake.leases.released).toEqual(['lease-2']);
  });

  it('REGRESSION: one failed heartbeat (a 503) keeps the lease: the next beat renews it and the run ends by releasing it', async () => {
    await start({ faults: { refuse: [{ match: { method: 'POST', path: /\/heartbeat$/ }, status: 503, code: 'engine_unavailable', times: 1 }] } });
    chat.heartbeatRetryMs = 10;
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      await new Promise((r) => setTimeout(r, 120));
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'b' });
      expect(chat.heldInRun()).toEqual([{ server: 'mac', model: 'qwen3.5-9b', leaseId: 'lease-1' }]);
    });
    const beats = fake.requestsTo('/v1/leases/lease-1/heartbeat').map((r) => r.fault ?? 'ok');
    expect(beats[0]).toBe('503 engine_unavailable');
    expect(beats.slice(1)).toContain('ok');
    expect(fake.leases.taken.map((l) => l.leaseId)).toEqual(['lease-1']);
    expect(fake.leases.released).toEqual(['lease-1']);
    expect(fake.openLease()).toBeNull();
  });

  it('REGRESSION: heartbeats failing past the TTL budget: the lease is released best-effort and re-taken before the next call', async () => {
    await start({ faults: { refuse: [{ match: { method: 'POST', path: /\/heartbeat$/ }, status: 503, code: 'engine_unavailable', times: 1_000 }] } });
    chat.heartbeatRetryMs = 10;
    chat.leaseTtlMs = 150;
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      await new Promise((r) => setTimeout(r, 300));
      // Given up by now: the old lease was handed back, not left open unheartbeaten.
      expect(fake.leases.released).toContain('lease-1');
      fake.faults.refuse = [];
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'b' });
      // Never chatting knowingly unleased: the call re-took one first.
      expect(chat.heldInRun()).toEqual([{ server: 'mac', model: 'qwen3.5-9b', leaseId: 'lease-2' }]);
    });
    expect(fake.leases.taken.map((l) => l.leaseId)).toEqual(['lease-1', 'lease-2']);
    expect(fake.leases.released).toEqual(['lease-1', 'lease-2']);
    expect(fake.openLease()).toBeNull();
  });

  it('REGRESSION: a given-up lease the server still holds (its release failed) is taken back, not chatted "under another app"', async () => {
    await start({ faults: { refuse: [
      { match: { method: 'POST', path: /\/heartbeat$/ }, status: 503, code: 'engine_unavailable', times: 1_000 },
      { match: { method: 'DELETE', path: /^\/v1\/leases\// }, status: 503, code: 'engine_unavailable', times: 1 },
    ] } });
    chat.heartbeatRetryMs = 10;
    chat.leaseTtlMs = 150;
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      await new Promise((r) => setTimeout(r, 300));
      expect(fake.openLease()?.leaseId).toBe('lease-1');
      // Heartbeats answer again; the release before re-taking still can't be sent.
      fake.faults.refuse = [{ match: { method: 'DELETE', path: /^\/v1\/leases\// }, status: 503, code: 'engine_unavailable', times: 1 }];
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'b' });
      expect(chat.heldInRun()).toEqual([{ server: 'mac', model: 'qwen3.5-9b', leaseId: 'lease-1' }]);
    });
    expect(fake.leases.taken.map((l) => l.leaseId)).toEqual(['lease-1']);
    expect(fake.openLease()).toBeNull();
  });

  it('503 chat_queue_full is retried after the server\'s Retry-After, read from the raw response', async () => {
    await start({ resident: 'qwen3.5-9b', faults: { refuse: [{ match: { method: 'POST', path: '/v1/openai/chat/completions' }, status: 503, code: 'chat_queue_full', retryAfter: 0.3, times: 2 }] } });
    const began = Date.now();
    const result = await chat.chat({ model: 'qwen3.5-9b', prompt: 'x' });
    expect(result.attempts).toBe(3);
    expect(Date.now() - began).toBeGreaterThanOrEqual(550);
    expect(fake.requestsTo('/v1/openai/chat/completions').map((r) => r.fault ?? 'ok')).toEqual(['503 chat_queue_full', '503 chat_queue_full', 'ok']);
  });

  it('a 429 from the provider passes through with its Retry-After (no retry here)', async () => {
    await start({ faults: { refuse: [{ match: { path: '/v1/openai/chat/completions' }, status: 429, code: 'upstream_rate_limited', retryAfter: 7, times: 1 }] } });
    const failure = await chat.chat({ model: 'anthropic/claude-x', prompt: 'x' }).catch((e) => e);
    expect(failure).toMatchObject({ code: 'upstream_rate_limited', status: 429, retryAfterMs: 7000 });
  });

  it('409 server_busy on the load is a typed busy error with the holder\'s sentence', async () => {
    await start();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.42 } });
    const failure = await chat.chat({ model: 'qwen3.5-9b', prompt: 'x' }).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleBusyError);
    expect(failure.server).toBe('mac');
    expect(failure.busyLine).toMatch(/bookforge/);
  });

  it('busyWait asks again until the card frees, telling the caller each time', async () => {
    await start();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.5 } });
    setTimeout(() => fake.inject({}), 150);
    const waits: string[] = [];
    const result = await chat.chat({ model: 'qwen3.5-9b', prompt: 'x', busyWait: { everyMs: 50, forMs: 5_000, onWait: (line) => waits.push(line) } });
    expect(result.text).toBe('{"ok":true}');
    expect(waits.length).toBeGreaterThanOrEqual(1);
  });

  it('another app\'s lease on a DIFFERENT model is busy; on OUR model we chat under it', async () => {
    await start();
    fake.leaseAsOther('qwen3.5-4b', 'bookforge');
    const failure = await chat.withRun(() => chat.chat({ model: 'qwen3.5-9b', prompt: 'x' })).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleBusyError);
    fake.leaseAsOther('qwen3.5-9b', 'bookforge');
    const ok = await chat.withRun(() => chat.chat({ model: 'qwen3.5-9b', prompt: 'x' }));
    expect(ok.text).toBe('{"ok":true}');
  });

  it('a model not downloaded on the server fails by name, without a load', async () => {
    await start();
    const failure = await chat.chat({ model: 'qwen3.8-27b', prompt: 'x' }).catch((e) => e);
    expect(failure).toMatchObject({ code: 'model_not_installed' });
    expect(fake.jobs).toHaveLength(0);
  });

  it('a failed load is an error with the server\'s words', async () => {
    await start();
    fake.inject({ failLoadWith: { code: 'engine_failed', message: 'out of memory' } });
    await expect(chat.chat({ model: 'qwen3.5-9b', prompt: 'x' })).rejects.toThrow(/out of memory/);
  });

  it('cancel mid-request aborts the open chat at once, and the run still releases its lease', async () => {
    await start();
    const controller = new AbortController();
    const began = Date.now();
    const run = chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'warm' });
      fake.inject({ chatDelayMs: 5_000 });
      setTimeout(() => controller.abort(), 50);
      return chat.chat({ model: 'qwen3.5-9b', prompt: 'long', signal: controller.signal });
    });
    await expect(run).rejects.toBeInstanceOf(CrucibleChatCancelled);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(fake.leases.released).toEqual(['lease-1']);
  });

  it('cancel mid-load cancels the load job on the server', async () => {
    await start({ loadMs: 3_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(chat.chat({ model: 'qwen3.5-9b', prompt: 'x', signal: controller.signal })).rejects.toBeInstanceOf(CrucibleChatCancelled);
    expect(fake.requestsTo('/v1/jobs/job-1', 'DELETE')).toHaveLength(1);
    expect(fake.jobs[0].status).toBe('cancelled');
    expect(fake.chatBodies()).toHaveLength(0);
  });

  it('REGRESSION: a cancel landing as a leased load finishes releases the lease the load took', async () => {
    await start({ loadMs: 100 });
    const controller = new AbortController();
    const touch = (chat as unknown as { touch: () => void }).touch.bind(chat);
    (chat as unknown as { touch: () => void }).touch = () => {
      if (fake.jobs[0]?.status === 'done') controller.abort();
      touch();
    };
    const run = chat.withRun(() => chat.chat({ model: 'qwen3.5-9b', prompt: 'x', signal: controller.signal }));
    await expect(run).rejects.toBeInstanceOf(CrucibleChatCancelled);
    expect(fake.leases.taken.map((l) => l.leaseId)).toEqual(['lease-1']);
    expect(fake.leases.released).toEqual(['lease-1']);
    expect(fake.chatBodies()).toHaveLength(0);
  });

  it('REGRESSION: a cancel landing as an unleased load finishes unloads the model it put on the card', async () => {
    await start({ loadMs: 100 });
    const controller = new AbortController();
    const touch = (chat as unknown as { touch: () => void }).touch.bind(chat);
    (chat as unknown as { touch: () => void }).touch = () => {
      if (fake.jobs[0]?.status === 'done') controller.abort();
      touch();
    };
    await expect(chat.chat({ model: 'qwen3.5-9b', prompt: 'x', signal: controller.signal })).rejects.toBeInstanceOf(CrucibleChatCancelled);
    expect(fake.jobs.map((j) => j.type)).toEqual(['load-model', 'unload-model']);
    expect(fake.leases.taken).toHaveLength(0);
    expect(fake.chatBodies()).toHaveLength(0);
  });

  it('REGRESSION: a load whose event stream drops is followed again after the last event seen (Last-Event-ID)', async () => {
    await start({ loadMs: 200 });
    chat.loadStreamRetry = { firstMs: 10, maxMs: 20, budgetMs: 2_000 };
    fake.faults.resetAfterBytes = [{ match: { method: 'GET', path: /\/v1\/jobs\/[^/]+\/events$/ }, afterBytes: 45, times: 1 }];
    const result = await chat.withRun(() => chat.chat({ model: 'qwen3.5-9b', prompt: 'x' }));
    expect(result.text).toBe('{"ok":true}');
    const streams = fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}/events`, 'GET');
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(streams[0].fault).toMatch(/reset/);
    expect(Number(streams[1].headers['last-event-id'])).toBeGreaterThan(0);
    expect(fake.jobs).toHaveLength(1);
  });

  it('REGRESSION: a load stream lost past its budget is "unreachable" (the queue parks on it), and the load is cancelled', async () => {
    await start({ loadMs: 200 });
    chat.loadStreamRetry = { firstMs: 10, maxMs: 20, budgetMs: 60 };
    fake.faults.resetAfterBytes = [{ match: { method: 'GET', path: /\/v1\/jobs\/[^/]+\/events$/ }, afterBytes: 0 }];
    const failure = await chat.withRun(() => chat.chat({ model: 'qwen3.5-9b', prompt: 'x' })).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleChatError);
    expect(failure).toMatchObject({ code: 'unreachable', server: 'mac' });
    expect(fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}/events`, 'GET').length).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}`, 'DELETE')).toHaveLength(1);
  });

  it('an already-aborted signal sends nothing', async () => {
    await start();
    const controller = new AbortController();
    controller.abort();
    await expect(chat.chat({ model: 'anthropic/claude-x', prompt: 'x', signal: controller.signal })).rejects.toBeInstanceOf(CrucibleChatCancelled);
    expect(fake.chatBodies()).toHaveLength(0);
  });

  it('P6: an ollama/ chat states its window as context_tokens on 1.0.24, and the server\'s X-Crucible-Context comes back', async () => {
    await start();
    const result = await chat.chat({ model: 'ollama:qwen3:14b', prompt: 'hello', temperature: 0.15, contextTokens: 16384 });
    expect(fake.chatBodies().at(-1)).toMatchObject({ model: 'ollama/qwen3:14b', context_tokens: 16384 });
    expect(result.context).toEqual({ num_ctx: 16384, source: 'request' });
    // Never on a local model or a cloud upstream.
    await chat.chat({ model: 'local:qwen3.5-9b', prompt: 'hello', contextTokens: 16384 });
    await chat.chat({ model: 'claude:claude-sonnet-5', prompt: 'hello', contextTokens: 16384 });
    expect(fake.chatBodies().slice(1).some((b) => 'context_tokens' in b)).toBe(false);
  });

  it('P6 version gate: a Crucible older than 1.0.24 is sent no context_tokens', async () => {
    await start({ version: '1.0.23' });
    const result = await chat.chat({ model: 'ollama:qwen3:14b', prompt: 'hello', contextTokens: 16384 });
    expect(fake.chatBodies().at(-1)).not.toHaveProperty('context_tokens');
    expect(result.context).toBeNull();
  });

  it('P6: 400 upstream_field_unsupported is an error by name, saying Ollama cannot take the field', async () => {
    await start({ faults: { refuse: [{ match: { path: '/v1/openai/chat/completions' }, status: 400, code: 'upstream_field_unsupported', message: 'seed cannot cross to /api/chat' }] } });
    const err = await chat.chat({ model: 'ollama:qwen3:14b', prompt: 'hello' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleChatError);
    expect(err).toMatchObject({ code: 'upstream_field_unsupported' });
    expect((err as Error).message).toMatch(/cannot carry that field to Ollama/);
  });

  it('P6: a chat names its act, and states thinking only for a local model', async () => {
    await start();
    await chat.chat({ model: 'local:qwen3.5-9b', prompt: 'outline', act: 'generate', thinking: false, maxTokens: 64, temperature: 0 });
    const req = fake.requestsTo('/v1/openai/chat/completions', 'POST').at(-1)!;
    expect(req.headers['x-crucible-act']).toBe('generate');
    expect(req.body).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, max_tokens: 64, temperature: 0 });
    await chat.chat({ model: 'ollama:qwen3:14b', prompt: 'x', thinking: false });
    expect(fake.chatBodies().at(-1)).not.toHaveProperty('chat_template_kwargs');
    expect(fake.requestsTo('/v1/openai/chat/completions', 'POST').at(-1)!.headers['x-crucible-act']).toBe('analysis');
  });

  it('P6: loadContext loads at that context, and a resident model under it is reloaded larger (never chatted past its window)', async () => {
    await start({ resident: 'qwen3.5-9b', models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 }] });
    await chat.withModel('mac', 'local:qwen3.5-9b', async () => {
      await chat.chat({ model: 'local:qwen3.5-9b', prompt: 'x', loadContext: 32768 });
      // Held at 32K now: a second call needs no reload.
      await chat.chat({ model: 'local:qwen3.5-9b', prompt: 'y', loadContext: 32768 });
    });
    const loads = fake.jobs.filter((j) => j.type === 'load-model');
    expect(loads.map((j) => j.params['context'])).toEqual([32768]);
    expect(fake.residentContext()).toBe(32768);
    expect(fake.leases.released).toEqual(fake.leases.taken.map((l) => l.leaseId));
  });

  it('P6: a load context over the host ceiling is refused by name before anything is evicted', async () => {
    await start({ contextCeilings: { 'qwen3.5-9b': 65536 } });
    const err = await chat.withModel('mac', 'local:qwen3.5-9b', async () => undefined, { loadContext: 131072 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'context_over_limit' });
    expect(fake.resident()).toBeNull();
  });

  it('structured output from a reasoning channel: content empty, reasoning carries the object', async () => {
    await start({ resident: 'qwen3.5-9b', chatReplies: { 'qwen3.5-9b': { content: '', reasoning: '{"quote":"here"}' } } });
    const structured = await chat.chat({ model: 'qwen3.5-9b', prompt: 'x', responseFormat: 'json' });
    expect(structured).toMatchObject({ text: '{"quote":"here"}', fromReasoning: true });
    const prose = await chat.chat({ model: 'qwen3.5-9b', prompt: 'x' });
    expect(prose).toMatchObject({ text: '', fromReasoning: false });
  });
});

describe('CrucibleChatService: venue is the selected server', () => {
  const fakes: FakeCrucible[] = [];
  afterEach(async () => { await Promise.all(fakes.splice(0).map((f) => f.close())); });

  it('an unreachable selected server is a no-venue error naming it; the work never moves to another server', async () => {
    const pc = await startFakeCrucible({ models: MODELS, name: 'pc' });
    fakes.push(pc);
    const h = harness();
    h.registry.add({ name: 'gone', url: await unusedLoopbackUrl(), token: 'tok-gone-000000000000' });
    h.registry.add({ name: 'pc', url: pc.url, token: pc.token });
    const failure = await chatService(h).chat({ model: 'qwen3.5-9b', prompt: 'x' }).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleNoVenueError);
    expect(failure.message).toMatch(/gone/);
    expect(pc.chatBodies()).toHaveLength(0);
  });

  it('an upstream the selected server lacks is asked of it anyway (its refusal names the fix), never of a server that has it', async () => {
    const mac = await startFakeCrucible({ models: MODELS, name: 'mac' });
    const pc = await startFakeCrucible({ models: MODELS, name: 'pc', upstreams: { anthropic: { key: 'sk-ant-1234' } } });
    fakes.push(mac, pc);
    const h = harness();
    h.registry.add({ name: 'mac', url: mac.url, token: mac.token });
    h.registry.add({ name: 'pc', url: pc.url, token: pc.token });
    await chatService(h).chat({ model: 'anthropic/claude-x', prompt: 'x' }).catch(() => undefined);
    expect(pc.chatBodies()).toHaveLength(0);
  });

  it('work moves only when the user selects another server', async () => {
    const mac = await startFakeCrucible({ models: MODELS, name: 'mac' });
    const pc = await startFakeCrucible({ models: MODELS, name: 'pc' });
    fakes.push(mac, pc);
    const h = harness();
    h.registry.add({ name: 'mac', url: mac.url, token: mac.token });
    h.registry.add({ name: 'pc', url: pc.url, token: pc.token });
    const chat = chatService(h);
    expect((await chat.chat({ model: 'qwen3.5-9b', prompt: 'x' })).server).toBe('mac');
    h.registry.select('pc');
    expect((await chat.chat({ model: 'qwen3.5-4b', prompt: 'x' })).server).toBe('pc');
  });

  it('nothing answering is a no-venue error that names the server', async () => {
    const h = harness();
    h.registry.add({ name: 'gone', url: await unusedLoopbackUrl(), token: 'tok-gone-000000000000' });
    const failure = await chatService(h).chat({ model: 'qwen3.5-9b', prompt: 'x' }).catch((e) => e);
    expect(failure).toBeInstanceOf(CrucibleNoVenueError);
    expect(failure.message).toMatch(/gone/);
  });

  it('a run keeps its model on the server it started on', async () => {
    const mac = await startFakeCrucible({ models: MODELS, name: 'mac' });
    const pc = await startFakeCrucible({ models: MODELS, name: 'pc' });
    fakes.push(mac, pc);
    const h = harness();
    h.registry.add({ name: 'mac', url: mac.url, token: mac.token });
    h.registry.add({ name: 'pc', url: pc.url, token: pc.token });
    const chat = chatService(h);
    await chat.withRun(async () => {
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'a' });
      h.registry.select('pc');
      await chat.chat({ model: 'qwen3.5-9b', prompt: 'b' });
    });
    expect(mac.chatBodies()).toHaveLength(2);
    expect(pc.chatBodies()).toHaveLength(0);
  });
});
