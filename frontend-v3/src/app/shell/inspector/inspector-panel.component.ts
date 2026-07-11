import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { CdkOverlayOrigin, OverlayModule } from '@angular/cdk/overlay';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer } from 'rxjs';
import { ConnectionsStore } from '../../core/stores/connections.store';
import { InspectorStore } from '../../core/stores/inspector.store';
import { PIPELINE_STEPS, PipelineStep, PipelineStepType } from '../../core/stores/pipeline-presets.service';
import { QueueSelectionStore } from '../../core/stores/queue-selection.store';
import { SelectionStore } from '../../core/stores/selection.store';
import { WorkspaceAction, WorkspaceActionsService } from '../../core/stores/workspace-actions.service';
import { formatBytes, formatDate } from '../../core/format';
import { QueueJob } from '../../models/queue-job.model';
import { AiSetupService } from '../../services/ai-setup.service';
import { QueueService } from '../../services/queue.service';
import { VideoTab } from '../../services/tabs.service';
import { UiButtonComponent, UiTimecodeInputComponent } from '../../ui';
import { getApiBase } from '../../core/runtime-url';
import { InspectorPreviewComponent } from './inspector-preview.component';
import { ProcessConfigComponent } from './process-config/process-config.component';

/** Task types the per-job Process panel owns (everything else is preserved). */
const PIPELINE_TASK_TYPES = new Set<PipelineStepType>(PIPELINE_STEPS.map(s => s.type));

/** Per-section disclosure state, persisted like the shell's other UI flags. */
const PROCESS_OPEN_KEY = 'briefcase-inspector-process-open';
const INFO_OPEN_KEY = 'briefcase-inspector-info-open';
const PENDING_OPEN_KEY = 'briefcase-inspector-pending-open';

/**
 * Right inspector panel — details, pipeline status, connections, and actions
 * for the current selection.
 *
 * Dumb projection over InspectorStore/SelectionStore/ConnectionsStore; every
 * workspace action dispatches through the WorkspaceActions channel to the
 * persistent workspace host, which owns the real handlers. Transcript preview
 * and connections are fetched lazily by their stores (only while this panel
 * is open).
 */
