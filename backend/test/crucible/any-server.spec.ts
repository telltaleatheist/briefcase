/**
 * ANY CRUCIBLE THAT ANSWERS (@crucible/client 1.0.25): a server that leaves
 * out every field the SDK reads as INFORMATIONAL still works end to end, and
 * the few Briefcase DEPENDS on are refused by name, never guessed.
 *
 * The fake plays that server with `omit` (INFORMATIONAL_FIELDS: versions,
 * host facts, model family/size/install, timings, counts, progress fractions,
 * upload digests, reasons). What each absence becomes is pinned here:
 * unknown in a sentence, a row left out of a match, a skipped statistic — or,
 * for chat `usage.prompt_tokens` and `finish_reason`, a model's analysis
 * context and the host backend a module is filtered to, a failure that names
 * the field. Decide `logprobs` is read from `probabilities` (its source).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleCoordinationService } from '../../src/crucible/coordinate.service';
import { CrucibleFieldMissing } from '../../src/crucible/errors';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleAiService } from '../../src/crucible/llm/crucible-ai.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleScorerService } from '../../src/scorer/crucible-scorer.service';
import { ScorerError } from '../../src/scorer/scorer.types';
import {
  INFORMATIONAL_FIELDS,
  informationalExcept,
  startFakeCrucible,
  stockedForBriefcase,
  type FakeCrucible,
  type FakeCrucibleOptions,
} from '../fake-crucible/fake-crucible';
import { harness } from './harness';
import { pairingHost, tempDir } from './helpers';

Logger.overrideLogger(false);

const savedEnv = { ...process.env };
const open: FakeCrucible[] = [];

beforeEach(() => {
  process.env = { ...savedEnv, APPDATA: tempDir('any-server-appdata-') };
});
afterEach(async () => {
  process.env = savedEnv;
  await Promise.all(open.splice(0).map((f) => f.close()));
});

async function rig(options: FakeCrucibleOptions = {}) {
  const fake = await startFakeCrucible({
    models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 }],
    upstreams: { anthropic: { key: 'sk-ant-1234' } },
    chatReplies: { '*': 'Cooking\nTravel' },
    omit: INFORMATIONAL_FIELDS,
    ...options,
  });
  open.push(fake);
  const h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes);
  chat.heartbeatMs = 40;
  return { fake, h, servers, chat };
}

describe('a server that states no informational field', () => {
  it('probes ready: version, host and GPU read as unknown, never as an old server', async () => {
    const { h } = await rig();
    const answer = await h.probes.test('mac');
    expect(answer.reach).toBe('ready');
    if (answer.probe.outcome !== 'ok') throw new Error(`probe: ${answer.probe.outcome}`);
    expect(answer.probe.facts).toMatchObject({
      version: null, platform: null, arch: null, backend: null, gpu: null, needsUpdate: false, busyLine: null,
    });
    // The capability rows keep their load-bearing facts; the reason is simply unstated.
    expect(answer.probe.facts.capabilities).toContainEqual({ capability: 'analysis', enabled: true, selected: 'qwen3.5-9b', route: 'local', reason: null });
  });

  it('lists its chat models: loadable, so offered, with the size shown as unknown, never hidden or guessed', async () => {
    const { h, servers, chat } = await rig();
    const ai = new CrucibleAiService(servers, h.probes, h.settings, chat, { keysForCopy: () => ({}) } as never, pairingHost(null));
    const view = await ai.models();
    expect(view.unavailable).toBeNull();
    expect(view.groups.find((g) => g.kind === 'server')?.options[0]).toEqual({
      value: 'local:qwen3.5-9b', label: 'qwen3.5-9b', group: 'server', sizeB: null, resident: false, serverChoice: true,
    });
    expect(view.upstreams?.anthropic).toEqual({ configured: true, keyHint: '…1234' });
  });

  it('runs a local chat: the unstated install goes to the load, which the server answers', async () => {
    const { fake, chat } = await rig();
    const provider = new AIProviderService(chat);
    const response = await provider.generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter');
    expect(response.text).toContain('Cooking');
    // usage was not stated: the counts add nothing, and are not invented.
    expect(response).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(fake.resident()).toBe('qwen3.5-9b');
  });

  it('an ollama: choice with no stated family or size is not matched to a local model: it stays on the ollama/ upstream', async () => {
    const { chat } = await rig({ upstreams: { ollama: { url: 'http://127.0.0.1:11434' } } });
    const chosen = await chat.effectiveTarget({ model: 'ollama/qwen3.5:9b', route: 'upstream', upstream: 'ollama', bareModel: 'qwen3.5:9b' });
    expect(chosen.mappedFrom).toBeNull();
    expect(chosen.target.model).toBe('ollama/qwen3.5:9b');
  });

  it('scores decisions: the decide class\'s own selection is used, and model/timing/tokens come back unknown, not zero', async () => {
    const { servers, chat } = await rig();
    const scorer = new CrucibleScorerService(chat, servers);
    const res = await chat.withRun(() => scorer.withScorer((sh) => sh.decide({
      state: 'Some cooking talk.',
      questions: [
        { type: 'choice', name: 'topic', instructions: 'Which?', options: [{ name: 'cooking', description: 'Cooking' }, { name: 'travel', description: 'Travel' }] },
        { type: 'yesno', name: 'ad', instructions: 'An ad?' },
      ],
    })));
    expect(res.model).toBeNull();
    expect(res.timingMs).toEqual({ total: null, perQuestion: {} });
    expect(res.tokens).toEqual({ perQuestion: {}, images: null });
    expect(res.answers['topic']).toMatchObject({ type: 'choice', choice: 'cooking' });
    expect(res.answers['ad'].type).toBe('yesno');
  });

  it('transcribes: no digest on the upload, no fraction on the frames, and the SRT is written', async () => {
    const { h, fake } = await rig({ installedJobTypes: ['echo', 'llm', 'asr'], asrInstalled: ['mlx-whisper-large-v3'] });
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
    svc.configDir = () => h.dir;
    svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
    const video = path.join(tempDir('any-server-video-'), 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(16 * 1024, 3));
    const outDir = tempDir('any-server-out-');
    const seen: Array<{ percent: number; message: string }> = [];
    const outcome = await svc.transcribe({
      server: 'mac', model: 'mlx-whisper-large-v3', videoFile: video, outputDir: outDir, baseName: 'a', localId: 'a',
      onProgress: (percent, message) => seen.push({ percent, message }),
    });
    expect(outcome.cues).toBe(3);
    expect(fs.existsSync(outcome.srtFile)).toBe(true);
    expect(fake.jobs[0].status).toBe('done');
    // A frame with no fraction leaves the bar where the server last put it: never backwards.
    const percents = seen.map((s) => s.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(seen).toContainEqual({ percent: 15, message: 'Transcribing on mac... 00:15:00 of 01:00:00' });
    // A warming frame with no line still says what is happening.
    expect(seen).toContainEqual({ percent: 9, message: 'Crucible on mac: loading the model...' });
  });

  it('coordination with the host backend unstated is refused BY NAME: a module can\'t be filtered to a guess', async () => {
    const { h, fake } = await rig(stockedForBriefcase());
    const service = new CrucibleCoordinationService(h.registry, h.factory, h.dir);
    service.deps = { sleep: async () => undefined, now: () => '2026-09-23T12:00:00Z' };
    const state = await service.request('mac', 'a spec asked');
    expect(state).toMatchObject({ phase: 'unreachable' });
    expect(state.phase === 'unreachable' && state.message).toBe(
      '"mac" did not state backendKind (GET /v1/capability), which Briefcase needs to work out which parts of its module this machine needs',
    );
    expect(fake.requestsTo('/v1/tasks', 'POST')).toHaveLength(0);
  });

  it('coordination with only the backend stated works on everything else unstated', async () => {
    const { h } = await rig({
      ...stockedForBriefcase(),
      omit: informationalExcept({ 'GET /v1/info': ['host.backend'], 'GET /v1/capability': ['backend_kind'] }),
    });
    const service = new CrucibleCoordinationService(h.registry, h.factory, h.dir);
    service.deps = { sleep: async () => undefined, now: () => '2026-09-23T12:00:00Z' };
    const state = await service.request('mac', 'a spec asked');
    expect(state).toMatchObject({ phase: 'stocked', unmet: [] });
  });
});

describe('what Briefcase depends on is refused by name', () => {
  it('a decide answer with no logprobs is read from its probabilities (the server\'s own ln): the same scores as with them', async () => {
    const ask = {
      state: 's',
      questions: [
        { type: 'choice' as const, name: 'topic', instructions: 'Which?', options: [{ name: 'cooking', description: 'Cooking' }, { name: 'travel', description: 'Travel' }, { name: 'none', description: 'None' }] },
        { type: 'score' as const, name: 'level', instructions: 'How much?', levels: ['low', 'mid', 'high'] },
      ],
    };
    // 'none' at probability exactly 0: the server's null-for-0 and ln(0) = -Infinity read alike.
    const decideProbs = (q: { labels: string[] }) => Object.fromEntries(q.labels.map((l, i) => [l, [0.7, 0.25, 0][i]]));
    const run = async (omit: FakeCrucibleOptions['omit']) => {
      const { servers, chat } = await rig({ omit, decideProbs });
      const scorer = new CrucibleScorerService(chat, servers);
      return chat.withRun(() => scorer.withScorer((sh) => sh.decide(ask)));
    };
    const stated = await run({});
    const derived = await run({ 'POST /v1/decide': ['answers.*.logprobs'] });
    // The fake rounds the logprobs it sends to 6 places, as JSON does: equal to that.
    for (const name of ['topic', 'level']) {
      derived.answers[name].logProbs.forEach((lp, i) => expect(lp).toBeCloseTo(stated.answers[name].logProbs[i], 5));
      for (const [label, p] of Object.entries(stated.answers[name].probabilities)) expect(derived.answers[name].probabilities[label]).toBeCloseTo(p, 5);
    }
    expect(derived.answers['topic']).toMatchObject({ type: 'choice', choice: 'cooking' });
  });

  it('a yes/no answer needs no logprobs (its p is load-bearing and stated)', async () => {
    const { servers, chat } = await rig({ omit: { 'POST /v1/decide': ['answers.*.logprobs', 'answers.*.logprob'] } });
    const scorer = new CrucibleScorerService(chat, servers);
    const res = await chat.withRun(() => scorer.withScorer((sh) => sh.decide({ state: 's', questions: [{ type: 'yesno', name: 'ad', instructions: 'An ad?' }] })));
    expect(res.answers['ad'].type).toBe('yesno');
  });

  it('an analysis window the server states nowhere is refused BY NAME, never sized with an invented number', async () => {
    const { chat } = await rig();
    const err = await new AIProviderService(chat).crucibleContextWindow('qwen3.5-9b').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleFieldMissing);
    expect((err as CrucibleFieldMissing).field).toMatch(/maxModelLen \/ contextDefault .*context_ceilings/);
  });

  it('a row with no stated context but a stated host ceiling: sized at the ceiling (capped at 32K), and the chat LOADS it there', async () => {
    const { chat, fake } = await rig({
      omit: informationalExcept({ 'GET /v1/capability': ['classes[].context_ceilings'] }),
      contextCeilings: { 'qwen3.5-9b': 24576 },
    });
    const provider = new AIProviderService(chat);
    await expect(provider.crucibleContextWindow('qwen3.5-9b')).resolves.toBe(24576);
    await provider.generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter');
    expect(fake.residentContext()).toBe(24576);
  });

  it('a chat reply with no finish_reason is refused by name (a missing one would hide truncation)', async () => {
    const { chat } = await rig({ omit: { 'POST /v1/openai/chat/completions': ['choices[].finish_reason'] } });
    await expect(new AIProviderService(chat).generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter'))
      .rejects.toThrow(/choices\[0\]\.finish_reason/);
  });

  it('countTokens with no usage.prompt_tokens on the chat fails naming the field, never counting 0', async () => {
    const { servers, chat } = await rig({ omit: { 'POST /v1/openai/chat/completions': ['usage.prompt_tokens'] } });
    const scorer = new CrucibleScorerService(chat, servers);
    const err = await chat.withRun(() => scorer.withScorer((sh) => sh.countTokens('one two three'))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScorerError);
    expect((err as ScorerError).message).toMatch(/prompt_tokens/);
  });
});
