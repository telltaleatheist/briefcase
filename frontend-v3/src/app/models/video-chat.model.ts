import { HttpErrorResponse } from '@angular/common/http';

/**
 * ASK: a chat about one video's transcript (the Ask tab in Scout).
 *
 * The wire types of /api/video-chat. The model has one tool, add_marker; the
 * backend resolves its quotes to times and returns the markers attached to the
 * assistant message. Those markers are PROPOSALS until the user applies them
 * (they become custom markers under a named marker set) or dismisses them.
 */
export interface ChatThread {
  id: string;
  videoId: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatMarkerStatus = 'proposed' | 'applied' | 'dismissed';

export interface ChatMarker {
  id: string;
  threadId: string;
  messageId: string;
  title: string;
  note: string | null;
  startSeconds: number;
  endSeconds: number;
  status: ChatMarkerStatus;
  customMarkerId: string | null;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  markers: ChatMarker[];
  createdAt: string;
}

export interface ChatThreadDetail {
  thread: ChatThread;
  messages: ChatMessage[];
}

export interface ChatSendResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export interface ChatApplyResult {
  markers: ChatMarker[];
  customMarkers: unknown[];
}

export type ChatPhase = 'loading-model' | 'thinking' | 'placing-markers' | 'done' | 'error';

/** The `video-chat:status` socket event: where a send is while the HTTP request waits. */
export interface VideoChatStatus {
  threadId: string;
  phase: ChatPhase;
}

export const VIDEO_CHAT_STATUS_EVENT = 'video-chat:status';

/** The status line under a waiting thread. */
export function chatPhaseLabel(phase: ChatPhase | null): string {
  switch (phase) {
    case 'loading-model': return 'Loading model…';
    case 'thinking': return 'Thinking…';
    case 'placing-markers': return 'Placing markers…';
    default: return 'Sending…';
  }
}

/** HH:MM:SS (CLAUDE.md's time format). */
export function formatChatTime(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/** A marker chip's range: `HH:MM:SS–HH:MM:SS` (one time when it is a point). */
export function formatChatRange(start: number, end: number): string {
  const a = formatChatTime(start);
  const b = formatChatTime(end);
  return a === b ? a : `${a}–${b}`;
}

/** A send refused because it was stopped (499 `cancelled`): not an error to show. */
export function isChatCancelled(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse)) return false;
  const body = (error.error && typeof error.error === 'object' ? error.error : null) as { code?: string } | null;
  return error.status === 499 || body?.code === 'cancelled';
}

/** What an error from a send (or any chat call) says, to show inline in the thread. */
export function chatErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = (error.error && typeof error.error === 'object' ? error.error : null) as { code?: string; message?: string } | null;
    if (error.status === 0) return "Briefcase's backend could not be reached. Try again.";
    if (body?.code === 'crucible_required') return body.message || 'AI needs Crucible, and it is not ready.';
    if (body?.code === 'no_transcript') return body.message || 'This video has no transcript yet. Transcribe it first, then ask.';
    if (body?.code === 'transcript_too_long') return body.message || "This video's transcript is too long for the model.";
    if (typeof body?.message === 'string' && body.message) return body.message;
    if (typeof error.error === 'string' && error.error) return error.error;
    return `The request failed (${error.status}${error.statusText ? ' ' + error.statusText : ''}).`;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Try again.';
}
