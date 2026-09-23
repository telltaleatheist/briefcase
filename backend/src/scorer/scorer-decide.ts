/**
 * One forward pass per question; read the label-token distribution; no
 * decoding. Port of snap/decide.py (+ the request validation of snap/schema.py).
 */

import { CompletionResult, EngineProps, N_PROBS, ScorerEngineLike, modelNameOf } from './scorer-engine';
import { Label, assignLabels, resolveLabelTokens, yesnoLabels } from './scorer-labels';
import { ScorerPromptBuilder, renderState } from './scorer-prompt';
import {
  DecideOptions,
  DecideRequest,
  DecideResponse,
  MissingLabelPolicy,
  QuestionTiming,
  ScorerAnswer,
  ScorerError,
  ScorerQuestion,
} from './scorer.types';

/**
 * Images per request. The engine has no count limit of its own; each image costs
 * up to 4096 tokens for Qwen-VL projectors, so 8 keeps a request inside a modest
 * context and makes a runaway client fail by name.
 */
export const MAX_IMAGES = 8;

export interface LabelDistribution {
  /** Renormalised probability per label, in label order. */
  probs: number[];
  /** ln of `probs`. */
  logProbs: number[];
  /** Engine logprob per label (floored ones carry the floor), in label order. */
  rawLogProbs: number[];
  /** Sum of the raw probabilities of the labels the engine actually returned. */
  mass: number;
  /** Letters absent from top-n that were floored ('floor' policy only). */
  missing: string[];
}

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/**
 * The label distribution at the answer position. Labels are matched BY TOKEN ID.
 * Renormalising p_i / sum(p) over the labels equals a softmax over the label
 * logits; it is done in log space so tiny probabilities keep their precision.
 *
 * A label missing from the engine's top-n: 'error' (snap) refuses the question
 * as label_not_in_probs; 'floor' gives it the logprob of the least likely token
 * the engine DID return (an upper bound on its true probability) and lists it.
 * `mass` counts only labels that were actually returned.
 */
export function labelDistribution(
  result: CompletionResult,
  labels: Label[],
  labelIds: Map<string, number>,
  question: string,
  policy: MissingLabelPolicy = 'error',
): LabelDistribution {
  const byId = new Map<number, number>();
  for (const t of result.top) {
    if (byId.has(t.id)) {
      throw new ScorerError('engine_error', `token id ${t.id} appears twice in top_logprobs`);
    }
    byId.set(t.id, t.logprob);
  }

  const missing: string[] = [];
  const raw: Array<number | undefined> = labels.map(([letter, name]) => {
    const tid = labelIds.get(letter);
    if (tid === undefined) {
      throw new ScorerError('label_not_single_token', `no token id was resolved for label '${letter}'`);
    }
    const lp = byId.get(tid);
    if (lp === undefined) {
      if (policy === 'error') {
        throw new ScorerError(
          'label_not_in_probs',
          `question '${question}': label '${letter}' (option '${name}', token id ${tid}) is not among ` +
            `the top ${result.top.length} tokens the engine returned`,
        );
      }
      missing.push(letter);
    }
    return lp;
  });

  let floor = -Infinity;
  if (missing.length) {
    if (!result.top.length) {
      throw new ScorerError('label_not_in_probs', `question '${question}': the engine returned no top tokens`);
    }
    floor = Math.min(...result.top.map((t) => t.logprob));
  }
  const rawLogProbs = raw.map((lp) => (lp === undefined ? floor : lp));

  const mass = raw.reduce<number>((s, lp) => s + (lp === undefined ? 0 : Math.exp(lp)), 0);
  const logZ = logSumExp(rawLogProbs);
  if (!Number.isFinite(logZ) || Math.exp(logZ) <= 0) {
    throw new ScorerError('label_not_in_probs', `question '${question}': every label has probability 0`);
  }
  const logProbs = rawLogProbs.map((lp) => lp - logZ);
  return { probs: logProbs.map(Math.exp), logProbs, rawLogProbs, mass, missing };
}

