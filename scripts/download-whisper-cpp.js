/**
 * Download/build whisper.cpp binaries and models for all platforms
 *
 * whisper.cpp is a standalone C++ implementation of Whisper that:
 * - Has NO dependencies (no Python, no VC++ runtime)
 * - Is faster than Python Whisper
 * - Works out of the box on all platforms
 *
 * Windows: Downloads pre-built binary
 * macOS/Linux: Builds from source (requires Xcode CLI tools / build-essential)
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

// Model to bundle
const MODEL_NAME = 'ggml-tiny.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin';

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
 * Build whisper.cpp from source for macOS/Linux
 */
async function buildFromSource(platform) {
  const targetName = TARGET_NAMES[platform];
  const cacheTarPath = path.join(CACHE_DIR, `whisper-cpp-source.tar.gz`);
  const cacheExtractDir = path.join(CACHE_DIR, `whisper-cpp-source`);
  const cacheBinaryPath = path.join(CACHE_DIR, targetName);
  const destPath = path.join(BIN_DIR, targetName);

  // Check if already cached
  if (fs.existsSync(cacheBinaryPath)) {
    console.log(`✅ whisper.cpp ${platform} binary found in cache`);
    fs.copyFileSync(cacheBinaryPath, destPath);
    fs.chmodSync(destPath, 0o755);
    return destPath;
  }

  // Check for build tools
  console.log('🔍 Checking for build tools...');
  try {
    if (platform === 'darwin') {
      execSync('which clang', { stdio: 'pipe' });
      console.log('   ✅ clang found');
    } else {
      execSync('which gcc', { stdio: 'pipe' });
      console.log('   ✅ gcc found');
    }
    execSync('which cmake', { stdio: 'pipe' });
    console.log('   ✅ cmake found');
    execSync('which make', { stdio: 'pipe' });
    console.log('   ✅ make found');
  } catch (err) {
    if (platform === 'darwin') {
      throw new Error('Build tools not found. Please install:\n   brew install cmake\n   xcode-select --install');
    } else {
      throw new Error('Build tools not found. Please install:\n   sudo apt-get install build-essential cmake');
    }
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
  console.log('🔨 Building whisper.cpp with CMake (this may take a minute)...');
  try {
    // Configure with CMake
    execSync(`cmake -B build -DCMAKE_BUILD_TYPE=Release`, {
      cwd: sourceDir,
      stdio: 'inherit'
    });

    // Build
    const jobs = platform === 'darwin' ? '4' : '$(nproc)';
    execSync(`cmake --build build --config Release -j ${jobs}`, {
      cwd: sourceDir,
      stdio: 'inherit'
    });
  } catch (err) {
    throw new Error(`Build failed: ${err.message}`);
  }

  // Find the built binary (it's in build/bin/ now)
  // whisper.cpp renamed from main to whisper-cli in v1.8.0+
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
    // List the build directory to help debug
    console.log('Looking for binary in build directory...');
    const buildDir = path.join(sourceDir, 'build');
    if (fs.existsSync(buildDir)) {
      const listDir = (dir, indent = '') => {
        const items = fs.readdirSync(dir).slice(0, 20);
        for (const item of items) {
          const fullPath = path.join(dir, item);
          const stat = fs.statSync(fullPath);
          console.log(`${indent}${item}${stat.isDirectory() ? '/' : ''}`);
          if (stat.isDirectory() && indent.length < 6) {
            listDir(fullPath, indent + '  ');
          }
        }
      };
      listDir(buildDir);
    }
    throw new Error('Build completed but whisper binary not found');
  }

  console.log(`   Found binary: ${builtBinary}`);

  // Copy to cache and destination
  fs.copyFileSync(builtBinary, cacheBinaryPath);
  fs.chmodSync(cacheBinaryPath, 0o755);

  fs.copyFileSync(cacheBinaryPath, destPath);
  fs.chmodSync(destPath, 0o755);

  console.log(`✅ ${platform} binary built and installed: ${targetName}`);
  return destPath;
}

/**
 * Download the Whisper model
 */
async function downloadModel() {
  const cacheModelPath = path.join(CACHE_DIR, MODEL_NAME);
  const destModelPath = path.join(MODELS_DIR, MODEL_NAME);

  if (fs.existsSync(cacheModelPath)) {
    console.log(`✅ Whisper model found in cache`);
    fs.copyFileSync(cacheModelPath, destModelPath);
    return destModelPath;
  }

  if (fs.existsSync(destModelPath)) {
    console.log(`✅ Whisper model already exists`);
    fs.copyFileSync(destModelPath, cacheModelPath);
    return destModelPath;
  }

  console.log(`📥 Downloading Whisper model (${MODEL_NAME})...`);
  console.log(`   URL: ${MODEL_URL}`);
  console.log('   This may take a few minutes (~75MB)...');

  await downloadFile(MODEL_URL, cacheModelPath);
  fs.copyFileSync(cacheModelPath, destModelPath);

  console.log(`✅ Model installed: ${MODEL_NAME}`);
  return destModelPath;
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
    } else {
      binaryPath = await buildFromSource(platform);
    }

    // Download model
    console.log('\n📋 Step 2: Download Whisper model\n');
    const modelPath = await downloadModel();

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         whisper.cpp Setup Complete! ✅                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`📁 Binary: ${binaryPath}`);
    console.log(`📁 Model: ${modelPath}`);
    console.log('\n💾 Files cached in .build-cache/whisper-cpp/ for reuse\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║              Setup Failed ❌                              ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    if (process.platform !== 'win32') {
      console.error('Note: Building whisper.cpp requires:\n');
      console.error('  macOS: Xcode Command Line Tools (xcode-select --install)');
      console.error('  Linux: build-essential (sudo apt-get install build-essential)\n');
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { downloadWhisperCpp: main };
