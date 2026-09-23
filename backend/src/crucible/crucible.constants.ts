/** Injection tokens for the Crucible module, so specs can point it at a temp dir and a fake clipboard. */

/** The directory holding crucible-servers.json and crucible-routing.json. */
export const CRUCIBLE_STATE_DIR = Symbol('CRUCIBLE_STATE_DIR');

/** Where the pairing file is read from (a `PairingFileHost`). */
export const CRUCIBLE_PAIRING_HOST = Symbol('CRUCIBLE_PAIRING_HOST');

/** Writes text to the system clipboard (a `ClipboardWriter`). */
export const CRUCIBLE_CLIPBOARD = Symbol('CRUCIBLE_CLIPBOARD');
