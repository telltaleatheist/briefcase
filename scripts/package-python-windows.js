/**
 * Package Python with dependencies for Windows distribution
 *
 * This script creates a portable Python environment that can be bundled with the installer.
 * It uses Python embeddable package and installs all required dependencies.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const extract = require('extract-zip');

const PYTHON_VERSION = '3.11.9';
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const DIST_DIR = path.join(__dirname, '..', 'dist-python');
const PYTHON_DIR = path.join(DIST_DIR, 'python');

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
    console.log('=== Python Windows Packaging Script ===\n');

    // Create dist directory
    if (!fs.existsSync(DIST_DIR)) {
      fs.mkdirSync(DIST_DIR, { recursive: true });
    }

    if (!fs.existsSync(PYTHON_DIR)) {
      fs.mkdirSync(PYTHON_DIR, { recursive: true });
    }

    // Download Python embeddable package
    const pythonZipPath = path.join(DIST_DIR, `python-${PYTHON_VERSION}-embed-amd64.zip`);
    if (!fs.existsSync(pythonZipPath)) {
      await downloadFile(PYTHON_EMBED_URL, pythonZipPath);
    } else {
      console.log(`Python ZIP already exists: ${pythonZipPath}`);
    }

    // Extract Python
    console.log('\nExtracting Python...');
    await extractZip(pythonZipPath, PYTHON_DIR);

    // Modify python311._pth to enable pip and site-packages
    const pthFile = path.join(PYTHON_DIR, `python${PYTHON_VERSION.replace(/\./g, '').slice(0, 3)}._pth`);
    if (fs.existsSync(pthFile)) {
      console.log('\nConfiguring Python paths...');
      let pthContent = fs.readFileSync(pthFile, 'utf8');
      // Uncomment import site and add Lib/site-packages
      pthContent = pthContent.replace('#import site', 'import site');
      if (!pthContent.includes('Lib\\site-packages')) {
        pthContent += '\nLib\\site-packages\n';
      }
      fs.writeFileSync(pthFile, pthContent);
      console.log('Python paths configured');
    }

    // Download get-pip.py
    const getPipPath = path.join(PYTHON_DIR, 'get-pip.py');
    if (!fs.existsSync(getPipPath)) {
      await downloadFile(GET_PIP_URL, getPipPath);
    } else {
      console.log(`get-pip.py already exists: ${getPipPath}`);
    }

    // Install pip
    console.log('\nInstalling pip...');
    const pythonExe = path.join(PYTHON_DIR, 'python.exe');
    execSync(`"${pythonExe}" "${getPipPath}"`, {
      stdio: 'inherit',
      cwd: PYTHON_DIR
    });
    console.log('Pip installed');

    // Install required packages
    console.log('\nInstalling Python dependencies...');
    const requirementsPath = path.join(__dirname, '..', 'backend', 'python', 'requirements.txt');

    if (!fs.existsSync(requirementsPath)) {
      throw new Error(`Requirements file not found: ${requirementsPath}`);
    }

    execSync(`"${pythonExe}" -m pip install -r "${requirementsPath}" --no-warn-script-location`, {
      stdio: 'inherit',
      cwd: PYTHON_DIR,
      env: { ...process.env, PYTHONUSERBASE: PYTHON_DIR }
    });

    console.log('Python dependencies installed');

    // Download Whisper base model to bundle with installer
    console.log('\nDownloading Whisper base model...');
    console.log('This will be bundled to avoid first-run download');

    try {
      execSync(`"${pythonExe}" -c "import whisper; whisper.load_model('base')"`, {
        stdio: 'inherit',
        cwd: PYTHON_DIR,
        env: {
          ...process.env,
          PYTHONUSERBASE: PYTHON_DIR,
          // Set Whisper cache to a location we can bundle
          XDG_CACHE_HOME: path.join(PYTHON_DIR, 'cache')
        }
      });
      console.log('Whisper base model downloaded and will be bundled');
    } catch (error) {
      console.warn('Warning: Failed to download Whisper model. It will download on first use.');
      console.warn(error.message);
    }

    // Create a marker file to indicate successful packaging
    const markerPath = path.join(PYTHON_DIR, 'PACKAGED_VERSION.txt');
    fs.writeFileSync(markerPath, `Python ${PYTHON_VERSION}\nPackaged on: ${new Date().toISOString()}\nWhisper model: base (bundled)\n`);

    console.log('\n=== Python packaging complete! ===');
    console.log(`Python directory: ${PYTHON_DIR}`);
    console.log('This directory should be included in the electron-builder extraResources');

  } catch (error) {
    console.error('\n=== Packaging failed ===');
    console.error(error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  packagePython();
}

module.exports = { packagePython, PYTHON_DIR };
