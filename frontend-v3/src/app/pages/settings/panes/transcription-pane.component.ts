import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { timer } from 'rxjs';
import { getApiBase } from '../../../core/runtime-url';
import { ErrorSurface } from '../../../core/error-surface.service';

type GpuMode = 'auto' | 'gpu' | 'cpu';

const GPU_MODE_DESCRIPTIONS: Record<GpuMode, string> = {
  auto: 'Tries GPU first, falls back to CPU if GPU fails',
  gpu: 'Always use GPU (faster, but may fail on some systems)',
  cpu: 'Always use CPU (slower, but more compatible)',
};

/**
 * Settings → Transcription: Whisper speech-to-text configuration.
 * Persists through the same backend endpoint the old settings page used.
 * Transcription never requires an AI provider.
 */
@Component({
  selector: 'app-transcription-pane',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  template: `
    <h2 class="pane-title">Transcription</h2>
    <p class="pane-lede">
      Whisper speech-to-text settings. Transcription runs entirely on this
      machine and works without any AI provider configured.
    </p>

    <div class="pane-section">
      <p class="section-label">GPU acceleration</p>
      <label class="field-label" for="gpu-mode">Processing mode</label>
      <select
        id="gpu-mode"
        class="select"
        [value]="gpuMode()"
        [disabled]="loading() || saving()"
        (change)="saveMode($event)">
        <option value="auto">Auto (recommended)</option>
        <option value="gpu">Always GPU</option>
        <option value="cpu">Always CPU</option>
      </select>
      @if (savedFlash()) {
        <span class="save-flash">✓ Saved</span>
      }
      <p class="hint">{{ modeDescription() }}</p>
      @if (gpuFailed()) {
        <div class="warn">⚠️ GPU transcription failed on this system. Auto mode will use CPU.</div>
      }
    </div>

    <div class="pane-section">
      <p class="section-label">Models</p>
      <p class="hint" style="margin-top: 0;">
        Whisper model downloads live in
        <a [routerLink]="['/settings/components']">Settings → Components</a>.
      </p>
    </div>
  `
})
export class TranscriptionPaneComponent {
  private http = inject(HttpClient);
  private destroyRef = inject(DestroyRef);
  private errorSurface = inject(ErrorSurface);
  private readonly apiBase = getApiBase();

  gpuMode = signal<GpuMode>('auto');
  gpuFailed = signal(false);
  loading = signal(true);
  saving = signal(false);
  savedFlash = signal(false);

  modeDescription = () => GPU_MODE_DESCRIPTIONS[this.gpuMode()];

  constructor() {
    this.http.get<{ mode?: GpuMode; gpuFailed?: boolean }>(`${this.apiBase}/media/whisper-gpu`)
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: data => {
          this.gpuMode.set(data.mode ?? 'auto');
          this.gpuFailed.set(data.gpuFailed ?? false);
          this.loading.set(false);
        },
        error: error => {
          this.loading.set(false);
          this.errorSurface.surfaceError("Couldn't load transcription settings", error);
        },
      });
  }

  saveMode(event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as GpuMode;
    this.saving.set(true);
    this.http.post<{ mode: GpuMode }>(`${this.apiBase}/media/whisper-gpu`, { mode })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: data => {
          this.gpuMode.set(data.mode);
          if (mode !== 'auto') this.gpuFailed.set(false);
          this.saving.set(false);
          this.flashSaved();
        },
        error: error => {
          this.saving.set(false);
          this.errorSurface.surfaceError("Transcription setting didn't save", error);
        },
      });
  }

  private flashSaved(): void {
    this.savedFlash.set(true);
    timer(1200).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.savedFlash.set(false));
  }
}
