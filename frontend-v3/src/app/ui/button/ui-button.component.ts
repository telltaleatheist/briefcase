import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Creamsicle button primitive.
 *
 * Dumb presentational component: variant/size/disabled in, pressed event out.
 * All colors come from theme CSS variables — no hardcoded values.
 */
@Component({
  selector: 'ui-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      class="ui-button"
      [class.primary]="variant() === 'primary'"
      [class.secondary]="variant() === 'secondary'"
      [class.ghost]="variant() === 'ghost'"
      [class.sm]="size() === 'sm'"
      [class.block]="block()"
      [disabled]="disabled()"
      [attr.title]="title() || null"
      [type]="type()"
      (click)="pressed.emit($event)">
      <ng-content />
    </button>
  `,
  styles: [`
    :host { display: inline-flex; }

    .ui-button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 7px;
      border: 1px solid var(--border-color);
      background: var(--bg-elevated);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      line-height: 1;
      cursor: pointer;
      transition: background-color 120ms ease, opacity 120ms ease, border-color 120ms ease;

      &:hover:not(:disabled) { background: var(--bg-input); }
      &:focus-visible { outline: 2px solid var(--primary-orange); outline-offset: 1px; }
      &:disabled { opacity: 0.4; cursor: default; }

      &.primary {
        background: var(--gradient-primary);
        border-color: transparent;
        color: var(--text-inverse);
        font-weight: 600;
        &:hover:not(:disabled) { background: var(--gradient-primary); filter: brightness(1.05); }
      }

      &.ghost {
        background: transparent;
        border-color: transparent;
        &:hover:not(:disabled) { background: var(--bg-input); }
      }

      &.sm { padding: 5px 9px; font-size: 12px; }

      &.block { width: 100%; justify-content: center; }
    }

    :host:has(.block) { display: flex; width: 100%; }
  `]
})
export class UiButtonComponent {
  variant = input<'primary' | 'secondary' | 'ghost'>('secondary');
  size = input<'md' | 'sm'>('md');
  /** Full-width button (stacked action lists, e.g. the inspector). */
  block = input(false);
  disabled = input(false);
  title = input('');
  type = input<'button' | 'submit'>('button');

  pressed = output<MouseEvent>();
}
