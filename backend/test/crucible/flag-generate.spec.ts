/**
 * Flags found by the model reading the transcript ("generate", the default),
 * end to end through the fake Crucible: the reading call's body on a local
 * model and on Claude, the passages it returns matched to the transcript, the
 * verifier's checks, and the rows that come out (ranker 'generate-v1', no
 * score, times from the transcript's segments).
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

const promptOf = (body: Record<string, unknown>) =>
  ((body['messages'] as Array<{ content: string }>) ?? []).map((m) => m.content).join('\n');
const isReading = (body: Record<string, unknown>) => promptOf(body).startsWith('Read this part of a video transcript');

async function start(reading: FakeChatReply, verdict: FakeChatReply = '{"verdict":"flag","reason":"The speaker says it as their own view."}') {
  fake = await startFakeCrucible({
    models: [{ id: 'qwen3.5-9b', paramsB: 9 }],
    upstreams: { anthropic: { key: 'sk-ant-9999' } },
    chatReplies: {
      '*': (body) => {
        const reply = isReading(body) ? reading : verdict;
        return typeof reply === 'function' ? reply(body) : reply;
      },
    },
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
      throw new Error('the scorer is not part of a flags-only generate run');
    },
  };
  return new AIAnalysisService(provider, snap as never, undefined);
}

function options(provider: 'local' | 'claude', model: string) {
  return {
    provider,
    model,
    transcript: LINES.join(' '),
    segments: SEGMENTS,
    outputFile: path.join(tempDir('flag-generate-out-'), 'analysis.txt'),
    categories: [{ name: 'political-demonization' }, { name: 'conspiracy' }],
    parts: ['flags' as const],
  };
}

beforeAll(() => Logger.overrideLogger(false));
beforeEach(() => {
  process.env = { ...savedEnv, APPDATA: tempDir('flag-generate-appdata-') };
});
afterEach(async () => {
  process.env = savedEnv;
  await fake?.close();
});

describe('flags found by the model reading the transcript, through Crucible', () => {
  it('a local model: schema, thinking off, temperature 0, a token ceiling; each passage matched, checked and stored as generate-v1 at its real times', async () => {
    await start(
      JSON.stringify({
        passages: [
          { first_words: 'Those people are communists and enemies', last_words: 'should all be thrown out', categories: ['political-demonization'] },
          { first_words: 'The deep state rigged the train', last_words: 'train timetable, folks', categories: ['conspiracy'] },
        ],
      }),
    );
    const result = await analysis().analyzeTranscript(options('local', 'qwen3.5-9b'));
    expect(snapCalls).toBe(0);

    const bodies = fake.chatBodies();
    const reading = bodies.filter(isReading);
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatchObject({
      model: 'qwen3.5-9b',
      temperature: 0,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'flags' } },
    });
    expect(promptOf(reading[0])).toContain(LINES.join('\n'));

    // The verifier: one check per passage, its own prompt and schema, as before.
    const checks = bodies.filter((b) => !isReading(b));
    expect(checks).toHaveLength(2);
    expect(promptOf(checks[0])).toMatch(/^Transcript passage\./);
    expect(checks[0]).toMatchObject({ temperature: 0, response_format: { type: 'json_schema' } });
    expect(checks[0]).not.toHaveProperty('chat_template_kwargs');

    expect(result.sections.map((s) => [s.start_time, s.end_time, s.category, s.verdict, s.ranker])).toEqual([
      ['00:10:12', '00:10:36', 'political-demonization', 'flag', 'generate-v1'],
      ['00:10:48', '00:11:00', 'conspiracy', 'flag', 'generate-v1'],
    ]);
    expect(result.sections.every((s) => s.nli_score === undefined)).toBe(true);
    expect(result.sections[0].description).toBe('The speaker says it as their own view.');
    expect(result.warnings).toBeUndefined();
    // The one lease is released at the end, as for every analysis.
    expect(fake.sessions.closed.map((x) => x.sessionId)).toEqual(fake.sessions.opened.map((x) => x.sessionId));
  });

  it('Claude: nothing but the prompt crosses, and its prose-wrapped answer is read without a schema', async () => {
    await start(
      'Here are the passages that may apply:\n\n```json\n{"passages": [{"first_words": "They are vermin and they", "last_words": "all be thrown out.", "categories": ["Political demonization"]}]}\n```\n',
      'Verdict: {"verdict": "flag", "reason": "Calls them vermin."}',
    );
    const result = await analysis().analyzeTranscript(options('claude', 'claude-sonnet-5'));
    const reading = fake.chatBodies().filter(isReading);
    expect(reading).toHaveLength(1);
    expect(Object.keys(reading[0]).sort()).toEqual(['messages', 'model', 'stream']);
    for (const key of CLOUD_FORBIDDEN_KEYS) expect(reading[0]).not.toHaveProperty(key);
    expect(result.sections.map((s) => [s.start_time, s.end_time, s.category, s.ranker])).toEqual([
      ['00:10:24', '00:10:36', 'political-demonization', 'generate-v1'],
    ]);
  });

  it('a reply cut off at the token ceiling is said on the job; the passages before the cut are kept', async () => {
    await start({
      content: '{"passages": [{"first_words": "They are vermin and they", "last_words": "all be thrown out", "categories": ["political-demonization"]}, {"first_words": "The deep',
      finishReason: 'length',
    });
    const result = await analysis().analyzeTranscript(options('local', 'qwen3.5-9b'));
    expect(result.sections.map((s) => s.start_time)).toEqual(['00:10:24']);
    expect(result.warnings).toEqual([
      "Flags: 1 of 1 transcript chunks reached the model's output limit (4096 tokens); passages after the cut were not read: chunk 1 (00:10:00-00:11:00)",
    ]);
  });

  it('the reading call failing everywhere fails the analysis with the server\'s error, and still closes the session', async () => {
    await start('{}');
    fake.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 500, code: 'engine_failed' }];
    await expect(analysis().analyzeTranscript(options('local', 'qwen3.5-9b'))).rejects.toThrow(
      /no part of the transcript could be read for flags — all 1 chunk\(s\) failed\. Last failure: chunk 1 .*engine_failed/,
    );
    expect(fake.sessions.closed.map((x) => x.sessionId)).toEqual(fake.sessions.opened.map((x) => x.sessionId));
  }, 30_000);
});
