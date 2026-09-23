/**
 * WHICH CRUCIBLE IS NEWEST: the question the install door asks before the
 * never-older gate compares it with what is running.
 *
 * Crucible cuts every release `--prerelease --latest=false` and promotes one to
 * GitHub's `releases/latest` only after an attested install smoke. In practice
 * `latest` lags far behind what the fleet runs (on 2026-09-23 it said 1.0.22
 * while 1.0.23 ran everywhere), so asking `releases/latest` would offer a
 * machine an engine OLDER than the one its neighbours run. The rule here is the
 * one Crucible's own installers adopted in crucible c04ef2c: ask the GitHub API
 * for the NEWEST release, prereleases included.
 *
 * Two refinements over that script's `releases?per_page=1 | head -1`:
 *  - drafts are skipped (GitHub lists them only to a caller with push access,
 *    which an app never is, but a draft is never a release to install);
 *  - "newest" is the highest VERSION among the page, not the most recently
 *    created tag, so a patch cut on an older line never outranks the head.
 *
 * NO FALLBACK: a list that cannot be read is `release_channel_unreadable`, never
 * the version this package was built at (crucible INSTALL-UNINSTALL.md §6.5.2).
 * The never-older gate in install.ts is unchanged and still refuses
 * `install_older_than_running`.
 */
import { compareReleases, RELEASE_REPO } from '@crucible/bootstrap';

/** Every release, newest first by creation; one page is plenty. Spelled once. */
export const RELEASES_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`;

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export class ReleaseChannelError extends Error {
  readonly code = 'release_channel_unreadable';
  readonly command: string | null = null;
  constructor(why: string, readonly detail: string | null = null) {
    super(`release_channel_unreadable: could not read the release list at ${RELEASES_URL}: ${why}`);
    this.name = 'ReleaseChannelError';
  }
}

/** The newest non-draft release a GitHub `releases` page names. Prereleases count. */
export function parseNewestRelease(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ReleaseChannelError(`it is not JSON (${(err as Error).message})`, text.trim().slice(0, 200));
  }
  if (!Array.isArray(parsed)) throw new ReleaseChannelError('it answered something that is not a list of releases');
  let newest: string | null = null;
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') continue;
    const release = row as { tag_name?: unknown; draft?: unknown };
    if (release.draft === true) continue;
    if (typeof release.tag_name !== 'string' || !VERSION_RE.test(release.tag_name)) continue;
    const version = release.tag_name.replace(/^v/, '');
    if (newest === null || compareReleases(version, newest) > 0) newest = version;
  }
  if (newest === null) throw new ReleaseChannelError('it names no Crucible release');
  return newest;
}

/** Ask GitHub which Crucible release is newest. `fetchImpl` is for specs. */
export async function newestRelease(fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_URL, { headers: { accept: 'application/vnd.github+json' } });
  } catch (err) {
    throw new ReleaseChannelError((err as Error).message);
  }
  const body = await response.text();
  if (!response.ok) throw new ReleaseChannelError(`HTTP ${response.status}`, body.trim().slice(0, 200));
  return parseNewestRelease(body);
}
