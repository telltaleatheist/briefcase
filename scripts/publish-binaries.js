/**
 * publish-binaries.js
 *
 * Uploads the packaged binaries bundle (archives + manifest.json) to the GitHub
 * release, creating the release as a pre-release if it doesn't exist yet. This
 * is the one-command replacement for the manual `gh release upload` dance.
 *
 * Prereq: `gh auth login` once, or set GITHUB_TOKEN/GH_TOKEN in the environment.
 *
 * Usage:
 *   node scripts/publish-binaries.js            # upload to RELEASE_TAG
 *   node scripts/publish-binaries.js --dry-run  # show what would happen, no upload
 *
 * Typically run via:  npm run binaries:publish  (builds first, then publishes)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const RELEASE_TAG = 'binaries-v1';
const REPO = 'telltaleatheist/briefcase';
const OUT = path.join(os.homedir(), 'Downloads', 'briefcase-binaries', RELEASE_TAG);
const DRY = process.argv.includes('--dry-run');

function sh(cmd) {
  return execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

function ghAvailable() {
  try { sh('command -v gh'); return true; } catch { return false; }
}

function ghAuthed() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return true;
  try { sh('gh auth status'); return true; } catch { return false; }
}

function releaseExists() {
  try { sh(`gh release view ${RELEASE_TAG} --repo ${REPO}`); return true; } catch { return false; }
}

function main() {
  if (!fs.existsSync(OUT)) {
    console.error(`No build output at ${OUT}. Run the binaries build first (npm run binaries:build).`);
    process.exit(1);
  }
  if (!ghAvailable()) {
    console.error('GitHub CLI (gh) not found. Install it (brew install gh) or set GITHUB_TOKEN and use the API.');
    process.exit(1);
  }
  if (!ghAuthed()) {
    console.error('Not authenticated. Run `gh auth login` once, or export GITHUB_TOKEN.');
    process.exit(1);
  }

  const assets = fs.readdirSync(OUT).filter((f) => /\.(tar\.gz|zip)$/.test(f) || f === 'manifest.json');
  if (assets.length === 0) {
    console.error(`No archives/manifest found in ${OUT}.`);
    process.exit(1);
  }

  const totalMB = assets.reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0) / 1e6;
  console.log(`Publishing ${assets.length} assets (${totalMB.toFixed(1)} MB) to ${REPO} @ ${RELEASE_TAG}`);
  assets.forEach((a) => console.log(`  - ${a}`));

  if (DRY) {
    console.log(`\n[dry-run] release ${releaseExists() ? 'exists' : 'would be created as prerelease'}; no upload performed.`);
    return;
  }

  if (!releaseExists()) {
    console.log(`\nCreating prerelease ${RELEASE_TAG}…`);
    execFileSync('gh', [
      'release', 'create', RELEASE_TAG,
      '--repo', REPO,
      '--prerelease',
      '--title', `Binaries (${RELEASE_TAG})`,
      '--notes', 'Download-on-demand binaries (ffmpeg, yt-dlp, whisper, llama) + manifest. Consumed by the app at runtime.',
    ], { stdio: 'inherit' });
  }

  console.log(`\nUploading assets (--clobber)…`);
  execFileSync('gh', [
    'release', 'upload', RELEASE_TAG,
    ...assets.map((a) => path.join(OUT, a)),
    '--clobber',
    '--repo', REPO,
  ], { stdio: 'inherit' });

  console.log(`\n✅ Published to https://github.com/${REPO}/releases/tag/${RELEASE_TAG}`);
}

main();
