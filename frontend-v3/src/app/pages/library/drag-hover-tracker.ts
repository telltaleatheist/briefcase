import { signal } from '@angular/core';

/** Longer than the gap between dragover events, so the cover doesn't flicker. */
export const DRAG_HOVER_TIMEOUT_MS = 1000;

/**
 * Whether a drag is over the drop target. A held drag repeats dragover, so when
 * the events stop the drag is over even if no drop or dragleave ever arrived;
 * the timeout clears the cover instead of leaving it up indefinitely.
 */
export class DragHoverTracker {
  readonly active = signal(false);

  private timer: ReturnType<typeof setTimeout> | null = null;

  over(): void {
    this.active.set(true);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active.set(false);
    }, DRAG_HOVER_TIMEOUT_MS);
  }

  end(): void {
    this.active.set(false);
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
