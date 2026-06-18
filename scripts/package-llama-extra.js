/**
 * package-llama-extra.js
 *
 * Fetches llama.cpp prebuilt binaries for mac-x64 and win-x64 from upstream
 * (which aren't present in utilities/bin), patches the macOS dylib rpaths the
 * same way scripts/download-llama-cpp.js does, packages them into the existing
 * ~/Downloads/briefcase-binaries/binaries-v1/ folder, and merges the new
 * artifacts into manifest.json (+ .sha256 sidecars).
 *
 * Usage: node scripts/package-llama-extra.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const RELEASE_TAG = 'binaries-v1';
const REPO = 'telltaleatheist/briefcase';
const BASE_URL = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}`;
const LLAMA_VERSION = 'b7482';
const URLS = {
  'darwin-x64': `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-macos-x64.tar.gz`,
  'win32-x64': `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`,
};

const OUT = path.join(os.homedir(), 'Downloads', 'briefcase-binaries', RELEASE_TAG);
const FETCH = path.join(OUT, '.fetch-llama');
const STAGE = path.join(OUT, '.stage-llama');

// dylibs llama needs on macOS (mirror of download-llama-cpp.js)
const DYLIBS = ['libllama.dylib', 'libggml.dylib', 'libggml-base.dylib', 'libggml-cpu.dylib', 'libggml-metal.dylib', 'libggml-blas.dylib', 'libggml-rpc.dylib', 'libmtmd.dylib'];

function sh(cmd, opts = {}) { return execSync(cmd, { stdio: 'pipe', ...opts }); }
function fresh(d) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
function exists(p) { return fs.existsSync(p); }
function sha256(f) { return sh(`shasum -a 256 "${f}"`).toString().split(/\s+/)[0]; }
function bytes(f) { return fs.statSync(f).size; }
function findFile(dir, name) {
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f); const st = fs.statSync(fp);
    if (st.isDirectory()) { const r = findFile(fp, name); if (r) return r; }
    else if (f.toLowerCase() === name.toLowerCase()) return fp;
  }
  return null;
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest); let n = 0;
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'Briefcase-Packager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (++n > 10) return reject(new Error('redirects'));
        let loc = res.headers.location; if (loc.startsWith('/')) { const o = new URL(u); loc = `${o.protocol}//${o.host}${loc}`; }
        return go(loc);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file); file.on('finish', () => file.close(resolve));
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
    go(url);
  });
}
const destName = (dylib, arch) => {
  const base = path.basename(dylib, '.dylib');
  return base.startsWith('libggml') ? `llama-${base}-${arch}.dylib` : `${base}-${arch}.dylib`;
};

async function buildMacX64() {
  const arch = 'x64';
  console.log('llama mac-x64:');
  const tgz = path.join(FETCH, 'llama-macos-x64.tar.gz');
  const ex = path.join(FETCH, 'llama-macos-x64'); fresh(ex);
  console.log('  ↓ fetching upstream…');
  await download(URLS['darwin-x64'], tgz);
  sh(`tar -xzf "${tgz}" -C "${ex}"`);
  const server = findFile(ex, 'llama-server');
  if (!server) { console.log('  ⚠ llama-server not found — skipped'); return null; }
  const s = path.join(STAGE, 'llama-darwin-x64'); fresh(s);
  const serverDest = path.join(s, 'llama-server-x64');
  fs.copyFileSync(server, serverDest); fs.chmodSync(serverDest, 0o755);

  const binDir = path.dirname(server);
  const searchDirs = [binDir, binDir.replace('/bin', '/lib'), path.join(binDir, '..', 'lib')];
  for (const d of DYLIBS) {
    const dn = destName(d, arch);
    let found = false;
    for (const sd of searchDirs) {
      const src = path.join(sd, d);
      if (exists(src)) { fs.copyFileSync(src, path.join(s, dn)); fs.chmodSync(path.join(s, dn), 0o755); found = true; break; }
    }
    if (!found) console.log(`    ⚠ ${d} not found (may be optional)`);
  }
  // patch rpaths: binary + inter-dylib, then ids
  const patch = (target) => {
    for (const ref of DYLIBS) {
      const rdn = destName(ref, arch); const rbase = path.basename(ref, '.dylib');
      for (const rp of [`@rpath/${ref}`, `@rpath/${rbase}.0.dylib`, `@rpath/../lib/${ref}`]) {
        try { sh(`install_name_tool -change "${rp}" @loader_path/${rdn} "${target}"`); } catch {}
      }
    }
  };
  patch(serverDest);
  for (const d of DYLIBS) {
    const dn = destName(d, arch); const tp = path.join(s, dn);
    if (!exists(tp)) continue;
    patch(tp);
    try { sh(`install_name_tool -id @loader_path/${dn} "${tp}"`); } catch {}
  }
  // ad-hoc codesign (rpath edits invalidate signatures)
  try {
    sh(`codesign --force --sign - "${serverDest}"`);
    for (const d of DYLIBS) { const tp = path.join(s, destName(d, arch)); if (exists(tp)) sh(`codesign --force --sign - "${tp}"`); }
  } catch (e) { console.log(`    ⚠ codesign: ${e.message}`); }

  const file = `llama-darwin-x64.tar.gz`;
  const outFile = path.join(OUT, file);
  sh(`tar -czf "${outFile}" -C "${s}" .`);
  console.log(`  ✓ ${file}  (${(bytes(outFile) / 1e6).toFixed(1)} MB)`);
  return { platform: 'darwin', arch, url: `${BASE_URL}/${file}`, file, sha256: sha256(outFile), bytes: bytes(outFile), entry: 'llama-server-x64' };
}

async function buildWinX64() {
  console.log('llama win-x64:');
  const zip = path.join(FETCH, 'llama-win-x64.zip');
  const ex = path.join(FETCH, 'llama-win-x64'); fresh(ex);
  console.log('  ↓ fetching upstream…');
  await download(URLS['win32-x64'], zip);
  sh(`unzip -qo "${zip}" -d "${ex}"`);
  const server = findFile(ex, 'llama-server.exe');
  if (!server) { console.log('  ⚠ llama-server.exe not found — skipped'); return null; }
  const s = path.join(STAGE, 'llama-win32-x64'); fresh(s);
  fs.copyFileSync(server, path.join(s, 'llama-server.exe'));
  const dir = path.dirname(server);
  let dll = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.toLowerCase().endsWith('.dll')) { fs.copyFileSync(path.join(dir, f), path.join(s, f)); dll++; }
  }
  console.log(`    bundled ${dll} DLLs`);
  const file = `llama-win32-x64.zip`;
  const outFile = path.join(OUT, file);
  sh(`cd "${s}" && zip -qr -X "${outFile}" .`);
  console.log(`  ✓ ${file}  (${(bytes(outFile) / 1e6).toFixed(1)} MB)`);
  console.log('    note: VC++ runtime not included; most Windows machines have it.');
  return { platform: 'win32', arch: 'x64', url: `${BASE_URL}/${file}`, file, sha256: sha256(outFile), bytes: bytes(outFile), entry: 'llama-server.exe' };
}

(async function main() {
  if (!exists(path.join(OUT, 'manifest.json'))) { console.error(`No manifest at ${OUT}. Run package-binaries.js first.`); process.exit(1); }
  fresh(FETCH); fresh(STAGE);
  const macX64 = await buildMacX64();
  const winX64 = await buildWinX64();

  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const llama = manifest.components.find(c => c.id === 'llama');
  if (!llama) { console.error('No llama component in manifest'); process.exit(1); }
  for (const art of [macX64, winX64].filter(Boolean)) {
    llama.artifacts = llama.artifacts.filter(a => !(a.platform === art.platform && a.arch === art.arch));
    llama.artifacts.push(art);
    fs.writeFileSync(path.join(OUT, `${art.file}.sha256`), `${art.sha256}  ${art.file}\n`);
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  fs.rmSync(FETCH, { recursive: true, force: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  console.log(`\n✅ Merged llama artifacts into manifest.json. llama now has ${llama.artifacts.length} platform(s).\n`);
})().catch((e) => { console.error('❌', e); process.exit(1); });
