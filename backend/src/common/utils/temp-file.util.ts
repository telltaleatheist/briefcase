/**
 * Temp file utilities for safe file processing
 * Handles Windows file locking issues by using temp directory
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from '@nestjs/common';

const logger = new Logger('TempFileUtil');

/**
 * Get the temp directory for ClipChimp processing
 */
export function getTempDir(): string {
  const tempBase = os.tmpdir();
  const clipchimpTemp = path.join(tempBase, 'clipchimp-processing');

  if (!fs.existsSync(clipchimpTemp)) {
    fs.mkdirSync(clipchimpTemp, { recursive: true });
  }

  return clipchimpTemp;
}

/**
 * Check if a file is accessible (not locked by another process)
 */
export async function isFileAccessible(filePath: string): Promise<{ accessible: boolean; error?: string }> {
  try {
    // Try to open the file for reading
    const fd = fs.openSync(filePath, 'r');
    fs.closeSync(fd);
    return { accessible: true };
  } catch (err: any) {
    if (err.code === 'EBUSY') {
      return { accessible: false, error: 'File is busy (locked by another process, possibly Syncthing)' };
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { accessible: false, error: 'Permission denied (file may be locked by another process)' };
    }
    if (err.code === 'ENOENT') {
      return { accessible: false, error: 'File does not exist' };
    }
    return { accessible: false, error: err.message };
  }
}

/**
 * Copy a file to temp directory for safe processing
 * Returns the path to the temp file
 */
export async function copyToTemp(
  sourcePath: string,
  options?: {
    maxRetries?: number;
    retryDelayMs?: number;
    onProgress?: (message: string) => void;
  }
): Promise<{ success: boolean; tempPath?: string; error?: string }> {
  const maxRetries = options?.maxRetries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 1000;

  const tempDir = getTempDir();
  const fileName = path.basename(sourcePath);
  const tempPath = path.join(tempDir, `${Date.now()}-${fileName}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      options?.onProgress?.(`Copying to temp (attempt ${attempt}/${maxRetries})...`);

      // Check if file is accessible first
      const accessCheck = await isFileAccessible(sourcePath);
      if (!accessCheck.accessible) {
        if (attempt < maxRetries) {
          logger.warn(`File not accessible (attempt ${attempt}): ${accessCheck.error}. Retrying in ${retryDelayMs}ms...`);
          await sleep(retryDelayMs * attempt); // Exponential backoff
          continue;
        }
        return { success: false, error: accessCheck.error };
      }

      // Copy file to temp
      fs.copyFileSync(sourcePath, tempPath);
      logger.log(`Copied to temp: ${sourcePath} -> ${tempPath}`);
      return { success: true, tempPath };

    } catch (err: any) {
      if (attempt < maxRetries) {
        logger.warn(`Copy failed (attempt ${attempt}): ${err.message}. Retrying in ${retryDelayMs}ms...`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return { success: false, error: `Failed to copy after ${maxRetries} attempts: ${err.message}` };
    }
  }

  return { success: false, error: 'Unexpected error in copyToTemp' };
}

/**
 * Copy a processed temp file back to the original location
 * Uses retry logic to handle file locks
 */
export async function copyFromTemp(
  tempPath: string,
  destPath: string,
  options?: {
    maxRetries?: number;
    retryDelayMs?: number;
    preserveTimestamps?: boolean;
    deleteTemp?: boolean;
    onProgress?: (message: string) => void;
  }
): Promise<{ success: boolean; error?: string }> {
  const maxRetries = options?.maxRetries ?? 5;
  const retryDelayMs = options?.retryDelayMs ?? 1000;
  const deleteTemp = options?.deleteTemp ?? true;

  // Get original timestamps if needed
  let originalStats: fs.Stats | null = null;
  if (options?.preserveTimestamps && fs.existsSync(destPath)) {
    try {
      originalStats = fs.statSync(destPath);
    } catch {
      // Ignore, will use new timestamps
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      options?.onProgress?.(`Saving file (attempt ${attempt}/${maxRetries})...`);

      // Create backup of original
      const backupPath = `${destPath}.backup`;
      if (fs.existsSync(destPath)) {
        try {
          fs.renameSync(destPath, backupPath);
        } catch (renameErr: any) {
          if (renameErr.code === 'EBUSY' || renameErr.code === 'EACCES') {
            if (attempt < maxRetries) {
              logger.warn(`Cannot backup original (attempt ${attempt}): file locked. Retrying in ${retryDelayMs * attempt}ms...`);
              await sleep(retryDelayMs * attempt);
              continue;
            }
            return { success: false, error: 'Original file is locked by another process. Please pause Syncthing and try again.' };
          }
          throw renameErr;
        }
      }

      // Copy temp to destination
      try {
        fs.copyFileSync(tempPath, destPath);
      } catch (copyErr: any) {
        // Restore backup if copy failed
        if (fs.existsSync(backupPath)) {
          try {
            fs.renameSync(backupPath, destPath);
          } catch {
            logger.error('Failed to restore backup!');
          }
        }
        throw copyErr;
      }

      // Restore timestamps if requested
      if (originalStats) {
        try {
          fs.utimesSync(destPath, originalStats.atime, originalStats.mtime);
        } catch {
          // Ignore timestamp errors
        }
      }

      // Delete backup
      if (fs.existsSync(backupPath)) {
        try {
          fs.unlinkSync(backupPath);
        } catch {
          logger.warn(`Could not delete backup: ${backupPath}`);
        }
      }

      // Delete temp file
      if (deleteTemp) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          logger.warn(`Could not delete temp file: ${tempPath}`);
        }
      }

      logger.log(`Successfully saved: ${destPath}`);
      return { success: true };

    } catch (err: any) {
      if (attempt < maxRetries) {
        logger.warn(`Save failed (attempt ${attempt}): ${err.message}. Retrying in ${retryDelayMs * attempt}ms...`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return { success: false, error: `Failed to save after ${maxRetries} attempts: ${err.message}` };
    }
  }

  return { success: false, error: 'Unexpected error in copyFromTemp' };
}

/**
 * Clean up temp files for a given source file
 */
export function cleanupTempFiles(sourceFileName: string): void {
  const tempDir = getTempDir();

  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file.includes(sourceFileName)) {
        const filePath = path.join(tempDir, file);
        try {
          fs.unlinkSync(filePath);
          logger.log(`Cleaned up temp file: ${filePath}`);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Clean up old temp files (older than 24 hours)
 */
export function cleanupOldTempFiles(): void {
  const tempDir = getTempDir();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  const now = Date.now();

  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          logger.log(`Cleaned up old temp file: ${filePath}`);
        }
      } catch {
        // Ignore errors
      }
    }
  } catch {
    // Ignore errors
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
