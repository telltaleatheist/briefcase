// Imported explicitly rather than relied on as globals: the backend tsconfig
// pins "types": ["node"], so ts-jest cannot see ambient jest declarations.
import { describe, expect, it } from '@jest/globals';

import { ScorerDecider, labelDistribution } from './scorer-decide';
import { FetchLike, ScorerEngine, completionReadTimeoutMs } from './scorer-engine';
import { SYSTEM_PROMPT, ScorerPromptBuilder } from './scorer-prompt';
import { ChatMessage, DecideRequest, ScorerError, ScorerErrorCode } from './scorer.types';

/**
 * A fake llama-server behind an injected fetch, emitting the response shapes
 * snap's docs/CONTRACT.md verified against llama.cpp b10964 (a TS port of
 * snap's tests/unit/fake_llama.py). The real ScorerEngine parses it, so these
 * tests cover the HTTP client too — no network, no GPU.
 */

const LETTER_IDS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 26 }, (_, i) => [String.fromCharCode(65 + i), 32 + i]),
);
const MEDIA_MARKER = '<__media_FAKEm4rk3r0123456789abcdefghijk__>';
const IMAGE_TOKENS = 64;
const ANSWER_PREFIX = '<|im_start|>assistant\n<think>\n\n</think>\n\n';

type ProbsFn = (prompt: string) => Record<string, number>;
type RenderFn = (messages: ChatMessage[], addGen: boolean, enableThinking: unknown) => string;

/** The Qwen3.5 template's behaviour for a system + user conversation (content |trim). */
const qwen35Render: RenderFn = (messages, addGen, enableThinking) => {
  let out = '';
  for (const m of messages) out += `<|im_start|>${m.role}\n${m.content.trim()}<|im_end|>\n`;
  if (addGen) out += '<|im_start|>assistant\n' + (enableThinking === false ? '<think>\n\n</think>\n\n' : '<think>\n');
  return out;
};

function questionOf(prompt: string): string | null {
  const m = /(?:Question|Statement): (.*)\n/.exec(prompt);
  return m ? m[1] : null;
}

interface FakeOptions {
  vision?: boolean;
  render?: RenderFn;
  letterTokens?: Record<string, number[]>;
  /** Replace a route's answer: return a Response, or undefined to fall through. */
  intercept?: (path: string, body: any, call: number) => Response | Promise<Response> | undefined;
}

class FakeLlama {
  readonly calls: Array<{ path: string; body: any }> = [];
  private lastPrompt = '';
  private lastImages: string[] = [];

  constructor(
    private readonly probsFor: ProbsFn,
    private readonly opts: FakeOptions = {},
  ) {}

  get completionBodies(): any[] {
    return this.calls.filter((c) => c.path === '/completion').map((c) => c.body);
  }

  fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ path, body });
    const intercepted = await this.opts.intercept?.(path, body, this.calls.length);
    if (intercepted) return intercepted;
    const json = (status: number, obj: unknown) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

    switch (path) {
      case '/health':
        return json(200, { status: 'ok' });
      case '/props':
        return json(200, {
          model_path: '/models/Qwen3.5-9B-BF16.gguf',
          modalities: { vision: !!this.opts.vision, video: false, audio: false },
          media_marker: MEDIA_MARKER,
          chat_template: '{# qwen3.5 #}',
          bos_token: ',',
          eos_token: '<|im_end|>',
          build_info: 'b10964-fake',
        });
      case '/tokenize': {
        const text: string = body.content;
        const toks = this.opts.letterTokens?.[text] ?? (LETTER_IDS[text] !== undefined ? [LETTER_IDS[text]] : [...text].map((c) => 1000 + c.charCodeAt(0)));
        return json(200, { tokens: toks });
      }
      case '/apply-template': {
        const render = this.opts.render ?? qwen35Render;
        return json(200, { prompt: render(body.messages, body.add_generation_prompt, body.chat_template_kwargs?.enable_thinking) });
      }
      case '/completion':
        return json(200, this.completion(body));
      case '/v1/chat/completions':
        return json(200, {
          model: 'scorer',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Chapter outline' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        });
    }
    return json(404, { error: { code: 404, message: 'not found', type: 'not_found_error' } });
  };

  private completion(body: any) {
    let prompt: string;
    let images: string[] = [];
    if (typeof body.prompt === 'string') {
      if (body.prompt.includes(MEDIA_MARKER)) throw new Error('a plain-string prompt carries a media marker');
      prompt = body.prompt;
    } else {
      if (!this.opts.vision) throw new Error('multimodal_data sent to an engine without vision');
      prompt = body.prompt.prompt_string;
      images = body.prompt.multimodal_data;
      if (prompt.split(MEDIA_MARKER).length - 1 !== images.length) throw new Error('marker/bitmap count mismatch');
    }
    if ('multimodal_data' in body) throw new Error('top-level multimodal_data is ignored by llama-server');

    const nPrompt = Math.floor(prompt.length / 4) + IMAGE_TOKENS * images.length;
    let common = 0;
    while (common < prompt.length && common < this.lastPrompt.length && prompt[common] === this.lastPrompt[common]) common++;
    const cacheN = Math.floor(common / 4);
    this.lastPrompt = prompt;
    this.lastImages = images;

    const letterP = this.probsFor(prompt);
    const entries: Array<[number, string, number]> = Object.entries(letterP).map(([k, p]) => [LETTER_IDS[k], k, p]);
    const rest = Math.max(0, 1 - Object.values(letterP).reduce((a, b) => a + b, 0));
    entries.push([9001, 'The', rest * 0.6], [9002, ' A', rest * 0.4]);
    entries.sort((a, b) => b[2] - a[2]);
    const tops = entries.slice(0, body.n_probs).map(([id, token, p]) => ({
      id,
      token,
      bytes: [...Buffer.from(token)],
      logprob: p > 0 ? Math.log(p) : -3.4028234663852886e38,
    }));
    return {
      content: tops[0].token,
      tokens_evaluated: nPrompt,
      tokens_cached: nPrompt + 1,
      timings: { cache_n: cacheN, prompt_n: nPrompt - cacheN, prompt_ms: 12.5, predicted_n: 1 },
      completion_probabilities: [{ ...tops[0], top_logprobs: tops }],
    };
  }

  engine(extra: ConstructorParameters<typeof ScorerEngine>[1] = {}): ScorerEngine {
    return new ScorerEngine('http://fake-llama', { fetchImpl: this.fetch, retryDelaysMs: [0, 0], ...extra });
  }
}

// snap's worked example (tests/unit/fake_llama.py EXAMPLE_REQUEST / EXAMPLE_RAW).
const EXAMPLE: DecideRequest = {
  state: 'Hi, I was charged twice for my subscription this month. Please fix it today.',
  questions: [
    {
      type: 'choice',
      name: 'team',
      instructions: 'Which team should handle this?',
      options: [
        { name: 'billing', description: 'Payment and invoice issues' },
        { name: 'technical', description: 'Bugs and errors' },
        { name: 'other', description: 'Anything else' },
      ],
    },
    { type: 'score', name: 'anger', instructions: 'How frustrated is the customer?', levels: ['Calm', 'Frustrated but civil', 'Very angry'] },
    { type: 'yesno', name: 'urgent', instructions: 'The message conveys urgency' },
  ],
};
const EXAMPLE_RAW: Record<string, Record<string, number>> = {
  'Which team should handle this?': { A: 0.91 * 0.998, B: 0.07 * 0.998, C: 0.02 * 0.998 },
  'How frustrated is the customer?': { A: 0.62 * 0.997, B: 0.36 * 0.997, C: 0.02 * 0.997 },
  'The message conveys urgency': { A: 0.83 * 0.99, B: 0.17 * 0.99 },
};
const exampleProbs: ProbsFn = (prompt) => {
  const q = questionOf(prompt);
  return q === null ? {} : EXAMPLE_RAW[q]; // a priming prompt gets only filler tokens
};

async function expectCode(p: Promise<unknown>, code: ScorerErrorCode): Promise<ScorerError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ScorerError);
    expect((err as ScorerError).code).toBe(code);
    return err as ScorerError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

const onePNG = Buffer.from('fake image bytes').toString('base64');

// ============================================================================ prompt

