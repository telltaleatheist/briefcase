import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CrucibleReadinessService } from '../../services/crucible-readiness.service';

/**
 * THE ONE "BRING CRUCIBLE UP?" PROMPT (P7).
 *
 * A non-modal card at the bottom of the window, shown when AI is needed and
 * Crucible is not ready and the user has not said "Not now" this session: AI
 * tasks are waiting in the queue, an AI action was attempted, or the backend
 * refused one with `crucible_required`. It says why, and offers the one door
 * (Start / Install / Connect) and "Not now". While Crucible is starting it
 * shows the start's progress instead of buttons. Nothing else in Briefcase
 * waits on it: browsing, downloads and processing go on around it.
 */
@Component({
  selector: 'app-crucible-prompt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (readiness.prompt()) {
      <div class="crucible-prompt" role="status" aria-live="polite">
        <div class="head">
          <span class="dot" [class.starting]="readiness.starting()" aria-hidden="true"></span>
          <span class="title">{{ readiness.starting() ? 'Starting Crucible' : 'AI needs Crucible' }}</span>
        </div>
        @if (readiness.starting()) {
          <div class="progress">
            <span class="spinner" aria-hidden="true"></span>
            <span class="line">{{ readiness.view()?.progress ?? 'Starting…' }}</span>
          </div>
        } @else {
          <p class="reason">{{ message() }}</p>
          @if (waiting(); as n) {
            <p class="waiting">{{ n }} AI task{{ n === 1 ? '' : 's' }} waiting in the queue.</p>
          }
          @if (readiness.error(); as err) {
            <p class="error">{{ err }}</p>
          }
          <div class="actions">
            @if (readiness.doorLabel(); as door) {
              <button type="button" class="primary" (click)="readiness.openDoor()">{{ door }}</button>
            }
            <button type="button" class="ghost" (click)="readiness.decline()">Not now</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      position: fixed;
      left: calc(var(--sidebar-width, 220px) + 16px);
      bottom: 16px;
      z-index: 900;
      pointer-events: none;
    }
    .crucible-prompt {
      pointer-events: auto;
      width: 340px;
      max-width: calc(100vw - 32px);
      padding: 12px 14px;
      border: 1px solid var(--primary-orange);
      border-radius: 10px;
      background: var(--bg-elevated, var(--bg-secondary));
      color: var(--text-primary);
      box-shadow: 0 8px 24px var(--shadow-color, rgba(0, 0, 0, 0.25));
      font-size: 12.5px;
    }
    .head { display: flex; align-items: center; gap: 8px; }
    .title { font-weight: 600; font-size: 13px; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex: none;
      background: var(--text-tertiary);
      &.starting { background: var(--warning); }
    }
    .reason, .waiting, .error { margin: 6px 0 0; line-height: 1.4; }
    .reason { color: var(--text-secondary); }
    .waiting { color: var(--text-tertiary); font-size: 11.5px; }
    .error { color: var(--error); }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    button {
      padding: 5px 12px; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer;
    }
    .primary { border: 1px solid var(--primary-orange); background: var(--primary-orange); color: var(--text-inverse, #fff); }
    .ghost { border: 1px solid var(--border-color); background: transparent; color: var(--text-secondary); }
    .progress { display: flex; align-items: center; gap: 8px; margin-top: 8px; color: var(--text-secondary); }
    .line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spinner {
      width: 12px; height: 12px; flex: none; border-radius: 50%;
      border: 2px solid var(--border-color); border-top-color: var(--primary-orange);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `],
})
export class CruciblePromptComponent {
  readonly readiness = inject(CrucibleReadinessService);

  /** A refusal's own sentence when one brought the prompt up, else the readiness reason. */
  readonly message = computed(() => this.readiness.refusalMessage() ?? this.readiness.reason());
  readonly waiting = computed(() => this.readiness.view()?.aiWaiting ?? 0);
}
