import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Creamsicle titled surface primitive: bordered card with an optional
 * uppercase section title, content projected inside.
 */
@Component({
  selector: 'ui-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ui-panel">
      @if (title()) {
        <h3 class="panel-title">{{ title() }}</h3>
      }
      <div class="panel-body">
        <ng-content />
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }

    .ui-panel {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 14px 16px;
    }

    .panel-title {
      margin: 0 0 10px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-tertiary);
    }
  `]
})
export class UiPanelComponent {
  title = input('');
}