@Component({
  selector: 'app-inspector-panel',
  standalone: true,
  imports: [
    OverlayModule,
    UiButtonComponent,
    UiTimecodeInputComponent,
    ProcessConfigComponent,
    InspectorPreviewComponent,
  ],
  templateUrl: './inspector-panel.component.html',
  styleUrls: ['./inspector-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InspectorPanelComponent {
  store = inject(InspectorStore);
  selection = inject(SelectionStore);
  queueSelection = inject(QueueSelectionStore);
  connectionsStore = inject(ConnectionsStore);
  private queueService = inject(QueueService);
  private actions = inject(WorkspaceActionsService);
  private aiSetup = inject(AiSetupService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  /** Whether an AI provider is configured (Analyze affordances). */
  aiReady = input(false);
  /** AI readiness unknown — the availability probe failed. */
  aiCheckFailed = input(false);
  /** Collections ("tabs") for the Add to Collection menu. */
  collections = input<VideoTab[]>([]);

  collectionsMenuOpen = signal(false);

  /**
   * The "Add to Collection…" trigger — queried instead of a template ref
   * because it lives inside @if branches (single vs multi selection), whose
   * template reference variables aren't visible at the template top level.
   */
  collectionsTrigger = viewChild(CdkOverlayOrigin);

  /** Brief highlight after a toolbar ⚡ Process reveal. */
  configFlash = signal(false);

  /**
   * Final Cut-style disclosure sections. Process (the pipeline config) and Info
   * (everything about the selection) are stacked in one scroll column and can
   * both be open at once. Each section defaults to expanded; the user's collapse
   * choice is remembered for the session (persisted like the shell's other
   * UI-state flags) and is never reset by a selection change.
   */
  processOpen = signal(localStorage.getItem(PROCESS_OPEN_KEY) !== 'false');
  infoOpen = signal(localStorage.getItem(INFO_OPEN_KEY) !== 'false');
  pendingOpen = signal(localStorage.getItem(PENDING_OPEN_KEY) !== 'false');

  /** The Process section wrapper — scrolled into view on a ⚡ Process reveal. */
  private processSection = viewChild<ElementRef<HTMLElement>>('processSection');

  // ── Queue-page per-job config (pending jobs selected in the queue cascade) ──

  /** The selected pending jobs, resolved live from the queue. */
  selectedPendingJobs = computed<QueueJob[]>(() => {
    const ids = this.queueSelection.selectedJobIds();
    if (ids.size === 0) return [];
    return this.queueService.pendingJobs().filter(j => ids.has(j.id));
  });

  /** Multi-select seeds from the first selected job (identity-stable). */
  private firstPendingJob = computed<QueueJob | null>(() => this.selectedPendingJobs()[0] ?? null);

  /**
   * The first job's pipeline as PipelineSteps (config = a copy of task.options),
   * skipping non-pipeline task types (download-import, export-clip, …) — those
   * are preserved separately by the save handler. Feeds process-config's
   * per-job mode. Empty array (not null) so process-config seeds "all off"
   * rather than falling back to compose mode.
   */
  pendingInitialSteps = computed<PipelineStep[]>(() => {
    const job = this.firstPendingJob();
    if (!job) return [];
    return job.tasks
      .filter(t => PIPELINE_TASK_TYPES.has(t.type as PipelineStepType))
      .map(t => ({ type: t.type as PipelineStepType, config: { ...t.options } }));
  });

  /** Trim block state (seconds cut from each end), seeded from the first job. */
  queueTrimStart = signal<number | null>(null);
  queueTrimEnd = signal<number | null>(null);
  private queueTrimStartInvalid = signal(false);
  private queueTrimEndInvalid = signal(false);
  queueTrimInvalid = computed(() => this.queueTrimStartInvalid() || this.queueTrimEndInvalid());

  constructor() {
    // Seed the trim block from the first selected pending job. Re-runs only when
    // that job's identity changes (selection move, or that job was saved), so it
    // never clobbers an in-progress trim edit of the currently-selected job. The
    // written signals aren't read here, so there's no self-retrigger.
    effect(() => {
      const job = this.firstPendingJob();
      this.queueTrimStart.set(job?.trimStartTime ?? null);
      this.queueTrimEnd.set(job?.trimEndTime ?? null);
      this.queueTrimStartInvalid.set(false);
      this.queueTrimEndInvalid.set(false);
    }, { allowSignalWrites: true });

    // The toolbar's ⚡ Process button bumps a counter; expand the Process
    // section (if collapsed), scroll it to the top of the column, and flash
    // its config ring. Setting a signal here doesn't subscribe the effect, so
    // toggling processOpen elsewhere never re-triggers a flash.
    let firstReveal = true;
    effect(() => {
      this.actions.processConfigRevealRequested();
      if (firstReveal) {
        firstReveal = false;
        return;
      }
      this.processOpen.set(true);
      localStorage.setItem(PROCESS_OPEN_KEY, 'true');
      this.configFlash.set(true);
      // The section body is always mounted (display:none when collapsed), so a
      // microtask is enough for it to lay out before we scroll it into view.
      timer(0)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() =>
          this.processSection()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
        );
      timer(1200)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.configFlash.set(false));
    }, { allowSignalWrites: true });
  }

  /** Toggle the Process disclosure section (persisted for the session). */
  toggleProcess(): void {
    this.processOpen.update(v => !v);
    localStorage.setItem(PROCESS_OPEN_KEY, String(this.processOpen()));
  }

  /** Toggle the Info disclosure section (persisted for the session). */
  toggleInfo(): void {
    this.infoOpen.update(v => !v);
    localStorage.setItem(INFO_OPEN_KEY, String(this.infoOpen()));
  }

  /** Toggle the Pending (queue per-job config) section (persisted). */
  togglePending(): void {
    this.pendingOpen.update(v => !v);
    localStorage.setItem(PENDING_OPEN_KEY, String(this.pendingOpen()));
  }

  setTrimStartInvalid(invalid: boolean): void {
    this.queueTrimStartInvalid.set(invalid);
  }

  setTrimEndInvalid(invalid: boolean): void {
    this.queueTrimEndInvalid.set(invalid);
  }

  /**
   * Save the edited pipeline + trim onto every selected pending job (no submit).
   * The workspace host rewrites each job's tasks (preserving non-pipeline tasks)
   * and applies the trim, then reports how many actually updated.
   */
  onSavePendingSteps(steps: PipelineStep[]): void {
    const jobIds = [...this.queueSelection.selectedJobIds()];
    if (jobIds.length === 0) return;
    this.dispatch({
      type: 'updatePendingJobs',
      jobIds,
      steps,
      trimStartSeconds: this.queueTrimStart(),
      trimEndSeconds: this.queueTrimEnd(),
    });
  }

  /**
   * Normalize a stored duration string ("m:ss" / "h:mm:ss") to HH:MM:SS with
   * leading zeros (project convention). Returns "—" when absent.
   */
  formatDuration(raw: string | undefined): string {
    if (!raw) return '—';
    const parts = raw.split(':').map(p => p.trim());
    if (parts.some(p => p === '' || Number.isNaN(Number(p)))) return raw;
    while (parts.length < 3) parts.unshift('0');
    const [h, m, s] = parts.slice(-3);
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
  }

  item = this.store.singleItem;
  kind = this.store.singleItemKind;

  kindIcon = computed(() => {
    switch (this.kind()) {
      case 'web': return '🌐';
      case 'doc': return '📄';
      default: return null; // videos show a thumbnail
    }
  });

  /**
   * Playable stream for the in-inspector preview — the same endpoint as the
   * poster thumbnail, minus the `poster=1` flag (Scout builds it identically).
   * Empty while nothing single is selected; the preview only renders when a
   * single item with a thumbnail is showing, so it always has an id in practice.
   */
  previewUrl = computed(() => {
    const item = this.item();
    return item ? `${getApiBase()}/database/videos/${item.id}/stream` : '';
  });

  resolution = computed(() => {
    const item = this.item();
    if (!item?.width || !item?.height) return null;
    return `${item.width}×${item.height}${item.fps ? ` · ${Math.round(item.fps)}fps` : ''}`;
  });

  addedDate = computed(() => {
    const item = this.item();
    return formatDate(item?.addedAt ?? item?.downloadDate ?? item?.uploadDate);
  });

  size = computed(() => formatBytes(this.item()?.size));

  /** Transcript belongs to the currently selected item only. */
  transcript = computed(() => {
    const transcript = this.store.transcript();
    const item = this.item();
    return transcript && item && transcript.videoId === item.id ? transcript : null;
  });

  /** Whether timestamped rendering is even possible for this transcript. */
  hasTimestamps = computed(() => (this.transcript()?.segments?.length ?? 0) > 0);

  /** Timestamps default OFF — clean flowing text. */
  showTimestamps = signal(false);

  /** Brief "Copied ✓" confirmation state. */
  copied = signal(false);

  copyTranscript(): void {
    const transcript = this.transcript();
    if (!transcript) return;
    const text =
      this.showTimestamps() && transcript.segments
        ? transcript.segments.map(s => `[${s.start}] ${s.text}`).join('\n')
        : transcript.plainText;
    navigator.clipboard.writeText(text).then(() => {
      this.copied.set(true);
      timer(1500)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.copied.set(false));
    });
  }

  /** Exactly two items selected — the "Connect these two" case. */
  isPair = computed(() => this.store.selectedItems().length === 2);

  kindLabelFor(kind: string): string {
    switch (kind) {
      case 'web': return 'Web Archive';
      case 'doc': return 'Document';
      default: return 'Video';
    }
  }

  /** Open a connected item in Scout (the workspace resolves the id → item). */
  openConnected(videoId: string): void {
    this.dispatch({ type: 'openEditor', videoId });
  }

  /** Reveal a connected item in the library (scroll + highlight). */
  locateConnected(videoId: string): void {
    this.dispatch({ type: 'locateVideo', videoId });
  }

  dispatch(action: WorkspaceAction): void {
    this.actions.dispatch(action);
  }

  /** Queue the composed pipeline for the selection (same channel as before). */
  onProcessSteps(steps: PipelineStep[]): void {
    this.dispatch({ type: 'processSelection', steps });
  }

  /** Re-run the AI availability probe (config's "AI check failed — retry"). */
  onRetryAi(): void {
    void this.aiSetup.checkAIAvailability();
  }

  /** No transcription models installed — take the user to Settings → Components. */
  onOpenComponents(): void {
    this.router.navigate(['/settings/components']);
  }

  addToCollection(tabId: string): void {
    this.collectionsMenuOpen.set(false);
    this.dispatch({ type: 'addSelectionToTab', tabId });
  }

  addToNewCollection(): void {
    this.collectionsMenuOpen.set(false);
    this.dispatch({ type: 'createTabWithSelection' });
  }
}
