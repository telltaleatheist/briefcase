/**
 * ASK: a chat about one video's transcript, with one tool, add_marker.
 *
 * The model quotes, Briefcase places: it is sent the transcript without a
 * single timestamp and names a passage by its first and last words; those are
 * found in the transcript's sentences (analysis/passage-anchor.ts, the flags
 * pipeline's matcher) and the sentences' times are the marker's. The answer is
 * the tool harness's loop (tool-harness/: free prose, the tool called
 * natively through Crucible 2.0.30+'s `tools`, in Claude's own
 * <function_calls> format for claude-cli, else with inline <tool_use> tags;
 * tool-format.ts) composed of a Crucible transport (video-chat-transport.ts) and the
 * add_marker tool (add-marker-tool.ts).
 *
 * INTERACTIVE, NOT QUEUED. An answer is one HTTP request that may take
 * minutes, called straight on CrucibleChatService (never the task queue), and
 * it never waits without bound:
 *
 *   - a cloud or Ollama upstream is forwarded by Crucible, with no session;
 *   - a local model (a catalog model, a size ceiling, an ollama tag the server
 *     runs as its own model) runs in Ask's own Crucible run: one queue session,
 *     so the model is loaded once (said as 'loading-model') and nothing evicts
 *     it between tool rounds. Its wait in Crucible's line is bounded
 *     (CHAT_LINE_WAIT_S, the session's maxWaitS); past it the server ends the
 *     wait and the answer is a 503 `crucible_busy`, as is any busy refusal (no
 *     busyWait is given, and the run does not park: parking is the queue's). A
 *     size ceiling is sized by the context its session loaded the pick at (as
 *     an analysis is, dc597d1);
 *   - when another Briefcase run already holds that server (the queue's AI
 *     task, or another conversation's answer), a second session would not be
 *     ours to open: Crucible counts every request from this client as an item
 *     of the open one (same-client membership). With the same model resident
 *     there the answer runs inside it, outside any run of its own (nothing to
 *     load or evict). With another model, the answer is
 *     refused `crucible_busy` rather than evict that run's model mid-task.
 *
 * THE HOLD. That run is KEPT after the answer (CrucibleChatService.keepRun),
 * so the next question on the same model and server, in any conversation,
 * finds the model loaded instead of reloading it. It is released after
 * ASK_HOLD_IDLE_MS with no question, when a question needs another model or
 * server, when Briefcase quits, and AT ONCE when other Briefcase work (the
 * queue's task) starts a Crucible run: an open session holds the server for
 * its client, so the queue never waits on an idle Ask. Its session asks for a
 * short idle_s (ASK_HOLD_SESSION_IDLE_S), so a backend that dies leaves the
 * card held for a minute and a half at most.
 *
 * THE LIBRARY. The library open at the question is the answer's: its database
 * path is read at the start, and the answer is written there
 * (DatabaseService.withDatabaseAt) even if another library is open by then.
 *
 * THE CONTEXT IS SIZED TO THE TRANSCRIPT. A local model loads at a default
 * context far under the most it can take (qwen3.8-27b-8bit: 12,288 of
 * 131,072); an answer that needs more than it is loaded at loads it bigger, in
 * the answer's run, up to its stated maximum (`max_context` on GET /v1/models).
 * Nothing is cut to fit: a transcript and conversation larger than that
 * maximum (or than a cloud model's window) is refused `transcript_too_long`,
 * naming the model and its maximum.
 *
 * STOP. `POST threads/:id/cancel` aborts the thread's answer in flight (the
 * open model call, a load, a wait in Crucible's line; the run's session is
 * closed as it settles) and takes the question back: its message is deleted
 * and the thread is as it was before it was asked. The question's own request
 * is refused 499 `cancelled`.
 */
