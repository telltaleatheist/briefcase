import { fakeAsync, tick } from '@angular/core/testing';
import { CascadeComponent } from '../../components/cascade/cascade.component';
import { LibraryPageComponent } from './library-page.component';
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

  it('end() clears at once and cancels the timer', fakeAsync(() => {
    const tracker = new DragHoverTracker();
    tracker.over();

    tracker.end();
    expect(tracker.active()).toBeFalse();
    // fakeAsync fails the test here if the timer were still pending.
  }));
});

describe('file drops in the library', () => {
  const dragEvent = (type: string, init: DragEventInit = {}) =>
    new DragEvent(type, { bubbles: true, cancelable: true, ...init });

  it('a week header outside Collections lets the drop reach the page', () => {
    const page = document.createElement('div');
    const header = document.createElement('div');
    page.appendChild(header);
    document.body.appendChild(page);

    const reachedPage = jasmine.createSpy('pageDrop');
    page.addEventListener('drop', reachedPage);
    header.addEventListener('drop', e =>
      CascadeComponent.prototype.onDropToTab.call({ tabsMode: false } as any, e as DragEvent, '2026-11-01'),
    );

    header.dispatchEvent(dragEvent('drop'));
    page.remove();

    expect(reachedPage).toHaveBeenCalledTimes(1);
  });

  describe('dragleave', () => {
    let container: HTMLDivElement;
    let child: HTMLDivElement;
    let end: jasmine.Spy;

    beforeEach(() => {
      container = document.createElement('div');
      child = document.createElement('div');
      container.appendChild(child);
      document.body.appendChild(container);
      end = jasmine.createSpy('end');
      container.addEventListener('dragleave', e =>
        LibraryPageComponent.prototype.onDragLeave.call({ dragHover: { end } } as any, e as DragEvent),
      );
    });

    afterEach(() => container.remove());

    it('keeps the cover when the drag only crosses a child', () => {
      child.dispatchEvent(dragEvent('dragleave', { relatedTarget: container }));
      expect(end).not.toHaveBeenCalled();
    });

    it('drops the cover when the drag leaves the container', () => {
      container.dispatchEvent(dragEvent('dragleave', { relatedTarget: document.body }));
      expect(end).toHaveBeenCalledTimes(1);
    });

    it('drops the cover when the drag leaves the window', () => {
      container.dispatchEvent(dragEvent('dragleave', { relatedTarget: null }));
      expect(end).toHaveBeenCalledTimes(1);
    });
  });
});
