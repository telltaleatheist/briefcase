import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  CRUCIBLE_REQUIRED_CODE,
  CRUCIBLE_TASK_TYPES,
  type CrucibleReadinessAction,
  type CrucibleReadinessView,
  type CrucibleRequiredRefusal,
} from '@crucible-wire/readiness-wire';
import { getApiBase } from '../core/runtime-url';
import { WebsocketService } from './websocket.service';

/** The label of the one button that repairs a not-ready state. */
export function readinessDoorLabel(action: CrucibleReadinessAction): string | null {
  switch (action) {
    case 'start': return 'Start Crucible';
    case 'install': return 'Install Crucible';
    case 'connect': return 'Connect a Crucible server';
    default: return null;
  }
}

/** The queue task types that need Crucible (frontend names included: 'ai-analyze' is 'analyze'). */
export function taskNeedsCrucible(type: string): boolean {
  return type === 'ai-analyze' || CRUCIBLE_TASK_TYPES.includes(type);
}

/**
 * IS CRUCIBLE THERE FOR AI WORK, in the renderer (P7).
 *
 * The one source every AI gate reads: the backend's `GET /crucible/readiness`
 * when first injected, then `crucible.readiness` socket pushes, re-read after every
 * socket reconnect. Nothing non-AI reads this, and nothing waits on it: until
 * the first answer arrives `view()` is null and `ready()` is false, which only
 * affects AI affordances.
 *
 * `prompt` is the global "bring Crucible up?" card's own switch: it opens when
 * an AI action needs Crucible (a gate, a 409, or parked AI tasks) and the user
 * has not said "Not now" this session.
 */
@Injectable({ providedIn: 'root' })
export class CrucibleReadinessService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly websocket = inject(WebsocketService);
  private readonly base = `${getApiBase()}/crucible/readiness`;

  readonly view = signal<CrucibleReadinessView | null>(null);
  readonly ready = computed(() => this.view()?.state === 'ready');
  readonly starting = computed(() => this.view()?.state === 'starting');
  readonly declined = computed(() => this.view()?.declined === true);
  readonly action = computed<CrucibleReadinessAction>(() => this.view()?.action ?? null);
  readonly doorLabel = computed(() => readinessDoorLabel(this.action()));
  /** Why AI actions are unavailable, for a tooltip or subtitle. Empty when ready. */
  readonly reason = computed(() => {
    const v = this.view();
    if (!v) return 'Checking whether Crucible is running…';
    return v.state === 'ready' ? '' : v.reason;
  });

  /** An AI action asked for Crucible this session (a gate click or a 409). */
  private readonly asked = signal(false);
  /** The last `crucible_required` refusal's sentence, shown on the prompt. */
  readonly refusalMessage = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  /** Whether the global prompt card shows. */
  readonly prompt = computed(() => {
    const v = this.view();
    if (!v || v.state === 'ready' || v.declined) return false;
    return v.aiWaiting > 0 || this.asked();
  });

  constructor() {
    this.websocket.onCrucibleReadiness((view) => this.apply(view));
    let wasConnected = this.websocket.connected();
    effect(() => {
      const connected = this.websocket.connected();
      untracked(() => {
        // Re-read after a reconnect: pushes sent while disconnected are lost.
        if (connected && !wasConnected) void this.load();
        wasConnected = connected;
      });
    });
    void this.load();
  }

  async load(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.http.get<CrucibleReadinessView>(this.base)));
    } catch {
      // The backend itself is unreachable; the view stays as it was (null = unknown).
    }
  }

  async start(): Promise<void> {
    await this.post('start');
  }

  async decline(): Promise<void> {
    this.asked.set(false);
    await this.post('decline');
  }

  async refresh(): Promise<void> {
    await this.post('refresh');
  }

  /** Does the one thing that repairs the current state. */
  async openDoor(): Promise<void> {
    this.asked.set(true);
    const action = this.action();
    if (action === 'start') {
      await this.start();
    } else if (action === 'install' || action === 'connect') {
      await this.router.navigate(['/settings/crucible']);
    }
  }

  /**
   * An AI action wanted Crucible and it is not ready: raise the prompt (unless
   * declined). Returns true when Crucible is ready and the action may proceed.
   */
  requireReady(): boolean {
    if (this.ready()) return true;
    this.asked.set(true);
    return false;
  }

  /** The body of a `crucible_required` 409, or null for any other error. */
  static refusalOf(error: unknown): CrucibleRequiredRefusal | null {
    if (!(error instanceof HttpErrorResponse) || error.status !== 409) return null;
    const body = error.error as Partial<CrucibleRequiredRefusal> | null;
    return body && body.code === CRUCIBLE_REQUIRED_CODE && typeof body.message === 'string'
      ? (body as CrucibleRequiredRefusal) : null;
  }

  /**
   * Handle an error from an AI request: a `crucible_required` refusal updates
   * the view, raises the prompt and returns its message (to show instead of a
   * generic error). Any other error returns null.
   */
  handleRefusal(error: unknown): string | null {
    const refusal = CrucibleReadinessService.refusalOf(error);
    if (!refusal) return null;
    if (refusal.readiness) this.apply(refusal.readiness);
    this.refusalMessage.set(refusal.message);
    this.asked.set(true);
    return refusal.message;
  }

  private async post(what: 'start' | 'decline' | 'refresh'): Promise<void> {
    this.error.set(null);
    try {
      this.apply(await firstValueFrom(this.http.post<CrucibleReadinessView>(`${this.base}/${what}`, {})));
    } catch (e) {
      const body = e instanceof HttpErrorResponse ? e.error as { message?: string } | null : null;
      this.error.set(typeof body?.message === 'string' ? body.message : 'Briefcase could not reach its own backend. Try again.');
    }
  }

  private apply(view: CrucibleReadinessView): void {
    this.view.set(view);
    if (view.state === 'ready') {
      this.asked.set(false);
      this.refusalMessage.set(null);
    }
  }
}
