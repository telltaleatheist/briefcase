/**
 * IS CRUCIBLE THERE FOR AI WORK: the one readiness signal (P7).
 *
 * Briefcase has no AI of its own (the user's rule, 2026-09-23: "No fallbacks.
 * If Crucible is down, Briefcase is down. Briefcase attempts/asks to bring
 * Crucible up. If the user refuses or we otherwise can't, the user just can't
 * take any actions that would require Crucible."). This service answers, in
 * one place, whether an AI action can run and what repairs it when it cannot,
 * derived from the P1 registry and probe and the P2 local presence, and
 * pushed on Socket.IO `crucible.readiness` whenever the answer changes.
 *
 *   ready           the selected server answers (a busy card is still ready: the
 *                   work queues and parks until the holder is done).
 *   starting        Briefcase is starting (or installing) the local Crucible.
 *   unreachable     the selected server, or the one installed here, doesn't answer.
 *   not-installed   nothing registered or installed, and this computer can host one.
 *   not-configured  nothing registered and this computer cannot host one, or
 *                   no registered server is selected.
 *
 * BRINGING IT UP. When AI work is waiting on it (queued tasks parked because
 * Crucible is not there) and the Crucible on this computer is installed but
 * not running, Briefcase STARTS it (P2's `startLocal`), once per outage, and
 * says so while it does. The user can decline ("Not now"): remembered for the
 * process's life, after which nothing starts or prompts on its own; an explicit
 * Start still works.
 *
 * GATING. `assertCanQueue` refuses AI work that could never run as things
 * stand (nothing to connect to, or the user declined), with the typed
 * {@link CrucibleRequiredError}; work for a registered server that is merely
 * down (or starting) is accepted and parks until it is back. `assertReadyNow`
 * refuses an immediate AI call unless a server answers.
 *
 * BOOT. Nothing is awaited at boot: the first derivation is a timer started in
 * onApplicationBootstrap. Until it lands, `current()` answers from the registry
 * alone, reading no network.
 */
