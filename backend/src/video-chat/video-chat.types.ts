/**
 * The wire types of /api/video-chat (Ask: a chat about one video's transcript).
 * The frontend's models/video-chat.model.ts is built against these.
 */

export interface ChatThread {
  id: string;
  videoId: string;
  /** The first question, cut to about 60 characters; '' until one is asked. */
  title: string;
  /** The last model asked in it, as the picker stores it (`provider:model`). */
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

export type VideoChatPhase = 'loading-model' | 'thinking' | 'placing-markers' | 'done' | 'error';

/** The `video-chat:status` socket event. */
export interface VideoChatStatusPayload {
  threadId: string;
  phase: VideoChatPhase;
}
