/**
 * Package Python with dependencies for Windows distribution
 *
 * This script creates a portable Python environment that can be bundled with the installer.
 * Uses Python embeddable package and installs all required dependencies.
 * Supports both x64 and ARM64 architectures.
 *
 * Usage:
 *   node scripts/package-python-windows.js [x64|arm64]
 *
 * If no architecture is specified, it will build for x64 (most common).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const extract = require('extract-zip');

const PYTHON_VERSION = '3.11.9'; // Using 3.11.9 for compatibility with torch 2.1.2 and Windows embeddable package

// Determine target architecture from command line argument or default to x64
const TARGET_ARCH = process.argv[2] || 'x64';
const ARCH = TARGET_ARCH === 'arm64' ? 'arm64' : 'amd64';

const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${ARCH}.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const DIST_DIR = path.join(__dirname, '..', 'dist-python');
const PYTHON_DIR = path.join(DIST_DIR, `python-${TARGET_ARCH}`);

/**
 * Download a file from URL
 */
async function downloadFile(url, destPath) {
  console.log(`Downloading ${url}...`);

  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        return downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log(`Downloaded to ${destPath}`);
        resolve();
      });

      file.on('error', (err) => {
        fs.unlinkSync(destPath);
        reject(err);
      });
    }).on('error', reject);
  });
}

/**
 * Extract ZIP file
 */
async function extractZip(zipPath, destDir) {
  console.log(`Extracting ${zipPath} to ${destDir}...`);
  await extract(zipPath, { dir: path.resolve(destDir) });
  console.log('Extraction complete');
}

/**
 * Main packaging function
 */
