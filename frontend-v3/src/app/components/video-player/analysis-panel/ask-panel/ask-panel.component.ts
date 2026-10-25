import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { VideoChatService } from '../../../../services/video-chat.service';
import { WebsocketService } from '../../../../services/websocket.service';
import { CrucibleReadinessService } from '../../../../services/crucible-readiness.service';
import { AiModelOptionsService } from '../../../../services/ai-model-options.service';
import { PipelinePresetsService } from '../../../../core/stores/pipeline-presets.service';
import { AiModelSelectComponent } from '../../../ai-model-select/ai-model-select.component';
import {
  ChatMarker,
  ChatMessage,
  ChatPhase,
  ChatThread,
  chatErrorMessage,
  chatPhaseLabel,
  formatChatRange,
} from '../../../../models/video-chat.model';

const SHOW_ON_TIMELINE_KEY = 'briefcase-ask-proposals-on-timeline';

function readShowOnTimeline(): boolean {
  try {
    return localStorage.getItem(SHOW_ON_TIMELINE_KEY) !== 'false';
  } catch {
    return true;
  }
}

/** A send on its way: the thread it went to (null while a new chat's thread is being made), and its phase. */
interface PendingSend {
  videoId: string;
  threadId: string | null;
  content: string;
  phase: ChatPhase | null;
}

/** The inline "apply to marker set" form: which proposals, and where it opened ('thread', 'message:<id>', 'marker:<id>'). */
interface ApplyForm {
  key: string;
  markerIds: string[];
}

/**
 * THE ASK TAB: a chat about this video's transcript.
 *
 * Threads per video (the newest opens), a message list, and a composer gated
 * on Crucible readiness. Markers the model placed arrive on assistant messages
 * as PROPOSALS: chips that seek, apply (into custom markers under a named
 * marker set) or dismiss (with undo). The current thread's proposals are
 * emitted to the player, which draws them as a ghost lane on the timeline.
 *
 * The component stays alive while other tabs are open (the host hides it), so
 * a send in flight and the timeline's proposals survive a tab switch. Threads
 * load the first time the tab is shown for a video.
 */
@Component({
  selector: 'app-ask-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, AiModelSelectComponent],
  templateUrl: './ask-panel.component.html',
  styleUrls: ['./ask-panel.component.scss'],
})
export class AskPanelComponent implements OnChanges, OnDestroy {
  private readonly chat = inject(VideoChatService);
  private readonly websocket = inject(WebsocketService);
  readonly readiness = inject(CrucibleReadinessService);
  private readonly modelOptions = inject(AiModelOptionsService);
  private readonly presets = inject(PipelinePresetsService);

  @Input() videoId?: string;
  /** The Ask tab is showing: threads load on the first showing for a video. */
  @Input() active = false;
  /** The player has a transcript for this video (Ask reads it). */
  @Input() hasTranscript = true;

  @Output() seek = new EventEmitter<number>();
  /** The current thread's proposed markers, for the timeline's ghost lane ([] when hidden). */
  @Output() proposalsChange = new EventEmitter<ChatMarker[]>();
  /** Proposals became custom markers: the player reloads its markers. */
  @Output() markersApplied = new EventEmitter<void>();

  @ViewChild('messageList') private messageList?: ElementRef<HTMLElement>;

  readonly threads = signal<ChatThread[]>([]);
  readonly threadsState = signal<'idle' | 'loading' | 'error'>('idle');
  readonly threadsError = signal('');
  /** The open thread; null is a new chat (its thread is made on the first send). */
  readonly currentThreadId = signal<string | null>(null);
  readonly messages = signal<ChatMessage[]>([]);
  readonly threadLoading = signal(false);
  readonly threadError = signal('');

  readonly draft = signal('');
  readonly pending = signal<PendingSend | null>(null);
  /** The last send's failure, shown at the end of the thread it was for. */
  readonly sendError = signal<{ threadId: string | null; message: string } | null>(null);
  /** A marker or thread action's failure (apply, dismiss, delete), shown above the composer. */
  readonly actionError = signal('');

