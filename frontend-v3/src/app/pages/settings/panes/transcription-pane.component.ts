import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UiButtonComponent } from '../../../ui';
import { CrucibleService, type CrucibleRefusal } from '../../../services/crucible.service';
import { CrucibleReadinessService } from '../../../services/crucible-readiness.service';
import { WebsocketService } from '../../../services/websocket.service';
import type { TranscriptionModelState, TranscriptionView } from '@crucible-wire/transcription-wire';

/**
 * Settings → Transcription.
 *
 * Transcription is Crucible's `asr` job with Qwen3-ASR-0.6B (the MLX build on a
 * Mac) and nothing else,
 * on the selected Crucible server (Settings › Crucible Servers), like all AI
 * work. There is nothing to choose here: the pane says whether that server has
 * Qwen and its aligner downloaded, and where a transcription queued now would
 * run, or why it would wait.
 */
@Component({
  selector: 'app-transcription-pane',
  standalone: true,
  imports: [RouterLink, UiButtonComponent],
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
      Speech-to-text for your videos, with Qwen3-ASR, on the Crucible server selected in
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

      @if (view(); as v) {
        @if (v.server; as server) {
          <div class="row-card field-gap">
            <div class="row-main">
              <div class="row-name">{{ v.model }} on {{ server.name }}</div>
              <div class="row-desc wrap">
                Model: {{ stateWord(server.qwen) }} · Word timings ({{ v.aligner }}): {{ stateWord(server.aligner) }}
              </div>
            </div>
          </div>
        }
        @if (v.route.kind === 'crucible') {
          <div class="row-card route-card field-gap">
            <div class="row-main">
              <div class="row-name">
                Transcribing on Crucible on {{ routeServer() }}
                <span class="pill ok">Ready</span>
              </div>
              <div class="row-desc wrap">
                The video is sent as it is, and Crucible splits long videos itself. Speech is transcribed as English.
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
            Queued transcriptions wait until it can. Start, install, update or connect a server in
            <a [routerLink]="['/settings/crucible']">Settings › Crucible Servers</a>.
          </p>
        }
      } @else if (loadError()) {
        <div class="warn">{{ loadError() }}</div>
      }
    </div>
  `
})
export class TranscriptionPaneComponent {
  private destroyRef = inject(DestroyRef);
  private crucible = inject(CrucibleService);
  readonly readiness = inject(CrucibleReadinessService);

  readonly view = signal<TranscriptionView | null>(null);
  readonly loadError = signal<string | null>(null);

  readonly routeServer = computed(() => { const r = this.view()?.route; return r?.kind === 'crucible' ? r.server : ''; });
  readonly routeReason = computed(() => { const r = this.view()?.route; return r?.kind === 'none' ? r.reason : ''; });

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
    // ...and when a server finishes preparing Briefcase's models (Qwen or its aligner just landed).
    const off = inject(WebsocketService).onCrucibleCoordination((state) => {
      if (state.phase === 'stocked') this.reload();
    });
    this.destroyRef.onDestroy(off);
  }

  stateWord(state: TranscriptionModelState | null): string {
    if (state === null) return 'unknown';
    if (!state.offered) return 'not offered (update Crucible)';
    return state.installed ? 'downloaded' : 'not downloaded yet';
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
}
