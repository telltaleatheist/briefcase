/**
 * What crosses from the backend to the renderer about ADDING a Crucible server.
 *
 * Owned here, beside the code that produces it, and imported by the Angular
 * app through its `@crucible-wire/*` path alias: the backend compiles from
 * `backend/src` only, so a copy under the repository's root `shared/` could
 * not be imported by both sides. Type-only: nothing in this file may import a
 * Node module, or the renderer build would pull it in.
 *
 * NOTHING HERE CARRIES A TOKEN. A device code, a bearer token and a connect
 * line all stay in the backend; the renderer sees the short matching code and
 * masked forms, and that is a boundary, not an oversight.
 */

/** Only the short matching code crosses into the renderer. */
export interface CruciblePairingPrompt {
  requestId: string;
  /** What the server calls itself, e.g. `crucible@owens-pc`. */
  name: string;
  url: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  /** False on an engine with open pairing (the default): the first poll approves. */
  approvalRequired: boolean;
}

export type CruciblePairingDecision =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; name: string };

/** A pasted connect code, read back with the token masked. */
export type ConnectCodeReading =
  | { ok: true; name: string; url: string; tokenMasked: string }
  | { ok: false; code: 'invalid_pairing'; message: string };

/** What `POST /crucible/servers` takes. Exactly one of the three. */
export type AddServerRequest =
  /** A `crucible://name@host:port/#token` line, pasted. `name` renames it here. */
  | { connectCode: string; name?: string }
  /** The Crucible on this computer, adopted from its pairing file. */
  | { discovered: true; name?: string };

/** What a copy-connect-code call answers: the line it copied, token elided. */
export interface CopiedConnectCode {
  copied: string;
}
