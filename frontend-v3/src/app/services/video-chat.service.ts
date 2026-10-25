import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { getApiBase } from '../core/runtime-url';
import {
  ChatApplyResult,
  ChatMarker,
  ChatSendResult,
  ChatThread,
  ChatThreadDetail,
} from '../models/video-chat.model';

/**
 * The Ask tab's backend: /api/video-chat (threads, messages, marker proposals).
 *
 * A send is synchronous and can take minutes (a model load, then the answer),
 * so nothing here sets a timeout; progress arrives as `video-chat:status`
 * socket events (WebsocketService.onVideoChatStatus) while the request waits.
 */
@Injectable({ providedIn: 'root' })
export class VideoChatService {
  private readonly http = inject(HttpClient);
  private readonly base = `${getApiBase()}/video-chat`;

  /** A video's threads, newest first. */
  listThreads(videoId: string): Observable<ChatThread[]> {
    return this.http.get<ChatThread[]>(`${this.base}/videos/${encodeURIComponent(videoId)}/threads`);
  }

  createThread(videoId: string, model?: string | null): Observable<ChatThread> {
    const body: { model?: string } = {};
    if (model) body.model = model;
    return this.http.post<ChatThread>(`${this.base}/videos/${encodeURIComponent(videoId)}/threads`, body);
  }

  getThread(threadId: string): Observable<ChatThreadDetail> {
    return this.http.get<ChatThreadDetail>(`${this.base}/threads/${encodeURIComponent(threadId)}`);
  }

  deleteThread(threadId: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`${this.base}/threads/${encodeURIComponent(threadId)}`);
  }

  sendMessage(threadId: string, content: string, model: string): Observable<ChatSendResult> {
    return this.http.post<ChatSendResult>(`${this.base}/threads/${encodeURIComponent(threadId)}/messages`, { content, model });
  }

  /**
   * Stop the thread's answer in flight and take its question back (the backend
   * deletes it; the send's own request is refused 499 `cancelled`). Answers
   * once that answer has settled. Nothing in flight: a no-op.
   */
  cancel(threadId: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/threads/${encodeURIComponent(threadId)}/cancel`, {});
  }

  /** Dismiss a proposal, or bring a dismissed one back ('proposed'). */
  setMarkerStatus(markerId: string, status: 'dismissed' | 'proposed'): Observable<ChatMarker> {
    return this.http.patch<ChatMarker>(`${this.base}/markers/${encodeURIComponent(markerId)}`, { status });
  }

  /** Turn proposals into custom markers, each in its answer's marker set (ChatMarker.setName). */
  applyMarkers(threadId: string, markerIds: string[]): Observable<ChatApplyResult> {
    return this.http.post<ChatApplyResult>(`${this.base}/threads/${encodeURIComponent(threadId)}/apply`, { markerIds });
  }
}
