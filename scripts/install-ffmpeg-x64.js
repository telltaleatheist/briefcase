/**
 * Install Intel Mac (x64) FFmpeg and FFprobe binaries
 *
 * This script installs the darwin-x64 versions of FFmpeg and FFprobe
 * which are needed when building for Intel Macs on an ARM Mac.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('Installing Intel Mac (x64) FFmpeg and FFprobe binaries...');

// Install platform-specific packages in both root and backend
const installLocations = [
  process.cwd(), // Root
  path.join(process.cwd(), 'backend') // Backend
];

for (const location of installLocations) {
  console.log(`\nInstalling in: ${location}`);

  try {
    // Install darwin-x64 versions
    // Use --force to bypass platform checks since we're cross-compiling
    execSync('npm install --no-save --force @ffmpeg-installer/darwin-x64@4.1.0', {
      cwd: location,
      stdio: 'inherit'
    });

    execSync('npm install --no-save --force @ffprobe-installer/darwin-x64@5.1.0', {
      cwd: location,
      stdio: 'inherit'
    });

    console.log(`✓ Installed darwin-x64 binaries in ${location}`);
  } catch (error) {
    console.error(`✗ Failed to install in ${location}:`, error.message);
    process.exit(1);
  }
}

console.log('\n✓ All Intel Mac binaries installed successfully!');
