import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

export interface SegmentOption {
  value: string;
  label: string;
}

/**
 * Creamsicle segmented control primitive (pill-style option row).
 * Dumb: options in, two-way `value` model out. Used by Phase 2 for the
 * Library type filter (All / Videos / Documents / Web Archives).
 */
@Component({
  selector: 'ui-segmented-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ui-segments" role="tablist">
      @for (option of options(); track option.value) {
        <button
          type="button"
          role="tab"
          class="segment"
          [class.active]="option.value === value()"
          [attr.aria-selected]="option.value === value()"
          (click)="value.set(option.value)">
          {{ option.label }}
        </button>
      }
    </div>
  `,
  styles: [`
    :host { display: inline-flex; }

    .ui-segments {
      display: flex;
      gap: 4px;
    }

    .segment {
      appearance: none;
      border: 0;
      background: transparent;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      padding: 5px 11px;
      border-radius: 999px;
      transition: background-color 120ms ease, color 120ms ease;

      &:hover { background: var(--bg-input); }
      &:focus-visible { outline: 2px solid var(--primary-orange); outline-offset: 1px; }

      &.active {
        background: var(--bg-input);
        color: var(--primary-orange);
        font-weight: 600;
      }
    }
  `]
})
export class UiSegmentedControlComponent {
  options = input.required<SegmentOption[]>();
  value = model<string>('');
}
