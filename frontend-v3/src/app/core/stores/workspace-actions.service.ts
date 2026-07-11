import { Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { DownloadQuality } from './add-defaults.service';
import { PipelineStep } from './pipeline-presets.service';

/** One-shot download request from the shell's Add popover. */
export interface AddDownloadsPayload {
  items: {
    url: string;
    name: string;
    /** Download height cap; 'best'/absent keeps the per-site default format. */
    quality: DownloadQuality;
    /** Fully-composed pipeline steps from the Add popover's embedded
     *  process-config (fix-aspect / normalize / transcribe / ai-analyze), in
     *  canonical run order. Carries EVERY option — translate, granularity,
     *  stripBlackBars, customInstructions, aiModel — that the old settings bag
     *  silently dropped. The download-import task is injected downstream. */
    steps: PipelineStep[];
    /** Seconds to remove from the START after download (0/undefined = none).
     *  Applied per-batch by the popover; set on QueueJob.trimStartTime at
     *  job creation and dispatched as an export-clip cut post-download. */
    trimStartSeconds?: number;
    /** Seconds to remove from the END after download — a duration cut off the
     *  tail (NOT an absolute timestamp), resolved against the file's real
     *  duration by the backend. Maps to QueueJob.trimEndTime → trimEndSeconds. */
    trimEndSeconds?: number;
  }[];
}

/**
 * Actions the shell toolbar can ask the workspace (library-page) to perform.
 * The workspace owns the handlers/modals; the shell just dispatches.
 */
export type WorkspaceAction =
  | { type: 'import' }
  | { type: 'openDownloadDialog' } // legacy full config dialog ("Advanced…")
  | { type: 'submitDownloads'; payload: AddDownloadsPayload }
  // Open Scout. With no videoId, opens the current selection; with one, opens
  // that specific item (e.g. a connected item from the inspector).
  | { type: 'openEditor'; videoId?: string }
  // Reveal a specific item in the library cascade (scroll + highlight).
  | { type: 'locateVideo'; videoId: string }
  | { type: 'viewInfo' }
  | { type: 'transcribeSelection' }
  | { type: 'analyzeSelection' }
  // Queue the chosen pipeline steps, in order, for every selected video
  | { type: 'processSelection'; steps: PipelineStep[] }
  // Rewrite the pipeline steps + trim of already-staged (pending) jobs, in
  // place — the queue-page inspector's per-job config Save (no submit).
  | {
      type: 'updatePendingJobs';
      jobIds: string[];
      steps: PipelineStep[];
      trimStartSeconds: number | null;
      trimEndSeconds: number | null;
    }
  | { type: 'openAiSetup' }
  // Inspector: add the current selection to a collection ("tab")
  | { type: 'addSelectionToTab'; tabId: string }
  | { type: 'createTabWithSelection' };

/**
 * Shell → workspace action channel.
 *
 * The toolbar (shell) dispatches; the persistent LibraryPageComponent
 * subscribes (takeUntilDestroyed) and routes each action to its existing
 * handlers. Mirrors the libraryManagerRequested pattern from Phase 1 but
 * typed and multi-action.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceActionsService {
  private actionsSubject = new Subject<WorkspaceAction>();

  /** Stream of dispatched actions (consumed by the workspace host). */
  readonly actions$: Observable<WorkspaceAction> = this.actionsSubject.asObservable();

  dispatch(action: WorkspaceAction): void {
    this.actionsSubject.next(action);
  }

  /**
   * Shell-internal coordination: the toolbar's ⚡ Process button asks the
   * inspector to reveal its Process config section (scroll it into view and
   * briefly highlight it). Counter signal; the inspector reacts to bumps.
   */
  readonly processConfigRevealRequested = signal(0);

  revealProcessConfig(): void {
    this.processConfigRevealRequested.update(n => n + 1);
  }
}
