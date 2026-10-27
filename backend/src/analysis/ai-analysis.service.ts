/**
 * AI Analysis Service — the snap engine's chapters, then the LLM stages, all on
 * Crucible (or the local Claude Code CLI, when the user picked it).
 *
 *   Scorer stage (SnapAnalysisService, Crucible's decision door): the whole
 *           video's chapters (outline + assignment + Viterbi + ad check).
 *   Pass 2: each chapter's summary from the LLM (the outline gave its title).
 *   Stories: the outline's top level (stories.ts): one call on the `chapter`
 *           model groups the chapters, with their summaries, into stories.
 *           Under 10 minutes, or when it is one story, the outline stays flat.
 *   Flags:  the clip-worthy moments, marked by the flags model with add_marker
 *           one stretch of about 15 minutes per question (flag-highlights.ts).
 *
 * Metadata (description, tags, title) is generated from chapter summaries.
 *
 * A run makes the PARTS it is asked for (analysis-parts.ts: metadata, chapters,
 * flags; all three when unsaid) and only the stages they need: chapters alone
 * is the scorer's chapter pass + Pass 2; flags alone is the flag stage, over
 * the whole video or one chapter's range; metadata alone is written from the
 * video's stored chapters (made first when it has none).
 *
 * A video with no speech (speech-presence.ts) makes no model calls: each part
 * it makes stores the no-speech placeholder (noSpeechResult).
 *
 * Snap is the only engine (P7 removed the classic embedding/lexical chaptering,
 * the NLI ranker and LLM chapter discovery): a stage that cannot be made fails
 * the analysis by name, and a busy or silent Crucible parks the task.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AIProviderService, AIProviderConfig, AIGenerateOverrides } from './ai-provider.service';
import { ensureNotCancelled, isCancellation, stopsTheRun } from './cancellation';
import { isParked } from '../crucible/llm/errors';
import { estimateNumCtx, numCtxMaxForModel, parseProviderModel, AITaskKind } from './model-utils';
import { crucibleTargetOf, storedChoice } from '../crucible/llm/target';
import { CRUCIBLE_OLLAMA_CONTEXT } from '../crucible/llm/ollama-map';
import { assembleSentences } from './flag-windows';
import {
  enabledCategories,
  findHighlights,
  HIGHLIGHT_MAX_OUTPUT_TOKENS,
  HIGHLIGHT_REPLY_RESERVE_TOKENS,
  highlightReason,
  highlightsSystemPrompt,
  highlightToolDefinition,
  HIGHLIGHTS_RANKER,
  planTranscript,
  wholeTranscriptTokens,
} from './flag-highlights';
import { claudeCodec, tagCodec, ToolLoopAborted } from '../tool-harness';
import { codecFor } from '../video-chat/tool-format';
import { isToolsRefusal } from '../crucible/llm/crucible-chat.service';
import { AnalysisCancelledError } from './cancellation';
import { safeJsonParse } from './json-utils';
import { DatabaseService } from '../database/database.service';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../bridges/runtime-paths';
import {
  buildChapterAnalysisPrompt,
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
import { DEFAULT_TIME_WINDOWS, windowsOf, type TimeWindows } from '../scorer/windows';
import {
  AnalysisPart,
  AnalysisRange,
  analysisProgressBands,
  describeParts,
  formatHms,
  partsToMake,
  resolveAnalysisParts,
  resolveAnalysisRange,
  segmentsInRange,
} from './analysis-parts';
import { speechPresence, SpeechPresence } from './speech-presence';
import { ChapterTreeResult, nestAnalysisChapters } from '../scorer/chapters/chapter-tree';
import { storyTreeFromGroups } from '../scorer/chapters/story-chapters';
import type { SnapChapter } from '../scorer/chapters/segmenter';
import { groupStories, runtimePhrase, STORIES_MIN_VIDEO_SECONDS, STORY_GROUP_MAX_OUTPUT_TOKENS, Story } from './stories';
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
  /** The flag's own name ("Calls Democrats demonic"), stored as the row's title. Absent: the category is the title (rows from before the highlights finder). */
  title?: string;
  description: string;
  start_time: string;
  end_time: string | null;
  quotes: Quote[];
  /** 'flag' on every flag the flags model marked (the UI's Confirmed). Absent on chapter sections. */
  verdict?: 'flag';
  /** Which finder made the flag: 'highlights-v1' (flag-highlights.ts). There is no score. */
  ranker?: typeof HIGHLIGHTS_RANKER;
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
  provider: 'local' | 'ollama' | 'openai' | 'claude' | 'claude-cli';
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
  /**
   * The parts to make (analysis-parts.ts). Absent: all three, as every run
   * made before parts existed. The result's `parts` says what was made.
   */
  parts?: AnalysisPart[];
  /**
   * Flags only: the stretch of the video to find flags in (one chapter). Only
   * the transcript inside it is read; timestamps stay on the real timeline.
   */
  range?: AnalysisRange;
  /**
   * The video's stored chapters (leaves, with their summaries), which metadata
   * is written from when this run does not make chapters. None: the run makes
   * chapters first (see analyzeTranscriptRun).
   */
  existingChapters?: Chapter[];
  /**
   * The video's duration in seconds, when known: what tells a few stray words
   * from a short clip that is all speech (speech-presence.ts).
   */
  durationSeconds?: number | null;
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
  /**
   * The parts this run made, which are the parts whose stored output it
   * replaces. Can hold 'chapters' when only metadata was asked for: the video
   * had none, and metadata is written from them.
   */
  parts: AnalysisPart[];
  /** The range a flags-only run was restricted to. */
  range?: AnalysisRange;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_RETRIES = 3;

