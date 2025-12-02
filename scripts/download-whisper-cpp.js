/**
 * Download/setup whisper.cpp binaries and models for all platforms
 *
 * whisper.cpp is a standalone C++ implementation of Whisper that:
 * - Has NO dependencies (no Python, no VC++ runtime)
 * - Is faster than Python Whisper
 * - Works out of the box on all platforms
 *
 * Windows: Downloads pre-built binary from GitHub releases
 * macOS: Copies from Homebrew installation (brew install whisper-cpp)
 * Linux: Builds from source (requires build-essential)
 *
 * Usage:
 *   node scripts/download-whisper-cpp.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');
const MODELS_DIR = path.join(__dirname, '..', 'utilities', 'models');
const CACHE_DIR = path.join(__dirname, '..', '.build-cache', 'whisper-cpp');

// whisper.cpp release version
const WHISPER_CPP_VERSION = '1.8.2';

// Models to bundle (tiny, base, small)
const MODELS = [
  { name: 'ggml-tiny.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin', size: '~75MB' },
  { name: 'ggml-base.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', size: '~142MB' },
  { name: 'ggml-small.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin', size: '~466MB' },
];

// Windows pre-built binary URL
const WINDOWS_BINARY_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v${WHISPER_CPP_VERSION}/whisper-bin-x64.zip`;

// Source code URL for building on macOS/Linux
const SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz`;

// Target binary names (whisper.cpp renamed from main/whisper to whisper-cli in v1.8.0+)
const TARGET_NAMES = {
  win32: 'whisper-cli.exe',
  darwin: 'whisper-cli',
  linux: 'whisper-cli'
};

/**
 * Download a file with redirect support
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let redirectCount = 0;
    const maxRedirects = 10;

    function doRequest(currentUrl) {
      const protocol = currentUrl.startsWith('https') ? https : http;

      const options = {
        headers: {
          'User-Agent': 'ClipChimp/1.0'
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
 * Extract a tar.gz file
 */
function extractTarGz(tarPath, destDir) {
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'inherit' });
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
 * Download and setup whisper.cpp binary for Windows
 */
