import * as path from 'path';
import {
  CruciblePairingFileError,
  cruciblePairingFilePath,
  readCruciblePairingFile,
  type PairingFileHost,
} from '../../src/crucible/pairing-file';
import { discoveredRow } from '../../src/crucible/discovery';
import { pairingHost, pairingLineFor } from './helpers';

const TOKEN = 's3cret-t0ken_abcdefghijklmnopqrstuvwxyz-9876';

function host(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: Record<string, string> = {}): PairingFileHost {
  return { platform, env, homedir: platform === 'win32' ? 'C:\\Users\\owen' : '/Users/owen', readFile: (f) => files[f] ?? null };
}

describe('the pairing file path', () => {
  it('is ~/.crucible/pairing on macOS and Linux', () => {
    expect(cruciblePairingFilePath(host('darwin', {}))).toBe('/Users/owen/.crucible/pairing');
    expect(cruciblePairingFilePath(host('linux', {}))).toBe('/Users/owen/.crucible/pairing');
  });

  it('is %LOCALAPPDATA%\\Crucible\\pairing on Windows, and refuses when LOCALAPPDATA is unset', () => {
    expect(cruciblePairingFilePath(host('win32', { LOCALAPPDATA: 'C:\\Users\\owen\\AppData\\Local' })))
      .toBe('C:\\Users\\owen\\AppData\\Local\\Crucible\\pairing');
    expect(() => cruciblePairingFilePath(host('win32', {}))).toThrow(expect.objectContaining({ code: 'no_local_app_data' }));
  });

  it('honours $CRUCIBLE_HOME on every platform', () => {
    expect(cruciblePairingFilePath(host('darwin', { CRUCIBLE_HOME: '/opt/crucible' }))).toBe('/opt/crucible/pairing');
    expect(cruciblePairingFilePath(host('linux', { CRUCIBLE_HOME: '/srv/c' }))).toBe('/srv/c/pairing');
    expect(cruciblePairingFilePath(host('win32', { CRUCIBLE_HOME: 'D:\\crucible' }))).toBe('D:\\crucible\\pairing');
  });

  it('agrees with the SDK\'s own async rule on this machine', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cruciblePairingPath } = require('@crucible/client');
    const env = { ...process.env, CRUCIBLE_HOME: path.join('/tmp', 'crucible-home-spec') };
    const ours = cruciblePairingFilePath({ platform: process.platform, env, homedir: '/unused', readFile: () => null });
    const saved = process.env.CRUCIBLE_HOME;
    process.env.CRUCIBLE_HOME = env.CRUCIBLE_HOME;
    try {
      expect(await cruciblePairingPath()).toBe(ours);
    } finally {
      if (saved === undefined) delete process.env.CRUCIBLE_HOME;
      else process.env.CRUCIBLE_HOME = saved;
    }
  });
});

describe('reading the pairing file', () => {
  const file = '/Users/owen/.crucible/pairing';

  it('answers null when there is no file: no engine here is a fact, not an error', () => {
    expect(readCruciblePairingFile(host('darwin', {}))).toBeNull();
  });

  it('parses the one connect code, percent-encoded name and all', () => {
    const line = pairingLineFor('crucible@owens-mac-studio', 'http://127.0.0.1:7100', TOKEN);
    const read = readCruciblePairingFile(host('darwin', {}, { [file]: line }));
    expect(read).toEqual({ file, pairing: { name: 'crucible@owens-mac-studio', url: 'http://127.0.0.1:7100', token: TOKEN } });
  });

  it('refuses an empty file, a multi-line file and a line that is not a connect code, by name, without the token', () => {
    const cases: Array<[string, string]> = [
      ['\n\n', 'pairing_file_empty'],
      [`${pairingLineFor('a', 'http://127.0.0.1:7100', TOKEN)}${pairingLineFor('b', 'http://127.0.0.1:7101', TOKEN)}`, 'pairing_file_multiline'],
      [`crucible://127.0.0.1:7100/#${TOKEN}\n`, 'pairing_file_invalid'],
    ];
    for (const [text, code] of cases) {
      try {
        readCruciblePairingFile(host('darwin', {}, { [file]: text }));
        throw new Error(`expected ${code}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CruciblePairingFileError);
        expect((err as CruciblePairingFileError).code).toBe(code);
        expect((err as Error).message).not.toContain(TOKEN);
      }
    }
  });
});

describe('discovery: the Crucible on this computer, as an offer', () => {
  const line = pairingLineFor('crucible@owens-mac-studio', 'http://127.0.0.1:7100', TOKEN);

  it('offers it with the token masked, and says when it is already registered', () => {
    const open = discoveredRow([], pairingHost(line));
    expect(open).toMatchObject({ present: true, serverName: 'crucible@owens-mac-studio', url: 'http://127.0.0.1:7100', tokenMasked: '****9876', registeredAs: null });
    expect(JSON.stringify(open)).not.toContain(TOKEN);
    const taken = discoveredRow([{ name: 'mac', url: 'http://127.0.0.1:7100/' }], pairingHost(line));
    expect(taken).toMatchObject({ present: true, registeredAs: 'mac' });
  });

  it('names why there is nothing to offer', () => {
    expect(discoveredRow([], pairingHost(null))).toMatchObject({ present: false, code: 'no_local_config' });
    expect(discoveredRow([], pairingHost('garbage\n'))).toMatchObject({ present: false, code: 'pairing_file_invalid' });
  });
});
