/**
 * electron-builder afterPack hook
 * Rebuilds native modules (better-sqlite3) for the target architecture
 * This is necessary because we pre-bundle backend/node_modules as extraResources
 *
 * - macOS: Cross-compiles for both arm64 and x64 from arm64 build machine
 * - Windows: Rebuilds for target arch (x64 or arm64) on Windows build machine
 * - Linux: Rebuilds for target arch on Linux build machine
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Map electron-builder arch numbers to npm arch names
const ARCH_MAP = {
  0: 'ia32',    // Arch.ia32
  1: 'x64',     // Arch.x64
  2: 'armv7l',  // Arch.armv7l
  3: 'arm64',   // Arch.arm64
  4: 'universal' // Arch.universal
};

module.exports = async function afterPack(context) {
  const arch = ARCH_MAP[context.arch] || 'x64';
  const platform = context.electronPlatformName;

  // Skip for universal builds - they combine arm64 and x64
  if (arch === 'universal') {
    console.log(`[afterPack] Skipping universal build (handled separately)`);
    return;
  }

  // Skip if building for same architecture as build machine
  // electron-builder already handles this case
  if (arch === process.arch) {
    console.log(`[afterPack] Building for same arch (${arch}), electron-builder handles this`);
    return;
  }

  console.log(`\n[afterPack] ====================================`);
  console.log(`[afterPack] Cross-compiling native modules`);
  console.log(`[afterPack] Platform: ${platform}`);
  console.log(`[afterPack] Target arch: ${arch}`);
  console.log(`[afterPack] Build machine: ${process.platform}-${process.arch}`);
  console.log(`[afterPack] ====================================\n`);

  // Determine path to backend node_modules in the packaged app
  let backendNodeModules;

  if (platform === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    backendNodeModules = path.join(
      context.appOutDir,
      `${appName}.app`,
      'Contents',
      'Resources',
      'backend',
      'node_modules'
    );
  } else {
    // Windows and Linux use the same structure
    backendNodeModules = path.join(
      context.appOutDir,
      'resources',
      'backend',
      'node_modules'
    );
  }

  console.log(`[afterPack] Backend modules path: ${backendNodeModules}`);

  if (!fs.existsSync(backendNodeModules)) {
    console.log(`[afterPack] Backend node_modules not found, skipping rebuild`);
    return;
  }

  // Get electron version
  const rootPackageJson = require(path.join(__dirname, '..', 'package.json'));
  const electronVersion = (
    rootPackageJson.devDependencies?.electron ||
    rootPackageJson.dependencies?.electron ||
    '33.4.11'
  ).replace(/^[\^~]/, '');

  console.log(`[afterPack] Electron version: ${electronVersion}`);

  // Path to better-sqlite3
  const betterSqlitePath = path.join(backendNodeModules, 'better-sqlite3');
  if (!fs.existsSync(betterSqlitePath)) {
    console.log(`[afterPack] better-sqlite3 not found, skipping rebuild`);
    return;
  }

  try {
    console.log(`[afterPack] Rebuilding better-sqlite3 for ${platform}-${arch}...`);

    // Create a minimal package.json in backend/node_modules for electron-rebuild
    const tempPackageJson = path.join(backendNodeModules, 'package.json');
    const backendPackageJson = require(path.join(__dirname, '..', 'backend', 'package.json'));

    fs.writeFileSync(tempPackageJson, JSON.stringify({
      name: 'backend-modules',
      version: '1.0.0',
      dependencies: {
        'better-sqlite3': backendPackageJson.dependencies['better-sqlite3'] || '^12.4.1'
      }
    }, null, 2));

    // Set environment variables for the target architecture
    const env = {
      ...process.env,
      npm_config_arch: arch,
      npm_config_target_arch: arch,
    };

    // Use @electron/rebuild with the temp package.json
    const rebuildCmd = [
      'npx @electron/rebuild',
      `--version ${electronVersion}`,
      `--arch ${arch}`,
      `--module-dir "${backendNodeModules}"`,
      '--only better-sqlite3',
      '--force'
    ].join(' ');

    console.log(`[afterPack] Running: ${rebuildCmd}`);

    execSync(rebuildCmd, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env
    });

    // Clean up temp package.json
    fs.unlinkSync(tempPackageJson);

    console.log(`[afterPack] Successfully rebuilt better-sqlite3 for ${platform}-${arch}`);

    // Verify the rebuild worked
    const binaryPath = path.join(
      betterSqlitePath,
      'build',
      'Release',
      'better_sqlite3.node'
    );

    if (fs.existsSync(binaryPath)) {
      const stats = fs.statSync(binaryPath);
      console.log(`[afterPack] Binary verified: ${(stats.size / 1024).toFixed(1)} KB`);
    } else {
      console.warn(`[afterPack] Warning: Binary not found at expected path`);
    }

  } catch (error) {
    console.error(`[afterPack] Failed to rebuild native modules: ${error.message}`);
    throw new Error(`Failed to rebuild native modules for ${platform}-${arch}: ${error.message}`);
  }
};
