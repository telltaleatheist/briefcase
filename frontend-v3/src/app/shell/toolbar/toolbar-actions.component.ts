import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { AddDownloadsPayload, WorkspaceActionsService } from '../../core/stores/workspace-actions.service';
import { PipelineStep } from '../../core/stores/pipeline-presets.service';
import { AddPopoverComponent } from './add-popover/add-popover.component';
import { ProcessPopoverComponent } from './process-popover/process-popover.component';

/**
 * Contextual toolbar actions (projected into the shell toolbar's slot):
 * "+ Add" (always available; opens the one-shot Add popover) and the
 * selection actions — Transcribe / Analyze / Open in Scout / Info / Queue —
 * which enable only when the workspace has a selection.
 *
 * Dumb component: state in via inputs, intents out via outputs; the shell
 * dispatches them over the WorkspaceActionsService channel.
 */
@Component({
  selector: 'app-toolbar-actions',
  standalone: true,
  imports: [OverlayModule, AddPopoverComponent, ProcessPopoverComponent],
  templateUrl: './toolbar-actions.component.html',
  styleUrls: ['./toolbar-actions.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToolbarActionsComponent {
  private workspaceActions = inject(WorkspaceActionsService);

  hasSelection = input(false);
  singleSelection = input(false);
  selectionCount = input(0);
  aiReady = input(false);
  /** AI readiness unknown — the availability probe failed (retry, don't lie). */
  aiCheckFailed = input(false);
  /** Already-done counts for the Process popover's per-step hints. */
  withoutTranscript = input(0);
  notAnalyzed = input(0);

  submitAdd = output<AddDownloadsPayload>();
  importFiles = output<void>();
  openAdvanced = output<void>();
  setupAi = output<void>();
  retryAiCheck = output<void>();
  openEditor = output<void>();
  viewInfo = output<void>();
  processSteps = output<PipelineStep[]>();

  addOpen = signal(false);
  processOpen = signal(false);

  constructor() {
    // The inspector's "Process…" button opens this popover (single instance,
    // anchored at the toolbar). Skip the initial value; react to bumps only.
    let initialRequest = true;
    effect(() => {
      this.workspaceActions.processPopoverRequested();
      if (initialRequest) {
        initialRequest = false;
        return;
      }
      if (this.hasSelection()) {
        this.processOpen.set(true);
      }
    }, { allowSignalWrites: true });
  }

  toggleAdd(): void {
    this.addOpen.update(open => !open);
  }

  closeAdd(): void {
    this.addOpen.set(false);
  }

  toggleProcess(): void {
    this.processOpen.update(open => !open);
  }

  closeProcess(): void {
    this.processOpen.set(false);
  }

  onSubmitProcess(steps: PipelineStep[]): void {
    this.closeProcess();
    this.processSteps.emit(steps);
  }

  onProcessSetupAi(): void {
    this.closeProcess();
    this.setupAi.emit();
  }

  onSubmitAdd(payload: AddDownloadsPayload): void {
    this.closeAdd();
    this.submitAdd.emit(payload);
  }

  onImportFiles(): void {
    this.closeAdd();
    this.importFiles.emit();
  }

  onOpenAdvanced(): void {
    this.closeAdd();
    this.openAdvanced.emit();
  }

  onSetupAi(): void {
    this.closeAdd();
    this.setupAi.emit();
  }
}
