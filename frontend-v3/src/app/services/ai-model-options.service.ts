import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { AiModelOption, AiModelsView, AiOptionGroup, AiResolvedValue } from '@crucible-wire/ai-wire';
import { CrucibleService, type CrucibleRefusal } from './crucible.service';
import { CrucibleReadinessService } from './crucible-readiness.service';
import { WebsocketService } from './websocket.service';

/**
 * THE AI MODEL OPTIONS, for every picker in the renderer.
 *
 * One copy of the backend's `GET /crucible/ai/models` (the connected
 * Crucible's own models that can serve the analysis class, and the models of
 * each upstream it has configured, grouped as the server presents them), and
 * what every stored choice a picker shows is among them. Nothing here knows a
 * vendor or a model: the backend decides both (model-options.ts).
 *
 * Loaded on first use, then read again when readiness or the connected server
 * changes (the `crucible.readiness` push), when the server registry changes,
 * and when a server finishes preparing Briefcase's models (a pull landed).
 * Stored values a picker shows are tracked, so a legacy spelling
 * (`ollama:qwen3.8:27b`) resolves to the option it runs as.
 */
@Injectable({ providedIn: 'root' })
export class AiModelOptionsService {
  private readonly crucible = inject(CrucibleService);
  private readonly readiness = inject(CrucibleReadinessService);

  readonly view = signal<AiModelsView | null>(null);
  readonly loading = signal(false);
  /** Why the options could not be read (the backend's sentence), or null. */
  readonly error = signal<string | null>(null);

  readonly groups = computed<AiOptionGroup[]>(() => this.view()?.groups ?? []);
  readonly options = computed<AiModelOption[]>(() => this.groups().flatMap((g) => g.options));
  /** Loaded at least once and still loading nothing: the list shown is the server's. */
  readonly loaded = computed(() => this.view() !== null);
  private readonly resolved = computed(() => new Map((this.view()?.resolved ?? []).map((r) => [r.value, r])));

  private readonly tracked = new Set<string>();
  private active = false;
  private inFlight: Promise<void> | null = null;
  private again = false;

  constructor() {
    const websocket = inject(WebsocketService);
    const destroyRef = inject(DestroyRef);
    // Readiness or the connected server changed: the list is another server's, or none.
    let lastKey: string | null = null;
    effect(() => {
      const v = this.readiness.view();
      const key = v === null ? 'unknown' : `${v.state}\n${v.server ?? ''}`;
      untracked(() => {
        if (key === lastKey) return;
        lastKey = key;
        if (this.active) void this.refresh();
      });
    });
    const offServers = websocket.onCrucibleServersChanged(() => { if (this.active) void this.refresh(); });
    const offCoordination = websocket.onCrucibleCoordination((state) => {
      if (this.active && state.phase === 'stocked') void this.refresh();
    });
    destroyRef.onDestroy(() => { offServers(); offCoordination(); });
  }

  /** Start reading options (idempotent), resolving these stored values too. */
  use(values: readonly (string | null | undefined)[] = []): void {
    let added = false;
    for (const raw of values) {
      const value = (raw ?? '').trim();
      if (value && !this.tracked.has(value)) {
        this.tracked.add(value);
        added = true;
      }
    }
    if (!this.active) {
      this.active = true;
      void this.refresh();
    } else if (added) {
      void this.refresh();
    }
  }

  /** Read the options again (after a settings save, say). */
  async refresh(): Promise<void> {
    this.active = true;
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.load().finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.inFlight;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.view.set(await firstValueFrom(this.crucible.aiModels(undefined, [...this.tracked])));
      this.error.set(null);
    } catch (error) {
      this.error.set((error as CrucibleRefusal)?.message ?? "Couldn't list the Crucible server's models.");
    } finally {
      this.loading.set(false);
    }
  }

  /** What a stored value is among the options; null until it has been asked about. Reads signals. */
  resolution(value: string | null | undefined): AiResolvedValue | null {
    const v = (value ?? '').trim();
    if (!v) return null;
    if (this.options().some((o) => o.value === v)) return { value: v, option: v, note: null, unavailable: null };
    return this.resolved().get(v) ?? null;
  }

  /** The option a stored value is (its Crucible spelling), or the value itself while unknown or unavailable. */
  canonical(value: string | null | undefined): string {
    const v = (value ?? '').trim();
    return this.resolution(v)?.option ?? v;
  }

  /** The option a stored value is, or null when it is not (yet) one. */
  optionFor(value: string | null | undefined): string | null {
    return this.resolution(value)?.option ?? null;
  }

  /** Why a stored value can't be used, or null (also null while it is still being asked about). */
  unavailable(value: string | null | undefined): string | null {
    const v = (value ?? '').trim();
    if (!v || !this.loaded()) return null;
    return this.resolution(v)?.unavailable ?? null;
  }
}