import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CrucibleUnreachable } from '@crucible/client';
import { DatabaseService } from '../database/database.service';
import { CrucibleReadinessService } from '../crucible/readiness.service';
import { CrucibleChatService, isToolsRefusal, KeptRunReleased, type KeptRun } from '../crucible/llm/crucible-chat.service';
import { CrucibleBusyError, CrucibleChatCancelled, CrucibleChatError, CrucibleNoVenueError } from '../crucible/llm/errors';
import { CrucibleFieldMissing } from '../crucible/errors';
import { crucibleUnavailableCause } from '../crucible/transport-failure';
import { CrucibleTargetError, crucibleTargetOf, isCloudTarget, storedChoice, type CrucibleTarget } from '../crucible/llm/target';
import { chatLoadContext, CLOUD_CONTEXT_TOKENS, fitContext, type FittedContext } from '../crucible/llm/context-fit';
import { WebSocketService } from '../common/websocket.service';
import { assembleSentences } from '../analysis/flag-windows';
import { parseProviderModel } from '../analysis/model-utils';
import { formatHms } from '../analysis/analysis-parts';
import { buildVideoChatSystemPrompt } from '../analysis/prompts/video-chat-prompts';
import { parseSrtSegments } from '../search/transcript-moments';
import { claudeCodec, tagCodec, replayHistory, runToolLoop, ToolLoopAborted, type StoredTurn, type ToolCallCodec, type ToolLoopEvent } from '../tool-harness';
import { codecFor, toolFormatFor } from './tool-format';
import { addMarkerTool, chatTranscript, type ChatTranscript, type PlacedMarker } from './add-marker-tool';
import { claudeCliTransport, crucibleTransport } from './video-chat-transport';
import { ClaudeCliError, ClaudeCliService, claudeCliModelOf } from '../claude-cli/claude-cli.service';
import * as store from './chat-store';
import type { ChatMarker, ChatMessage, ChatThread, VideoChatPhase } from './video-chat.types';

/** How long an answer's session may wait in Crucible's line before it is refused busy. */
export const CHAT_LINE_WAIT_S = 120;
/** Rounds of add_marker calls one answer may make. */
export const CHAT_MAX_TOOL_ROUNDS = 3;
/**
 * Characters per token, kept on the safe side. Measured on qwen3.8-27b-8bit
 * (Oct 25 2026): an English transcript's prompt, 67,295 characters, was 15,348
 * prompt tokens (4.4 characters a token); 3.5 leaves a quarter's margin for
 * denser text (names, numbers, other languages).
 */
const CHARS_PER_TOKEN = 3.5;
/** Room kept for the model's reply, and for each tool round's reply and results. */
const CHAT_OUTPUT_RESERVE_TOKENS = 4096;
const CHAT_ROUND_RESERVE_TOKENS = 512;
/** How long a cancel waits for its answer to settle (the question taken back, the run's session closed). */
export const CHAT_CANCEL_SETTLE_MS = 10_000;
/** How long Ask keeps its model loaded after an answer, for the next question. */
export const ASK_HOLD_IDLE_MS = 5 * 60_000;
/** The held session's idle_s: the touch keeps it open; a backend that died stops touching it. */
export const ASK_HOLD_SESSION_IDLE_S = 90;

/** A refusal with its HTTP status and `code` (the global filter carries `code` through). */
export class VideoChatError extends HttpException {
  constructor(status: HttpStatus, readonly code: string, message: string) {
    super({ code, message }, status);
    this.name = 'VideoChatError';
  }
}

/** The model's window for this answer, and what the calls are sent so it holds (crucible/llm/context-fit.ts). */
type ChatWindow = FittedContext;

/** The context a local model is loaded at for an answer (crucible/llm/context-fit.ts). */
export { chatLoadContext };

/** Where an answer runs: forwarded, in Ask's own (kept) run on a server, or inside the queue's session. */
type Venue = { kind: 'upstream' } | { kind: 'own-run'; server: string; model: string } | { kind: 'queue-session'; server: string };

/** Ask's kept run: the model it holds loaded between questions, and when it lets go. */
interface AskHold {
  kept: KeptRun;
  server: string;
  model: string;
  idle: NodeJS.Timeout | null;
}

