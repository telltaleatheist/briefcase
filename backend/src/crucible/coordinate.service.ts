/**
 * THE ONE OWNER OF "make sure this server has what Briefcase needs".
 *
 * Ported from BookForge's electron/crucible/coordinate.ts (crucible
 * docs/INTEGRATING-AN-APP.md §4.6). There is no button: every time Briefcase
 * connects to the SELECTED Crucible (at startup, when it is added or selected,
 * after an install) it coordinates with it. A server that is not selected is
 * asked for nothing:
 *
 *   1. READ `GET /v1/info`, `GET /v1/catalog` and `GET /v1/capability`.
 *   2. Compare Briefcase's module, filtered to that server's backend, against them.
 *   3. Nothing missing: STOP. Nothing is posted. A Crucible runs one task at a
 *      time, and a no-op module would collide with BookForge's or Foundry's
 *      real one (`task_busy`).
 *   4. Something missing: post the module and follow its events.
 *
 * What can come back, and what each one does:
 *  - `task_busy`: another task is running there. FOLLOW it, never re-post;
 *    when it lands, read again from the top (it may have been the other app's
 *    module, which does not answer Briefcase's demand).
 *  - `server_busy` (`CrucibleCardHeld`): the card is held. A WAIT with the
 *    holder named verbatim, and one `GET /v1/activity` per 20 s until the card
 *    accepts work, for at most half an hour.
 *  - A refusal about the REQUEST (`invalid_module`, `unknown_subject`): fails
 *    once, by name, and is remembered for the session. The vendored module
 *    cannot change while the app runs.
 *  - Anything else: nothing was posted, and the state says why.
 *
 * It never throws: every ending is a STATE, pushed on Socket.IO
 * `crucible.coordination`, because every caller was doing something else.
 *
 * THE FIRST-RUN HOLD. While the setup wizard is open (`FirstRunGate`),
 * coordination is recorded as `deferred` and nothing is read or posted. The
 * wizard's finish releases it and coordinates the selected server. The wizard
 * does NOT wait for models: they download in the background.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import {
  CrucibleAuthError,
  CrucibleCardHeld,
  CrucibleNotACrucible,
  CrucibleRefused,
  CrucibleUnreachable,
  CrucibleVersionError,
  type CapabilityRecord,
  type CatalogRow,
  type CrucibleClient,
} from '@crucible/client';
import { WebSocketService } from '../common/websocket.service';
import { CrucibleClientFactory } from './client-factory';
import { CRUCIBLE_STATE_DIR } from './crucible.constants';
import { CrucibleFieldMissing } from './errors';
import { FirstRunGate } from './first-run';
import { followCrucibleTask, moduleForBackend, postBriefcaseModule } from './module-setup';
import { CrucibleRegistryService } from './registry.service';
import type {
  CrucibleCoordinationMap,
  CrucibleCoordinationState,
  CrucibleMissingEntry,
  CrucibleModuleProgress,
  CrucibleUnmetClass,
} from './wire/coordinate-wire';

/** Between two asks about a held card, and how many asks (half an hour). */
export const SETTLE_POLL_MS = 20_000;
export const SETTLE_POLL_ATTEMPTS = 90;

/** How long after boot the startup pass runs, so auto-connect has had its first go. */
export const STARTUP_COORDINATION_DELAY_MS = 5_000;

/** The outside world a run needs, injectable so a spec does not wait twenty real seconds. */
export interface CoordinateDeps {
  sleep(ms: number): Promise<void>;
  now(): string;
}

export const defaultCoordinateDeps: CoordinateDeps = {
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  now: () => new Date().toISOString(),
};

