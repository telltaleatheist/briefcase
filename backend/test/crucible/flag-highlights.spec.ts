/**
 * The flag stage end to end through the fake Crucible (analysis/flag-highlights.ts):
 * the flags model marks the clip-worthy moments with add_marker, in the
 * tool-call format it gets (native tools on 2.0.30+, tags on an older
 * server), on a local model with a reply ceiling and thinking off (loaded
 * big enough for the whole transcript when it can be), and on Claude with
 * nothing but the conversation crossing. The rows that come out: ranker
 * 'highlights-v1', no score, times from the transcript's segments.
 */
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { AIAnalysisService } from '../../src/analysis/ai-analysis.service';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CLOUD_FORBIDDEN_KEYS } from '../../src/crucible/llm/target';
import { startFakeCrucible, type FakeChatReply, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { tempDir } from './helpers';

const LINES = [
  'Welcome back to the kitchen everybody, today is pasta day.',
  'Those people are communists and enemies of this country.',
  'They are vermin and they should all be thrown out.',
  'Now let us talk about our summer travel plans.',
  'The deep state rigged the train timetable, folks.',
];
// Real-timeline times, not starting at zero: the run must keep them.
const SEGMENTS = LINES.map((text, i) => ({ start: 600 + i * 12, end: 600 + i * 12 + 12, text }));

const savedEnv = { ...process.env };
let fake: FakeCrucible;
let h: Harness;
let provider: AIProviderService;
let snapCalls: number;

const MARK = { title: 'Calls them vermin', category: 'political-demonization', why: 'He calls opponents vermin.', first_words: 'Those people are communists and enemies', last_words: 'should all be thrown out' };
const messagesOf = (body: Record<string, unknown>) => (body['messages'] as Array<{ role: string; content: string | null }>) ?? [];
const firstTurn = (body: Record<string, unknown>) => messagesOf(body).length === 2;

async function start(reply: FakeChatReply, extra: Partial<Parameters<typeof startFakeCrucible>[0]> = {}) {
  fake = await startFakeCrucible({
    version: '2.0.30',
    models: [{ id: 'qwen3.5-9b', paramsB: 9 }],
    upstreams: { anthropic: { key: 'sk-ant-9999' } },
    chatReplies: { '*': reply },
    ...extra,
  });
  h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  provider = new AIProviderService(new CrucibleChatService(new CrucibleServersService(h.registry, h.factory), h.factory, h.probes));
}

function analysis(): AIAnalysisService {
  snapCalls = 0;
  const snap = {
    run: async () => {
      snapCalls++;
      throw new Error('the scorer is not part of a flags-only run');
    },
  };
  return new AIAnalysisService(provider, snap as never, undefined);
}

function options(provider: 'local' | 'claude', model: string, segments = SEGMENTS) {
  return {
    provider,
    model,
    transcript: segments.map((s) => s.text).join(' '),
    segments,
    outputFile: path.join(tempDir('flag-highlights-out-'), 'analysis.txt'),
    categories: [{ name: 'political-demonization' }, { name: 'conspiracy' }],
    parts: ['flags' as const],
  };
}

beforeAll(() => Logger.overrideLogger(false));
beforeEach(() => {
  process.env = { ...savedEnv, APPDATA: tempDir('flag-highlights-appdata-') };
});
afterEach(async () => {
  process.env = savedEnv;
  await fake?.close();
});

describe('the flag stage through Crucible', () => {
  it('a local model on 2.0.30: native tools, a reply ceiling, thinking off; the moment stored as highlights-v1 at its real times, in one session', async () => {
    await start((body) => (firstTurn(body) ? { content: null as never, toolCalls: [{ id: 'c1', name: 'add_marker', arguments: JSON.stringify(MARK) }] } : 'Calls them vermin'));
    const result = await analysis().analyzeTranscript(options('local', 'qwen3.5-9b'));
    expect(snapCalls).toBe(0);

    const bodies = fake.chatBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: 'qwen3.5-9b', max_tokens: 6144, chat_template_kwargs: { enable_thinking: false }, tool_choice: 'auto' });
    expect((bodies[0]['tools'] as Array<{ function: { name: string; parameters: { properties: { category: { enum: string[] } } } } }>)[0].function)
      .toMatchObject({ name: 'add_marker', parameters: { properties: { category: { enum: ['political-demonization', 'conspiracy'] } } } });
    expect(bodies[0]).not.toHaveProperty('response_format');
    // The whole transcript is in the system prompt; the system prompt and tools are the same on the follow-up.
    expect(messagesOf(bodies[0])[0].content).toContain(`TRANSCRIPT:\n${LINES.join('\n')}`);
    expect(messagesOf(bodies[1])[0].content).toBe(messagesOf(bodies[0])[0].content);
    expect(JSON.stringify(bodies[1]['tools'])).toBe(JSON.stringify(bodies[0]['tools']));

    expect(result.sections).toEqual([expect.objectContaining({
      category: 'political-demonization', title: 'Calls them vermin', description: 'Calls them vermin — He calls opponents vermin.',
      // 24 s as marked, padded to a clip with the sentence before it.
      start_time: '00:10:00', end_time: '00:10:36', verdict: 'flag', ranker: 'highlights-v1',
    })]);
    expect(result.sections[0].nli_score).toBeUndefined();
    // The run's one session is closed at the end.
    expect(fake.sessions.closed.map((x) => x.sessionId)).toEqual(fake.sessions.opened.map((x) => x.sessionId));
  });

  it('a Crucible before 2.0.30: tool tags in the system prompt, no tools sent', async () => {
    await start((body) => (firstTurn(body) ? `<tool_use>\n${JSON.stringify({ name: 'add_marker', arguments: MARK })}\n</tool_use>` : 'Calls them vermin'), { version: '2.0.29' });
    const result = await analysis().analyzeTranscript(options('local', 'qwen3.5-9b'));
    const bodies = fake.chatBodies();
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(messagesOf(bodies[0])[0].content).toContain('<tool_use>');
    expect(result.sections.map((s) => s.title)).toEqual(['Calls them vermin']);
  });

  it('Claude through Crucible: native tools, and nothing else of ours crosses (no ceiling, no sampling)', async () => {
    await start((body) => (firstTurn(body) ? { content: 'Marking it.', toolCalls: [{ id: 't1', name: 'add_marker', arguments: JSON.stringify(MARK) }] } : 'Done'));
    const result = await analysis().analyzeTranscript(options('claude', 'claude-sonnet-5'));
    const bodies = fake.chatBodies();
    expect(bodies[0]['model']).toBe('anthropic/claude-sonnet-5');
    for (const key of CLOUD_FORBIDDEN_KEYS) expect(bodies[0]).not.toHaveProperty(key);
    expect(result.sections.map((s) => [s.start_time, s.category, s.ranker])).toEqual([['00:10:00', 'political-demonization', 'highlights-v1']]);
  });

  it('a transcript over the loaded context: the local model is loaded big enough for all of it, up to its maximum', async () => {
    // ~3,000 sentences of ~60 characters: about 52K tokens with the prompt.
    const long = Array.from({ length: 3000 }, (_u, i) => ({ start: i * 2, end: i * 2 + 2, text: `This is sentence number ${i} of a very long sermon about things.` }));
    await start('Nothing clip-worthy in this stretch.', {
      models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384, maxContext: { tokens: 131072, cardAffords: 131072 } }],
    });
    await analysis().analyzeTranscript(options('local', 'qwen3.5-9b', long));
    const loads = fake.jobs.filter((j) => j.type === 'load-model');
    expect(loads.length).toBeGreaterThan(0);
    expect((loads[loads.length - 1].params as { context?: number }).context).toBeGreaterThanOrEqual(52000);
    // Whole transcript: every question's system prompt carries it.
    expect(messagesOf(fake.chatBodies()[0])[0].content).toContain('TRANSCRIPT:');
  });

  it('a transcript past the maximum: each question carries its stretch instead', async () => {
    const long = Array.from({ length: 3000 }, (_u, i) => ({ start: i * 2, end: i * 2 + 2, text: `This is sentence number ${i} of a very long sermon about things.` }));
    await start('Nothing clip-worthy in this stretch.', {
      models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 32768, maxModelLen: 32768, maxContext: { tokens: 32768, cardAffords: 32768 } }],
    });
    await analysis().analyzeTranscript(options('local', 'qwen3.5-9b', long));
    const bodies = fake.chatBodies();
    // 100 minutes in stretches of 15: seven questions, none with the transcript in the system prompt.
    expect(bodies).toHaveLength(7);
    expect(messagesOf(bodies[0])[0].content).not.toContain('TRANSCRIPT:');
    expect(messagesOf(bodies[1])[1].content).toContain('STRETCH:\nThis is sentence number 450 of');
  });
});
