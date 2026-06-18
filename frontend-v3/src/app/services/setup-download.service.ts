import { Injectable, computed, signal } from '@angular/core';
import { ComponentService } from './component.service';
import { WebsocketService } from './websocket.service';

export type ItemStatus = 'queued' | 'downloading' | 'done' | 'failed';

interface ItemProgress {
  phase: string;
  pct: number;
  speed?: string;
  eta?: string;
}

/**
 * Coordinates download-on-demand component installs for the setup wizard and
 * the download dock. Selections are queued and drained sequentially; live
 * progress/completion comes from WebsocketService 'component.download.*' events.
 * Modeled on the Minutes setup-download store.
 */
@Injectable({ providedIn: 'root' })
export class SetupDownloadService {
  // Selection (checked component ids in the wizard)
  readonly selected = signal<Set<string>>(new Set());

  // Batch state
  readonly order = signal<string[]>([]);
  readonly currentId = signal<string | null>(null);
  readonly doneIds = signal<Set<string>>(new Set());
  readonly failed = signal<Record<string, string>>({});
  readonly progress = signal<Record<string, ItemProgress>>({});
  readonly dismissed = signal<boolean>(false);

  private draining = false;
  private resolveCurrent: (() => void) | null = null;

  readonly running = computed(() =>
    this.order().some((id) => !this.doneIds().has(id) && !this.failed()[id]),
  );

  readonly aggregatePct = computed(() => {
    const ids = this.order();
    if (ids.length === 0) return 0;
    const done = this.doneIds();
    const prog = this.progress();
    const sum = ids.reduce((acc, id) => acc + (done.has(id) ? 100 : prog[id]?.pct || 0), 0);
    return Math.round(sum / ids.length);
  });

  readonly visible = computed(() => !this.dismissed() && this.order().length > 0);

  constructor(
    private components: ComponentService,
    private ws: WebsocketService,
  ) {
    this.ws.onComponentDownloadProgress((e) => {
      this.progress.update((p) => ({
        ...p,
        [e.componentId]: { phase: e.phase, pct: e.progress, speed: e.speed, eta: e.eta },
      }));
    });
    this.ws.onComponentDownloadComplete((e) => {
      this.doneIds.update((s) => new Set(s).add(e.componentId));
      this.components.listComponents().subscribe();
      this.finishCurrent(e.componentId);
    });
    this.ws.onComponentDownloadError((e) => {
      this.failed.update((f) => ({ ...f, [e.componentId]: e.error }));
      this.finishCurrent(e.componentId);
    });
    this.ws.onComponentDownloadCancelled((e) => {
      this.failed.update((f) => ({ ...f, [e.componentId]: 'Cancelled' }));
      this.finishCurrent(e.componentId);
    });
  }

  // ---------- selection ----------
  isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  toggle(id: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  select(ids: string[]): void {
    this.selected.update((s) => {
      const next = new Set(s);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }

  // ---------- queue ----------
  /** Queue the given ids (or the current selection) and start draining. */
  enqueue(ids?: string[]): void {
    const toAdd = ids ?? Array.from(this.selected());
    const existing = new Set(this.order());
    const additions = toAdd.filter((id) => !existing.has(id));
    if (additions.length > 0) {
      this.dismissed.set(false);
      this.order.update((o) => [...o, ...additions]);
    }
    void this.drain();
  }

  cancelCurrent(): void {
    this.components.cancelComponent().subscribe();
  }

  dismiss(): void {
    if (!this.running()) {
      this.dismissed.set(true);
      this.order.set([]);
      this.doneIds.set(new Set());
      this.failed.set({});
      this.progress.set({});
    }
  }

  statusOf(id: string): ItemStatus {
    if (this.doneIds().has(id)) return 'done';
    if (this.failed()[id]) return 'failed';
    if (this.currentId() === id) return 'downloading';
    return 'queued';
  }

  pctOf(id: string): number {
    return this.doneIds().has(id) ? 100 : this.progress()[id]?.pct || 0;
  }

  private nextToRun(): string | null {
    const done = this.doneIds();
    const failed = this.failed();
    return this.order().find((id) => !done.has(id) && !failed[id]) || null;
  }

  private finishCurrent(componentId: string): void {
    if (this.currentId() === componentId && this.resolveCurrent) {
      const r = this.resolveCurrent;
      this.resolveCurrent = null;
      this.currentId.set(null);
      r();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let id: string | null;
      while ((id = this.nextToRun()) !== null) {
        this.currentId.set(id);
        await new Promise<void>((resolve) => {
          this.resolveCurrent = resolve;
          this.components.installComponent(id as string).subscribe({
            error: (err) => {
              this.failed.update((f) => ({ ...f, [id as string]: err?.message || 'Install failed' }));
              this.finishCurrent(id as string);
            },
          });
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