describe('prompt construction', () => {
  it('renders system, state, question, legend and ends exactly at the answer position', async () => {
    const fake = new FakeLlama(exampleProbs);
    const builder = await ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER);
    expect(builder.assistantPrefix).toBe(ANSWER_PREFIX);

    const prompt = builder.build('hello', 'choice', 'Which?', [['A', 'x: an x'], ['B', 'y: a y']]);
    expect(prompt).toBe(
      `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
        '<|im_start|>user\nState:\nhello\n\nQuestion: Which?\nOptions:\nA. x: an x\nB. y: a y\nAnswer with the letter only.<|im_end|>\n' +
        ANSWER_PREFIX,
    );
    const yesno = builder.build('hello', 'yesno', 'It is a greeting', [['A', 'Yes'], ['B', 'No']]);
    expect(yesno).toContain('Statement: It is a greeting\nIs this statement true of the state above?\nOptions:\nA. Yes\nB. No\n');
  });

  it('asks the engine to render with thinking disabled (a JSON boolean) and with/without a generation prompt', async () => {
    const fake = new FakeLlama(exampleProbs);
    await ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER);
    const renders = fake.calls.filter((c) => c.path === '/apply-template').map((c) => c.body);
    expect(renders.length).toBeGreaterThanOrEqual(2);
    for (const b of renders) expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(renders.map((b) => b.add_generation_prompt)).toEqual(expect.arrayContaining([true, false]));
    expect(renders[0].messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
  });

  it('every completion the decider sends ends at the answer position', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    await decider.decide(EXAMPLE);
    const questionPrompts = fake.completionBodies.filter((b) => b.n_probs === 40).map((b) => b.prompt as string);
    expect(questionPrompts).toHaveLength(3);
    for (const p of questionPrompts) expect(p.endsWith('Answer with the letter only.<|im_end|>\n' + ANSWER_PREFIX)).toBe(true);
  });

  it('refuses a template that leaves <think> open (thinking not disabled)', async () => {
    const fake = new FakeLlama(exampleProbs, { render: (m, g) => qwen35Render(m, g, true) });
    const err = await expectCode(ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER), 'template_not_answer_ready');
    expect(err.message).toContain('<think>');
  });

  it('refuses a template whose generation render does not extend the plain render', async () => {
    const render: RenderFn = (m, g, t) => (g ? qwen35Render(m, g, t) : qwen35Render(m, g, t) + '<|endoftext|>');
    const fake = new FakeLlama(exampleProbs, { render });
    await expectCode(ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER), 'template_not_answer_ready');
  });

  it('refuses a template that adds nothing for the generation prompt', async () => {
    const fake = new FakeLlama(exampleProbs, { render: (m) => qwen35Render(m, false, false) });
    await expectCode(ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER), 'template_not_answer_ready');
  });

  it('refuses a template that does not carry the user message verbatim', async () => {
    const render: RenderFn = (m, g, t) =>
      qwen35Render(m.map((x) => (x.role === 'user' ? { ...x, content: x.content.replace(/\n\n/g, '\n') } : x)), g, t);
    const fake = new FakeLlama(exampleProbs, { render });
    await expectCode(ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER), 'template_not_answer_ready');
  });

  it('reports an engine that cannot render the template as template_not_answer_ready', async () => {
    const fake = new FakeLlama(exampleProbs, {
      intercept: (path) =>
        path === '/apply-template'
          ? new Response(JSON.stringify({ error: { code: 500, message: 'template error', type: 'server_error' } }), { status: 500 })
          : undefined,
    });
    await expectCode(ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER), 'template_not_answer_ready');
  });

  it('shared prefix = everything before "\\n\\n" + question block, images as marker lines before the state', async () => {
    const fake = new FakeLlama(exampleProbs);
    const builder = await ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER);
    const prefix = builder.sharedPrefix('the state', 2);
    expect(prefix.endsWith(`<|im_start|>user\nState:\n${MEDIA_MARKER}\n${MEDIA_MARKER}\nthe state`)).toBe(true);
    const full = builder.build('the state', 'yesno', 'x', [['A', 'Yes'], ['B', 'No']], 2);
    expect(full.startsWith(prefix + '\n\nStatement: x')).toBe(true);
    // images only: no empty line for the state text
    expect(builder.sharedPrefix('', 1).endsWith(`State:\n${MEDIA_MARKER}`)).toBe(true);
  });

  it('refuses the media marker inside the caller text (it would shift every image)', async () => {
    const fake = new FakeLlama(exampleProbs);
    const builder = await ScorerPromptBuilder.create(fake.engine(), MEDIA_MARKER);
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as ScorerError).code;
      }
      return 'no error';
    };
    expect(codeOf(() => builder.build(`look ${MEDIA_MARKER}`, 'yesno', 'x', [['A', 'Yes'], ['B', 'No']]))).toBe('bad_request');
    expect(codeOf(() => builder.sharedPrefix(`look ${MEDIA_MARKER}`))).toBe('bad_request');
  });
});

// ============================================================================ labels + answers

describe('label distribution', () => {
  it('renormalises over the labels and reports label_mass (snap worked example)', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    const res = await decider.decide(EXAMPLE);
    expect(res.model).toBe('Qwen3.5-9B-BF16.gguf');

    const team = res.answers.team;
    if (team.type !== 'choice') throw new Error('expected choice');
    expect(team.choice).toBe('billing');
    expect(team.confidence).toBeCloseTo(0.91, 10);
    expect(team.probabilities.billing).toBeCloseTo(0.91, 10);
    expect(team.probabilities.technical).toBeCloseTo(0.07, 10);
    expect(team.probabilities.other).toBeCloseTo(0.02, 10);
    expect(team.labelMass).toBeCloseTo(0.998, 10);
    expect(team.options).toEqual(['billing', 'technical', 'other']);
    // log P for Viterbi: renormalised and raw, in option order
    expect(team.logProbs.map(Math.exp)).toEqual([0.91, 0.07, 0.02].map((p) => expect.closeTo(p, 10)));
    expect(team.rawLogProbs[0]).toBeCloseTo(Math.log(0.91 * 0.998), 10);
    expect(team.missingLabels).toBeUndefined();

    const urgent = res.answers.urgent;
    if (urgent.type !== 'yesno') throw new Error('expected yesno');
    expect(urgent.p).toBeCloseTo(0.83, 10);
    expect(urgent.labelMass).toBeCloseTo(0.99, 10);
    expect(urgent.options).toEqual(['Yes', 'No']);
  });

  it('score = expected 1-based level index', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    const res = await decider.decide(EXAMPLE);
    const anger = res.answers.anger;
    if (anger.type !== 'score') throw new Error('expected score');
    expect(anger.score).toBeCloseTo(0.62 * 1 + 0.36 * 2 + 0.02 * 3, 10); // 1.40
    expect(anger.level).toBe('Calm');
    expect(anger.confidence).toBeCloseTo(0.62, 10);
    expect(anger.labelMass).toBeCloseTo(0.997, 10);
  });

  it('a label missing from top-n is label_not_in_probs by default (snap behaviour)', async () => {
    const fake = new FakeLlama(() => ({ A: 0.7, B: 0.25 })); // C never appears
    const decider = await ScorerDecider.create(fake.engine());
    const err = await expectCode(decider.decide({ state: 's', questions: [EXAMPLE.questions[0]] }), 'label_not_in_probs');
    expect(err.message).toContain("label 'C'");
  });

  it("missingLabels: 'floor' floors the missing label at the smallest returned prob, records it, and keeps going", async () => {
    // Question 1 is missing C; question 2 is complete. The batch must not abort.
    const probs: ProbsFn = (prompt): Record<string, number> => {
      const q = questionOf(prompt);
      if (q === null) return {};
      return q === 'Which team should handle this?' ? { A: 0.7, B: 0.25 } : { A: 0.6, B: 0.3, C: 0.05 };
    };
    const fake = new FakeLlama(probs);
    const decider = await ScorerDecider.create(fake.engine());
    const res = await decider.decide({
      state: 's',
      questions: [EXAMPLE.questions[0], { ...EXAMPLE.questions[1], name: 'anger' }],
      missingLabels: 'floor',
    });
    const team = res.answers.team;
    if (team.type !== 'choice') throw new Error('expected choice');
    expect(team.missingLabels).toEqual(['C']);
    // top-n was A 0.7, B 0.25, "The" 0.03, " A" 0.02 -> floor = 0.02
    expect(team.rawLogProbs[2]).toBeCloseTo(Math.log(0.02), 10);
    expect(team.labelMass).toBeCloseTo(0.95, 10); // only labels actually returned
    const z = 0.7 + 0.25 + 0.02;
    expect(team.probabilities.other).toBeCloseTo(0.02 / z, 10);
    expect(team.probabilities.billing).toBeCloseTo(0.7 / z, 10);
    expect(Object.values(team.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(team.logProbs.every(Number.isFinite)).toBe(true);
    expect(res.answers.anger.missingLabels).toBeUndefined();
  });

  it('refuses a duplicated token id in top_logprobs', () => {
    const result = {
      top: [
        { id: 32, token: 'A', logprob: Math.log(0.5), prob: 0.5 },
        { id: 32, token: 'A', logprob: Math.log(0.4), prob: 0.4 },
      ],
      timings: { prompt_ms: 1, prompt_n: 1, cache_n: 0 },
      tokensEvaluated: 1,
      tokensCached: 1,
    };
    expect(() => labelDistribution(result, [['A', 'x']], new Map([['A', 32]]), 'q')).toThrow(/appears twice/);
  });

  it('every label with probability 0 is label_not_in_probs', () => {
    const result = {
      top: [
        { id: 32, token: 'A', logprob: -3.4028234663852886e38, prob: 0 },
        { id: 33, token: 'B', logprob: -3.4028234663852886e38, prob: 0 },
      ],
      timings: { prompt_ms: 1, prompt_n: 1, cache_n: 0 },
      tokensEvaluated: 1,
      tokensCached: 1,
    };
    try {
      labelDistribution(result, [['A', 'x'], ['B', 'y']], new Map([['A', 32], ['B', 33]]), 'q');
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as ScorerError).code).toBe('label_not_in_probs');
    }
  });

  it('label_not_single_token when a letter tokenizes to two tokens, or two letters share an id', async () => {
    const split = new FakeLlama(exampleProbs, { letterTokens: { Q: [1, 2] } });
    await expectCode(ScorerDecider.create(split.engine()), 'label_not_single_token');
    const shared = new FakeLlama(exampleProbs, { letterTokens: { B: [32] } });
    await expectCode(ScorerDecider.create(shared.engine()), 'label_not_single_token');
  });
});

// ============================================================================ priming

describe('priming', () => {
  it('with more than one question, sends the shared prefix alone first, then each question', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    const res = await decider.decide(EXAMPLE);

    const bodies = fake.completionBodies;
    expect(bodies).toHaveLength(4);
    const prime = bodies[0];
    expect(prime.n_probs).toBe(1);
    expect(prime.prompt).toBe(decider.builder.sharedPrefix(EXAMPLE.state as string));
    expect(prime.prompt.endsWith(`State:\n${EXAMPLE.state}`)).toBe(true);
    expect(questionOf(prime.prompt)).toBeNull();
    for (const b of bodies.slice(1)) {
      expect(b.n_probs).toBe(40);
      expect((b.prompt as string).startsWith(prime.prompt + '\n\n')).toBe(true);
    }
    expect(bodies.slice(1).map((b) => questionOf(b.prompt))).toEqual([
      'Which team should handle this?',
      'How frustrated is the customer?',
      'The message conveys urgency',
    ]);

    // timing reported the way snap does: prime + per question, cache counts from the engine
    expect(res.timingMs.prime).toBeDefined();
    expect(res.timingMs.prime!.cachedTokens).toBe(0);
    const primeTokens = Math.floor(prime.prompt.length / 4);
    for (const name of ['team', 'anger', 'urgent']) {
      expect(res.timingMs.perQuestion[name].promptMs).toBe(12.5);
      expect(res.timingMs.perQuestion[name].cachedTokens).toBeGreaterThanOrEqual(primeTokens);
      expect(res.tokens.perQuestion[name]).toBeGreaterThan(primeTokens);
    }
    expect(res.tokens.images).toBe(0);
    expect(res.timingMs.total).toBeGreaterThanOrEqual(0);
  });

  it('does not prime a single question', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    const res = await decider.decide({ state: 's', questions: [EXAMPLE.questions[2]] });
    expect(fake.completionBodies).toHaveLength(1);
    expect(res.timingMs.prime).toBeUndefined();
  });

  it('images ride on the prime and on every question, as {prompt_string, multimodal_data}', async () => {
    const fake = new FakeLlama(exampleProbs, { vision: true });
    const decider = await ScorerDecider.create(fake.engine());
    const res = await decider.decide({ ...EXAMPLE, images: [onePNG, onePNG] });
    const bodies = fake.completionBodies;
    expect(bodies).toHaveLength(4);
    for (const b of bodies) {
      expect(b.prompt.multimodal_data).toEqual([onePNG, onePNG]);
      expect(b.prompt.prompt_string.split(MEDIA_MARKER).length - 1).toBe(2);
    }
    expect(res.tokens.images).toBe(2);
  });

  it('builds every prompt before the first forward pass: a bad question refuses the request with no GPU spent', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    const tooMany = { type: 'choice' as const, name: 'big', instructions: 'x', options: Array.from({ length: 27 }, (_, i) => ({ name: `o${i}`, description: 'd' })) };
    await expectCode(decider.decide({ state: 's', questions: [EXAMPLE.questions[2], tooMany] }), 'too_many_options');
    expect(fake.completionBodies).toHaveLength(0);
  });
});

// ============================================================================ request errors

describe('request validation', () => {
  it('names each caller mistake', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    const yesno = EXAMPLE.questions[2];
    await expectCode(decider.decide({ state: null, questions: [yesno] }), 'bad_request');
    await expectCode(decider.decide({ state: '  ', questions: [yesno] }), 'bad_request');
    await expectCode(decider.decide({ state: 's', questions: [] }), 'bad_request');
    await expectCode(decider.decide({ state: 's', questions: [yesno, yesno] }), 'bad_request');
    await expectCode(
      decider.decide({
        state: 's',
        questions: [{ type: 'choice', name: 'c', instructions: 'x', options: [{ name: 'a', description: 'd' }, { name: 'a', description: 'e' }] }],
      }),
      'bad_request',
    );
    await expectCode(decider.decide({ state: 's', questions: [{ type: 'score', name: 's', instructions: 'x', levels: ['a', 'a'] }] }), 'bad_request');
    await expectCode(decider.decide({ state: 's', questions: [yesno], images: ['data:image/png;base64,AAAA'] }), 'bad_request');
    await expectCode(decider.decide({ state: 's', questions: [yesno], images: [onePNG] }), 'engine_no_vision');
    await expectCode(decider.decide({ state: 's', questions: [yesno], images: Array(9).fill(onePNG) }), 'too_many_images');
    expect(fake.completionBodies).toHaveLength(0);
  });

  it('a JSON state is sent as compact JSON', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    await decider.decide({ state: { a: 1, b: [2, 3] }, questions: [EXAMPLE.questions[2]] });
    expect(fake.completionBodies[0].prompt).toContain('State:\n{"a":1,"b":[2,3]}\n\n');
  });
});

// ============================================================================ engine transport

describe('engine transport', () => {
  it('sends snap\'s completion body: raw probs, n_predict 1, n_probs 40, cache_prompt', async () => {
    const fake = new FakeLlama(exampleProbs);
    const decider = await ScorerDecider.create(fake.engine());
    await decider.decide({ state: 's', questions: [EXAMPLE.questions[2]] });
    expect(fake.completionBodies[0]).toMatchObject({
      n_predict: 1,
      n_probs: 40,
      post_sampling_probs: false,
      temperature: 1.0,
      top_k: 0,
      top_p: 1.0,
      min_p: 0.0,
      samplers: [],
      cache_prompt: true,
      stream: false,
    });
  });

  it('retries a refused connection 3 times, then engine_unreachable', async () => {
    let n = 0;
    const engine = new ScorerEngine('http://127.0.0.1:1', {
      retryDelaysMs: [0, 0],
      fetchImpl: async () => {
        n++;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    });
    const err = await expectCode(engine.props(), 'engine_unreachable');
    expect(n).toBe(3);
    expect(err.message).toContain('ECONNREFUSED');
  });

  it('retries a 503 (loading) and succeeds; a 500 is engine_error at once', async () => {
    const loading = new FakeLlama(exampleProbs, {
      intercept: (path, _b, call) =>
        path === '/props' && call === 1
          ? new Response(JSON.stringify({ error: { code: 503, message: 'Loading model' } }), { status: 503 })
          : undefined,
    });
    await expect(loading.engine().props()).resolves.toMatchObject({ mediaMarker: MEDIA_MARKER, vision: false, buildInfo: 'b10964-fake' });
    expect(loading.calls.filter((c) => c.path === '/props')).toHaveLength(2);

    const broken = new FakeLlama(exampleProbs, {
      intercept: (path) => (path === '/tokenize' ? new Response('{"error":{"message":"boom"}}', { status: 500 }) : undefined),
    });
    const err = await expectCode(broken.engine().tokenize('A'), 'engine_error');
    expect(err.message).toContain('boom');
    expect(broken.calls).toHaveLength(1);
  });

  it('a response missing a required field is engine_error', async () => {
    const fake = new FakeLlama(exampleProbs, {
      intercept: (path) => (path === '/props' ? new Response(JSON.stringify({ model_path: 'x' }), { status: 200 }) : undefined),
    });
    await expectCode(fake.engine().props(), 'engine_error');
  });

  it('completion read budget = 120 s + 5 ms per prompt character', () => {
    expect(completionReadTimeoutMs(0)).toBe(120_000);
    expect(completionReadTimeoutMs(1000)).toBe(125_000);
    expect(completionReadTimeoutMs(400_000)).toBe(2_120_000); // a ~100k-token transcript: ~35 min
    expect(new ScorerEngine('http://x').completionTimeoutMs(2000)).toBe(130_000);
  });

  it('a read timeout is engine_timeout and is NOT retried; the budget scales with the prompt', async () => {
    let n = 0;
    const slow: FetchLike = (_url, init) =>
      new Promise((resolve, reject) => {
        n++;
        const t = setTimeout(() => resolve(new Response(JSON.stringify(completionBody()), { status: 200 })), 80);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    // 0 ms base + 1 ms per char: 10 chars -> 10 ms budget (times out); 500 chars -> 500 ms (answers at 80 ms)
    const engine = new ScorerEngine('http://x', { fetchImpl: slow, retryDelaysMs: [0, 0], baseReadTimeoutMs: 0, readTimeoutMsPerChar: 1 });
    const err = await expectCode(engine.completion('0123456789'), 'engine_timeout');
    expect(err.message).toContain('sized to the prompt');
    expect(n).toBe(1);
    await expect(engine.completion('x'.repeat(500))).resolves.toMatchObject({ tokensEvaluated: 3 });
  });

  it('a caller abort is cancelled, not a timeout and not retried', async () => {
    const controller = new AbortController();
    let n = 0;
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        n++;
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const engine = new ScorerEngine('http://x', { fetchImpl: hang, retryDelaysMs: [0, 0] });
    const p = engine.completion('prompt', 40, undefined, controller.signal);
    controller.abort();
    await expectCode(p, 'cancelled');
    expect(n).toBe(1);
  });
});

function completionBody() {
  const top = [{ id: 32, token: 'A', bytes: [65], logprob: Math.log(0.9) }];
  return {
    tokens_evaluated: 3,
    tokens_cached: 4,
    timings: { cache_n: 0, prompt_n: 3, prompt_ms: 1 },
    completion_probabilities: [{ ...top[0], top_logprobs: top }],
  };
}

// ============================================================================ generate

describe('generate', () => {
  it('one chat completion: thinking off, temperature 0, max_tokens', async () => {
    const fake = new FakeLlama(exampleProbs);
    const res = await fake.engine().generate([{ role: 'user', content: 'Outline this transcript' }], { maxTokens: 512 });
    expect(res).toEqual({ text: 'Chapter outline', promptTokens: 12, completionTokens: 3, finishReason: 'stop', model: 'scorer' });
    const body = fake.calls.find((c) => c.path === '/v1/chat/completions')!.body;
    expect(body).toMatchObject({
      messages: [{ role: 'user', content: 'Outline this transcript' }],
      max_tokens: 512,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
    });
  });

  it('refuses a non-positive maxTokens', async () => {
    const fake = new FakeLlama(exampleProbs);
    await expectCode(fake.engine().generate([{ role: 'user', content: 'x' }], { maxTokens: 0 }), 'bad_request');
    expect(fake.calls).toHaveLength(0);
  });
});