  /** The model picked for this chat ('' = the default below). */
  readonly modelChoice = signal('');
  readonly modelValue = computed(() =>
    this.modelChoice() || this.presets.lastChosenAiModel() || this.modelOptions.view()?.analysisDefault || '');

  readonly showOnTimeline = signal(readShowOnTimeline());
  readonly applyForm = signal<ApplyForm | null>(null);
  readonly setName = signal('');
  readonly applying = signal(false);
  readonly busyMarkerIds = signal<ReadonlySet<string>>(new Set());
  readonly confirmingDelete = signal(false);

  readonly currentThread = computed(() => this.threads().find(t => t.id === this.currentThreadId()) ?? null);
  readonly proposals = computed(() =>
    this.messages().flatMap(m => m.markers ?? []).filter(k => k.status === 'proposed'));

  /** The pending send belongs to the open thread (or to the new chat being written). */
  readonly pendingHere = computed(() => {
    const p = this.pending();
    return !!p && p.videoId === this.videoId && p.threadId === this.currentThreadId();
  });
  readonly statusLine = computed(() => chatPhaseLabel(this.pending()?.phase ?? null));
  readonly sendErrorHere = computed(() => {
    const e = this.sendError();
    return e && e.threadId === this.currentThreadId() ? e.message : '';
  });

  readonly canSend = computed(() =>
    this.readiness.ready() && !this.pending() && !!this.videoId && !!this.modelValue() && this.draft().trim().length > 0);

  readonly formatRange = formatChatRange;

  private loadedFor: string | null = null;
  private seq = 0;
  private readonly offStatus: () => void;

  constructor() {
    this.offStatus = this.websocket.onVideoChatStatus(event => {
      const p = this.pending();
      if (p && p.threadId === event.threadId) this.pending.set({ ...p, phase: event.phase });
    });
    effect(() => {
      const shown = this.showOnTimeline() ? this.proposals() : [];
      untracked(() => this.proposalsChange.emit(shown));
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['videoId'] && this.videoId !== this.loadedFor) this.reset();
    if ((changes['active'] || changes['videoId']) && this.active && this.videoId && this.loadedFor !== this.videoId) {
      void this.loadThreads(true);
    }
  }

  ngOnDestroy(): void {
    this.offStatus();
    this.proposalsChange.emit([]);
  }

  private reset(): void {
    this.seq++;
    this.loadedFor = null;
    this.threads.set([]);
    this.threadsState.set('idle');
    this.currentThreadId.set(null);
    this.messages.set([]);
    this.threadError.set('');
    this.sendError.set(null);
    this.actionError.set('');
    this.applyForm.set(null);
    this.confirmingDelete.set(false);
    this.modelChoice.set('');
  }

  /** Read the video's threads; `openLatest` opens the newest (or a new chat when there is none). */
  async loadThreads(openLatest: boolean): Promise<void> {
    const videoId = this.videoId;
    if (!videoId) return;
    const seq = this.seq;
    this.loadedFor = videoId;
    if (openLatest) this.threadsState.set('loading');
    try {
      const threads = await firstValueFrom(this.chat.listThreads(videoId));
      if (seq !== this.seq) return;
      this.threads.set(threads ?? []);
      this.threadsState.set('idle');
      if (openLatest) {
        const latest = this.threads()[0];
        if (latest) await this.openThread(latest.id);
        else this.newChat();
      }
    } catch (error) {
      if (seq !== this.seq) return;
      if (openLatest) {
        this.loadedFor = null; // try again on the next showing
        this.threadsState.set('error');
        this.threadsError.set(chatErrorMessage(error));
      }
    }
  }

  retryThreads(): void {
    void this.loadThreads(true);
  }

  async openThread(threadId: string): Promise<void> {
    const seq = ++this.seq;
    this.currentThreadId.set(threadId);
    this.applyForm.set(null);
    this.confirmingDelete.set(false);
    this.actionError.set('');
    this.threadError.set('');
    this.messages.set([]);
    this.modelChoice.set(this.threads().find(t => t.id === threadId)?.model ?? '');
    this.threadLoading.set(true);
    try {
      const detail = await firstValueFrom(this.chat.getThread(threadId));
      if (seq !== this.seq) return;
      this.messages.set(detail.messages ?? []);
      if (detail.thread) {
        this.threads.update(list => list.map(t => (t.id === threadId ? detail.thread : t)));
        if (detail.thread.model && !this.modelChoice()) this.modelChoice.set(detail.thread.model);
      }
      this.scrollToBottom();
    } catch (error) {
      if (seq !== this.seq) return;
      this.threadError.set(chatErrorMessage(error));
    } finally {
      if (seq === this.seq) this.threadLoading.set(false);
    }
  }

  onThreadPick(value: string): void {
    if (value) void this.openThread(value);
    else this.newChat();
  }

  /** A new chat: its thread is made on the first send, so an unused one leaves nothing behind. */
  newChat(): void {
    this.seq++;
    this.currentThreadId.set(null);
    this.messages.set([]);
    this.threadLoading.set(false);
    this.threadError.set('');
    this.applyForm.set(null);
    this.confirmingDelete.set(false);
    this.actionError.set('');
    this.modelChoice.set('');
  }

  async deleteThread(): Promise<void> {
    const threadId = this.currentThreadId();
    this.confirmingDelete.set(false);
    if (!threadId) return;
    try {
      await firstValueFrom(this.chat.deleteThread(threadId));
      this.threads.update(list => list.filter(t => t.id !== threadId));
      if (this.currentThreadId() !== threadId) return;
      const next = this.threads()[0];
      if (next) await this.openThread(next.id);
      else this.newChat();
    } catch (error) {
      this.actionError.set(`Couldn't delete the chat: ${chatErrorMessage(error)}`);
    }
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    }
  }

