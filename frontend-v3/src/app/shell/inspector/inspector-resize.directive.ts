import { DOCUMENT } from '@angular/common';
import { Directive, inject, input, output, signal } from '@angular/core';

/**
 * Drag handle for the inspector's left edge.
 *
 * Emits the new width while dragging (pointer capture keeps the drag alive
 * outside the handle) and `resetWidth` on double-click. The host element is
 * the slim vertical bar itself; the shell owns applying the width.
 *
 * Width math: the inspector hugs the right viewport edge, so
 * width = startWidth + (startX − pointerX). Clamping to 40vw happens here
 * (the store only knows the hard px bounds).
 */
@Directive({
  selector: '[appInspectorResize]',
  standalone: true,
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerEnd($event)',
    '(pointercancel)': 'onPointerEnd($event)',
    '(dblclick)': 'resetWidth.emit()',
    '[class.dragging]': 'dragging()',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize inspector',
  },
})
export class InspectorResizeDirective {
  private document = inject(DOCUMENT);

  /** Inspector width (px) at drag start. */
  currentWidth = input.required<number>();

  widthChange = output<number>();
  resetWidth = output<void>();

  dragging = signal(false);
  private startX = 0;
  private startWidth = 0;

  onPointerDown(event: PointerEvent): void {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.dragging.set(true);
    this.startX = event.clientX;
    this.startWidth = this.currentWidth();
    event.preventDefault();
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    const viewport = this.document.documentElement.clientWidth;
    const raw = this.startWidth + (this.startX - event.clientX);
    this.widthChange.emit(Math.min(raw, viewport * 0.4));
  }

  onPointerEnd(event: PointerEvent): void {
    if (!this.dragging()) return;
    this.dragging.set(false);
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  }
}
