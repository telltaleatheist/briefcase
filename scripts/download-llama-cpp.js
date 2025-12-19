/**
 * Download llama.cpp pre-built binaries and Cogito 8B model for all platforms
 *
 * llama.cpp is a standalone C++ implementation of LLaMA inference that:
 * - Has NO dependencies (no Python, no VC++ runtime on Windows)
 * - Supports Metal acceleration on macOS
 * - Runs GGUF quantized models efficiently
 *
 * This script downloads PRE-BUILT binaries for ALL target architectures:
 * - macOS: arm64 (Apple Silicon) with Metal support
 * - macOS: x64 (Intel)
 * - Windows: x64 CPU version
 *
 * Also downloads the Cogito 8B Q6_K model (~6.6 GB) from HuggingFace.
 *
 * NO CMAKE OR BUILD TOOLS REQUIRED!
 *
 * Usage:
 *   node scripts/download-llama-cpp.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');
const MODELS_DIR = path.join(__dirname, '..', 'utilities', 'models', 'llama');
const CACHE_DIR = path.join(__dirname, '..', '.build-cache', 'llama-cpp');

// llama.cpp version to download
const LLAMA_CPP_VERSION = 'b7482';

// Model to bundle
const MODEL = {
  name: 'cogito-8b-q6_k.gguf',
  url: 'https://huggingface.co/bartowski/deepcogito_cogito-v1-preview-llama-8B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-8B-Q6_K.gguf',
  size: '~6.6GB',
  sizeBytes: 6.6 * 1024 * 1024 * 1024,
};

// Binary URLs per platform
const BINARY_URLS = {
  'darwin-arm64': `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-macos-arm64.tar.gz`,
  'darwin-x64': `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-macos-x64.tar.gz`,
  'win32-x64': `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}/llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`,
};

// Target binary names per platform/architecture
const BINARY_NAMES = {
  'darwin-arm64': 'llama-server-arm64',
  'darwin-x64': 'llama-server-x64',
  'win32-x64': 'llama-server.exe',
};

// macOS dylibs to copy (llama-specific, not shared with whisper)
// We prefix with 'llama-' to avoid conflicts with whisper's ggml libs
const MACOS_DYLIBS = [
  'libllama.dylib',
];

// ggml dylibs that llama needs - these will be prefixed with 'llama-'
// to avoid overwriting whisper's ggml libraries
const MACOS_GGML_DYLIBS = [
  'libggml.dylib',
  'libggml-base.dylib',
  'libggml-cpu.dylib',
  'libggml-metal.dylib',
  'libggml-blas.dylib',
  'libggml-rpc.dylib',
  'libmtmd.dylib',  // metal tensor lib
];

// Windows DLLs to copy
const WINDOWS_DLLS = [
  'llama.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu.dll',
];

/**
 * Download a file with redirect support and progress display
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
          ...headers,
        },
      };

      protocol
        .get(currentUrl, options, (response) => {
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
          let lastLogTime = Date.now();

          response.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalBytes) {
              const percent = Math.floor((downloadedBytes / totalBytes) * 100);
              const now = Date.now();
              // Log every 5% or every 2 seconds for large files
              if (percent >= lastPercent + 5 || (now - lastLogTime > 2000 && percent > lastPercent)) {
                const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(1);
                const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
                process.stdout.write(`\r   Progress: ${percent}% (${downloadedMB}/${totalMB} MB)`);
                lastPercent = percent;
                lastLogTime = now;
              }
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log('\r   Progress: 100%                              ');
            resolve();
          });

          file.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
          });
        })
        .on('error', (err) => {
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
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'pipe' });
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
 * Download and extract llama.cpp for macOS
 */
