import { ChangeDetectionStrategy, Component, HostListener, input, output, signal } from '@angular/core';
import { AddDownloadsPayload } from '../../core/stores/workspace-actions.service';
import { AddPopoverComponent } from './add-popover/add-popover.component';

/**
 * Contextual toolbar actions (projected into the shell toolbar's slot):
 * "+ Add" (always available; opens the one-shot Add modal) and the
 * selection actions — Process / Scout / Info — which enable only when the
 * workspace has a selection.
 *
 * Process is no longer a popover: it reveals the inspector's Process config
 * section (the composer moved there). Dumb component: state in via inputs,
 * intents out via outputs; the shell dispatches them.
 */
@Component({
  selector: 'app-toolbar-actions',
  standalone: true,
  imports: [AddPopoverComponent],
  templateUrl: './toolbar-actions.component.html',
  styleUrls: ['./toolbar-actions.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ToolbarActionsComponent {
  hasSelection = input(false);
  singleSelection = input(false);
  selectionCount = input(0);
  aiReady = input(false);
  /** AI readiness UNKNOWN (probe failed) — the popover shows retry, not setup. */
  aiCheckFailed = input(false);

  submitAdd = output<AddDownloadsPayload>();
  importFiles = output<void>();
  openAdvanced = output<void>();
  setupAi = output<void>();
  /** Re-run the AI availability probe (Add popover's embedded config). */
  retryAi = output<void>();
  /** Open Settings → Components (Add popover's "install models" affordance). */
  openComponents = output<void>();
  openEditor = output<void>();
  viewInfo = output<void>();
  /** Reveal (and highlight) the inspector's Process config for the selection. */
  revealProcess = output<void>();

  addOpen = signal(false);

  toggleAdd(): void {
    this.addOpen.update(open => !open);
  }

  closeAdd(): void {
    this.addOpen.set(false);
  }

  // Close only on a click of the backdrop itself — not clicks that bubble up
  // from the modal content (which stops propagation anyway).
  onAddBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('add-modal-backdrop')) {
      this.closeAdd();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.addOpen()) {
      this.closeAdd();
    }
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

  // Retry re-runs the AI probe WITHOUT closing — the user stays in the popover
  // and watches the AI Analyze step become available once readiness resolves.
  onRetryAi(): void {
    this.retryAi.emit();
  }

  // Opening Components navigates away, so close the popover first.
  onOpenComponents(): void {
    this.closeAdd();
    this.openComponents.emit();
  }
}
