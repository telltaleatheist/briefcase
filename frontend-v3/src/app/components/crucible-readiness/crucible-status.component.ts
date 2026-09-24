import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CrucibleReadinessService } from '../../services/crucible-readiness.service';

/**
 * The always-visible Crucible line in the sidebar footer (P7): whether AI
 * actions can run, in a few words. Clicking it opens the one door when
 * Crucible is not ready, or Settings › Crucible Servers when it is.
 */
@Component({
  selector: 'app-crucible-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="crucible-status" [attr.title]="tooltip()" (click)="onClick()">
      <span class="dot" [class.ok]="tone() === 'ok'" [class.busy]="tone() === 'busy'" aria-hidden="true"></span>
      <span class="label">{{ label() }}</span>
    </button>
  `,
  styles: [`
    :host { display: block; }
    .crucible-status {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 6px 10px;
      border: 0; border-radius: 7px; background: transparent;
      color: var(--text-tertiary); font: inherit; font-size: 11.5px; text-align: left; cursor: pointer;
      &:hover { background: var(--bg-input); color: var(--text-secondary); }
      &:focus-visible { outline: 2px solid var(--primary-orange); outline-offset: -2px; }
    }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--text-tertiary); }
    .dot.ok { background: var(--success); }
    .dot.busy { background: var(--warning); }
    .dot.off { background: var(--text-tertiary); }
  `],
})
export class CrucibleStatusComponent {
  private readonly readiness = inject(CrucibleReadinessService);
  private readonly router = inject(Router);

  readonly label = computed(() => {
    const view = this.readiness.view();
    if (!view) return 'Crucible: checking…';
    switch (view.state) {
      case 'ready':
        if (view.busy) return 'Crucible: busy (AI work waits)';
        return view.server ? `Crucible: ready on ${view.server}` : 'Crucible: ready';
      case 'starting': return 'Crucible: starting…';
      case 'unreachable': return 'Crucible: not running';
      case 'not-installed': return 'Crucible: not installed';
      case 'not-configured': return 'Crucible: not connected';
    }
  });

  readonly tone = computed(() => {
    const view = this.readiness.view();
    if (view?.state === 'ready') return view.busy ? 'busy' : 'ok';
    return view?.state === 'starting' ? 'busy' : 'off';
  });

  readonly tooltip = computed(() => {
    const view = this.readiness.view();
    if (!view) return 'Checking whether Crucible is running';
    if (view.state === 'ready' && view.busy) return `${view.reason} The card is busy: ${view.busy}. AI work waits for it.`;
    const door = this.readiness.doorLabel();
    return door ? `${view.reason} Click to ${door.charAt(0).toLowerCase()}${door.slice(1)}.` : view.reason;
  });

  onClick(): void {
    if (this.readiness.ready() || this.readiness.starting() || !this.readiness.action()) {
      void this.router.navigate(['/settings/crucible']);
    } else {
      void this.readiness.openDoor();
    }
  }
}
