import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Creamsicle count badge primitive (e.g. queue count in the sidebar).
 * Dumb: value + tone in, pill out. Renders nothing when value is 0/undefined
 * unless `showZero` is set.
 */
@Component({
  selector: 'ui-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <span
        class="ui-badge"
        [class.accent]="tone() === 'accent'"
        [class.neutral]="tone() === 'neutral'">{{ value() }}</span>
    }
  `,
  styles: [`
    :host { display: inline-flex; }

    .ui-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.2;

      &.accent {
        background: var(--primary-orange);
        color: var(--text-inverse);
      }

      &.neutral {
        background: var(--bg-input);
        color: var(--text-secondary);
        border: 1px solid var(--border-color);
      }
    }
  `]
})
export class UiBadgeComponent {
  value = input<number | string | null>(null);
  tone = input<'accent' | 'neutral'>('accent');
  showZero = input(false);

  visible = computed(() => {
    const v = this.value();
    if (v === null || v === undefined || v === '') return false;
    if (!this.showZero() && (v === 0 || v === '0')) return false;
    return true;
  });
}