@Injectable()
export class VideoChatService implements OnModuleDestroy {
  private readonly logger = new Logger('VideoChat');
  /** Threads with an answer in flight (one at a time per thread): its stop, and when it has settled. */
  private readonly answering = new Map<string, { stop: AbortController; settled: Promise<void> }>();
  /** The model kept loaded between questions (THE HOLD), or null. */
  private hold: AskHold | null = null;
  /** How long the hold outlives an answer ({@link ASK_HOLD_IDLE_MS}); a spec shortens it. */
  holdIdleMs = ASK_HOLD_IDLE_MS;

  constructor(
    private readonly database: DatabaseService,
    private readonly chat: CrucibleChatService,
    private readonly readiness: CrucibleReadinessService,
    private readonly websocket: WebSocketService,
    // TEMPORARY (claude-cli): the user's exception to Crucible-only AI.
    private readonly claudeCli: ClaudeCliService = new ClaudeCliService(),
  ) {}

  // ── threads ────────────────────────────────────────────────────────────

  listThreads(videoId: string): ChatThread[] {
    return this.onLibrary((db) => store.listThreads(db, videoId));
  }

  createThread(videoId: string, model: string | null): ChatThread {
    if (!this.database.getVideoById(videoId)) throw new VideoChatError(HttpStatus.NOT_FOUND, 'video_not_found', 'That video is not in the open library.');
    return this.onLibrary((db) => store.createThread(db, videoId, model));
  }

  getThread(threadId: string): { thread: ChatThread; messages: ChatMessage[] } {
    return this.onLibrary((db) => {
      const thread = store.getThread(db, threadId);
      if (!thread) throw this.threadNotFound();
      return { thread, messages: store.listMessages(db, threadId) };
    });
  }

  deleteThread(threadId: string): { ok: true } {
    if (!this.onLibrary((db) => store.deleteThread(db, threadId))) throw this.threadNotFound();
    return { ok: true };
  }

  // ── markers ────────────────────────────────────────────────────────────

  setMarkerStatus(markerId: string, status: unknown): ChatMarker {
    if (status !== 'dismissed' && status !== 'proposed') {
      throw new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_request', 'status must be "dismissed" or "proposed".');
    }
    return this.onLibrary((db) => {
      const marker = store.getMarker(db, markerId);
      if (!marker) throw new VideoChatError(HttpStatus.NOT_FOUND, 'marker_not_found', 'That marker is not in the open library.');
      if (marker.status === 'applied') {
        throw new VideoChatError(HttpStatus.CONFLICT, 'marker_applied', 'That marker is already applied; change it in the markers list.');
      }
      return store.setMarkerStatus(db, markerId, status)!;
    });
  }

  /**
   * Apply proposals into custom_markers, each under its answer's set name
   * (ChatMarker.setName), or all under `setName` when one is given: category
   * 'custom' (the hand-made markers'), the note as the description, the range
   * as `HH:MM:SS - HH:MM:SS`. One already applied keeps its custom marker.
   */
  apply(threadId: string, markerIds: unknown, setName?: unknown): { markers: ChatMarker[]; customMarkers: unknown[] } {
    const ids = Array.isArray(markerIds) ? markerIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
    const name = typeof setName === 'string' ? setName.trim() : '';
    if (ids.length === 0) throw new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Name the markers to apply.');
    return this.onLibrary((db) => {
      if (!store.getThread(db, threadId)) throw this.threadNotFound();
      const found = store.markersToApply(db, threadId, ids);
      if (found.length !== new Set(ids).size) throw new VideoChatError(HttpStatus.NOT_FOUND, 'marker_not_found', 'Some of those markers are not in this conversation.');
      const markers = db.transaction(() =>
        found.map((m) => {
          if (m.status === 'applied' && m.customMarkerId !== null) return store.getMarker(db, m.id)!;
          const customMarkerId = randomUUID();
          this.database.insertCustomMarker({
            id: customMarkerId,
            videoId: m.videoId,
            startSeconds: m.startSeconds,
            endSeconds: m.endSeconds,
            timestampText: `${formatHms(m.startSeconds)} - ${formatHms(m.endSeconds)}`,
            title: m.title,
            description: m.note ?? undefined,
            category: 'custom',
            markerSet: name || m.setName,
          });
          return store.markApplied(db, m.id, customMarkerId)!;
        }),
      )();
      const wanted = new Set(markers.map((m) => m.customMarkerId));
      const customMarkers = [...new Set(found.map((m) => m.videoId))]
        .flatMap((videoId) => this.database.getCustomMarkers(videoId))
        .filter((c) => wanted.has(c.id));
      return { markers, customMarkers };
    });
  }

