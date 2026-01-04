import { Component, input, output, signal, ElementRef, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  divider?: boolean;
}

export interface ContextMenuPosition {
  x: number;
  y: number;
}

@Component({
  selector: 'app-context-menu',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './context-menu.component.html',
  styleUrls: ['./context-menu.component.scss']
})
export class ContextMenuComponent implements OnInit, OnDestroy {
  // Inputs
  position = input.required<ContextMenuPosition>();
  actions = input.required<ContextMenuAction[]>();

  // Outputs
  actionSelected = output<string>();
  closed = output<void>();

  // Internal state
  adjustedPosition = signal<ContextMenuPosition>({ x: 0, y: 0 });

  constructor(private elementRef: ElementRef) {}

  ngOnInit() {
    // Adjust position to keep menu within viewport
    setTimeout(() => this.adjustPosition(), 0);
  }

  ngOnDestroy() {}

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.closed.emit();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey() {
    this.closed.emit();
  }

  @HostListener('document:contextmenu', ['$event'])
  onContextMenu(event: MouseEvent) {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.closed.emit();
    }
  }

  onActionClick(action: ContextMenuAction) {
    if (action.disabled || action.divider) return;
    this.actionSelected.emit(action.id);
    this.closed.emit();
  }

  private adjustPosition() {
    const pos = this.position();
    const menuElement = this.elementRef.nativeElement.querySelector('.context-menu');
    if (!menuElement) {
      this.adjustedPosition.set(pos);
      return;
    }

    const menuRect = menuElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = pos.x;
    let y = pos.y;

    // Adjust if menu would overflow right edge
    if (x + menuRect.width > viewportWidth) {
      x = viewportWidth - menuRect.width - 10;
    }

    // Adjust if menu would overflow bottom edge
    if (y + menuRect.height > viewportHeight) {
      y = viewportHeight - menuRect.height - 10;
    }

    // Ensure menu doesn't go off left or top
    x = Math.max(10, x);
    y = Math.max(10, y);

    this.adjustedPosition.set({ x, y });
  }

  getMenuStyle() {
    const pos = this.adjustedPosition();
    return {
      left: `${pos.x}px`,
      top: `${pos.y}px`
    };
  }
}