async function downloadWindowsBinary() {
  const targetName = TARGET_NAMES.win32;
  const cacheZipPath = path.join(CACHE_DIR, `whisper-cpp-win32.zip`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-win32`);
  const cacheBinaryPath = path.join(CACHE_DIR, targetName);
  const destPath = path.join(BIN_DIR, targetName);

  // Check if already cached
  if (fs.existsSync(cacheBinaryPath)) {
    console.log(`✅ whisper.cpp Windows binary found in cache`);
    fs.copyFileSync(cacheBinaryPath, destPath);
    return destPath;
  }

  console.log(`📥 Downloading whisper.cpp v${WHISPER_CPP_VERSION} for Windows...`);
  console.log(`   URL: ${WINDOWS_BINARY_URL}`);

  if (!fs.existsSync(cacheZipPath)) {
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

  // Find whisper-cli.exe (the main CLI binary, renamed in v1.8.0+)
  // Try multiple possible names in order of preference
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
    throw new Error(`Could not find whisper binary in extracted archive. Tried: ${possibleNames.join(', ')}`);
  }

  fs.copyFileSync(foundBinary, cacheBinaryPath);
  fs.copyFileSync(cacheBinaryPath, destPath);
  console.log(`✅ Windows binary installed: ${targetName}`);

  // Copy required DLLs (whisper-cli.exe needs these to run)
  const requiredDlls = ['ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll', 'whisper.dll'];
  const binaryDir = path.dirname(foundBinary);

  for (const dll of requiredDlls) {
    const dllPath = path.join(binaryDir, dll);
    if (fs.existsSync(dllPath)) {
      const destDllPath = path.join(BIN_DIR, dll);
      fs.copyFileSync(dllPath, destDllPath);
      console.log(`   ✓ Copied ${dll}`);
    } else {
      console.warn(`   ⚠ DLL not found: ${dll}`);
    }
  }

  return destPath;
}

/**
 * Setup whisper.cpp from Homebrew on macOS
 * Copies binary and dylibs, fixes rpath, and codesigns
 */
async function setupFromHomebrew() {
  const targetName = TARGET_NAMES.darwin;
  const destPath = path.join(BIN_DIR, targetName);

  // Check if already set up
  if (fs.existsSync(destPath)) {
    // Verify it works
    try {
      execSync(`"${destPath}" --help`, { stdio: 'pipe', timeout: 5000 });
      console.log(`✅ whisper-cli already installed and working`);
      return destPath;
    } catch (err) {
      console.log('   Existing binary not working, reinstalling...');
    }
  }

  // Find Homebrew whisper-cpp installation
  const homebrewPaths = [
    '/opt/homebrew/Cellar/whisper-cpp',  // Apple Silicon
    '/usr/local/Cellar/whisper-cpp',     // Intel Mac
  ];

  let whisperDir = null;
  for (const basePath of homebrewPaths) {
    if (fs.existsSync(basePath)) {
      // Find the latest version
      const versions = fs.readdirSync(basePath).sort().reverse();
      if (versions.length > 0) {
        whisperDir = path.join(basePath, versions[0]);
        break;
      }
    }
  }

  if (!whisperDir) {
    throw new Error(
      'whisper-cpp not found. Please install it first:\n\n' +
      '   brew install whisper-cpp\n\n' +
      'Then run this script again.'
    );
  }

  console.log(`📦 Found Homebrew whisper-cpp: ${whisperDir}`);

  const binPath = path.join(whisperDir, 'bin', 'whisper-cli');
  const libPath = path.join(whisperDir, 'libinternal');

  if (!fs.existsSync(binPath)) {
    throw new Error(`whisper-cli binary not found at: ${binPath}`);
  }

  // Required dylibs
  const dylibs = [
    'libwhisper.1.dylib',
    'libggml.dylib',
    'libggml-base.dylib',
    'libggml-cpu.dylib',
    'libggml-blas.dylib',
    'libggml-metal.dylib',
  ];

  // Copy binary
  console.log('📋 Copying whisper-cli binary...');
  fs.copyFileSync(binPath, destPath);
  fs.chmodSync(destPath, 0o755);

  // Copy dylibs
  console.log('📋 Copying dynamic libraries...');
  for (const dylib of dylibs) {
    const srcDylib = path.join(libPath, dylib);
    const destDylib = path.join(BIN_DIR, dylib);
    if (fs.existsSync(srcDylib)) {
      fs.copyFileSync(srcDylib, destDylib);
      fs.chmodSync(destDylib, 0o755);
      console.log(`   ✓ ${dylib}`);
    } else {
      console.warn(`   ⚠ ${dylib} not found`);
    }
  }

  // Fix rpath references to use @loader_path (same directory)
  console.log('🔧 Fixing library paths...');
  const allBinaries = [targetName, ...dylibs];

  for (const binary of allBinaries) {
    const binaryPath = path.join(BIN_DIR, binary);
    if (!fs.existsSync(binaryPath)) continue;

    for (const dylib of dylibs) {
      try {
        execSync(
          `install_name_tool -change @rpath/${dylib} @loader_path/${dylib} "${binaryPath}"`,
          { stdio: 'pipe' }
        );
      } catch (err) {
        // Ignore errors - some binaries may not reference all dylibs
      }
    }
  }

  // Codesign all binaries (required on macOS after modification)
  console.log('🔐 Code signing binaries...');
  for (const binary of allBinaries) {
    const binaryPath = path.join(BIN_DIR, binary);
    if (!fs.existsSync(binaryPath)) continue;

    try {
      execSync(`codesign --force --sign - "${binaryPath}"`, { stdio: 'pipe' });
    } catch (err) {
      console.warn(`   ⚠ Failed to sign ${binary}`);
    }
  }

  // Verify it works
  console.log('✅ Verifying installation...');
  try {
    execSync(`"${destPath}" --help`, { stdio: 'pipe', timeout: 5000 });
    console.log('   ✓ whisper-cli is working');
  } catch (err) {
    throw new Error('Installation failed - whisper-cli not working after setup');
  }

  console.log(`✅ macOS binary installed: ${targetName}`);
  return destPath;
}

/**
 * Build whisper.cpp from source for Linux
 */
async function buildFromSource() {
  const targetName = TARGET_NAMES.linux;
  const cacheTarPath = path.join(CACHE_DIR, `whisper-cpp-source.tar.gz`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-source`);
  const cacheBinaryPath = path.join(CACHE_DIR, targetName);
  const destPath = path.join(BIN_DIR, targetName);

  // Check if already cached
  if (fs.existsSync(cacheBinaryPath)) {
    console.log(`✅ whisper.cpp linux binary found in cache`);
    fs.copyFileSync(cacheBinaryPath, destPath);
    fs.chmodSync(destPath, 0o755);
    return destPath;
  }

  // Check for build tools
  console.log('🔍 Checking for build tools...');
  try {
    execSync('which gcc', { stdio: 'pipe' });
    console.log('   ✅ gcc found');
    execSync('which cmake', { stdio: 'pipe' });
    console.log('   ✅ cmake found');
    execSync('which make', { stdio: 'pipe' });
    console.log('   ✅ make found');
  } catch (err) {
    throw new Error('Build tools not found. Please install:\n   sudo apt-get install build-essential cmake');
  }

  // Download source
  console.log(`📥 Downloading whisper.cpp v${WHISPER_CPP_VERSION} source...`);
  console.log(`   URL: ${SOURCE_URL}`);

  if (!fs.existsSync(cacheTarPath)) {
    await downloadFile(SOURCE_URL, cacheTarPath);
  } else {
    console.log('   Source already downloaded');
  }

  // Extract
  console.log('📦 Extracting source...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });
  extractTarGz(cacheTarPath, cacheExtractDir);

  // Find the extracted directory
  const extractedDirs = fs.readdirSync(cacheExtractDir).filter(f =>
    fs.statSync(path.join(cacheExtractDir, f)).isDirectory()
  );
  if (extractedDirs.length === 0) {
    throw new Error('No directory found in extracted source');
  }
  const sourceDir = path.join(cacheExtractDir, extractedDirs[0]);

  // Build using CMake
  console.log('🔨 Building whisper.cpp with CMake (this may take a few minutes)...');
  try {
    execSync(`cmake -B build -DCMAKE_BUILD_TYPE=Release`, {
      cwd: sourceDir,
      stdio: 'inherit'
    });

    execSync(`cmake --build build --config Release -j $(nproc)`, {
      cwd: sourceDir,
      stdio: 'inherit'
    });
  } catch (err) {
    throw new Error(`Build failed: ${err.message}`);
  }

  // Find the built binary
  const possibleBinaryPaths = [
    path.join(sourceDir, 'build', 'bin', 'whisper-cli'),
    path.join(sourceDir, 'build', 'bin', 'main'),
    path.join(sourceDir, 'build', 'whisper-cli'),
    path.join(sourceDir, 'build', 'main'),
  ];

  let builtBinary = null;
  for (const p of possibleBinaryPaths) {
    if (fs.existsSync(p)) {
      builtBinary = p;
      break;
    }
  }

  if (!builtBinary) {
    throw new Error('Build completed but whisper binary not found');
  }

  console.log(`   Found binary: ${builtBinary}`);

  // Copy to cache and destination
  fs.copyFileSync(builtBinary, cacheBinaryPath);
  fs.chmodSync(cacheBinaryPath, 0o755);

  fs.copyFileSync(cacheBinaryPath, destPath);
  fs.chmodSync(destPath, 0o755);

  console.log(`✅ Linux binary built and installed: ${targetName}`);
  return destPath;
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
      if (stats.size > 1000000) { // > 1MB means it's a real model file
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
    console.log(`   URL: ${model.url}`);

    await downloadFile(model.url, cacheModelPath);
    fs.copyFileSync(cacheModelPath, destModelPath);

    console.log(`✅ Model installed: ${model.name}`);
    downloadedModels.push(destModelPath);
  }

  return downloadedModels;
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Setup                                 ║');
    console.log('║   Standalone Whisper - No Python/VC++ Required!           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const platform = process.platform;
    console.log(`Platform: ${platform}\n`);

    // Create directories
    for (const dir of [BIN_DIR, MODELS_DIR, CACHE_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Download/build binary based on platform
    console.log('📋 Step 1: Setup whisper.cpp binary\n');

    let binaryPath;
    if (platform === 'win32') {
      binaryPath = await downloadWindowsBinary();
    } else if (platform === 'darwin') {
      binaryPath = await setupFromHomebrew();
    } else {
      binaryPath = await buildFromSource();
    }

    // Download models
    console.log('\n📋 Step 2: Download Whisper models (tiny, base, small)\n');
    const modelPaths = await downloadModels();

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Setup Complete! ✅                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`📁 Binary: ${binaryPath}`);
    console.log(`📁 Models: ${modelPaths.length} models installed`);
    for (const mp of modelPaths) {
      console.log(`   - ${path.basename(mp)}`);
    }
    console.log('\n💾 Files cached in .build-cache/whisper-cpp/ for reuse\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║              Setup Failed ❌                              ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    if (process.platform === 'darwin') {
      console.error('Note: On macOS, install whisper-cpp via Homebrew:\n');
      console.error('  brew install whisper-cpp\n');
    } else if (process.platform === 'linux') {
      console.error('Note: On Linux, building whisper.cpp requires:\n');
      console.error('  sudo apt-get install build-essential cmake\n');
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadWhisperCpp: main };
