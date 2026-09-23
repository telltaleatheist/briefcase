/**
 * IS THERE A CRUCIBLE ON THIS COMPUTER: a machine fact, offered to the pane as
 * something to add, never a server by itself.
 *
 * Ported from BookForge's electron/crucible/discovery.ts, keeping its one
 * question: what would the registry row for the Crucible on this computer look
 * like? A local server is not a different KIND of server (BookForge's ruling of
 * 2026-09-15, adopted for Briefcase 2026-09-23); it becomes a row only through
 * the same add door every other server uses, and refusing the offer is an
 * ordinary state.
 *
 * ONE DOOR, NOT BOOKFORGE'S TWO. BookForge also reads `config.toml`, through
 * `wsl.exe` on Windows, and crucible docs/PHASE15-HOST.md §3.6 dates that door
 * ("deleted when the host lands"). Every Crucible Briefcase can meet (1.0.x)
 * writes the pairing file, including the Windows host, so Briefcase reads only
 * that, and needs no TOML parser and no WSL distro setting.
 */
import { maskToken, originKey } from './registry';
import {
  CruciblePairingFileError,
  processPairingFileHost,
  readCruciblePairingFile,
  type PairingFileHost,
  type PairingFileReading,
} from './pairing-file';
import type { DiscoveredCrucibleRow } from './wire/settings-wire';

/**
 * The offer row, or the named reason there is nothing to offer. Never throws
 * for "none"; a malformed pairing file is reported by its own code.
 */
export function discoveredRow(
  registered: readonly { name: string; url: string }[],
  host: PairingFileHost = processPairingFileHost(),
): DiscoveredCrucibleRow {
  let found: PairingFileReading | null;
  try {
    found = readCruciblePairingFile(host);
  } catch (err) {
    if (err instanceof CruciblePairingFileError) {
      return { present: false, code: err.code, reason: err.message };
    }
    throw err;
  }
  if (found === null) {
    return {
      present: false,
      code: 'no_local_config',
      reason: 'There is no Crucible on this computer. Connect to one on another computer, '
        + 'or install one here.',
    };
  }
  const origin = originKey(found.pairing.url);
  const already = registered.find((row) => originKey(row.url) === origin);
  return {
    present: true,
    serverName: found.pairing.name,
    url: found.pairing.url,
    tokenMasked: maskToken(found.pairing.token),
    file: found.file,
    registeredAs: already === undefined ? null : already.name,
  };
}
