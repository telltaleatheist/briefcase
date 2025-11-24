/**
 * SIMPLIFIED Python configuration for ClipChimp
 * No more complex detection - just use bundled Python and set cache to writable location
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Get the user data path for storing writable data (cache, logs, etc.)
 */
function getUserDataPath(): string {
  try {
    const { app } = require('electron');
    return app.getPath('userData');
  } catch {
    // Fallback when Electron is not available (testing, etc.)
    const home = os.homedir();
    if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'ClipChimp');
    } else if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ClipChimp');
    } else {
      return path.join(home, '.config', 'ClipChimp');
    }
  }
}

/**
 * Get Python from runtime paths
 */
function getPythonPath(): string {
  try {
    const getRuntimePaths = require('../../../dist-electron/shared/runtime-paths').getRuntimePaths;
    return getRuntimePaths().python;
  } catch {
    // Fallback to system Python in development
    return process.platform === 'win32' ? 'python' : 'python3';
  }
}

/**
 * Configuration for Python environment
 */
export interface PythonConfig {
  /** The command/path to use for executing Python */
  command: string;
  /** Python version (e.g., "3.11.13") */
  version?: string;
  /** Whether this is a conda environment */
  isConda: boolean;
  /** Full path to the Python executable */
  fullPath?: string;
}

/**
 * Get the Python configuration
 * SIMPLIFIED: Just use bundled Python and set cache directory
 */
export function getPythonConfig(): PythonConfig {
  const pythonPath = getPythonPath();

  // Set cache directory for Whisper models to writable location
  const userDataPath = getUserDataPath();
  const cacheDir = path.join(userDataPath, 'cache');

  // Ensure cache directory exists
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Set environment variable for cache
  process.env.XDG_CACHE_HOME = cacheDir;

  console.log(`[Python Config] Using Python: ${pythonPath}`);
  console.log(`[Python Config] Cache directory: ${cacheDir}`);

  return {
    command: pythonPath,
    isConda: false,
    fullPath: pythonPath,
  };
}

/**
 * Get just the Python command string (for backward compatibility)
 */
export function getPythonCommand(): string {
  return getPythonConfig().command;
}

/**
 * Check if the configured Python has the required packages installed
 */
export async function checkPythonPackages(packages: string[]): Promise<Record<string, boolean>> {
  const { execSync } = require('child_process');
  const pythonCmd = getPythonCommand();
  const results: Record<string, boolean> = {};

  for (const pkg of packages) {
    try {
      execSync(`${pythonCmd} -c "import ${pkg}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      results[pkg] = true;
    } catch {
      results[pkg] = false;
    }
  }

  return results;
}

/**
 * Get Python version information
 */
export async function getPythonVersion(): Promise<string | null> {
  const { execSync } = require('child_process');
  const pythonCmd = getPythonCommand();

  try {
    const output = execSync(`${pythonCmd} --version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Validate that Python is properly configured and accessible
 */
export async function validatePythonConfig(): Promise<{
  valid: boolean;
  command: string;
  version: string | null;
  error?: string;
}> {
  const pythonCmd = getPythonCommand();
  const version = await getPythonVersion();

  if (!version) {
    return {
      valid: false,
      command: pythonCmd,
      version: null,
      error: `Python command '${pythonCmd}' not found or not executable`,
    };
  }

  return {
    valid: true,
    command: pythonCmd,
    version,
  };
}
