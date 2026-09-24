/**
 * THE SEAM every other part of the backend uses to reach a Crucible server.
 *
 * Three methods whose signatures are an agreement with other branches (the
 * Crucible transcription work rebases onto this one), so they do not change
 * shape:
 *
 *   list(): {name, url, added}[]            no token, ever
 *   get(name): {name, url, token}           for code that must authenticate
 *   clientFor(name): Promise<CrucibleClient> clientName 'briefcase', engine-resolved
 *
 * Behind it: `<userData>/crucible-servers.json` (`{servers: [{name, url, token,
 * added}]}`, BookForge's shape) and `<userData>/crucible-routing.json`
 * (`{selected}`), where `<userData>` is `getBriefcaseConfigDir()`,
 * owned by the NestJS backend. The extra methods (select, add, remove)
 * are the same records the Settings pane writes; the pane itself goes through
 * CrucibleController.
 */
import { Injectable } from '@nestjs/common';
import type { CrucibleClient } from '@crucible/client';
import { CrucibleClientFactory } from './client-factory';
import { CrucibleRegistryService } from './registry.service';
import type { RoutingView } from './wire/settings-wire';

export interface CrucibleServerListing {
  name: string;
  url: string;
  added: string;
}

export interface CrucibleServerCredentials {
  name: string;
  url: string;
  token: string;
}

@Injectable()
export class CrucibleServersService {
  constructor(
    private readonly registry: CrucibleRegistryService,
    private readonly factory: CrucibleClientFactory,
  ) {}

  /** Every registered server, in the order they were added. No token. */
  list(): CrucibleServerListing[] {
    return this.registry.list().map(({ name, url, added }) => ({ name, url, added }));
  }

  /** One server with its token, by exact name. Throws `unknown_server` by name. Never hand this to the renderer. */
  get(name: string): CrucibleServerCredentials {
    const { url, token } = this.registry.getWithToken(name);
    return { name, url, token };
  }

  /** A client bound to the engine behind a registered server (one orchestrator hop at most). */
  clientFor(name: string): Promise<CrucibleClient> {
    return this.factory.clientFor(name);
  }

  // ── extras: the same records the Settings pane writes ────────────────

  /** The server all work goes to. Throws `no_selected_server` by name when there is none. */
  selected(): string {
    return this.registry.selected();
  }

  routing(): RoutingView {
    return this.registry.routingView();
  }

  add(server: CrucibleServerCredentials): CrucibleServerListing {
    const { name, url, added } = this.registry.add(server);
    return { name, url, added };
  }

  remove(name: string): CrucibleServerListing {
    const { url, added } = this.registry.remove(name);
    return { name, url, added };
  }

  select(name: string): RoutingView {
    return this.registry.select(name);
  }
}
