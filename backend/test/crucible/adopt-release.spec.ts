/**
 * tools/adopt-crucible-release.mjs follows Crucible's channel rule (crucible
 * 6807b50): "latest" is `releases/latest`, never `releases?per_page=1` (the
 * newest tag CREATED, an unverified candidate between a cut and its promotion),
 * and nothing goes backwards unless an exact release is named.
 *
 * The script is ESM and this suite is CommonJS, so each case runs in a child
 * node that imports it; nothing is downloaded (fetch is scripted).
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'tools', 'adopt-crucible-release.mjs');

function run(body: string): { ok: boolean; out: unknown; err: string } {
  const code = `
    const m = await import(${JSON.stringify(SCRIPT)});
    const asked = [];
    const fetchAt = (tag) => async (url) => { asked.push(url); return { ok: true, status: 200, json: async () => ({ tag_name: tag }) }; };
    const result = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify({ result, asked }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  let out: unknown = null;
  try { out = JSON.parse(child.stdout); } catch { out = child.stdout; }
  return { ok: child.status === 0, out, err: child.stderr };
}

describe('REGRESSION: adopt-crucible-release reads the channel and never goes backwards', () => {
  it('asks releases/latest, not releases?per_page=1', () => {
    const r = run(`return await m.newestRelease(fetchAt('v1.0.24'));`);
    expect(r.err).toBe('');
    expect(r.out).toEqual({ result: '1.0.24', asked: ['https://api.github.com/repos/telltaleatheist/crucible/releases/latest'] });
  });

  it('with no version, adopts the channel\'s latest when it is newer (number by number: 1.0.10 is after 1.0.9)', () => {
    const r = run(`return await m.chooseTarget([], '1.0.9', () => m.newestRelease(fetchAt('v1.0.10')));`);
    expect(r.err).toBe('');
    expect((r.out as { result: unknown }).result).toEqual({ to: '1.0.10', rollback: false });
  });

  it('refuses the channel\'s latest when it is older than what is vendored', () => {
    const r = run(`try { await m.chooseTarget(['--newest'], '1.0.23', () => m.newestRelease(fetchAt('v1.0.22'))); return 'adopted'; }
                   catch (e) { return { refused: e instanceof m.AdoptRefusal, message: e.message }; }`);
    expect(r.err).toBe('');
    const result = (r.out as { result: { refused: boolean; message: string } }).result;
    expect(result.refused).toBe(true);
    expect(result.message).toMatch(/older than the vendored 1\.0\.23; never going backwards/);
  });

  it('an exact older version is the one way down, and never asks the channel', () => {
    const r = run(`return await m.chooseTarget(['1.0.20'], '1.0.23', () => { throw new Error('asked the channel'); });`);
    expect(r.err).toBe('');
    expect((r.out as { result: unknown }).result).toEqual({ to: '1.0.20', rollback: true });
  });

  it('a channel that can\'t be read is a refusal, with no fallback', () => {
    const r = run(`try { await m.newestRelease(async () => ({ ok: false, status: 503, json: async () => ({}) })); return 'read'; }
                   catch (e) { return { refused: e instanceof m.AdoptRefusal, message: e.message }; }`);
    expect((r.out as { result: { refused: boolean; message: string } }).result).toEqual({ refused: true, message: expect.stringMatching(/releases\/latest answered HTTP 503/) });
  });
});
