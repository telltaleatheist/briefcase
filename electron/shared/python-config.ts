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
  const isPackaged = process.env.NODE_ENV === 'production' ||
                     (process as any).resourcesPath !== undefined ||
                     process.defaultApp === false;

  // If packaged, use bundled Python
  if (isPackaged) {
    // Get resources path
    const resourcesPath = (process as any).resourcesPath ||
                          path.join(process.cwd(), 'resources');

    // Path to packaged Python
    let packagedPythonPath: string;

    if (platform === 'win32') {
      packagedPythonPath = path.join(resourcesPath, 'python', 'python.exe');
    } else if (platform === 'darwin') {
      packagedPythonPath = path.join(resourcesPath, 'python', 'bin', 'python3');
    } else {
      packagedPythonPath = path.join(resourcesPath, 'python', 'bin', 'python3');
    }

    // Check if packaged Python exists
    if (fs.existsSync(packagedPythonPath)) {
      return {
        command: packagedPythonPath,
        isConda: false,
        fullPath: packagedPythonPath,
      };
    }
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

  // Windows: Use 'python' command (development only)
  if (platform === 'win32') {
    // CRITICAL: In production, we must have found bundled Python above
    // If we reach here in production, something is wrong
    if (isPackaged) {
      throw new Error(
        'CRITICAL: Packaged app missing bundled Python! ' +
        'Expected to find python.exe in resources/python/. ' +
        'Check electron-builder configuration and packaging script.'
      );
    }

    return {
      command: 'python',
      isConda: false,
    };
  }

  // Linux/other: Use 'python3' command (development only)
  if (isPackaged) {
    throw new Error(
      'CRITICAL: Packaged app missing bundled Python! ' +
      'Expected to find python3 in resources/python/bin/. ' +
      'Check electron-builder configuration and packaging script.'
    );
  }

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
