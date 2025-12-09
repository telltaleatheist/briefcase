/**
 * Download yt-dlp binaries for all platforms
 *
 * Downloads standalone yt-dlp executables - no Python required!
 *
 * Usage:
 *   node scripts/download-ytdlp.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'utilities', 'bin');

// URLs for yt-dlp binaries - USE THE .ZIP (ONEDIR) BUILDS FOR ALL PLATFORMS!
//
// The "onefile" builds (yt-dlp_macos, yt-dlp.exe, etc.) are PyInstaller binaries
// that extract themselves to a temp folder on EVERY run. This takes ~8 seconds!
//
// The "onedir" builds (.zip files) are pre-extracted and start INSTANTLY.
//
const DOWNLOAD_URLS = {
  macos: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux.zip',
  windows: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip'
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
        console.log('Download complete');
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
 * Check if a binary already exists and has a reasonable size (> 1MB)
 */
function binaryExists(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  return stats.size > 1024 * 1024; // > 1MB
}

/**
 * Main download function
 */
async function downloadYtDlp() {
  try {
    // Create bin directory if it doesn't exist
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }

    // All platforms use onedir builds (extracted to directories)
    // Structure after extraction: yt-dlp_<platform>_dir/<executable> + yt-dlp_<platform>_dir/_internal/
    const macosPath = path.join(BIN_DIR, 'yt-dlp_macos_dir', 'yt-dlp_macos');
    const linuxPath = path.join(BIN_DIR, 'yt-dlp_linux_dir', 'yt-dlp_linux');
    const windowsPath = path.join(BIN_DIR, 'yt-dlp_win_dir', 'yt-dlp.exe');

    // Check if all binaries already exist
    const macosExists = binaryExists(macosPath);
    const linuxExists = binaryExists(linuxPath);
    const windowsExists = binaryExists(windowsPath);

    if (macosExists && linuxExists && windowsExists) {
      console.log('✅ yt-dlp: All binaries already cached, skipping download');
      return;
    }

    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║        Downloading yt-dlp Binaries                        ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const results = { macos: macosExists, linux: linuxExists, windows: windowsExists };

    // macOS - download and extract the zip (onedir build for fast startup)
    if (!macosExists) {
      console.log('▶️  Downloading macOS version (onedir build)...');
      const zipPath = path.join(BIN_DIR, 'yt-dlp_macos.zip');
      const extractDir = path.join(BIN_DIR, 'yt-dlp_macos_dir');
      try {
        // Download the zip
        await downloadFile(DOWNLOAD_URLS.macos, zipPath);

        // Remove old extracted directory if it exists
        if (fs.existsSync(extractDir)) {
          fs.rmSync(extractDir, { recursive: true });
        }

        // Extract using unzip command (available on macOS)
        console.log('   Extracting zip...');
        execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });

        // The zip extracts directly: yt-dlp_macos (executable) + _internal/ (support files)
        const executablePath = path.join(extractDir, 'yt-dlp_macos');

        // Make the executable... executable
        if (fs.existsSync(executablePath)) {
          fs.chmodSync(executablePath, 0o755);
        }

        // Clean up the zip file
        fs.unlinkSync(zipPath);

        results.macos = true;
        console.log('   ✅ macOS: Done (extracted onedir build)');
      } catch (err) {
        console.error(`   ❌ Failed to download/extract macOS version: ${err.message}`);
        // Clean up partial downloads
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      }
    } else {
      console.log('✅ macOS: Already cached');
    }

    // Linux - download and extract the zip (onedir build for fast startup)
    if (!linuxExists) {
      console.log('\n▶️  Downloading Linux version (onedir build)...');
      const zipPath = path.join(BIN_DIR, 'yt-dlp_linux.zip');
      const extractDir = path.join(BIN_DIR, 'yt-dlp_linux_dir');
      try {
        await downloadFile(DOWNLOAD_URLS.linux, zipPath);

        if (fs.existsSync(extractDir)) {
          fs.rmSync(extractDir, { recursive: true });
        }

        console.log('   Extracting zip...');
        execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });

        // The zip extracts directly: yt-dlp_linux (executable) + _internal/ (support files)
        const executablePath = path.join(extractDir, 'yt-dlp_linux');
        if (fs.existsSync(executablePath)) {
          fs.chmodSync(executablePath, 0o755);
        }

        fs.unlinkSync(zipPath);
        results.linux = true;
        console.log('   ✅ Linux: Done (extracted onedir build)');
      } catch (err) {
        console.error(`   ❌ Failed to download/extract Linux version: ${err.message}`);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      }
    } else {
      console.log('✅ Linux: Already cached');
    }

    // Windows - download and extract the zip (onedir build for fast startup)
    if (!windowsExists) {
      console.log('\n▶️  Downloading Windows version (onedir build)...');
      const zipPath = path.join(BIN_DIR, 'yt-dlp_win.zip');
      const extractDir = path.join(BIN_DIR, 'yt-dlp_win_dir');
      try {
        await downloadFile(DOWNLOAD_URLS.windows, zipPath);

        if (fs.existsSync(extractDir)) {
          fs.rmSync(extractDir, { recursive: true });
        }

        console.log('   Extracting zip...');
        // Use PowerShell on Windows for extraction
        if (process.platform === 'win32') {
          execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });
        } else {
          // When building on non-Windows, use unzip
          execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });
        }

        fs.unlinkSync(zipPath);
        results.windows = true;
        console.log('   ✅ Windows: Done (extracted onedir build)');
      } catch (err) {
        console.error(`   ❌ Failed to download/extract Windows version: ${err.message}`);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      }
    } else {
      console.log('✅ Windows: Already cached');
    }

    // Check if at least one platform succeeded
    const anySuccess = results.macos || results.linux || results.windows;
    if (!anySuccess) {
      throw new Error('Failed to download yt-dlp for any platform');
    }

    // Show file sizes
    console.log('\n📊 File sizes:');
    if (results.macos && fs.existsSync(macosPath)) {
      const size = fs.statSync(macosPath).size;
      console.log(`   macOS:   ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
    if (results.linux && fs.existsSync(linuxPath)) {
      const size = fs.statSync(linuxPath).size;
      console.log(`   Linux:   ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
    if (results.windows && fs.existsSync(windowsPath)) {
      const size = fs.statSync(windowsPath).size;
      console.log(`   Windows: ${(size / 1024 / 1024).toFixed(2)} MB`);
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
