/**
 * THE SCORER'S DECISIONS, READ OFF CRUCIBLE'S `POST /v1/decide` (P6).
 *
 * The boundary (the user's rule): Crucible reserves the card and returns data
 * — one distribution per question — and nothing else. Chapters and flags stay
 * in Briefcase; this file only swaps the TRANSPORT under the scorer seam
 * (`ScorerHandle.decide`), so every pipeline above it sees the same
 * {@link DecideResponse} the scorer produced before P7 on its own llama-server:
 *
 *   request   Briefcase's arrays → the wire's ordered objects. State,
 *             instructions, option names and descriptions cross verbatim; the
 *             frame (system prompt, legend, letters) is Crucible's, the same
 *             snap port (PHASE22 §2.3). `nProbs` has no wire field: the
 *             server's K is the labels plus 4, clamped to the engine's cap.
 *   missing   always `"report"`, so the server never refuses a question for a
 *             label outside its top-K, and Briefcase's own 'floor' policy is
 *             applied HERE, client-side (see {@link floorAnswer}).
 *   answers   the renormalised `logprobs` feed Viterbi; `labelMass` is the
 *             returned letters' raw mass.
 *
 * PURE: no I/O, so the mapping is pinned by unit tests.
 */

import type {
  DecideAnswer as WireAnswer,
  DecideQuestion as WireQuestion,
  DecideRequest as WireRequest,
  DecideResponse as WireResponse,
} from '@crucible/client';
import { MAX_IMAGES, validateDecideRequest } from './decide-request';
import { MAX_OPTIONS, YESNO_OPTIONS } from './scorer-labels';
import {
  DecideRequest,
  DecideResponse,
  QuestionTiming,
  ScorerAnswer,
  ScorerError,
  ScorerQuestion,
} from './scorer.types';

/**
 * Below this much raw mass on the returned letters, an answer says nothing
 * about the options: the model wanted to write something that is not a letter
 * (PHASE22 §2.2: "a caller gates on label_mass before it believes p"). A gated
 * answer is flattened to the uniform distribution — no evidence either way —
 * so Viterbi's switch cost, not noise, decides that unit. 0.01 is ~50x under
 * anything the 9B was seen to answer on a real question (label_mass 0.9+).
 */
export const LABEL_MASS_GATE = 0.01;

/** ln(1e-12): the chapter matrix's own floor (segmenter.ts LOG_FLOOR), the lowest a floored label may go. */
const LOG_FLOOR = Math.log(1e-12);

/**
 * The server's top-K margin (PHASE22 §2.4: "K is the number of labels in the
 * question plus 4"). Used only to bound a missing label's probability.
 */
export const DECIDE_TOP_K_MARGIN = 4;

