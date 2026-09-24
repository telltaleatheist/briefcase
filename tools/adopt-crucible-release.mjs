#!/usr/bin/env node
/**
 * Adopt a Crucible release: fetch the two vendored tarballs, repin, relink, prove it.
 *
 *   node tools/adopt-crucible-release.mjs              # the channel's latest (releases/latest)
 *   node tools/adopt-crucible-release.mjs --newest     # the same, said out loud
 *   node tools/adopt-crucible-release.mjs 0.6.8        # exactly this release (the one way DOWN)
 *   node tools/adopt-crucible-release.mjs --check      # what is pinned, and what the channel says
 *
 * "LATEST" HAS ONE OWNER, THE RELEASE CHANNEL (crucible 6807b50,
 * docs/INSTALL-UNINSTALL.md §6.5.1): GitHub's `releases/latest`, which moves
 * only when `promote_release.py --publish` promotes a verified cut. Not
 * `releases?per_page=1`, which answers "the newest tag CREATED": every cut is
 * created `--prerelease --latest=false`, so between a cut and its promotion
 * that is the unverified candidate. And NOTHING GOES BACKWARDS: the channel's
 * latest older than what is vendored is refused, compared number by number (a
 * string compare puts 1.0.10 before 1.0.2). Naming an exact release is the one
 * way down, as `rollbackTo` is in the bootstrapper.
 *
 * ADOPTING A RELEASE USED TO BE FOUR EDITS AND A DOWNLOAD, done by hand, and the
 * places do not look alike: two `file:vendor/...tgz` dependency lines that name
 * the version inside a filename, two `//crucible-*` prose keys that name it in a
 * sentence, two tarballs to fetch and two to delete. Miss the prose and the
 * package still installs — it just describes a release it is not pinned to,
 * which is the failure each app's pin keeper was written for after it happened
 * (BookForge's `tools/test-crucible-install-seam.js`; Briefcase's
 * `backend/test/crucible/sdk-seam.spec.ts` and `adopt-release.spec.ts`).
 *
 * THE VERSION IS NEVER TYPED TWICE HERE. Everything downstream of the tarballs
 * derives from the tarballs: `electron/crucible/install.ts` exports
 * `BOOTSTRAP_LIBRARY_VERSION` as the vendored bootstrap's own
 * `BOOTSTRAP_VERSION`, so once the right bytes are in `vendor/` the app cannot
 * disagree with them about what it pinned. What that number is NOT, since
 * 2026-09-18, is the release an install puts on a machine — that is the release
 * channel's answer (crucible `docs/INSTALL-UNINSTALL.md` §6.5), so re-vendoring
 * the library moves the library and nothing else. That is also how this script CHECKS itself at the end — it
 * asks the freshly installed package its version rather than trusting that the
 * download went to the right filename.
 *
 * It works unchanged in Foundry, whose package.json is `app/package.json` and
 * whose prose key is `_crucibleClientNote`, and in Briefcase, whose Crucible
 * dependencies live in `backend/package.json` (the NestJS backend owns every
 * Crucible call) with the tarballs in `backend/vendor/`. All three are found
 * rather than assumed. Run it from the repository root.
 * It is `.mjs` for the same reason: BookForge's package.json has no `type`, so a
 * `.js` file there is CommonJS, while Foundry's says `"type": "module"`, so the
 * same bytes under the same name would be ESM. One file that must run in both
 * cannot be ambiguous about which it is.
 *
 * Nothing here is reversible by itself: it edits package.json, deletes the old
 * tarballs and runs `npm install`. It is all inside the repo, so `git checkout`
 * undoes it, but --check first is free.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_SLUG = 'telltaleatheist/crucible';
const PACKAGES = ['@crucible/client', '@crucible/bootstrap'];
const SEMVER = /^\d+\.\d+\.\d+$/;

function die(message) {
  console.error(`adopt: ${message}`);
  process.exit(1);
}

/** The package.json that declares the Crucible dependencies, and where its vendor/ is. */
export function findManifest() {
  const roots = ['.', 'app', 'backend'];
  for (const root of roots) {
    const file = path.resolve(root, 'package.json');
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (PACKAGES.every((name) => parsed.dependencies?.[name])) {
      return { file, dir: path.resolve(root), parsed };
    }
  }
  die(`no package.json in ${roots.join(' or ')} depends on ${PACKAGES.join(' and ')}; ` +
      'run this from the root of BookForge, Foundry or Briefcase');
}

