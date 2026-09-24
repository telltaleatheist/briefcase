import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient } from '@angular/common/http';
import { timer } from 'rxjs';
import { getApiBase } from '../../../core/runtime-url';
import { ErrorSurface } from '../../../core/error-surface.service';
import { UiButtonComponent } from '../../../ui';
import { CrucibleService, type CrucibleRefusal } from '../../../services/crucible.service';
import type {
  TranscriptionServerView,
  TranscriptionSettingWire,
  TranscriptionVenueChoiceWire,
  TranscriptionView,
} from '@crucible-wire/transcription-wire';

type GpuMode = 'auto' | 'gpu' | 'cpu';

const GPU_MODE_DESCRIPTIONS: Record<GpuMode, string> = {
  auto: 'Tries GPU first, falls back to CPU if GPU fails',
  gpu: 'Always use GPU (faster, but may fail on some systems)',
  cpu: 'Always use CPU (slower, but more compatible)',
};

/**
 * Settings → Transcription.
 *
 * Where transcription runs (P5): Crucible's `asr` job on a connected server
 * (mlx-whisper on the Mac, faster-whisper on the PC), or the offline
 * transcriber (whisper-cli) on this computer, which also stands in when
 * Crucible can't transcribe and does every translate-to-English task.
 * The offline transcriber's GPU mode stays here for those cases.
 * Transcription never requires an AI provider.
 */
