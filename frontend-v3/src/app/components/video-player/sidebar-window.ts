import { DomPortal, DomPortalOutlet } from '@angular/cdk/portal';

/**
 * Scout's analysis sidebar in its own OS window, so the video can have the
 * whole Scout window while the sidebar sits on another screen.
 *
 * The window is a same-origin about:blank child of Scout's page, so it shares
 * Scout's JS realm: the sidebar's element (with its live bindings, its
 * component state and its listeners) is moved into the child document and
 * moved back when the window goes. Angular keeps driving it from Scout.
 * Electron's main process gives the window its options by this frame name.
 */
export const SIDEBAR_WINDOW_NAME = 'scout-sidebar';

const BOUNDS_KEY = 'briefcase-scout-sidebar-window';
const DEFAULT_WIDTH = 440;

/** Attributes that carry the theme (light/dark) on <html> and <body>. */
const THEME_ATTRIBUTES = ['data-theme', 'class'];

interface WindowBounds {
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface SidebarWindowHooks {
  /** The user closed the window (close button, Cmd+W); the element is already back in Scout. */
  closed: () => void;
  /** A key pressed in the window, for Scout's playback shortcuts. */
  keydown: (event: KeyboardEvent) => void;
}

export class SidebarWindow {
  private readonly outlet: DomPortalOutlet;
  private readonly observers: MutationObserver[] = [];
  /** Each of Scout's stylesheet nodes and its copy in the window. */
  private readonly sheetCopies = new Map<Node, Node>();
  private disposed = false;

  /** Opens the window and moves `element` into it; null when the window could not be opened. */
  static open(element: HTMLElement, title: string, hooks: SidebarWindowHooks): SidebarWindow | null {
    const win = window.open('', SIDEBAR_WINDOW_NAME, featuresFor(loadBounds() ?? defaultBounds()));
    return win ? new SidebarWindow(win, element, title, hooks) : null;
  }

  private constructor(
    private readonly win: Window,
    element: HTMLElement,
    title: string,
    private readonly hooks: SidebarWindowHooks,
  ) {
    const doc = win.document;
    this.setTitle(title);

    // Relative URLs (stylesheets, thumbnails) resolve the way they do in Scout.
    const base = doc.createElement('base');
    base.href = document.baseURI;
    doc.head.appendChild(base);

    // Scout's styles, kept in step: Angular adds a component's styles when it
    // first renders and removes them when the last instance goes.
    document.head.querySelectorAll('style, link[rel~="stylesheet"]').forEach(node => this.copySheet(node));
    this.observe(document.head, { childList: true }, records => {
      for (const record of records) {
        record.addedNodes.forEach(node => this.copySheet(node));
        record.removedNodes.forEach(node => {
          (this.sheetCopies.get(node) as ChildNode | undefined)?.remove();
          this.sheetCopies.delete(node);
        });
      }
    });

    // The theme, kept in step with Scout's.
    this.mirrorAttributes(document.documentElement, doc.documentElement);
    this.mirrorAttributes(document.body, doc.body);

    this.outlet = new DomPortalOutlet(doc.body, undefined, undefined, undefined, document);
    this.outlet.attach(new DomPortal(element));

    win.addEventListener('pagehide', this.onWindowGone);
    // Playback keys (space, arrows, J/L...) work while the sidebar has focus.
    // Cmd/Ctrl combinations stay with the window, so Cmd+W closes it rather
    // than a Scout tab.
    doc.addEventListener('keydown', this.onKeydown);
    // Scout reloading or closing takes the window with it.
    window.addEventListener('pagehide', this.close);
  }

  setTitle(title: string): void {
    if (!this.disposed) this.win.document.title = title;
  }

  /** Moves the element back into Scout and closes the window (pop in, or Scout going away). */
  readonly close = (): void => {
    if (this.dispose()) this.win.close();
  };

  private readonly onWindowGone = (): void => {
    if (this.dispose()) this.hooks.closed();
  };

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (!event.metaKey && !event.ctrlKey) this.hooks.keydown(event);
  };

  /** Returns false when already done. */
  private dispose(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    saveBounds({
      width: this.win.outerWidth,
      height: this.win.outerHeight,
      left: this.win.screenX,
      top: this.win.screenY,
    });
    this.observers.forEach(o => o.disconnect());
    this.win.removeEventListener('pagehide', this.onWindowGone);
    window.removeEventListener('pagehide', this.close);
    this.outlet.dispose();
    return true;
  }

  private copySheet(node: Node): void {
    if (!(node instanceof HTMLStyleElement || (node instanceof HTMLLinkElement && node.relList.contains('stylesheet')))) {
      return;
    }
    const copy = node.cloneNode(true);
    if (node instanceof HTMLLinkElement) (copy as HTMLLinkElement).href = node.href;
    this.win.document.head.appendChild(copy);
    this.sheetCopies.set(node, copy);
  }

  private mirrorAttributes(from: HTMLElement, to: HTMLElement): void {
    const sync = () => {
      for (const name of THEME_ATTRIBUTES) {
        const value = from.getAttribute(name);
        if (value === null) to.removeAttribute(name);
        else to.setAttribute(name, value);
      }
    };
    sync();
    this.observe(from, { attributes: true, attributeFilter: THEME_ATTRIBUTES }, sync);
  }

  private observe(target: Node, options: MutationObserverInit, callback: MutationCallback): void {
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    this.observers.push(observer);
  }
}

/** Beside Scout (inside the screen), its full height, the first time. */
function defaultBounds(): WindowBounds {
  const screenLeft = (window.screen as Screen & { availLeft?: number }).availLeft ?? 0;
  return {
    width: DEFAULT_WIDTH,
    height: window.outerHeight,
    left: Math.min(window.screenX + window.outerWidth, screenLeft + window.screen.availWidth - DEFAULT_WIDTH),
    top: window.screenY,
  };
}

function featuresFor(b: WindowBounds): string {
  return `popup,width=${b.width},height=${b.height},left=${b.left},top=${b.top}`;
}

function loadBounds(): WindowBounds | null {
  try {
    const saved = JSON.parse(localStorage.getItem(BOUNDS_KEY) ?? 'null') as Partial<WindowBounds> | null;
    if (saved && [saved.width, saved.height, saved.left, saved.top].every(Number.isFinite)) {
      return saved as WindowBounds;
    }
  } catch {
    // Unreadable: the default placement.
  }
  return null;
}

function saveBounds(bounds: WindowBounds): void {
  try {
    localStorage.setItem(BOUNDS_KEY, JSON.stringify(bounds));
  } catch {
    // A convenience; the next window opens beside Scout instead.
  }
}
