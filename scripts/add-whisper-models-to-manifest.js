/**
 * add-whisper-models-to-manifest.js
 *
 * Adds a `models` array (whisper ggml-tiny/base/small) to the binaries manifest.
 * Models download from the Hugging Face mirror (ggerganov/whisper.cpp), with
 * sha256/bytes computed from the local utilities/models/*.bin copies. Each model
 * gets a per-platform artifact (same URL — the .bin is platform-agnostic) so
 * ComponentManagerService.pickArtifact() matches on any OS.
 *
 * Writes the updated manifest into the release-staging folder AND a bundled
 * fallback copy at assets/manifest.json. Re-upload manifest.json afterward:
 *   gh release upload binaries-v1 manifest.json --clobber --repo telltaleatheist/briefcase
 *
 * Usage: node scripts/add-whisper-models-to-manifest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'utilities', 'models');
const ASSETS_MANIFEST = path.join(ROOT, 'assets', 'manifest.json');
const RELEASE_TAG = 'binaries-v1';
const OUT_MANIFEST = path.join(os.homedir(), 'Downloads', 'briefcase-binaries', RELEASE_TAG, 'manifest.json');
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const PLATFORMS = ['darwin', 'win32', 'linux'];

const MODELS = [
  { id: 'whisper-model-tiny', file: 'ggml-tiny.bin', name: 'Whisper Tiny (fastest)', description: 'Smallest, fastest, lowest accuracy. Good for quick drafts.' },
  { id: 'whisper-model-base', file: 'ggml-base.bin', name: 'Whisper Base (recommended)', description: 'Balanced speed and accuracy. Recommended default.' },
  { id: 'whisper-model-small', file: 'ggml-small.bin', name: 'Whisper Small (most accurate)', description: 'Best accuracy, slower and larger.' },
];

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function buildModels() {
  const out = [];
  for (const m of MODELS) {
    const local = path.join(MODELS_DIR, m.file);
    if (!fs.existsSync(local)) {
      console.log(`  ⚠ ${m.file} not found locally — skipped`);
      continue;
    }
    const bytes = fs.statSync(local).size;
    const hash = sha256(local);
    const url = `${HF_BASE}/${m.file}`;
    const artifacts = PLATFORMS.map((platform) => ({
      platform,
      arch: 'universal',
      url,
      file: m.file,
      sha256: hash,
      bytes,
      entry: m.file,
    }));
    out.push({ id: m.id, name: m.name, kind: 'whisper-model', required: false, description: m.description, artifacts });
    console.log(`  ✓ ${m.id}  ${(bytes / 1e6).toFixed(0)}MB  sha256=${hash.slice(0, 12)}…`);
  }
  return out;
}

function main() {
  if (!fs.existsSync(OUT_MANIFEST)) {
    console.error(`Manifest not found at ${OUT_MANIFEST}. Run package-binaries.js first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(OUT_MANIFEST, 'utf8'));
  console.log('Building whisper model entries from local files:');
  manifest.models = buildModels();

  fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`\n✓ Updated ${OUT_MANIFEST}`);

  // Bundled fallback copy shipped inside the app (assets/).
  fs.writeFileSync(ASSETS_MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`✓ Wrote bundled fallback ${ASSETS_MANIFEST}`);

  console.log(`\nNext: gh release upload ${RELEASE_TAG} "${OUT_MANIFEST}" --clobber --repo telltaleatheist/briefcase`);
}

main();
