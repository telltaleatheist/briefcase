/**
 * Centralized Python configuration for Clippy
 *
 * This module ensures that all parts of the application use the SAME Python
 * interpreter, preventing version mismatch issues between setup, checks, and runtime.
 *
 * IMPORTANT: Any changes to Python path detection MUST be made here and nowhere else.
 */

import * as fs from 'fs';
import * as path from 'path';

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
 * Get the Python command/path that should be used across the entire application
 *
 * Priority order:
 * 1. Packaged Python (if running in production/packaged app)
 * 2. Conda environment (if available on macOS)
 * 3. System Python (python3 on Unix, python on Windows)
 *
 * This function MUST return the same result whether called from:
 * - Electron main process (whisper-setup-wizard.ts)
 * - NestJS backend (python-bridge.service.ts)
 * - Any other part of the application
 */
export function getPythonConfig(): PythonConfig {
  const platform = process.platform;

  // Check if we're running in a packaged app
  // In production: Check if RESOURCES_PATH env var is set OR resourcesPath property exists
  const isPackaged = process.env.NODE_ENV === 'production' &&
                     (process.env.RESOURCES_PATH !== undefined ||
                      (process as any).resourcesPath !== undefined ||
                      (process as any).defaultApp === false);

  // Check for bundled Python in both production AND development (if USE_BUNDLED_PYTHON is set)
  const useBundledPython = isPackaged || process.env.USE_BUNDLED_PYTHON === 'true';

  // If packaged or explicitly using bundled Python, try to use bundled Python first
  if (useBundledPython) {
    let resourcesPath: string;

    if (isPackaged) {
      // Production: Use resources path from packaged app
      resourcesPath = process.env.RESOURCES_PATH ||
                      (process as any).resourcesPath ||
                      path.join(process.cwd(), 'resources');
    } else {
      // Development: Use dist-python directory
      resourcesPath = path.join(process.cwd(), 'dist-python', `python-${process.arch}`);
    }

    // Path to packaged Python (architecture-independent - always in 'python' folder in prod, direct path in dev)
    let packagedPythonPath: string;

    if (isPackaged) {
      // Production: Python is in resources/python/
      if (platform === 'win32') {
        packagedPythonPath = path.join(resourcesPath, 'python', 'python.exe');
      } else if (platform === 'darwin' || platform === 'linux') {
        packagedPythonPath = path.join(resourcesPath, 'python', 'bin', 'python3');
      } else {
        packagedPythonPath = path.join(resourcesPath, 'python', 'bin', 'python3');
      }
    } else {
      // Development: Python is in dist-python/python-{arch}/
      if (platform === 'win32') {
        packagedPythonPath = path.join(resourcesPath, 'python.exe');
      } else if (platform === 'darwin' || platform === 'linux') {
        packagedPythonPath = path.join(resourcesPath, 'bin', 'python3');
      } else {
        packagedPythonPath = path.join(resourcesPath, 'bin', 'python3');
      }
    }

    console.log(`[Python Config] Checking for bundled Python at: ${packagedPythonPath}`);

    // Check if packaged Python exists
    if (fs.existsSync(packagedPythonPath)) {
      console.log(`[Python Config] Found bundled Python: ${packagedPythonPath}`);

      // Set up environment for bundled Python
      if (platform === 'darwin' || platform === 'linux') {
        // Ensure Python can find its libraries
        const pythonHome = isPackaged
          ? path.join(resourcesPath, 'python')
          : resourcesPath; // In dev, resourcesPath IS the python dir

        process.env.PYTHONHOME = pythonHome;
        process.env.PYTHONPATH = path.join(pythonHome, 'lib', 'python3.11', 'site-packages');

        // Set cache directory for Whisper
        const cacheDir = path.join(pythonHome, 'cache');
        if (fs.existsSync(cacheDir)) {
          process.env.XDG_CACHE_HOME = cacheDir;
        }
      } else if (platform === 'win32') {
        // Windows: Set Python user base
        const pythonHome = isPackaged
          ? path.join(resourcesPath, 'python')
          : resourcesPath; // In dev, resourcesPath IS the python dir

        process.env.PYTHONHOME = pythonHome;

        // Set cache directory for Whisper
        const cacheDir = path.join(pythonHome, 'cache');
        if (fs.existsSync(cacheDir)) {
          process.env.XDG_CACHE_HOME = cacheDir;
        }
      }

      return {
        command: packagedPythonPath,
        isConda: false,
        fullPath: packagedPythonPath,
      };
    }

    // Python should be bundled for all platforms in production
    // If missing, log a warning but fall back to system Python
    console.warn(
      `[Python Config] WARNING: Packaged Python not found at: ${packagedPythonPath}. ` +
      'Falling back to system Python. This may cause issues if dependencies are missing.'
    );

    // For Mac/Linux, fall back to system Python if bundled Python not found
    // This provides a graceful degradation during development/testing
  }

  // Development mode: use system Python
  // macOS: Try conda environment first
  if (platform === 'darwin') {
    const condaEnvPath = '/opt/homebrew/Caskroom/miniconda/base/envs/metadata-generator/bin/python';

    if (fs.existsSync(condaEnvPath)) {
      return {
        command: condaEnvPath,
        isConda: true,
        fullPath: condaEnvPath,
      };
    }

    // Fall back to system python3
    return {
      command: 'python3',
      isConda: false,
    };
  }

  // Windows: Use 'python' command
  if (platform === 'win32') {
    return {
      command: 'python',
      isConda: false,
    };
  }

  // Linux/other: Use 'python3' command
  return {
    command: 'python3',
    isConda: false,
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
 *
 * @param packages - Array of package names to check (e.g., ['whisper', 'requests'])
 * @returns Object with package names as keys and boolean availability as values
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
 *
 * @returns Object with validation results
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
