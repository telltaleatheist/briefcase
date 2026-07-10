import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Right inspector panel — reserved shell region.
 *
 * Phase 1: empty placeholder so the layout region exists and can be toggled.
 * Phase 3 fills it with selection details, pipeline status, connections,
 * and batch actions (retiring a pile of modals in the process).
 */
@Component({
  selector: 'app-inspector-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="inspector" aria-label="Inspector">
      <div class="empty">Select an item to see details,<br />status, and actions.</div>
    </aside>
  `,
  styles: [`
    :host { display: block; height: 100%; }

    .inspector {
      display: grid;
      place-items: center;
      height: 100%;
      width: var(--inspector-width);
      padding: 16px;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-color);
    }

    .empty {
      font-size: 13px;
      color: var(--text-tertiary);
      text-align: center;
    }
  `]
})
export class InspectorPanelComponent {}
