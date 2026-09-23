/**
 * THE ONLY PLACE A CRUCIBLE TOKEN MEETS THE SDK.
 *
 * Every `CrucibleClient` in the backend is built by {@link makeClient} below,
 * and a spec greps the source to keep it that way. Callers hold a server NAME;
 * the factory reads the token from the registry at call time, so a token never
 * sits in a service field, a cache or a log line, and nothing that answers the
 * renderer can reach it.
 *
 * `clientName` is 'briefcase' on every client. It lands in the User-Agent and
 * `X-Crucible-Client`, which is what `/v1/activity` reports as a job's
 * `client`, so a Crucible shared with BookForge and Foundry can say whose work
 * is on the card. One name, declared once.
 */
import { Injectable } from '@nestjs/common';
import { CrucibleClient } from '@crucible/client';
import { CrucibleRegistryService } from './registry.service';
import { EngineResolver, type ClientMaker, type ResolvedEngine } from './engine-resolve';

export const CRUCIBLE_CLIENT_NAME = 'briefcase';

export interface ClientOptions {
  /**
   * A deadline on EVERY call the client makes. For probes only: it would also
   * cut off an SSE stream or a long chat, so work clients are built without it.
   */
  timeoutMs?: number;
}

/** The single `new CrucibleClient` in the backend. */
const makeClient: ClientMaker = (url, token, options) =>
  new CrucibleClient({
    url,
    token,
    clientName: CRUCIBLE_CLIENT_NAME,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

@Injectable()
export class CrucibleClientFactory {
  private readonly resolver = new EngineResolver(makeClient);

  constructor(private readonly registry: CrucibleRegistryService) {
    // A removed or re-added server must never be answered from a stale hop.
    registry.onChange((change) => this.resolver.forget(change.server ?? undefined));
  }

  /**
   * A client bound to the ENGINE behind a registered server: the one to send
   * work, settings and activity reads to. Follows an orchestrator's hop once.
   */
  async clientFor(name: string, options?: ClientOptions): Promise<CrucibleClient> {
    return this.resolver.engineClientFor(this.registry.getWithToken(name), options);
  }

  /** The engine a registered address resolves to (cached 60 s). */
  async resolve(name: string): Promise<ResolvedEngine> {
    return this.resolver.resolve(this.registry.getWithToken(name));
  }

  /** A client at the address the user registered, with no hop. For probing that address itself. */
  addressClientFor(name: string, options?: ClientOptions): CrucibleClient {
    const entry = this.registry.getWithToken(name);
    return makeClient(entry.url, entry.token, options);
  }

  /**
   * A client for credentials that are not registered yet: a pairing file, a
   * pasted connect code or an approved device-code pairing, probed BEFORE the
   * registry is written. The credentials come from the backend's own reads,
   * never from the renderer.
   */
  clientForCredentials(url: string, token: string, options?: ClientOptions): CrucibleClient {
    return makeClient(url, token, options);
  }

  /** Engine resolution for unregistered credentials, uncached. */
  async resolveCredentials(url: string, token: string): Promise<ResolvedEngine> {
    return new EngineResolver(makeClient).resolve({ name: url, url, token });
  }

  /** Drop every cached hop (a spec, or a Re-check button). */
  forgetResolved(name?: string): void {
    this.resolver.forget(name);
  }
}
