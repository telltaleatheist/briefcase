/**
 * Every way Briefcase's Crucible layer refuses, each named by a `code`.
 *
 * Never a generic "something went wrong": the code says which refusal it is,
 * so the controller can map it to an HTTP status and the pane can show the
 * sentence, which always carries the fix.
 */
import { CrucibleProtocolError } from '@crucible/client';

export type CrucibleRegistryErrorCode =
  | 'unknown_server'
  | 'duplicate_server'
  | 'invalid_name'
  | 'invalid_url'
  | 'empty_token'
  | 'corrupt_registry';

/** A refusal from the server registry (`crucible-servers.json`). */
export class CrucibleRegistryError extends Error {
  constructor(readonly code: CrucibleRegistryErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleRegistryError';
  }
}

export type CrucibleRoutingErrorCode =
  | 'corrupt_routing'
  | 'unknown_server'
  | 'no_selected_server';

/** A refusal from the routing record (`crucible-routing.json`). */
export class CrucibleRoutingError extends Error {
  constructor(readonly code: CrucibleRoutingErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleRoutingError';
  }
}

export type CrucibleConnectErrorCode =
  /** The pasted line is not a connect code. */
  | 'invalid_pairing'
  /** The device-code request is gone: cancelled, expired or never started here. */
  | 'pairing_not_active'
  /** The pairing or connect code named a server, and probing it did not answer `ok`. */
  | 'probe_failed'
  /** There is no Crucible on this computer to adopt. */
  | 'nothing_discovered'
  /** The clipboard could not be written. */
  | 'clipboard_unavailable';

/** A refusal while adding a server. */
export class CrucibleConnectError extends Error {
  constructor(readonly code: CrucibleConnectErrorCode | string, message: string) {
    super(message);
    this.name = 'CrucibleConnectError';
  }
}

/**
 * A Crucible answered without a field Briefcase cannot work without.
 *
 * Since @crucible/client 1.0.25 the SDK reads a field it calls informational
 * as `null` when the server leaves it out ("any Crucible that answers works").
 * Most of those Briefcase renders as unknown or skips; the few it DEPENDS on
 * for correctness (the host backend a module is filtered to, say) are
 * refused here, by name, rather than guessed. A protocol error: the server
 * answered, but not with what this act needs.
 */
export class CrucibleFieldMissing extends CrucibleProtocolError {
  constructor(
    /** The server, when the caller knows it. */
    readonly server: string | null,
    /** The field as the wire spells it, with the route it came from. */
    readonly field: string,
    /** What Briefcase needed it for. */
    readonly neededFor: string,
  ) {
    super(`${server === null ? 'the Crucible server' : `"${server}"`} did not state ${field}, which Briefcase needs to ${neededFor}`);
    this.name = 'CrucibleFieldMissing';
  }
}
