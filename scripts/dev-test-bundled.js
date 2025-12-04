/**
 * Development Test Script - Uses EXACT same binaries as production
 *
 * This script:
 * 1. Ensures all binaries are downloaded
 * 2. Builds the app
 * 3. Runs Electron with bundled binaries
 *
 * Usage: npm run dev:test-bundled
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   ClipChimp Dev Test (Using Bundled Binaries)            ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Step 1: Check binaries
console.log('📦 Step 1: Checking bundled binaries...');
const binaries = {
  'yt-dlp': path.join(PROJECT_ROOT, 'utilities', 'bin', 'yt-dlp.exe'),
  'ffmpeg': path.join(PROJECT_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
  'ffprobe': path.join(PROJECT_ROOT, 'node_modules', '@ffprobe-installer', 'win32-x64', 'ffprobe.exe'),
  'whisper': path.join(PROJECT_ROOT, 'utilities', 'bin', 'whisper-cli.exe'),
};

let allBinariesExist = true;
for (const [name, binPath] of Object.entries(binaries)) {
  if (fs.existsSync(binPath)) {
    console.log(`   ✅ ${name}: ${binPath}`);
  } else {
    console.log(`   ❌ ${name}: NOT FOUND at ${binPath}`);
    allBinariesExist = false;
  }
}

if (!allBinariesExist) {
  console.log('\n   Downloading missing binaries...');
  try {
    execSync('npm run download:binaries', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('❌ Failed to download binaries');
    process.exit(1);
  }
}

// Step 2: Build shared and backend
console.log('\n📦 Step 2: Building project...');
try {
  execSync('npm run build:shared && npm run build:backend && npm run build:frontend && npm run build:electron && npm run build:preload', {
    cwd: PROJECT_ROOT,
    stdio: 'inherit'
  });
} catch (error) {
  console.error('❌ Build failed');
  process.exit(1);
}

// Step 3: Print paths that will be used
console.log('\n📋 Binary paths that will be used:');
console.log(`   FFmpeg:  ${binaries['ffmpeg']}`);
console.log(`   FFprobe: ${binaries['ffprobe']}`);
console.log(`   yt-dlp:  ${binaries['yt-dlp']}`);
console.log(`   Whisper: ${binaries['whisper']}`);

// Step 4: Run Electron with environment variables pointing to bundled binaries
console.log('\n🚀 Step 3: Starting Electron with bundled binaries...\n');

const mainScript = path.join(PROJECT_ROOT, 'dist-electron', 'electron', 'main.js');

// Set environment variables to force using bundled binaries
// CRITICAL: Remove ELECTRON_RUN_AS_NODE if set (e.g., when running from within Claude Code or other Electron apps)
// When ELECTRON_RUN_AS_NODE=1, Electron runs as plain Node.js and require('electron') returns a path string instead of the module
const env = {
  ...process.env,
  CLIPCHIMP_PROJECT_ROOT: PROJECT_ROOT,
  FFMPEG_PATH: binaries['ffmpeg'],
  FFPROBE_PATH: binaries['ffprobe'],
  YT_DLP_PATH: binaries['yt-dlp'],
  WHISPER_PATH: binaries['whisper'],
  // Don't set NODE_ENV to production - we want dev tools
};

// Remove ELECTRON_RUN_AS_NODE to allow Electron to run as a proper Electron app
delete env.ELECTRON_RUN_AS_NODE;

// Get electron binary path directly from node_modules
const electronPath = require('electron');
console.log(`   Electron:  ${electronPath}`);

// Run electron using '.' (package.json main entry point) not the script directly
// This is how electron expects to be run and ensures proper context
const electron = spawn(electronPath, ['.'], {
  cwd: PROJECT_ROOT,
  env,
  stdio: 'inherit'
});

electron.on('close', (code) => {
  console.log(`\nElectron exited with code ${code}`);
  process.exit(code);
});

electron.on('error', (err) => {
  console.error('Failed to start Electron:', err);
  process.exit(1);
});