  async send(): Promise<void> {
    const content = this.draft().trim();
    const videoId = this.videoId;
    if (!content || !videoId || this.pending()) return;
    if (!this.readiness.requireReady()) return;
    const model = this.modelValue();
    if (!model) {
      this.sendError.set({ threadId: this.currentThreadId(), message: 'Pick a model to ask with.' });
      return;
    }

    let threadId = this.currentThreadId();
    this.pending.set({ videoId, threadId, content, phase: null });
    this.sendError.set(null);
    this.draft.set('');
    this.scrollToBottom();
    try {
      if (!threadId) {
        const thread = await firstValueFrom(this.chat.createThread(videoId, model));
        if (this.videoId !== videoId) return;
        threadId = thread.id;
        this.threads.update(list => [thread, ...list.filter(t => t.id !== thread.id)]);
        if (this.currentThreadId() === null) {
          this.currentThreadId.set(thread.id);
          this.modelChoice.set(thread.model ?? model);
        }
        const p = this.pending();
        if (p) this.pending.set({ ...p, threadId });
      }

      const result = await firstValueFrom(this.chat.sendMessage(threadId, content, model));
      if (this.videoId !== videoId) return;
      if (this.currentThreadId() === threadId) {
        this.messages.update(list => [...list, result.userMessage, result.assistantMessage]);
        this.scrollToBottom();
      }
      void this.loadThreads(false); // the title and order may have changed
    } catch (error) {
      if (this.videoId !== videoId) return;
      this.readiness.handleRefusal(error);
      this.sendError.set({ threadId, message: chatErrorMessage(error) });
      // Show what the backend kept; give the question back unless it was saved.
      let saved = false;
      if (threadId && this.currentThreadId() === threadId) {
        try {
          const detail = await firstValueFrom(this.chat.getThread(threadId));
          if (this.currentThreadId() === threadId) {
            this.messages.set(detail.messages ?? []);
            const last = detail.messages?.[detail.messages.length - 1];
            saved = last?.role === 'user' && last.content.trim() === content;
          }
        } catch {
          // The thread as shown stands.
        }
      }
      if (!saved && !this.draft()) this.draft.set(content);
    } finally {
      const p = this.pending();
      if (p && p.content === content && p.videoId === videoId) this.pending.set(null);
      this.scrollToBottom();
    }
  }

