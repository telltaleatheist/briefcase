/**
 * ASK CONVERSATIONS IN THE LIBRARY DATABASE: chat_threads, chat_messages and
 * chat_markers (created in DatabaseService.initializeSchema), read and written
 * on the connection the caller passes, so a write that comes minutes after its
 * question goes to the library the question was asked in
 * (DatabaseService.withDatabaseAt). Synchronous, like better-sqlite3.
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { ChatMarker, ChatMarkerStatus, ChatMessage, ChatThread } from './video-chat.types';
import type { ChatMessage as TurnMessage, StoredTurn } from '../tool-harness';
import type { PlacedMarker } from './add-marker-tool';

/** A thread's title: its first question, cut at a word to about this many characters. */
export const THREAD_TITLE_CHARS = 60;

export function threadTitleOf(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  if (flat.length <= THREAD_TITLE_CHARS) return flat;
  const cut = flat.slice(0, THREAD_TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > THREAD_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A marker set's name: cut at a word to about this many characters. */
export const SET_NAME_CHARS = 40;

const TRAILING_PUNCTUATION = /[\s.,;:!?…–—-]+$/;

/**
 * A set name as the model (or a title) gave it, tidied: one line, no wrapping
 * quotes or end punctuation, cut at a word, in sentence case (the first letter
 * capitalised, the rest as written, so names keep theirs). '' when nothing is left.
 */
export function tidySetName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').replace(TRAILING_PUNCTUATION, '').trim();
  if (name.length > SET_NAME_CHARS) {
    const cut = name.slice(0, SET_NAME_CHARS);
    const space = cut.lastIndexOf(' ');
    name = (space > SET_NAME_CHARS / 2 ? cut.slice(0, space) : cut).replace(TRAILING_PUNCTUATION, '');
  }
  return name ? name[0].toUpperCase() + name.slice(1) : '';
}

/** How a question asks for markers ("Can you find all the…", "Is there a…"), dropped from a title made into a set name. */
const ASK_LEAD_IN = /^(?:(?:please|can you|could you|would you|will you|now)\s+)*(?:mark|find|show(?: me)?|list|highlight|point out|where(?:'s| is| are| does| do| did)?|is there|are there|what are|which are)(?:\s+(?:a|an|any|all|the|every))*\s+/i;

/**
 * A set name for an answer whose model named none (or for markers from before
 * set names): the thread's title, its first sentence without the asking.
 * "Is there a section where Trump is discussed?" is "Section where Trump is
 * discussed". A heuristic; no model call.
 */
export function fallbackSetName(threadTitle: string): string {
  const first = threadTitle.replace(/…$/, '').split(/[?.!]\s/)[0];
  return tidySetName(first.replace(ASK_LEAD_IN, '')) || tidySetName(threadTitle) || 'Ask';
}

/** One set name for an answer's markers: the first `set` the model gave among them, tidied, else the thread title's. */
export function answerSetName(markers: ReadonlyArray<Pick<PlacedMarker, 'set'>>, threadTitle: string): string {
  for (const m of markers) {
    const name = tidySetName(m.set ?? '');
    if (name) return name;
  }
  return fallbackSetName(threadTitle);
}

interface ThreadRow { id: string; video_id: string; title: string | null; model: string | null; created_at: string; updated_at: string }
interface MessageRow { id: string; thread_id: string; role: 'user' | 'assistant'; content: string; model: string | null; tool_trace_json: string | null; created_at: string }
interface MarkerRow {
  id: string; thread_id: string; message_id: string; video_id: string; title: string; note: string | null;
  start_seconds: number; end_seconds: number; status: ChatMarkerStatus; custom_marker_id: string | null;
  set_name: string | null; thread_title: string | null;
}

/** Marker rows with their thread's title (the set name of one stored without, from before set names). */
const MARKERS = 'SELECT m.*, t.title AS thread_title FROM chat_markers m JOIN chat_threads t ON t.id = m.thread_id';

const threadOf = (r: ThreadRow): ChatThread => ({ id: r.id, videoId: r.video_id, title: r.title ?? '', model: r.model, createdAt: r.created_at, updatedAt: r.updated_at });
const markerOf = (r: MarkerRow): ChatMarker => ({
  id: r.id, threadId: r.thread_id, messageId: r.message_id, title: r.title, note: r.note,
  startSeconds: r.start_seconds, endSeconds: r.end_seconds, status: r.status, customMarkerId: r.custom_marker_id,
  setName: r.set_name || fallbackSetName(r.thread_title ?? ''),
});

// ── threads ──────────────────────────────────────────────────────────────

/** A video's threads, the most recently used first. */
export function listThreads(db: Database, videoId: string): ChatThread[] {
  return (db.prepare('SELECT * FROM chat_threads WHERE video_id = ? ORDER BY updated_at DESC, created_at DESC').all(videoId) as ThreadRow[]).map(threadOf);
}

export function getThread(db: Database, threadId: string): ChatThread | null {
  const row = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ThreadRow | undefined;
  return row ? threadOf(row) : null;
}

export function createThread(db: Database, videoId: string, model: string | null, now = new Date().toISOString()): ChatThread {
  const id = randomUUID();
  db.prepare('INSERT INTO chat_threads (id, video_id, title, model, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)').run(id, videoId, model, now, now);
  return getThread(db, id)!;
}

/** A question was asked in it: it moves to the top, takes the model, and its first question names it. */
export function touchThread(db: Database, threadId: string, model: string, question: string, now = new Date().toISOString()): void {
  db.prepare('UPDATE chat_threads SET updated_at = ?, model = ?, title = COALESCE(title, ?) WHERE id = ?').run(now, model, threadTitleOf(question), threadId);
}

/**
 * A thread put back as `thread` read it (a question taken back): its time, its
 * model, and its title, unnamed again when that question was its first.
 */
export function restoreThread(db: Database, thread: ChatThread): void {
  db.prepare('UPDATE chat_threads SET updated_at = ?, model = ?, title = ? WHERE id = ?').run(thread.updatedAt, thread.model, thread.title || null, thread.id);
}

/** Its messages and markers go with it; custom markers applied from it stay. True when it existed. */
export function deleteThread(db: Database, threadId: string): boolean {
  return db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId).changes > 0;
}

// ── messages ─────────────────────────────────────────────────────────────

export function insertUserMessage(db: Database, threadId: string, content: string, model: string, now = new Date().toISOString()): ChatMessage {
  const id = randomUUID();
  db.prepare('INSERT INTO chat_messages (id, thread_id, role, content, model, created_at) VALUES (?, ?, \'user\', ?, ?, ?)').run(id, threadId, content, model, now);
  return { id, threadId, role: 'user', content, model, markers: [], createdAt: now };
}

/** A message taken back (a stopped question); a user message has no markers. */
export function deleteMessage(db: Database, messageId: string): void {
  db.prepare('DELETE FROM chat_messages WHERE id = ?').run(messageId);
}

/**
 * An answer, its hidden trace and usage, and the markers it placed (as
 * proposals, all under the answer's one set name), in one transaction.
 */
export function insertAnswer(
  db: Database,
  answer: { threadId: string; videoId: string; content: string; model: string; trace: TurnMessage[]; usage: unknown[]; markers: PlacedMarker[] },
  now = new Date().toISOString(),
): ChatMessage {
  const id = randomUUID();
  const setName = answerSetName(answer.markers, getThread(db, answer.threadId)?.title ?? '');
  const addMarker = db.prepare(
    `INSERT INTO chat_markers (id, thread_id, message_id, video_id, title, note, first_words, last_words, start_seconds, end_seconds, status, set_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, model, tool_trace_json, usage_json, created_at) VALUES (?, ?, \'assistant\', ?, ?, ?, ?, ?)',
    ).run(id, answer.threadId, answer.content, answer.model, JSON.stringify(answer.trace), JSON.stringify(answer.usage), now);
    for (const m of answer.markers) {
      addMarker.run(randomUUID(), answer.threadId, id, answer.videoId, m.title, m.note, m.firstWords, m.lastWords, m.startSeconds, m.endSeconds, setName, now);
    }
  })();
  return { id, threadId: answer.threadId, role: 'assistant', content: answer.content, model: answer.model, markers: markersOfMessage(db, id), createdAt: now };
}

/** A thread's messages, oldest first, each with its markers. */
export function listMessages(db: Database, threadId: string): ChatMessage[] {
  const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as MessageRow[];
  const byMessage = new Map<string, ChatMarker[]>();
  for (const marker of (db.prepare(`${MARKERS} WHERE m.thread_id = ? ORDER BY m.start_seconds, m.rowid`).all(threadId) as MarkerRow[]).map(markerOf)) {
    const list = byMessage.get(marker.messageId);
    if (list) list.push(marker);
    else byMessage.set(marker.messageId, [marker]);
  }
  return rows.map((r) => ({ id: r.id, threadId: r.thread_id, role: r.role, content: r.content, model: r.model, markers: byMessage.get(r.id) ?? [], createdAt: r.created_at }));
}

/**
 * The answered questions so far, each with its answer's trace (the model's raw
 * replies and the tool results it was sent), for the tool harness to replay
 * (replayHistory), so the model sees its own placements. A question left
 * unanswered (its answer failed) is not replayed: the next question takes its
 * place.
 */
export function historyOf(db: Database, threadId: string): StoredTurn[] {
  const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as MessageRow[];
  const turns: StoredTurn[] = [];
  rows.forEach((row, i) => {
    const question = rows[i - 1];
    if (row.role !== 'assistant' || question?.role !== 'user') return;
    const trace = row.tool_trace_json ? (JSON.parse(row.tool_trace_json) as TurnMessage[]) : [];
    turns.push({ userMessage: question.content, trace: trace.length > 0 ? trace : [{ role: 'assistant', content: row.content }] });
  });
  return turns;
}

// ── markers ──────────────────────────────────────────────────────────────

function markersOfMessage(db: Database, messageId: string): ChatMarker[] {
  return (db.prepare(`${MARKERS} WHERE m.message_id = ? ORDER BY m.start_seconds, m.rowid`).all(messageId) as MarkerRow[]).map(markerOf);
}

export function getMarker(db: Database, markerId: string): ChatMarker | null {
  const row = db.prepare(`${MARKERS} WHERE m.id = ?`).get(markerId) as MarkerRow | undefined;
  return row ? markerOf(row) : null;
}

/** The marker rows a thread holds among `ids`, with what applying them needs. */
export function markersToApply(db: Database, threadId: string, ids: string[]): Array<ChatMarker & { videoId: string }> {
  const get = db.prepare(`${MARKERS} WHERE m.id = ? AND m.thread_id = ?`);
  return ids.flatMap((id) => {
    const row = get.get(id, threadId) as MarkerRow | undefined;
    return row ? [{ ...markerOf(row), videoId: row.video_id }] : [];
  });
}

export function setMarkerStatus(db: Database, markerId: string, status: 'proposed' | 'dismissed'): ChatMarker | null {
  db.prepare('UPDATE chat_markers SET status = ? WHERE id = ?').run(status, markerId);
  return getMarker(db, markerId);
}

export function markApplied(db: Database, markerId: string, customMarkerId: string): ChatMarker | null {
  db.prepare('UPDATE chat_markers SET status = \'applied\', custom_marker_id = ? WHERE id = ?').run(customMarkerId, markerId);
  return getMarker(db, markerId);
}
