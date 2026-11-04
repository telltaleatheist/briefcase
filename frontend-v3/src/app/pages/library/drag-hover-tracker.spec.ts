import { fakeAsync, tick } from '@angular/core/testing';
import { DRAG_HOVER_TIMEOUT_MS, DragHoverTracker } from './drag-hover-tracker';

describe('DragHoverTracker', () => {
  it('clears the hover when dragover events stop arriving', fakeAsync(() => {
    const tracker = new DragHoverTracker();
    tracker.over();
    expect(tracker.active()).toBeTrue();

    tick(DRAG_HOVER_TIMEOUT_MS);
    expect(tracker.active()).toBeFalse();
  }));

  it('stays active while dragover events keep arriving', fakeAsync(() => {
    const tracker = new DragHoverTracker();
    tracker.over();
    tick(DRAG_HOVER_TIMEOUT_MS - 1);
    tracker.over();
    tick(DRAG_HOVER_TIMEOUT_MS - 1);
    expect(tracker.active()).toBeTrue();

    tick(1);
    expect(tracker.active()).toBeFalse();
  }));

  it('shows again when a dragover follows the timeout', fakeAsync(() => {
    const tracker = new DragHoverTracker();
    tracker.over();
    tick(DRAG_HOVER_TIMEOUT_MS);
    tracker.over();
    expect(tracker.active()).toBeTrue();
    tracker.end();
  }));

  it('end() clears at once, cancels the timer and reports the gap', fakeAsync(() => {
    const tracker = new DragHoverTracker();
    const now = spyOn(Date, 'now').and.returnValue(1000);
    tracker.over();
    now.and.returnValue(1250);

    expect(tracker.end()).toBe(250);
    expect(tracker.active()).toBeFalse();
    // fakeAsync fails the test here if the timer were still pending.
  }));

  it('end() reports null when no dragover preceded it', () => {
    expect(new DragHoverTracker().end()).toBeNull();
  });
});