  // ---- markers -------------------------------------------------------------

  onChipClick(marker: ChatMarker): void {
    this.seek.emit(marker.startSeconds);
  }

  markersOf(message: ChatMessage): ChatMarker[] {
    return message.markers ?? [];
  }

  proposedOf(message: ChatMessage): ChatMarker[] {
    return (message.markers ?? []).filter(k => k.status === 'proposed');
  }

  isBusy(marker: ChatMarker): boolean {
    return this.busyMarkerIds().has(marker.id);
  }

  markerTitle(marker: ChatMarker): string {
    const range = formatChatRange(marker.startSeconds, marker.endSeconds);
    return marker.note ? `${marker.title} (${range}): ${marker.note}` : `${marker.title} (${range})`;
  }

  setShowOnTimeline(on: boolean): void {
    this.showOnTimeline.set(on);
    try {
      localStorage.setItem(SHOW_ON_TIMELINE_KEY, String(on));
    } catch {
      // A convenience; the toggle works without it.
    }
  }

  openApply(key: string, markerIds: string[]): void {
    if (!markerIds.length) return;
    this.actionError.set('');
    this.applyForm.set({ key, markerIds });
    this.setName.set(this.currentThread()?.title?.trim() || 'Ask');
  }

  openApplyThread(): void {
    this.openApply('thread', this.proposals().map(k => k.id));
  }

  openApplyMessage(message: ChatMessage): void {
    this.openApply(`message:${message.id}`, this.proposedOf(message).map(k => k.id));
  }

  cancelApply(): void {
    this.applyForm.set(null);
  }

  isApplyOpen(key: string): boolean {
    return this.applyForm()?.key === key;
  }

  async confirmApply(): Promise<void> {
    const form = this.applyForm();
    const threadId = this.currentThreadId();
    const setName = this.setName().trim();
    if (!form || !threadId || !setName || this.applying()) return;
    this.applying.set(true);
    this.markBusy(form.markerIds, true);
    try {
      const result = await firstValueFrom(this.chat.applyMarkers(threadId, form.markerIds, setName));
      this.mergeMarkers(result.markers ?? []);
      this.applyForm.set(null);
      this.markersApplied.emit();
    } catch (error) {
      this.actionError.set(`Couldn't apply the markers: ${chatErrorMessage(error)}`);
    } finally {
      this.applying.set(false);
      this.markBusy(form.markerIds, false);
    }
  }

  dismiss(marker: ChatMarker): Promise<void> {
    return this.setStatus(marker, 'dismissed');
  }

  undoDismiss(marker: ChatMarker): Promise<void> {
    return this.setStatus(marker, 'proposed');
  }

  private async setStatus(marker: ChatMarker, status: 'dismissed' | 'proposed'): Promise<void> {
    if (this.isBusy(marker)) return;
    this.markBusy([marker.id], true);
    this.actionError.set('');
    try {
      const updated = await firstValueFrom(this.chat.setMarkerStatus(marker.id, status));
      this.mergeMarkers([updated]);
    } catch (error) {
      this.actionError.set(`Couldn't ${status === 'dismissed' ? 'dismiss' : 'restore'} "${marker.title}": ${chatErrorMessage(error)}`);
    } finally {
      this.markBusy([marker.id], false);
    }
  }

  private mergeMarkers(updated: ChatMarker[]): void {
    if (!updated.length) return;
    const byId = new Map(updated.map(k => [k.id, k]));
    this.messages.update(list => list.map(m =>
      (m.markers ?? []).some(k => byId.has(k.id))
        ? { ...m, markers: m.markers.map(k => byId.get(k.id) ?? k) }
        : m));
  }

  private markBusy(ids: string[], busy: boolean): void {
    const next = new Set(this.busyMarkerIds());
    for (const id of ids) {
      if (busy) next.add(id);
      else next.delete(id);
    }
    this.busyMarkerIds.set(next);
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      const el = this.messageList?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
}