// --------------------------------------------------------------------------- validation

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The checks snap's pydantic schema makes, refused as bad_request. Counts keep their own names. */
export function validateDecideRequest(req: DecideRequest): void {
  const bad = (msg: string): never => {
    throw new ScorerError('bad_request', msg);
  };
  if (!req || typeof req !== 'object') bad('the request must be an object');
  if (req.state === null || req.state === undefined) bad('state is required and may not be null');
  if (!Array.isArray(req.questions) || req.questions.length < 1) bad('questions must be a non-empty array');
  if (req.nProbs !== undefined && (!Number.isInteger(req.nProbs) || req.nProbs < 1)) {
    bad(`nProbs must be a positive integer, got ${req.nProbs}`);
  }
  if (req.missingLabels !== undefined && req.missingLabels !== 'error' && req.missingLabels !== 'floor') {
    bad(`missingLabels must be 'error' or 'floor', got ${JSON.stringify(req.missingLabels)}`);
  }

  const names = new Set<string>();
  for (const q of req.questions) {
    if (!q || typeof q.name !== 'string' || !q.name) bad('every question needs a non-empty name');
    if (names.has(q.name)) bad(`duplicate question name '${q.name}'`);
    names.add(q.name);
    if (typeof q.instructions !== 'string' || !q.instructions) bad(`question '${q.name}' has empty instructions`);
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) bad(`question '${q.name}' needs at least 2 options`);
      for (const o of q.options) {
        if (!o || typeof o.name !== 'string' || !o.name || typeof o.description !== 'string' || !o.description) {
          bad(`question '${q.name}' has an option with an empty name or description`);
        }
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.levels) || q.levels.length < 2) bad(`question '${q.name}' needs at least 2 levels`);
      if (q.levels.some((l) => typeof l !== 'string' || !l)) bad(`question '${q.name}' has an empty level`);
      if (new Set(q.levels).size !== q.levels.length) bad(`question '${q.name}': levels must be unique`);
    } else if (q.type !== 'yesno') {
      bad(`question '${(q as ScorerQuestion).name}' has an unknown type`);
    }
  }

  // Strict, because the engine's own decoder is not: llama-server's base64_decode
  // stops silently at the first character outside [A-Za-z0-9+/], so a data: URI or
  // a line-wrapped string would reach the model as a truncated file.
  const images = req.images ?? [];
  if (!Array.isArray(images)) bad('images must be an array of base64 strings');
  images.forEach((s, i) => {
    if (typeof s !== 'string' || !s) bad(`images[${i}] is empty`);
    if (s.length % 4 !== 0 || !BASE64_RE.test(s)) {
      bad(`images[${i}] is not base64 (standard alphabet, padded, no whitespace or data: prefix)`);
    }
    if (Buffer.from(s, 'base64').length === 0) bad(`images[${i}] decodes to zero bytes`);
  });

  if (typeof req.state === 'string' && !req.state.trim() && images.length === 0) {
    bad('state may not be empty unless images carry the state');
  }
}

// --------------------------------------------------------------------------- decider

interface Plan {
  q: ScorerQuestion;
  labels: Label[];
  legend: Array<[string, string]>;
}

function planOf(q: ScorerQuestion): Plan {
  switch (q.type) {
    case 'choice': {
      const labels = assignLabels(
        q.options.map((o) => o.name),
        q.name,
      );
      const legend = labels.map(([letter], i) => [letter, `${q.options[i].name}: ${q.options[i].description}`] as [string, string]);
      return { q, labels, legend };
    }
    case 'score': {
      const labels = assignLabels(q.levels, q.name);
      return { q, labels, legend: labels.map(([l, n]) => [l, n] as [string, string]) };
    }
    case 'yesno': {
      const labels = yesnoLabels();
      return { q, labels, legend: labels.map(([l, n]) => [l, n] as [string, string]) };
    }
  }
}

function timingOf(result: CompletionResult): QuestionTiming {
  return {
    promptMs: Number(result.timings.prompt_ms),
    promptTokens: Math.trunc(Number(result.timings.prompt_n)),
    cachedTokens: Math.trunc(Number(result.timings.cache_n)),
  };
}

function answerOf(plan: Plan, dist: LabelDistribution): ScorerAnswer {
  const options = plan.labels.map(([, name]) => name);
  const probabilities: Record<string, number> = {};
  options.forEach((name, i) => (probabilities[name] = dist.probs[i]));
  const base = {
    options,
    probabilities,
    logProbs: dist.logProbs,
    rawLogProbs: dist.rawLogProbs,
    labelMass: dist.mass,
    ...(dist.missing.length ? { missingLabels: dist.missing } : {}),
  };
  if (plan.q.type === 'yesno') {
    return { type: 'yesno', p: dist.probs[0], ...base };
  }
  let best = 0;
  for (let i = 1; i < dist.probs.length; i++) if (dist.probs[i] > dist.probs[best]) best = i;
  if (plan.q.type === 'choice') {
    return { type: 'choice', choice: options[best], confidence: dist.probs[best], ...base };
  }
  // score: expected value of the 1-based level index
  const score = dist.probs.reduce((s, p, i) => s + (i + 1) * p, 0);
  return { type: 'score', score, level: options[best], confidence: dist.probs[best], ...base };
}