/**
 * The version a `file:vendor/crucible-client-X.tgz` specifier names.
 *
 * ── THE `-<label>` SUFFIX, AND WHY IT IS READ RATHER THAN REFUSED ──────────
 *
 * A pack built from a crucible BRANCH carries the same version string as the
 * release it was cut beside — `npm pack` reads `package.json`, which the branch
 * has not bumped — so the two tarballs cannot share a file name and one of them
 * is `crucible-bootstrap-1.0.5-phase19.tgz`. PHASE19 is the first time BookForge
 * has pinned one (package.json's `//crucible-bootstrap` says which branch and
 * which sha, and that it is replaced by the release).
 *
 * This READS the version out of such a name and never WRITES one: `download()`
 * below composes `crucible-<name>-<version>.tgz` from a release tag, so
 * adopting a release is what replaces a pre-release pin and the label
 * disappears with it. Refusing the name instead — which is what this did until
 * 2026-09-19 — took the whole install-seam suite down with it, because `die`
 * exits the process and the suite imports this module.
 */
export function pinnedVersion(parsed) {
  const found = new Set();
  for (const name of PACKAGES) {
    const specifier = parsed.dependencies[name];
    const match = /crucible-(?:client|bootstrap)-(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?\.tgz$/.exec(specifier);
    if (!match) die(`${name} is pinned as ${specifier}, which is not a vendored release tarball`);
    found.add(match[1]);
  }
  if (found.size !== 1) {
    die(`the two Crucible packages are pinned to different releases (${[...found].join(', ')}); ` +
        'they are cut together and the bootstrapper peer-depends on the client at its exact version');
  }
  return [...found][0];
}

/** The channel's pointer at the promoted release. One URL, spelled once (as crucible's channel.ts). */
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

/** A refusal this script states and exits on; thrown (not `die`d) so the functions can be tested. */
export class AdoptRefusal extends Error {}

/**
 * What `releases/latest` names. No fallback: a channel that can't be read is a
 * refusal, never "the newest tag" or whatever is vendored.
 */
export async function newestRelease(fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(LATEST_RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' } });
  } catch (error) {
    throw new AdoptRefusal(`could not read the release channel at ${LATEST_RELEASE_URL}: ${error.message}`);
  }
  if (!response.ok) throw new AdoptRefusal(`the release channel at ${LATEST_RELEASE_URL} answered HTTP ${response.status}`);
  const release = await response.json();
  const tag = release?.tag_name;
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new AdoptRefusal(`the channel's latest release is tagged ${JSON.stringify(tag)}, which is not vX.Y.Z`);
  }
  return tag.slice(1);
}

