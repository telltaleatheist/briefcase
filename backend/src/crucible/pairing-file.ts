/**
 * THE CONNECT CODE THE ENGINE ON THIS MACHINE LEFT FOR AN APP TO FIND.
 *
 * crucible docs/PHASE15-HOST.md §3.6 and §5.1: `crucible init`, `crucible
 * service install` and the Windows host write the pairing line to a user-only
 * file, so an app on the same machine connects without anyone typing a token.
 *
 * Ported from BookForge's electron/crucible/pairing-file.ts. It is this
 * module's own SYNCHRONOUS execution of the SDK's one path rule, not a second
 * opinion: the three names the path is composed from are the SDK's constants.
 * The SDK's `readPairingFile` is async for a bundling reason that does not
 * apply here, and the pane's discovery row composes this beside other
 * synchronous reads.
 *
 * `null` IS THE ANSWER, NOT A GAP. No file means no engine here (a laptop that
 * only uses the PC's Crucible is not broken). A file that EXISTS and is not one
 * connect code throws by name: reading it as "no engine" would send someone to
 * install a second one over the top of one that is already running.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CRUCIBLE_HOME_ENV as SDK_CRUCIBLE_HOME_ENV,
  PAIRING_FILE as SDK_PAIRING_FILE,
  WINDOWS_HOME_DIRNAME as SDK_WINDOWS_HOME_DIRNAME,
  parsePairing,
  type Pairing,
} from '@crucible/client';

export const CRUCIBLE_HOME_ENV = SDK_CRUCIBLE_HOME_ENV;
export const PAIRING_FILE_NAME = SDK_PAIRING_FILE;
export const WINDOWS_HOME_DIRNAME = SDK_WINDOWS_HOME_DIRNAME;

export type CruciblePairingFileErrorCode =
  /** Windows with no `%LOCALAPPDATA%`: refused rather than assembled from a username. */
  | 'no_local_app_data'
  | 'pairing_file_unreadable'
  /** The file is there and empty: an interrupted write. */
  | 'pairing_file_empty'
  /** More than one non-blank line: which one is the server's is a guess. */
  | 'pairing_file_multiline'
  | 'pairing_file_invalid';

export class CruciblePairingFileError extends Error {
  constructor(readonly code: CruciblePairingFileErrorCode, message: string) {
    super(message);
    this.name = 'CruciblePairingFileError';
  }
}

/** What the reader needs, so a spec can drive every branch with no filesystem. */
export interface PairingFileHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** The file's text, or `null` when it is not there. Anything else throws. */
  readFile: (file: string) => string | null;
}

export function processPairingFileHost(): PairingFileHost {
  return {
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new CruciblePairingFileError(
          'pairing_file_unreadable',
          `${file} exists and could not be read: ${(err as Error).message}`,
        );
      }
    },
  };
}

/**
 * `$CRUCIBLE_HOME/pairing` when set, else `%LOCALAPPDATA%\Crucible\pairing` on
 * Windows, else `~/.crucible/pairing`.
 */
export function cruciblePairingFilePath(host: PairingFileHost): string {
  const override = host.env[CRUCIBLE_HOME_ENV];
  if (override !== undefined && override !== '') {
    return (host.platform === 'win32' ? path.win32 : path.posix).join(override, PAIRING_FILE_NAME);
  }
  if (host.platform === 'win32') {
    const local = host.env['LOCALAPPDATA'];
    if (local === undefined || local === '') {
      throw new CruciblePairingFileError(
        'no_local_app_data',
        'LOCALAPPDATA is not set, so there is no per-user place the Crucible host would have '
          + 'written a connect code. Paste one instead, or set CRUCIBLE_HOME.',
      );
    }
    return path.win32.join(local, WINDOWS_HOME_DIRNAME, PAIRING_FILE_NAME);
  }
  return path.posix.join(host.homedir, '.crucible', PAIRING_FILE_NAME);
}

export interface PairingFileReading {
  pairing: Pairing;
  /** The path it was read from. */
  file: string;
}

/**
 * The connect code on this machine, or `null` because there is no engine here.
 * Never throws for absence; throws, by name, for everything else.
 */
export function readCruciblePairingFile(
  host: PairingFileHost = processPairingFileHost(),
): PairingFileReading | null {
  const file = cruciblePairingFilePath(host);
  const text = host.readFile(file);
  if (text === null) return null;
  const lines = text.split(/\r?\n/).map((each) => each.trim()).filter((each) => each !== '');
  if (lines.length === 0) {
    throw new CruciblePairingFileError(
      'pairing_file_empty',
      `${file} is empty. The engine writes one connect code with a trailing newline, so an empty `
        + 'file is an interrupted write. Run `crucible token --url` on that machine again.',
    );
  }
  if (lines.length > 1) {
    throw new CruciblePairingFileError(
      'pairing_file_multiline',
      `${file} holds ${lines.length} lines and a pairing file holds exactly one. Something other `
        + 'than `crucible init` has written to it; delete it and re-run `crucible token --url`.',
    );
  }
  try {
    return { pairing: parsePairing(lines[0]!), file };
  } catch (err) {
    // parsePairing elides the token before it throws, so its sentence is safe to keep.
    throw new CruciblePairingFileError('pairing_file_invalid', `${file} is not a connect code: ${(err as Error).message}`);
  }
}
