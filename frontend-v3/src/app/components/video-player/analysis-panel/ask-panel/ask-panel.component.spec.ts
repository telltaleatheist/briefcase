import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed, fakeAsync, flush, flushMicrotasks } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { AskPanelComponent } from './ask-panel.component';
import { VideoChatService } from '../../../../services/video-chat.service';
import { WebsocketService } from '../../../../services/websocket.service';
import { CrucibleReadinessService } from '../../../../services/crucible-readiness.service';
import { AiModelOptionsService } from '../../../../services/ai-model-options.service';
import { PipelinePresetsService } from '../../../../core/stores/pipeline-presets.service';
import type { ChatMessage, ChatSendResult, ChatThread } from '../../../../models/video-chat.model';

const thread = (id: string, title = ''): ChatThread =>
  ({ id, videoId: 'v1', title, model: 'local:max-27b', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z' });
const message = (id: string, role: 'user' | 'assistant', content: string): ChatMessage =>
  ({ id, threadId: 't1', role, content, model: 'local:max-27b', markers: [], createdAt: '2026-10-25T10:00:00Z' });

/**
 * Stop: the pending bubble goes, the question is back in the box, the
 * backend is told to cancel, the send's request is dropped, and the thread
 * is as it was before the question (a new chat's thread deleted again).
 */
describe('AskPanelComponent: Stop', () => {
  let fixture: ComponentFixture<AskPanelComponent>;
  let panel: AskPanelComponent;
  let sends: Subject<ChatSendResult>;
  let cancels: Subject<{ ok: true }>;
  let creates: Subject<ChatThread>;
  let chat: jasmine.SpyObj<VideoChatService>;
  const history = [message('m1', 'user', 'Earlier?'), message('m2', 'assistant', 'Earlier answer.')];

  beforeEach(() => {
    sends = new Subject();
    cancels = new Subject();
    creates = new Subject();
    chat = jasmine.createSpyObj<VideoChatService>('VideoChatService', ['listThreads', 'getThread', 'createThread', 'sendMessage', 'cancel', 'deleteThread']);
    chat.listThreads.and.returnValue(of([thread('t1', 'Earlier?')]));
    chat.getThread.and.returnValue(of({ thread: thread('t1', 'Earlier?'), messages: history }));
    chat.createThread.and.returnValue(creates);
    chat.sendMessage.and.returnValue(sends);
    chat.cancel.and.returnValue(cancels);
    chat.deleteThread.and.returnValue(of({ ok: true as const }));
    TestBed.configureTestingModule({
      imports: [AskPanelComponent],
      providers: [
        { provide: VideoChatService, useValue: chat },
        { provide: WebsocketService, useValue: { onVideoChatStatus: () => () => {} } },
        { provide: CrucibleReadinessService, useValue: { ready: signal(true), requireReady: () => true, handleRefusal: () => null } },
        { provide: AiModelOptionsService, useValue: { view: signal(null) } },
        { provide: PipelinePresetsService, useValue: { lastChosenAiModel: signal('local:max-27b') } },
      ],
    });
    // The model picker is not under test.
    TestBed.overrideComponent(AskPanelComponent, { set: { imports: [CommonModule, FormsModule], schemas: [CUSTOM_ELEMENTS_SCHEMA] } });
    fixture = TestBed.createComponent(AskPanelComponent);
    panel = fixture.componentInstance;
    panel.videoId = 'v1';
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const button = () => el().querySelector('.send-btn') as HTMLButtonElement;

  async function openThread(): Promise<void> {
    await panel.loadThreads(true);
    fixture.detectChanges();
  }

  it('on an open thread: the bubble goes, the question is back, cancel is called, and the thread is as it was', fakeAsync(() => {
    void openThread();
    flushMicrotasks();
    panel.draft.set('What about the budget?');
    void panel.send();
    fixture.detectChanges();
    expect(button().textContent!.trim()).toBe('Stop');
    expect(el().querySelector('.message.user.pending')).not.toBeNull();

    void panel.stop();
    fixture.detectChanges();
    expect(chat.cancel).toHaveBeenCalledWith('t1');
    expect(el().querySelector('.message.user.pending')).toBeNull();
    expect(panel.draft()).toBe('What about the budget?');
    expect(button().textContent!.trim()).toBe('Stopping…');

    // The backend refuses the send 499 `cancelled` before cancel answers.
    sends.error(new HttpErrorResponse({ status: 499, error: { code: 'cancelled', message: 'The question was cancelled.' } }));
    cancels.next({ ok: true });
    cancels.complete();
    flushMicrotasks();
    fixture.detectChanges();

    expect(panel.pending()).toBeNull();
    expect(panel.sendErrorHere()).toBe('');
    expect(panel.messages()).toEqual(history);
    expect(panel.draft()).toBe('What about the budget?');
    expect(panel.canSend()).toBeTrue();
    expect(button().textContent!.trim()).toBe('Send');
    flush();
  }));

  it('cancel answering first: the send\'s request is dropped (unsubscribed), and nothing is shown as an error', fakeAsync(() => {
    void openThread();
    flushMicrotasks();
    panel.draft.set('Where is the flood?');
    void panel.send();
    flushMicrotasks();
    expect(sends.observed).toBeTrue();
    void panel.stop();
    cancels.next({ ok: true });
    cancels.complete();
    flushMicrotasks();
    expect(sends.observed).toBeFalse();
    expect(panel.pending()).toBeNull();
    expect(panel.sendErrorHere()).toBe('');
    expect(panel.draft()).toBe('Where is the flood?');
    flush();
  }));

  it('in a new chat whose thread is still being made: that thread is deleted again and the chat stays new', fakeAsync(() => {
    chat.listThreads.and.returnValue(of([]));
    void openThread();
    flushMicrotasks();
    expect(panel.currentThreadId()).toBeNull();
    panel.draft.set('First question?');
    void panel.send();
    void panel.stop();
    flushMicrotasks();
    expect(chat.cancel).not.toHaveBeenCalled();
    creates.next(thread('t9'));
    creates.complete();
    flushMicrotasks();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(chat.deleteThread).toHaveBeenCalledWith('t9');
    expect(panel.currentThreadId()).toBeNull();
    expect(panel.threads()).toEqual([]);
    expect(panel.pending()).toBeNull();
    expect(panel.draft()).toBe('First question?');
    flush();
  }));
});

/**
 * TEMPORARY (claude-cli): a claude-cli model is the local Claude Code CLI, the
 * user's exception to Crucible-only AI. Ask sends with it while Crucible is
 * down; a Crucible model still needs Crucible; nothing picks it for the user.
 */
describe('AskPanelComponent: Claude Code without Crucible', () => {
  let panel: AskPanelComponent;
  let chat: jasmine.SpyObj<VideoChatService>;
  let requireReady: jasmine.Spy;

  beforeEach(() => {
    chat = jasmine.createSpyObj<VideoChatService>('VideoChatService', ['listThreads', 'getThread', 'createThread', 'sendMessage', 'cancel', 'deleteThread']);
    chat.listThreads.and.returnValue(of([]));
    chat.createThread.and.returnValue(of(thread('t9')));
    chat.sendMessage.and.returnValue(of({ userMessage: message('u1', 'user', 'Hi?'), assistantMessage: message('a1', 'assistant', 'Hello.') }));
    requireReady = jasmine.createSpy('requireReady').and.returnValue(false);
    TestBed.configureTestingModule({
      imports: [AskPanelComponent],
      providers: [
        { provide: VideoChatService, useValue: chat },
        { provide: WebsocketService, useValue: { onVideoChatStatus: () => () => {} } },
        { provide: CrucibleReadinessService, useValue: { ready: signal(false), requireReady, handleRefusal: () => null } },
        { provide: AiModelOptionsService, useValue: { view: signal(null) } },
        { provide: PipelinePresetsService, useValue: { lastChosenAiModel: signal('local:max-27b') } },
      ],
    });
    TestBed.overrideComponent(AskPanelComponent, { set: { imports: [CommonModule, FormsModule], schemas: [CUSTOM_ELEMENTS_SCHEMA] } });
    const fixture = TestBed.createComponent(AskPanelComponent);
    panel = fixture.componentInstance;
    panel.videoId = 'v1';
    panel.draft.set('Hi?');
  });

  it('a Crucible model can not send while Crucible is down', fakeAsync(() => {
    expect(panel.canAsk()).toBeFalse();
    expect(panel.canSend()).toBeFalse();
    void panel.send();
    flushMicrotasks();
    expect(requireReady).toHaveBeenCalled();
    expect(chat.sendMessage).not.toHaveBeenCalled();
  }));

  it('a Claude Code model sends without asking for Crucible', fakeAsync(() => {
    panel.modelChoice.set('claude-cli:claude-haiku-5-5');
    expect(panel.canSend()).toBeTrue();
    void panel.send();
    flushMicrotasks();
    expect(requireReady).not.toHaveBeenCalled();
    expect(chat.sendMessage).toHaveBeenCalledWith('t9', 'Hi?', 'claude-cli:claude-haiku-5-5');
  }));
});