import { HttpException, HttpStatus, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { WebSocketService } from '../common/websocket.service';
import { CrucibleServersService } from './crucible-servers.service';
import { CrucibleInstallService } from './install/install.service';
import { CrucibleProbeService } from './probe';
import { CrucibleRegistryService } from './registry.service';
import type { CrucibleEnginePresence, CrucibleInstallPlan } from './wire/install-wire';
import {
  CRUCIBLE_REQUIRED_CODE,
  CRUCIBLE_TASK_TYPES,
  type CrucibleReadinessView,
  type CrucibleRequiredRefusal,
} from './wire/readiness-wire';
import type { RoutingView } from './wire/settings-wire';

/** How often the answer is derived again on its own: often while AI can't run, rarely while it can. */
export const READINESS_REFRESH_MS = { notReady: 10_000, ready: 30_000 } as const;
/** The install plan (host facts: nvidia-smi on Linux) is read at most this often. */
const PLAN_CACHE_MS = 5 * 60_000;
/** The local engine's own status (a CLI call) is read at most this often. */
const PRESENCE_CACHE_MS = 15_000;

/**
 * An action that needs Crucible, refused because Crucible is not there: HTTP
 * 409, body {@link CrucibleRequiredRefusal} (the global filter carries `code`
 * and `readiness` through).
 */
export class CrucibleRequiredError extends HttpException {
  readonly readiness: CrucibleReadinessView;
  constructor(what: string, readiness: CrucibleReadinessView) {
    const body: CrucibleRequiredRefusal = {
      code: 'crucible_required',
      message: `${what} needs Crucible. ${readiness.reason}`,
      readiness,
    };
    super(body, HttpStatus.CONFLICT);
    this.name = 'CrucibleRequiredError';
    this.readiness = readiness;
  }
}

export function isCrucibleRequired(error: unknown): error is CrucibleRequiredError {
  return error instanceof CrucibleRequiredError
    || ((error as { response?: { code?: unknown } } | null)?.response?.code === CRUCIBLE_REQUIRED_CODE);
}

/** The task types among `tasks` that need Crucible. */
export function crucibleTasksIn(tasks: ReadonlyArray<{ type: string }> | undefined): string[] {
  return (tasks ?? []).map((t) => t.type).filter((type) => CRUCIBLE_TASK_TYPES.includes(type));
}

function sameView(a: CrucibleReadinessView, b: CrucibleReadinessView): boolean {
  const { at: _a, ...x } = a;
  const { at: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
}

@Injectable()
export class CrucibleReadinessService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CrucibleReadiness');
  private view: CrucibleReadinessView;
  private declined = false;
  private startingLine: string | null = null;
  /** Why the last start this process tried did not bring it up, said until the next derivation that finds it up. */
  private startFailure: string | null = null;
  /** One automatic start per outage: reset when Crucible is ready again. */
  private autoStartTried = false;
  private aiWaiting = 0;
  private timer: NodeJS.Timeout | null = null;
  private deriving: Promise<CrucibleReadinessView> | null = null;
  private deriveAgain = false;
  private planCache: { at: number; plan: CrucibleInstallPlan } | null = null;
  private presenceCache: { at: number; presence: CrucibleEnginePresence } | null = null;
  private stopped = false;
  private offRegistry: (() => void) | null = null;
  private readonly listeners = new Set<(view: CrucibleReadinessView) => void>();

  /** Replaceable by a spec. */
  now: () => number = Date.now;
  refreshMs: { notReady: number; ready: number } = { ...READINESS_REFRESH_MS };

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly probes: CrucibleProbeService,
    private readonly registry: CrucibleRegistryService,
    private readonly install: CrucibleInstallService,
    @Optional() private readonly ws?: WebSocketService,
  ) {
    this.view = this.provisional();
  }

  onApplicationBootstrap(): void {
    this.offRegistry = this.registry.onChange(() => this.refreshSoon());
    // Never awaited: boot does not wait on Crucible.
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.offRegistry?.();
    this.offRegistry = null;
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /** The latest answer, synchronously (no network). */
  current(): CrucibleReadinessView {
    return this.view;
  }

  /** Every change of the answer, in process (the queue listens). Returns the unsubscribe. */
  onChange(listener: (view: CrucibleReadinessView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Derive the answer again now (a Test button, the renderer's refresh). */
  async refresh(): Promise<CrucibleReadinessView> {
    if (this.deriving) {
      this.deriveAgain = true;
      return this.deriving;
    }
    this.deriving = (async () => {
      let view: CrucibleReadinessView;
      do {
        this.deriveAgain = false;
        view = await this.derive().catch((err: unknown) => this.answer('unreachable', `Crucible's state could not be read (${(err as Error)?.message ?? err}).`, 'connect'));
      } while (this.deriveAgain);
      this.publish(view);
      return view;
    })().finally(() => {
      this.deriving = null;
      this.schedule(this.view.state === 'ready' ? this.refreshMs.ready : this.refreshMs.notReady);
    });
    return this.deriving;
  }

  // ── gating ─────────────────────────────────────────────────────────────

  /**
   * Refuse queueing AI work that could never run as things stand: nothing to
   * connect to (not installed, not configured, every server paused), or the
   * user declined bringing Crucible up. A registered server that is down, or
   * one being started, is not a refusal: the work parks until it is back.
   */
  assertCanQueue(what: string): void {
    const view = this.view;
    if (view.state === 'ready' || view.state === 'starting') return;
    if (view.state === 'unreachable' && !view.declined) return;
    throw new CrucibleRequiredError(what, view);
  }

  /** Refuse an immediate AI call (no queue to park in) unless a server answers now. */
  assertReadyNow(what: string): void {
    if (this.view.state !== 'ready') throw new CrucibleRequiredError(what, this.view);
  }

  // ── bringing it up ─────────────────────────────────────────────────────

  /** The user said "Not now": nothing starts or prompts on its own again this session. */
  decline(): CrucibleReadinessView {
    if (!this.declined) this.logger.log('Bringing Crucible up was declined for this session');
    this.declined = true;
    this.publish({ ...this.view, declined: true, at: new Date(this.now()).toISOString() });
    return this.view;
  }

  /**
   * AI work waiting on Crucible (queued tasks parked because it is not there).
   * The moment to ask, and, when the Crucible here is installed and stopped
   * and nobody declined, to start it: once per outage.
   */
  noteAiWaiting(count: number): void {
    const waiting = Math.max(0, Math.floor(count));
    if (waiting !== this.aiWaiting) {
      this.aiWaiting = waiting;
      this.publish({ ...this.view, aiWaiting: this.view.state === 'ready' ? 0 : waiting, at: new Date(this.now()).toISOString() });
    }
    if (waiting > 0 && !this.declined && !this.autoStartTried && this.view.action === 'start' && this.startingLine === null) {
      this.autoStartTried = true;
      this.logger.log(`AI work is waiting and the Crucible on this computer is not running: starting it`);
      void this.start();
    }
  }

  /**
   * Start the Crucible on this computer (P2's startLocal, which adopts it into
   * the registry when nothing is registered). Answers at once with `starting`;
   * the outcome follows on `crucible.readiness`. Never stops anything.
   */
  start(): Promise<CrucibleReadinessView> {
    if (this.startingLine !== null) return Promise.resolve(this.view);
    this.startingLine = 'Starting Crucible on this computer...';
    this.startFailure = null;
    this.publish(this.answer('starting', 'Crucible is starting on this computer.', null));
    void (async () => {
      try {
        const outcome = await this.install.startLocal();
        if (!outcome.started) {
          this.startFailure = `Crucible could not be started on this computer${outcome.detail ? ` (${outcome.detail})` : ''}.`;
          this.logger.warn(this.startFailure);
        } else {
          this.logger.log(`Crucible started on this computer${outcome.connectedAs ? `, connected as "${outcome.connectedAs}"` : ''}`);
        }
        this.presenceCache = null;
        for (const row of this.routing().servers) this.probes.test(row.name).catch(() => undefined);
      } catch (err) {
        this.startFailure = `Crucible could not be started on this computer (${(err as Error)?.message ?? err}).`;
        this.logger.warn(this.startFailure);
      } finally {
        this.startingLine = null;
        await this.refresh();
      }
    })();
    return Promise.resolve(this.view);
  }

  // ── derivation ─────────────────────────────────────────────────────────

  private routing(): RoutingView {
    try {
      return this.servers.routing();
    } catch {
      return { servers: [], selected: null, missing: null };
    }
  }

  private answer(
    state: CrucibleReadinessView['state'],
    reason: string,
    action: CrucibleReadinessView['action'],
    extra: Partial<Pick<CrucibleReadinessView, 'server' | 'busy'>> = {},
  ): CrucibleReadinessView {
    return {
      state,
      reason,
      action,
      server: extra.server ?? null,
      busy: extra.busy ?? null,
      progress: state === 'starting' ? this.startingLine ?? this.installLine() : null,
      declined: this.declined,
      aiWaiting: state === 'ready' ? 0 : this.aiWaiting,
      at: new Date(this.now()).toISOString(),
    };
  }

  /** Before the first derivation: the registry alone, no network. */
  private provisional(): CrucibleReadinessView {
    const { selected } = this.routing();
    if (selected !== null) return this.answer('unreachable', `Checking Crucible on ${selected}...`, null);
    return this.answer('not-configured', 'Checking for Crucible...', null);
  }

  private installLine(): string | null {
    const status = this.install.status();
    if (!status.running) return null;
    const last = [...status.events].reverse().find((e) => e.kind === 'step');
    return last && last.kind === 'step' ? `Installing Crucible: ${last.step}` : 'Installing Crucible...';
  }

  private plan(): CrucibleInstallPlan {
    const now = this.now();
    if (this.planCache === null || now - this.planCache.at > PLAN_CACHE_MS) this.planCache = { at: now, plan: this.install.plan() };
    return this.planCache.plan;
  }

  private async presence(): Promise<CrucibleEnginePresence | null> {
    const now = this.now();
    if (this.presenceCache !== null && now - this.presenceCache.at < PRESENCE_CACHE_MS) return this.presenceCache.presence;
    try {
      const presence = await this.install.presence();
      this.presenceCache = { at: now, presence };
      return presence;
    } catch {
      return null;
    }
  }

  private async derive(): Promise<CrucibleReadinessView> {
    if (this.startingLine !== null || this.install.status().running) {
      return this.answer('starting', this.startingLine !== null ? 'Crucible is starting on this computer.' : 'Crucible is being installed on this computer.', null);
    }
    const routing = this.routing();
    const selected = routing.selected;
    let silent: string | null = null;
    if (selected !== null) {
      const answer = await this.probes.reach(selected);
      if (answer.reach === 'ready' || answer.reach === 'busy') {
        this.autoStartTried = false;
        this.startFailure = null;
        const busy = answer.reach === 'busy' && answer.probe.outcome === 'ok' ? answer.probe.facts.busyLine : null;
        return this.answer('ready', `Crucible on ${selected} is ready${busy ? ` (${busy}; AI work waits its turn)` : ''}.`, null, { server: selected, busy });
      }
      silent = answer.probe.outcome === 'ok' ? `Crucible on ${selected} isn't answering` : answer.probe.message.replace(/[.\s]+$/, '');
    }

    const plan = this.plan();
    const here = plan.host.discovered;
    const failed = this.startFailure !== null ? ` ${this.startFailure}` : '';

    if (routing.servers.length > 0) {
      if (selected === null) {
        const why = routing.missing !== null
          ? `The selected Crucible server "${routing.missing}" isn't connected any more.`
          : 'No Crucible server is selected.';
        return this.answer('not-configured', `${why} Select one in Settings › Crucible Servers.`, 'connect');
      }
      const localName = here.present ? here.registeredAs : null;
      if (localName !== null && selected === localName) {
        const presence = await this.presence();
        if (presence?.offerStart) {
          return this.answer('unreachable', `${presence.message ?? 'Crucible is stopped on this computer.'}${failed}`, 'start');
        }
      }
      return this.answer('unreachable', `${silent}.${failed}`, 'connect');
    }

    if (here.present) {
      return this.answer('unreachable', `Crucible is installed on this computer but not connected to Briefcase.${failed}`, 'start');
    }
    if (plan.hostable === 'no') {
      return this.answer('not-configured', `${plan.hostableWhy.replace(/[.\s]+$/, '')}. Connect to a Crucible on another computer in Settings › Crucible Servers.`, 'connect');
    }
    return this.answer('not-installed', 'Crucible is not installed. Transcription and AI analysis run on it: install it, or connect to a Crucible on another computer.', 'install');
  }

  // ── publishing ─────────────────────────────────────────────────────────

  private publish(view: CrucibleReadinessView): void {
    const changed = !sameView(view, this.view);
    this.view = view;
    if (!changed) return;
    this.logger.log(`Crucible ${view.state}: ${view.reason}`);
    this.ws?.emitCrucibleReadiness(view);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (err) {
        this.logger.warn(`A readiness listener failed: ${(err as Error).message}`);
      }
    }
  }

  private refreshSoon(): void {
    this.schedule(250);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, ms);
    this.timer.unref?.();
  }
}
