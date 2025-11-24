#!/usr/bin/env node
/**
 * Package backend with only production dependencies
 * This dramatically reduces the package size by excluding dev dependencies
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

const backendDir = path.join(__dirname, '..', 'backend');
const tempDir = path.join(__dirname, '..', 'backend-prod-temp');

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║   Creating Production Backend (No Dev Dependencies)      ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

try {
  // 1. Clean temp directory if it exists
  if (fs.existsSync(tempDir)) {
    console.log('🧹 Cleaning existing temp directory...');
    fs.removeSync(tempDir);
  }

  // 2. Create temp directory
  console.log('📁 Creating temp directory...');
  fs.ensureDirSync(tempDir);

  // 3. Copy only necessary files
  console.log('📋 Copying necessary files...');

  // Copy package.json and package-lock.json
  fs.copySync(path.join(backendDir, 'package.json'), path.join(tempDir, 'package.json'));
  if (fs.existsSync(path.join(backendDir, 'package-lock.json'))) {
    fs.copySync(path.join(backendDir, 'package-lock.json'), path.join(tempDir, 'package-lock.json'));
  }

  // Copy dist folder (compiled code)
  console.log('   ✓ Copying dist/...');
  fs.copySync(path.join(backendDir, 'dist'), path.join(tempDir, 'dist'));

  // Copy python folder if it exists
  if (fs.existsSync(path.join(backendDir, 'python'))) {
    console.log('   ✓ Copying python/...');
    fs.copySync(path.join(backendDir, 'python'), path.join(tempDir, 'python'));
  }

  // 4. Install ONLY production dependencies
  console.log('\n📦 Installing production dependencies only...');
  console.log('   (This may take a few minutes)\n');

  execSync('npm ci --omit=dev --omit=optional', {
    cwd: tempDir,
    stdio: 'inherit'
  });

  // 5. Rebuild native modules for Electron
  console.log('\n🔨 Rebuilding native modules for Electron...');
  console.log('   (This ensures better-sqlite3 works with Electron)\n');

  // Get Electron version from root package.json
  const rootPackageJson = require(path.join(__dirname, '..', 'package.json'));
  const electronVersion = rootPackageJson.devDependencies.electron.replace(/^[\^~]/, '');

  execSync(`npx @electron/rebuild --version ${electronVersion}`, {
    cwd: tempDir,
    stdio: 'inherit'
  });

  // 6. Get size comparison
  const getDirectorySize = (dirPath) => {
    const result = execSync(`du -sh "${dirPath}"`, { encoding: 'utf-8' });
    return result.split('\t')[0].trim();
  };

  const originalSize = getDirectorySize(path.join(backendDir, 'node_modules'));
  const prodSize = getDirectorySize(path.join(tempDir, 'node_modules'));

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║              Size Comparison                              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`📦 Original (with dev deps): ${originalSize}`);
  console.log(`📦 Production only:          ${prodSize}`);

  // 7. Replace backend node_modules with production-only version
  console.log('\n🔄 Replacing backend/node_modules with production version...');
  fs.removeSync(path.join(backendDir, 'node_modules'));
  fs.moveSync(path.join(tempDir, 'node_modules'), path.join(backendDir, 'node_modules'));

  // 8. Clean up temp directory
  console.log('🧹 Cleaning up temp directory...');
  fs.removeSync(tempDir);

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║          Production Backend Ready! ✅                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('\n⚠️  NOTE: To restore dev dependencies for development, run:');
  console.log('   cd backend && npm install\n');

} catch (error) {
  console.error('\n❌ Error:', error.message);

  // Clean up on error
  if (fs.existsSync(tempDir)) {
    fs.removeSync(tempDir);
  }

  process.exit(1);
}