@Component({
  selector: 'app-transcription-pane',
  standalone: true,
  imports: [RouterLink, FormsModule, UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  styles: [`
    .row-desc.wrap { white-space: normal; overflow: visible; }
    .route-card.fallback { border-color: var(--warning); }
    .field-gap { margin-top: 12px; }
  `],
  template: `
    <h2 class="pane-title">Transcription</h2>
    <p class="pane-lede">
      Speech-to-text for your videos. It runs on Crucible when a server offers
      it, or on this computer with the offline transcriber, and works without
      any AI provider configured.
    </p>

    <div class="pane-section">
      <p class="section-label">Where transcription runs</p>
      <label class="field-label" for="transcribe-venue">Transcriber</label>
      <select
        id="transcribe-venue"
        class="select"
        [ngModel]="venue()"
        [disabled]="!view() || savingVenue()"
        (ngModelChange)="onVenueChange($event)">
        <option value="auto">Automatic: Crucible when a server offers it, otherwise this computer</option>
        <option value="crucible">Through Crucible</option>
        <option value="whisper-cli">The offline transcriber on this computer (whisper)</option>
      </select>
      @if (venueSavedFlash()) {
        <span class="save-flash">Saved</span>
      }

      @if (venue() !== 'whisper-cli' && servers().length > 0) {
        <label class="field-label field-gap" for="transcribe-server">Server</label>
        <select
          id="transcribe-server"
          class="select"
          [ngModel]="serverChoice()"
          [disabled]="savingVenue()"
          (ngModelChange)="onServerChange($event)">
          <option value="">Best available server</option>
          @for (s of servers(); track s.name) {
            <option [value]="s.name">{{ s.name }}{{ serverNote(s) }}</option>
          }
        </select>

        @if (modelServer(); as target) {
          <label class="field-label field-gap" for="transcribe-model">Model on {{ target.name }}</label>
          <select
            id="transcribe-model"
            class="select"
            [ngModel]="modelChoice()"
            [disabled]="savingVenue() || target.models.length === 0"
            (ngModelChange)="onModelChange($event)">
            <option value="">{{ target.recommended ? 'Most accurate downloaded (' + target.recommended + ')' : 'Most accurate downloaded' }}</option>
            @for (m of target.models; track m.id) {
              <option [value]="m.id" [disabled]="!m.installed">{{ m.id }}{{ m.installed ? '' : ' (not downloaded)' }}</option>
            }
          </select>
          @if (target.betterNotInstalled; as better) {
            <p class="hint">{{ better }} is more accurate and can be downloaded on {{ target.name }} from Crucible's catalog.</p>
          }
        }
      }

      @if (view(); as v) {
        @if (v.route.kind === 'crucible') {
          <div class="row-card route-card field-gap">
            <div class="row-main">
              <div class="row-name">
                Transcribing on Crucible on {{ routeServer() }}
                <span class="pill ok">Ready</span>
              </div>
              <div class="row-desc wrap">
                With {{ routeModel() }}. The video is sent as it is, and Crucible splits long videos itself.
              </div>
            </div>
            <ui-button variant="secondary" size="sm" (pressed)="reload()">Re-check</ui-button>
          </div>
        } @else {
          <div class="row-card route-card field-gap" [class.fallback]="!!routeWarning()">
            <div class="row-main">
              <div class="row-name">
                Transcribing on this computer (whisper)
                @if (routeWarning()) {
                  <span class="pill accent">Fallback</span>
                }
              </div>
              <div class="row-desc wrap">{{ routeReason() }}</div>
            </div>
            <ui-button variant="secondary" size="sm" (pressed)="reload()">Re-check</ui-button>
          </div>
        }
        @if (v.ignored) {
          <p class="hint">Ignored an unreadable saved value ({{ v.ignored }}); the default applies.</p>
        }
      } @else if (loadError()) {
        <div class="warn">{{ loadError() }}</div>
      }
      <p class="hint">Translating speech to English always uses the offline transcriber on this computer.</p>
    </div>

    <div class="pane-section">
      <p class="section-label">Offline transcriber (whisper)</p>
      <p class="hint" style="margin: 0 0 10px;">
        Used when transcription runs on this computer, when Crucible can't
        transcribe, and for translation.
      </p>
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
        <span class="save-flash">Saved</span>
      }
      <p class="hint">{{ modeDescription() }}</p>
      @if (gpuFailed()) {
        <div class="warn">GPU transcription failed on this system. Auto mode will use CPU.</div>
      }
      <p class="hint">
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
  private crucible = inject(CrucibleService);
  private readonly apiBase = getApiBase();

  gpuMode = signal<GpuMode>('auto');
  gpuFailed = signal(false);
  loading = signal(true);
  saving = signal(false);
  savedFlash = signal(false);

  readonly view = signal<TranscriptionView | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly savingVenue = signal(false);
  readonly venueSavedFlash = signal(false);

  readonly venue = computed<TranscriptionVenueChoiceWire>(() => this.view()?.setting.venue ?? 'auto');
  readonly serverChoice = computed(() => this.view()?.setting.server ?? '');
  readonly modelChoice = computed(() => this.view()?.setting.model ?? '');
  readonly servers = computed<TranscriptionServerView[]>(() => this.view()?.servers ?? []);

  /** The server whose models the model picker lists: the chosen one, else the one transcribing, else the first offering asr. */
  readonly modelServer = computed<TranscriptionServerView | null>(() => {
    const v = this.view();
    if (!v) return null;
    const named = v.setting.server ? v.servers.find((s) => s.name === v.setting.server) : undefined;
    if (named) return named;
    const route = v.route;
    if (route.kind === 'crucible') return v.servers.find((s) => s.name === route.server) ?? null;
    return v.servers.find((s) => s.offersAsr) ?? null;
  });

  readonly routeServer = computed(() => { const r = this.view()?.route; return r?.kind === 'crucible' ? r.server : ''; });
  readonly routeModel = computed(() => { const r = this.view()?.route; return r?.kind === 'crucible' ? r.model : ''; });
  readonly routeReason = computed(() => {
    const r = this.view()?.route;
    return r?.kind === 'cli' ? (r.warning ?? r.reason) : '';
  });
  readonly routeWarning = computed(() => { const r = this.view()?.route; return r?.kind === 'cli' ? r.warning : null; });

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
    this.reload();
  }

  reload(): void {
    this.crucible.transcription()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          this.view.set(view);
          this.loadError.set(null);
        },
        error: (refusal: CrucibleRefusal) => this.loadError.set(refusal.message),
      });
  }

  serverNote(s: TranscriptionServerView): string {
    if (!s.enabled) return ' (paused)';
    if (s.unavailable) return s.offersAsr ? ' (not available now)' : ' (no transcription)';
    return '';
  }

  onVenueChange(venue: TranscriptionVenueChoiceWire): void {
    this.save({ ...this.current(), venue });
  }

  onServerChange(server: string): void {
    // A model id is per engine (mlx-whisper on a Mac, faster-whisper on a PC): a new server starts on its own best.
    this.save({ ...this.current(), server: server || null, model: null });
  }

  onModelChange(model: string): void {
    this.save({ ...this.current(), model: model || null });
  }

  private current(): TranscriptionSettingWire {
    return this.view()?.setting ?? { venue: 'auto', server: null, model: null };
  }

  private save(setting: TranscriptionSettingWire): void {
    this.savingVenue.set(true);
    this.crucible.saveTranscription(setting)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          this.view.set(view);
          this.savingVenue.set(false);
          this.venueSavedFlash.set(true);
          timer(1200).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.venueSavedFlash.set(false));
        },
        error: (refusal: CrucibleRefusal) => {
          this.savingVenue.set(false);
          this.errorSurface.surfaceError("Transcription setting didn't save", refusal.message);
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