async function downloadMacOSBinary(arch) {
  const binaryName = BINARY_NAMES[`darwin-${arch}`];
  const destPath = path.join(BIN_DIR, binaryName);

  // Check if already exists
  if (isValidBinary(destPath)) {
    console.log(`✅ ${binaryName} already exists`);
    return destPath;
  }

  const url = BINARY_URLS[`darwin-${arch}`];
  const cacheFileName = `llama-cpp-${LLAMA_CPP_VERSION}-macos-${arch}.tar.gz`;
  const cacheTarPath = path.join(CACHE_DIR, cacheFileName);
  const cacheExtractDir = path.join(CACHE_DIR, `llama-cpp-macos-${arch}`);

  console.log(`📥 Downloading llama.cpp ${LLAMA_CPP_VERSION} for macOS ${arch}...`);

  // Download if not cached
  if (!fs.existsSync(cacheTarPath) || fs.statSync(cacheTarPath).size < 100 * 1024) {
    console.log(`   URL: ${url}`);
    await downloadFile(url, cacheTarPath);
  } else {
    console.log('   Using cached archive');
  }

  // Extract
  console.log('📦 Extracting...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });
  extractTarGz(cacheTarPath, cacheExtractDir);

  // Find llama-server binary
  const serverBinary = findFile(cacheExtractDir, 'llama-server');
  if (!serverBinary) {
    throw new Error('llama-server not found in extracted archive');
  }

  // Copy binary
  console.log(`📋 Installing ${binaryName}...`);
  fs.copyFileSync(serverBinary, destPath);
  fs.chmodSync(destPath, 0o755);

  // Find and copy dylibs
  const binDir = path.dirname(serverBinary);
  const libDir = binDir.replace('/bin', '/lib');
  const searchDirs = [binDir, libDir, path.join(binDir, '..', 'lib')];

  // Combine all dylibs we need to process
  const ALL_DYLIBS = [...MACOS_DYLIBS, ...MACOS_GGML_DYLIBS];

  // Function to get the destination name (with llama- prefix for ggml libs to avoid whisper conflicts)
  const getDestName = (dylib) => {
    const baseName = path.basename(dylib, '.dylib');
    // Prefix ggml libs with 'llama-' to avoid conflicts with whisper's ggml libs
    if (baseName.startsWith('libggml')) {
      return `llama-${baseName}-${arch}.dylib`;
    }
    return `${baseName}-${arch}.dylib`;
  };

  console.log('   Copying dylibs...');
  for (const dylib of ALL_DYLIBS) {
    const destName = getDestName(dylib);
    const destDylib = path.join(BIN_DIR, destName);
    let found = false;

    for (const searchDir of searchDirs) {
      const srcDylib = path.join(searchDir, dylib);
      if (fs.existsSync(srcDylib)) {
        fs.copyFileSync(srcDylib, destDylib);
        fs.chmodSync(destDylib, 0o755);
        console.log(`   ✓ ${dylib} -> ${destName}`);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log(`   ⚠ ${dylib} not found (may not be required)`);
    }
  }

  // Fix rpaths in main binary
  console.log('🔧 Fixing library paths...');

  // Fix references in llama-server binary
  for (const dylib of ALL_DYLIBS) {
    const destName = getDestName(dylib);
    const baseName = path.basename(dylib, '.dylib');

    // Try various rpath formats that llama.cpp uses
    const rpathVariants = [
      `@rpath/${dylib}`,
      `@rpath/${baseName}.0.dylib`,  // versioned format
      `@rpath/../lib/${dylib}`,
    ];

    for (const rpath of rpathVariants) {
      try {
        execSync(`install_name_tool -change "${rpath}" @loader_path/${destName} "${destPath}"`, {
          stdio: 'pipe',
        });
      } catch (err) {
        // May not have this reference
      }
    }
  }

  // Fix inter-dylib dependencies
  for (const targetDylib of ALL_DYLIBS) {
    const targetDestName = getDestName(targetDylib);
    const targetPath = path.join(BIN_DIR, targetDestName);

    if (!fs.existsSync(targetPath)) continue;

    for (const refDylib of ALL_DYLIBS) {
      const refDestName = getDestName(refDylib);
      const refBaseName = path.basename(refDylib, '.dylib');

      // Try various rpath formats
      const rpathVariants = [
        `@rpath/${refDylib}`,
        `@rpath/${refBaseName}.0.dylib`,  // versioned format
        `@rpath/../lib/${refDylib}`,
      ];

      for (const rpath of rpathVariants) {
        try {
          execSync(`install_name_tool -change "${rpath}" @loader_path/${refDestName} "${targetPath}"`, {
            stdio: 'pipe',
          });
        } catch (err) {
          // May not reference this dylib
        }
      }
    }

    // Update the dylib's own install name
    try {
      execSync(`install_name_tool -id @loader_path/${targetDestName} "${targetPath}"`, { stdio: 'pipe' });
    } catch (err) {
      // May fail if already set
    }
  }

  // Codesign everything
  console.log('🔏 Codesigning binaries...');
  try {
    execSync(`codesign --force --sign - "${destPath}"`, { stdio: 'pipe' });
    for (const dylib of ALL_DYLIBS) {
      const destName = getDestName(dylib);
      const dylibPath = path.join(BIN_DIR, destName);
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
 * Download and extract llama.cpp for Windows
 */
async function downloadWindowsBinary() {
  const binaryName = BINARY_NAMES['win32-x64'];
  const destPath = path.join(BIN_DIR, binaryName);

  // Check if already exists
  if (isValidBinary(destPath)) {
    console.log(`✅ ${binaryName} already exists`);
    return destPath;
  }

  const url = BINARY_URLS['win32-x64'];
  const cacheZipPath = path.join(CACHE_DIR, `llama-cpp-${LLAMA_CPP_VERSION}-win32-x64.zip`);
  const cacheExtractDir = path.join(CACHE_DIR, 'llama-cpp-win32-x64');

  console.log(`📥 Downloading llama.cpp ${LLAMA_CPP_VERSION} for Windows x64...`);

  // Download if not cached
  if (!fs.existsSync(cacheZipPath) || fs.statSync(cacheZipPath).size < 100 * 1024) {
    console.log(`   URL: ${url}`);
    await downloadFile(url, cacheZipPath);
  } else {
    console.log('   Using cached archive');
  }

  // Extract
  console.log('📦 Extracting...');
  if (fs.existsSync(cacheExtractDir)) {
    fs.rmSync(cacheExtractDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheExtractDir, { recursive: true });
  await extractZip(cacheZipPath, cacheExtractDir);

  // Find llama-server.exe
  const serverBinary = findFile(cacheExtractDir, 'llama-server.exe');
  if (!serverBinary) {
    throw new Error('llama-server.exe not found in extracted archive');
  }

  // Copy binary
  console.log(`📋 Installing ${binaryName}...`);
  fs.copyFileSync(serverBinary, destPath);

  // Copy required DLLs
  const binaryDir = path.dirname(serverBinary);
  console.log('   Copying DLLs...');
  for (const dll of WINDOWS_DLLS) {
    const dllPath = path.join(binaryDir, dll);
    if (fs.existsSync(dllPath)) {
      const destDllPath = path.join(BIN_DIR, dll);
      fs.copyFileSync(dllPath, destDllPath);
      console.log(`   ✓ ${dll}`);
    } else {
      console.log(`   ⚠ ${dll} not found (may not be required)`);
    }
  }

  console.log(`✅ Installed ${binaryName}`);
  return destPath;
}

/**
 * Setup llama.cpp for all macOS architectures
 */
async function setupMacOS() {
  const arm64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-arm64']);
  const x64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-x64']);

  // Check if both already exist
  if (isValidBinary(arm64Path) && isValidBinary(x64Path)) {
    console.log('✅ llama.cpp: Both macOS binaries already exist');
    return;
  }

  // Download both architectures
  if (!isValidBinary(arm64Path)) {
    await downloadMacOSBinary('arm64');
  }

  if (!isValidBinary(x64Path)) {
    await downloadMacOSBinary('x64');
  }
}

/**
 * Download the Cogito 8B model
 */
async function downloadModel() {
  const destModelPath = path.join(MODELS_DIR, MODEL.name);
  const cacheModelPath = path.join(CACHE_DIR, MODEL.name);

  // Check if already exists in destination
  if (fs.existsSync(destModelPath)) {
    const stats = fs.statSync(destModelPath);
    // Model should be at least 6 GB
    if (stats.size > 6 * 1024 * 1024 * 1024) {
      console.log(`✅ ${MODEL.name} already exists (${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);
      return destModelPath;
    }
  }

  // Check cache
  if (fs.existsSync(cacheModelPath)) {
    const stats = fs.statSync(cacheModelPath);
    if (stats.size > 6 * 1024 * 1024 * 1024) {
      console.log(`✅ ${MODEL.name} found in cache`);
      console.log('   Copying to models directory...');
      fs.copyFileSync(cacheModelPath, destModelPath);
      return destModelPath;
    }
  }

  console.log(`📥 Downloading ${MODEL.name} (${MODEL.size})...`);
  console.log('   This is a large file and may take several minutes.');
  console.log(`   URL: ${MODEL.url}`);

  await downloadFile(MODEL.url, cacheModelPath);

  // Verify download
  const stats = fs.statSync(cacheModelPath);
  if (stats.size < 6 * 1024 * 1024 * 1024) {
    throw new Error(`Downloaded model is too small (${stats.size} bytes). Download may have failed.`);
  }

  // Copy to models directory
  console.log('   Copying to models directory...');
  fs.copyFileSync(cacheModelPath, destModelPath);

  console.log(`✅ Model installed: ${MODEL.name} (${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);
  return destModelPath;
}

/**
 * Check if all required binaries and model are present
 */
function isEverythingCached() {
  const platform = process.platform;

  // Check model
  const modelPath = path.join(MODELS_DIR, MODEL.name);
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 6 * 1024 * 1024 * 1024) {
    return false;
  }

  // Check binaries based on platform
  if (platform === 'darwin') {
    const arm64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-arm64']);
    const x64Path = path.join(BIN_DIR, BINARY_NAMES['darwin-x64']);
    return isValidBinary(arm64Path) && isValidBinary(x64Path);
  } else if (platform === 'win32') {
    return isValidBinary(path.join(BIN_DIR, BINARY_NAMES['win32-x64']));
  }

  return false;
}

/**
 * Main function
 */
async function main() {
  try {
    const platform = process.platform;

    // Quick check if everything is cached
    if (isEverythingCached()) {
      console.log('✅ llama.cpp: All binaries and model already cached');
      return;
    }

    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         llama.cpp + Cogito 8B Model Setup                 ║');
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
    console.log('📋 Step 1: Download llama.cpp binaries\n');

    if (platform === 'darwin') {
      await setupMacOS();
    } else if (platform === 'win32') {
      await downloadWindowsBinary();
    } else {
      console.log('⚠️  Linux not yet supported in this version');
    }

    // Download model
    console.log('\n📋 Step 2: Download Cogito 8B model\n');
    await downloadModel();

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║         llama.cpp Setup Complete! ✅                      ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // List what was installed
    console.log('📁 Binaries:');
    for (const [key, name] of Object.entries(BINARY_NAMES)) {
      const binPath = path.join(BIN_DIR, name);
      if (fs.existsSync(binPath)) {
        const stats = fs.statSync(binPath);
        console.log(`   ✓ ${name} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    }

    console.log('\n📁 Model:');
    const modelPath = path.join(MODELS_DIR, MODEL.name);
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      console.log(`   ✓ ${MODEL.name} (${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);
    }

    console.log('\n💾 Files cached in .build-cache/llama-cpp/ for reuse\n');
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

module.exports = { downloadLlamaCpp: main };
