/**
 * Scorer types — a TypeScript port of snap's /v1/decide contract
 * (snap/schema.py, snap/errors.py, docs/CONTRACT.md).
 *
 * The scorer makes decisions from text without generating any: one forward
 * pass per question on a local llama-server, reading the next-token
 * distribution at the answer position restricted to the label tokens A..Z.
 *
 * Differences from snap's wire schema, all deliberate:
 *   - camelCase fields (labelMass, not label_mass) to match the backend.
 *   - Questions and options are ARRAYS, not objects. JS objects reorder
 *     integer-like keys ("1", "2"), and option order is the label order, so a
 *     chapter list keyed by number would silently shuffle its letters.
 *   - Every answer also carries per-option log-probabilities (renormalised and
 *     raw), in option order, because Viterbi consumers need log P.
 */

// --------------------------------------------------------------------------- errors

/** code -> HTTP-ish status. 4xx = the caller's request is wrong; 502 = the engine is. */
export const SCORER_ERROR_STATUS = {
  bad_request: 400,
  too_many_options: 400,
  too_many_images: 400,
  label_not_single_token: 502,
  label_not_in_probs: 502,
  engine_unreachable: 502,
  engine_timeout: 502,
  engine_error: 502,
  template_not_answer_ready: 502,
  engine_no_vision: 502,
  // Crucible's decision door (P6): the engine cannot read this question
  // (more options than its top-K cap, or an engine with no logprobs).
  decide_not_served: 503,
  // Crucible has no model its decide class can use, or is older than the door.
  scorer_unavailable: 503,
  // Not in snap: the caller's AbortSignal fired (a cancelled analysis job).
  cancelled: 499,
} as const;

export type ScorerErrorCode = keyof typeof SCORER_ERROR_STATUS;

/** Every failure the scorer reports has a NAME. Nothing is defaulted silently. */
export class ScorerError extends Error {
  readonly code: ScorerErrorCode;
  readonly detail: string;

  constructor(code: ScorerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ScorerError';
    this.code = code;
    this.detail = message;
  }

  get status(): number {
    return SCORER_ERROR_STATUS[this.code];
  }

  toJSON(): { error: { code: ScorerErrorCode; message: string } } {
    return { error: { code: this.code, message: this.detail } };
  }
}

export function isScorerError(err: unknown, code?: ScorerErrorCode): err is ScorerError {
  return err instanceof ScorerError && (code === undefined || err.code === code);
}

// --------------------------------------------------------------------------- request

export interface ChoiceOption {
  /** The option's name; returned as `choice` and as the key of `probabilities`. */
  name: string;
  /** What the option means; shown to the model as "<letter>. <name>: <description>". */
  description: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  /** Unique within the request; answers are keyed by it. */
  name: string;
  instructions: string;
  /** At least 2, at most 26. The first option is label A. */
  options: ChoiceOption[];
}

export interface ScoreQuestion {
  type: 'score';
  name: string;
  instructions: string;
  /** Ordered, lowest first; level i (1-based) is the value used for the expected score. */
  levels: string[];
}

export interface YesNoQuestion {
  type: 'yesno';
  name: string;
  /** A statement; the model is asked whether it is true of the state. */
  instructions: string;
}

export type ScorerQuestion = ChoiceQuestion | ScoreQuestion | YesNoQuestion;

/**
 * What to do when a label letter is not among the engine's top-n tokens.
 *   'error' (default, snap's behaviour): refuse the question as label_not_in_probs.
 *   'floor': give each missing label the probability of the LEAST likely token
 *            the engine did return (an upper bound on its true probability),
 *            list it in `missingLabels`, and answer. For Viterbi consumers that
 *            need a finite log P for every option.
 */
export type MissingLabelPolicy = 'error' | 'floor';

export interface DecideRequest {
  /** A string, or any JSON value (serialised as compact JSON). May be '' only when images carry the state. */
  state: unknown;
  questions: ScorerQuestion[];
  /** Base64 image files (standard alphabet, padded, no whitespace, no data: prefix), placed before the state text. */
  images?: string[];
  /** Top-n requested from the engine (snap: 40). */
  nProbs?: number;
  missingLabels?: MissingLabelPolicy;
}

export interface DecideOptions {
  signal?: AbortSignal;
}

// --------------------------------------------------------------------------- response

interface AnswerBase {
  /** Option names in label order (A, B, ...), aligned with the arrays below. */
  options: string[];
  /** Renormalised probability per option (sums to 1), keyed by option name. */
  probabilities: Record<string, number>;
  /** ln of the renormalised probability, in option order. What Viterbi wants. */
  logProbs: number[];
  /** ln of the raw full-vocabulary probability, in option order (before renormalising). */
  rawLogProbs: number[];
  /** Sum of the raw label probabilities: how much of the model's mass was on an answer. */
  labelMass: number;
  /** Labels absent from top-n that were floored (only with missingLabels: 'floor'). */
  missingLabels?: string[];
}

export interface ChoiceAnswer extends AnswerBase {
  type: 'choice';
  choice: string;
  confidence: number;
}

export interface ScoreAnswer extends AnswerBase {
  type: 'score';
  /** Expected value of the 1-based level index. */
  score: number;
  level: string;
  confidence: number;
}

export interface YesNoAnswer extends AnswerBase {
  type: 'yesno';
  /** p(Yes). options = ['Yes', 'No']. */
  p: number;
}

export type ScorerAnswer = ChoiceAnswer | ScoreAnswer | YesNoAnswer;

export interface QuestionTiming {
  /** llama-server: timings.prompt_ms. Crucible: the door's wall clock for that completion. */
  promptMs: number;
  /** llama-server: timings.prompt_n (tokens actually processed). Crucible: usage.prompt_tokens (the whole prompt). */
  promptTokens: number;
  /** Tokens reused from the KV cache; null when the engine did not say (Crucible never reports an unmeasured 0). */
  cachedTokens: number | null;
}

export interface DecideResponse {
  model: string;
  answers: Record<string, ScorerAnswer>;
  timingMs: {
    total: number;
    perQuestion: Record<string, QuestionTiming>;
    /** Present when the request carried more than one question (the shared prefix was primed). */
    prime?: QuestionTiming;
  };
  tokens: {
    /** server tokens_evaluated per question (whole prompt length, image tokens included) */
    perQuestion: Record<string, number>;
    images: number;
  };
}

// --------------------------------------------------------------------------- generate

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  /** Hard cap on generated tokens. */
  maxTokens: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  model: string;
}
