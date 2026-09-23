/**
 * The registry and the routing record, as one Nest provider, announcing every
 * change on Socket.IO `crucible.servers-changed`.
 *
 * Announced where the record is WRITTEN rather than at each caller, so the
 * pane, the pairing flow and auto-connect all get it (BookForge learned this
 * the hard way: a record nobody announced is a lane nobody can use until
 * something unrelated publishes).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as path from 'path';
import { WebSocketService } from '../common/websocket.service';
import { CRUCIBLE_STATE_DIR } from './crucible.constants';
import { REGISTRY_FILE, ServerRegistry, type ResolvedServer } from './registry';
import { ROUTING_FILE, Routing } from './routing';
import type {
  CrucibleServerRow,
  CrucibleServersChangedPayload,
  RankedServerRow,
  RoutingView,
} from './wire/settings-wire';

export type RegistryListener = (change: CrucibleServersChangedPayload) => void;

@Injectable()
export class CrucibleRegistryService {
  private readonly logger = new Logger('CrucibleRegistry');
  private readonly registry: ServerRegistry;
  private readonly routing: Routing;
  private readonly listeners = new Set<RegistryListener>();

  constructor(
    @Inject(CRUCIBLE_STATE_DIR) stateDir: string,
    @Optional() private readonly ws?: WebSocketService,
  ) {
    this.registry = new ServerRegistry(path.join(stateDir, REGISTRY_FILE));
    this.routing = new Routing(path.join(stateDir, ROUTING_FILE));
  }

  /** Has a registry ever been written? An empty one may be a user who removed a server on purpose. */
  exists(): boolean {
    return this.registry.exists();
  }

  list(): CrucibleServerRow[] {
    return this.registry.list();
  }

  names(): string[] {
    return this.registry.names();
  }

  /**
   * One server WITH its token. For the client factory only: nothing that
   * answers the renderer may call this.
   */
  getWithToken(name: string): ResolvedServer {
    return this.registry.get(name);
  }

  add(server: { name: string; url: string; token: string }): CrucibleServerRow {
    const row = this.registry.add(server);
    this.logger.log(`Added Crucible server "${row.name}" at ${row.url}`);
    this.announce({ reason: 'added', server: row.name });
    return row;
  }

  /** Forget a server. Its rank is kept, reported as unknown, in case it comes back. */
  remove(name: string): CrucibleServerRow {
    const row = this.registry.remove(name);
    this.logger.log(`Removed Crucible server "${row.name}"`);
    this.announce({ reason: 'removed', server: row.name });
    return row;
  }

  routingView(): RoutingView {
    return this.routing.view(this.names());
  }

  /** Enabled servers, best first. Throws `no_enabled_server` by name when there are none. */
  rankedEnabled(): RankedServerRow[] {
    return this.routing.ranked(this.names());
  }

  setOrder(order: readonly string[]): RoutingView {
    const view = this.routing.setOrder(order, this.names());
    this.announce({ reason: 'order', server: null });
    return view;
  }

  setEnabled(name: string, enabled: boolean): RoutingView {
    const view = this.routing.setEnabled(name, enabled, this.names());
    this.announce({ reason: enabled ? 'resumed' : 'paused', server: name });
    return view;
  }

  forgetRoutingName(name: string): RoutingView {
    const view = this.routing.forget(name, this.names());
    this.announce({ reason: 'forgotten', server: name });
    return view;
  }

  /** In-process listeners (the client factory's engine cache, P4's lanes). */
  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(change: CrucibleServersChangedPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.logger.warn(`A registry listener threw: ${(err as Error).message}`);
      }
    }
    this.ws?.emitCrucibleServersChanged(change);
  }
}
