/**
 * ASK: a chat about one video's transcript, with one tool, add_marker.
 *
 * The model quotes, Briefcase places: it is sent the transcript without a
 * single timestamp and names a passage by its first and last words; those are
 * found in the transcript's sentences (analysis/passage-anchor.ts, the flags
 * pipeline's matcher) and the sentences' times are the marker's. The answer is
 * the tool harness's loop (tool-harness/: free prose, the tool called with
 * inline <tool_use> tags) composed of a Crucible transport
 * (video-chat-transport.ts) and the add_marker tool (add-marker-tool.ts).
 *
 * INTERACTIVE, NOT QUEUED. An answer is one HTTP request that may take
 * minutes, called straight on CrucibleChatService (never the task queue), and
 * it never waits without bound:
 *
 *   - a cloud or Ollama upstream is forwarded by Crucible, with no session;
 *   - a local model (a catalog model, a size ceiling, an ollama tag the server
 *     runs as its own model) gets its own Crucible run: one queue session for
 *     the whole answer, so the model is loaded once (said as 'loading-model')
 *     and nothing evicts it between tool rounds, closed when the answer
 *     settles. Its wait in Crucible's line is bounded (CHAT_LINE_WAIT_S, the
 *     session's maxWaitS); past it the server ends the wait and the answer is
 *     a 503 `crucible_busy`, as is any busy refusal (no busyWait is given, and
 *     the run does not park: parking is the queue's). A size ceiling is sized
 *     by the context its session loaded the pick at (as an analysis is, dc597d1);
 *   - when another Briefcase run already holds that server (the queue's AI
 *     task, or another conversation's answer), a second session would not be
 *     ours to open: Crucible counts every request from this client as an item
 *     of the open one (same-client membership). With the same model resident
 *     there the answer runs inside it, outside any run of its own (nothing to
 *     load or evict). With another model, the answer is
 *     refused `crucible_busy` rather than evict that run's model mid-task.
 *
 * THE LIBRARY. The library open at the question is the answer's: its database
 * path is read at the start, and the answer is written there
 * (DatabaseService.withDatabaseAt) even if another library is open by then.
 *
 * Nothing is cut to fit: a transcript and conversation larger than the
 * model's context is refused `transcript_too_long`, naming the model.
 */
import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CrucibleUnreachable } from '@crucible/client';
import { DatabaseService } from '../database/database.service';
import { CrucibleReadinessService } from '../crucible/readiness.service';
import { CrucibleChatService, OLLAMA_CONTEXT_VERSION } from '../crucible/llm/crucible-chat.service';
import { CrucibleBusyError, CrucibleChatCancelled, CrucibleChatError, CrucibleNoVenueError } from '../crucible/llm/errors';
import { CrucibleFieldMissing } from '../crucible/errors';
import { crucibleUnavailableCause } from '../crucible/transport-failure';
import { CrucibleTargetError, crucibleTargetOf, isCloudTarget, storedChoice, type CrucibleTarget } from '../crucible/llm/target';
import { CRUCIBLE_OLLAMA_CONTEXT } from '../crucible/llm/ollama-map';
import { WebSocketService } from '../common/websocket.service';
import { assembleSentences } from '../analysis/flag-windows';
import { estimateNumCtx, numCtxMaxForModel, parseProviderModel } from '../analysis/model-utils';
import { formatHms } from '../analysis/analysis-parts';
import { buildVideoChatSystemPrompt } from '../analysis/prompts/video-chat-prompts';
import { parseSrtSegments } from '../search/transcript-moments';
import { tagCodec, replayHistory, runToolLoop, ToolLoopAborted, type StoredTurn, type ToolLoopEvent } from '../tool-harness';
import { addMarkerTool, chatTranscript, type ChatTranscript, type PlacedMarker } from './add-marker-tool';
import { crucibleTransport } from './video-chat-transport';
import * as store from './chat-store';
import type { ChatMarker, ChatMessage, ChatThread, VideoChatPhase } from './video-chat.types';

/** How long an answer's session may wait in Crucible's line before it is refused busy. */
export const CHAT_LINE_WAIT_S = 120;
/** Rounds of add_marker calls one answer may make. */
export const CHAT_MAX_TOOL_ROUNDS = 3;
/** Characters per token, the analysis's estimate (ai-analysis.service getModelLimits). */
const CHARS_PER_TOKEN = 3;
/** Room kept for the model's reply, and for each tool round's reply and results. */
const CHAT_OUTPUT_RESERVE_TOKENS = 4096;
const CHAT_ROUND_RESERVE_TOKENS = 512;
/** A cloud model's window, as the analysis takes it (claude/openai have large windows). */
const CLOUD_CONTEXT_TOKENS = 128000;

