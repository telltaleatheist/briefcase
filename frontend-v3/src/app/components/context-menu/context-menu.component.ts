import { Component, EventEmitter, Input, Output, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ContextMenuAction, ContextMenuPosition } from '../../models/file.model';

@Component({
  selector: 'app-context-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible) {
      <div
        class="context-menu"
        [style.left.px]="position.x"
        [style.top.px]="position.y"
        (click)="$event.stopPropagation()"
      >
        @for (action of actions; track action.action) {
          @if (action.divider) {
            <div class="context-menu-divider"></div>
          } @else {
            <button
              class="context-menu-item"
              [class.disabled]="action.disabled"
              [disabled]="action.disabled"
              (click)="onActionClick(action)"
            >
              <span class="menu-icon">{{ action.icon }}</span>
              <span class="menu-label">{{ action.label }}</span>
            </button>
          }
        }
      </div>
    }
  `,
  styles: [`
    @use '../../../styles/variables' as *;
    @use '../../../styles/mixins' as *;

    .context-menu {
      position: fixed;
      z-index: $z-popover;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: $radius-md;
      box-shadow: $shadow-xl;
      min-width: 200px;
      padding: $spacing-xs;
      animation: contextMenuAppear 0.15s ease-out;
    }

    @keyframes contextMenuAppear {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .context-menu-item {
      @include flex-center;
      justify-content: flex-start;
      gap: $spacing-sm;
      width: 100%;
      padding: $spacing-sm $spacing-md;
      background: transparent;
      border: none;
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: $font-size-sm;
      cursor: pointer;
      transition: all $transition-fast;
      text-align: left;

      &:hover:not(.disabled) {
        background: var(--bg-secondary);
        color: var(--primary-orange);

        .menu-icon {
          transform: scale(1.1);
        }
      }

      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .menu-icon {
      font-size: $font-size-base;
      transition: transform $transition-fast;
    }

    .menu-label {
      flex: 1;
    }

    .context-menu-divider {
      height: 1px;
      background: var(--border-color);
      margin: $spacing-xs 0;
    }
  `]
})
export class ContextMenuComponent {
  @Input() visible = false;
  @Input() position: ContextMenuPosition = { x: 0, y: 0 };
  @Input() actions: ContextMenuAction[] = [];
  @Output() actionSelected = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  @HostListener('document:click')
  onDocumentClick() {
    if (this.visible) {
      this.close();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey() {
    if (this.visible) {
      this.close();
    }
  }


  onActionClick(action: ContextMenuAction) {
    if (!action.disabled) {
      this.actionSelected.emit(action.action);
      this.close();
    }
  }

  close() {
    this.visible = false;
    this.closed.emit();
  }
}
