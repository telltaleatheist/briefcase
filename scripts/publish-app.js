/**
 * publish-app.js — upload built Briefcase installers to GitHub under STABLE names,
 * so owenmorgan.com/tools can use permanent "latest" URLs that never need editing
 * per release. Mirrors BookForge's packaging/publish-app.js.
 *
 * Public download URLs (permanent — point /tools at these once):
 *   https://github.com/<repo>/releases/latest/download/Briefcase-mac-arm64.dmg
 *   https://github.com/<repo>/releases/latest/download/Briefcase-mac-x64.dmg
 *   https://github.com/<repo>/releases/latest/download/Briefcase-win-x64.exe
 *
 * For /latest/download to resolve, the release must carry the stable-named asset
 * AND be marked "Latest" (i.e. NOT a pre-release). So per platform we copy each
 * versioned build to a version-less name, upload it to the per-version release
 * tag v<version>, and mark that release --latest (clearing the prerelease flag).
 * The versioned assets still live on the release for history.
 *
 *   node scripts/publish-app.js --mac                      # both dist-electron DMGs -> stable mac names
 *   node scripts/publish-app.js --win                      # dist-electron Briefcase-Setup-<ver>.exe -> stable win name
 *   node scripts/publish-app.js --win --file "<path.exe>"  # upload a win .exe built/obtained elsewhere
 *   ... add --dry-run to preview without uploading.
 *
 * Version is NOT bumped here — run `npm run version:bump` first when you want a new
 * version, commit/push it, then build + publish. Requires `gh auth login` (or GITHUB_TOKEN).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;
const REPO = process.env.BRIEFCASE_GH_REPO || 'telltaleatheist/briefcase';
const OUT_DIR = path.join(ROOT, (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist-electron');
const TAG = `v${VERSION}`;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const fileArg = (() => { const i = args.indexOf('--file'); return i !== -1 ? args[i + 1] : null; })();
const which = args.includes('--win') ? 'win' : args.includes('--mac') ? 'mac' : null;

function fail(msg) { console.error(`\n[publish-app] ${msg}`); process.exit(1); }
function sh(cmd, a) { return execFileSync(cmd, a, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }

if (!which) fail('Specify --mac or --win.');

// Per platform: list of { match, stable } pairs (mac has arm64 + x64).
const PLATFORMS = {
  mac: [
    { match: (f) => f.endsWith('-arm64.dmg') && f.includes(VERSION), stable: 'Briefcase-mac-arm64.dmg' },
    { match: (f) => f.endsWith('.dmg') && !f.includes('arm64') && f.includes(VERSION), stable: 'Briefcase-mac-x64.dmg' },
  ],
  win: [
    { match: (f) => f.endsWith('.exe') && f.includes(VERSION), stable: 'Briefcase-win-x64.exe' },
  ],
};
const specs = PLATFORMS[which];

// gh availability + auth.
try { sh('gh', ['--version']); } catch { fail('GitHub CLI (gh) not found. Install it or set GITHUB_TOKEN.'); }
if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
  try { sh('gh', ['auth', 'status']); } catch { fail('Not authenticated. Run `gh auth login` once, or export GITHUB_TOKEN.'); }
}

// Resolve built artifacts → staged copies under stable names (gh names the asset after the file).
const dir = fileArg ? null : OUT_DIR;
if (!fileArg && !fs.existsSync(OUT_DIR)) fail(`Output dir not found: ${OUT_DIR}. Build first.`);
const available = fileArg ? [] : fs.readdirSync(OUT_DIR).filter((f) => !f.startsWith('._'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pub-'));
const staged = [];

if (fileArg && which === 'win') {
  const src = path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg);
  if (!fs.existsSync(src)) fail(`--file not found: ${src}`);
  const dst = path.join(tmp, specs[0].stable);
  fs.copyFileSync(src, dst);
  staged.push({ src, dst, stable: specs[0].stable });
} else {
  for (const spec of specs) {
    const hit = available.find(spec.match);
    if (!hit) {
      // mac x64 may be absent on some builds; warn but don't hard-fail if at least one staged.
      console.warn(`[publish-app] (skip) no build matching ${spec.stable} in ${OUT_DIR}`);
      continue;
    }
    const src = path.join(OUT_DIR, hit);
    const dst = path.join(tmp, spec.stable);
    fs.copyFileSync(src, dst);
    staged.push({ src, dst, stable: spec.stable });
  }
}
if (staged.length === 0) fail(`No ${which} installer for v${VERSION} found in ${OUT_DIR}. Build first.`);

console.log(`[publish-app] repo=${REPO} tag=${TAG} platform=${which}`);
staged.forEach((s) => {
  const mb = (fs.statSync(s.src).size / 1e6).toFixed(1);
  console.log(`   ${path.basename(s.src)} (${mb} MB) -> ${s.stable}`);
  console.log(`     permanent URL: https://github.com/${REPO}/releases/latest/download/${s.stable}`);
});

const releaseExists = (() => { try { sh('gh', ['release', 'view', TAG, '--repo', REPO]); return true; } catch { return false; } })();

if (DRY) {
  console.log(`\n[dry-run] release ${TAG} ${releaseExists ? 'exists' : 'would be created'}; would upload + mark --latest (clear prerelease); no upload performed.`);
  process.exit(0);
}

if (!releaseExists) {
  console.log(`\n[publish-app] creating release ${TAG}…`);
  execFileSync('gh', ['release', 'create', TAG, '--repo', REPO,
    '--title', `Briefcase ${VERSION}`,
    '--notes', `Briefcase ${VERSION} (beta). Unsigned build — SmartScreen / Gatekeeper may warn (false positive). macOS: right-click the app → Open.`,
  ], { stdio: 'inherit' });
}

console.log(`\n[publish-app] uploading ${staged.length} stable asset(s) to ${TAG}…`);
execFileSync('gh', ['release', 'upload', TAG, ...staged.map((s) => s.dst), '--clobber', '--repo', REPO], { stdio: 'inherit' });

// Mark this release "Latest" and clear prerelease so /latest/download resolves to it.
console.log(`[publish-app] marking ${TAG} as latest (clearing prerelease)…`);
execFileSync('gh', ['release', 'edit', TAG, '--latest', '--prerelease=false', '--repo', REPO], { stdio: 'inherit' });

console.log('\n[publish-app] done. Permanent /tools URLs (no edits needed on future releases):');
staged.forEach((s) => console.log(`   https://github.com/${REPO}/releases/latest/download/${s.stable}`));
