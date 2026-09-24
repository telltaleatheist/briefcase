/**
 * AI Analysis Service — the snap engine, then the LLM stages, all on Crucible.
 *
 *   Scorer stage (SnapAnalysisService, Crucible's decision door): the chapter
 *           outline + assignment + Viterbi, and the flag ranking, in one lease.
 *   Pass 2: each chapter's summary from the LLM (the outline gave its title).
 *   Pass 2b: the flag sections from the decide map (verifyFlagsWithLlm is off:
 *           no LLM check; turned on, each window is verified by the LLM).
 *
 * Metadata (description, tags, title) is generated from chapter summaries.
 * Snap is the only engine (P7 removed the classic embedding/lexical chaptering,
 * the NLI ranker and LLM chapter discovery): a stage that cannot be made fails
 * the analysis by name, and a busy or silent Crucible parks the task.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AIProviderService, AIProviderConfig } from './ai-provider.service';
import { ensureNotCancelled, isCancellation, stopsTheRun } from './cancellation';
import { isParked } from '../crucible/llm/errors';
import { estimateNumCtx, numCtxMaxForModel, parseProviderModel, AITaskKind } from './model-utils';
import { crucibleTargetOf } from '../crucible/llm/target';
import { CRUCIBLE_OLLAMA_CONTEXT } from '../crucible/llm/ollama-map';
import { assembleSentences, FlagWindow, RankedSentence, WindowCategory } from './flag-windows';
import { safeJsonParse } from './json-utils';
import { DatabaseService } from '../database/database.service';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildChapterAnalysisPrompt,
  buildFlagVerificationPrompt,
  FLAG_VERIFICATION_PROMPT_VERSION,
  interpolatePrompt,
  HOOK_FROM_CHAPTERS_PROMPT,
  BODY_FROM_CHAPTERS_PROMPT,
  REGISTER_RESTATEMENT,
  TAGS_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_CHAPTERS_PROMPT,
  TITLE_FROM_WEBPAGE_PROMPT,
  AnalysisCategory,
} from './prompts/analysis-prompts';
import { SnapAnalysisService } from '../scorer/snap-analysis.service';
import { leafChapters, nestAnalysisChapters } from '../scorer/chapters/chapter-tree';
import type { SnapFlagRankResult } from '../scorer/flags/snap-flag-ranker.service';
import { mergeSpanSubPassages, promoteCachedOverflow } from '../scorer/flags/flag-integration';
import {
  buildChapterLines,
  buildHashtags,
  composeDescription,
  detectNarratedActor,
  truncateAtWordBoundary,
  HOOK_MAX_CHARS,
} from './description-composer';

// =============================================================================
// INTERFACES
// =============================================================================

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Quote {
  timestamp: string;
  text: string;
  significance?: string;
}

export interface AnalyzedSection {
  category: string;
  description: string;
  start_time: string;
  end_time: string | null;
  quotes: Quote[];
  /**
   * The flag verifier's answer for this (passage, category).
   *
   * The ranked path emits BOTH: 'flag' for a passage the verifier accepted, and
   * 'skip' for one it rejected as reported / quoted / questioned / opposed
   * rather than asserted. Rejected passages are not discarded any more — they
   * are stored and shown, ghosted, at the LOOSE filter position, because a
   * capture-wide-then-filter pipeline that threw its rejections away could never
   * show the user what it decided not to show them.
   *
   * ABSENT on everything that is not a flag (chapter sections, legacy rows
   * from the retired discovery engine). Absent is read as 'flag' everywhere.
   *
   * 'candidate' comes only from the snap engine: a ranked passage beyond the
   * verify budget, stored unverified (plan §5.6) and shown only at All.
   */
  verdict?: 'flag' | 'skip' | 'candidate';
  /**
   * The ranker's score, 0-1, for the category this section carries — the
   * number the display filter thresholds on. For ranker 'nli' an entailment
   * probability; for 'snap-v1' the snap span score s_c (same column, told apart
   * by `ranker`). Absent wherever there is no ranker score, and absent passes
   * every filter.
   */
  nli_score?: number;
  /** Which ranker produced the candidate ('nli' | 'snap-v1'). Absent on legacy rows. 'nli' rows predate P7 and are displayed, never produced. */
  ranker?: 'nli' | 'snap-v1';
}

export interface Chapter {
  sequence: number;
  start_time: string;
  end_time: string;
  title: string;
  summary?: string;
  /**
   * True when analysis of this chapter failed after retries. Failed chapters are
   * NEVER persisted as content (see finalize) — they carry no fabricated title —
   * and are excluded from description/tags/title generation. They exist in the
   * in-memory result only so the failure is counted and visible, never silently
   * dropped or written to the DB as a fake successful chapter.
   */
  failed?: boolean;
  /**
   * Outline level on a nested (snap refined) analysis: 0 = top level. Absent
   * on flat analyses. Rows are in preorder, parents before their children.
   */
  level?: number;
  /** `sequence` of the parent row, on a nested analysis below level 0. */
  parent_sequence?: number;
}

// Interface for category flags detected within chapters
export interface ChapterFlag {
  category: string;
  description: string;
  quote: string;
}

// Interface for chapter analysis response
interface ChapterAnalysisResult {
  title: string;
  summary: string;
  flags?: ChapterFlag[];
}

export interface Tags {
  people: string[];
  topics: string[];
}

export interface AnalysisProgress {
  phase: string;
  progress: number;
  message: string;
  eta?: number;           // Estimated seconds remaining
  elapsedMs?: number;     // Milliseconds elapsed since start
}

export interface AnalysisOptions {
  provider: 'local' | 'ollama' | 'openai' | 'claude';
  model: string;
  transcript: string;
  segments: Segment[];
  outputFile: string;
  customInstructions?: string;
  videoTitle?: string;
  categories?: AnalysisCategory[];
  onProgress?: (progress: AnalysisProgress) => void;
  /**
   * Queue job this analysis belongs to. Supplying it is what makes the run
   * CANCELLABLE: the run registers under this id, and `job.cancel-requested`
   * for the same id aborts its in-flight call and stops its stage loops (the
   * Crucible run then releases its lease).
   *
   * Optional because the standalone analysis controller and the smoke harnesses
   * have no queue job. Those runs behave exactly as before — uncancellable, but
   * unaffected by anyone else's cancel.
   */
  jobId?: string;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  apiCalls: number;
}

export interface AnalysisResult {
  sections_count: number;
  sections: AnalyzedSection[];
  chapters: Chapter[];
  // null = generation explicitly failed (recorded, not fabricated). undefined =
  // not attempted. A placeholder string is never synthesized on failure.
  tags?: Tags | null;
  description?: string | null;
  suggested_title?: string;
  tokenStats?: TokenStats;
  /**
   * Non-fatal outcomes the user should know about, carried out to the queue
   * job (TaskResult.warnings -> job.warnings) where the library and queue
   * surfaces already render them: sub-chapters skipped, and the scorer's
   * answers read as no evidence (the label-mass gate), counted.
   */
  warnings?: string[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 3;
const JSON_PARSE_RETRIES = 2;

/**
 * Tasks whose model may be overridden via `taskModels` in app-config.json.
 *
 * EVERY LLM task is routable. The two that read long spans of raw transcript
 * (chapter, flags) are safe to route because the chapter caps are computed as
 * the MOST CONSERVATIVE limits across whichever models those tasks resolve to —
 * see `perTaskLimits` in analyzeTranscript. Sizing to one model while another
 * does the reading is what would silently truncate prompts, so the caps follow
 * the smallest context in play.
 *
 * Tasks are executed grouped by model (chaptering, then Pass 2b, then metadata
 * ordered main-model-first), so each routed model loads once rather than being
 * swapped in and out per call.
 */
const ROUTABLE_TASKS = ['chapter', 'flags', 'description', 'tags', 'title'] as const;

/**
 * `taskModels` keys that named a task P7 removed: 'boundary' was the classic
 * engine's boundary placement. A stored entry is read and ignored quietly
 * (it is not a mistake the user made), not warned about on every run.
 */
const RETIRED_TASKS: ReadonlySet<string> = new Set(['boundary']);

/**
 * The context an `ollama/` model is chunked for THROUGH CRUCIBLE, when the
 * server has no model of its own to run it as (ollama-map.ts has the constant
 * and why: Crucible forwards no num_ctx, so Ollama serves its 4K default).
 */
export { CRUCIBLE_OLLAMA_CONTEXT };

/**
 * JSON Schema for ONE flag-verification verdict: `{"verdict": "flag" | "skip"}`.
 *
 * THE CONSTRAINT INVERSION — read this before unconstraining it.
 *
 * Constraining the OLD open-ended flag DISCOVERY call (removed in P7) hurt:
 * recall 7.3 -> 5.7 of 11 and false positives 0.7 -> 3.0 per run, because the
 * suppressed reasoning was paying for the assert-vs-debunk judgment. That call
 * read a whole chapter, decided what was in it and produced a variable-length
 * list of quotes and categories. Reasoning was the work there.
 *
 * This call is the opposite shape: the candidate is already chosen, the claim is
 * already stated, and the answer is one of two tokens. It is
 * mechanical-with-a-test, the same class as boundary placement — and the
 * measurement inverts with the shape (final-score.txt, qwen3.8:27b, same 70
 * candidates, same prompt):
 *
 *   constrained    9/10 recall vs the hand audit,  2.90s/call median, 204s total
 *   UNCONSTRAINED  6/10 recall vs the hand audit, 20.30s/call median, 3,091s
 *
 * Unconstrained was WORSE on quality AND ~7x slower: given room to reason about
 * one line, the model talks itself out of real flags and into "misinformation"
 * mislabels. So this stage is constrained, with no opt-out.
 */
const FLAG_VERIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['flag', 'skip'] },
  },
  required: ['verdict'],
  additionalProperties: false,
};

/**
 * Whether the chat model double-checks each flag section the decide map made.
 *
 * OFF (2026-09-24, the user: "decide only for now. see how it turns out"): the
 * sections come straight from the decide map, strongest first, all stored as
 * flags. Turning it back on restores the verified path below unchanged
 * (budget, verdict cache, ghosted rejections, unverified overflow).
 */
const VERIFY_FLAGS_WITH_LLM = false;

/** Where the analysis engine's share of the progress bar ends (it starts at 3). */
const ENGINE_BAND_END = 70;

/**
 * Output budget for one verification call, used only to SIZE num_ctx.
 *
 * A verdict is ~10 tokens of JSON and the constrained decode measured 27-30
 * output tokens end to end; 2048 is headroom, not an expectation. It keeps the
 * bucketed num_ctx at its floor so the stage pins one small context for every
 * call instead of paying an Ollama model reload per call.
 */
const VERIFY_OUTPUT_BUDGET_TOKENS = 2048;

/**
 * JSON Schema for tag extraction — the SAME `{people, topics}` shape the parser
 * and every downstream consumer already expect. The schema pins the shape; the
 * prompt and its intent are unchanged.
 */
const TAGS_EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    people: { type: 'array', items: { type: 'string' } },
    topics: { type: 'array', items: { type: 'string' } },
  },
  required: ['people', 'topics'],
};

/**
 * `{"hook": string}` — the ≤150-char search snippet (spec §5).
 *
 * Deliberately NO maxLength: measured on qwen3.5 4b/9b, Ollama enforces schema
 * maxLength by TRUNCATING the decode mid-word — the server silently rewrites
 * the search snippet. The 150-char cap is enforced in code (word-boundary
 * truncation after the re-ask path), where the cut is at least controlled.
 */
const HOOK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { hook: { type: 'string' } },
  required: ['hook'],
};

/** `{"body": string}` — the 150-300 word paragraph (spec §5). */
const BODY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { body: { type: 'string' } },
  required: ['body'],
};

/**
 * Kill switches for the metadata schemas.
 *
 * Open-ended flag discovery (removed in P7) was a JUDGMENT task: the measured
 * A/B showed structured output bought 5.5x speed at the cost of recall. Tags
 * and description are MECHANICAL — extraction and format
 * transforms over summaries that were already the product of judgment upstream —
 * which is exactly the class where constraining is pure win (it collapses a
 * thinking model's output from thousands of reasoning tokens to the answer; a
 * prior run measured a 9b spending 7,369 tokens writing a filename). So they are
 * constrained by DEFAULT, with an env escape hatch for A/B-ing the trade back.
 */
const TAGS_UNCONSTRAINED = process.env.BRIEFCASE_TAGS_UNCONSTRAINED === '1';
const DESCRIPTION_UNCONSTRAINED = process.env.BRIEFCASE_DESCRIPTION_UNCONSTRAINED === '1';