// ─────────────────────────────────────────────────────────────────────────────
// The comparison: the whole of "does this server have what Briefcase needs"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the module asks for that this server has not got, and what it will
 * never have. PURE over the three reads.
 *
 *  - Job types are compared on the type alone (the server's own rule: a
 *    module's install entry is skipped when the job type is installed).
 *  - Each needed CLASS is resolved through that engine's capability record:
 *    no row, or `enabled: false`, or nothing selected, is UNMET (a fact about
 *    the machine, never a download); routed upstream needs nothing; a local
 *    selection is missing exactly when that catalog says it is not installed.
 *  - Explicit subjects are filtered to this backend, exactly as the posted
 *    module is; one absent from the catalog is still missing (the post will be
 *    refused `unknown_subject` by the server, the one owner of what exists).
 *  - An `engine` row a local selection needs (llama.cpp binaries on
 *    llama-windows) is missing when not installed.
 */
export function missingForBriefcase(
  installedJobTypes: readonly string[],
  catalog: readonly CatalogRow[],
  capability: Pick<CapabilityRecord, 'backendKind' | 'classes'>,
): { missing: CrucibleMissingEntry[]; unmet: CrucibleUnmetClass[] } {
  const missing: CrucibleMissingEntry[] = [];
  const unmet: CrucibleUnmetClass[] = [];
  // Load-bearing here (the SDK reads it as informational): which module
  // entries apply is a per-backend fact, and no backend is a safe guess.
  if (capability.backendKind === null) {
    throw new CrucibleFieldMissing(null, 'backendKind (GET /v1/capability)', 'work out which parts of its module this machine needs');
  }
  const module = moduleForBackend(capability.backendKind);
  const localJobTypes = new Set<string>();

  for (const entry of module.job_types) {
    if (!installedJobTypes.includes(entry.type)) missing.push({ what: 'job-type', jobType: entry.type });
  }

  for (const need of module.needs) {
    const row = capability.classes.find((item) => item.capability === need.class);
    if (row === undefined) {
      unmet.push({
        class: need.class,
        reason: 'this engine\'s capability record does not mention it, so nothing there has decided whether it can serve it',
      });
      continue;
    }
    if (!row.enabled) {
      unmet.push({ class: need.class, reason: row.reason });
      continue;
    }
    if (row.route === 'upstream' || row.selected.includes('/')) continue;
    if (row.selected.length === 0) {
      unmet.push({ class: need.class, reason: row.reason });
      continue;
    }
    const subject = catalog.find((item) => item.id === row.selected && (item.kind === 'model' || item.kind === 'engine'));
    if (subject !== undefined && subject.jobType !== null) localJobTypes.add(subject.jobType);
    if (subject !== undefined && subject.installed) continue;
    missing.push({
      what: 'class',
      class: need.class,
      id: row.selected,
      kind: subject?.kind ?? null,
      name: subject?.name ?? null,
      jobType: subject?.jobType ?? null,
      expectedBytes: subject?.expectedBytes ?? null,
      inCatalog: subject !== undefined,
    });
  }

  for (const subject of module.subjects) {
    const row = catalog.find((item) => item.kind === subject.kind && item.id === subject.id);
    if (row !== undefined && row.installed) continue;
    missing.push({
      what: 'subject',
      kind: subject.kind,
      id: subject.id,
      name: row?.name ?? null,
      jobType: row?.jobType ?? null,
      expectedBytes: row?.expectedBytes ?? null,
      inCatalog: row !== undefined,
    });
  }

  for (const engine of catalog) {
    // An engine row that states no job type can't be tied to a local selection:
    // not listed here (a load that needs it is refused by the server, by name).
    if (engine.kind !== 'engine' || engine.installed || engine.jobType === null || !localJobTypes.has(engine.jobType)) continue;
    if (missing.some((entry) => entry.what !== 'job-type' && entry.kind === engine.kind && entry.id === engine.id)) continue;
    missing.push({
      what: 'subject', kind: engine.kind, id: engine.id, name: engine.name,
      jobType: engine.jobType, expectedBytes: engine.expectedBytes, inCatalog: true,
    });
  }
  return { missing, unmet };
}

/** Why a read did not happen, in the SDK's own words with the server named. */
export function describeRead(err: unknown, server: string): string {
  if (err instanceof CrucibleUnreachable) return `"${server}" did not answer: ${err.message}`;
  if (err instanceof CrucibleNotACrucible) return `"${server}" answered, but it is not a Crucible: ${err.message}`;
  if (err instanceof CrucibleAuthError) return `"${server}" refused Briefcase's key: ${err.message}`;
  if (err instanceof CrucibleVersionError) return `"${server}" speaks a different API version: ${err.message}`;
  if (err instanceof CrucibleRefused) return `"${server}" refused ${err.code}: ${err.message}`;
  if (err instanceof CrucibleFieldMissing) return `"${server}" did not state ${err.field}, which Briefcase needs to ${err.neededFor}`;
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

export type CoordinationListener = (state: CrucibleCoordinationState) => void;

@Injectable()
export class CrucibleCoordinationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('CrucibleCoordination');
  private readonly states = new Map<string, CrucibleCoordinationState>();
  private readonly inFlight = new Map<string, Promise<CrucibleCoordinationState>>();
  /** Servers whose module was refused about the REQUEST. Never posted again this session. */
  private readonly requestRefusals = new Map<string, { code: string; message: string }>();
  private readonly listeners = new Set<CoordinationListener>();
  private readonly gate: FirstRunGate;
  private startupTimer: NodeJS.Timeout | null = null;
  private offRegistry: (() => void) | null = null;
  /** Replaceable by a spec. */
  deps: CoordinateDeps = defaultCoordinateDeps;

  constructor(
    private readonly registry: CrucibleRegistryService,
    private readonly factory: CrucibleClientFactory,
    @Inject(CRUCIBLE_STATE_DIR) stateDir: string,
    @Optional() private readonly ws?: WebSocketService,
  ) {
    this.gate = FirstRunGate.inDir(stateDir);
  }

  /**
   * Coordinate on every connect: a server added (auto-connect, pairing, a
   * connect code, an install) that is the selected one, or a server the user
   * selects. And once at startup, for the selected server, after auto-connect
   * has had its first go. Never awaited.
   */
  onApplicationBootstrap(): void {
    this.offRegistry = this.registry.onChange((change) => {
      if ((change.reason === 'added' || change.reason === 'selected') && change.server !== null && this.isSelected(change.server)) {
        void this.request(change.server, change.reason === 'added' ? 'it was added' : 'it was selected');
      }
    });
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.coordinateAll('Briefcase started');
    }, STARTUP_COORDINATION_DELAY_MS);
    this.startupTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.startupTimer !== null) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.offRegistry?.();
    this.offRegistry = null;
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** Every state coordination holds. A server absent from it has not been asked yet. */
  all(): CrucibleCoordinationMap {
    return Object.fromEntries(this.states);
  }

  get held(): boolean {
    return this.gate.held;
  }

  onChange(listener: CoordinationListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ── the first-run hold ───────────────────────────────────────────────

  /** The setup wizard opened: hold coordination until it finishes. */
  holdForFirstRun(): { held: true } {
    this.gate.hold();
    this.logger.log('Holding Crucible coordination until setup finishes');
    return { held: true };
  }

  /**
   * The setup wizard finished or was skipped: release the hold and coordinate
   * the selected server. Not awaited: models download while the user works.
   */
  finishFirstRun(): { released: boolean; coordinating: string[] } {
    const released = this.gate.release();
    const names = this.selectedNames();
    void this.coordinateAll('setup finished');
    return { released, coordinating: names };
  }

  // ── the act ──────────────────────────────────────────────────────────

  /** Coordinate one server unless the first-run hold is on. Never throws. */
  request(server: string, why: string): Promise<CrucibleCoordinationState> {
    if (this.gate.held) {
      return Promise.resolve(this.report({ server, phase: 'deferred', reason: 'first-run' }));
    }
    this.logger.log(`Coordinating with "${server}" because ${why}`);
    return this.coordinate(server);
  }

  /** The selected server, the same way (none when nothing is selected). Resolves when the run has settled. */
  async coordinateAll(why: string): Promise<CrucibleCoordinationState[]> {
    return Promise.all(this.selectedNames().map((name) => this.request(name, why)));
  }

  /** Idempotent and concurrent-safe: a second call while one runs joins it. Ignores the hold. */
  coordinate(server: string): Promise<CrucibleCoordinationState> {
    const running = this.inFlight.get(server);
    if (running !== undefined) return running;
    const run = this.run(server)
      .catch((err: unknown) => this.report({ server, phase: 'unreachable', message: describeRead(err, server) }))
      .finally(() => { this.inFlight.delete(server); });
    this.inFlight.set(server, run);
    return run;
  }

  private selectedNames(): string[] {
    const { selected } = this.registry.routingView();
    return selected === null ? [] : [selected];
  }

  private isSelected(server: string): boolean {
    return this.registry.routingView().selected === server;
  }

  private async run(server: string): Promise<CrucibleCoordinationState> {
    if (!this.isSelected(server)) {
      return this.report({ server, phase: 'unreachable', message: `"${server}" is not the selected server in Settings › Crucible Servers, so Briefcase asks it for nothing.` });
    }
    const remembered = this.requestRefusals.get(server);
    this.report({ server, phase: 'checking' });

    let client: CrucibleClient;
    let installedJobTypes: string[];
    let catalog: CatalogRow[];
    let capability: CapabilityRecord;
    try {
      client = await this.factory.clientFor(server);
      const [info, rows, record] = await Promise.all([client.info(), client.catalog(), client.capability()]);
      installedJobTypes = info.capabilities.map((item) => item.jobType);
      catalog = rows;
      capability = record;
    } catch (err) {
      return this.report({ server, phase: 'unreachable', message: describeRead(err, server) });
    }

    let needs: { missing: CrucibleMissingEntry[]; unmet: CrucibleUnmetClass[] };
    try {
      needs = missingForBriefcase(installedJobTypes, catalog, capability);
    } catch (err) {
      return this.report({ server, phase: 'unreachable', message: describeRead(err, server) });
    }
    const { missing, unmet } = needs;
    if (missing.length === 0) {
      return this.report({ server, phase: 'stocked', checkedAt: this.deps.now(), unmet });
    }
    if (remembered !== undefined) {
      return this.report({ server, phase: 'refused', code: remembered.code, message: remembered.message });
    }
    return this.prepare(server, client, missing, unmet);
  }

  /** Post the module (or join the task already running) and follow it to the end. */
  private async prepare(
    server: string,
    client: CrucibleClient,
    missing: CrucibleMissingEntry[],
    unmet: CrucibleUnmetClass[],
  ): Promise<CrucibleCoordinationState> {
    let attempts = 0;
    const budget = { remaining: SETTLE_POLL_ATTEMPTS };
    for (;;) {
      let taskId: string;
      let followed = false;
      try {
        taskId = await postBriefcaseModule(client, server);
      } catch (err) {
        if (err instanceof CrucibleCardHeld) {
          attempts += 1;
          const holder = { fact: err.fact, who: err.who };
          const stopped = attempts >= SETTLE_POLL_ATTEMPTS;
          const waiting = this.report({ server, phase: 'waiting', missing, unmet, holder, attempts, stopped });
          if (stopped) return waiting;
          if (!(await this.waitForSettle(client, budget))) {
            return this.report({ server, phase: 'waiting', missing, unmet, holder, attempts, stopped: true });
          }
          continue;
        }
        if (err instanceof CrucibleRefused && err.code === 'task_busy') {
          const other = await this.runningTaskId(client);
          // Landed between the refusal and the listing: decide again from the reads.
          if (other === null) return this.run(server);
          taskId = other;
          followed = true;
        } else if (err instanceof CrucibleRefused) {
          this.requestRefusals.set(server, { code: err.code, message: err.message });
          return this.report({ server, phase: 'refused', code: err.code, message: err.message });
        } else {
          return this.report({ server, phase: 'unreachable', message: describeRead(err, server) });
        }
      }

      const first: CrucibleModuleProgress = {
        server, taskId, state: 'running', step: null, line: null, bytes: null, skipped: null, jobTypes: null, error: null, unmet: null,
      };
      this.report({ server, phase: 'preparing', missing, unmet, progress: first, followed });
      let last: CrucibleModuleProgress;
      try {
        last = await followCrucibleTask(client, server, taskId, (progress) => {
          this.report({ server, phase: 'preparing', missing, unmet, progress, followed });
        });
      } catch (err) {
        return this.report({ server, phase: 'unreachable', message: describeRead(err, server) });
      }
      // Somebody else's task landing only freed the slot: read our own demand again.
      if (followed && last.state === 'done') return this.run(server);
      return this.report({ server, phase: 'preparing', missing, unmet, progress: last, followed });
    }
  }

  /** Wait until the card accepts work, asking the server on a slow cadence. False when the budget ran out. */
  private async waitForSettle(client: CrucibleClient, budget: { remaining: number }): Promise<boolean> {
    try {
      while (budget.remaining > 0) {
        budget.remaining -= 1;
        await this.deps.sleep(SETTLE_POLL_MS);
        const activity = await client.activity();
        if (activity.slots.accelerated.acceptsWork) return true;
      }
      return false;
    } catch {
      // The settle read failed: the post that follows is the authoritative answer.
      return true;
    }
  }

  private async runningTaskId(client: CrucibleClient): Promise<string | null> {
    const tasks = await client.tasks();
    return tasks.find((task) => task.state === 'running')?.taskId ?? null;
  }

  private report(state: CrucibleCoordinationState): CrucibleCoordinationState {
    this.states.set(state.server, state);
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        this.logger.warn(`A coordination listener threw: ${(err as Error).message}`);
      }
    }
    this.ws?.emitCrucibleCoordination(state);
    return state;
  }
}
