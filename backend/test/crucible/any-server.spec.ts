/**
 * ANY CRUCIBLE THAT ANSWERS (@crucible/client 1.0.72): a server that leaves
 * out every field the SDK still reads as INFORMATIONAL works end to end, and
 * the chat facts Briefcase DEPENDS on are refused by name, never guessed.
 *
 * 1.0.72 made most facts required (versions, host and GPU, model size and
 * context, capability sizing, decide timings and logprobs): a server without
 * them is the SDK's protocol error, so the cases that pinned Briefcase's
 * reading of their absence are gone with them. What can still be left out
 * (INFORMATIONAL_FIELDS: capability model revisions, activity timings, a
 * model's reason, chat id/model/usage, progress lines) is played by the fake's
 * `omit`; chat `usage.prompt_tokens` and `finish_reason` fail by name.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleCoordinationService } from '../../src/crucible/coordinate.service';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleAiService } from '../../src/crucible/llm/crucible-ai.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleScorerService } from '../../src/scorer/crucible-scorer.service';
import { ScorerError } from '../../src/scorer/scorer.types';
import {
  INFORMATIONAL_FIELDS,
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

describe('a server that states only what 1.0.72 requires', () => {
  it('probes ready, with its capability rows', async () => {
    const { h } = await rig();
    const answer = await h.probes.test('mac');
    expect(answer.reach).toBe('ready');
    if (answer.probe.outcome !== 'ok') throw new Error(`probe: ${answer.probe.outcome}`);
    expect(answer.probe.facts.capabilities).toContainEqual(expect.objectContaining({ capability: 'analysis', enabled: true, selected: 'qwen3.5-9b', route: 'local' }));
  });

  it('lists its chat models: loadable, so offered', async () => {
    const { h, servers, chat } = await rig();
    const ai = new CrucibleAiService(servers, h.probes, h.settings, chat, { keysForCopy: () => ({}) } as never, pairingHost(null));
    const view = await ai.models();
    expect(view.unavailable).toBeNull();
    expect(view.groups.find((g) => g.kind === 'server')?.options[0]).toMatchObject({ value: 'local:qwen3.5-9b', label: 'qwen3.5-9b', group: 'server' });
    expect(view.upstreams?.anthropic).toEqual({ configured: true, keyHint: '…1234' });
  });

  it('runs a local chat: with no usage stated the counts add nothing, and are not invented', async () => {
    const { fake, chat } = await rig();
    const provider = new AIProviderService(chat);
    const response = await provider.generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter');
    expect(response.text).toContain('Cooking');
    expect(response).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(fake.resident()).toBe('qwen3.5-9b');
  });

  it('scores decisions on the decide class\'s own selection', async () => {
    const { servers, chat } = await rig();
    const scorer = new CrucibleScorerService(chat, servers);
    const res = await chat.withRun(() => scorer.withScorer((sh) => sh.decide({
      state: 'Some cooking talk.',
      questions: [
        { type: 'choice', name: 'topic', instructions: 'Which?', options: [{ name: 'cooking', description: 'Cooking' }, { name: 'travel', description: 'Travel' }] },
        { type: 'yesno', name: 'ad', instructions: 'An ad?' },
      ],
    })));
    expect(res.answers['topic']).toMatchObject({ type: 'choice', choice: 'cooking' });
    expect(res.answers['ad'].type).toBe('yesno');
  });

  it('transcribes: the bar never goes backwards, and the SRT is written', async () => {
    const { h, fake } = await rig(stockedForBriefcase());
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
    svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
    const video = path.join(tempDir('any-server-video-'), 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(16 * 1024, 3));
    const outDir = tempDir('any-server-out-');
    const seen: Array<{ percent: number; message: string }> = [];
    const outcome = await svc.transcribe({
      server: 'mac', model: 'qwen3-asr-0.6b-mlx', videoFile: video, outputDir: outDir, baseName: 'a', localId: 'a',
      onProgress: (percent, message) => seen.push({ percent, message }),
    });
    expect(outcome.cues).toBe(3);
    expect(fs.existsSync(outcome.srtFile)).toBe(true);
    expect(fake.jobs[0].status).toBe('done');
    const percents = seen.map((s) => s.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('coordination works', async () => {
    const { h } = await rig(stockedForBriefcase());
    const service = new CrucibleCoordinationService(h.registry, h.factory, h.dir);
    service.deps = { sleep: async () => undefined, now: () => '2026-09-23T12:00:00Z' };
    const state = await service.request('mac', 'a spec asked');
    expect(state).toMatchObject({ phase: 'stocked', unmet: [] });
  });
});

describe('what Briefcase depends on is refused by name', () => {
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
