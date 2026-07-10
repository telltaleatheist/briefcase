import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { VideoJobSettings } from '../../models/video-processing.model';

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
  | { type: 'addSelectionToQueue' }
  | { type: 'openAiSetup' };

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
}
