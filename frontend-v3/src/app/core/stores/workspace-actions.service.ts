import { Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { VideoJobSettings } from '../../models/video-processing.model';
import { PipelineStep } from './pipeline-presets.service';

/** One-shot download request from the shell's Add popover. */
export interface AddDownloadsPayload {
  items: { url: string; name: string; settings: VideoJobSettings }[];
  /** Open the trim-opener for the added job(s) once queued. */
  trimAfter?: boolean;
}

/**
 * Actions the shell toolbar can ask the workspace (library-page) to perform.
 * The workspace owns the handlers/modals; the shell just dispatches.
 */
export type WorkspaceAction =
  | { type: 'import' }
  | { type: 'openDownloadDialog' } // legacy full config dialog ("Advanced…")
  | { type: 'submitDownloads'; payload: AddDownloadsPayload }
  | { type: 'openEditor' }
  | { type: 'viewInfo' }
  | { type: 'transcribeSelection' }
  | { type: 'analyzeSelection' }
  // Queue the chosen pipeline steps, in order, for every selected video
  | { type: 'processSelection'; steps: PipelineStep[] }
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
   * Shell-internal coordination: the inspector's "Process…" button asks the
   * toolbar to open its Process popover (single popover instance, anchored to
   * the toolbar's Process button). Counter signal; toolbar reacts to bumps.
   */
  readonly processPopoverRequested = signal(0);

  requestProcessPopover(): void {
    this.processPopoverRequested.update(n => n + 1);
  }
}
