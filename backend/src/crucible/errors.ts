/**
 * Every way Briefcase's Crucible layer refuses, each named by a `code`.
 *
 * Never a generic "something went wrong": the code says which refusal it is,
 * so the controller can map it to an HTTP status and the pane can show the
 * sentence, which always carries the fix.
 */

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
  | 'incomplete_order'
  | 'duplicate_in_order'
  | 'server_is_known'
  | 'no_enabled_server';

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
