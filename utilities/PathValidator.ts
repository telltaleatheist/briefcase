// utilities/PathValidator.ts
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as log from 'electron-log';

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  version?: string;
}

export class PathValidator {
  /**
   * Validate that a file exists and is executable
   */
  static async validateExecutable(filePath: string | undefined): Promise<ValidationResult> {
    if (!filePath) {
      return { isValid: false, error: 'Path is not specified' };
    }

    try {
      const stats = fs.statSync(filePath);
      
      if (!stats.isFile()) {
        return { isValid: false, error: 'Path exists but is not a file' };
      }
      
      // Add executable check for unix systems
      if (process.platform !== 'win32') {
        const isExecutable = !!(stats.mode & 0o111); // Check if any execute bit is set
        if (!isExecutable) {
          return { isValid: false, error: 'File exists but is not executable' };
        }
      }
      
      return { isValid: true };
    } catch (error) {
      return { 
        isValid: false, 
        error: `File validation error: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }

  /**
   * Validate the FFmpeg binary
   */
  static validateFFmpeg(ffmpegPath: string | undefined): Promise<ValidationResult> {
    return new Promise(async (resolve) => {
      const basicCheck = await this.validateExecutable(ffmpegPath);
      if (!basicCheck.isValid) {
        log.warn(`FFmpeg basic check failed for ${ffmpegPath}:`, basicCheck.error);
        resolve(basicCheck);
        return;
      }

      log.info(`Validating FFmpeg at: ${ffmpegPath}`);

      // Add timeout to prevent hanging
      const timeout = setTimeout(() => {
        log.error(`FFmpeg validation timed out for: ${ffmpegPath}`);
        resolve({
          isValid: false,
          error: 'FFmpeg validation timed out after 10 seconds'
        });
      }, 10000);

      execFile(ffmpegPath!, ['-version'], (error, stdout, stderr) => {
        clearTimeout(timeout);

        if (error) {
          log.error(`FFmpeg execution error for ${ffmpegPath}:`, error.message);
          if (stderr) log.error(`FFmpeg stderr: ${stderr}`);
          resolve({
            isValid: false,
            error: `FFmpeg execution error: ${error.message}`
          });
          return;
        }

        // Extract version from output
        const versionMatch = stdout.match(/ffmpeg version (\S+)/);
        const version = versionMatch ? versionMatch[1] : 'unknown';

        log.info(`FFmpeg validated successfully: ${version}`);

        resolve({
          isValid: true,
          version: version
        });
      });
    });
  }

  /**
   * Validate the FFprobe binary
   */
  static validateFFprobe(ffprobePath: string | undefined): Promise<ValidationResult> {
    return new Promise(async (resolve) => {
      const basicCheck = await this.validateExecutable(ffprobePath);
      if (!basicCheck.isValid) {
        log.warn(`FFprobe basic check failed for ${ffprobePath}:`, basicCheck.error);
        resolve(basicCheck);
        return;
      }

      log.info(`Validating FFprobe at: ${ffprobePath}`);

      // Add timeout to prevent hanging
      const timeout = setTimeout(() => {
        log.error(`FFprobe validation timed out for: ${ffprobePath}`);
        resolve({
          isValid: false,
          error: 'FFprobe validation timed out after 10 seconds'
        });
      }, 10000);

      execFile(ffprobePath!, ['-version'], (error, stdout, stderr) => {
        clearTimeout(timeout);

        if (error) {
          log.error(`FFprobe execution error for ${ffprobePath}:`, error.message);
          if (stderr) log.error(`FFprobe stderr: ${stderr}`);
          resolve({
            isValid: false,
            error: `FFprobe execution error: ${error.message}`
          });
          return;
        }

        // Extract version from output
        const versionMatch = stdout.match(/ffprobe version (\S+)/);
        const version = versionMatch ? versionMatch[1] : 'unknown';

        log.info(`FFprobe validated successfully: ${version}`);

        resolve({
          isValid: true,
          version: version
        });
      });
    });
  }

  /**
   * Validate the yt-dlp binary
   */
  static validateYtDlp(ytDlpPath: string | undefined): Promise<ValidationResult> {
    return new Promise(async (resolve) => {
      const basicCheck = await this.validateExecutable(ytDlpPath);
      if (!basicCheck.isValid) {
        log.warn(`yt-dlp basic check failed for ${ytDlpPath}:`, basicCheck.error);
        resolve(basicCheck);
        return;
      }

      log.info(`Validating yt-dlp at: ${ytDlpPath}`);

      // Add timeout to prevent hanging
      const timeout = setTimeout(() => {
        log.error(`yt-dlp validation timed out for: ${ytDlpPath}`);
        resolve({
          isValid: false,
          error: 'yt-dlp validation timed out after 10 seconds'
        });
      }, 10000);

      execFile(ytDlpPath!, ['--version'], (error, stdout, stderr) => {
        clearTimeout(timeout);

        if (error) {
          log.error(`yt-dlp execution error for ${ytDlpPath}:`, error.message);
          if (stderr) log.error(`yt-dlp stderr: ${stderr}`);
          resolve({
            isValid: false,
            error: `yt-dlp execution error: ${error.message}`
          });
          return;
        }

        // The version output is just the version number
        const version = stdout.trim();

        log.info(`yt-dlp validated successfully: ${version}`);

        resolve({
          isValid: true,
          version: version
        });
      });
    });
  }

  /**
   * Validate all required paths
   */
  static async validateAllPaths(paths: { 
    ffmpegPath?: string; 
    ffprobePath?: string; 
    ytDlpPath?: string; 
  }): Promise<{
    allValid: boolean;
    ffmpeg: ValidationResult;
    ffprobe: ValidationResult;
    ytDlp: ValidationResult;
  }> {
    const ffmpegResult = await this.validateFFmpeg(paths.ffmpegPath);
    const ffprobeResult = await this.validateFFprobe(paths.ffprobePath);
    const ytDlpResult = await this.validateYtDlp(paths.ytDlpPath);
    
    const allValid = ffmpegResult.isValid && ffprobeResult.isValid && ytDlpResult.isValid;
    
    return {
      allValid,
      ffmpeg: ffmpegResult,
      ffprobe: ffprobeResult,
      ytDlp: ytDlpResult
    };
  }

  /**
   * Look for executables in a directory
   */
  static findExecutablesInDirectory(directoryPath: string): {
    ffmpegPath?: string;
    ffprobePath?: string;
    ytDlpPath?: string;
  } {
    const result: {
      ffmpegPath?: string;
      ffprobePath?: string;
      ytDlpPath?: string;
    } = {};

    try {
      if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
        return result;
      }

      // Get all files in directory
      const files = fs.readdirSync(directoryPath);
      
      // Check for FFmpeg
      const ffmpegNames = process.platform === 'win32' 
        ? ['ffmpeg.exe'] 
        : ['ffmpeg'];
      
      for (const name of ffmpegNames) {
        if (files.includes(name)) {
          result.ffmpegPath = path.join(directoryPath, name);
          break;
        }
      }
      
      // Check for FFprobe
      const ffprobeNames = process.platform === 'win32' 
        ? ['ffprobe.exe'] 
        : ['ffprobe'];
      
      for (const name of ffprobeNames) {
        if (files.includes(name)) {
          result.ffprobePath = path.join(directoryPath, name);
          break;
        }
      }
      
      // Check for yt-dlp
      const ytDlpNames = process.platform === 'win32' 
        ? ['yt-dlp.exe'] 
        : ['yt-dlp'];
      
      for (const name of ytDlpNames) {
        if (files.includes(name)) {
          result.ytDlpPath = path.join(directoryPath, name);
          break;
        }
      }
      
      return result;
    } catch (error) {
      log.error('Error looking for executables:', error);
      return result;
    }
  }

  /**
   * Attempt to find executables in PATH
   */
  static findExecutablesInSystemPath(): {
    ffmpegPath?: string;
    ffprobePath?: string;
    ytDlpPath?: string;
  } {
    const result: {
      ffmpegPath?: string;
      ffprobePath?: string;
      ytDlpPath?: string;
    } = {};

    try {
      const pathEnv = process.env.PATH || '';
      const pathSeparator = process.platform === 'win32' ? ';' : ':';
      const pathDirs = pathEnv.split(pathSeparator);
      
      const exeExtension = process.platform === 'win32' ? '.exe' : '';
      
      // Check all directories in PATH for each executable
      for (const dir of pathDirs) {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          continue;
        }

        // Check for FFmpeg
        const ffmpegPath = path.join(dir, `ffmpeg${exeExtension}`);
        if (!result.ffmpegPath && fs.existsSync(ffmpegPath)) {
          result.ffmpegPath = ffmpegPath;
        }
        
        // Check for FFprobe
        const ffprobePath = path.join(dir, `ffprobe${exeExtension}`);
        if (!result.ffprobePath && fs.existsSync(ffprobePath)) {
          result.ffprobePath = ffprobePath;
        }
        
        // Check for yt-dlp
        const ytDlpPath = path.join(dir, `yt-dlp${exeExtension}`);
        if (!result.ytDlpPath && fs.existsSync(ytDlpPath)) {
          result.ytDlpPath = ytDlpPath;
        }
        
        // If we found all executables, we can stop searching
        if (result.ffmpegPath && result.ffprobePath && result.ytDlpPath) {
          break;
        }
      }
      
      return result;
    } catch (error) {
      log.error('Error looking for executables in PATH:', error);
      return result;
    }
  }
}