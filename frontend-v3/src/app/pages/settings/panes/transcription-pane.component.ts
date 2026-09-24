import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer } from 'rxjs';
import { ErrorSurface } from '../../../core/error-surface.service';
import { UiButtonComponent } from '../../../ui';
import { CrucibleService, type CrucibleRefusal } from '../../../services/crucible.service';
import { CrucibleReadinessService } from '../../../services/crucible-readiness.service';
import type {
  TranscriptionServerView,
  TranscriptionSettingWire,
  TranscriptionView,
} from '@crucible-wire/transcription-wire';

/**
 * Settings → Transcription.
 *
 * Transcription is Crucible's `asr` job and nothing else (P7): mlx-whisper on
 * a Mac server, faster-whisper on a PC one, in the language spoken. It runs
 * on the selected Crucible server (Settings › Crucible Servers), like all AI
 * work. The pane picks the asr model on that server, and says where a
 * transcription queued now would run, or why it would wait.
 */
@Component({
  selector: 'app-transcription-pane',
  standalone: true,
  imports: [RouterLink, FormsModule, UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  styles: [`
    .row-desc.wrap { white-space: normal; overflow: visible; }
    .route-card.waiting { border-color: var(--warning); }
    .field-gap { margin-top: 12px; }
  `],
  template: `
    <h2 class="pane-title">Transcription</h2>
    <p class="pane-lede">
      Speech-to-text for your videos, in the language spoken. It runs on the Crucible server selected in
      <a [routerLink]="['/settings/crucible']">Settings › Crucible Servers</a>.
    </p>

    <div class="pane-section">
      <p class="section-label">Where transcription runs</p>
      @if (!readiness.ready()) {
        <div class="row-card route-card waiting">
          <div class="row-main">
            <div class="row-name">Transcription needs Crucible</div>
            <div class="row-desc wrap">{{ readiness.reason() }}</div>
          </div>
          @if (readiness.doorLabel(); as door) {
            <ui-button variant="primary" size="sm" (pressed)="readiness.openDoor()">{{ door }}</ui-button>
          }
        </div>
      }
      @if (modelServer(); as target) {
        <label class="field-label" for="transcribe-model">Model on {{ target.name }}</label>
        <select
          id="transcribe-model"
          class="select"
          [ngModel]="modelChoice()"
          [disabled]="saving() || target.models.length === 0"
          (ngModelChange)="onModelChange($event)">
          <option value="">{{ target.recommended ? 'Most accurate downloaded (' + target.recommended + ')' : 'Most accurate downloaded' }}</option>
          @for (m of target.models; track m.id) {
            <option [value]="m.id" [disabled]="!m.installed">{{ m.id }}{{ m.installed ? '' : ' (not downloaded)' }}</option>
          }
          @if (missingModel(); as missing) {
            <option [value]="missing">{{ missing }} (unavailable)</option>
          }
        </select>
        @if (missingModel(); as missing) {
          <p class="hint">{{ target.name }} does not offer {{ missing }}, so its most accurate downloaded model is used instead. Pick one it offers to change that.</p>
        }
        @if (target.betterNotInstalled; as better) {
          <p class="hint">{{ better }} is more accurate and can be downloaded on {{ target.name }} from Crucible's catalog.</p>
        }
        @if (savedFlash()) {
          <span class="save-flash">Saved</span>
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
          <div class="row-card route-card waiting field-gap">
            <div class="row-main">
              <div class="row-name">
                Transcription can't run now
                <span class="pill accent">Waiting</span>
              </div>
              <div class="row-desc wrap">{{ routeReason() }}</div>
            </div>
            <ui-button variant="secondary" size="sm" (pressed)="reload()">Re-check</ui-button>
          </div>
          <p class="hint">
            Start, install or connect a server in
            <a [routerLink]="['/settings/crucible']">Settings › Crucible Servers</a>.
          </p>
        }
        @if (v.ignored) {
          <p class="hint">Ignored an unreadable saved value ({{ v.ignored }}); the default applies.</p>
        }
      } @else if (loadError()) {
        <div class="warn">{{ loadError() }}</div>
      }
    </div>
  `
})
export class TranscriptionPaneComponent {
  private destroyRef = inject(DestroyRef);
  private errorSurface = inject(ErrorSurface);
  private crucible = inject(CrucibleService);
  readonly readiness = inject(CrucibleReadinessService);

  readonly view = signal<TranscriptionView | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly savedFlash = signal(false);

  readonly modelChoice = computed(() => this.view()?.setting.model ?? '');

  /** The selected server, whose models the model picker lists. */
  readonly modelServer = computed<TranscriptionServerView | null>(() => this.view()?.server ?? null);

  readonly routeServer = computed(() => { const r = this.view()?.route; return r?.kind === 'crucible' ? r.server : ''; });
  readonly routeModel = computed(() => { const r = this.view()?.route; return r?.kind === 'crucible' ? r.model : ''; });
  readonly routeReason = computed(() => { const r = this.view()?.route; return r?.kind === 'none' ? r.reason : ''; });

  /** The saved model, when the server the picker lists does not offer it (shown as unavailable, never dropped). */
  readonly missingModel = computed(() => {
    const model = this.modelChoice();
    const target = this.modelServer();
    if (!model || !target) return null;
    return target.models.some((m) => m.id === model) ? null : model;
  });

  constructor() {
    // Re-read when readiness or the connected server changes (the crucible.readiness push).
    let lastKey: string | null = null;
    effect(() => {
      const v = this.readiness.view();
      const key = v === null ? 'unknown' : `${v.state}\n${v.server ?? ''}`;
      untracked(() => {
        if (key === lastKey) return;
        lastKey = key;
        this.reload();
      });
    });
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

  onModelChange(model: string): void {
    this.save({ model: model || null });
  }

  private save(setting: TranscriptionSettingWire): void {
    this.saving.set(true);
    this.crucible.saveTranscription(setting)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          this.view.set(view);
          this.saving.set(false);
          this.savedFlash.set(true);
          timer(1200).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.savedFlash.set(false));
        },
        error: (refusal: CrucibleRefusal) => {
          this.saving.set(false);
          this.errorSurface.surfaceError("Transcription setting didn't save", refusal.message);
        },
      });
  }
}
