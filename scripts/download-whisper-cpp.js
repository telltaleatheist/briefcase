/**
 * Download whisper.cpp pre-built binaries and models for all platforms
 *
 * whisper.cpp is a standalone C++ implementation of Whisper that:
 * - Has minimal dependencies (no Python required)
 * - Requires Visual C++ Runtime on Windows (bundled by this script)
 * - Is faster than Python Whisper
 * - Works out of the box on all platforms
 *
 * This script downloads PRE-BUILT binaries for ALL target architectures:
 * - macOS: arm64 (Apple Silicon) from Homebrew bottle
 * - macOS: x64 (Intel) from Homebrew bottle
 * - Windows: x64 from GitHub releases
 * - Linux: x64 from GitHub releases (or Homebrew)
 *
 * NO CMAKE OR BUILD TOOLS REQUIRED!
 *
 * Usage:
 *   node scripts/download-whisper-cpp.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const { createGunzip } = require('zlib');

const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');
const MODELS_DIR = path.join(__dirname, '..', 'utilities', 'models');
const CACHE_DIR = path.join(__dirname, '..', '.build-cache', 'whisper-cpp');

// Models to bundle (tiny, base, small)
const MODELS = [
  { name: 'ggml-tiny.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', size: '~75MB' },
  { name: 'ggml-base.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', size: '~142MB' },
  { name: 'ggml-small.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', size: '~466MB' },
];

// GitHub releases for Windows
const WHISPER_CPP_VERSION = '1.8.2';
const WINDOWS_BINARY_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;

// Target binary names per platform/architecture
const BINARY_NAMES = {
  'darwin-arm64': 'whisper-cli-arm64',
  'darwin-x64': 'whisper-cli-x64',
  'win32-x64': 'whisper-cli.exe',
  'linux-x64': 'whisper-cli',
};

// macOS dylibs
const MACOS_DYLIBS = [
  'libwhisper.1.dylib',
  'libggml.dylib',
  'libggml-base.dylib',
  'libggml-cpu.dylib',
  'libggml-blas.dylib',
  'libggml-metal.dylib',
];

// Visual C++ Runtime DLLs required for Windows builds
const VCRUNTIME_DLLS = [
  'MSVCP140.dll',
  'MSVCP140_CODECVT_IDS.dll',
  'VCRUNTIME140.dll',
  'VCRUNTIME140_1.dll',
];

/**
 * Download a file with redirect support
 */
function downloadFile(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let redirectCount = 0;
    const maxRedirects = 10;

    function doRequest(currentUrl) {
      const protocol = currentUrl.startsWith('https') ? https : http;

      const options = {
        headers: {
          'User-Agent': 'ClipChimp/1.0',
          ...headers
        }
      };

      protocol.get(currentUrl, options, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          redirectCount++;
          if (redirectCount > maxRedirects) {
            reject(new Error('Too many redirects'));
            return;
          }

          let redirectUrl = response.headers.location;
          if (redirectUrl.startsWith('/')) {
            const urlObj = new URL(currentUrl);
            redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
          }

          doRequest(redirectUrl);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage} for ${currentUrl}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'], 10);
        let downloadedBytes = 0;
        let lastPercent = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes) {
            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
            if (percent >= lastPercent + 10) {
              process.stdout.write(`\r   Progress: ${percent}%`);
              lastPercent = percent;
            }
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\r   Progress: 100%');
          resolve();
        });

        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    doRequest(url);
  });
}

/**
 * Extract a zip file
 */
async function extractZip(zipPath, destDir) {
  const extractZipModule = require('extract-zip');
  await extractZipModule(zipPath, { dir: destDir });
}

/**
 * Find a file in directory recursively
 */
function findFile(dir, filename) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (file === filename || file.toLowerCase() === filename.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Check if a binary is valid (exists and is large enough)
 */
function isValidBinary(filePath, minSize = 100 * 1024) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  return stats.size >= minSize;
}

/**
 * Get Homebrew bottle URL for whisper-cpp
 */
