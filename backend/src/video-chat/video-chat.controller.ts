/**
 * `/api/video-chat/*`: Ask, a chat about one video's transcript
 * (video-chat.service.ts). Every refusal is `{code, message}`.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { VideoChatService } from './video-chat.service';
import type { ChatMarker, ChatMessage, ChatThread } from './video-chat.types';

@Controller('video-chat')
export class VideoChatController {
  constructor(private readonly chat: VideoChatService) {}

  @Get('videos/:videoId/threads')
  listThreads(@Param('videoId') videoId: string): ChatThread[] {
    return this.chat.listThreads(videoId);
  }

  @Post('videos/:videoId/threads')
  createThread(@Param('videoId') videoId: string, @Body() body: { model?: unknown }): ChatThread {
    const model = typeof body?.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;
    return this.chat.createThread(videoId, model);
  }

  @Get('threads/:threadId')
  getThread(@Param('threadId') threadId: string): { thread: ChatThread; messages: ChatMessage[] } {
    return this.chat.getThread(threadId);
  }

  /** The conversation only: custom markers applied from it stay. */
  @Delete('threads/:threadId')
  deleteThread(@Param('threadId') threadId: string): { ok: true } {
    return this.chat.deleteThread(threadId);
  }

  /** Ask a question; answers when the model has (it may take minutes). Progress is `video-chat:status`. */
  @Post('threads/:threadId/messages')
  ask(
    @Param('threadId') threadId: string,
    @Body() body: { content?: unknown; model?: unknown },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    // The tab closed or the request was dropped before the answer: stop working on it.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gone.abort(new Error('The request went away.'));
    });
    return this.chat.ask(threadId, body?.content, body?.model, gone.signal);
  }

  /**
   * Stop the thread's answer in flight and take its question back; that
   * question's POST is refused 499 `cancelled`. Nothing in flight: a no-op.
   */
  @Post('threads/:threadId/cancel')
  cancel(@Param('threadId') threadId: string): Promise<{ ok: true }> {
    return this.chat.cancel(threadId);
  }

  @Patch('markers/:markerId')
  setMarkerStatus(@Param('markerId') markerId: string, @Body() body: { status?: unknown }): ChatMarker {
    return this.chat.setMarkerStatus(markerId, body?.status);
  }

  /** Proposals into custom markers, each in its answer's set; `setName`, when given, names one set for all. */
  @Post('threads/:threadId/apply')
  apply(@Param('threadId') threadId: string, @Body() body: { markerIds?: unknown; setName?: unknown }): { markers: ChatMarker[]; customMarkers: unknown[] } {
    return this.chat.apply(threadId, body?.markerIds, body?.setName);
  }
}