/** A refusal with its HTTP status and `code` (the global filter carries `code` through). */
export class VideoChatError extends HttpException {
  constructor(status: HttpStatus, readonly code: string, message: string) {
    super({ code, message }, status);
    this.name = 'VideoChatError';
  }
}

/** The model's window for this answer, and what the calls are sent so it holds. */
interface ChatWindow {
  tokens: number;
  /** `ollama/` upstream: the num_ctx to send. */
  contextTokens?: number;
  /** A local model: the context to load it at, at least. */
  loadContext?: number;
}

/** Where an answer runs: forwarded, in a run of its own, or inside the queue's session. */
type Venue = { kind: 'upstream' } | { kind: 'own-run' } | { kind: 'queue-session'; server: string };

@Injectable()
export class VideoChatService {
  private readonly logger = new Logger('VideoChat');
  /** Threads with an answer in flight: one at a time per thread. */
  private readonly answering = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly chat: CrucibleChatService,
    private readonly readiness: CrucibleReadinessService,
    private readonly websocket: WebSocketService,
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
   * Apply proposals into custom_markers under the set `setName`: category
   * 'custom' (the hand-made markers'), the note as the description, the range
   * as `HH:MM:SS - HH:MM:SS`. One already applied keeps its custom marker.
   */
  apply(threadId: string, markerIds: unknown, setName: unknown): { markers: ChatMarker[]; customMarkers: unknown[] } {
    const ids = Array.isArray(markerIds) ? markerIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
    const name = typeof setName === 'string' ? setName.trim() : '';
    if (ids.length === 0) throw new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Name the markers to apply.');
    if (!name) throw new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_request', 'Name the marker set.');
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
            markerSet: name,
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
   * answer: the open model call, a load, a wait in Crucible's line.
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

    this.answering.add(threadId);
    try {
      this.readiness.assertReadyNow('Ask');
      const sentences = assembleSentences(parseSrtSegments(srt));
      if (sentences.length === 0) {
        throw new VideoChatError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_transcript', 'This video has no transcript yet. Transcribe it first, then ask.');
      }
      const system = buildVideoChatSystemPrompt(video?.title || video?.filename || 'untitled', sentences);
      const result = await this.answer(threadId, choice, system, start.history, question, chatTranscript(sentences), signal);
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
      const refusal = this.refusalOf(error, choice);
      const { code, message } = refusal.getResponse() as { code?: string; message?: string };
      this.logger.warn(`[${threadId}] ${choice}: ${code ?? refusal.getStatus()}: ${message ?? refusal.message}`);
      throw refusal;
    } finally {
      this.answering.delete(threadId);
    }
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
    const choice = storedChoice({ provider: parsed.provider ?? '', model: parsed.model });
    const target = crucibleTargetOf(choice.provider, choice.model);
    const tools = [addMarkerTool(transcript)];
    const replayed = replayHistory(history);
    const promptChars = [system, tagCodec.toolsPrompt(tools), question, ...replayed.map((m) => m.content)].reduce((sum, text) => sum + text.length, 0);
    const venue = await this.venueOf(target);

    const work = async () => {
      if (venue.kind !== 'upstream') this.status(threadId, 'loading-model');
      const window = await this.windowOf(target, promptChars, signal);
      const needed = Math.ceil(promptChars / CHARS_PER_TOKEN) + CHAT_OUTPUT_RESERVE_TOKENS + CHAT_MAX_TOOL_ROUNDS * CHAT_ROUND_RESERVE_TOKENS;
      if (needed > window.tokens) {
        throw new VideoChatError(HttpStatus.UNPROCESSABLE_ENTITY, 'transcript_too_long',
          `This video's transcript and the conversation need about ${needed.toLocaleString('en-US')} tokens, more than ${value} takes `
          + `(${window.tokens.toLocaleString('en-US')}). Pick a model with a larger context, or start a new conversation.`);
      }
      const transport = crucibleTransport(this.chat, {
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
      const loop = () => runToolLoop({
        transport, tools, system, history: replayed, userMessage: question, maxRounds: CHAT_MAX_TOOL_ROUNDS, onEvent,
        ...(signal === undefined ? {} : { signal }),
      });
      if (venue.kind !== 'own-run') return loop();
      // Loaded in the run's session before the first turn, at the context it was sized for.
      return this.chat.withModel(undefined, choice.model, loop, {
        provider: choice.provider,
        ...(window.loadContext === undefined ? {} : { loadContext: window.loadContext }),
        ...(signal === undefined ? {} : { signal }),
      });
    };
    const result = venue.kind === 'own-run' ? await this.chat.withRun(work, { maxWaitS: CHAT_LINE_WAIT_S, localId: `ask:${threadId}` }) : await work();
    const markers = result.toolCalls.flatMap((call) => (call.ok && call.data !== undefined ? [call.data as PlacedMarker] : []));
    return { message: result.finalText, markers, trace: result.trace, usage: result.usage, rounds: result.rounds };
  }

  /**
   * Where the answer runs. A local model on a server Briefcase's queue holds
   * runs in the queue's session when that session has the same model, and is
   * refused busy when it has another; otherwise in a run of its own.
   */
  private async venueOf(target: CrucibleTarget): Promise<Venue> {
    if (isCloudTarget(target)) return { kind: 'upstream' };
    const chosen = await this.chat.effectiveTarget(target);
    if (chosen.target.route === 'upstream') return { kind: 'upstream' };
    const server = chosen.server ?? await this.chat.venueFor(chosen.target);
    const others = this.chat.otherRunsOn(server);
    if (others.length === 0) return { kind: 'own-run' };
    if (others.some((o) => o.model === chosen.target.model)) return { kind: 'queue-session', server };
    const holding = others.find((o) => o.model !== null)?.model;
    throw new CrucibleBusyError(server,
      `Briefcase is already using it for ${holding ? holding : 'other AI work'} (a queued task, or another answer). Ask with ${holding ? `${holding} or ` : ''}a cloud model, or when that work is done`);
  }

  /**
   * The model's context for this answer, never a guess: a cloud model's large
   * window; an `ollama/` upstream's num_ctx cap (Ollama's default on a
   * Crucible older than 1.0.24, which forwards none); a local model's
   * context as its session loaded it (a size ceiling), or as the server states
   * it (its served context, or the host's ceiling it is then loaded at).
   * Called inside the answer's run, so a ceiling's session opens here.
   */
  private async windowOf(target: CrucibleTarget, promptChars: number, signal: AbortSignal | undefined): Promise<ChatWindow> {
    if (isCloudTarget(target)) return { tokens: CLOUD_CONTEXT_TOKENS };
    const chosen = await this.chat.effectiveTarget(target, undefined, signal);
    const model = chosen.target;
    if (model.route === 'upstream') {
      const server = await this.chat.venueFor(model);
      if (!(await this.chat.serverAtLeast(server, OLLAMA_CONTEXT_VERSION))) return { tokens: CRUCIBLE_OLLAMA_CONTEXT };
      const reserve = CHAT_OUTPUT_RESERVE_TOKENS + CHAT_MAX_TOOL_ROUNDS * CHAT_ROUND_RESERVE_TOKENS;
      return { tokens: numCtxMaxForModel(model.bareModel), contextTokens: estimateNumCtx(promptChars, model.bareModel, reserve) };
    }
    if (chosen.context !== undefined) return { tokens: chosen.context, loadContext: chosen.context };
    if (chosen.loadContext !== undefined) return { tokens: chosen.loadContext, loadContext: chosen.loadContext };
    const server = chosen.server ?? await this.chat.venueFor(model);
    const stated = await this.chat.statedLocalContext(server, model.model);
    if (stated === null || !(stated.tokens > 0)) {
      if (!(await this.chat.modelsOn(server)).some((m) => m.id === model.model)) {
        throw new CrucibleChatError(404, 'unknown_model', `"${model.model}" is not a model Crucible "${server}" knows. Pick one from its catalog.`, server);
      }
      throw new CrucibleFieldMissing(server, `a context for ${model.model} (maxModelLen / contextDefault on GET /v1/models, or its context_ceilings row on GET /v1/capability)`, 'fit the transcript to it');
    }
    return { tokens: stated.tokens, ...(stated.loadAt === undefined ? {} : { loadContext: stated.loadAt }) };
  }

  /** A failure as the HTTP refusal the Ask tab reads: 409 Crucible, 422 the transcript, 503 not now, 502 the model. */
  private refusalOf(error: unknown, model: string): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof CrucibleTargetError) return new VideoChatError(HttpStatus.BAD_REQUEST, 'invalid_model', error.message);
    // The request went away: nobody reads this, but the log says why it stopped.
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