  // ── a question ─────────────────────────────────────────────────────────

  /**
   * Ask `content` in the thread with `model` (a stored `provider:model`
   * choice, as the analysis picker stores it). The question is saved first,
   * so it shows even when the answer fails; the failure is then thrown as an
   * HTTP refusal with its `code`. `signal` (the request going away) stops the
   * answer: the open model call, a load, a wait in Crucible's line. So does
   * {@link cancel}, which also takes the question back.
   */
  async ask(threadId: string, content: unknown, model: unknown, signal?: AbortSignal): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    const question = typeof content === 'string' ? content.trim() : '';
    const choice = typeof model === 'string' ? model.trim() : '';
    if (!question) throw new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Ask something.');
    if (!choice) throw new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Pick a model to ask.');
    const dbPath = this.database.getCurrentDbPath();
    if (dbPath === null || !this.database.isInitialized()) throw new VideoChatError(HttpStatus.CONFLICT, 'no_library', 'No library is open.');
    if (this.answering.has(threadId)) {
      throw new VideoChatError(HttpStatus.CONFLICT, 'thread_busy', 'This conversation is still answering the last question.');
    }

    // All read and written in this tick, on the library open now.
    const start = this.database.withDatabaseAt(dbPath, (db) => {
      const thread = store.getThread(db, threadId);
      if (!thread) throw this.threadNotFound();
      const history = store.historyOf(db, threadId);
      const userMessage = store.insertUserMessage(db, threadId, question, choice);
      store.touchThread(db, threadId, choice, question);
      return { thread, history, userMessage };
    });
    const video = this.database.getVideoById(start.thread.videoId);
    const srt = this.database.getTranscript(start.thread.videoId)?.srt_format ?? '';

