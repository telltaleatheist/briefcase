/**
 * THE NEVER-OLDER GATE (INSTALL-UNINSTALL.md §6.5.3; migration plan §5.2).
 * One Crucible per machine, shared: never downgrade it, never reinstall the same one.
 */
import { compareReleases } from '@crucible/bootstrap';
import {
  CrucibleInstallError,
  checkRelease,
  driveCrucibleInstall,
  releaseToInstall,
  type BootstrapSurface,
  type CrucibleReleaseSources,
} from '../../src/crucible/install/install';
import { newestRelease, parseNewestRelease, RELEASES_URL } from '../../src/crucible/install/channel';
import './helpers';

const sources = (latest: string, running: string | null): CrucibleReleaseSources => ({
  latest: async () => latest,
  running: async () => running,
  compare: compareReleases,
});

async function refusalCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    return (err as CrucibleInstallError).code;
  }
  throw new Error('expected a refusal');
}

describe('releaseToInstall', () => {
  it('nothing running: installs the channel\'s latest', async () => {
    await expect(releaseToInstall(sources('1.0.23', null))).resolves.toBe('1.0.23');
  });

  it('the channel is newer: installs it (the upgrade path)', async () => {
    await expect(releaseToInstall(sources('1.0.24', '1.0.23'))).resolves.toBe('1.0.24');
  });

  it('the same version is running: crucible_already_latest', async () => {
    expect(await refusalCode(releaseToInstall(sources('1.0.23', '1.0.23')))).toBe('crucible_already_latest');
  });

  it('a NEWER Crucible is running than the channel offers: install_older_than_running', async () => {
    expect(await refusalCode(releaseToInstall(sources('1.0.22', '1.0.23')))).toBe('install_older_than_running');
    expect(await refusalCode(releaseToInstall(sources('1.0.9', '1.0.23')))).toBe('install_older_than_running');
  });

  it('a channel that will not answer is a refusal by name, never a fallback', async () => {
    const unreadable = Object.assign(new Error('could not read the release channel'), { code: 'release_channel_unreadable' });
    const check = await checkRelease({ latest: async () => { throw unreadable; }, running: async () => null, compare: compareReleases });
    expect(check).toMatchObject({ action: 'unknown', refusal: { code: 'release_channel_unreadable' } });
  });

  it('checkRelease answers the same four rows as values', async () => {
    expect(await checkRelease(sources('1.0.23', null))).toEqual({ action: 'install', latest: '1.0.23', running: null });
    expect(await checkRelease(sources('1.0.24', '1.0.23'))).toEqual({ action: 'upgrade', latest: '1.0.24', running: '1.0.23' });
    expect(await checkRelease(sources('1.0.23', '1.0.23'))).toMatchObject({ action: 'none', code: 'crucible_already_latest' });
    expect(await checkRelease(sources('1.0.22', '1.0.23'))).toMatchObject({ action: 'none', code: 'install_older_than_running' });
  });
});

describe('driveCrucibleInstall and the gate', () => {
  const runner = { platform: 'darwin' } as never;
  const noisyBootstrap = (): BootstrapSurface & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      install: async () => { calls.push('install'); throw new Error('must not be reached'); },
      startLocal: async () => { calls.push('startLocal'); throw new Error('must not be reached'); },
    };
  };

  it.each([
    ['1.0.23', '1.0.23', 'crucible_already_latest'],
    ['1.0.22', '1.0.23', 'install_older_than_running'],
  ])('channel %s over running %s: refused %s, and nothing is spawned', async (latest, running, code) => {
    const bootstrap = noisyBootstrap();
    expect(await refusalCode(driveCrucibleInstall({ jobTypes: ['echo'], onLine: () => undefined }, { bootstrap, runner, sources: sources(latest, running) }))).toBe(code);
    expect(bootstrap.calls).toEqual([]);
  });

  it('an engine configured here that will not say its version stops the install (not treated as absent)', async () => {
    const bootstrap = noisyBootstrap();
    const running = async (): Promise<string | null> => { throw Object.assign(new Error('connection refused'), { code: 'unreachable' }); };
    await expect(driveCrucibleInstall({ jobTypes: ['echo'], onLine: () => undefined }, {
      bootstrap, runner, sources: { latest: async () => '1.0.24', running, compare: compareReleases },
    })).rejects.toThrow('connection refused');
    expect(bootstrap.calls).toEqual([]);
  });

  it('installs the release the gate chose, whatever the options said', async () => {
    const seen: Array<string | undefined> = [];
    const bootstrap: BootstrapSurface = {
      install: async (options) => {
        seen.push(options.release);
        return { steps: [], server: { name: 'crucible@here', url: 'http://127.0.0.1:7100', configPath: '/x' }, release: '1.0.24', backend: 'mlx-darwin', crucible: '/x' };
      },
      startLocal: async () => ({ schema_version: 1, state: 'running', name: 'crucible@here', url: 'http://127.0.0.1:7100', detail: 'ok' }),
    };
    await driveCrucibleInstall({ jobTypes: ['echo'], onLine: () => undefined, release: '0.0.1' }, { bootstrap, runner, sources: sources('1.0.24', '1.0.23') });
    expect(seen).toEqual(['1.0.24']);
  });
});

