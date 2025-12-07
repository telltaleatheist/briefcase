#!/usr/bin/env node
/**
 * Package backend with only production dependencies
 * This dramatically reduces the package size by excluding dev dependencies
 *
 * Features caching to speed up subsequent builds:
 * - Caches production node_modules based on package-lock.json hash
 * - Caches rebuilt native modules per architecture
 */

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const backendDir = path.join(__dirname, '..', 'backend');
const cacheDir = path.join(__dirname, '..', '.build-cache');
const tempDir = path.join(__dirname, '..', 'backend-prod-temp');

// Get current architecture
const arch = process.arch; // 'arm64' or 'x64'

/**
 * Calculate hash of package-lock.json to detect dependency changes
 */
function getPackageLockHash() {
  const lockFile = path.join(backendDir, 'package-lock.json');
  if (!fs.existsSync(lockFile)) {
    return null;
  }
  const content = fs.readFileSync(lockFile);
  return crypto.createHash('md5').update(content).digest('hex').substring(0, 12);
}

/**
 * Get Electron version from root package.json
 */
function getElectronVersion() {
  const rootPackageJson = require(path.join(__dirname, '..', 'package.json'));
  return (rootPackageJson.dependencies?.electron || rootPackageJson.devDependencies?.electron || '33.4.11').replace(/^[\^~]/, '');
}

/**
 * Get cache key based on dependencies and architecture
 */
function getCacheKey() {
  const lockHash = getPackageLockHash();
  const electronVersion = getElectronVersion();
  return `backend-prod-${lockHash}-electron${electronVersion}-${arch}`;
}

/**
 * Check if we have a valid cache
 */
function getCachedNodeModules() {
  const cacheKey = getCacheKey();
  const cachePath = path.join(cacheDir, cacheKey);

  if (fs.existsSync(cachePath)) {
    // Verify it has node_modules
    const nodeModulesPath = path.join(cachePath, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      return cachePath;
    }
  }
  return null;
}

/**
 * Save node_modules to cache
 */
function saveToCache(nodeModulesPath) {
  const cacheKey = getCacheKey();
  const cachePath = path.join(cacheDir, cacheKey);

  // Clean old caches (keep only 3 most recent)
  cleanOldCaches();

  console.log(`📦 Saving to cache: ${cacheKey}`);
  fs.ensureDirSync(cachePath);
  fs.copySync(nodeModulesPath, path.join(cachePath, 'node_modules'));

  // Write timestamp
  fs.writeFileSync(path.join(cachePath, '.timestamp'), Date.now().toString());
}

/**
 * Clean old cache entries, keeping only the 3 most recent
 */
function cleanOldCaches() {
  if (!fs.existsSync(cacheDir)) return;

  const entries = fs.readdirSync(cacheDir)
    .filter(name => name.startsWith('backend-prod-'))
    .map(name => {
      const fullPath = path.join(cacheDir, name);
      const timestampFile = path.join(fullPath, '.timestamp');
      let timestamp = 0;
      if (fs.existsSync(timestampFile)) {
        timestamp = parseInt(fs.readFileSync(timestampFile, 'utf8')) || 0;
      }
      return { name, path: fullPath, timestamp };
    })
    .sort((a, b) => b.timestamp - a.timestamp);

  // Remove all but the 3 most recent
  for (let i = 3; i < entries.length; i++) {
    console.log(`🧹 Removing old cache: ${entries[i].name}`);
    fs.removeSync(entries[i].path);
  }
}

/**
 * Get directory size for display
 */
function getDirectorySize(dirPath) {
  const getAllFiles = (dir) => {
    let totalSize = 0;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          totalSize += getAllFiles(filePath);
        } else {
          totalSize += stat.size;
        }
      } catch (e) {
        // Skip files we can't access
      }
    }
    return totalSize;
  };

  const bytes = getAllFiles(dirPath);
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
  } else if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  } else if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + 'K';
  }
  return bytes + 'B';
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   Creating Production Backend (No Dev Dependencies)      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log(`🖥️  Architecture: ${arch}`);
  console.log(`📦 Electron: ${getElectronVersion()}`);

  // Check for cached version
  const cachedPath = getCachedNodeModules();

  if (cachedPath) {
    console.log('\n✅ Found cached production dependencies!');
    console.log(`   Cache: ${path.basename(cachedPath)}\n`);

    // Use cached version
    const cachedNodeModules = path.join(cachedPath, 'node_modules');
    const targetNodeModules = path.join(backendDir, 'node_modules');

    console.log('🔄 Restoring from cache...');
    if (fs.existsSync(targetNodeModules)) {
      fs.removeSync(targetNodeModules);
    }
    fs.copySync(cachedNodeModules, targetNodeModules);

    const prodSize = getDirectorySize(targetNodeModules);
    console.log(`📦 Production size: ${prodSize}`);

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║    Production Backend Ready (from cache)! ✅             ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    return;
  }

  console.log('\n📥 No cache found, building fresh...\n');

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

    // 4. Install ONLY production dependencies
    console.log('\n📦 Installing production dependencies only...');
    console.log('   (This may take a minute)\n');

    execSync('npm ci --omit=dev --omit=optional', {
      cwd: tempDir,
      stdio: 'inherit'
    });

    // 5. Rebuild native modules for Electron
    console.log('\n🔨 Rebuilding native modules for Electron...');
    console.log('   (This ensures better-sqlite3 works with Electron)\n');

    const electronVersion = getElectronVersion();
    execSync(`npx @electron/rebuild --version ${electronVersion}`, {
      cwd: tempDir,
      stdio: 'inherit'
    });

    // 6. Get size comparison
    const originalSize = getDirectorySize(path.join(backendDir, 'node_modules'));
    const prodSize = getDirectorySize(path.join(tempDir, 'node_modules'));

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║              Size Comparison                              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(`📦 Original (with dev deps): ${originalSize}`);
    console.log(`📦 Production only:          ${prodSize}`);

    // 7. Save to cache before moving
    saveToCache(path.join(tempDir, 'node_modules'));

    // 8. Replace backend node_modules with production-only version
    console.log('\n🔄 Replacing backend/node_modules with production version...');
    fs.removeSync(path.join(backendDir, 'node_modules'));
    fs.moveSync(path.join(tempDir, 'node_modules'), path.join(backendDir, 'node_modules'));

    // 9. Clean up temp directory
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
}

main();