// Job-level failure accounting. Any analysis step that cannot produce a real
// result — a chapter that exhausts its retries, a description/tags generation
// that fails — is recorded
// as an explicit failure instead of being papered over with fabricated data.
// Once this many steps have failed, the whole job aborts with TOO_MANY_FAILURES
// rather than shipping a mostly-empty analysis that looks successful.
const MAX_FAILURES = 10;

// =============================================================================
// JSON EXTRACTION AND VALIDATION HELPERS
// =============================================================================

/**
 * Validate chapter analysis result has required fields
 */
function validateChapterAnalysisResult(data: unknown): ChapterAnalysisResult | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Must have a title (string)
  if (typeof obj.title !== 'string' || obj.title.trim() === '') {
    return null;
  }

  // Summary should be string (can be empty)
  const summary = typeof obj.summary === 'string' ? obj.summary : '';

  // Flags should be array if present
  let flags: ChapterFlag[] = [];
  if (Array.isArray(obj.flags)) {
    flags = obj.flags.filter((f): f is ChapterFlag => {
      return (
        f &&
        typeof f === 'object' &&
        typeof (f as ChapterFlag).category === 'string' &&
        (typeof (f as ChapterFlag).description === 'string' ||
          typeof (f as ChapterFlag).quote === 'string')
      );
    });
  }

  return {
    title: obj.title.trim(),
    summary: summary.trim(),
    flags,
  };
}

// Model size limits - conservative estimates based on typical context windows
// These ensure a chapter fits comfortably with room for prompts and output
interface ModelLimits {
  maxChapterChars: number;     // Max chars per chapter for analysis
}

/**
 * Per-chapter size limits that are guaranteed to FIT the context window the
 * model will actually run with, so the transcript is never silently truncated:
 * the CHARACTER cap is derived from `contextTokens`, the real ceiling (a
 * Crucible catalog model's served context, an `ollama/` upstream's window, or
 * a cloud model's large one). Snap chapters are never split for time: the
 * outline's Viterbi switch cost owns granularity.
 */
function getModelLimits(contextTokens: number): ModelLimits {
  // Reserve context for generation + prompt scaffolding (template + categories),
  // then convert the remaining input budget to chars. Thinking models use the
  // leftover generation headroom for their chain of thought.
  const OUTPUT_RESERVE_TOKENS = 4096;
  const SCAFFOLD_TOKENS = 1024;
  const CHARS_PER_TOKEN = 3;
  const usableInputTokens = Math.max(1024, contextTokens - OUTPUT_RESERVE_TOKENS - SCAFFOLD_TOKENS);
  return { maxChapterChars: usableInputTokens * CHARS_PER_TOKEN };
}

// =============================================================================
// SERVICE
// =============================================================================

/**
 * Whether a section belongs in the human-readable .txt report: accepted flags
 * and legacy/discovery rows (no verdict) only, never 'skip' or 'candidate'.
 */
export function isReportedFinding(section: Pick<AnalyzedSection, 'verdict'>): boolean {
  return !section.verdict || section.verdict === 'flag';
}

@Injectable()
export class AIAnalysisService {
  private readonly logger = new Logger(AIAnalysisService.name);
  /** `ollama/` models already told they are chunked for Ollama's default context (said once per process). */
  private readonly crucibleOllamaNoted = new Set<string>();
  /** Whether the chat model double-checks each flag section (VERIFY_FLAGS_WITH_LLM; a spec turns it on to test that path). */
  verifyFlagsWithLlm = VERIFY_FLAGS_WITH_LLM;

  constructor(
    private readonly aiProviderService: AIProviderService,
    /** The snap engine's scorer stage (chapters + flag ranking on Crucible's decision door). */
    private readonly snapAnalysis: SnapAnalysisService,
    /**
     * OPTIONAL on purpose. This service is constructed directly by smoke
     * harnesses and by callers that have no library open, and the only thing it
     * uses the database for is the verdict cache — an optimization. A missing
     * DatabaseService means every question is asked of the model, which is
     * exactly the behavior before the cache existed. It must never be the reason
     * an analysis cannot run.
     */
    @Optional() private readonly databaseService?: DatabaseService,
  ) {}

  // ===========================================================================
  // CANCELLATION
  // ===========================================================================

  /**
   * Analyses currently in flight, keyed by queue job id.
   *
   * A MAP rather than a single field: analyses on different Crucible lanes
   * (a GPU lane and the cloud lane) can run at once.
   */
  private readonly activeRuns = new Map<string, { controller: AbortController }>();

  /**
   * Cancel the analysis belonging to one queue job.
   *
   * Scoped per job, exactly like whisper/ffmpeg/downloader's handlers: an id we
   * are not running is a no-op, so cancelling a download cannot disturb an
   * analysis and vice versa. Idempotent.
   */
  @OnEvent('job.cancel-requested')
  handleJobCancelRequested(payload: { jobId?: string }): void {
    const jobId = payload?.jobId;
    if (!jobId) return;
    this.cancelAnalysis(jobId);
  }

  /**
   * The cancel itself, split out from the event handler so it can be driven
   * directly (tests, and any future in-process caller).
   *
   * The abort kills the open call (a chat or a decide), and every stage loop's
   * next `ensureNotCancelled` throws instead of issuing another one. The
   * Crucible run the analysis is inside releases its lease as it unwinds.
   *
   * Returns false when no such run exists.
   */
  cancelAnalysis(jobId: string): boolean {
    const run = this.activeRuns.get(jobId);
    if (!run) return false;

    this.logger.log(`Cancelling AI analysis for job ${jobId}`);
    run.controller.abort();
    return true;
  }

  /**
   * Per-task model routing, read from `taskModels` in app-config.json:
   *
   *   "taskModels": { "tags": "ollama:qwen3.5:9b", "description": "ollama:qwen3.5:9b" }
   *
   * Values are "provider:model" strings; a task with no entry uses the job's
   * main model. The point is to let cheap, narrow tasks (metadata generation)
   * run on a small fast model while chapter analysis keeps the big one.
   *
   * Returns {} on any read/parse failure — routing is an optimization, and a
   * malformed config must not take the whole analysis down.
   */
  private appConfigPath(): string {
    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config'));
    return path.join(userDataPath, 'briefcase', 'app-config.json');
  }

  private loadTaskModelOverrides(): Partial<Record<AITaskKind, string>> {
    try {
      const configPath = this.appConfigPath();
      if (!fs.existsSync(configPath)) return {};

      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))?.taskModels;
      if (!raw || typeof raw !== 'object') return {};

      const out: Partial<Record<AITaskKind, string>> = {};
      for (const task of ROUTABLE_TASKS) {
        if (typeof raw[task] === 'string' && raw[task].trim()) out[task] = raw[task].trim();
      }