async function getHomebrewBottleUrl(osVersion, isArm64) {
  // Get the brew info JSON
  const result = execSync('brew info whisper-cpp --json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const info = JSON.parse(result)[0];
  const bottle = info.bottle?.stable;

  if (!bottle) {
    throw new Error('No Homebrew bottle available for whisper-cpp');
  }

  // Determine which bottle to use
  // arm64_sonoma/arm64_sequoia for Apple Silicon, sonoma for Intel
  const files = bottle.files;
  let bottleKey;

  if (isArm64) {
    // Prefer newer macOS versions for arm64
    bottleKey = files.arm64_tahoe ? 'arm64_tahoe' :
                files.arm64_sequoia ? 'arm64_sequoia' :
                files.arm64_sonoma ? 'arm64_sonoma' : null;
  } else {
    // Intel - use non-arm64 macOS bottle
    bottleKey = files.sonoma ? 'sonoma' :
                files.ventura ? 'ventura' : null;
  }

  if (!bottleKey || !files[bottleKey]) {
    throw new Error(`No Homebrew bottle for ${isArm64 ? 'arm64' : 'x64'} macOS`);
  }

  return {
    url: files[bottleKey].url,
    sha256: files[bottleKey].sha256,
    version: info.versions.stable
  };
}

/**
 * Download and extract Homebrew bottle for macOS
 */
async function downloadHomebrewBottle(arch) {
  const binaryName = BINARY_NAMES[`darwin-${arch}`];
  const destPath = path.join(BIN_DIR, binaryName);
  const isArm64 = arch === 'arm64';

  // Check if already exists
  if (isValidBinary(destPath)) {
    console.log(`✅ ${binaryName} already exists`);
    return destPath;
  }

  console.log(`📥 Getting Homebrew bottle info for macOS ${arch}...`);

  let bottleInfo;
  try {
    bottleInfo = await getHomebrewBottleUrl('sonoma', isArm64);
  } catch (err) {
    console.error(`Failed to get Homebrew bottle: ${err.message}`);
    throw err;
  }

  const cacheBottlePath = path.join(CACHE_DIR, `whisper-cpp-${bottleInfo.version}-${arch}.tar.gz`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-${arch}`);

  // Download bottle if not cached
  if (!fs.existsSync(cacheBottlePath) || fs.statSync(cacheBottlePath).size < 100 * 1024) {
    console.log(`📥 Downloading Homebrew bottle for ${arch}...`);
    console.log(`   URL: ${bottleInfo.url}`);

    // Homebrew bottles need authentication header for GHCR
    await downloadFile(bottleInfo.url, cacheBottlePath, {
      'Authorization': 'Bearer QQ==',
      'Accept': 'application/vnd.oci.image.layer.v1.tar+gzip'
    });
  } else {
    console.log(`   Using cached bottle`);
  }

  // Extract bottle
  console.log('📦 Extracting bottle...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });

  execSync(`tar -xzf "${cacheBottlePath}" -C "${cacheExtractDir}"`, { stdio: 'pipe' });

  // Find the whisper-cli binary in the extracted bottle
  const whisperCliPath = findFile(cacheExtractDir, 'whisper-cli');
  if (!whisperCliPath) {
    throw new Error('whisper-cli not found in extracted bottle');
  }

  // Copy binary
  console.log(`📋 Installing ${binaryName}...`);
  fs.copyFileSync(whisperCliPath, destPath);
  fs.chmodSync(destPath, 0o755);

  // Find and copy dylibs - search multiple possible locations
  const binDir = path.dirname(whisperCliPath);
  const searchDirs = [
    binDir.replace('/bin', '/lib'),
    binDir.replace('/bin', '/libinternal'),
    binDir.replace('/bin', '/libexec/lib'),
    binDir,
  ];

  console.log('   Searching for dylibs...');
  for (const dylib of MACOS_DYLIBS) {
    const archDylibName = `${path.basename(dylib, '.dylib')}-${arch}.dylib`;
    const destDylib = path.join(BIN_DIR, archDylibName);
    let found = false;

    for (const searchDir of searchDirs) {
      const srcDylib = path.join(searchDir, dylib);
      if (fs.existsSync(srcDylib)) {
        fs.copyFileSync(srcDylib, destDylib);
        fs.chmodSync(destDylib, 0o755);
        console.log(`   ✓ ${dylib} -> ${archDylibName}`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`   ⚠ ${dylib} not found`);
    }
  }

  // Fix rpaths in main binary
  console.log('🔧 Fixing library paths in main binary...');
  for (const dylib of MACOS_DYLIBS) {
    const archDylibName = `${path.basename(dylib, '.dylib')}-${arch}.dylib`;
    try {
      execSync(
        `install_name_tool -change @rpath/${dylib} @loader_path/${archDylibName} "${destPath}"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      // Some dylibs may not be referenced
    }
  }

  // Fix inter-dylib dependencies (dylibs reference each other)
  console.log('🔧 Fixing library paths in dylibs...');
  for (const targetDylib of MACOS_DYLIBS) {
    const targetArchName = `${path.basename(targetDylib, '.dylib')}-${arch}.dylib`;
    const targetPath = path.join(BIN_DIR, targetArchName);

    if (!fs.existsSync(targetPath)) continue;

    // Fix this dylib's references to other dylibs
    for (const refDylib of MACOS_DYLIBS) {
      const refArchName = `${path.basename(refDylib, '.dylib')}-${arch}.dylib`;
      try {
        // Fix @rpath references
        execSync(
          `install_name_tool -change @rpath/${refDylib} @loader_path/${refArchName} "${targetPath}"`,
          { stdio: 'pipe' }
        );
        // Also fix any ../lib references
        execSync(
          `install_name_tool -change @rpath/../lib/${refDylib} @loader_path/${refArchName} "${targetPath}"`,
          { stdio: 'pipe' }
        );
      } catch (err) {
        // Some dylibs may not reference others
      }
    }

    // Also update the dylib's own install name to the arch-specific version
    try {
      execSync(
        `install_name_tool -id @loader_path/${targetArchName} "${targetPath}"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      // May fail if already set
    }
  }

  // Codesign everything
  console.log('🔏 Codesigning binaries...');
  try {
    execSync(`codesign --force --sign - "${destPath}"`, { stdio: 'pipe' });
    for (const dylib of MACOS_DYLIBS) {
      const archDylibName = `${path.basename(dylib, '.dylib')}-${arch}.dylib`;
      const dylibPath = path.join(BIN_DIR, archDylibName);
      if (fs.existsSync(dylibPath)) {
        execSync(`codesign --force --sign - "${dylibPath}"`, { stdio: 'pipe' });
      }
    }
  } catch (err) {
    console.warn(`   ⚠ Codesign warning: ${err.message}`);
  }

  console.log(`✅ Installed ${binaryName}`);
  return destPath;
}

/**
 * Setup whisper.cpp for all macOS architectures
 */
async function setupMacOS() {
  const arm64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-arm64']);
  const x64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-x64']);

  // Check if both already exist
  if (isValidBinary(arm64Path) && isValidBinary(x64Path)) {
    console.log(`✅ whisper.cpp: Both macOS binaries already exist`);
    return;
  }

  // Check if Homebrew is available
  try {
    execSync('which brew', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Homebrew not found. Please install Homebrew:\n\n' +
      '   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n' +
      'Then run this script again.'
    );
  }

  // Make sure whisper-cpp formula is available
  try {
    execSync('brew info whisper-cpp', { stdio: 'pipe' });
  } catch {
    console.log('📦 Updating Homebrew and fetching whisper-cpp info...');
    execSync('brew update', { stdio: 'pipe' });
  }

  // Download both architectures
  if (!isValidBinary(arm64Path)) {
    await downloadHomebrewBottle('arm64');
  } else {
    console.log(`✅ whisper.cpp arm64 already exists`);
  }

  if (!isValidBinary(x64Path)) {
    await downloadHomebrewBottle('x64');
  } else {
    console.log(`✅ whisper.cpp x64 already exists`);
  }
}

/**
 * Download and setup whisper.cpp binary for Windows
 */
async function downloadWindowsBinary() {
  const binaryName = BINARY_NAMES['win32-x64'];
  const destPath = path.join(BIN_DIR, binaryName);
  const cacheZipPath = path.join(CACHE_DIR, `whisper-cpp-win32-v${WHISPER_CPP_VERSION}.zip`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-win32`);

  // Check if already exists
  if (isValidBinary(destPath)) {
    console.log(`✅ Windows binary already exists`);
    return destPath;
  }

  console.log(`📥 Downloading whisper.cpp v${WHISPER_CPP_VERSION} for Windows...`);

  if (!fs.existsSync(cacheZipPath) || fs.statSync(cacheZipPath).size < 100 * 1024) {
    await downloadFile(WINDOWS_BINARY_URL, cacheZipPath);
  } else {
    console.log('   ZIP already downloaded');
  }

  console.log('📦 Extracting...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });
  await extractZip(cacheZipPath, cacheExtractDir);

  // Find whisper-cli.exe
  const possibleNames = ['whisper-cli.exe', 'whisper.exe', 'main.exe'];
  let foundBinary = null;

  for (const name of possibleNames) {
    foundBinary = findFile(cacheExtractDir, name);
    if (foundBinary) {
      console.log(`   Found binary: ${name}`);
      break;
    }
  }

  if (!foundBinary) {
    throw new Error(`Could not find whisper binary in extracted archive`);
  }

  fs.copyFileSync(foundBinary, destPath);
  console.log(`✅ Windows binary installed: ${binaryName}`);

  // Copy ALL DLLs from the release to ensure everything works
  const binaryDir = path.dirname(foundBinary);
  const dllFiles = fs.readdirSync(binaryDir).filter(f => f.toLowerCase().endsWith('.dll'));
  console.log(`   Found ${dllFiles.length} DLLs to copy`);

  for (const dll of dllFiles) {
    const srcPath = path.join(binaryDir, dll);
    const destDllPath = path.join(BIN_DIR, dll);
    fs.copyFileSync(srcPath, destDllPath);
    console.log(`   ✓ ${dll}`);
  }

  return destPath;
}

/**
 * Ensure Visual C++ Runtime DLLs are present for Windows
 */
function ensureVCRuntime() {
  if (process.platform !== 'win32') return;

  console.log('📋 Checking Visual C++ Runtime DLLs...');

  let allPresent = true;
  for (const dll of VCRUNTIME_DLLS) {
    const destPath = path.join(BIN_DIR, dll);
    if (!fs.existsSync(destPath)) {
      allPresent = false;
      const systemPath = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', dll);
      if (fs.existsSync(systemPath)) {
        fs.copyFileSync(systemPath, destPath);
        console.log(`   ✓ Copied ${dll} from system`);
      } else {
        console.log(`   ⚠ ${dll} not found`);
      }
    }
  }

  if (allPresent) {
    console.log('   ✓ All VC++ Runtime DLLs already present');
  }
}

/**
 * Download all Whisper models
 */
async function downloadModels() {
  const downloadedModels = [];

  for (const model of MODELS) {
    const cacheModelPath = path.join(CACHE_DIR, model.name);
    const destModelPath = path.join(MODELS_DIR, model.name);

    if (fs.existsSync(destModelPath)) {
      const stats = fs.statSync(destModelPath);
      if (stats.size > 1000000) {
        console.log(`✅ ${model.name} already exists (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
        downloadedModels.push(destModelPath);
        continue;
      }
    }

    if (fs.existsSync(cacheModelPath)) {
      const stats = fs.statSync(cacheModelPath);
      if (stats.size > 1000000) {
        console.log(`✅ ${model.name} found in cache`);
        fs.copyFileSync(cacheModelPath, destModelPath);
        downloadedModels.push(destModelPath);
        continue;
      }
    }

    console.log(`📥 Downloading ${model.name} (${model.size})...`);
    await downloadFile(model.url, cacheModelPath);
    fs.copyFileSync(cacheModelPath, destModelPath);

    console.log(`✅ Model installed: ${model.name}`);
    downloadedModels.push(destModelPath);
  }

  return downloadedModels;
}

/**
 * Check if all required binaries and models are cached
 */
function isEverythingCached() {
  const platform = process.platform;

  // Check models
  const hasAllModels = MODELS.every(model => {
    const modelPath = path.join(MODELS_DIR, model.name);
    return fs.existsSync(modelPath) && fs.statSync(modelPath).size > 1024 * 1024;
  });

  if (!hasAllModels) return false;

  // Check binaries based on platform
  if (platform === 'darwin') {
    const arm64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-arm64']);
    const x64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-x64']);
    return isValidBinary(arm64Path) && isValidBinary(x64Path);
  } else if (platform === 'win32') {
    // Check main binary
    if (!isValidBinary(path.join(BIN_DIR, BINARY_NAMES['win32-x64']))) {
      return false;
    }
    // Check VC++ Runtime DLLs
    for (const dll of VCRUNTIME_DLLS) {
      if (!fs.existsSync(path.join(BIN_DIR, dll))) {
        return false;
      }
    }
    return true;
  } else {
    return isValidBinary(path.join(BIN_DIR, BINARY_NAMES['linux-x64']));
  }
}

/**
 * Main function
 */
async function main() {
  try {
    const platform = process.platform;

    // Quick check if everything is cached
    if (isEverythingCached()) {
      console.log('✅ whisper.cpp: All binaries and models already cached');
      return;
    }

    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Pre-Built Binary Setup               ║');
    console.log('║   Downloading for ALL target platforms/architectures     ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log(`Build platform: ${platform} (${process.arch})\n`);

    // Create directories
    for (const dir of [BIN_DIR, MODELS_DIR, CACHE_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Download binaries based on platform
    console.log('📋 Step 1: Download whisper.cpp binaries\n');

    if (platform === 'darwin') {
      await setupMacOS();
    } else if (platform === 'win32') {
      await downloadWindowsBinary();
      // Ensure VC++ Runtime DLLs are present for clean systems
      ensureVCRuntime();
    } else {
      // Linux - use Windows download approach with Linux binary
      console.log('⚠️  Linux not yet supported in this version');
    }

    // Download models
    console.log('\n📋 Step 2: Download Whisper models\n');
    const modelPaths = await downloadModels();

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Setup Complete! ✅                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // List what was installed
    console.log('📁 Binaries:');
    for (const [key, name] of Object.entries(BINARY_NAMES)) {
      const binPath = path.join(BIN_DIR, name);
      if (fs.existsSync(binPath)) {
        const stats = fs.statSync(binPath);
        console.log(`   ✓ ${name} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
      }
    }

    console.log(`\n📁 Models: ${modelPaths.length} installed`);
    for (const mp of modelPaths) {
      console.log(`   ✓ ${path.basename(mp)}`);
    }

    console.log('\n💾 Files cached in .build-cache/whisper-cpp/ for reuse\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║              Setup Failed ❌                              ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadWhisperCpp: main };
