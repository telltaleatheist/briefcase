/**
 * Download/Setup Whisper binaries for all platforms with caching
 *
 * Whisper is installed via pip (openai-whisper package).
 * This script copies the whisper executable from the Python environment to the cache.
 * For packaging, you need whisper installed on your system first: pip install openai-whisper
 *
 * Usage:
 *   node scripts/download-whisper.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');
const CACHE_DIR = path.join(__dirname, '..', '.build-cache', 'whisper');

/**
 * Find whisper executable on the system
 */
function findWhisperExecutable() {
  const isWindows = process.platform === 'win32';

  // Try using 'where' on Windows or 'which' on Unix
  try {
    const cmd = isWindows ? 'where whisper' : 'which whisper';
    const whisperPath = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
    if (whisperPath && fs.existsSync(whisperPath)) {
      return whisperPath;
    }
  } catch (error) {
    // Command failed, try other methods
  }

  // Try common Python script locations
  const commonPaths = isWindows ? [
    // Windows paths
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'whisper.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'whisper.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'Scripts', 'whisper.exe'),
    'C:\\Python312\\Scripts\\whisper.exe',
    'C:\\Python311\\Scripts\\whisper.exe',
    'C:\\Python310\\Scripts\\whisper.exe',
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts', 'whisper.exe'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts', 'whisper.exe'),
  ] : [
    // Unix paths
    '/usr/local/bin/whisper',
    '/usr/bin/whisper',
    path.join(process.env.HOME || '', '.local', 'bin', 'whisper'),
  ];

  for (const testPath of commonPaths) {
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }

  return null;
}

/**
 * Copy file with progress
 */
function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
  console.log(`   ✅ Copied: ${path.basename(src)}`);
}

/**
 * Main setup function
 */
async function downloadWhisper() {
  try {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         Whisper Binary Setup                              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Create directories if they don't exist
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'whisper.exe' : 'whisper';
    const cachePath = path.join(CACHE_DIR, binaryName);
    const destPath = path.join(BIN_DIR, binaryName);

    // Check cache first
    console.log('🔍 Checking cache directory...');
    if (fs.existsSync(cachePath)) {
      console.log('✅ Whisper binary found in cache!\n');
      console.log('📋 Restoring from cache...\n');
      copyFile(cachePath, destPath);
      if (!isWindows) {
        fs.chmodSync(destPath, 0o755);
      }

      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║          Whisper Binary Restored! ✅                      ║');
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
      console.log(`📁 Binary restored to: utilities/bin/${binaryName}\n`);
      return;
    }

    // Try to find whisper on system
    console.log('🔍 Looking for whisper installation on system...\n');
    const whisperPath = findWhisperExecutable();

    if (!whisperPath) {
      console.error('╔═══════════════════════════════════════════════════════════╗');
      console.error('║              Whisper Not Found ❌                         ║');
      console.error('╚═══════════════════════════════════════════════════════════╝\n');
      console.error('Whisper is not installed on your system.\n');
      console.error('Please install it first:\n');
      console.error('  pip install openai-whisper\n');
      console.error('Then run this script again.\n');
      process.exit(1);
    }

    console.log(`✅ Found whisper at: ${whisperPath}\n`);
    console.log('📋 Copying to cache and bin directories...\n');

    // Copy to cache
    copyFile(whisperPath, cachePath);
    if (!isWindows) {
      fs.chmodSync(cachePath, 0o755);
    }

    // Copy to bin
    copyFile(whisperPath, destPath);
    if (!isWindows) {
      fs.chmodSync(destPath, 0o755);
    }

    const stats = fs.statSync(destPath);
    const size = `${(stats.size / 1024).toFixed(2)} KB`;

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║          Whisper Setup Complete! ✅                       ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`📁 Binary saved to: utilities/bin/${binaryName} (${size})`);
    console.log('💾 Cached in: .build-cache/whisper/\n');
    console.log('ℹ️  This binary will be reused for all future builds!\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║              Setup Failed ❌                              ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  downloadWhisper();
}

module.exports = { downloadWhisper };
