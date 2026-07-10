import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { OverlayModule } from '@angular/cdk/overlay';
import { AddDownloadsPayload } from '../../core/stores/workspace-actions.service';
import { AddPopoverComponent } from './add-popover/add-popover.component';

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
  imports: [OverlayModule, AddPopoverComponent],
  templateUrl: './toolbar-actions.component.html',
  styleUrls: ['./toolbar-actions.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToolbarActionsComponent {
  hasSelection = input(false);
  singleSelection = input(false);
  selectionCount = input(0);
  aiReady = input(false);

  submitAdd = output<AddDownloadsPayload>();
  importFiles = output<void>();
  openAdvanced = output<void>();
  setupAi = output<void>();
  transcribe = output<void>();
  analyze = output<void>();
  openEditor = output<void>();
  viewInfo = output<void>();
  addToQueue = output<void>();

  addOpen = signal(false);

  toggleAdd(): void {
    this.addOpen.update(open => !open);
  }

  closeAdd(): void {
    this.addOpen.set(false);
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
