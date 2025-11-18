import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'gradient';
export type ButtonSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'app-button',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button
      [type]="type"
      [disabled]="disabled"
      [class]="'btn btn-' + variant + ' btn-' + size"
      [class.loading]="loading"
      [class.full-width]="fullWidth"
    >
      @if (loading) {
        <span class="spinner"></span>
      }

      @if (icon && !loading) {
        <span class="btn-icon">{{ icon }}</span>
      }

      <span class="btn-text">
        <ng-content></ng-content>
      </span>

      @if (iconRight && !loading) {
        <span class="btn-icon-right">{{ iconRight }}</span>
      }
    </button>
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .btn {
      @include button-base;
      position: relative;
      overflow: hidden;

      &::before {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 0;
        height: 0;
        border-radius: $radius-full;
        background: rgba(255, 255, 255, 0.3);
        transform: translate(-50%, -50%);
        transition: width 0.6s, height 0.6s;
      }

      &:active::before {
        width: 300px;
        height: 300px;
      }
    }

    // Variants
    .btn-primary {
      @include button-primary;
    }

    .btn-secondary {
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);

      &:hover:not(:disabled) {
        background: var(--bg-tertiary);
        border-color: var(--primary-orange);
      }
    }

    .btn-outline {
      background: transparent;
      color: var(--primary-orange);
      border: 2px solid var(--primary-orange);

      &:hover:not(:disabled) {
        background: var(--primary-orange);
        color: white;
      }
    }

    .btn-ghost {
      background: transparent;
      color: var(--primary-orange);
      box-shadow: none;

      &:hover:not(:disabled) {
        background: rgba(255, 107, 53, 0.1);
      }
    }

    .btn-gradient {
      background: var(--gradient-primary);
      color: white;
      box-shadow: $shadow-md;

      &:hover:not(:disabled) {
        box-shadow: $shadow-xl, $shadow-glow;
        transform: translateY(-2px);
      }
    }

    // Sizes
    .btn-sm {
      padding: $spacing-xs $spacing-md;
      font-size: $font-size-sm;
      border-radius: $radius-sm;
    }

    .btn-md {
      padding: $spacing-sm $spacing-lg;
      font-size: $font-size-base;
    }

    .btn-lg {
      padding: $spacing-md $spacing-xl;
      font-size: $font-size-lg;
      border-radius: $radius-lg;
    }

    // States
    .btn.loading {
      pointer-events: none;
      opacity: 0.7;
    }

    .btn.full-width {
      width: 100%;
    }

    // Icons
    .btn-icon,
    .btn-icon-right {
      font-size: 1.2em;
      transition: transform $transition-fast;
    }

    .btn:hover .btn-icon {
      transform: scale(1.1) rotate(-5deg);
    }

    .btn:hover .btn-icon-right {
      transform: translateX(4px);
    }

    // Spinner
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: currentColor;
      border-radius: $radius-full;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class ButtonComponent {
  @Input() type: 'button' | 'submit' | 'reset' = 'button';
  @Input() variant: ButtonVariant = 'primary';
  @Input() size: ButtonSize = 'md';
  @Input() icon?: string;
  @Input() iconRight?: string;
  @Input() disabled: boolean = false;
  @Input() loading: boolean = false;
  @Input() fullWidth: boolean = false;
}
