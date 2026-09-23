/** Shared scaffolding for the Crucible specs: a temp state dir and a scripted pairing file. */
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import type { PairingFileHost } from '../../src/crucible/pairing-file';

// The services log what they do; a spec run does not need to read it.
Logger.overrideLogger(false);

export function tempDir(prefix = 'crucible-spec-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A pairing host whose one file is `text` (or absent when null), at ~/.crucible/pairing under `home`. */
export function pairingHost(text: string | null, home = '/home/spec'): PairingFileHost {
  return {
    platform: 'darwin',
    env: {},
    homedir: home,
    readFile: (file) => (file === path.posix.join(home, '.crucible', 'pairing') ? text : null),
  };
}

/** A pairing file's one line, as `crucible init` writes it: name and token percent-encoded, trailing newline. */
export function pairingLineFor(name: string, url: string, token: string): string {
  return `crucible://${encodeURIComponent(name)}@${new URL(url).host}/#${encodeURIComponent(token)}\n`;
}
