/**
 * Package Python with dependencies for macOS distribution
 *
 * This script creates a portable Python environment that can be bundled with the installer.
 * Creates architecture-specific builds for Apple Silicon (arm64) and Intel (x64).
 *
 * Usage:
 *   node scripts/package-python-mac.js [arm64|x64]
 *
 * If no architecture is specified, it will build for the current system architecture.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PYTHON_VERSION = '3.11.9'; // Using 3.11.9 for compatibility with torch 2.1.2 and Windows embeddable package

// Determine target architecture from command line argument or system architecture
const TARGET_ARCH = process.argv[2] || process.arch;
const ARCH = TARGET_ARCH === 'arm64' ? 'arm64' : 'x64';

const DIST_DIR = path.join(__dirname, '..', 'dist-python');
const PYTHON_DIR = path.join(DIST_DIR, `python-${ARCH}`);

/**
 * Find the appropriate Python installation for the target architecture
 */
function findPythonForArch() {
  // Python 3.11 locations to try (prioritize 3.11 for torch 2.1.2 compatibility)
  const pythonPaths = [
    '/opt/homebrew/bin/python3.11',      // Homebrew on Apple Silicon
    '/usr/local/bin/python3.11',         // Homebrew on Intel
    '/opt/homebrew/bin/python3.12',      // Fallback to 3.12
    '/usr/local/bin/python3.12',         // Fallback to 3.12
    '/opt/homebrew/bin/python3',         // Fallback to python3
    '/usr/local/bin/python3',            // Fallback to python3
    'python3.11',                         // System PATH
    'python3.12',                         // System PATH
    'python3'                             // System PATH fallback
  ];

  for (const pythonPath of pythonPaths) {
    try {
      // Check if Python exists and is executable
      const versionOutput = execSync(`"${pythonPath}" --version 2>&1`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Check Python version (must be 3.11 or 3.12)
      if (versionOutput.includes('Python 3.12') || versionOutput.includes('Python 3.11')) {
        console.log(`Found suitable Python: ${pythonPath} (${versionOutput.trim()})`);
        return pythonPath;
      }
    } catch (err) {
      // Try next path
    }
  }

  throw new Error(
    'Python 3.12 or 3.11 not found. Please install:\n' +
    '  brew install python@3.12\n' +
    'Or:\n' +
    '  brew install python@3.11'
  );
}

/**
 * Create a relocatable Python venv
 */
async function createPythonVenv() {
  console.log(`\nCreating Python virtual environment for ${ARCH}...`);

  // Find appropriate Python installation
  const pythonCmd = findPythonForArch();

  // Create venv with explicit architecture (important for cross-compilation)
  const envVars = { ...process.env };

  // For cross-compilation (building x64 on arm64 or vice versa)
  if (ARCH === 'x64' && process.arch === 'arm64') {
    console.log('Note: Cross-compiling x64 on arm64 - Python packages will be x64');
    envVars.ARCHFLAGS = '-arch x86_64';
  } else if (ARCH === 'arm64' && process.arch === 'x64') {
    console.log('Note: Cross-compiling arm64 on x64 - Python packages will be arm64');
    envVars.ARCHFLAGS = '-arch arm64';
  }

  // Create venv
  execSync(`"${pythonCmd}" -m venv "${PYTHON_DIR}"`, {
    stdio: 'inherit',
    env: envVars
  });

  console.log('Virtual environment created successfully');
}

/**
 * Main packaging function
 */
async function packagePython() {
  try {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║     Python macOS Packaging Script (Professional)         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`Target Architecture: ${ARCH}`);
    console.log(`System Architecture: ${process.arch}`);
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

    // Create Python venv
    await createPythonVenv();

    // Get pip and python paths from venv
    const pipPath = path.join(PYTHON_DIR, 'bin', 'pip');
    const pythonPath = path.join(PYTHON_DIR, 'bin', 'python');

    // Upgrade pip
    console.log('\n📦 Upgrading pip to latest version...');
    execSync(`"${pipPath}" install --upgrade pip`, {
      stdio: 'inherit',
      cwd: PYTHON_DIR
    });

    // Install required packages
    console.log('\n📦 Installing Python dependencies from requirements.txt...');
    const requirementsPath = path.join(__dirname, '..', 'backend', 'python', 'requirements.txt');

    if (!fs.existsSync(requirementsPath)) {
      throw new Error(`Requirements file not found: ${requirementsPath}`);
    }

    console.log(`   Reading: ${requirementsPath}`);

    // Install with architecture-specific settings
    const installEnv = { ...process.env };
    if (ARCH === 'x64' && process.arch === 'arm64') {
      installEnv.ARCHFLAGS = '-arch x86_64';
    } else if (ARCH === 'arm64' && process.arch === 'x64') {
      installEnv.ARCHFLAGS = '-arch arm64';
    }

    execSync(`"${pipPath}" install -r "${requirementsPath}" --no-warn-script-location`, {
      stdio: 'inherit',
      cwd: PYTHON_DIR,
      env: installEnv
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

      execSync(`"${pythonPath}" -c "import whisper; model = whisper.load_model('base'); print(f'Model loaded: {model}')"`, {
        stdio: 'inherit',
        cwd: PYTHON_DIR,
        env: {
          ...process.env,
          // Set Whisper cache to a location we can bundle
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
Architecture: ${ARCH}
Packaged on: ${new Date().toISOString()}
System: macOS
Whisper model: base (bundled in cache/)
Dependencies: numpy 1.26.4, torch 2.1.2, openai-whisper

This is a bundled Python environment for Clippy.
Do not modify or move files manually.
`;
    fs.writeFileSync(markerPath, packageInfo);

    // Make Python binaries executable
    console.log('\n🔧 Setting executable permissions...');
    const binDir = path.join(PYTHON_DIR, 'bin');
    if (fs.existsSync(binDir)) {
      const binaries = fs.readdirSync(binDir);
      let count = 0;
      for (const binary of binaries) {
        const binaryPath = path.join(binDir, binary);
        try {
          const stats = fs.statSync(binaryPath);
          if (stats.isFile()) {
            fs.chmodSync(binaryPath, 0o755);
            count++;
          }
        } catch (err) {
          // Ignore errors for non-files
        }
      }
      console.log(`   Made ${count} binaries executable`);
    }

    // Calculate package size
    console.log('\n📊 Calculating package size...');
    const sizeOutput = execSync(`du -sh "${PYTHON_DIR}"`, { encoding: 'utf8' }).trim();
    const size = sizeOutput.split('\t')[0];

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║            Python Packaging Complete! ✅                  ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    console.log(`📁 Output Directory: ${PYTHON_DIR}`);
    console.log(`💾 Package Size: ${size}`);
    console.log(`🏗️  Architecture: ${ARCH}`);
    console.log(`🐍 Python: ${PYTHON_VERSION}`);
    console.log('\nThis directory will be included in electron-builder extraResources.');
    console.log('For Intel Mac builds, run: node scripts/package-python-mac.js x64\n');

  } catch (error) {
    console.error('\n╔═══════════════════════════════════════════════════════════╗');
    console.error('║                  Packaging Failed ❌                      ║');
    console.error('╚═══════════════════════════════════════════════════════════╝\n');
    console.error(`Error: ${error.message}\n`);
    console.error('Prerequisites:');
    console.error('  • Python 3.12 or 3.11 must be installed');
    console.error('  • Install with: brew install python@3.12');
    console.error('  • Or: brew install python@3.11\n');
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  packagePython();
}

module.exports = { packagePython, PYTHON_DIR };