      // Anything outside ROUTABLE_TASKS is not a task this pipeline runs, so an
      // entry for it silently does nothing. Warn loudly instead of ignoring it
      // (a retired task's entry is not the user's mistake: ignored quietly).
      const rejected = Object.keys(raw).filter(
        (k) => !ROUTABLE_TASKS.includes(k as (typeof ROUTABLE_TASKS)[number]) && !RETIRED_TASKS.has(k),
      );
      if (rejected.length) {
        this.logger.warn(
          `[TaskModels] Ignoring non-routable task override(s): ${rejected.join(', ')}. ` +
          `Only ${ROUTABLE_TASKS.join(', ')} can be routed — the others drive context sizing.`,
        );
      }
      return out;
    } catch (error) {
      this.logger.warn(`[TaskModels] Ignoring unreadable taskModels config: ${(error as Error).message}`);
      return {};
    }
  }

  /**
   * Resolve the provider config for one task, applying any `taskModels` override.
   * Keys are the serving Crucible's, so an override naming an upstream is taken
   * as it is; the server refuses by name if it has no key for it.
   */
  private resolveTaskConfig(
    base: AIProviderConfig,
    task: AITaskKind,
    overrides: Partial<Record<AITaskKind, string>>,
  ): AIProviderConfig {
    const spec = overrides[task];
    if (!spec) return base;

    const parsed = parseProviderModel(spec);
    const provider = parsed.provider ?? base.provider;
    const model = parsed.model;
    if (!model || (provider === base.provider && model === base.model)) return base;

    this.logger.log(`[TaskModels] ${task} -> ${provider}:${model}`);
    return { ...base, provider, model };
  }

  /**
   * Main entry point: analyse a transcript. The snap scorer stage (chapters
   * and flag ranking), then Pass 2 (chapter summaries), Pass 2b (flag
   * verification) and the metadata, all on Crucible (see the file header).
   */
  async analyzeTranscript(options: AnalysisOptions): Promise<AnalysisResult> {
    // ONE Crucible run per analysis: each local model the run uses is loaded
    // once, leased and heartbeaten until the analysis settles (done, failed or
    // cancelled), then released.
    return this.aiProviderService.withRun(() => this.analyzeTranscriptRun(options));
  }

  private async analyzeTranscriptRun(options: AnalysisOptions): Promise<AnalysisResult> {
    console.log('=== AIAnalysisService.analyzeTranscript CALLED (Two-Pass) ===');
    console.log(`Provider: ${options.provider}, Model: ${options.model}`);
    console.log(`[analyzeTranscript] SEGMENTS RECEIVED: ${options.segments?.length || 0}`);
    if (options.segments && options.segments.length > 0) {
      console.log(`[analyzeTranscript] First segment: start=${options.segments[0].start}, end=${options.segments[0].end}, text="${options.segments[0].text?.substring(0, 50)}"`);
      console.log(`[analyzeTranscript] Last segment: start=${options.segments[options.segments.length - 1].start}, end=${options.segments[options.segments.length - 1].end}`);
    } else {
      console.log(`[analyzeTranscript] WARNING: No segments or empty segments array!`);
    }
    this.logger.log('=== AIAnalysisService.analyzeTranscript CALLED (Two-Pass) ===');
    this.logger.log(`Provider: ${options.provider}, Model: ${options.model}`);

    let {
      provider,
      model,
      segments,
      outputFile,
      videoTitle = '',
      categories,
      customInstructions,
      onProgress,
      jobId,
    } = options;

    // ---- cancellation ------------------------------------------------------
    // ONE signal for the whole run. Every stage loop checks it before starting
    // its next unit of work and every provider call carries it, so a cancel
    // both kills the open generation and stops the pipeline issuing more.
    const controller = new AbortController();
    const signal = controller.signal;
    const run = { controller };

    // EVERY run registers, even one with no queue job (it is then not
    // cancellable by id, since nothing can name it).
    const runKey = jobId ?? `standalone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stale = this.activeRuns.get(runKey);
    if (stale) {
      // Can only happen if a previous run for this id never unwound. Abort it
      // rather than orphaning its controller under the new registration.
      this.logger.warn(`[Analysis] Replacing a still-registered run for job ${runKey}`);
      stale.controller.abort();
    }
    this.activeRuns.set(runKey, run);

    // Strip provider prefix from model if present (shared parser, one source of
    // truth across all entry points), e.g. "local:qwen3.5-9b" -> "qwen3.5-9b".
    {
      const parsed = parseProviderModel(model, provider);
      if (parsed.provider && parsed.provider !== provider) {
        this.logger.log(`[analyzeTranscript] Correcting provider: ${provider} -> ${parsed.provider}`);
        provider = parsed.provider;
      }
      if (parsed.model !== model) {
        model = parsed.model;
        this.logger.log(`[analyzeTranscript] Stripped model prefix: ${model}`);
      }
    }

    // Job-level failure accounting: record explicit failures and abort loudly
    // rather than fabricating success once too many steps fail.
    let failureCount = 0;
    // Remember the most recent failure so an all-failed run can report the real
    // reason (e.g. the underlying Claude API error) instead of an opaque message.
    let lastFailureReason = '';
    const recordFailure = (what: string): void => {
      failureCount++;
      lastFailureReason = what;
      this.logger.error(`[Analysis Failure ${failureCount}/${MAX_FAILURES}] ${what}`);
      if (failureCount >= MAX_FAILURES) {
        throw new Error(
          `TOO_MANY_FAILURES: ${failureCount} analysis steps failed (threshold ${MAX_FAILURES}). ` +
          `Aborting to avoid shipping an incomplete analysis that looks successful.`,
        );
      }
    };

    // Track timing for ETA calculation
    const analysisStartTime = Date.now();
    let pass2StartTime = 0;  // Set after Pass 1 completes
    let totalApiCalls = 0;   // Will be set after Pass 1
    let completedApiCalls = 0;

    const sendProgress = (phase: string, progress: number, message: string) => {
      const elapsedMs = Date.now() - analysisStartTime;
      let eta: number | undefined;

      // Calculate ETA based on Pass 2 timing only (excludes slower Pass 1)
      if (completedApiCalls > 0 && totalApiCalls > 0 && pass2StartTime > 0) {
        const pass2ElapsedMs = Date.now() - pass2StartTime;
        const avgCallTimeMs = pass2ElapsedMs / completedApiCalls;
        const remainingCalls = totalApiCalls - completedApiCalls;
        eta = Math.round((remainingCalls * avgCallTimeMs) / 1000);
      }

      console.log(`[AI Analysis] ${progress}% - ${message} (ETA: ${eta !== undefined ? eta + 's' : 'calculating...'})`);

      if (onProgress) {
        onProgress({ phase, progress, message, eta, elapsedMs });
      }
    };

    // Token tracking for API calls
    const tokenStats: TokenStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      apiCalls: 0,
    };

    const trackTokens = (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => {
      console.log(`[trackTokens] Received: inputTokens=${response.inputTokens}, outputTokens=${response.outputTokens}, cost=${response.estimatedCost}`);
      if (response.inputTokens) tokenStats.inputTokens += response.inputTokens;
      if (response.outputTokens) tokenStats.outputTokens += response.outputTokens;
      tokenStats.totalTokens = tokenStats.inputTokens + tokenStats.outputTokens;
      if (response.estimatedCost) tokenStats.estimatedCost += response.estimatedCost;
      tokenStats.apiCalls++;
      console.log(`[trackTokens] Running total: apiCalls=${tokenStats.apiCalls}, totalTokens=${tokenStats.totalTokens}`);
    };

    try {
      sendProgress('analysis', 0, `Starting AI analysis with ${model}...`);

      // Write header to file
      fs.writeFileSync(
        outputFile,
        '='.repeat(80) +
          '\n' +
          'VIDEO ANALYSIS RESULTS\n' +
          '='.repeat(80) +
          '\n\n',
        'utf-8',
      );

      const aiConfig: AIProviderConfig = { provider, model };

      // Per-task model routing. Metadata tasks are narrow and cheap, so they can
      // run on a small fast model while chapter work keeps the big one. The three
      // metadata calls run consecutively at the end of the job, so routing all of
      // them to the same model costs exactly ONE model swap, not three.
      const taskModels = this.loadTaskModelOverrides();

      // Effective context window each raw-transcript task will actually use.
      //
      // chapter / flags both read raw transcript, and each may be
      // routed to a DIFFERENT model. One shared set of caps therefore has to be
      // safe for all of them, so every limit is the most CONSERVATIVE across the
      // resolved models: sizing to the main model alone would overflow a smaller
      // routed model's context and silently truncate its prompt.
      // Through Crucible a 'local' model is one in the server's catalog, served
      // at the context its manifest sizes for this host: read it once per model.
      const crucibleLocalContext = new Map<string, number>();
      // An ollama choice the serving Crucible has a model of its own for runs
      // as that model (ollama-map.ts, decided again by chat() at call time):
      // sized at that model's context. `null`: it stays on the ollama/ upstream.
      const crucibleStandIn = new Map<string, string | null>();
      const crucibleStandInLoad = new Map<string, number>();
      const ollamaTagOf = (cfg: AIProviderConfig): string | null => {
        try {
          const target = crucibleTargetOf(cfg.provider, cfg.model);
          return target.route === 'upstream' && target.upstream === 'ollama' ? target.bareModel : null;
        } catch {
          return null;
        }
      };
      // An Ollama model forwarded by Crucible: from 1.0.24 Crucible forwards
      // the window (context_tokens → num_ctx), so it is sized as the direct
      // road sizes it; an older server sends none, and Ollama runs at its 4096
      // default (CRUCIBLE_OLLAMA_CONTEXT).
      const isCrucibleOllama = (cfg: AIProviderConfig): boolean => {
        const tag = ollamaTagOf(cfg);
        return tag !== null && !crucibleStandIn.get(tag);
      };
      const crucibleOllamaSized = new Map<string, boolean>();
      {
        const sized = [aiConfig, ...(['chapter', 'flags'] as AITaskKind[]).map((t) => this.resolveTaskConfig(aiConfig, t, taskModels))];
        for (const cfg of sized) {
          const tag = ollamaTagOf(cfg);
          if (tag !== null && !crucibleStandIn.has(tag)) {
            const choice = await this.aiProviderService.crucibleOllamaStandInChoice(tag);
            crucibleStandIn.set(tag, choice?.model ?? null);
            if (choice?.loadContext !== undefined) crucibleStandInLoad.set(choice.model, choice.loadContext);
          }
          if (tag !== null && !crucibleStandIn.get(tag) && !crucibleOllamaSized.has(tag)) {
            crucibleOllamaSized.set(tag, await this.aiProviderService.crucibleOllamaTakesContext(tag));
          }
          const local = tag !== null ? crucibleStandIn.get(tag) ?? null : cfg.provider === 'local' ? cfg.model : null;
          if (local === null || crucibleLocalContext.has(local)) continue;
          // What the server states, or a failure by name: never an invented window.
          crucibleLocalContext.set(local, await this.aiProviderService.crucibleContextWindow(local, crucibleStandInLoad.get(local)));
        }
      }
      const contextFor = (cfg: AIProviderConfig): number => {
        const standIn = crucibleStandIn.get(ollamaTagOf(cfg) ?? '');
        if (standIn && crucibleLocalContext.has(standIn)) return crucibleLocalContext.get(standIn)!;
        if (isCrucibleOllama(cfg)) {
          if (crucibleOllamaSized.get(ollamaTagOf(cfg) ?? '') === true) return numCtxMaxForModel(cfg.model);
          if (!this.crucibleOllamaNoted.has(cfg.model)) {
            this.crucibleOllamaNoted.add(cfg.model);
            this.logger.warn(
              `[Model Limits] ${cfg.model} goes to Ollama through a Crucible older than 1.0.24, which can't set num_ctx: ` +
              `chunking for Ollama's default context (${CRUCIBLE_OLLAMA_CONTEXT} tokens) so no prompt is truncated`,
            );
          }
          return CRUCIBLE_OLLAMA_CONTEXT;
        }
        if (cfg.provider === 'local') {
          const window = crucibleLocalContext.get(cfg.model);
          // Every local model the tasks resolve to was sized in the loop above.
          if (window === undefined) throw new Error(`No context window was resolved for Crucible model ${cfg.model}`);
          return window;
        }
        // An ollama/ choice the server runs as its own model was answered above.
        if (cfg.provider === 'ollama') return numCtxMaxForModel(cfg.model);
        return 128000; // claude/openai have large windows
      };

      const rawTranscriptTasks: AITaskKind[] = ['chapter', 'flags'];
      const perTaskLimits = rawTranscriptTasks.map((t) => {
        const cfg = this.resolveTaskConfig(aiConfig, t, taskModels);
        const ctx = contextFor(cfg);
        return { task: t, model: cfg.model, ctx, limits: getModelLimits(ctx) };
      });

      // The CHARACTER cap is a CORRECTNESS guarantee and takes the minimum: a
      // model reading text sized for a larger model's context would silently
      // truncate its prompt, losing transcript with no error.
      const contextTokens = Math.min(...perTaskLimits.map((x) => x.ctx));
      const modelLimits: ModelLimits = {
        maxChapterChars: Math.min(...perTaskLimits.map((x) => x.limits.maxChapterChars)),
      };

      const distinct = [...new Set(perTaskLimits.map((x) => x.model))];
      if (distinct.length > 1) {
        this.logger.log(
          `[Model Limits] raw-transcript tasks span ${distinct.length} models (${perTaskLimits
            .map((x) => `${x.task}=${x.model}@${x.ctx}`)
            .join(', ')}) — using the most conservative limits`,
        );
      }
      this.logger.log(
        `[Model Limits] effective ctx=${contextTokens}: maxChapterChars=${modelLimits.maxChapterChars}`,
      );

      // =========================================================================
      // THE SCORER STAGE (snap, on Crucible's decision door)
      // =========================================================================
      // Both passes in one scorer lease, BEFORE every LLM stage. There is no
      // other engine: a stage it cannot make throws (SnapEngineError, naming
      // why) and fails the analysis; a busy or silent server parks the task; a
      // cancel propagates as a cancellation and never falls into more work.
      sendProgress('analysis', 3, 'Starting the analysis engine...');
      const snap = await this.snapAnalysis.run({
        segments,
        categories: categories || [],
        chapters: true,
        flags: true,
        signal,
        onProgress: (p) => sendProgress('analysis', 3 + Math.round(p.fraction * (ENGINE_BAND_END - 3)), p.message),
      });
      const engineWarnings: string[] = [];
      if (snap.chapterTreeError) engineWarnings.push(`Sub-chapters were skipped: ${snap.chapterTreeError}`);
      const gated = snap.labelMassGated.total;
      if (gated > 0) {
        engineWarnings.push(
          `${gated} of the analysis engine's answers were read as no evidence (the model put under 1% of its ` +
            `probability on the answer letters); they did not move any chapter or flag.`,
        );
      }
      // A refined outline: Pass 2 works on its LEAVES (they tile the video, as
      // flat chapters do); the parents are put back around them at the end.
      const snapTree = snap.chapterTree && snap.chapterTree.depth > 1 ? snap.chapterTree : null;
      const snapChapters = snapTree ? leafChapters(snapTree.flat) : snap.chapters?.chapters ?? [];
      const flagRanking = snap.flags;
      if (!flagRanking) throw new Error('the analysis engine returned no flag ranking');

      // The chapters: the scorer's outline + Viterbi path, the outline labels as titles.
      const boundaries = snapChapters.map((c) => c.startSeconds);
      sendProgress('analysis', ENGINE_BAND_END, `Found ${boundaries.length} chapter${boundaries.length === 1 ? '' : 's'}`);

      // Calculate total API calls for accurate progress reporting: one summary
      // call per chapter + one verification call per (window, category) + the
      // FOUR metadata calls (tags, description hook, description body, title).
      //
      // The narrated-actor re-ask (at most one per viewer-facing field) is NOT
      // counted here, exactly as chapter and flag PARSE retries are not: this
      // number is the expected-work estimate the ETA divides by, and retries are
      // exceptions. Their real cost is still recorded — every attempt, retry
      // included, goes through trackTokens and lands in tokenStats.apiCalls.
      // The scorer stage's decides are NOT counted: they are not generation
      // calls, and counting them would poison the ETA's average-call-time.
      let chapterCallCount = boundaries.length;
      // Flag calls: one per (window, category) pair, known once the verifier
      // stage has the ranking. Starts at ZERO — not at a one-per-chapter guess. Under capture-wide
      // ranking the real number is routinely 10x a per-chapter estimate (83 vs
      // 7 on the hour-long reference video), and a guess that wrong does not
      // degrade gracefully: it made the bar sprint to 53% after a single
      // chapter and then sit still. Unknown work claims no space until the
      // ranker reports its actual count.
      let flagCallCount = 0;
      const recomputeTotalApiCalls = () => {
        totalApiCalls = chapterCallCount + flagCallCount + 4;
      };
      recomputeTotalApiCalls();
      completedApiCalls = 0;
      // ETA averages over every counted call, so the clock starts with Pass 2.
      pass2StartTime = Date.now();

      // Progress is BANDED PER STAGE, not computed as a fraction of all calls.
      //
      // A global call-fraction requires knowing the total up front, and the flag
      // stage's total is unknowable until its ranker has run — so the bar used
      // to lurch (26% -> 53% on one chapter of seven) and then stall when the
      // real count arrived. Bands make each stage's share fixed and its motion
      // smooth: a stage that has not started occupies none of the bar, and a
      // stage that discovers more work slows down inside its own band instead
      // of stealing another stage's.
      //
      // The analysis engine (3 -> ENGINE_BAND_END) is most of a run's time: it
      // asks the model about every sentence. The chat stages after it are a few
      // calls each.
      const PASS2_BAND: [number, number] = this.verifyFlagsWithLlm ? [ENGINE_BAND_END + 1, 80] : [ENGINE_BAND_END + 1, 92];
      const FLAG_BAND: [number, number] = this.verifyFlagsWithLlm ? [80, 92] : [92, 92];
      const METADATA_BAND: [number, number] = [92, 98];
      const bandProgress = ([start, end]: [number, number], done: number, total: number) =>
        Math.round(start + (Math.min(done, total) / Math.max(1, total)) * (end - start));
      // Message-only ticks (stage announcements) report where their stage
      // currently sits rather than recomputing a global fraction.
      let lastProgress = PASS2_BAND[0];
      const calculateProgress = () => lastProgress;

      // =========================================================================
      // PASS 2: Analyze each chapter (title, summary), then extract flags (2b)
      // =========================================================================
      sendProgress('analysis', PASS2_BAND[0], `Analyzing ${boundaries.length} chapters (0/${totalApiCalls} API calls)...`);
      const { chapters, flags, warnings: flagWarnings } = await this.analyzeChaptersPass2(
        aiConfig,
        segments,
        boundaries,
        videoTitle,
        categories || [],
        modelLimits,
        recordFailure,
        customInstructions,
        trackTokens,
        (current, total) => {
          if (total !== chapterCallCount) {
            chapterCallCount = total;
            recomputeTotalApiCalls();
          }
          completedApiCalls = current;
          lastProgress = bandProgress(PASS2_BAND, current, total);
          sendProgress('analysis', lastProgress, `Analyzing chapter ${current}/${total}...`);
        },
        taskModels,
        (current, total) => {
          if (total !== flagCallCount) {
            flagCallCount = total;
            recomputeTotalApiCalls();
          }
          completedApiCalls = chapterCallCount + current;
          lastProgress = bandProgress(FLAG_BAND, current, total);
          sendProgress('analysis', lastProgress, `Verifying flag candidates ${current}/${total}...`);
        },
        // A message at the CURRENT percentage, not counted in totalApiCalls.
        (message) => {
          // Ranking runs at the START of the flag band: chapters are done, no
          // verification has happened yet, and the candidate count is about to
          // become known.
          lastProgress = FLAG_BAND[0];
          sendProgress('analysis', lastProgress, message);
        },
        signal,
        {
          chapterTitles: snapChapters.map((c) => c.title),
          flagRanking,
        },
      );
      lastProgress = METADATA_BAND[0];
      sendProgress('analysis', lastProgress, `Analyzed ${chapters.length} chapters, found ${flags.length} flags`);

      // Honest-failure gate: if NOT ONE chapter was successfully analyzed, the
      // run produced nothing real (every API call failed). Fail loudly with the
      // real reason instead of returning an empty analysis that looks successful
      // — stale/no data beats a lie. A partial run (some chapters analyzed, some
      // failed) still completes below with whatever succeeded.
      const successfulChapters = chapters.filter((ch) => !ch.failed).length;
      if (successfulChapters === 0) {
        throw new Error(
          lastFailureReason
            ? `no chapters could be analyzed — every analysis call failed. Last failure: ${lastFailureReason}`
            : 'no chapters could be analyzed — every analysis call failed.',
        );
      }

      // Write the FINDINGS to the report. The ranked paths also return rows
      // that are not findings: 'skip' (the verifier rejected that reading) and
      // 'candidate' (snap: ranked but never verified). Those stay in the
      // database, where the UI shows them only at the filter positions that ask
      // for them; the .txt report has no such filter and no verdict column, so
      // writing them would present them as confirmed flags.
      for (const flag of flags) {
        if (isReportedFinding(flag)) this.writeSectionToFile(outputFile, flag);
      }

      // =========================================================================
      // Generate metadata FROM chapters
      // =========================================================================
      // These three are independent functions of `chapters` — none reads another's
      // result — so they may run in any order. They are therefore ORDERED BY
      // MODEL, not by name: everything still on the main model runs first (it is
      // already resident from Pass 2), then each override model in turn. Each
      // model is loaded exactly once and we never swap back to one we've left.
      //
      // This matters because a swap-back is the expensive case: reloading a 27B
      // costs far more than the metadata calls it would be interleaved with, so
      // grouping is what makes routing a win instead of a wash. Ordering here
      // rather than relying on the config's task order means any taskModels
      // combination gets the minimum number of loads automatically.
      let description: string | null = null;
      let tags: Tags | null = null;
      let suggestedTitle: string | null = null;

      // TAGS RUNS FIRST, and the order in this array is load-bearing: grouping is
      // stable within a model group, and the description step CONSUMES the tags
      // result (people ground the body, topics feed the hook and the code-built
      // hashtag line). With every task on one model — the default — this array
      // order is the execution order, so tags always lands first. When tags is
      // routed to a different model, grouping may still run description first;
      // that degrades cleanly (the chapter summaries carry the same names) rather
      // than failing, which is why this is an ordering preference and not a
      // dependency the loop enforces.
      //
      // `calls` is what the ETA counter advances by: description is TWO calls
      // now (hook, then body), not one.
      const metadataSteps = (
        [
          { task: 'tags', label: 'Extracting tags', calls: 1 },
          { task: 'description', label: 'Generating description', calls: 2 },
          { task: 'title', label: 'Generating title', calls: 1 },
        ] as const
      ).map((step) => {
        const cfg = this.resolveTaskConfig(aiConfig, step.task, taskModels);
        return { ...step, cfg, key: `${cfg.provider}:${cfg.model}` };
      });

      const mainKey = `${aiConfig.provider}:${aiConfig.model}`;
      // Main model first (already loaded), then each other model in first-appearance
      // order. Stable within a group, so same-model tasks keep their relative order.
      const orderedKeys = [
        ...(metadataSteps.some((s) => s.key === mainKey) ? [mainKey] : []),
        ...metadataSteps
          .map((s) => s.key)
          .filter((k, i, arr) => k !== mainKey && arr.indexOf(k) === i),
      ];
      if (orderedKeys.length > 1) {
        this.logger.log(
          `[TaskModels] Metadata runs grouped by model, one load each: ${orderedKeys.join(' -> ')}`,
        );
      }

      let metadataStepsDone = 0;
      for (const key of orderedKeys) {
        for (const step of metadataSteps.filter((s) => s.key === key)) {
          // Each metadata step is 1-2 more generation calls. A cancelled run
          // stops here rather than spending them.
          ensureNotCancelled(signal, `metadata step '${step.task}'`);

          completedApiCalls += step.calls;
          lastProgress = bandProgress(METADATA_BAND, metadataStepsDone++, metadataSteps.length);
          sendProgress('analysis', lastProgress, `${step.label}...`);
          switch (step.task) {
            case 'description':
              description = await this.generateDescriptionFromChapters(
                step.cfg, chapters, videoTitle, tags, recordFailure, trackTokens, signal,
              );
              break;
            case 'tags':
              tags = await this.generateTagsFromChapters(
                step.cfg, chapters, recordFailure, trackTokens, signal,
              );
              break;
            case 'title':
              suggestedTitle = await this.generateTitleFromChapters(
                step.cfg, chapters, videoTitle, recordFailure, trackTokens, signal,
              );
              break;
          }
        }
      }

      // Prepend summary to file (only when a real description was produced;
      // a failed description is null and must not become a placeholder).
      if (description) {
        this.prependSummaryToFile(outputFile, description);
      }

      // Log token usage summary
      console.log('');
      console.log('='.repeat(60));
      console.log('AI ANALYSIS TOKEN USAGE SUMMARY (Two-Pass)');
      console.log('='.repeat(60));
      console.log(`Provider: ${provider}`);
      console.log(`Model: ${model}`);
      console.log(`API Calls: ${tokenStats.apiCalls}`);
      console.log(`Input Tokens: ${tokenStats.inputTokens.toLocaleString()}`);
      console.log(`Output Tokens: ${tokenStats.outputTokens.toLocaleString()}`);
      console.log(`Total Tokens: ${tokenStats.totalTokens.toLocaleString()}`);
      console.log('='.repeat(60));
      console.log('');

      this.logger.log('AI ANALYSIS TOKEN SUMMARY: ' +
        `apiCalls=${tokenStats.apiCalls}, ` +
        `inputTokens=${tokenStats.inputTokens}, ` +
        `outputTokens=${tokenStats.outputTokens}, ` +
        `totalTokens=${tokenStats.totalTokens}`
      );

      sendProgress('analysis', 100, 'Analysis complete!');

      // Debug: Log what we're returning
      console.log(`[analyzeTranscript] RETURNING: sections=${flags.length}, chapters=${chapters.length}, tags=${JSON.stringify(tags)}`);
      if (chapters.length > 0) {
        console.log(`[analyzeTranscript] Chapters being returned: ${JSON.stringify(chapters)}`);
      }

      return {
        sections_count: flags.length,
        sections: flags,           // Category flags from chapter analysis
        // Chapter list with titles/summaries; a refined outline adds its parents.
        chapters: snapTree ? nestAnalysisChapters(chapters, snapTree.flat) : chapters,
        tags,
        description,
        suggested_title: suggestedTitle || undefined,
        tokenStats: tokenStats.apiCalls > 0 ? tokenStats : undefined,
        warnings:
          engineWarnings.length + (flagWarnings?.length ?? 0) > 0
            ? [...engineWarnings, ...(flagWarnings ?? [])]
            : undefined,
      };
    } catch (error) {
      // A cancellation is NOT a failure. It must not be wrapped as one (the
      // wrapper would hide the type from every caller), must not be logged at
      // ERROR level, and must reach media-operations as a cancellation so that
      // nothing is persisted for the job.
      // Crucible said "not now": the task parks, as it is (never wrapped).
      if (isParked(error)) {
        this.logger.log(`AI analysis parked${jobId ? ` for job ${jobId}` : ''}: ${(error as Error).message}`);
        throw error;
      }
      if (isCancellation(error)) {
        this.logger.log(
          `AI analysis cancelled${jobId ? ` for job ${jobId}` : ''} after ${tokenStats.apiCalls} API call(s) ` +
          `— no further calls will be issued and no results will be saved`,
        );
        throw error;
      }
      const message = `AI analysis failed: ${(error as Error).message}`;
      this.logger.error(message);
      throw new Error(message);
    } finally {
      // Deregister LAST, and identity-checked, so a cancel that arrives while
      // this run is unwinding still finds it (and a replacement run registered
      // under the same id is never deleted out from under itself).
      if (this.activeRuns.get(runKey) === run) {
        this.activeRuns.delete(runKey);
      }
    }
  }

  // =============================================================================
  // TWO-PASS CHAPTER ANALYSIS METHODS
  // =============================================================================

  /**
   * Analyze a single chapter with retry logic
   */
  private async analyzeChapterWithRetry(
    config: AIProviderConfig,
    chapterText: string,
    videoTitle: string,
    chapterNumber: number,
    previousChapterSummary: string,
    customInstructions: string | undefined,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    signal?: AbortSignal,
  ): Promise<ChapterAnalysisResult> {
    const maxRetries = JSON_PARSE_RETRIES;
    // Capture the underlying error so the final throw carries the real reason
    // (e.g. a Claude 400) rather than an opaque "failed after N attempts".
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // A RETRY is another full call. Cancelling has to stop retries too, not
      // just the first attempt.
      ensureNotCancelled(signal, `chapter ${chapterNumber} attempt ${attempt + 1}`);

      try {
        const prompt = buildChapterAnalysisPrompt(
          videoTitle,
          chapterText,
          chapterNumber,
          previousChapterSummary,
          customInstructions,
        );

        const response = await this.aiProviderService.generateText(prompt, config, 'chapter', { signal });
        onTokens?.(response);

        if (!response || !response.text) {
          this.logger.warn(`[Pass 2] No response for chapter ${chapterNumber} (attempt ${attempt + 1})`);
          if (attempt < maxRetries) {
            await this.delay(1000 * (attempt + 1)); // Exponential backoff
            continue;
          }
          break;
        }

        // Returns null on parse/validation failure (no fabricated "Unknown").
        const result = this.parseChapterAnalysisResponse(response.text);
        if (result) {
          return result;
        }

        if (attempt < maxRetries) {
          this.logger.warn(`[Pass 2] Chapter ${chapterNumber} unparseable, retrying (attempt ${attempt + 1})`);
          await this.delay(1000 * (attempt + 1));
          continue;
        }
      } catch (error) {
        // Never retry a cancellation, and never let it become a chapter failure.
        if (stopsTheRun(error)) throw error;
        lastError = (error as Error).message;
        this.logger.warn(`[Pass 2] Error analyzing chapter ${chapterNumber} (attempt ${attempt + 1}): ${lastError}`);
        if (attempt < maxRetries) {
          await this.delay(1000 * (attempt + 1));
          continue;
        }
      }
    }

    // All retries exhausted — fail loudly. The caller records this as an explicit
    // failure and marks the chapter failed; it is NEVER written to the DB as a
    // fabricated "Chapter N (analysis failed)" success row.
    throw new Error(
      `Chapter ${chapterNumber} analysis failed after ${maxRetries + 1} attempts` +
      (lastError ? `: ${lastError}` : ''),
    );
  }

  /**
   * Simple delay helper for retry backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // PASS 2b (DEFAULT): ranked-then-verified flag extraction
  // ===========================================================================

  /**
   * Read one verdict out of a verification response.
   *
   * The schema-constrained decode makes the JSON reliable, but this stays
   * tolerant on purpose: cloud upstreams get the same prompt with NO schema (see
   * crucible/llm/target.ts), so their answer is whatever prose the model chose
   * to wrap the verdict in.
   *
   * Returns null when the text carries no verdict at all; the caller treats that
   * as 'skip' plus a warning, never as a flag. An unreadable answer must not be
   * able to accuse anybody.
   */
  private parseVerificationVerdict(text: string): 'flag' | 'skip' | null {
    if (!text) return null;
    const json = /"verdict"\s*:\s*"(flag|skip)"/i.exec(text);
    if (json) return json[1].toLowerCase() as 'flag' | 'skip';

    const lower = text.trim().toLowerCase();
    const hasFlag = lower.includes('flag');
    const hasSkip = lower.includes('skip');
    if (hasFlag && !hasSkip) return 'flag';
    if (hasSkip && !hasFlag) return 'skip';
    return null;
  }

  /**
   * Turn a window's ACCEPTED categories into ONE stored section.
   *
   * WHY ONE, when a window can have several verified categories. The operator's
   * complaint about the previous shape was over-splitting: four back-to-back
   * single-sentence flags for one moment. Emitting one section per verified
   * category on the same passage is the same complaint in a different costume —
   * three markers stacked on the same 20 seconds of timeline. So the section
   * carries the STRONGEST verified category, and the others are named in the
   * description after the quote as `[also: hate, extremism]`. Nothing is lost:
   * `description` is the field both section lists and the timeline tooltip
   * render, so the extra categories are on screen wherever the flag is.
   *
   * THIS MERGE IS WHY REJECTED CATEGORIES GET THEIR OWN ROWS INSTEAD (see
   * buildSkipSections). A 'skip' is a statement about ONE claim against ONE
   * passage — "the speaker is reporting this, not asserting it" — and merging
   * several of them into one row would produce a ghost marker that means nothing
   * in particular. Accepted verdicts merge because they describe the same
   * moment; rejected verdicts do not, because each one names a different
   * rejected reading of it.
   *
   * The SPAN is measured, never a fixed window: it runs from the first to the
   * last sentence that fired a VERIFIED category, and the quote is that span
   * read verbatim. Sentences that fired only a category the verifier rejected do
   * not stretch the span, and the surrounding context the model was shown is not
   * part of it — a viewer clicking the flag lands on the words that earned it.
   *
   * `nli_score` on the row is the PRIMARY category's ranker score, i.e. the
   * strongest evidence in the window, because that is the number the STRICT and
   * MODERATE filter positions are asking about: "how strong is the best reason
   * this passage is on my timeline".
   */
  private buildWindowSections(
    verified: Array<{ window: FlagWindow; categories: WindowCategory[] }>,
    sentences: RankedSentence[],
    ranker: 'nli' | 'snap-v1',
    /** 'candidate' for over-budget snap windows the verifier never saw (same shape, never a finding). */
    verdict: 'flag' | 'candidate' = 'flag',
  ): AnalyzedSection[] {
    const sections: AnalyzedSection[] = [];

    for (const { categories } of verified) {
      if (categories.length === 0) continue;
      // Strongest first: `categories` arrives ordered by the ranker's per-
      // category best score, and the primary is simply the survivor at the top.
      const ranked = [...categories].sort((a, b) => b.score - a.score);
      const primary = ranked[0];
      const also = ranked.slice(1).map((c) => c.category);

      const fired = ranked.flatMap((c) => c.sentenceIndices);
      const from = Math.min(...fired);
      const to = Math.max(...fired);
      const text = sentences.slice(from, to + 1).map((sentence) => sentence.text).join(' ');

      sections.push({
        category: primary.category,
        // The verifier answers with a verdict and nothing else, so there is no
        // generated explanation to show — and inventing one would be a
        // fabrication. The flagged passage IS the finding.
        description: `"${text}"${also.length > 0 ? ` [also: ${also.join(', ')}]` : ''}`,
        start_time: this.formatDisplayTime(sentences[from].start),
        end_time: this.formatDisplayTime(sentences[to].end),
        quotes: [{ timestamp: this.formatDisplayTime(sentences[from].start), text }],
        verdict,
        nli_score: primary.score,
        ranker,
      });
    }

    return sections;
  }

  /**
   * Turn REJECTED (window, category) verdicts into stored sections — one row
   * each, marked 'skip'.
   *
   * THIS IS THE HALF OF THE PIPELINE THAT USED TO BE THROWN AWAY. Under the
   * operator's 2026-08-25 ruling the run captures at its widest and the dial
   * becomes a display filter, and a filter can only filter what was kept. The
   * LOOSE position shows these rows ghosted, labelled with the verifier's reason
   * for rejecting them, so "what did the machine decide not to show me" is a
   * question the UI can actually answer instead of a black box.
   *
   * ONE ROW PER (WINDOW, CATEGORY), unlike the accepted side — see
   * buildWindowSections for why. The span is the sentences that fired THIS
   * category, not the whole window, so a ghost marker sits on the words that
   * scored rather than on the paragraph they were read in.
   *
   * A window can produce both: a passage that flags on `hate` and skips on
   * `conspiracy` stores one flag row and one skip row over overlapping time.
   * That is the honest record, and the filter is what separates them.
   *
   * DEGRADED CALLS ARE NOT WRITTEN HERE. A call that timed out, hit the token
   * ceiling, or came back without a readable verdict is counted and logged, and
   * the pipeline treats it as "not flagged" exactly as before — but it is NOT a
   * rejection, and storing it as one would put words in the verifier's mouth and
   * caption them "the verifier rejected this". Those candidates are simply
   * absent from the record, and the run's log says how many.
   */
  private buildSkipSections(
    rejected: Array<{ window: FlagWindow; category: WindowCategory }>,
    sentences: RankedSentence[],
    ranker: 'nli' | 'snap-v1',
  ): AnalyzedSection[] {
    const sections: AnalyzedSection[] = [];

    for (const { window, category } of rejected) {
      const fired =
        category.sentenceIndices.length > 0
          ? category.sentenceIndices
          : [window.firedFrom, window.firedTo];
      const from = Math.min(...fired);
      const to = Math.max(...fired);
      const text = sentences.slice(from, to + 1).map((sentence) => sentence.text).join(' ');

      sections.push({
        category: category.category,
        // Same shape as a flag row's description — the quote is the content. The
        // "verifier rejected this" caption is NOT baked in here: it is a
        // rendering decision the UI makes from `verdict`, so it can be worded,
        // restyled and localized without rewriting stored data.
        description: `"${text}"`,
        start_time: this.formatDisplayTime(sentences[from].start),
        end_time: this.formatDisplayTime(sentences[to].end),
        quotes: [{ timestamp: this.formatDisplayTime(sentences[from].start), text }],
        verdict: 'skip',
        nli_score: category.score,
        ranker,
      });
    }

    return sections;
  }

  /**
   * The stable identity of ONE verification question, for the verdict cache.
   *
   * EVERYTHING THE ANSWER DEPENDS ON IS IN THE HASH and nothing else is:
   *
   *   passage     the exact text the model reads, newline-joined as sent;
   *   category    the label the claim is being tested under;
   *   proposition the stance hypothesis the claim is stated as;
   *   model       "provider:model" — a different grader is a different answer;
   *   prompt      FLAG_VERIFICATION_PROMPT_VERSION, the template's identity.
   *
   * Timestamps, video id, window indices and sensitivity are deliberately OUT.
   * They do not change the answer, and including any of them would invalidate
   * the cache on exactly the re-runs it exists to make cheap — a re-transcribe
   * that shifts every timestamp by 40ms, a widened capture that renumbers every
   * window, a second video quoting the same passage.
   *
   * The parts are joined with a delimiter that cannot occur in any of them, so
   * two different questions cannot collide by concatenation.
   */
  private verificationQuestionHash(
    passage: string[],
    categoryName: string,
    proposition: string,
    verifierModel: string,
  ): string {
    return crypto
      .createHash('sha256')
      .update(
        [
          FLAG_VERIFICATION_PROMPT_VERSION,
          verifierModel,
          categoryName,
          proposition,
          passage.join('\n'),
          // U+0000 cannot appear in a prompt, a model name or a transcript,
          // so no two different questions can collide by concatenation.
        ].join('\u0000'),
      )
      .digest('hex');
  }

  /**
   * The flag verifier stage: ask one question per (window, category) of the
   * snap ranking, and STORE EVERY ANSWER.
   *
   * THE RULING BEHIND IT (operator, 2026-08-25):
   *
   *   "really, we should find all the loose flags and organize them, and the
   *    knob can be a filter afterward that filters out loosely paired ones,
   *    moderate, or strictly paired ones... all the work will be done anyway,
   *    and itll be a UI component that filters out loose pairings rather than
   *    defining what the actual run does before it runs."
   *
   * So this stage takes NO sensitivity. It asks the calibrated question (see
   * FLAG_VERIFICATION_PROMPT_VERSION) and returns BOTH the accepted and the
   * rejected verdicts as sections carrying `verdict` and the ranker's score.
   * Which of them a user sees is decided afterwards, client-side, instantly,
   * and reversibly.
   *
   * VERIFICATION ORDER IS DESCENDING WINDOW SCORE, and that is a durability
   * property, not a cosmetic one: a run killed halfway has already answered and
   * cached its most trustworthy questions, so the resume is cheap AND the
   * findings that survive an interruption are the ones most worth having.
   *
   * A per-call problem does not throw: a verification the model answered
   * unreadably, or past its token limit, is that (window, category) left
   * unflagged with a warning, NOT a recordFailure (one bad answer must not push
   * a run toward TOO_MANY_FAILURES across hundreds of tiny calls). A TOTAL
   * failure is recorded once, for the stage. A cancel, and Crucible parking
   * the run, are never absorbed here (stopsTheRun): they stop the whole run.
   */
  private async runRankedFlagStage(
    flagConfig: AIProviderConfig,
    segments: Segment[],
    recordFailure: (what: string) => void,
    onTokens: ((response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void) | undefined,
    onFlagProgress: ((current: number, total: number) => void) | undefined,
    onFlagStatus: ((message: string) => void) | undefined,
    signal: AbortSignal | undefined,
    /**
     * The snap engine's ranking, made by the scorer before any LLM stage ran:
     * its windows (strength-first), over-budget windows become unverified
     * 'candidate' rows unless every question is already cached, and accepted
     * sub-passages of one long span are stored as one section.
     */
    snapRanking: SnapFlagRankResult,
  ): Promise<AnalyzedSection[]> {
    const sentences = assembleSentences(segments);
    if (sentences.length === 0) {
      this.logger.warn('[Pass 2b] No sentences could be assembled from the transcript');
      return [];
    }

    const ranker = 'snap-v1' as const;
    const verifierModel = `${flagConfig.provider}:${flagConfig.model}`;
    const passageOf = (window: FlagWindow) =>
      sentences.slice(window.contextFrom, window.contextTo + 1).map((s) => s.text);

    if (!this.verifyFlagsWithLlm) {
      // Decide only: every window the map produced is a flag, as ranked. A long
      // span split into <= 40 s sub-passages is stored as one section again.
      const all: FlagWindow[] = [...snapRanking.windows, ...snapRanking.overflow];
      const verified = mergeSpanSubPassages(all, new Map(all.map((w) => [w, w.categories])));
      const sections = this.buildWindowSections(verified, sentences, ranker).sort(
        (a, b) => this.parseDisplayTime(a.start_time) - this.parseDisplayTime(b.start_time),
      );
      this.logger.log(
        `[Pass 2b] Decide only (no LLM check): ${sentences.length} sentences (${snapRanking.stats.units} units, ` +
        `${snapRanking.stats.groupQuestions} group questions) -> ${snapRanking.stats.spans} spans -> ` +
        `${sections.length} flag sections`,
      );
      return sections;
    }

    let windows: FlagWindow[] = snapRanking.windows;
    // Over-budget snap windows that stay unverified ('candidate' rows).
    let candidateWindows: FlagWindow[] = [];
    {
      if (snapRanking.overflow.length > 0) {
        // Cache hits do not count against the verify budget (plan §5.5): an
        // over-budget window whose every question is already answered costs
        // nothing, so it is verified (from the cache) rather than stored blind.
        // Promoted windows are weaker than every in-budget one, so appending
        // them keeps the descending verification order.
        const cacheOpen = this.databaseService?.isInitialized?.() === true;
        const { promoted, candidates } = promoteCachedOverflow(snapRanking.overflow, (window, category) =>
          cacheOpen &&
          this.databaseService!.getFlagVerdict(
            this.verificationQuestionHash(passageOf(window), category.category, category.proposition, verifierModel),
          ) !== null,
        );
        windows = [...windows, ...promoted];
        candidateWindows = candidates;
        this.logger.log(
          `[Pass 2b] Snap verify budget ${snapRanking.stats.verifyBudget}: ${snapRanking.windows.length} windows in ` +
          `budget, ${promoted.length} over-budget window(s) fully cached (verified free), ${candidates.length} ` +
          `stored as unverified candidates`,
        );
      }
    }
    onFlagStatus?.(`Verifying ${windows.length} flag candidate passage${windows.length === 1 ? '' : 's'}...`);
    ensureNotCancelled(signal, 'flag verification');

    // One call per (window, category) — a passage where three categories fired
    // costs three questions, not one per (sentence, category) pair.
    //
    // `windows` arrives from the snap ranker sorted by DESCENDING strength
    // and each window's categories are ordered strongest-first, so walking them
    // in nested order produces exactly the descending-score verification order
    // this stage promises. The order is ASSERTED in the loop below rather than
    // re-sorted here, so a change to rankWindows' ordering surfaces as a loud
    // warning instead of being silently papered over.
    const jobs: Array<{
      window: FlagWindow;
      category: WindowCategory;
      passage: string[];
      prompt: string;
    }> = [];
    for (const window of windows) {
      const passage = passageOf(window);
      for (const category of window.categories) {
        jobs.push({
          window,
          category,
          passage,
          prompt: buildFlagVerificationPrompt(passage, category.category, category.proposition),
        });
      }
    }

    this.logger.log(
      `[Pass 2b] Snap-ranked ${sentences.length} sentences (${snapRanking.stats.units} units, ` +
      `${snapRanking.stats.spans} spans) -> ` +
      `${windows.length} windows / ${jobs.length} verification calls on ${verifierModel}. ` +
      `Sensitivity is NOT a run input on this path: every candidate is verified and every verdict ` +
      `is stored, and the dial filters that stored record at display time.`,
    );

    // Descending-order assertion. Cheap, and it is the only thing standing
    // between "an interrupted run keeps its best findings" and a silent
    // regression in a sort comparator two files away.
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].score - windows[i - 1].score > 1e-9) {
        this.logger.warn(
          `[Pass 2b] Verification order is NOT descending by window score at index ${i} ` +
          `(${windows[i - 1].score.toFixed(4)} then ${windows[i].score.toFixed(4)}) — an interrupted ` +
          `run will not have finished its most trustworthy findings first.`,
        );
        break;
      }
    }

    // The call count is only known NOW, so this is where the run's API-call
    // estimate gets corrected — the same mid-run recompute the chapter loop does
    // after long chapters are split.
    onFlagProgress?.(0, jobs.length);
    const candidateSections = this.buildWindowSections(
      candidateWindows.map((window) => ({ window, categories: window.categories })),
      sentences,
      ranker,
      'candidate',
    );
    if (jobs.length === 0) return candidateSections;

    // ONE num_ctx for every verification call in the stage, sized from the
    // largest prompt. Ollama fully reloads the model on ANY num_ctx change, and
    // these prompts differ only by the length of their passage — per-call sizing
    // would buy reloads and nothing else.
    const numCtx = estimateNumCtx(
      jobs.reduce((max, job) => Math.max(max, job.prompt.length), 0),
      flagConfig.model,
      VERIFY_OUTPUT_BUDGET_TOKENS,
    );

    const overrides = {
      numCtx,
      temperature: 0,
      signal,
      // The schema crosses for a Crucible catalog model and ollama/; a cloud
      // upstream gets none (target.ts) and answers the same prompt in prose,
      // parsed by parseVerificationVerdict.
      format: FLAG_VERIFICATION_SCHEMA,
    };

    // Verified categories per window, keyed by the window object itself: jobs
    // are walked in noisy-OR order, so a window's categories can be answered
    // consecutively but a window is only finished when all of them are.
    const verifiedByWindow = new Map<FlagWindow, WindowCategory[]>();
    const rejected: Array<{ window: FlagWindow; category: WindowCategory }> = [];
    let flaggedCalls = 0;
    let skipped = 0;
    let degraded = 0;
    let cacheHits = 0;
    const cachePresent = this.databaseService?.isInitialized?.() === true;
    const startedAt = Date.now();

    if (!cachePresent) {
      this.logger.log(
        '[Pass 2b] Verdict cache unavailable (no open library database) — every question goes to the model.',
      );
    }

    for (let i = 0; i < jobs.length; i++) {
      // THE big win. This loop is the longest stage in the pipeline (dozens to
      // hundreds of verification calls on an hour-long video), so aborting the
      // open call without this check would simply start the next one.
      ensureNotCancelled(signal, `flag verification ${i + 1}/${jobs.length}`);

      const { window, category, passage, prompt } = jobs[i];
      const where = `${this.formatDisplayTime(sentences[window.firedFrom].start)} (${category.category})`;
      const questionHash = this.verificationQuestionHash(
        passage,
        category.category,
        category.proposition,
        verifierModel,
      );

      // ---- cache lookup ----------------------------------------------------
      // A hit skips the model entirely. It is logged at log level, individually
      // and distinctly, because "did the cache actually work" is a question that
      // gets asked of a run's log, and a silent optimization is an unverifiable
      // one.
      const cached = cachePresent ? this.databaseService!.getFlagVerdict(questionHash) : null;
      if (cached) {
        cacheHits++;
        this.databaseService!.recordFlagVerdictHit(questionHash);
        this.logger.log(
          `[Pass 2b] CACHE HIT ${where} -> ${cached.verdict} (first asked ${cached.created_at}, ` +
          `hit ${cached.hit_count + 1}x, q ${questionHash.slice(0, 12)}) — no model call`,
        );
        if (cached.verdict === 'flag') {
          flaggedCalls++;
          const list = verifiedByWindow.get(window);
          if (list) list.push(category);
          else verifiedByWindow.set(window, [category]);
        } else {
          skipped++;
          rejected.push({ window, category });
        }
        onFlagProgress?.(i + 1, jobs.length);
        continue;
      }

      try {
        const response = await this.aiProviderService.generateText(prompt, flagConfig, 'flags', overrides);
        onTokens?.(response);

        if (response.doneReason === 'length') {
          degraded++;
          this.logger.warn(
            `[Pass 2b] Verification hit the token ceiling at ${where} — not flagged, and NOT recorded ` +
            `as a rejection`,
          );
        } else {
          const verdict = this.parseVerificationVerdict(response.text);
          if (verdict === null) {
            degraded++;
            this.logger.warn(
              `[Pass 2b] No verdict in the verification answer at ${where} — not flagged, and NOT ` +
              `recorded as a rejection`,
            );
          } else {
            // Only real verdicts are cached. A degraded call has no answer to
            // remember, and caching "no answer" would make a transient Ollama
            // hiccup permanent for that question.
            if (cachePresent) {
              this.databaseService!.putFlagVerdict({
                questionHash,
                category: category.category,
                verifierModel,
                promptVersion: FLAG_VERIFICATION_PROMPT_VERSION,
                verdict,
              });
            }
            if (verdict === 'flag') {
              flaggedCalls++;
              const list = verifiedByWindow.get(window);
              if (list) list.push(category);
              else verifiedByWindow.set(window, [category]);
            } else {
              skipped++;
              rejected.push({ window, category });
            }
          }
        }
      } catch (error) {
        // A cancelled call is not a degraded verdict. Counting it as one would
        // also let the loop continue to the next candidate.
        if (stopsTheRun(error)) throw error;
        degraded++;
        this.logger.warn(
          `[Pass 2b] Verification call failed at ${where}: ${(error as Error).message} — not flagged, ` +
          `and NOT recorded as a rejection`,
        );
      }
      onFlagProgress?.(i + 1, jobs.length);
    }

    const wallSeconds = (Date.now() - startedAt) / 1000;
    const modelCalls = jobs.length - cacheHits;
    this.logger.log(
      `[Pass 2b] Verified ${jobs.length} (window, category) pairs across ${windows.length} windows in ` +
      `${wallSeconds.toFixed(1)}s (${(wallSeconds / jobs.length).toFixed(2)}s/pair): ` +
      `${flaggedCalls} flag, ${skipped} skip, ${degraded} unusable. ` +
      `Cache: ${cacheHits}/${jobs.length} hits (${((cacheHits / jobs.length) * 100).toFixed(1)}%), ` +
      `${modelCalls} model call(s)` +
      (cachePresent ? `, ${this.databaseService!.countFlagVerdicts()} question(s) now cached` : ''),
    );

    // Every single call failing is a broken stage, not a quiet result. Report it
    // ONCE — the same shape as a chapter's total failure — so the job's failure
    // accounting sees it without being flooded by hundreds of per-call entries.
    if (degraded === jobs.length) {
      recordFailure(
        `Pass 2b flag verification produced no usable verdicts across all ${jobs.length} calls`,
      );
    }

    // Windows in transcript order, so the sections are built in the order the
    // video plays rather than in noisy-OR order. On the snap path, accepted
    // sub-passages of ONE long span (split only so the verifier reads <= 40 s)
    // are stored as one section covering both: no picket fence.
    const verified = mergeSpanSubPassages(windows, verifiedByWindow);

    const flagSections = this.buildWindowSections(verified, sentences, ranker);
    const skipSections = this.buildSkipSections(rejected, sentences, ranker);
    // Flags before ghosts at the same timestamp, so a list rendered in stored
    // order puts the finding above the rejected (then unverified) readings of it.
    const verdictRank = (v: AnalyzedSection['verdict']) => (v === 'skip' ? 1 : v === 'candidate' ? 2 : 0);
    const sections = [...flagSections, ...skipSections, ...candidateSections].sort(
      (a, b) =>
        this.parseDisplayTime(a.start_time) - this.parseDisplayTime(b.start_time) ||
        verdictRank(a.verdict) - verdictRank(b.verdict),
    );

    this.logger.log(
      `[Pass 2b] ${flaggedCalls} accepted (window, category) verdicts across ${verified.length} windows ` +
      `-> ${flagSections.length} flag sections; ${skipSections.length} rejected verdicts stored as ` +
      `ghost sections (visible only at the LOOSE filter position)` +
      (candidateSections.length ? `; ${candidateSections.length} unverified candidates stored` : ''),
    );
    return sections;
  }

  /**
   * PASS 2: Analyze each chapter with full context
   * Generates title and summary per chapter, then runs the dedicated flag pass
   */
  private async analyzeChaptersPass2(
    config: AIProviderConfig,
    segments: Segment[],
    boundaries: number[],
    videoTitle: string,
    categories: AnalysisCategory[],
    limits: ModelLimits,
    recordFailure: (what: string) => void,
    customInstructions: string | undefined,
    onTokens: ((response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void) | undefined,
    onChapterProgress: ((current: number, total: number) => void) | undefined,
    taskModels: Partial<Record<AITaskKind, string>>,
    onFlagProgress: ((current: number, total: number) => void) | undefined,
    onFlagStatus: ((message: string) => void) | undefined,
    signal: AbortSignal | undefined,
    /**
     * The snap engine's output:
     *   chapterTitles  one per boundary, the scorer's outline labels. The LLM
     *                  chapter call supplies only the summary (its title is
     *                  discarded), and long chapters are NOT split: Viterbi's
     *                  switch cost owns granularity, and a forced split would
     *                  manufacture chapters at arbitrary times (plan §4.5).
     *   flagRanking    the snap ranker's windows for the verifier stage.
     */
    snap: { chapterTitles: string[]; flagRanking: SnapFlagRankResult },
  ): Promise<{ chapters: Chapter[]; flags: AnalyzedSection[]; warnings?: string[] }> {
    const chapters: Chapter[] = [];
    const warnings: string[] = [];
    const allFlags: AnalyzedSection[] = [];

    if (!segments || segments.length === 0) {
      this.logger.warn('[Pass 2] No segments available for chapter analysis');
      return { chapters, flags: allFlags, warnings };
    }

    const videoDuration = segments[segments.length - 1].end;

    // Snap chapters: boundaries and titles come as a set, one title each.
    if (snap.chapterTitles.length !== boundaries.length) {
      throw new Error(`the analysis engine gave ${snap.chapterTitles.length} chapter titles for ${boundaries.length} chapters`);
    }
    const presetTitles = snap.chapterTitles;
    const adjustedBoundaries = boundaries;

    let previousChapterSummary = '';

    this.logger.log(`[Pass 2] Analyzing ${adjustedBoundaries.length} chapters (max ${limits.maxChapterChars} chars each)`);

    // Chapter analysis may be routed to its own (typically smaller) model. All
    // chapter calls run consecutively, so this model loads once.
    const chapterConfig = this.resolveTaskConfig(config, 'chapter', taskModels);
    if (chapterConfig.model !== config.model) {
      this.logger.log(`[Pass 2] Analyzing chapters on ${chapterConfig.provider}:${chapterConfig.model}`);
    }

    // Chapters that succeeded: flags are verified only when at least one did
    // (a run with none fails below, with the real reason).
    let succeededChapters = 0;

    for (let i = 0; i < adjustedBoundaries.length; i++) {
      // Do not start chapter i+1 on a cancelled run.
      ensureNotCancelled(signal, `chapter ${i + 1}/${adjustedBoundaries.length} analysis`);

      const startTime = adjustedBoundaries[i];
      const endTime = i < adjustedBoundaries.length - 1 ? adjustedBoundaries[i + 1] : videoDuration;

      // Extract chapter transcript
      const chapterSegments = segments.filter(
        (s) => s.start >= startTime && s.start < endTime,
      );

      if (chapterSegments.length === 0) {
        this.logger.debug(`[Pass 2] No segments for chapter ${i + 1}, skipping`);
        continue;
      }

      const chapterText = chapterSegments.map((s) => s.text).join(' ');
      const chapterDuration = endTime - startTime;

      // Log if we're still truncating (shouldn't happen often after splitting)
      if (chapterText.length > limits.maxChapterChars) {
        this.logger.warn(
          `[Pass 2] Chapter ${i + 1} (${Math.round(chapterDuration)}s) still exceeds limit: ` +
          `${chapterText.length} chars -> truncating to ${limits.maxChapterChars}`,
        );
      }

      // Truncate if needed
      const truncatedText = chapterText.substring(0, limits.maxChapterChars);

      // Use retry-enabled analysis. On exhaustion it THROWS — we record the
      // failure and push a chapter explicitly marked failed (no title/summary,
      // no fabricated content). Finalize excludes failed chapters from the DB.
      let result: ChapterAnalysisResult;
      try {
        result = await this.analyzeChapterWithRetry(
          chapterConfig,
          truncatedText,
          videoTitle,
          i + 1,
          previousChapterSummary,
          customInstructions,
          onTokens,
          signal,
        );
      } catch (error) {
        // A cancelled chapter is not a FAILED chapter: recording it would
        // inflate the job's failure count (and could trip TOO_MANY_FAILURES,
        // turning a user cancel into a reported analysis failure).
        if (stopsTheRun(error)) throw error;
        recordFailure(`Pass 2 chapter ${i + 1}/${adjustedBoundaries.length} analysis failed: ${(error as Error).message}`);
        chapters.push({
          sequence: i + 1,
          start_time: this.formatDisplayTime(startTime),
          end_time: this.formatDisplayTime(endTime),
          title: '',
          summary: '',
          failed: true,
        });
        if (onChapterProgress) {
          onChapterProgress(i + 1, adjustedBoundaries.length);
        }
        // Do not carry a failed chapter's (empty) summary into the next chapter.
        continue;
      }

      // Flag verification deliberately does NOT happen here — see Pass 2b
      // below. Running it inline would alternate chapter/flags per iteration,
      // which reloads a model between every call the moment the two tasks are
      // routed to different models.
      succeededChapters++;

      // The title is the outline label the boundary came from; the LLM call
      // supplied the summary only.
      chapters.push({
        sequence: i + 1,
        start_time: this.formatDisplayTime(startTime),
        end_time: this.formatDisplayTime(endTime),
        title: presetTitles[i],
        summary: result.summary,
      });

      // Report progress after each chapter
      if (onChapterProgress) {
        onChapterProgress(i + 1, adjustedBoundaries.length);
      }

      // Save summary for next chapter's context
      previousChapterSummary = result.summary;

      this.logger.debug(`[Pass 2] Chapter ${i + 1}: "${result.title.substring(0, 50)}..."`);
    }


    // =========================================================================
    // PASS 2b: flag verification, as its own phase, after every chapter, so
    // each model loads once even when 'flags' is routed to a different model
    // than 'chapter'.
    // =========================================================================
    const flagConfig = this.resolveTaskConfig(config, 'flags', taskModels);

    // The snap ranker already ranked the candidates (before any LLM stage ran);
    // each window is verified here. The flag stage is the expensive one: never
    // entered on a cancelled run.
    if (succeededChapters > 0) {
      ensureNotCancelled(signal, 'the flag stage');
      const ranked = await this.runRankedFlagStage(
        flagConfig,
        segments,
        recordFailure,
        onTokens,
        onFlagProgress,
        onFlagStatus,
        signal,
        snap.flagRanking,
      );
      this.logger.log(
        `[Pass 2b] ranked + verified (snap scorer ranking, verify budget ${snap.flagRanking.stats.verifyBudget}) — ` +
          `${ranked.length} sections (${ranked.filter((r) => r.verdict === 'flag').length} flag, ` +
          `${ranked.filter((r) => r.verdict === 'skip').length} ghosted rejections, ` +
          `${ranked.filter((r) => r.verdict === 'candidate').length} unverified candidates)`,
      );
      allFlags.push(...ranked);
    }

    this.logger.log(`[Pass 2] Analyzed ${chapters.length} chapters, found ${allFlags.length} flag sections`);
    return { chapters, flags: allFlags, warnings };
  }

  /**
   * Parse chapter analysis response with robust JSON handling
   */
  private parseChapterAnalysisResponse(response: string): ChapterAnalysisResult | null {
    // Use safe JSON parsing with multiple strategies. Returns null on failure —
    // the caller retries, then records an explicit failure. No fabricated
    // "Unknown"/salvage object that would masquerade as a real chapter.
    const parsed = safeJsonParse<Record<string, unknown>>(response, this.logger);

    if (!parsed) {
      this.logger.warn('[Pass 2] Failed to parse chapter analysis response - all strategies failed');
      this.logger.debug(`[Pass 2] Raw response was: ${response.substring(0, 500)}...`);
      return null;
    }

    // Validate the parsed result
    const validated = validateChapterAnalysisResult(parsed);

    if (!validated) {
      this.logger.warn('[Pass 2] Chapter analysis response failed validation');
      this.logger.debug(`[Pass 2] Parsed data was: ${JSON.stringify(parsed).substring(0, 500)}`);
      return null;
    }

    // Debug: Log what the AI returned for flags
    if (validated.flags && validated.flags.length > 0) {
      this.logger.debug(`[Pass 2] Raw flags from AI: ${JSON.stringify(validated.flags, null, 2)}`);
    }

    return validated;
  }

  /**
   * Reject an AI refusal masquerading as content. A refusal is a real failure,
   * never a description.
   */
  private isRefusal(text: string): boolean {
    return [/^i apologize/i, /^i'm sorry/i, /^i cannot/i, /^unfortunately/i, /^as an ai/i]
      .some((p) => p.test(text.trim()));
  }

  /**
   * One schema-constrained call for a VIEWER-FACING prose field (hook or body),
   * with the register check and its single re-ask.
   *
   * The re-ask exists because register and specificity fail independently: a
   * perfectly specific, entity-rich line can still be written in narration
   * register, and that is a real SEO/readability loss but not a broken result.
   * So detection is a DECLARED WARNING worth one more attempt — never a blocking
   * check, and never a silent code rewrite of the model's prose.
   *
   * The re-ask prompt is the original prompt plus a restatement of the POSITIVE
   * instruction. Per the spec's prompt-hygiene ruling it does not quote, echo or
   * describe the rejected text: a model shown the bad form sometimes reproduces
   * it, which is exactly the failure we are trying to clear.
   */
  private async generateViewerFacingField(
    field: 'hook' | 'body',
    basePrompt: string,
    schema: Record<string, unknown>,
    config: AIProviderConfig,
    temperature: number | undefined,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // target.ts decides what crosses: a Crucible catalog model and ollama/ take
    // the schema and the temperature; a cloud upstream gets neither and follows
    // the same prompt's "output JSON only" instruction.
    const overrides = {
      ...(DESCRIPTION_UNCONSTRAINED ? {} : { format: schema }),
      ...(temperature !== undefined ? { temperature } : {}),
      signal,
    };

    const runOnce = async (prompt: string): Promise<string | null> => {
      const response = await this.aiProviderService.generateText(prompt, config, 'description', overrides);
      onTokens?.(response);
      const raw = (response?.text || '').trim();
      if (!raw) return null;

      // Structured mode makes the parse a formality; the raw-text fallback is
      // for a cloud model that answered in prose despite being asked for JSON.
      const parsed = safeJsonParse<Record<string, unknown>>(raw, this.logger);
      const value = parsed && typeof parsed[field] === 'string' ? (parsed[field] as string) : null;
      if (value && value.trim()) return value.trim();
      if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
      return null;
    };

    let text = await runOnce(basePrompt);
    if (!text) return null;

    const finding = detectNarratedActor(text);
    if (finding.flagged) {
      // Declared warning: the offending fragment is logged for the operator and
      // goes nowhere near the model.
      this.logger.warn(
        `[Description] ${field}: narrated-actor register detected (${finding.rule}: "${finding.match}") — re-asking once`,
      );
      // The re-ask is another full generation call — skip it on a cancelled run.
      ensureNotCancelled(signal, `the ${field} re-ask`);
      const retry = await runOnce(`${basePrompt}\n${REGISTER_RESTATEMENT}`);
      // The second result is ACCEPTED regardless. One re-ask, then we ship what
      // the model wrote; nothing here blocks or rewrites.
      if (retry) {
        const secondFinding = detectNarratedActor(retry);
        if (secondFinding.flagged) {
          this.logger.warn(
            `[Description] ${field}: still narrated after one re-ask (${secondFinding.rule}) — accepting as written`,
          );
        }
        text = retry;
      }
    }

    if (this.isRefusal(text)) return null;
    return text;
  }

  /**
   * Build the YouTube description: two model calls (hook, body) and a
   * code-composed template. Implements docs/youtube-metadata-spec.md §2-§3.
   *
   * The model writes prose and nothing else. The chapters block, the hashtag
   * line, the ordering and the character caps are all code, because they are the
   * parts with exact right answers — and because per §3 exactly one component
   * may own each element, so the model is never allowed to emit a hashtag line
   * that would then have to be reconciled with the one code builds.
   *
   * `tags` comes from the tags step, which runs first: its `people` list grounds
   * the body and its `topics` feed the hook and the hashtags. A null `tags`
   * (tags failed, or ran after this on a different routed model) degrades
   * cleanly — the chapter summaries already carry the names.
   */
  private async generateDescriptionFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    videoTitle: string,
    tags: Tags | null,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // Only describe chapters that actually succeeded.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      recordFailure('Description generation: no successfully-analyzed chapters to summarize');
      return null;
    }

    {
      this.logger.debug(
        `[Description] hook + body calls: ${
          DESCRIPTION_UNCONSTRAINED
            ? 'free-running (BRIEFCASE_DESCRIPTION_UNCONSTRAINED=1)'
            : 'schema-constrained (default)'
        }`,
      );
    }

    try {
      const people = tags?.people?.length ? tags.people.join(', ') : 'none identified';
      const topics = tags?.topics?.length ? tags.topics.join(', ') : 'none identified';

      // ---- Call 1: the hook. Chapter TITLES only — the hook is one sentence and
      // the summaries would bury the searchable phrase in detail.
      const hookPrompt = interpolatePrompt(HOOK_FROM_CHAPTERS_PROMPT, {
        videoTitle: videoTitle || 'Untitled',
        chapterTitles: validChapters.map((ch) => `- ${ch.title}`).join('\n').substring(0, 2000),
        topics,
      });
      // Hook keeps the 'description' task temperature (0.4) — it needs a little
      // life, which is exactly what that default was chosen for.
      let hook = await this.generateViewerFacingField('hook', hookPrompt, HOOK_SCHEMA, config, undefined, onTokens, signal);

      if (hook && hook.length > HOOK_MAX_CHARS) {
        // The ONLY length enforcement — the schema deliberately has no maxLength
        // (see HOOK_SCHEMA: Ollama enforces it by truncating mid-word). A hard
        // display limit is never left to a model or a serializer: the snippet is
        // truncated by YouTube either way, so we choose the cut point.
        this.logger.warn(
          `[Description] hook came back at ${hook.length} chars (cap ${HOOK_MAX_CHARS}) — trimming at a word boundary`,
        );
        hook = truncateAtWordBoundary(hook, HOOK_MAX_CHARS);
      }

      // ---- Call 2: the body. ALL chapter summaries. They narrate internally and
      // that is correct for internal data; the prompt's register instruction is
      // what keeps that register out of the published paragraph.
      const bodyPrompt = interpolatePrompt(BODY_FROM_CHAPTERS_PROMPT, {
        videoTitle: videoTitle || 'Untitled',
        people,
        chapterSummaries: validChapters
          .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
          .join('\n')
          .substring(0, 6000),
      });
      // The body is a SECOND call. Do not spend it on a cancelled run.
      ensureNotCancelled(signal, 'the description body call');
      const body = await this.generateViewerFacingField('body', bodyPrompt, BODY_SCHEMA, config, 0.2, onTokens, signal);

      if (!hook && !body) {
        recordFailure('Description generation: neither the hook nor the body call produced text');
        return null;
      }
      if (!hook) recordFailure('Description generation: hook call produced no usable text');
      if (!body) recordFailure('Description generation: body call produced no usable text');

      // ---- Composition: pure code from here down.
      const description = composeDescription({
        hook: hook || '',
        chapterLines: buildChapterLines(validChapters),
        body: body || '',
        hashtags: buildHashtags(tags?.topics || [], tags?.people || [], videoTitle || ''),
      });

      if (!description.trim()) {
        recordFailure('Description generation produced an empty composition');
        return null;
      }
      return description;
    } catch (error) {
      // A cancellation is not a description failure — it must not be recorded
      // against the job's failure budget.
      if (stopsTheRun(error)) throw error;
      recordFailure(`Description generation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Extract tags from chapter content
   */
  private async generateTagsFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    signal?: AbortSignal,
  ): Promise<Tags | null> {
    // Only tag chapters that actually succeeded.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      recordFailure('Tags extraction: no successfully-analyzed chapters to tag');
      return null;
    }

    try {
      const chaptersList = validChapters
        .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(TAGS_FROM_CHAPTERS_PROMPT, {
        chaptersList: chaptersList.substring(0, 4000),
      });

      // Schema-constrained by DEFAULT (target.ts sends it to every non-cloud
      // model). This is mechanical
      // extraction from summaries — the judgment already happened upstream in
      // chapter summarization — which is precisely the class where structured
      // output is pure win: it pins the exact `{people, topics}` shape the parser
      // below expects AND collapses a thinking model's output from thousands of
      // reasoning tokens to the answer itself. The prompt, its intent and the
      // output shape are UNCHANGED; only the decoding grammar is.
      // BRIEFCASE_TAGS_UNCONSTRAINED=1 restores free-running decoding.
      const overrides = TAGS_UNCONSTRAINED ? { signal } : { format: TAGS_EXTRACTION_SCHEMA, signal };

      const response = await this.aiProviderService.generateText(prompt, config, 'tags', overrides);
      onTokens?.(response);

      if (response && response.text) {
        // Use the shared parser (markdown-strip + brace-balance + repair, plus
        // think-tag stripping). A successful parse with no tags is a valid empty
        // result; only a genuine PARSE failure is recorded as a failure.
        const tagsData = safeJsonParse<{ people?: unknown; topics?: unknown }>(response.text, this.logger);
        if (tagsData) {
          return {
            people: Array.isArray(tagsData.people) ? (tagsData.people as string[]).slice(0, 20) : [],
            topics: Array.isArray(tagsData.topics) ? (tagsData.topics as string[]).slice(0, 15) : [],
          };
        }
        recordFailure('Tags extraction: response could not be parsed as JSON');
        return null;
      }

      recordFailure('Tags extraction returned empty text');
      return null;
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      recordFailure(`Tags extraction failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Generate suggested title from chapter content
   */
  private async generateTitleFromChapters(
    config: AIProviderConfig,
    chapters: Chapter[],
    currentTitle: string,
    recordFailure: (what: string) => void,
    onTokens?: (response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    // Only title from chapters that actually succeeded. A null title is a
    // legitimate "keep the original filename" outcome, so an empty/rejected
    // title is not counted as a failure; only a hard error is.
    const validChapters = (chapters || []).filter((ch) => !ch.failed);
    if (validChapters.length === 0) {
      return null;
    }

    try {
      const chaptersList = validChapters
        .map((ch) => `${ch.title}${ch.summary ? `: ${ch.summary}` : ''}`)
        .join('\n');

      const prompt = interpolatePrompt(TITLE_FROM_CHAPTERS_PROMPT, {
        currentTitle: currentTitle || 'untitled',
        chaptersList: chaptersList.substring(0, 4000),
      });

      const response = await this.aiProviderService.generateText(prompt, config, 'title', { signal });
      onTokens?.(response);

      if (response && response.text) {
        let suggestedTitle = response.text.trim();

        // Remove quotes
        if (suggestedTitle.startsWith('"') && suggestedTitle.endsWith('"')) {
          suggestedTitle = suggestedTitle.slice(1, -1);
        }

        // Strip only a trailing file extension (e.g. ".mp4"), not mid-title dots
        // like "$3.5 million".
        suggestedTitle = suggestedTitle.replace(/\.[A-Za-z0-9]{1,5}$/, '');

        // Remove date prefix
        suggestedTitle = suggestedTitle.replace(/^\d{4}-\d{2}-\d{2}[-\s]*/, '');

        // Lowercase and clean
        suggestedTitle = suggestedTitle.toLowerCase().trim();

        // Remove invalid filesystem characters
        suggestedTitle = suggestedTitle.replace(/[/\\:*?"<>|]/g, '');

        // Remove parentheses and their contents at the end (e.g., "(source name)")
        suggestedTitle = suggestedTitle.replace(/\s*\([^)]*\)\s*$/, '');

        // Remove periods
        suggestedTitle = suggestedTitle.replace(/\.(?!\s|$)/g, '');
        suggestedTitle = suggestedTitle.replace(/\.$/, '');

        // Clean up multiple spaces
        suggestedTitle = suggestedTitle.replace(/\s+/g, ' ').trim();

        // Reject AI meta-commentary
        const invalidPatterns = [
          /^based on/i,
          /^the transcript/i,
          /^this video/i,
          /^i would/i,
          /^i suggest/i,
          /^here is/i,
          /^the suggested/i,
        ];

        for (const pattern of invalidPatterns) {
          if (pattern.test(suggestedTitle)) {
            this.logger.warn(`Rejected invalid AI title: "${suggestedTitle}"`);
            return null;
          }
        }

        // Length limit
        if (suggestedTitle.length > 200) {
          suggestedTitle = suggestedTitle.substring(0, 200).split(',').slice(0, -1).join(',');
        }

        // Reject if too short
        if (suggestedTitle.length < 10) {
          this.logger.warn(`Rejected too-short AI title: "${suggestedTitle}"`);
          return null;
        }

        return suggestedTitle || null;
      }

      return null;
    } catch (error) {
      if (stopsTheRun(error)) throw error;
      // A hard error (not just a rejected title) is a real failure.
      recordFailure(`Title generation failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Generate a suggested filename for a webpage from its extracted text.
   * Public entry point used by webpage analysis (no chapters/transcript needed).
   */
  async generateTitleFromWebpageText(
    config: AIProviderConfig,
    pageText: string,
    currentTitle: string,
    jobId?: string,
  ): Promise<string | null> {
    // 'analyze-webpage' runs in the same single-slot AI pool as a full
    // analysis, so it registers the same way — one call, but a cancel must
    // still abort it and release whatever model it loaded.
    const controller = new AbortController();
    const run = { controller };
    const runKey = jobId ?? `standalone-webpage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeRuns.set(runKey, run);

    try {
      if (!pageText || pageText.trim().length === 0) {
        return null;
      }

      // Truncate to stay within reasonable context; ~8000 chars ≈ 2k tokens
      const truncated = pageText.substring(0, 8000);

      const prompt = interpolatePrompt(TITLE_FROM_WEBPAGE_PROMPT, {
        currentTitle: currentTitle || 'untitled',
        pageText: truncated,
      });

      const response = await this.aiProviderService.generateText(prompt, config, 'title', {
        signal: controller.signal,
      });

      if (!response || !response.text) {
        return null;
      }

      let suggestedTitle = response.text.trim();

      // Remove quotes
      if (suggestedTitle.startsWith('"') && suggestedTitle.endsWith('"')) {
        suggestedTitle = suggestedTitle.slice(1, -1);
      }

      // Strip only a trailing file extension (e.g. ".mp4"), not mid-title dots
      // like "$3.5 million".
      suggestedTitle = suggestedTitle.replace(/\.[A-Za-z0-9]{1,5}$/, '');

      // Remove leading date prefix
      suggestedTitle = suggestedTitle.replace(/^\d{4}-\d{2}-\d{2}[-\s]*/, '');

      suggestedTitle = suggestedTitle.toLowerCase().trim();
      suggestedTitle = suggestedTitle.replace(/[/\\:*?"<>|]/g, '');
      suggestedTitle = suggestedTitle.replace(/\s*\([^)]*\)\s*$/, '');
      suggestedTitle = suggestedTitle.replace(/\.(?!\s|$)/g, '');
      suggestedTitle = suggestedTitle.replace(/\.$/, '');
      suggestedTitle = suggestedTitle.replace(/\s+/g, ' ').trim();

      const invalidPatterns = [
        /^based on/i,
        /^the page/i,
        /^this page/i,
        /^this article/i,
        /^i would/i,
        /^i suggest/i,
        /^here is/i,
        /^the suggested/i,
      ];
      for (const pattern of invalidPatterns) {
        if (pattern.test(suggestedTitle)) {
          this.logger.warn(`Rejected invalid webpage AI title: "${suggestedTitle}"`);
          return null;
        }
      }

      if (suggestedTitle.length > 200) {
        suggestedTitle = suggestedTitle.substring(0, 200).split(',').slice(0, -1).join(',');
      }

      if (suggestedTitle.length < 10) {
        this.logger.warn(`Rejected too-short webpage AI title: "${suggestedTitle}"`);
        return null;
      }

      return suggestedTitle || null;
    } catch (error) {
      // A cancellation must NOT become "no title" — that would let the caller
      // treat the job as a completed analysis that simply found nothing.
      if (stopsTheRun(error)) throw error;
      this.logger.warn(`Webpage title generation failed: ${(error as Error).message}`);
      return null;
    } finally {
      if (this.activeRuns.get(runKey) === run) {
        this.activeRuns.delete(runKey);
      }
    }
  }

  /**
   * Write a section to the output file
   */
  private writeSectionToFile(
    outputFile: string,
    section: AnalyzedSection,
  ): void {
    try {
      let content = '';

      const endTime = section.end_time ? section.end_time : '';
      if (endTime) {
        content = `**${section.start_time} - ${endTime} - ${section.description} [${section.category}]**\n\n`;
      } else {
        content = `**${section.start_time} - ${section.description} [${section.category}]**\n\n`;
      }

      for (const quote of section.quotes || []) {
        content += `${quote.timestamp} - "${quote.text}"\n`;
        if (quote.significance) {
          content += `   → ${quote.significance}\n`;
        }
        content += '\n';
      }

      content += '-'.repeat(80) + '\n\n';
      fs.appendFileSync(outputFile, content, 'utf-8');
    } catch (error) {
      this.logger.error(
        `Error writing to file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Prepend the video overview section to the analysis file
   */
  private prependSummaryToFile(outputFile: string, summary: string): void {
    try {
      const existingContent = fs.readFileSync(outputFile, 'utf-8');

      const headerEnd = existingContent.indexOf('\n\n');
      if (headerEnd !== -1) {
        const header = existingContent.substring(0, headerEnd + 2);
        const rest = existingContent.substring(headerEnd + 2);

        const newContent =
          header +
          '**VIDEO OVERVIEW**\n\n' +
          summary +
          '\n\n' +
          '-'.repeat(80) +
          '\n\n' +
          rest;

        fs.writeFileSync(outputFile, newContent, 'utf-8');
      } else {
        const newContent =
          '**VIDEO OVERVIEW**\n\n' +
          summary +
          '\n\n' +
          '-'.repeat(80) +
          '\n\n' +
          existingContent;

        fs.writeFileSync(outputFile, newContent, 'utf-8');
      }
    } catch (error) {
      this.logger.warn(
        `Could not prepend summary to file: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Format time for display (HH:MM:SS)
   */
  private formatDisplayTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Parse display time (HH:MM:SS) back to seconds
   */
  private parseDisplayTime(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }
}
