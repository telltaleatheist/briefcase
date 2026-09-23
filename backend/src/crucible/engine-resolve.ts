/**
 * WHICH PROCESS ACTUALLY DOES THE WORK AT A REGISTERED ADDRESS: the one place
 * Briefcase follows an orchestrator's hop.
 *
 * Ported from BookForge's electron/crucible/engine-resolve.ts. crucible
 * docs/PHASE17-ORCHESTRATOR.md: a process is an `engine` (serves job types) or
 * an `orchestrator` (the Windows tray on :7101, which serves none and names
 * the engine it manages). `engineOf(info)` is the SDK's rule and is never
 * re-derived here: `null` means "this IS the engine", an `EngineRef` means
 * "follow `engine.url` ONCE, with the SAME token". The second document is
 * READ, and a second `role` that is not `engine` is refused rather than
 * followed, so a misconfigured chain cannot loop.
 *
 * The cache is keyed on NAME + URL and never holds a token: the token comes
 * from the registry entry on every call, so a rotation takes effect at once.
 * Sixty seconds, with concurrent resolutions of one name sharing one request.
 *
 * This module builds no client itself: it is handed the factory's maker, so
 * client-factory.ts stays the only place a token meets the SDK.
 */
import { CrucibleProtocolError, engineOf, type CrucibleClient, type EngineRef, type ServerInfo } from '@crucible/client';

export interface EngineEntry {
  readonly name: string;
  readonly url: string;
  readonly token: string;
}

export interface ResolvedEngine {
  /** The registered name this was resolved from. */
  readonly server: string;
  /** The address that serves job types. */
  readonly url: string;
  /** The ENGINE's own `/v1/info`. */
  readonly info: ServerInfo;
  /** The orchestrator that was followed, or null when the address is the engine. */
  readonly through: EngineRef | null;
}

/** Builds a client for a url and token. The factory's; see the header. */
export type ClientMaker = (url: string, token: string, options?: { timeoutMs?: number }) => CrucibleClient;

export const RESOLVE_TTL_MS = 60_000;
/** The clock on each `info()` a resolution makes: a sleeping machine answers nothing for minutes. */
export const RESOLVE_PROBE_MS = 5_000;

export class EngineResolveError extends Error {
  constructor(readonly code: 'crucible_orchestrator_has_no_engine' | 'crucible_orchestrator_chain', message: string) {
    super(`${code}: ${message}`);
    this.name = 'EngineResolveError';
  }
}

interface CacheRow {
  readonly key: string;
  readonly at: number;
  readonly resolved: ResolvedEngine;
}

export class EngineResolver {
  private readonly byName = new Map<string, CacheRow>();
  private readonly inFlight = new Map<string, { key: string; promise: Promise<ResolvedEngine> }>();

  constructor(private readonly make: ClientMaker, private readonly now: () => number = Date.now) {}

  /** Forget one resolution, or all. Called whenever the registry changes. */
  forget(name?: string): void {
    if (name === undefined) {
      this.byName.clear();
      this.inFlight.clear();
      return;
    }
    this.byName.delete(name);
    this.inFlight.delete(name);
  }

  async resolve(entry: EngineEntry): Promise<ResolvedEngine> {
    const key = `${entry.name}\n${entry.url}`;
    const cached = this.byName.get(entry.name);
    if (cached !== undefined && cached.key === key && this.now() - cached.at < RESOLVE_TTL_MS) {
      return cached.resolved;
    }
    if (cached !== undefined && cached.key !== key) this.byName.delete(entry.name);

    const running = this.inFlight.get(entry.name);
    if (running !== undefined && running.key === key) return running.promise;

    const request: Promise<ResolvedEngine> = this.resolveNow(entry)
      .then((resolved) => {
        if (this.inFlight.get(entry.name)?.promise === request) {
          this.byName.set(entry.name, { key, at: this.now(), resolved });
        }
        return resolved;
      })
      .finally(() => {
        if (this.inFlight.get(entry.name)?.promise === request) this.inFlight.delete(entry.name);
      });
    this.inFlight.set(entry.name, { key, promise: request });
    return request;
  }

  private async resolveNow(entry: EngineEntry): Promise<ResolvedEngine> {
    const front = await this.make(entry.url, entry.token).info({ timeoutMs: RESOLVE_PROBE_MS });
    let ref: EngineRef | null;
    try {
      ref = engineOf(front);
    } catch (err) {
      if (err instanceof CrucibleProtocolError) {
        throw new EngineResolveError(
          'crucible_orchestrator_has_no_engine',
          `"${entry.name}" (${entry.url}) is a Crucible orchestrator that manages no engine, so there is nothing there to do work.`,
        );
      }
      throw err;
    }
    if (ref === null) return { server: entry.name, url: entry.url, info: front, through: null };
    const behind = await this.make(ref.url, entry.token).info({ timeoutMs: RESOLVE_PROBE_MS });
    if (behind.role !== 'engine') {
      throw new EngineResolveError(
        'crucible_orchestrator_chain',
        `"${entry.name}" (${entry.url}) is an orchestrator whose engine at ${ref.url} answers "${behind.role}", not "engine". `
          + 'Briefcase follows one hop and no more.',
      );
    }
    return { server: entry.name, url: ref.url, info: behind, through: ref };
  }

  /** A client bound to the ENGINE behind a registered address. */
  async engineClientFor(entry: EngineEntry, options?: { timeoutMs?: number }): Promise<CrucibleClient> {
    const resolved = await this.resolve(entry);
    return this.make(resolved.url, entry.token, options);
  }
}
