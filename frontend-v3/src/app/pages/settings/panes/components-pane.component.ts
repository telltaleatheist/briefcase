import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComponentService, ComponentStatus } from '../../../services/component.service';
import { ErrorSurface } from '../../../core/error-surface.service';
import { SetupDownloadService } from '../../../services/setup-download.service';
import { SetupWizardComponent } from '../../../components/setup-wizard/setup-wizard.component';
import { UiButtonComponent } from '../../../ui';

/**
 * Settings → Components: the download-on-demand tools (ffmpeg, yt-dlp). AI
 * models and transcription live on the Crucible server (P7). The paginated
 * wizard stays available as a guided installer. Downloads run through
 * SetupDownloadService and show in the download dock.
 */
@Component({
  selector: 'app-components-pane',
  standalone: true,
  imports: [SetupWizardComponent, UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  templateUrl: './components-pane.component.html'
})
export class ComponentsPaneComponent {
  private componentService = inject(ComponentService);
  private destroyRef = inject(DestroyRef);
  private errorSurface = inject(ErrorSurface);
  dl = inject(SetupDownloadService);

  all = signal<ComponentStatus[]>([]);
  wizardOpen = signal(false);

  tools = computed(() => this.all().filter(c => c.kind === 'binary' && c.supported));

  constructor() {
    this.reload();
  }

  private reload(): void {
    this.componentService.listComponents()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(components => this.all.set(components));
  }

  statusOf(id: string): string {
    return this.dl.statusOf(id);
  }

  pctOf(id: string): number {
    return this.dl.pctOf(id);
  }

  isBusy(component: ComponentStatus): boolean {
    const status = this.dl.statusOf(component.id);
    return status === 'queued' || status === 'downloading';
  }

  download(component: ComponentStatus): void {
    if (component.installed || this.isBusy(component)) return;
    const ids = [component.id];
    this.dl.select(ids);
    this.dl.enqueue(ids);
  }

  /** Id of the component awaiting removal confirmation (two-click remove). */
  confirmingRemoveId = signal<string | null>(null);
  removingId = signal<string | null>(null);

  canRemove(component: ComponentStatus): boolean {
    return component.installed && !component.required && this.removingId() === null;
  }

  remove(component: ComponentStatus): void {
    if (!this.canRemove(component)) return;
    if (this.confirmingRemoveId() !== component.id) {
      // First click arms the confirmation; the button relabels to "Confirm".
      this.confirmingRemoveId.set(component.id);
      return;
    }
    this.confirmingRemoveId.set(null);
    this.removingId.set(component.id);
    this.componentService.removeComponent(component.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.removingId.set(null);
          this.reload();
        },
        error: error => {
          // Keep the item visible; tell the user the removal failed
          // (this code originally reset silently — fallback-audit #17).
          this.removingId.set(null);
          this.errorSurface.surfaceError("Couldn't remove the component", error);
        },
      });
  }

  cancelRemove(): void {
    this.confirmingRemoveId.set(null);
  }

  openWizard(): void {
    this.wizardOpen.set(true);
  }

  closeWizard(): void {
    this.wizardOpen.set(false);
    this.reload();
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
}
