/**
 * THE SDK SEAM: the vendored @crucible/* tarballs load the way the backend
 * loads them (CommonJS, under Jest's require), and the version the installed
 * packages report is the version package.json pins. A port of BookForge's
 * tools/test-crucible-install-seam.js, trimmed to what P1 depends on.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));

function pinOf(name: string): string {
  const specifier: string = manifest.dependencies[name];
  const match = /^file:vendor\/crucible-(?:client|bootstrap)-(\d+\.\d+\.\d+)\.tgz$/.exec(specifier ?? '');
  if (!match) throw new Error(`${name} is pinned as ${specifier}, not a vendored release tarball`);
  return match[1];
}

describe('the @crucible SDK seam', () => {
  it('pins both packages to vendored tarballs of ONE release', () => {
    expect(pinOf('@crucible/client')).toBe(pinOf('@crucible/bootstrap'));
  });

  it('keeps the pinned tarballs in backend/vendor', () => {
    const version = pinOf('@crucible/client');
    for (const name of ['client', 'bootstrap']) {
      expect(fs.existsSync(path.join(BACKEND, 'vendor', `crucible-${name}-${version}.tgz`))).toBe(true);
    }
  });

  it('loads the client through require (the CJS build) and reports the pinned version', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const client = require('@crucible/client');
    expect(require.resolve('@crucible/client')).toMatch(/dist[\\/]cjs[\\/]index\.js$/);
    expect(typeof client.CrucibleClient).toBe('function');
    expect(typeof client.parsePairing).toBe('function');
    expect(typeof client.startPairing).toBe('function');
    expect(typeof client.pollPairing).toBe('function');
    expect(typeof client.engineOf).toBe('function');
    expect(client.SDK_VERSION).toBe(pinOf('@crucible/client'));
    expect(client.API_VERSION).toBe(1);
  });

  it('loads the bootstrap through require and reports the pinned version', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bootstrap = require('@crucible/bootstrap');
    expect(require.resolve('@crucible/bootstrap')).toMatch(/dist[\\/]cjs[\\/]index\.js$/);
    expect(bootstrap.BOOTSTRAP_VERSION).toBe(pinOf('@crucible/bootstrap'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('@crucible/bootstrap/package.json').version).toBe(pinOf('@crucible/bootstrap'));
  });

  it('has the adopt script able to find backend/package.json', () => {
    const script = fs.readFileSync(path.join(BACKEND, '..', 'tools', 'adopt-crucible-release.mjs'), 'utf8');
    expect(script).toContain("const roots = ['.', 'app', 'backend'];");
  });
});