describe('the release channel: the NEWEST release, prereleases included', () => {
  const page = (rows: Array<{ tag_name: string; prerelease?: boolean; draft?: boolean }>) => JSON.stringify(rows);
  const fetchOf = (status: number, body: string): typeof fetch =>
    (async (url: string) => {
      expect(url).toBe(RELEASES_URL);
      return new Response(body, { status });
    }) as unknown as typeof fetch;

  it('a prerelease newer than GitHub\'s promoted latest is the one offered', async () => {
    const body = page([
      { tag_name: 'v1.0.23', prerelease: true },
      { tag_name: 'v1.0.22', prerelease: false },
      { tag_name: 'v1.0.21', prerelease: false },
    ]);
    await expect(newestRelease(fetchOf(200, body))).resolves.toBe('1.0.23');
  });

  it('with that channel, nothing running installs the prerelease, and 1.0.23 running is already latest', async () => {
    const latest = () => newestRelease(fetchOf(200, page([{ tag_name: 'v1.0.23', prerelease: true }, { tag_name: 'v1.0.22' }])));
    await expect(releaseToInstall({ latest, running: async () => null, compare: compareReleases })).resolves.toBe('1.0.23');
    await expect(releaseToInstall({ latest, running: async () => '1.0.22', compare: compareReleases })).resolves.toBe('1.0.23');
    expect(await refusalCode(releaseToInstall({ latest, running: async () => '1.0.23', compare: compareReleases }))).toBe('crucible_already_latest');
  });

  it('the never-older gate still refuses when a newer engine runs than even the newest release', async () => {
    const latest = () => newestRelease(fetchOf(200, page([{ tag_name: 'v1.0.23', prerelease: true }])));
    expect(await refusalCode(releaseToInstall({ latest, running: async () => '1.0.24', compare: compareReleases }))).toBe('install_older_than_running');
  });

  it('drafts are skipped, and newest is by version, not by list order', () => {
    expect(parseNewestRelease(page([
      { tag_name: 'v1.0.25', draft: true },
      { tag_name: 'v1.0.9' },
      { tag_name: 'v1.0.24', prerelease: true },
      { tag_name: 'nightly' },
    ]))).toBe('1.0.24');
  });

  it('an unreadable list is release_channel_unreadable, never a fallback', async () => {
    await expect(newestRelease(fetchOf(503, 'down'))).rejects.toMatchObject({ code: 'release_channel_unreadable' });
    await expect(newestRelease(fetchOf(200, '{"message":"rate limited"}'))).rejects.toMatchObject({ code: 'release_channel_unreadable' });
    await expect(newestRelease(fetchOf(200, '[]'))).rejects.toMatchObject({ code: 'release_channel_unreadable' });
    const thrown = (async () => { throw new Error('ENOTFOUND api.github.com'); }) as unknown as typeof fetch;
    await expect(newestRelease(thrown)).rejects.toMatchObject({ code: 'release_channel_unreadable' });
  });
});
