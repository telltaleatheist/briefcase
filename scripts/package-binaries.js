/**
 * package-binaries.js
 *
 * Builds per-platform binary archives for download-on-demand and drops them in
 * ~/Downloads/briefcase-binaries/<RELEASE_TAG>/ along with a manifest.json and
 * .sha256 sidecars. Upload the archives + manifest.json to the GitHub release
 * tagged RELEASE_TAG; the app's download manager consumes manifest.json.
 *
 * Sources:
 *   - ffmpeg/ffprobe (mac): node_modules/@ffmpeg-installer + @ffprobe-installer
 *   - ffmpeg/ffprobe (win): fetched via `npm pack @ffmpeg-installer/win32-x64`
 *   - whisper (mac):  utilities/bin/whisper-cli-<arch> + co-located dylibs (already rpath-patched)
 *   - whisper (win):  fetched from ggml-org/whisper.cpp release (whisper-bin-x64.zip)
 *   - llama  (mac):   utilities/bin/llama-server-<arch> + llama-* dylibs   [arm64 only locally]
 *   - yt-dlp:         utilities/bin/yt-dlp_<plat>_dir  (onedir; fast startup)
 *
 * Models (whisper ggml-*, llama gguf) are NOT packaged here — they download from
 * Hugging Face mirrors at runtime.
 *
 * Usage: node scripts/package-binaries.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'utilities', 'bin');
const NM = path.join(ROOT, 'node_modules');

const RELEASE_TAG = 'binaries-v1';
const REPO = 'telltaleatheist/briefcase';
const BASE_URL = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}`;
const WHISPER_CPP_VERSION = '1.8.2';
const WHISPER_WIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;

const OUT = path.join(os.homedir(), 'Downloads', 'briefcase-binaries', RELEASE_TAG);
const STAGE = path.join(OUT, '.stage');
const FETCH = path.join(OUT, '.fetch');

const components = []; // manifest entries

// ---------- helpers ----------
function sh(cmd, opts = {}) { return execSync(cmd, { stdio: 'pipe', ...opts }); }
function fresh(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); }
function exists(p) { return fs.existsSync(p); }
function copy(src, dst) { ensure(path.dirname(dst)); fs.copyFileSync(src, dst); }
function sha256(file) { return sh(`shasum -a 256 "${file}"`).toString().split(/\s+/)[0]; }
function bytes(file) { return fs.statSync(file).size; }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let redirects = 0;
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'Briefcase-Packager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (++redirects > 10) return reject(new Error('too many redirects'));
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const o = new URL(u); loc = `${o.protocol}//${o.host}${loc}`; }
        return go(loc);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    go(url);
  });
}

// Create an archive from a staging dir's *contents* (flat) and register it.
function archive(id, name, kind, required, platform, arch, stageDir, entry, fmt) {
  const ext = fmt === 'zip' ? 'zip' : 'tar.gz';
  const fileName = `${id}-${platform}-${arch}.${ext}`;
  const outFile = path.join(OUT, fileName);
  if (fmt === 'zip') {
    sh(`cd "${stageDir}" && zip -qr -X "${outFile}" .`);
  } else {
    sh(`tar -czf "${outFile}" -C "${stageDir}" .`);
  }
  const entryArr = (components.find(c => c.id === id) || {});
  let comp = components.find(c => c.id === id);
  if (!comp) { comp = { id, name, kind, required, artifacts: [] }; components.push(comp); }
  comp.artifacts.push({
    platform, arch,
    url: `${BASE_URL}/${fileName}`,
    file: fileName,
    sha256: sha256(outFile),
    bytes: bytes(outFile),
    entry, // executable to invoke once extracted, relative to archive root
  });
  console.log(`  ✓ ${fileName}  (${(bytes(outFile) / 1e6).toFixed(1)} MB)`);
}

// ---------- builders ----------
function buildFfmpegMac(arch) {
  const ff = path.join(NM, '@ffmpeg-installer', `darwin-${arch}`, 'ffmpeg');
  const fp = path.join(NM, '@ffprobe-installer', `darwin-${arch}`, 'ffprobe');
  if (!exists(ff) || !exists(fp)) { console.log(`  ⚠ ffmpeg/ffprobe darwin-${arch} missing in node_modules — skipped`); return; }
  const s = path.join(STAGE, `ffmpeg-darwin-${arch}`); fresh(s);
  copy(ff, path.join(s, 'ffmpeg')); fs.chmodSync(path.join(s, 'ffmpeg'), 0o755);
  copy(fp, path.join(s, 'ffprobe')); fs.chmodSync(path.join(s, 'ffprobe'), 0o755);
  archive('ffmpeg-tools', 'FFmpeg & FFprobe', 'binary', true, 'darwin', arch, s, 'ffmpeg', 'tar');
}

async function buildFfmpegWin() {
  fresh(FETCH);
  const s = path.join(STAGE, 'ffmpeg-win32-x64'); fresh(s);
  let ok = true;
  for (const [pkg, exe] of [['@ffmpeg-installer/win32-x64', 'ffmpeg.exe'], ['@ffprobe-installer/win32-x64', 'ffprobe.exe']]) {
    try {
      const out = sh(`cd "${FETCH}" && npm pack ${pkg} 2>/dev/null`).toString().trim().split('\n').pop().trim();
      const tgz = path.join(FETCH, out);
      const ex = path.join(FETCH, `x-${exe}`); fresh(ex);
      sh(`tar -xzf "${tgz}" -C "${ex}"`);
      const found = sh(`find "${ex}" -iname "${exe}"`).toString().trim().split('\n')[0];
      if (!found) { ok = false; console.log(`  ⚠ ${exe} not found in ${pkg}`); break; }
      copy(found, path.join(s, exe));
    } catch (e) { ok = false; console.log(`  ⚠ npm pack ${pkg} failed: ${e.message}`); break; }
  }
  if (ok) archive('ffmpeg-tools', 'FFmpeg & FFprobe', 'binary', true, 'win32', 'x64', s, 'ffmpeg.exe', 'zip');
}

const WHISPER_DYLIBS = {
  arm64: ['libwhisper.1-arm64.dylib', 'libggml-arm64.dylib', 'libggml-base-arm64.dylib', 'libggml-cpu-arm64.dylib', 'libggml-blas-arm64.dylib', 'libggml-metal-arm64.dylib'],
  x64: ['libwhisper.1-x64.dylib', 'libggml-x64.dylib', 'libggml-base-x64.dylib', 'libggml-cpu-x64.dylib', 'libggml-blas-x64.dylib'],
};
function buildWhisperMac(arch) {
  const binName = `whisper-cli-${arch}`;
  const bin = path.join(BIN, binName);
  if (!exists(bin)) { console.log(`  ⚠ ${binName} missing — skipped`); return; }
  const s = path.join(STAGE, `whisper-darwin-${arch}`); fresh(s);
  copy(bin, path.join(s, binName)); fs.chmodSync(path.join(s, binName), 0o755);
  for (const d of WHISPER_DYLIBS[arch]) {
    const src = path.join(BIN, d);
    if (exists(src)) copy(src, path.join(s, d));
    else console.log(`    ⚠ dylib ${d} missing`);
  }
  archive('whisper', 'Whisper (speech-to-text)', 'binary', true, 'darwin', arch, s, binName, 'tar');
}

async function buildWhisperWin() {
  const s = path.join(STAGE, 'whisper-win32-x64'); fresh(s);
  const zip = path.join(FETCH, 'whisper-win.zip');
  const ex = path.join(FETCH, 'whisper-win'); fresh(ex);
  try {
    console.log(`  ↓ fetching whisper.cpp v${WHISPER_CPP_VERSION} (Windows)…`);
    await download(WHISPER_WIN_URL, zip);
    sh(`unzip -qo "${zip}" -d "${ex}"`);
    const cli = sh(`find "${ex}" -iname "whisper-cli.exe"`).toString().trim().split('\n')[0]
             || sh(`find "${ex}" -iname "main.exe"`).toString().trim().split('\n')[0];
    if (!cli) { console.log('  ⚠ whisper-cli.exe not found in release zip — skipped'); return; }
    copy(cli, path.join(s, 'whisper-cli.exe'));
    const dir = path.dirname(cli);
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.dll')) copy(path.join(dir, f), path.join(s, f));
    }
    archive('whisper', 'Whisper (speech-to-text)', 'binary', true, 'win32', 'x64', s, 'whisper-cli.exe', 'zip');
    console.log('    note: MSVC redistributable DLLs (MSVCP140/VCRUNTIME140) are NOT in the upstream zip;');
    console.log('          add them on a Windows box if target machines lack the VC++ runtime.');
  } catch (e) { console.log(`  ⚠ whisper Windows fetch failed: ${e.message}`); }
}

const LLAMA_DYLIBS_ARM64 = ['libllama-arm64.dylib', 'libmtmd-arm64.dylib', 'llama-libggml-arm64.dylib', 'llama-libggml-base-arm64.dylib', 'llama-libggml-cpu-arm64.dylib', 'llama-libggml-blas-arm64.dylib', 'llama-libggml-metal-arm64.dylib', 'llama-libggml-rpc-arm64.dylib'];
function buildLlamaMacArm64() {
  const bin = path.join(BIN, 'llama-server-arm64');
  if (!exists(bin)) { console.log('  ⚠ llama-server-arm64 missing — skipped'); return; }
  const s = path.join(STAGE, 'llama-darwin-arm64'); fresh(s);
  copy(bin, path.join(s, 'llama-server-arm64')); fs.chmodSync(path.join(s, 'llama-server-arm64'), 0o755);
  for (const d of LLAMA_DYLIBS_ARM64) {
    const src = path.join(BIN, d);
    if (exists(src)) copy(src, path.join(s, d)); else console.log(`    ⚠ dylib ${d} missing`);
  }
  archive('llama', 'Llama (local AI inference)', 'binary', false, 'darwin', 'arm64', s, 'llama-server-arm64', 'tar');
}

function buildYtDlpOnedir(srcDirName, platform, arch, fmt) {
  const src = path.join(BIN, srcDirName);
  if (!exists(src)) { console.log(`  ⚠ ${srcDirName} missing — skipped`); return; }
  // archive the onedir folder itself so it extracts to yt-dlp_<plat>_dir/
  const s = path.join(STAGE, `ytdlp-${platform}-${arch}`); fresh(s);
  sh(`cp -R "${src}" "${path.join(s, srcDirName)}"`);
  const exe = platform === 'win32' ? `${srcDirName}/yt-dlp.exe`
           : platform === 'darwin' ? `${srcDirName}/yt-dlp_macos`
           : `${srcDirName}/yt-dlp_linux`;
  archive('yt-dlp', 'yt-dlp (video downloader)', 'binary', true, platform, arch, s, exe, fmt);
}

// ---------- main ----------
(async function main() {
  console.log(`\nPackaging Briefcase binaries → ${OUT}\n`);
  fresh(OUT); ensure(STAGE); ensure(FETCH);

  console.log('FFmpeg/FFprobe:');
  buildFfmpegMac('arm64');
  buildFfmpegMac('x64');
  await buildFfmpegWin();

  console.log('Whisper:');
  buildWhisperMac('arm64');
  buildWhisperMac('x64');
  await buildWhisperWin();

  console.log('Llama (optional, local AI):');
  buildLlamaMacArm64();

  console.log('yt-dlp (onedir):');
  buildYtDlpOnedir('yt-dlp_macos_dir', 'darwin', 'universal', 'tar');
  buildYtDlpOnedir('yt-dlp_win_dir', 'win32', 'x64', 'zip');

  const manifest = {
    schemaVersion: 1,
    releaseTag: RELEASE_TAG,
    repo: REPO,
    baseUrl: BASE_URL,
    note: 'AI/whisper models are NOT here — they download from Hugging Face at runtime.',
    components,
  };
  const manifestPath = path.join(OUT, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // sha256 sidecars for every archive
  for (const c of components) for (const a of c.artifacts) {
    fs.writeFileSync(path.join(OUT, `${a.file}.sha256`), `${a.sha256}  ${a.file}\n`);
  }

  // cleanup scratch
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(FETCH, { recursive: true, force: true });

  console.log(`\n✅ Done. ${components.reduce((n, c) => n + c.artifacts.length, 0)} archives + manifest.json in:\n   ${OUT}\n`);
  console.log('Upload everything in that folder to the GitHub release tagged ' + RELEASE_TAG + '.\n');
})().catch((e) => { console.error('\n❌ Packaging failed:', e); process.exit(1); });