export class ScorerDecider {
  private constructor(
    readonly engine: ScorerEngineLike,
    readonly props: EngineProps,
    readonly builder: ScorerPromptBuilder,
    readonly labelIds: Map<string, number>,
  ) {}

  /** Startup: read /props, render + prove the chat template, prove every label is one token. */
  static async create(engine: ScorerEngineLike): Promise<ScorerDecider> {
    const props = await engine.props();
    if (!props.chatTemplate || !props.chatTemplate.trim()) {
      throw new ScorerError('template_not_answer_ready', 'the engine reported an empty chat_template');
    }
    const builder = await ScorerPromptBuilder.create(engine, props.mediaMarker);
    const labelIds = await resolveLabelTokens(engine);
    return new ScorerDecider(engine, props, builder, labelIds);
  }

  get model(): string {
    return modelNameOf(this.props);
  }

  get assistantPrefix(): string {
    return this.builder.assistantPrefix;
  }

  async decide(req: DecideRequest, options: DecideOptions = {}): Promise<DecideResponse> {
    const t0 = performance.now();
    const signal = options.signal;
    validateDecideRequest(req);
    const stateText = renderState(req.state);

    // Images are checked before anything else touches the engine: too many is the
    // caller's mistake; an engine without vision (no --mmproj) cannot read them.
    const images = req.images ?? [];
    if (images.length > MAX_IMAGES) {
      throw new ScorerError('too_many_images', `the request carries ${images.length} images; at most ${MAX_IMAGES}`);
    }
    if (images.length && !this.props.vision) {
      throw new ScorerError(
        'engine_no_vision',
        `the request carries ${images.length} image(s) but the engine (${this.model}) reports ` +
          `modalities.vision = false; start it with an --mmproj (app-config scorerMmproj)`,
      );
    }
    const nImages = images.length;
    const sendImages = nImages ? images : undefined;
    const nProbs = req.nProbs ?? N_PROBS;
    const policy = req.missingLabels ?? 'error';

    // Resolve every question's labels AND build every prompt BEFORE the first
    // forward pass, so a bad question refuses the whole request instead of after
    // spending GPU time on the others.
    const plans = req.questions.map(planOf);
    const prompts = plans.map((p) =>
      this.builder.build(stateText, p.q.type, p.q.instructions, p.legend, nImages),
    );

    // Prime: with more than one question, prefill the shared prefix (system + state)
    // alone first. Qwen3.5 is hybrid, so the engine can only rewind to a context
    // checkpoint, and a prompt's checkpoints land at batch boundaries rather than at
    // the end of the state; a prefix sent alone leaves one exactly there, and every
    // question then prefills only its own block. With checkpoints off it costs one
    // prefill and buys one; never worse than not priming.
    let prime: QuestionTiming | undefined;
    if (plans.length > 1) {
      const primeResult = await this.engine.completion(
        this.builder.sharedPrefix(stateText, nImages),
        1,
        sendImages,
        signal,
      );
      prime = timingOf(primeResult);
    }

    const answers: Record<string, ScorerAnswer> = {};
    const perQuestion: Record<string, QuestionTiming> = {};
    const perQuestionTokens: Record<string, number> = {};
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      const result = await this.engine.completion(prompts[i], nProbs, sendImages, signal);
      const dist = labelDistribution(result, plan.labels, this.labelIds, plan.q.name, policy);
      answers[plan.q.name] = answerOf(plan, dist);
      perQuestion[plan.q.name] = timingOf(result);
      perQuestionTokens[plan.q.name] = result.tokensEvaluated;
    }

    const total = Math.round((performance.now() - t0) * 10) / 10;
    return {
      model: this.model,
      answers,
      timingMs: { total, perQuestion, ...(prime ? { prime } : {}) },
      tokens: { perQuestion: perQuestionTokens, images: nImages },
    };
  }
}