async function packagePython() {
  try {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║   Python Windows Packaging Script (Professional)         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`Target Architecture: ${TARGET_ARCH}`);
    console.log(`Python Embed Package: ${ARCH}`);
    console.log(`Python Version: ${PYTHON_VERSION}`);
    console.log(`Output Directory: ${PYTHON_DIR}\n`);

    // Create dist directory
    if (!fs.existsSync(DIST_DIR)) {
      fs.mkdirSync(DIST_DIR, { recursive: true });
    }

    // Remove existing Python directory if it exists
    if (fs.existsSync(PYTHON_DIR)) {
      console.log('⚠️  Removing existing Python directory...');
      fs.rmSync(PYTHON_DIR, { recursive: true, force: true });
    }

    fs.mkdirSync(PYTHON_DIR, { recursive: true });

    // Download Python embeddable package
    console.log('📥 Downloading Python embeddable package...');
    const pythonZipPath = path.join(DIST_DIR, `python-${PYTHON_VERSION}-embed-${ARCH}.zip`);
    if (!fs.existsSync(pythonZipPath)) {
      await downloadFile(PYTHON_EMBED_URL, pythonZipPath);
    } else {
      console.log(`   Python ZIP already downloaded: ${pythonZipPath}`);
    }

    // Extract Python
    console.log('\n📦 Extracting Python embeddable package...');
    await extractZip(pythonZipPath, PYTHON_DIR);
    console.log('   Extraction complete');

    // Modify python3XX._pth to enable pip and site-packages
    const pythonMajorMinor = PYTHON_VERSION.split('.').slice(0, 2).join('');
    const pthFile = path.join(PYTHON_DIR, `python${pythonMajorMinor}._pth`);
    if (fs.existsSync(pthFile)) {
      console.log('\n⚙️  Configuring Python paths...');
      let pthContent = fs.readFileSync(pthFile, 'utf8');
      // Uncomment import site and add Lib/site-packages
      pthContent = pthContent.replace('#import site', 'import site');
      if (!pthContent.includes('Lib\\site-packages')) {
        pthContent += '\nLib\\site-packages\n';
      }
      fs.writeFileSync(pthFile, pthContent);
      console.log('   Python paths configured to enable pip');
    } else {
      console.warn(`   Warning: Could not find ${pthFile}`);
    }

    // Download get-pip.py
    console.log('\n📥 Downloading get-pip.py...');
    const getPipPath = path.join(PYTHON_DIR, 'get-pip.py');
    if (!fs.existsSync(getPipPath)) {
      await downloadFile(GET_PIP_URL, getPipPath);
    } else {
      console.log(`   get-pip.py already downloaded`);
    }

    // Install pip
    console.log('\n📦 Installing pip...');
    const pythonExe = path.join(PYTHON_DIR, 'python.exe');
    execSync(`"${pythonExe}" "${getPipPath}"`, {
      stdio: 'inherit',
      cwd: PYTHON_DIR
    });
    console.log('✅ Pip installed successfully');

    // Install required packages
    console.log('\n📦 Installing Python dependencies from requirements.txt...');
    const requirementsPath = path.join(__dirname, '..', 'backend', 'python', 'requirements.txt');

    if (!fs.existsSync(requirementsPath)) {
      throw new Error(`Requirements file not found: ${requirementsPath}`);
    }

    console.log(`   Reading: ${requirementsPath}`);

    execSync(`"${pythonExe}" -m pip install -r "${requirementsPath}" --no-warn-script-location`, {
      stdio: 'inherit',
      cwd: PYTHON_DIR,
      env: { ...process.env, PYTHONUSERBASE: PYTHON_DIR }
    });

    console.log('✅ Python dependencies installed successfully');

    // Download Whisper base model to bundle with installer
    console.log('\n🎤 Downloading Whisper base model...');
    console.log('   This will be bundled to avoid first-run download');

    try {
      const cacheDir = path.join(PYTHON_DIR, 'cache', 'whisper');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      execSync(`"${pythonExe}" -c "import whisper; model = whisper.load_model('base'); print(f'Model loaded: {model}')"`, {
        stdio: 'inherit',
        cwd: PYTHON_DIR,
        env: {
          ...process.env,
          PYTHONUSERBASE: PYTHON_DIR,
          // Set Whisper cache to a location we can bundle (Windows uses LOCALAPPDATA or XDG_CACHE_HOME)
          XDG_CACHE_HOME: path.join(PYTHON_DIR, 'cache')
        }
      });
      console.log('✅ Whisper base model downloaded and cached');
    } catch (error) {
      console.warn('⚠️  Warning: Failed to download Whisper model. It will download on first use.');
      console.warn(`   Error: ${error.message}`);
    }

    // Create a marker file to indicate successful packaging
    const markerPath = path.join(PYTHON_DIR, 'PACKAGED_VERSION.txt');
    const packageInfo = `Python ${PYTHON_VERSION}
Architecture: ${TARGET_ARCH}
Packaged on: ${new Date().toISOString()}
System: Windows
Whisper model: base (bundled in cache/)
Dependencies: numpy 1.26.4, torch 2.1.2, openai-whisper

This is a bundled Python environment for Clippy.
Do not modify or move files manually.
`;
    fs.writeFileSync(markerPath, packageInfo);

    // Clean up get-pip.py (no longer needed)
    try {
      if (fs.existsSync(getPipPath)) {
        fs.unlinkSync(getPipPath);
      }
    } catch (err) {
      // Ignore cleanup errors
    }

    // Calculate package size
    console.log('\n📊 Calculating package size...');
    try {
      const getDirSize = (dirPath) => {
        let size = 0;
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const file of files) {
          const filePath = path.join(dirPath, file.name);
          if (file.isDirectory()) {
            size += getDirSize(filePath);
          } else {
            size += fs.statSync(filePath).size;
          }
        }
        return size;
      };

      const sizeBytes = getDirSize(PYTHON_DIR);
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║            Python Packaging Complete! ✅                  ║');
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
      console.log(`📁 Output Directory: ${PYTHON_DIR}`);
      console.log(`💾 Package Size: ${sizeMB} MB`);
      console.log(`🏗️  Architecture: ${TARGET_ARCH}`);
      console.log(`🐍 Python: ${PYTHON_VERSION}`);
      console.log('\nThis directory will be included in electron-builder extraResources.');
      console.log('For ARM64 builds, run: node scripts/package-python-windows.js arm64\n');
    } catch (err) {
      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║            Python Packaging Complete! ✅                  ║');
      console.log('╚═══════════════════════════════════════════════════════════╝\n');
      console.log(`📁 Output Directory: ${PYTHON_DIR}`);
      console.log(`🏗️  Architecture: ${TARGET_ARCH}`);
      console.log(`🐍 Python: ${PYTHON_VERSION}\n`);
    }

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║                  Packaging Failed ❌                      ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    console.error('Prerequisites:');
    console.error('  • Internet connection required to download Python');
    console.error('  • Sufficient disk space (~1-2 GB)\n');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  packagePython();
}

module.exports = { packagePython, PYTHON_DIR };