/** What a video with no speech stores (see noSpeechResult). */
const NO_SPEECH_TITLE = 'No speech';
const NO_SPEECH_SUMMARY = 'No speech in this video (music, ambient sound or silence).';
const NO_SPEECH_DESCRIPTION = 'No speech in this video.';

/** The stored chapters metadata can be written from: real ones, with a title. */
function usableStoredChapters(chapters: Chapter[] | undefined): Chapter[] {
  return (chapters ?? []).filter((ch) => !ch.failed && ch.title.trim() !== '');
}
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
 * Tasks are executed grouped by model (chaptering, then the flags, then metadata
 * ordered main-model-first), so each routed model loads once rather than being
 * swapped in and out per call.
 */
const ROUTABLE_TASKS = ['chapter', 'flags', 'description', 'tags', 'title'] as const;

/**
 * A suggested title is one line of plain text, so a local model writes it
 * without thinking first. With thinking on (Qwen3.8 27B's default), it spent
 * Crucible's default 512 tokens reasoning and stopped before writing a word,
 * so every title failed (seen 2026-10-11). Thinking off, it answers
 * in ~30 tokens; 256 leaves room for a long filename. Both are sent to local
 * models only (crucible/llm/target.ts).
 */
const TITLE_OVERRIDES = { thinking: false, maxTokens: 256 } as const;

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
 * `{"title": string, "summary": string}` — Pass 2's answer for one chapter.
 *
 * Pass 2 is mechanical (a title and 2-3 sentences), so it runs with thinking
 * off, this schema and a small ceiling. Left to its manifest default, a
 * thinking model (qwen3.8-27b on the Mac, 2026-10-08) reasoned until its
 * context ran out on most chapters of a 96-minute debate: no answer, or a cut
 * one, and the job hit TOO_MANY_FAILURES.
 */
const CHAPTER_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { title: { type: 'string' }, summary: { type: 'string' } },
  required: ['title', 'summary'],
};

/** Output ceiling of one Pass 2 call: the JSON is well under 300 tokens. */
const CHAPTER_SUMMARY_MAX_OUTPUT_TOKENS = 1024;

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

@Injectable()
export class AIAnalysisService {
  private readonly logger = new Logger(AIAnalysisService.name);
  /** `ollama/` models already told they are chunked for Ollama's default context (said once per process). */
  private readonly crucibleOllamaNoted = new Set<string>();

