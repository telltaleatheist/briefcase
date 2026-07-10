import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ComponentService, ComponentStatus } from '../../../services/component.service';
import { SetupDownloadService } from '../../../services/setup-download.service';
import { SetupWizardComponent } from '../../../components/setup-wizard/setup-wizard.component';
import { UiButtonComponent } from '../../../ui';

/**
 * Settings → Components: download-on-demand tools and models
 * (ffmpeg / yt-dlp / whisper models / local AI models), previously only
 * reachable through the "Models & Tools" wizard. The flat list here is the
 * primary surface; the paginated wizard stays available as a guided installer.
 * Downloads run through SetupDownloadService and show in the download dock.
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
  dl = inject(SetupDownloadService);

  all = signal<ComponentStatus[]>([]);
  wizardOpen = signal(false);

  tools = computed(() => this.all().filter(c => c.kind === 'binary' && c.supported));
  whisperModels = computed(() => this.all().filter(c => c.kind === 'whisper-model' && c.supported));
  llamaModels = computed(() => this.all().filter(c => c.kind === 'llama-model' && c.supported));

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
    // A local AI model needs the llama engine binary alongside it.
    if (component.kind === 'llama-model') {
      const llama = this.all().find(c => c.id === 'llama' && !c.installed);
      if (llama && !this.isBusy(llama)) ids.unshift('llama');
    }
    this.dl.select(ids);
    this.dl.enqueue(ids);
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
