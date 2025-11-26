/**
 * Download fast Python-based yt-dlp binaries for all platforms
 *
 * This script downloads the Python script versions of yt-dlp instead of
 * the slow PyInstaller-compiled binaries that have 8+ second startup overhead.
 *
 * Usage:
 *   node scripts/download-ytdlp.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const YTDLP_VERSION = 'latest'; // or specify a version like '2025.10.07'
const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');

// URLs for Python script versions (NOT the compiled binaries)
const DOWNLOAD_URLS = {
  // For macOS and Linux, we download the Python script
  macos: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',

  // For Windows, we MUST use the .exe as Windows doesn't have Python by default
  windows: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
};

/**
 * Download a file from URL with redirect support
 */
function downloadFile(url, dest, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    console.log(`Downloading from: ${url}`);
    console.log(`Saving to: ${dest}`);

    // Try to remove existing file first to avoid EPERM errors
    let backupPath = null;
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
        console.log('   Removed existing file');
      } catch (err) {
        console.warn(`   Warning: Could not remove existing file: ${err.message}`);
        // Try renaming instead
        try {
          backupPath = `${dest}.backup.${Date.now()}`;
          fs.renameSync(dest, backupPath);
          console.log(`   Renamed existing file to backup`);
        } catch (renameErr) {
          reject(new Error(`Cannot write to ${dest}: file is locked or permission denied`));
          return;
        }
      }
    }

    // Helper to clean up backup after successful download
    const cleanupBackup = () => {
      if (backupPath && fs.existsSync(backupPath)) {
        try {
          fs.unlinkSync(backupPath);
          console.log('   Cleaned up backup file');
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    };

    const file = fs.createWriteStream(dest);

    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 302 || response.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        console.log(`Following redirect to: ${response.headers.location}`);
        downloadFile(response.headers.location, dest, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed with status: ${response.statusCode}`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        cleanupBackup();
        console.log('✅ Download complete');
        resolve();
      });

      file.on('error', (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      reject(err);
    });
  });
}

/**
 * Main download function
 */
async function downloadYtDlp() {
  try {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║        Downloading Fast yt-dlp Binaries                   ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Create bin directory if it doesn't exist
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    // Download for each platform
    console.log('\n📥 Downloading yt-dlp binaries...\n');

    const results = { macos: false, linux: false, windows: false };

    // macOS
    console.log('▶️  Downloading macOS version (Python script)...');
    try {
      await downloadFile(
        DOWNLOAD_URLS.macos,
        path.join(BIN_DIR, 'yt-dlp_macos')
      );
      fs.chmodSync(path.join(BIN_DIR, 'yt-dlp_macos'), 0o755);
      results.macos = true;
    } catch (err) {
      console.error(`   ❌ Failed to download macOS version: ${err.message}`);
    }

    // Linux
    console.log('\n▶️  Downloading Linux version (Python script)...');
    try {
      await downloadFile(
        DOWNLOAD_URLS.linux,
        path.join(BIN_DIR, 'yt-dlp_linux')
      );
      fs.chmodSync(path.join(BIN_DIR, 'yt-dlp_linux'), 0o755);
      results.linux = true;
    } catch (err) {
      console.error(`   ❌ Failed to download Linux version: ${err.message}`);
    }

    // Windows
    console.log('\n▶️  Downloading Windows version (.exe)...');
    try {
      await downloadFile(
        DOWNLOAD_URLS.windows,
        path.join(BIN_DIR, 'yt-dlp.exe')
      );
      results.windows = true;
    } catch (err) {
      console.error(`   ❌ Failed to download Windows version: ${err.message}`);
    }

    // Check if at least one platform succeeded
    const anySuccess = results.macos || results.linux || results.windows;
    if (!anySuccess) {
      throw new Error('Failed to download yt-dlp for any platform');
    }

    // Verify downloads
    console.log('\n✅ Verifying downloads...');
    const macosPath = path.join(BIN_DIR, 'yt-dlp_macos');
    const linuxPath = path.join(BIN_DIR, 'yt-dlp_linux');
    const windowsPath = path.join(BIN_DIR, 'yt-dlp.exe');

    // Check macOS is a Python script (only if downloaded)
    if (results.macos && fs.existsSync(macosPath)) {
      const macosContent = fs.readFileSync(macosPath, 'utf8', { length: 100 });
      if (!macosContent.startsWith('#!/usr/bin/env python')) {
        console.warn('⚠️  WARNING: macOS binary is not a Python script! May have slow startup.');
      } else {
        console.log('   ✅ macOS: Python script (fast startup)');
      }
    }

    // Check Linux is a Python script (only if downloaded)
    if (results.linux && fs.existsSync(linuxPath)) {
      const linuxContent = fs.readFileSync(linuxPath, 'utf8', { length: 100 });
      if (!linuxContent.startsWith('#!/usr/bin/env python')) {
        console.warn('⚠️  WARNING: Linux binary is not a Python script! May have slow startup.');
      } else {
        console.log('   ✅ Linux: Python script (fast startup)');
      }
    }

    // Check Windows is an .exe (only if downloaded)
    if (results.windows && fs.existsSync(windowsPath)) {
      const windowsStats = fs.statSync(windowsPath);
      if (windowsStats.size < 1000000) {
        console.warn('⚠️  WARNING: Windows binary seems too small!');
      } else {
        console.log('   ✅ Windows: Executable (.exe)');
      }
    }

    // Show file sizes
    console.log('\n📊 File sizes:');
    if (results.macos && fs.existsSync(macosPath)) {
      console.log(`   macOS:   ${(fs.statSync(macosPath).size / 1024).toFixed(2)} KB`);
    }
    if (results.linux && fs.existsSync(linuxPath)) {
      console.log(`   Linux:   ${(fs.statSync(linuxPath).size / 1024).toFixed(2)} KB`);
    }
    if (results.windows && fs.existsSync(windowsPath)) {
      console.log(`   Windows: ${(fs.statSync(windowsPath).size / 1024 / 1024).toFixed(2)} MB`);
    }

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║              yt-dlp Download Complete! ✅                 ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log('📁 Binaries saved to: utilities/bin/\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║                  Download Failed ❌                       ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  downloadYtDlp();
}

module.exports = { downloadYtDlp };