  constructor(
    private readonly aiProviderService: AIProviderService,
    /** The snap engine's scorer stage (chapters on Crucible's decision door). */
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

  /**
   * How the analysis engine asks about the transcript (app-config.json
   * `analysisWindows`, Settings › AI Analysis): time windows, 90 s every 60 s
   * unless set otherwise, or null for one question per sentence. An unreadable
   * config is the default, said once in the log.
   */
  private loadAnalysisWindows(): TimeWindows | null {
    try {
      const configPath = this.appConfigPath();
      const stored = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8'))?.analysisWindows : undefined;
      return windowsOf(stored);
    } catch (error) {
      this.logger.warn(`[Engine] Using the default analysis windows; the config could not be read: ${(error as Error).message}`);
      return DEFAULT_TIME_WINDOWS;
    }
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
    return storedChoice({ ...base, provider, model });
  }

  /**
   * Main entry point: analyse a transcript. The snap scorer stage (chapters),
   * then Pass 2 (chapter summaries), the flag stage and the metadata (see the
   * file header).
   */
  async analyzeTranscript(options: AnalysisOptions): Promise<AnalysisResult> {
    // A video with no speech has nothing for a model to read: what it is sent
    // comes back as junk (speech-presence.ts). Decided before a Crucible run is
    // even opened, so such a video makes no model calls at all.
    const presence = speechPresence(options.segments ?? [], options.durationSeconds);
    if (!presence.speech) return this.noSpeechResult(options, presence);

    // ONE Crucible run per analysis: one queue session per server it uses,
    // each local model loaded once in it, closed when the analysis settles
    // (done, failed or cancelled).
    return this.aiProviderService.withRun(() => this.analyzeTranscriptRun(options));
  }

  /**
   * The analysis of a video with no speech: what each part it makes would
   * store, said plainly instead of asked of a model. The chapters are one
   * "No speech" chapter over the whole video, the flags are none, and the
   * metadata is a placeholder description with no tags and no suggested title
   * (the filename stays). A recognized outcome, not an empty run: the
   * every-chapter-failed rule in the pipeline is for runs whose calls failed.
   */
  private noSpeechResult(options: AnalysisOptions, presence: SpeechPresence): AnalysisResult {
    const asked = resolveAnalysisParts(options.parts);
    const range = resolveAnalysisRange(options.range, asked);
    const { made } = partsToMake(asked, usableStoredChapters(options.existingChapters).length > 0);
    const segments = options.segments ?? [];
    const lastCueEnd = segments.length ? segments[segments.length - 1].end : 0;
    const videoSeconds = options.durationSeconds && options.durationSeconds > 0 ? options.durationSeconds : lastCueEnd;

    this.logger.log(
      `[AI Analysis] No speech in ${options.videoTitle || 'this video'} ` +
        `(${presence.words} word${presence.words === 1 ? '' : 's'} over ${presence.spokenSeconds.toFixed(1)}s` +
        `${options.durationSeconds ? ` of ${options.durationSeconds.toFixed(1)}s` : ''}): ` +
        `storing the no-speech placeholder for ${describeParts(made)}, no model calls`,
    );

    // The report the analysis row keeps, as a run that made these parts writes it.
    fs.writeFileSync(options.outputFile, `${'='.repeat(80)}\nVIDEO ANALYSIS RESULTS\n${'='.repeat(80)}\n\n`, 'utf-8');
    if (made.includes('metadata')) this.prependSummaryToFile(options.outputFile, NO_SPEECH_DESCRIPTION);
    options.onProgress?.({ phase: 'analysis', progress: 100, message: 'No speech in this video: nothing to analyze' });

    return {
      sections_count: 0,
      sections: [],
      chapters: made.includes('chapters')
        ? [{ sequence: 1, start_time: formatHms(0), end_time: formatHms(videoSeconds), title: NO_SPEECH_TITLE, summary: NO_SPEECH_SUMMARY }]
        : [],
      ...(made.includes('metadata') ? { tags: { people: [], topics: [] }, description: NO_SPEECH_DESCRIPTION } : {}),
      parts: made,
      ...(range ? { range } : {}),
    };
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

      // ---- the parts this run makes (analysis-parts.ts) ----------------------
      const asked = resolveAnalysisParts(options.parts);
      const range = resolveAnalysisRange(options.range, asked);
      if (range) {
        // One chapter's flags: only its transcript is read, at its real times.
        segments = segmentsInRange(segments ?? [], range);
        if (segments.length === 0) {
          throw new Error(`no transcript falls inside ${formatHms(range.start)}-${formatHms(range.end)}`);
        }
      }
      // Metadata is written FROM chapter summaries. Asked for without chapters,
      // it is written from the video's stored chapters; a video that has none
      // gets its chapters made first (and they are stored: real chapters, and
      // there were none to replace). The job says so. Writing metadata from the
      // raw transcript instead would be a second, unmeasured prompt family, and
      // a 4-hour transcript does not fit in one call anyway.
      const storedChapters = usableStoredChapters(options.existingChapters);
      const { made, chaptersFirst } = partsToMake(asked, storedChapters.length > 0);
      const makeChapters = made.includes('chapters');
      const makeFlags = made.includes('flags');
      const makeMetadata = made.includes('metadata');
      // The outline's top level: a video of 10 minutes or more has its
      // chapters grouped into stories after Pass 2 (stories.ts); a shorter one
      // is one story, and its outline stays flat.
      const videoSeconds = segments && segments.length ? segments[segments.length - 1].end : 0;
      const groupStoriesStage = makeChapters && !range && videoSeconds >= STORIES_MIN_VIDEO_SECONDS;
      // A stage this run does not make takes no share of the progress bar.
      const bands = analysisProgressBands(
        {
          stories: groupStoriesStage,
          engine: makeChapters,
          summaries: makeChapters,
          flags: makeFlags,
          metadata: makeMetadata,
        },
      );
      const runNotes: string[] = [];
      if (chaptersFirst) {
        runNotes.push('Chapters were made first: metadata is written from chapter summaries, and this video had none.');
      }
      this.logger.log(
        `[Analysis] Making ${describeParts(made)}` +
          (range ? ` inside ${formatHms(range.start)}-${formatHms(range.end)} (${segments.length} segments)` : '') +
          (makeFlags ? ' (flags: the clip-worthy moments, marked by the flags model)' : '') +
          (makeMetadata && !makeChapters ? ` from the ${storedChapters.length} stored chapters` : '') +
          (chaptersFirst ? ' (chapters first: the video has none to write metadata from)' : ''),
      );

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

      // A stored 27B quantisation runs as the 27B ceiling (target.ts storedChoice), read once here.
      const aiConfig: AIProviderConfig = storedChoice({ provider, model });

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
      // A size ceiling whose pick the run's session loaded is sized at the
      // context that session reports (crucibleContextWindow).
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
      // The flag stage sizes itself (fitToolContext: the whole transcript when
      // it fits, else one stretch per question), so only chapters are sized here.
      const rawTranscriptTasks: AITaskKind[] = [
        ...(makeChapters ? (['chapter'] as const) : []),
      ];
      {
        // Only the stages this run makes are sized: a metadata-only run reads no raw transcript.
        const sized = rawTranscriptTasks.length
          ? [aiConfig, ...rawTranscriptTasks.map((t) => this.resolveTaskConfig(aiConfig, t, taskModels))]
          : [];
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

      const perTaskLimits = rawTranscriptTasks.map((t) => {
        const cfg = this.resolveTaskConfig(aiConfig, t, taskModels);
        const ctx = contextFor(cfg);
        return { task: t, model: cfg.model, ctx, limits: getModelLimits(ctx) };
      });

      // The CHARACTER cap is a CORRECTNESS guarantee and takes the minimum: a
      // model reading text sized for a larger model's context would silently
      // truncate its prompt, losing transcript with no error.
      const contextTokens = perTaskLimits.length ? Math.min(...perTaskLimits.map((x) => x.ctx)) : 0;
      const modelLimits: ModelLimits = {
        maxChapterChars: perTaskLimits.length ? Math.min(...perTaskLimits.map((x) => x.limits.maxChapterChars)) : 0,
      };

      const distinct = [...new Set(perTaskLimits.map((x) => x.model))];
      if (distinct.length > 1) {
        this.logger.log(
          `[Model Limits] raw-transcript tasks span ${distinct.length} models (${perTaskLimits
            .map((x) => `${x.task}=${x.model}@${x.ctx}`)
            .join(', ')}) — using the most conservative limits`,
        );
      }
      if (perTaskLimits.length) {
        this.logger.log(
          `[Model Limits] effective ctx=${contextTokens}: maxChapterChars=${modelLimits.maxChapterChars}`,
        );
      }

      // =========================================================================
      // THE SCORER STAGE (snap, on Crucible's decision door)
      // =========================================================================
      // The chapters, in one scorer lease, BEFORE every LLM stage; a run that
      // makes no chapters (flags or metadata on stored chapters) never takes
      // the scorer. There is no other engine: a stage it cannot
      // make throws (SnapEngineError, naming why) and fails the analysis; a
      // busy or silent server parks the task; a cancel propagates as a
      // cancellation and never falls into more work.
      const engineWarnings: string[] = [];
      let snapTree: ChapterTreeResult | null = null;
      let snapChapters: SnapChapter[] = [];
      if (bands.engine) {
        const [engineStart, engineEnd] = bands.engine;
        sendProgress('analysis', engineStart, 'Starting the analysis engine...');
        const windows = this.loadAnalysisWindows();
        this.logger.log(
          `[Engine] asking ${windows ? `per ${windows.windowSeconds}s window every ${windows.stepSeconds}s` : 'per sentence'}`,
        );
        const snap = await this.snapAnalysis.run({
          segments,
          windows,
          // No sub-chapters inside long chapters: the outline's second level is
          // the stories, made from these chapters after Pass 2.
          refineOptions: false,
          signal,
          onProgress: (p) => sendProgress('analysis', engineStart + Math.round(p.fraction * (engineEnd - engineStart)), p.message),
        });
        if (snap.chapterTreeError) engineWarnings.push(`Sub-chapters were skipped: ${snap.chapterTreeError}`);
        const gated = snap.labelMassGated.total;
        if (gated > 0) {
          engineWarnings.push(
            `${gated} of the analysis engine's answers were read as no evidence (the model put under 1% of its ` +
              `probability on the answer letters); they did not move any chapter.`,
          );
        }
        snapChapters = snap.chapters?.chapters ?? [];
        sendProgress('analysis', engineEnd, `Found ${snapChapters.length} chapter${snapChapters.length === 1 ? '' : 's'}`);
      }

      // The chapters: the scorer's outline + Viterbi path, the outline labels as titles.
      const boundaries = snapChapters.map((c) => c.startSeconds);

      // Calculate total API calls for accurate progress reporting: one summary
      // call per chapter + one question per stretch of the flag stage + the
      // FOUR metadata calls (tags, description hook, description body, title),
      // for the stages this run makes.
      //
      // The narrated-actor re-ask (at most one per viewer-facing field) is NOT
      // counted here, exactly as chapter and flag PARSE retries are not: this
      // number is the expected-work estimate the ETA divides by, and retries are
      // exceptions. Their real cost is still recorded — every attempt, retry
      // included, goes through trackTokens and lands in tokenStats.apiCalls.
      // The scorer stage's decides are NOT counted: they are not generation
      // calls, and counting them would poison the ETA's average-call-time.
      let chapterCallCount = boundaries.length;
      // The flag stage: one question per stretch, known once the transcript is cut.
      let flagReadCallCount = 0;
      const metadataCallCount = makeMetadata ? 4 : 0;
      const recomputeTotalApiCalls = () => {
        totalApiCalls = chapterCallCount + flagReadCallCount + metadataCallCount;
      };
      recomputeTotalApiCalls();
      completedApiCalls = 0;
      // ETA averages over every counted call, so the clock starts with Pass 2.
      pass2StartTime = Date.now();

      // Progress is BANDED PER STAGE, not computed as a fraction of all calls.
      //
      // A global call-fraction requires knowing the total up front, and a
      // stage's total can be unknown until it starts — so the bar used to
      // lurch (26% -> 53% on one chapter of seven) and then stall when the
      // real count arrived. Bands make each stage's share fixed and its motion
      // smooth: a stage that has not started occupies none of the bar, and a
      // stage that discovers more work slows down inside its own band instead
      // of stealing another stage's. A stage this run does not make has no band
      // at all (analysisProgressBands).
      //
      // The analysis engine is most of a run's time: it asks the model about
      // every sentence. The chat stages after it are a few calls each.
      const bandProgress = ([start, end]: [number, number], done: number, total: number) =>
        Math.round(start + (Math.min(done, total) / Math.max(1, total)) * (end - start));
      // Message-only ticks (stage announcements) report where their stage
      // currently sits rather than recomputing a global fraction.
      let lastProgress = 3;

      // =========================================================================
      // PASS 2: each chapter's summary (the outline gave its title)
      // =========================================================================
      let chapters: Chapter[] = [];
      if (makeChapters) {
        const summariesBand = bands.summaries!;
        lastProgress = summariesBand[0];
        sendProgress('analysis', lastProgress, `Analyzing ${boundaries.length} chapters (0/${totalApiCalls} API calls)...`);
        chapters = await this.analyzeChaptersPass2(
          aiConfig,
          segments,
          boundaries,
          videoTitle,
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
            lastProgress = bandProgress(summariesBand, current, total);
            sendProgress('analysis', lastProgress, `Analyzing chapter ${current}/${total}...`);
          },
          taskModels,
          signal,
          snapChapters.map((c) => c.title),
        );

        // Honest-failure gate: if NOT ONE chapter was successfully analyzed, the
        // run produced nothing real (every API call failed). Fail loudly with the
        // real reason instead of returning an empty analysis that looks successful
        // — stale/no data beats a lie. A partial run (some chapters analyzed, some
        // failed) still completes below with whatever succeeded. Checked before
        // the flag stage, which is never entered on a run that will fail.
        const successfulChapters = chapters.filter((ch) => !ch.failed).length;
        if (successfulChapters === 0) {
          throw new Error(
            lastFailureReason
              ? `no chapters could be analyzed — every analysis call failed. Last failure: ${lastFailureReason}`
              : 'no chapters could be analyzed — every analysis call failed.',
          );
        }

        // STORIES: the chapters, with their summaries, grouped by the chapter
        // model (one call, stories.ts). More than one story makes the outline
        // two levels; one keeps it flat, as a video under 10 minutes is.
        if (groupStoriesStage && snapChapters.length > 1) {
          const stories = await this.groupChaptersIntoStories(
            this.resolveTaskConfig(aiConfig, 'chapter', taskModels),
            snapChapters,
            chapters,
            videoSeconds,
            bands.stories!,
            (at, message) => sendProgress('analysis', at, message),
            trackTokens,
            signal,
          );
          if (stories.length > 1) snapTree = storyTreeFromGroups(stories, snapChapters);
        } else if (makeChapters) {
          this.logger.log(`[Stories] ${runtimePhrase(videoSeconds)}${range ? ' (a range)' : ''}, ${snapChapters.length} chapter(s): one story, flat outline`);
        }
      }

      // =========================================================================
      // FLAGS: the clip-worthy moments, marked by the flags model one stretch
      // at a time (flag-highlights.ts), as its own phase after every chapter,
      // so each model loads once even when 'flags' is routed to another model.
      // =========================================================================
      let flags: AnalyzedSection[] = [];
      const flagWarnings: string[] = [];
      if (makeFlags) {
        const flagBand = bands.flags!;
        const flagConfig = this.resolveTaskConfig(aiConfig, 'flags', taskModels);
        // The flag stage is the expensive one: never entered on a cancelled run.
        ensureNotCancelled(signal, 'the flag stage');
        lastProgress = flagBand[0];
        sendProgress('analysis', lastProgress, 'Finding the clip-worthy moments...');
        const stage = await this.runHighlightsFlagStage(
          flagConfig,
          segments,
          categories || [],
          videoTitle,
          trackTokens,
          (current, total) => {
            if (total !== flagReadCallCount) {
              flagReadCallCount = total;
              recomputeTotalApiCalls();
            }
            completedApiCalls = chapterCallCount + current - 1;
            lastProgress = bandProgress(flagBand, current - 1, total);
            sendProgress('analysis', lastProgress, `Finding flags: stretch ${current}/${total}...`);
          },
          signal,
        );
        flags = stage.sections;
        flagWarnings.push(...stage.warnings);
      }
      lastProgress = bands.metadata?.[0] ?? lastProgress;
      if (makeChapters || makeFlags) {
        sendProgress(
          'analysis',
          lastProgress,
          [makeChapters ? `Analyzed ${chapters.length} chapters` : '', makeFlags ? `found ${flags.length} flags` : '']
            .filter(Boolean)
            .join(', '),
        );
      }

      // Write the flags to the report.
      for (const flag of flags) this.writeSectionToFile(outputFile, flag);

      // =========================================================================
      // Generate metadata FROM chapters
      // =========================================================================
      // The chapters this run made, or the video's stored ones when it made
      // none (the metadata part alone).
      //
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

      if (makeMetadata) {
        const metadataBand = bands.metadata!;
        const metadataChapters = makeChapters ? chapters : storedChapters;

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
            lastProgress = bandProgress(metadataBand, metadataStepsDone++, metadataSteps.length);
            sendProgress('analysis', lastProgress, `${step.label}...`);
            switch (step.task) {
              case 'description':
                description = await this.generateDescriptionFromChapters(
                  step.cfg, metadataChapters, videoTitle, tags, recordFailure, trackTokens, signal,
                );
                break;
              case 'tags':
                tags = await this.generateTagsFromChapters(
                  step.cfg, metadataChapters, videoTitle, recordFailure, trackTokens, signal,
                );
                break;
              case 'title':
                suggestedTitle = await this.generateTitleFromChapters(
                  step.cfg, metadataChapters, videoTitle, recordFailure, trackTokens, signal,
                );
                break;
            }
          }
        }

        // Metadata that is all this run was asked for, and produced neither tags
        // nor a description, made nothing: completing would replace the stored
        // metadata with nothing. Fail with the real reason; the old metadata stays.
        // (A missing title alone is a legitimate "keep the filename".)
        if (!asked.has('chapters') && !asked.has('flags') && tags === null && description === null) {
          throw new Error(
            'no metadata could be written — the tags and the description both failed.' +
              (lastFailureReason ? ` Last failure: ${lastFailureReason}` : ''),
          );
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
      console.log(`[analyzeTranscript] RETURNING (${describeParts(made)}): sections=${flags.length}, chapters=${chapters.length}, tags=${JSON.stringify(tags)}`);
      if (chapters.length > 0) {
        console.log(`[analyzeTranscript] Chapters being returned: ${JSON.stringify(chapters)}`);
      }

      const warnings = [...runNotes, ...engineWarnings, ...flagWarnings];
      return {
        sections_count: flags.length,
        sections: flags,           // The flags (flags part)
        // Chapter list with titles/summaries; a refined outline adds its parents.
        chapters: snapTree ? nestAnalysisChapters(chapters, snapTree.flat) : chapters,
        // Only a run that made metadata carries it: undefined = not attempted.
        ...(makeMetadata ? { tags, description, suggested_title: suggestedTitle || undefined } : {}),
        tokenStats: tokenStats.apiCalls > 0 ? tokenStats : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        parts: made,
        ...(range ? { range } : {}),
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

        const response = await this.aiProviderService.generateText(prompt, config, 'chapter', {
          thinking: false,
          maxTokens: CHAPTER_SUMMARY_MAX_OUTPUT_TOKENS,
          format: CHAPTER_SUMMARY_SCHEMA,
          signal,
        });
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

  /**
   * THE FLAG STAGE (flag-highlights.ts): the flags model marks the clip-worthy
   * moments, one stretch of about 15 minutes per question, with add_marker in
   * the tool-call format it was trained on (tool-format.ts). The whole
   * transcript goes once in the system prompt when it fits the model's
   * context (a local model is loaded big enough for it, up to its maximum:
   * fitToolContext); otherwise each question carries its stretch with a
   * minute of context on each side, in stretches cut smaller while they
   * don't fit. Local models get a reply ceiling and thinking off.
   *
   * Each marker is one flag row: verdict 'flag' (shown at Confirmed), ranker
   * 'highlights-v1', no score, its category, its title, and "title — why" as
   * its reason. A stretch whose question fails is named in the job's
   * warnings; all of them failing fails the analysis (the stored flags stay).
   * A cancel or a park stops the run as it is; a Crucible that refuses
   * native tools for the model is answered with tags instead.
   */
  private async runHighlightsFlagStage(
    flagConfig: AIProviderConfig,
    segments: Segment[],
    categories: AnalysisCategory[],
    videoTitle: string,
    onTokens: ((response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void) | undefined,
    /** Called as stretch `current` (1-based) of `total` starts. */
    onWindow: (current: number, total: number) => void,
    signal: AbortSignal | undefined,
  ): Promise<{ sections: AnalyzedSection[]; warnings: string[] }> {
    const sentences = assembleSentences(segments);
    const enabled = enabledCategories(categories);
    const model = `${flagConfig.provider}:${flagConfig.model}`;
    if (sentences.length === 0 || enabled.length === 0) {
      this.logger.warn(
        `[Flags] Nothing to look for flags in: ${sentences.length === 0 ? 'no sentences could be assembled from the transcript' : 'no category is enabled'}`,
      );
      return { sections: [], warnings: [] };
    }

    // Sizing: the system prompt without the transcript, plus the tools section
    // a text format appends (Claude's, the longer of the two), plus the transcript.
    const input = { sentences, categories: enabled, videoTitle };
    const systemChars = highlightsSystemPrompt(input, 'window').length
      + claudeCodec.toolsPrompt([{ ...highlightToolDefinition(enabled.map((c) => c.name.trim())), execute: async () => ({ content: '' }) }]).length;
    const transcriptChars = sentences.reduce((sum, sentence) => sum + sentence.text.length + 1, 0);
    const fitted = await this.aiProviderService.fitToolContext(flagConfig, {
      promptChars: systemChars + transcriptChars,
      needed: wholeTranscriptTokens(systemChars, sentences),
      reserveTokens: HIGHLIGHT_REPLY_RESERVE_TOKENS,
      ...(signal === undefined ? {} : { signal }),
    });
    const plan = planTranscript(sentences, systemChars, fitted.tokens);
    if (plan === null) {
      throw new Error(
        `${model}'s context (${fitted.tokens.toLocaleString('en-US')} tokens) is too small to read even a 3-minute stretch of transcript for flags. Pick a model with a larger context for the flags.`,
      );
    }
    this.logger.log(
      `[Flags] Marking the clip-worthy moments on ${model}: ${sentences.length} sentences, ` +
        (plan.mode === 'whole'
          ? `the whole transcript in the system prompt (about ${plan.neededTokens.toLocaleString('en-US')} of ${fitted.tokens.toLocaleString('en-US')} tokens)`
          : `each question carrying its stretch (the whole transcript needs more than ${fitted.tokens.toLocaleString('en-US')} tokens)`) +
        `, stretches of up to ${Math.round(plan.windowSeconds / 60)} minutes; categories: ${enabled.map((c) => c.name).join(', ')}`,
    );

    const { transport, format } = await this.aiProviderService.toolChat(flagConfig, {
      maxTokens: HIGHLIGHT_MAX_OUTPUT_TOKENS,
      thinking: false,
      ...(fitted.loadContext === undefined ? {} : { loadContext: fitted.loadContext }),
      ...(fitted.contextTokens === undefined ? {} : { contextTokens: fitted.contextTokens }),
      ...(signal === undefined ? {} : { signal }),
      ...(onTokens === undefined ? {} : { onTokens }),
    });
    const startedAt = Date.now();
    const run = (codec: ReturnType<typeof codecFor>) =>
      findHighlights(
        { ...input, plan },
        {
          transport,
          codec,
          ...(signal === undefined ? {} : { signal }),
          stops: (error) => stopsTheRun(error) || isToolsRefusal(error),
          onWindow,
          log: (message) => this.logger.log(`[Flags] ${message}`),
        },
      );
    let result: Awaited<ReturnType<typeof findHighlights>>;
    try {
      try {
        result = await run(codecFor(format));
      } catch (error) {
        if (format !== 'native' || !isToolsRefusal(error)) throw error;
        this.logger.log(`[Flags] ${model} takes no native tools; marking with tool tags`);
        result = await run(tagCodec);
      }
    } catch (error) {
      if (error instanceof ToolLoopAborted) throw new AnalysisCancelledError('The flag stage was cancelled: job was cancelled');
      throw error;
    }

    const sections: AnalyzedSection[] = result.markers.map((marker) => {
      const text = sentences.slice(marker.from, marker.to + 1).map((sentence) => sentence.text).join(' ');
      return {
        category: marker.category,
        title: marker.title,
        description: highlightReason(marker),
        start_time: this.formatDisplayTime(marker.start),
        end_time: this.formatDisplayTime(marker.end),
        quotes: [{ timestamp: this.formatDisplayTime(marker.start), text }],
        verdict: 'flag',
        ranker: HIGHLIGHTS_RANKER,
      };
    });
    const warnings: string[] = [];
    if (result.failed.length > 0) {
      warnings.push(
        `Flags: ${result.failed.length} of ${result.windows} stretches of the transcript could not be read, so no flags were looked for in them: ${result.failed.join('; ')}`,
      );
    }
    this.logger.log(
      `[Flags] ${sections.length} flag(s) from ${result.windows} stretch(es) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s on ${model} ` +
        `(${format} tool calls, ${result.modelCalls} model call(s), ${result.notPlaced} call(s) not placed, ${result.failed.length} stretch(es) failed)`,
    );
    return { sections, warnings };
  }

  /**
   * STORIES: one call on the chapter model groups the chapters (times, titles,
   * Pass 2 summaries, sponsor marks) into stories (stories.ts). On a Crucible
   * catalog model: thinking off, temperature 0 (a cloud upstream is sent the
   * prompt alone, target.ts). Throws with the reason when the grouping cannot
   * be read after one retry (the Chapters part fails); a cancel or a park
   * stops the run as it is.
   */
  private async groupChaptersIntoStories(
    chapterConfig: AIProviderConfig,
    snapChapters: SnapChapter[],
    rows: Chapter[],
    videoSeconds: number,
    band: [number, number],
    progress: (at: number, message: string) => void,
    onTokens: ((response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Story[]> {
    // Chapter k (0-based) is Pass 2's row `sequence` k + 1; a failed row has no summary.
    const bySequence = new Map(rows.map((r) => [r.sequence, r]));
    const list = snapChapters.map((c, k) => {
      const row = bySequence.get(k + 1);
      return {
        startSeconds: c.startSeconds,
        endSeconds: c.endSeconds,
        title: c.title,
        summary: row && !row.failed ? row.summary ?? '' : '',
        isAd: c.isAd,
      };
    });
    const model = `${chapterConfig.provider}:${chapterConfig.model}`;
    const startedAt = Date.now();
    progress(band[0], `Grouping ${list.length} chapters into stories...`);
    this.logger.log(`[Stories] grouping ${list.length} chapters (${runtimePhrase(videoSeconds)}) on ${model}`);
    const found = await groupStories(list, videoSeconds, {
      generate: async (prompt) => {
        ensureNotCancelled(signal, 'grouping the stories');
        const response = await this.aiProviderService.generateText(prompt, chapterConfig, 'chapter', {
          // Sent to an ollama/ upstream only.
          numCtx: estimateNumCtx(prompt.length, chapterConfig.model, STORY_GROUP_MAX_OUTPUT_TOKENS),
          temperature: 0,
          thinking: false,
          maxTokens: STORY_GROUP_MAX_OUTPUT_TOKENS,
          signal,
        });
        onTokens?.(response);
        return { text: response.text, truncated: response.doneReason === 'length' };
      },
      log: (message) => this.logger.log(message),
    });
    progress(band[1], `Found ${found.stories.length} stor${found.stories.length === 1 ? 'y' : 'ies'}`);
    this.logger.log(
      `[Stories] ${found.stories.length} stor${found.stories.length === 1 ? 'y' : 'ies'} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
        `(${found.calls} call(s)): ` +
        found.stories
          .map((st) => `${formatHms(st.startSeconds)} "${st.title}" (chapters ${st.firstChapter + 1}-${st.lastChapter + 1}${st.isAd ? ', sponsor' : ''})`)
          .join(', '),
    );
    return found.stories;
  }

  /**
   * PASS 2: Analyze each chapter with full context. The LLM writes each
   * chapter's summary; the title is the scorer's outline label. The flags
   * are their own stage (runHighlightsFlagStage), run by analyzeTranscriptRun
   * only when the run makes flags.
   */
  private async analyzeChaptersPass2(
    config: AIProviderConfig,
    segments: Segment[],
    boundaries: number[],
    videoTitle: string,
    limits: ModelLimits,
    recordFailure: (what: string) => void,
    customInstructions: string | undefined,
    onTokens: ((response: { inputTokens?: number; outputTokens?: number; estimatedCost?: number }) => void) | undefined,
    onChapterProgress: ((current: number, total: number) => void) | undefined,
    taskModels: Partial<Record<AITaskKind, string>>,
    signal: AbortSignal | undefined,
    /**
     * The snap engine's outline labels, one per boundary. The LLM chapter call
     * supplies only the summary (its title is discarded), and long chapters are
     * NOT split: Viterbi's switch cost owns granularity, and a forced split
     * would manufacture chapters at arbitrary times (plan §4.5).
     */
    chapterTitles: string[],
  ): Promise<Chapter[]> {
    const chapters: Chapter[] = [];

    if (!segments || segments.length === 0) {
      this.logger.warn('[Pass 2] No segments available for chapter analysis');
      return chapters;
    }

    const videoDuration = segments[segments.length - 1].end;

    // Snap chapters: boundaries and titles come as a set, one title each.
    if (chapterTitles.length !== boundaries.length) {
      throw new Error(`the analysis engine gave ${chapterTitles.length} chapter titles for ${boundaries.length} chapters`);
    }
    const presetTitles = chapterTitles;
    const adjustedBoundaries = boundaries;

    let previousChapterSummary = '';

    this.logger.log(`[Pass 2] Analyzing ${adjustedBoundaries.length} chapters (max ${limits.maxChapterChars} chars each)`);

    // Chapter analysis may be routed to its own (typically smaller) model. All
    // chapter calls run consecutively, so this model loads once.
    const chapterConfig = this.resolveTaskConfig(config, 'chapter', taskModels);
    if (chapterConfig.model !== config.model) {
      this.logger.log(`[Pass 2] Analyzing chapters on ${chapterConfig.provider}:${chapterConfig.model}`);
    }

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

      // The flags deliberately do NOT happen here — see the flag stage in
      // analyzeTranscriptRun. Running them inline would alternate chapter/flags
      // per iteration, which reloads a model between every call the moment the
      // two tasks are routed to different models.

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


    this.logger.log(`[Pass 2] Analyzed ${chapters.length} chapters`);
    return chapters;
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
    currentTitle: string,
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

      // The filename too: it names the speaker a transcript seldom does.
      const prompt = interpolatePrompt(TAGS_FROM_CHAPTERS_PROMPT, {
        currentTitle: currentTitle || 'untitled',
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

      const response = await this.aiProviderService.generateText(prompt, config, 'title', { ...TITLE_OVERRIDES, signal });
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
        ...TITLE_OVERRIDES,
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