/** Negative when `a` is older than `b`, 0 when the same, positive when newer. Number by number. */
export function compareReleases(a, b) {
  const left = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(a).trim());
  const right = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(b).trim());
  if (left === null || right === null) {
    throw new AdoptRefusal(`${JSON.stringify(left === null ? a : b)} is not a release version, so it can't be compared`);
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Which release to adopt, and whether it goes down. An exact version is taken
 * as named (older included: that is the rollback). With none, the channel's
 * latest, refused when it is older than the vendored `from`.
 *
 * `latest` is a function so the channel is only asked when it is needed.
 */
export async function chooseTarget(args, from, latest) {
  const exact = args.find((value) => SEMVER.test(value));
  if (exact !== undefined) {
    return { to: exact, rollback: compareReleases(exact, from) < 0 };
  }
  const to = await latest();
  if (compareReleases(to, from) < 0) {
    throw new AdoptRefusal(
      `the channel's latest release is ${to}, older than the vendored ${from}; never going backwards. ` +
      `To roll back, name the exact release: node tools/adopt-crucible-release.mjs ${to}`,
    );
  }
  return { to, rollback: false };
}

async function download(version, name, into) {
  const filename = `crucible-${name}-${version}.tgz`;
  const url = `https://github.com/${REPO_SLUG}/releases/download/v${version}/${filename}`;
  const response = await fetch(url);
  if (!response.ok) {
    die(`${filename} is not published on v${version} (GitHub answered ${response.status}). ` +
        'A release whose tarballs are missing is one that was never fully cut.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) die(`${filename} downloaded as zero bytes`);
  const target = path.join(into, filename);
  fs.writeFileSync(target, bytes);
  console.log(`  ${filename}  (${bytes.length.toLocaleString()} bytes)`);
  return filename;
}

/**
 * Repin the dependencies AND the prose that explains them.
 *
 * The prose is rewritten by replacing the version it names, not by writing a new
 * sentence: these keys say things this script has no business restating, and a
 * generated sentence would quietly erase whatever a person put there.
 */
function repin(manifest, from, to) {
  let text = fs.readFileSync(manifest.file, 'utf8');
  const changed = [];
  for (const name of PACKAGES) {
    const short = name.split('/')[1];
    /*
     * THE SPECIFIER THAT IS THERE, NOT ONE REBUILT FROM A VERSION NUMBER.
     *
     * This composed `crucible-<short>-<from>.tgz` and died when the two did
     * not match — which is what a LABELLED pre-release pin looks like
     * (`crucible-bootstrap-1.0.5-phase19.tgz`, PHASE19). `pinnedVersion` was
     * taught to READ such a name on 2026-09-19 and this half was not, so the
     * script could say "1.0.5 -> 1.0.6", download both tarballs, and then
     * refuse — leaving new bytes in vendor/ and the manifest untouched.
     *
     * The pin has one owner and it is `dependencies[name]`. Reading it is also
     * what makes adopting a release the thing that ENDS a pre-release: the
     * label goes because the whole specifier is replaced, not edited.
     */
    const specifier = manifest.parsed.dependencies[name];
    const before = `"${name}": "${specifier}"`;
    const after = `"${name}": "file:vendor/crucible-${short}-${to}.tgz"`;
    if (!text.includes(before)) die(`could not find the pin line for ${name} (${before})`);
    text = text.replace(before, after);
    changed.push(name);
  }
  for (const [key, value] of Object.entries(manifest.parsed)) {
    if (!/crucible/i.test(key) || typeof value !== 'string') continue;
    if (!value.includes(from)) continue;
    // THE VALUE IS EDITED WHERE IT SITS, not matched as a whole string.
    //
    // `JSON.stringify(value)` re-serialises what the PARSER produced, and that
    // is not what is in the file: a prose key written with an escaped em dash
    // (`—`) comes back as the literal character, so the exact-text match
    // could never hit and every repin after such an edit died with "could not
    // find the prose". It happened on the 1.0.15 -> 1.0.16 repin and would have
    // happened on every one after it.
    //
    // So the key's own value span is located in the raw text and the version is
    // replaced inside it. That leaves every escape exactly as the author wrote
    // it — this file is hand-edited prose and reformatting it would be a diff
    // nobody asked for.
    const span = valueSpan(text, key);
    if (span === null) die(`could not find the prose for ${key} to update`);
    const raw = text.slice(span.start, span.end);
    if (!raw.includes(from)) die(`the prose for ${key} does not name ${from}`);
    text = text.slice(0, span.start) + raw.split(from).join(to) + text.slice(span.end);
    changed.push(key);
  }
  fs.writeFileSync(manifest.file, text);
  return changed;
}

/**
 * Where `"<key>": "<value>"`'s VALUE sits in the raw text, or null.
 *
 * Returns the offsets between the quotes, so a caller edits the bytes the
 * author wrote rather than a re-serialisation of what the parser made of them.
 * Escapes are walked rather than guessed at: a `\"` inside the prose is not the
 * end of it, and these strings contain quoted phrases.
 */
function valueSpan(text, key) {
  const at = text.indexOf(`"${key}":`);
  if (at === -1) return null;
  const open = text.indexOf('"', at + key.length + 3);
  if (open === -1) return null;
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === '"') return { start: open + 1, end: i };
  }
  return null;
}

/** Ask the installed package its own version — the only answer that is not a filename. */
function installedVersion(manifest) {
  // Resolved from the manifest's own directory, which is what `npm install`
  // just linked into — not from this file's, which in Foundry is a level up.
  const probe = spawnSync(process.execPath, [
    '-e', "process.stdout.write(require('@crucible/bootstrap/package.json').version)",
  ], { cwd: manifest.dir, encoding: 'utf8' });
  if (probe.status !== 0) {
    die(`@crucible/bootstrap is not resolvable after npm install:\n${probe.stderr || probe.stdout}`);
  }
  return probe.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = findManifest();
  const from = pinnedVersion(manifest.parsed);
  const vendor = path.join(manifest.dir, 'vendor');

  if (args.includes('--check')) {
    const latest = await newestRelease();
    const order = compareReleases(latest, from);
    console.log(`adopt: ${path.relative(process.cwd(), manifest.file) || 'package.json'} pins ${from}`);
    console.log(`adopt: the release channel's latest is ${latest}` +
      (order > 0 ? ' (newer: adopt it with no argument)' : order === 0 ? ' (already pinned)' : ' (OLDER than the pin: not adopted without naming it)'));
    return;
  }
  if (args.includes('--newest') && args.some((value) => SEMVER.test(value))) {
    die('--newest and an exact release contradict each other; pass one');
  }
  const { to, rollback } = await chooseTarget(args, from, () => newestRelease());

  if (to === from) {
    console.log(`adopt: already pinned to ${to}; nothing to do`);
    return;
  }
  console.log(`adopt: ${from} -> ${to}${rollback ? '  (ROLLING BACK: an older release, named exactly)' : ''}`);

  if (!fs.existsSync(vendor)) die(`${vendor} does not exist`);
  console.log('adopt: fetching');
  const fetched = [];
  for (const name of ['client', 'bootstrap']) {
    fetched.push(await download(to, name, vendor));
  }

  /*
   * WHAT THE PIN NAMED BEFORE IT WAS CHANGED — read here, because `repin`
   * rewrites the manifest and after that nothing can say what the old file was
   * called. It matters for the prune below: a LABELLED pre-release
   * (`crucible-bootstrap-1.0.5-phase19.tgz`) is not `crucible-bootstrap-<from>
   * .tgz`, and a prune that rebuilt the name from the version left the
   * labelled tarball sitting in vendor/, unpinned, for the next reader to
   * wonder about.
   */
  const superseded = PACKAGES
    .map((name) => manifest.parsed.dependencies[name].replace(/^file:vendor\//, ''));

  const changed = repin(manifest, from, to);
  console.log(`adopt: repinned ${changed.join(', ')}`);

  // Only after the new bytes are safely on disk and the manifest names them.
  // Both the plain `<from>` tarballs and whatever the pins ACTUALLY named, so
  // adopting a release is what ends a pre-release rather than leaving it about.
  const gone = new Set();
  for (const name of ['client', 'bootstrap']) gone.add(`crucible-${name}-${from}.tgz`);
  for (const file of superseded) gone.add(file);
  for (const file of gone) {
    const stale = path.join(vendor, file);
    if (fs.existsSync(stale)) {
      fs.unlinkSync(stale);
      console.log(`adopt: removed ${file}`);
    }
  }

  console.log('adopt: npm install');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'],
                            { cwd: manifest.dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (install.status !== 0) die('npm install failed; the pin is updated but the link is not');

  const actual = installedVersion(manifest);
  if (actual !== to) {
    die(`asked for ${to} but the installed @crucible/bootstrap says ${actual}; ` +
        'the tarball and the version it carries disagree');
  }
  console.log(`adopt: @crucible/bootstrap reports ${actual}`);
  const checks = checksBeforeCommit(manifest);
  console.log(`adopt: ${fetched.join(' and ')} adopted. Before committing, run ` +
    (checks.length ? checks.join(', then ') : "this repository's Crucible tests") + '.');
}

/**
 * What to run before committing an adoption, from what THIS repository has,
 * never from what one of the three apps happens to call it: BookForge runs its
 * keepers (`tools/run-keepers.js`), Foundry has `tools/test-crucible-*.js`
 * keepers, Briefcase has `test:crucible` / `test:no-crucible` in
 * `backend/package.json`. Looked for at the root and beside the package.json
 * that pins the SDK; any npm script there that names Crucible is listed.
 */
export function checksBeforeCommit(manifest, root = process.cwd()) {
  const checks = [];
  const dirs = [...new Set([path.resolve(root), manifest.dir])];
  for (const dir of dirs) {
    const rel = path.relative(root, dir);
    const at = (p) => (rel ? path.join(rel, p) : p);
    if (fs.existsSync(path.join(dir, 'tools', 'run-keepers.js'))) {
      checks.push(`node ${at('tools/run-keepers.js')}`);
    } else {
      let keepers = [];
      try {
        keepers = fs.readdirSync(path.join(dir, 'tools')).filter((f) => /^test-crucible-.*\.js$/.test(f));
      } catch {
        keepers = [];
      }
      if (keepers.length) {
        checks.push(`the Crucible keeper${keepers.length === 1 ? '' : 's'} (node ${at('tools/test-crucible-*.js')})`);
      }
    }
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
    } catch {
      scripts = {};
    }
    for (const [name, command] of Object.entries(scripts)) {
      if (!/crucible/i.test(`${name} ${command}`)) continue;
      checks.push(rel ? `npm --prefix ${rel} run ${name}` : `npm run ${name}`);
    }
  }
  return checks;
}

// Only when RUN, never when imported. A repository's pin keeper (BookForge's
// `tools/test-crucible-install-seam.js`, Briefcase's
// `backend/test/crucible/adopt-release.spec.ts`) imports this to check its
// parsing against the pin the app actually carries, and an import that started
// downloading tarballs would make that impossible.
const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => die(error instanceof AdoptRefusal ? error.message : (error.stack || String(error))));
}
