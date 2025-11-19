import { Component, EventEmitter, Input, Output, HostListener, ViewChild, ElementRef, AfterViewChecked, OnChanges, SimpleChanges, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ContextMenuAction, ContextMenuPosition } from '../../models/file.model';

@Component({
  selector: 'app-context-menu',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible) {
      <div
        #menuElement
        class="context-menu"
        [style.left.px]="adjustedPosition.x"
        [style.top.px]="adjustedPosition.y"
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
export class ContextMenuComponent implements AfterViewChecked, OnChanges {
  private cdr = inject(ChangeDetectorRef);

  @Input() visible = false;
  @Input() position: ContextMenuPosition = { x: 0, y: 0 };
  @Input() actions: ContextMenuAction[] = [];
  @Output() actionSelected = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('menuElement') menuElement?: ElementRef<HTMLDivElement>;

  adjustedPosition: ContextMenuPosition = { x: 0, y: 0 };
  private needsPositionRecalc = false;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['position'] || changes['visible']) {
      // Estimate menu height (typical context menu is ~200-300px)
      const estimatedHeight = 250;
      const viewportHeight = window.innerHeight;

      let y = this.position.y;

      // If likely to overflow bottom, flip upward
      if (y + estimatedHeight > viewportHeight) {
        y = this.position.y - estimatedHeight;
      }

      this.adjustedPosition = { x: this.position.x, y };
      this.needsPositionRecalc = true;
    }
  }

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

  ngAfterViewChecked() {
    if (this.visible && this.menuElement && this.needsPositionRecalc) {
      this.needsPositionRecalc = false;
      // Use requestAnimationFrame to ensure DOM has rendered with actual dimensions
      requestAnimationFrame(() => {
        this.calculateAdjustedPosition();
      });
    }
  }

  private calculateAdjustedPosition() {
    const menu = this.menuElement?.nativeElement;
    if (!menu) {
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    let y = this.position.y;

    // If menu would go off bottom, open above cursor instead
    if (this.position.y + menuRect.height > viewportHeight) {
      y = this.position.y - menuRect.height;
    }

    this.adjustedPosition = { x: this.position.x, y };
    this.cdr.detectChanges();
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