/** A JS object lists integer-like keys first, whatever order they were written in. */
function integerLike(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** The labels of one Briefcase question, in label order (A, B, …). */
export function labelsOf(q: ScorerQuestion): string[] {
  if (q.type === 'choice') return q.options.map((o) => o.name);
  if (q.type === 'score') return [...q.levels];
  return [...YESNO_OPTIONS];
}

/**
 * Briefcase's request as the wire's. Order is meaning (the option order is the
 * letter order), and the wire carries options and questions as JSON objects,
 * so a name a JS object would reorder is refused here by name rather than
 * silently re-lettered. Every validation of decide-request.ts runs
 * first, so a bad request is refused before the card is touched.
 */
export function toWireRequest(model: string, req: DecideRequest): WireRequest {
  validateDecideRequest(req);
  const images = req.images ?? [];
  if (images.length > MAX_IMAGES) {
    throw new ScorerError('too_many_images', `the request carries ${images.length} images; at most ${MAX_IMAGES}`);
  }
  const questions: Record<string, WireQuestion> = {};
  for (const q of req.questions) {
    if (integerLike(q.name)) {
      throw new ScorerError('bad_request', `question name '${q.name}' is integer-like; the wire would reorder it`);
    }
    if (q.type === 'choice') {
      if (q.options.length > MAX_OPTIONS) {
        throw new ScorerError('too_many_options', `question '${q.name}' has ${q.options.length} options; the label set is A..Z (${MAX_OPTIONS})`);
      }
      const options: Record<string, string> = {};
      for (const o of q.options) {
        if (integerLike(o.name)) {
          throw new ScorerError('bad_request', `question '${q.name}': option name '${o.name}' is integer-like; the wire would re-letter it`);
        }
        if (o.name in options) throw new ScorerError('bad_request', `question '${q.name}' has duplicate option names`);
        options[o.name] = o.description;
      }
      questions[q.name] = { type: 'choice', instructions: q.instructions, options };
    } else if (q.type === 'score') {
      if (q.levels.length > 10) {
        throw new ScorerError('too_many_options', `question '${q.name}' has ${q.levels.length} levels; the decision door takes 2-10`);
      }
      questions[q.name] = { type: 'score', instructions: q.instructions, levels: [...q.levels] };
    } else {
      questions[q.name] = { type: 'yesno', instructions: q.instructions };
    }
  }
  return {
    model,
    state: req.state,
    ...(images.length ? { images } : {}),
    questions,
    missing: 'report',
  };
}

/** One answer's distribution over its labels, in label order, as the wire gave it (null = missing, or p exactly 0). */
function wireLogprobs(answer: WireAnswer, labels: string[]): Array<number | null> {
  if (answer.type === 'yesno') {
    // p is the renormalised P(Yes) over the letters returned.
    const missing = new Set(answer.missingLabels ?? []);
    const yes = missing.has('Yes') ? null : answer.p > 0 ? Math.log(answer.p) : null;
    const no = missing.has('No') ? null : answer.p < 1 ? Math.log1p(-answer.p) : null;
    return [yes, no];
  }
  return labels.map((l) => {
    const lp = answer.logprobs[l];
    return typeof lp === 'number' && Number.isFinite(lp) ? lp : null;
  });
}

export interface FlooredDistribution {
  /** Renormalised over every label (floored ones included), in label order. */
  logProbs: number[];
  probs: number[];
  /** ln of the raw full-vocabulary probability (the floor for a missing label), in label order. */
  rawLogProbs: number[];
  /** The raw mass of the letters the engine returned. */
  mass: number;
  /** Labels (option names) that were outside the top-K and floored. */
  missing: string[];
  /** True when the answer fell under {@link LABEL_MASS_GATE} and was flattened. */
  gated: boolean;
}

/**
 * Briefcase's 'floor' policy (the llama-server path's labelDistribution, before P7) on a
 * report-mode answer. On its own llama-server a missing label took the logprob
 * of the least likely token the engine returned — an upper bound on its true
 * probability. The door returns only the letters, so the floor here is the
 * tighter of two bounds the answer itself proves, both upper bounds on a
 * label outside the top-K (and both at or above the llama-server floor):
 *
 *   - the smallest returned label's raw probability (every returned label is
 *     in the top-K, a missing one is not), and
 *   - the raw mass NOT on the returned letters, shared over the top-K's other
 *     entries: at least (missing labels + {@link DECIDE_TOP_K_MARGIN}) tokens
 *     each at or above the missing label's probability.
 *
 * clamped to ln(1e-12), the chapter matrix's own floor. Then the whole row is
 * renormalised in log space, exactly as that path did it.
 */
export function floorAnswer(answer: WireAnswer, labels: string[], question: string): FlooredDistribution {
  const mass = answer.labelMass;
  const lnMass = mass > 0 ? Math.log(mass) : -Infinity;
  const given = wireLogprobs(answer, labels);
  const missingSet = new Set(answer.missingLabels ?? []);
  const missing = labels.filter((l) => missingSet.has(l));
  // Raw (full-vocabulary) logprobs: renormalised + ln(mass). null = outside the
  // top-K (floored below); -Infinity = returned at a probability of exactly 0.
  const raw: Array<number | null> = labels.map((l, i) => {
    if (missingSet.has(l)) return null;
    const lp = given[i];
    return lp === null ? -Infinity : lp + lnMass;
  });
  if (raw.every((x) => x === null || x === -Infinity)) {
    throw new ScorerError('label_not_in_probs', `question '${question}': the engine returned no label with any probability`);
  }
  let floor = -Infinity;
  if (missing.length) {
    const returned = raw.filter((x): x is number => x !== null && Number.isFinite(x));
    const smallest = returned.length ? Math.min(...returned) : -Infinity;
    const rest = 1 - mass;
    const shared = rest > 0 ? Math.log(rest / (missing.length + DECIDE_TOP_K_MARGIN)) : -Infinity;
    floor = Math.max(LOG_FLOOR, Math.min(smallest, shared));
  }
  const rawLogProbs = raw.map((x) => (x === null ? floor : x));

  if (mass < LABEL_MASS_GATE) {
    const flat = -Math.log(labels.length);
    return {
      logProbs: labels.map(() => flat),
      probs: labels.map(() => 1 / labels.length),
      rawLogProbs,
      mass,
      missing,
      gated: true,
    };
  }
  const logZ = logSumExp(rawLogProbs);
  if (!Number.isFinite(logZ)) {
    throw new ScorerError('label_not_in_probs', `question '${question}': every label has probability 0`);
  }
  const logProbs = rawLogProbs.map((lp) => lp - logZ);
  return { logProbs, probs: logProbs.map(Math.exp), rawLogProbs, mass, missing, gated: false };
}

/** The Briefcase answer for one question (the same shapes scorer-decide.ts answerOf builds). */
export function toScorerAnswer(q: ScorerQuestion, answer: WireAnswer): ScorerAnswer {
  if (answer.type !== q.type) {
    throw new ScorerError('engine_error', `question '${q.name}' was a ${q.type} and came back a ${answer.type}`);
  }
  const labels = labelsOf(q);
  const dist = floorAnswer(answer, labels, q.name);
  const probabilities: Record<string, number> = {};
  labels.forEach((name, i) => (probabilities[name] = dist.probs[i]));
  const base = {
    options: labels,
    probabilities,
    logProbs: dist.logProbs,
    rawLogProbs: dist.rawLogProbs,
    labelMass: dist.mass,
    ...(dist.missing.length ? { missingLabels: dist.missing } : {}),
    ...(dist.gated ? { gated: true as const } : {}),
  };
  if (q.type === 'yesno') return { type: 'yesno', p: dist.probs[0], ...base };
  let best = 0;
  for (let i = 1; i < dist.probs.length; i++) if (dist.probs[i] > dist.probs[best]) best = i;
  if (q.type === 'choice') return { type: 'choice', choice: labels[best], confidence: dist.probs[best], ...base };
  const score = dist.probs.reduce((s, p, i) => s + (i + 1) * p, 0);
  return { type: 'score', score, level: labels[best], confidence: dist.probs[best], ...base };
}

function timingOf(t: { wallMs: number; promptTokens: number; cachedTokens: number | null }): QuestionTiming {
  return { promptMs: t.wallMs, promptTokens: t.promptTokens, cachedTokens: t.cachedTokens };
}

/** The wire's response as Briefcase's {@link DecideResponse}. */
export function fromWireResponse(req: DecideRequest, res: WireResponse): DecideResponse & { gated: number } {
  const answers: Record<string, ScorerAnswer> = {};
  const perQuestion: Record<string, QuestionTiming> = {};
  const perQuestionTokens: Record<string, number> = {};
  let gated = 0;
  for (const q of req.questions) {
    const wire = res.answers[q.name];
    if (wire === undefined) throw new ScorerError('engine_error', `decide returned no answer for '${q.name}'`);
    const answer = toScorerAnswer(q, wire);
    if (answer.gated) gated++;
    answers[q.name] = answer;
    const t = res.timingMs.perQuestion[q.name];
    if (t !== undefined) perQuestion[q.name] = timingOf(t);
    perQuestionTokens[q.name] = res.tokens.perQuestion[q.name] ?? 0;
  }
  return {
    model: res.model.id,
    answers,
    timingMs: {
      total: res.timingMs.total,
      perQuestion,
      ...(res.timingMs.prime ? { prime: timingOf(res.timingMs.prime) } : {}),
    },
    tokens: { perQuestion: perQuestionTokens, images: res.tokens.images },
    gated,
  };
}
