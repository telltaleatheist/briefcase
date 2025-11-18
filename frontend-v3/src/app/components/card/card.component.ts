import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="card"
      [class.hoverable]="hoverable"
      [class.clickable]="clickable"
      [ngStyle]="customStyles"
    >
      @if (icon) {
        <div class="card-icon">{{ icon }}</div>
      }

      @if (title || badge) {
        <div class="card-header">
          @if (title) {
            <h3 class="card-title">{{ title }}</h3>
          }
          @if (badge) {
            <span class="card-badge" [class]="badgeClass">{{ badge }}</span>
          }
        </div>
      }

      <div class="card-content">
        <ng-content></ng-content>
      </div>

      @if (footer) {
        <div class="card-footer">
          <ng-content select="[footer]"></ng-content>
        </div>
      }
    </div>
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .card {
      background: var(--bg-card);
      border-radius: $radius-lg;
      padding: $spacing-lg;
      box-shadow: $shadow-md;
      transition: all $transition-base;
      border: 1px solid var(--border-color);

      &.hoverable:hover {
        box-shadow: $shadow-xl;
        transform: translateY(-4px);
        border-color: var(--primary-orange);
      }

      &.clickable {
        cursor: pointer;

        &:active {
          transform: scale(0.98);
        }
      }
    }

    .card-icon {
      font-size: $font-size-4xl;
      margin-bottom: $spacing-md;
      transition: transform $transition-base;

      .card:hover & {
        transform: scale(1.1) rotate(5deg);
      }
    }

    .card-header {
      @include flex-between;
      margin-bottom: $spacing-md;
      gap: $spacing-sm;
    }

    .card-title {
      font-size: $font-size-xl;
      font-weight: $font-weight-bold;
      color: var(--text-primary);
      margin: 0;
    }

    .card-badge {
      padding: $spacing-xs $spacing-sm;
      border-radius: $radius-full;
      font-size: $font-size-xs;
      font-weight: $font-weight-semibold;
      background: var(--bg-secondary);
      color: var(--text-secondary);

      &.badge-success {
        background: rgba(34, 197, 94, 0.1);
        color: $success;
      }

      &.badge-warning {
        background: rgba(245, 158, 11, 0.1);
        color: $warning;
      }

      &.badge-error {
        background: rgba(239, 68, 68, 0.1);
        color: $error;
      }

      &.badge-info {
        background: rgba(59, 130, 246, 0.1);
        color: $info;
      }
    }

    .card-content {
      color: var(--text-secondary);
      line-height: $line-height-relaxed;
    }

    .card-footer {
      margin-top: $spacing-lg;
      padding-top: $spacing-lg;
      border-top: 1px solid var(--border-color);
    }
  `]
})
export class CardComponent {
  @Input() title?: string;
  @Input() icon?: string;
  @Input() badge?: string;
  @Input() badgeClass?: string;
  @Input() hoverable: boolean = true;
  @Input() clickable: boolean = false;
  @Input() footer: boolean = false;
  @Input() customStyles?: { [key: string]: string };
}