    const stop = new AbortController();
    let settle: () => void = () => undefined;
    this.answering.set(threadId, { stop, settled: new Promise<void>((resolve) => { settle = resolve; }) });
    const answerSignal = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
    try {
      // TEMPORARY (claude-cli): the local Claude Code CLI needs no Crucible, so
      // a claude-cli question is not refused `crucible_required`.
      if (claudeCliModelOf(undefined, choice) === null) this.readiness.assertReadyNow('Ask');
      const sentences = assembleSentences(parseSrtSegments(srt));
      if (sentences.length === 0) {
        throw new VideoChatError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_transcript', 'This video has no transcript yet. Transcribe it first, then ask.');
      }
      const system = buildVideoChatSystemPrompt(video?.title || video?.filename || 'untitled', sentences);
      const result = await this.answer(threadId, choice, system, start.history, question, chatTranscript(sentences), answerSignal);
      // Stopped as the answer came in: nothing is stored.
      if (stop.signal.aborted) throw new ToolLoopAborted(stop.signal.reason);
      const assistantMessage = this.database.withDatabaseAt(dbPath, (db) => {
        if (!store.getThread(db, threadId)) {
          throw new VideoChatError(HttpStatus.CONFLICT, 'thread_deleted', 'The conversation was deleted while it was answering.');
        }
        const message = store.insertAnswer(db, {
          threadId, videoId: start.thread.videoId, content: result.message, model: choice,
          trace: result.trace, usage: result.usage, markers: result.markers,
        });
        store.touchThread(db, threadId, choice, question);
        return message;
      });
      this.status(threadId, 'done');
      this.logger.log(`[${threadId}] answered with ${choice}: ${result.markers.length} marker(s) placed in ${result.rounds} tool round(s)`);
      return { userMessage: start.userMessage, assistantMessage };
    } catch (error) {
      this.status(threadId, 'error');
      if (stop.signal.aborted) {
        // Stopped: the question goes back to the asker, so the thread is as it was before it.
        try {
          this.database.withDatabaseAt(dbPath, (db) => {
            store.deleteMessage(db, start.userMessage.id);
            store.restoreThread(db, start.thread);
          });
        } catch (err) {
          this.logger.warn(`[${threadId}] taking the stopped question back failed: ${(err as Error).message}`);
        }
      }
      const refusal = this.refusalOf(stop.signal.aborted ? new ToolLoopAborted(stop.signal.reason) : error, choice);
      const { code, message } = refusal.getResponse() as { code?: string; message?: string };
      this.logger.warn(`[${threadId}] ${choice}: ${code ?? refusal.getStatus()}: ${message ?? refusal.message}`);
      throw refusal;
    } finally {
      this.answering.delete(threadId);
      settle();
    }
  }

  /**
   * Stop the thread's answer in flight and take its question back (see ask).
   * Answers once that answer has settled (its run's session closed, the
   * question deleted), at most {@link CHAT_CANCEL_SETTLE_MS}, so a question
   * asked right after is not refused `thread_busy`. Nothing in flight: nothing to do.
   */
  async cancel(threadId: string): Promise<{ ok: true }> {
    const inFlight = this.answering.get(threadId);
    if (inFlight === undefined) return { ok: true };
    this.logger.log(`[${threadId}] stopped by the user`);
    inFlight.stop.abort(new Error('The question was stopped.'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      inFlight.settled,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, CHAT_CANCEL_SETTLE_MS); timer.unref?.(); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return { ok: true };
  }

  private async answer(
    threadId: string,
    value: string,
    system: string,
    history: StoredTurn[],
    question: string,
    transcript: ChatTranscript,
    signal: AbortSignal | undefined,
  ): Promise<{ message: string; markers: PlacedMarker[]; trace: StoredTurn['trace']; usage: unknown[]; rounds: number }> {
    const parsed = parseProviderModel(value);
    // TEMPORARY (claude-cli): a claude-cli choice skips Crucible entirely (a
    // user-requested exception to Crucible-only AI): no target, no run, no
    // session; forwarded like a cloud model, with a cloud model's window.
    const cliModel = claudeCliModelOf(parsed.provider, parsed.model);
    const choice = storedChoice({ provider: parsed.provider ?? '', model: parsed.model });
    const target = cliModel === null ? crucibleTargetOf(choice.provider, choice.model) : null;
    const tools = [addMarkerTool(transcript)];
    // The estimate counts the tools as a text format's prompt section: the
    // Claude format's for claude-cli, else the tag format's, which holds every
    // tool's definition (what the native format sends as `tools`, and Crucible
    // renders into the model's template) plus the calling instructions, so it
    // is never under either.
    const textCodec = cliModel !== null ? claudeCodec : tagCodec;
    const promptChars = [system, textCodec.toolsPrompt(tools), question, ...replayHistory(history, textCodec).map((m) => m.content)].reduce((sum, text) => sum + text.length, 0);
    const venue: Venue = target === null ? { kind: 'upstream' } : await this.venueOf(target);
    // A question for another model (or server) lets the held one go.
    if (venue.kind !== 'own-run' || this.hold?.server !== venue.server || this.hold?.model !== venue.model) {
      await this.releaseHold('a question needs another model');
    }

    const needed = Math.ceil(promptChars / CHARS_PER_TOKEN) + CHAT_OUTPUT_RESERVE_TOKENS + CHAT_MAX_TOOL_ROUNDS * CHAT_ROUND_RESERVE_TOKENS;

    const kept = venue.kind === 'own-run' ? this.holdFor(venue.server, venue.model) : null;
    const work = async () => {
      if (venue.kind !== 'upstream' && kept?.fresh !== false) this.status(threadId, 'loading-model');
      const window: ChatWindow = target === null ? { tokens: CLOUD_CONTEXT_TOKENS } : await this.windowOf(target, promptChars, needed, venue, signal);
      if (needed > window.tokens) {
        const most = window.maxTokens ?? window.tokens;
        throw new VideoChatError(HttpStatus.UNPROCESSABLE_ENTITY, 'transcript_too_long',
          `This video's transcript and the conversation need about ${needed.toLocaleString('en-US')} tokens, more than ${value} `
          + (window.maxTokens === undefined ? 'takes' : 'can take at most')
          + ` (${most.toLocaleString('en-US')}). ${window.refusal ?? 'Pick a cloud model, or start a new conversation.'}`);
      }
      const transport = cliModel !== null ? claudeCliTransport(this.claudeCli, cliModel) : crucibleTransport(this.chat, {
        provider: choice.provider,
        model: choice.model,
        ...(window.contextTokens === undefined ? {} : { contextTokens: window.contextTokens }),
        ...(window.loadContext === undefined ? {} : { loadContext: window.loadContext }),
      });
      let shown: VideoChatPhase | null = null;
      const onEvent = (event: ToolLoopEvent): void => {
        const phase = event.type === 'model-call' ? 'thinking' : event.type === 'tool-call' ? 'placing-markers' : null;
        if (phase !== null && phase !== shown) this.status(threadId, (shown = phase));
      };
      const run = (codec: ToolCallCodec) => runToolLoop({
        transport, tools, system, history: replayHistory(history, codec), userMessage: question, maxRounds: CHAT_MAX_TOOL_ROUNDS, onEvent, codec,
        ...(signal === undefined ? {} : { signal }),
      });
      // Each model the format it was trained on (tool-format.ts): Claude's
      // own for claude-cli; native tools where the serving Crucible takes them
      // (2.0.30+, every route), decided inside the run so it asks the server
      // the run placed the model on; the tag format below that. A model
      // Crucible refuses tools for by name (no tool format) is answered in the
      // tag format, and remembered (nativeToolsFor): the refusal comes on the
      // first call, before any tool ran, so the answer simply starts over.
      const loop = async () => {
        const nativeTools = target !== null && (await this.chat.nativeToolsFor(target, undefined, signal));
        const format = toolFormatFor({ claudeCli: cliModel !== null, nativeTools });
        if (format !== 'native') return run(codecFor(format));
        try {
          return await run(codecFor('native'));
        } catch (error) {
          if (!isToolsRefusal(error)) throw error;
          this.logger.log(`[${threadId}] ${value} takes no native tools; answering with tool tags`);
          return run(tagCodec);
        }
      };
      if (venue.kind !== 'own-run') return loop();
      // Loaded in the run's session before the first turn (unless the hold has it), at the context it was sized for.
      return this.chat.withModel(undefined, choice.model, loop, {
        provider: choice.provider,
        ...(window.loadContext === undefined ? {} : { loadContext: window.loadContext }),
        ...(signal === undefined ? {} : { signal }),
      });
    };
    const result = kept === null ? await work() : await this.inHold(kept.hold, work);
    const markers = result.toolCalls.flatMap((call) => (call.ok && call.data !== undefined ? [call.data as PlacedMarker] : []));
    return { message: result.finalText, markers, trace: result.trace, usage: result.usage, rounds: result.rounds };
  }

  /**
   * Where the answer runs. A local model on a server Briefcase's queue holds
   * runs in the queue's session when that session has the same model, and is
   * refused busy when it has another; otherwise in Ask's own run (the hold).
   */
  private async venueOf(target: CrucibleTarget): Promise<Venue> {
    if (isCloudTarget(target)) return { kind: 'upstream' };
    const chosen = await this.chat.effectiveTarget(target);
    if (chosen.target.route === 'upstream') return { kind: 'upstream' };
    const server = chosen.server ?? await this.chat.venueFor(chosen.target);
    const model = chosen.target.model;
    // The hold is Ask's own run, never another's: used when it has this model
    // here, else let go first (it would count as a run holding the server).
    const hold = this.hold;
    if (hold !== null && !hold.kept.released) {
      if (hold.server === server && hold.model === model) return { kind: 'own-run', server, model };
      await this.releaseHold('a question needs another model', hold);
    }
    const others = this.chat.otherRunsOn(server);
    if (others.length === 0) return { kind: 'own-run', server, model };
    if (others.some((o) => o.model === chosen.target.model)) return { kind: 'queue-session', server };
    const holding = others.find((o) => o.model !== null)?.model;
    throw new CrucibleBusyError(server,
      `Briefcase is already using it for ${holding ? holding : 'other AI work'} (a queued task, or another answer). Ask with ${holding ? `${holding} or ` : ''}a cloud model, or when that work is done`);
  }

  /**
   * The model's context for this answer, never a guess (crucible/llm/context-fit.ts):
   * widened when the answer needs more, except inside the queue's own session.
   * Called inside the answer's run, so a ceiling's session opens here.
   */
  private async windowOf(target: CrucibleTarget, promptChars: number, needed: number, venue: Venue, signal: AbortSignal | undefined): Promise<ChatWindow> {
    return fitContext(this.chat, target, {
      promptChars,
      needed,
      reserveTokens: CHAT_OUTPUT_RESERVE_TOKENS + CHAT_MAX_TOOL_ROUNDS * CHAT_ROUND_RESERVE_TOKENS,
      inQueueSession: venue.kind === 'queue-session',
      ...(signal === undefined ? {} : { signal }),
      log: (message) => this.logger.log(message),
    });
  }

  /** A failure as the HTTP refusal the Ask tab reads: 409 Crucible, 422 the transcript, 503 not now, 502 the model. */
  private refusalOf(error: unknown, model: string): HttpException {
    if (error instanceof HttpException) return error;
    // TEMPORARY (claude-cli): the local Claude Code CLI's failures, by name.
    if (error instanceof ClaudeCliError) {
      if (error.code === 'cancelled') return new VideoChatError(499 as HttpStatus, 'cancelled', 'The question was cancelled.');
      if (error.code === 'not_installed') return new VideoChatError(HttpStatus.SERVICE_UNAVAILABLE, 'claude_cli_missing', error.message);
      return new VideoChatError(HttpStatus.BAD_GATEWAY, `claude_cli_${error.code}`, error.message);
    }
    if (error instanceof CrucibleTargetError) return new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_model', error.message);
    // Stopped, or the request went away: the Ask tab shows nothing for it, but the log says why it stopped.
    if (error instanceof ToolLoopAborted || error instanceof CrucibleChatCancelled) return new VideoChatError(499 as HttpStatus, 'cancelled', 'The question was cancelled.');
    if (error instanceof CrucibleBusyError) {
      return new VideoChatError(HttpStatus.SERVICE_UNAVAILABLE, 'crucible_busy', `Crucible "${error.server}" is busy: ${error.busyLine}. Ask again in a moment.`);
    }
    if (error instanceof CrucibleNoVenueError) return new VideoChatError(HttpStatus.SERVICE_UNAVAILABLE, 'crucible_unreachable', error.message);
    if (error instanceof CrucibleChatError) {
      if (error.code === 'unreachable' || error.code === 'timeout') return new VideoChatError(HttpStatus.SERVICE_UNAVAILABLE, `crucible_${error.code}`, error.message);
      return new VideoChatError(HttpStatus.BAD_GATEWAY, error.code, `${model}: ${error.message}`);
    }
    if (error instanceof CrucibleFieldMissing) return new VideoChatError(HttpStatus.BAD_GATEWAY, 'crucible_field_missing', error.message);
    const wire = error instanceof CrucibleUnreachable ? error.message : crucibleUnavailableCause(error);
    if (wire !== null) return new VideoChatError(HttpStatus.SERVICE_UNAVAILABLE, 'crucible_unreachable', `Crucible isn't answering (${wire}).`);
    return new VideoChatError(HttpStatus.BAD_GATEWAY, 'chat_failed', `${model}: ${(error as Error).message}`);
  }

  // ── the hold ───────────────────────────────────────────────────────────

  /**
   * Ask's kept run for `model` on `server`: the hold when it has them, else a
   * new one (its session opened by the answer's first local call). `fresh`:
   * nothing is loaded in it yet.
   */
  private holdFor(server: string, model: string): { hold: AskHold; fresh: boolean } {
    const current = this.hold;
    if (current !== null && !current.kept.released && current.server === server && current.model === model) {
      this.disarm(current);
      return { hold: current, fresh: current.kept.held().length === 0 };
    }
    const kept = this.chat.keepRun(
      { maxWaitS: CHAT_LINE_WAIT_S, idleS: ASK_HOLD_SESSION_IDLE_S, localId: 'ask' },
      (reason) => {
        if (this.hold?.kept !== kept) return;
        this.disarm(this.hold);
        this.hold = null;
        this.logger.log(`[${server}] let ${model} go: ${reason}`);
      },
    );
    const hold: AskHold = { kept, server, model, idle: null };
    this.hold = hold;
    return { hold, fresh: true };
  }

  /**
   * An answer in the hold. Kept after it (the idle clock restarts) when it
   * answered, stopped or was refused by Ask itself; let go when Crucible
   * failed it (a busy line, a load that failed), so the next question starts clean.
   */
  private async inHold<T>(hold: AskHold, work: () => Promise<T>): Promise<T> {
    try {
      const result = await hold.kept.run(work);
      this.arm(hold);
      return result;
    } catch (error) {
      if (error instanceof KeptRunReleased) {
        // Let go between the choice and the run (the queue started): no Crucible was touched.
        throw new CrucibleBusyError(hold.server, 'Briefcase started other AI work on it just now');
      }
      // Stopped, or refused before Crucible was asked (a transcript too long): the model stays.
      if (error instanceof ToolLoopAborted || error instanceof CrucibleChatCancelled || error instanceof VideoChatError) this.arm(hold);
      else await this.releaseHold('the answer failed', hold);
      throw error;
    }
  }

  private arm(hold: AskHold): void {
    this.disarm(hold);
    if (this.hold !== hold || hold.kept.released) return;
    hold.idle = setTimeout(() => void this.releaseHold(`no question for ${Math.round(this.holdIdleMs / 1000)} s`, hold), this.holdIdleMs);
    hold.idle.unref?.();
  }

  private disarm(hold: AskHold): void {
    if (hold.idle !== null) clearTimeout(hold.idle);
    hold.idle = null;
  }

  /** Let the held model go (the session closed); `only`: when that is still the hold. */
  private async releaseHold(reason: string, only?: AskHold): Promise<void> {
    const hold = this.hold;
    if (hold === null || (only !== undefined && hold !== only)) return;
    this.disarm(hold);
    this.hold = null;
    await hold.kept.release(reason);
  }

  /** The quit (CrucibleChatService releases kept runs too; this stops the clock). */
  onModuleDestroy(): void {
    if (this.hold !== null) void this.releaseHold('Briefcase is quitting');
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  /** Quick reads and writes, on the library open now (synchronous: no switch can land inside). */
  private onLibrary<T>(fn: (db: Parameters<Parameters<DatabaseService['withDatabaseAt']>[1]>[0]) => T): T {
    const dbPath = this.database.getCurrentDbPath();
    if (dbPath === null || !this.database.isInitialized()) throw new VideoChatError(HttpStatus.CONFLICT, 'no_library', 'No library is open.');
    return this.database.withDatabaseAt(dbPath, fn);
  }

  private threadNotFound(): VideoChatError {
    return new VideoChatError(HttpStatus.NOT_FOUND, 'thread_not_found', 'That conversation is not in the open library.');
  }

  /** Best effort: the HTTP answer is the result. */
  private status(threadId: string, phase: VideoChatPhase): void {
    try {
      this.websocket.emitVideoChatStatus({ threadId, phase });
    } catch {
      // A display event never breaks an answer.
    }
  }
}
