// backend/src/media/whisper-manager.ts
// Uses bundled Python with openai-whisper for maximum compatibility

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { SharedConfigService } from '../config/shared-config.service';
import * as fs from 'fs';
import * as path from 'path';

export interface WhisperProgress {
  percent: number;
  task: string;
}

@Injectable()
export class WhisperManager extends EventEmitter {
  private readonly logger = new Logger(WhisperManager.name);
  private currentProcess: ChildProcess | null = null;
  private isRunning = false;
  private aborted = false;
  private pythonPath: string;
  private progressCounter = 0;
  private startTime: number = 0;
  private audioDuration: number = 0;
  private lastReportedPercent = 0;

  constructor(private readonly sharedConfigService: SharedConfigService) {
    super();
    // Use bundled Python instead of whisper binary
    this.pythonPath = this.sharedConfigService.getPythonPath();
    this.logger.log(`Using Python at: ${this.pythonPath}`);
  }

  /**
   * Get environment with ffmpeg in PATH and proper Python setup
   */
  private getEnvironment(): NodeJS.ProcessEnv {
    const ffmpegPath = this.sharedConfigService.getFfmpegPath();
    const ffmpegDir = path.dirname(ffmpegPath);
    const pythonDir = path.dirname(this.pythonPath);

    const env = { ...process.env };
    const pathSeparator = process.platform === 'win32' ? ';' : ':';

    // Add ffmpeg and python directories to PATH
    env.PATH = `${ffmpegDir}${pathSeparator}${pythonDir}${pathSeparator}${env.PATH || ''}`;

    // Set cache directory for whisper models
    const cacheDir = this.getCacheDir();
    env.XDG_CACHE_HOME = cacheDir;

    // On Windows, also set these for whisper model caching
    if (process.platform === 'win32') {
      env.USERPROFILE = env.USERPROFILE || process.env.USERPROFILE;
    }

    this.logger.log(`Environment PATH includes: ${ffmpegDir}, ${pythonDir}`);
    this.logger.log(`Whisper cache directory: ${cacheDir}`);
    return env;
  }

  /**
   * Get cache directory for whisper models
   */
  private getCacheDir(): string {
    // Try to use the bundled cache first (for packaged app)
    const pythonDir = path.dirname(this.pythonPath);
    const bundledCache = path.join(pythonDir, '..', 'cache');

    if (fs.existsSync(bundledCache)) {
      return bundledCache;
    }

    // Fall back to user's app data
    const os = require('os');
    const homeDir = os.homedir();

    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'ClipChimp', 'cache');
    } else if (process.platform === 'darwin') {
      return path.join(homeDir, 'Library', 'Caches', 'ClipChimp');
    } else {
      return path.join(homeDir, '.cache', 'ClipChimp');
    }
  }

  async transcribe(audioFile: string, outputDir: string): Promise<string> {
    this.progressCounter = 0;
    this.lastReportedPercent = 0;
    this.startTime = Date.now();

    this.logger.log('Starting Whisper transcription via Python');
    this.logger.log(`Audio file: ${audioFile}`);
    this.logger.log(`Output directory: ${outputDir}`);
    this.logger.log(`Python path: ${this.pythonPath}`);

    if (!audioFile || !fs.existsSync(audioFile)) {
      throw new Error(`Audio file not found: ${audioFile}`);
    }

    // Check if Python exists
    if (!fs.existsSync(this.pythonPath)) {
      throw new Error(`Python not found at: ${this.pythonPath}. Please reinstall the application.`);
    }

    // Get audio duration for progress estimation
    this.audioDuration = await this.getAudioDuration(audioFile);
    this.logger.log(`Audio duration: ${this.audioDuration}s`);

    this.aborted = false;
    this.isRunning = true;

    // Start periodic progress updates based on time
    const progressInterval = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(progressInterval);
        return;
      }
      this.updateTimeBasedProgress();
    }, 1000);

    // Create output filename for SRT
    const basename = path.basename(audioFile, path.extname(audioFile));
    const srtFile = path.join(outputDir, `${basename}.srt`);

    // Python script to run whisper
    const whisperScript = `
import sys
import os

# Set cache directory before importing whisper
cache_dir = os.environ.get('XDG_CACHE_HOME', '')
if cache_dir:
    os.makedirs(os.path.join(cache_dir, 'whisper'), exist_ok=True)

import whisper

print("[WHISPER] Loading model...", flush=True)
model = whisper.load_model("tiny")
print("[WHISPER] Model loaded", flush=True)

print("[WHISPER] Transcribing...", flush=True)
result = model.transcribe(r"${audioFile.replace(/\\/g, '\\\\')}", verbose=True)
print("[WHISPER] Transcription complete", flush=True)

# Generate SRT output
def format_timestamp(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    msecs = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{msecs:03d}"

output_path = r"${srtFile.replace(/\\/g, '\\\\')}"
with open(output_path, 'w', encoding='utf-8') as f:
    for i, segment in enumerate(result['segments'], 1):
        start = format_timestamp(segment['start'])
        end = format_timestamp(segment['end'])
        text = segment['text'].strip()
        f.write(f"{i}\\n{start} --> {end}\\n{text}\\n\\n")

print(f"[WHISPER] SRT saved to: {output_path}", flush=True)
print("[WHISPER] SUCCESS", flush=True)
`;

    return new Promise<string>((resolve, reject) => {
      const env = this.getEnvironment();

      // Run Python with the whisper script
      this.currentProcess = spawn(this.pythonPath, ['-c', whisperScript], {
        env,
        cwd: outputDir
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        this.logger.log(`[PYTHON STDOUT] ${chunk.trim()}`);
        this.parseProgress(chunk);
      });

      this.currentProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        // Whisper outputs progress to stderr
        this.logger.log(`[PYTHON STDERR] ${chunk.trim()}`);
        this.parseProgress(chunk);
      });

      this.currentProcess.on('close', (code) => {
        this.isRunning = false;
        clearInterval(progressInterval);

        this.logger.log(`Python process exited with code ${code}`);

        if (this.aborted) {
          reject(new Error('Transcription was cancelled'));
          return;
        }

        if (code === 0 && stdoutBuffer.includes('[WHISPER] SUCCESS')) {
          if (fs.existsSync(srtFile)) {
            this.emit('progress', { percent: 100, task: 'Transcription completed' });
            resolve(srtFile);
          } else {
            // Try to find any SRT file created
            const files = fs.readdirSync(outputDir);
            const srtFiles = files.filter(f => f.endsWith('.srt'));
            if (srtFiles.length > 0) {
              const foundSrt = path.join(outputDir, srtFiles[0]);
              this.emit('progress', { percent: 100, task: 'Transcription completed' });
              resolve(foundSrt);
            } else {
              reject(new Error('Transcription completed but no SRT file was created'));
            }
          }
        } else {
          // Check for common errors
          const fullOutput = stdoutBuffer + stderrBuffer;

          if (fullOutput.includes('No module named')) {
            const moduleMatch = fullOutput.match(/No module named '(\w+)'/);
            const moduleName = moduleMatch ? moduleMatch[1] : 'unknown';
            reject(new Error(`Python module '${moduleName}' not found. Please reinstall the application.`));
          } else if (fullOutput.includes('CUDA') || fullOutput.includes('cuda')) {
            // CUDA errors are usually warnings, check if we still got output
            if (fs.existsSync(srtFile)) {
              this.emit('progress', { percent: 100, task: 'Transcription completed' });
              resolve(srtFile);
              return;
            }
            reject(new Error('Transcription failed. GPU acceleration not available, but CPU should work.'));
          } else {
            reject(new Error(`Transcription failed (exit code ${code}): ${stderrBuffer.substring(0, 500)}`));
          }
        }
      });

      this.currentProcess.on('error', (err) => {
        this.isRunning = false;
        clearInterval(progressInterval);
        this.logger.error(`Failed to spawn Python process: ${err.message}`);
        this.logger.error(`Python path: ${this.pythonPath}`);
        this.logger.error(`Python exists: ${fs.existsSync(this.pythonPath)}`);
        reject(new Error(`Failed to start Python: ${err.message}. Please reinstall the application.`));
      });
    });
  }

  /**
   * Get audio duration using ffprobe
   */
  private async getAudioDuration(audioFile: string): Promise<number> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      const ffprobePath = this.sharedConfigService.getFfprobePath();
      exec(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`, (error: any, stdout: string) => {
        if (error) {
          this.logger.warn(`Could not get audio duration: ${error.message}`);
          resolve(180); // Default to 3 minutes
          return;
        }
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 180 : duration);
      });
    });
  }

  /**
   * Update progress based on elapsed time
   */
  private updateTimeBasedProgress(): void {
    if (this.audioDuration === 0) return;

    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    // Python whisper is slower than whisper.cpp, estimate ~5x realtime on CPU
    const estimatedProgress = Math.min(95, (elapsedSeconds * 5 / this.audioDuration) * 100);

    if (Math.floor(estimatedProgress / 5) > Math.floor(this.lastReportedPercent / 5)) {
      this.lastReportedPercent = estimatedProgress;
      this.emit('progress', {
        percent: Math.round(estimatedProgress),
        task: this.getCurrentTask(estimatedProgress)
      });
    }
  }

  private parseProgress(output: string): void {
    // Check for whisper milestone messages
    if (output.includes('[WHISPER] Loading model')) {
      this.emit('progress', { percent: 5, task: 'Loading Whisper model' });
      this.lastReportedPercent = 5;
    } else if (output.includes('[WHISPER] Model loaded')) {
      this.emit('progress', { percent: 15, task: 'Model loaded' });
      this.lastReportedPercent = 15;
    } else if (output.includes('[WHISPER] Transcribing')) {
      this.emit('progress', { percent: 20, task: 'Starting transcription' });
      this.lastReportedPercent = 20;
    } else if (output.includes('[WHISPER] Transcription complete')) {
      this.emit('progress', { percent: 90, task: 'Saving transcript' });
      this.lastReportedPercent = 90;
    } else if (output.includes('[WHISPER] SUCCESS')) {
      this.emit('progress', { percent: 100, task: 'Transcription completed' });
      this.lastReportedPercent = 100;
    }

    // Check for percentage in whisper verbose output
    const percentMatch = output.match(/(\d+)%/);
    if (percentMatch) {
      const percent = Math.min(95, parseInt(percentMatch[1], 10));
      if (percent > this.lastReportedPercent) {
        this.lastReportedPercent = percent;
        this.emit('progress', {
          percent,
          task: this.getCurrentTask(percent)
        });
      }
    }
  }

  private getCurrentTask(percent: number): string {
    if (percent < 10) return 'Loading Whisper model';
    if (percent < 20) return 'Preparing transcription';
    if (percent < 30) return 'Detecting language';
    if (percent < 50) return 'Processing audio';
    if (percent < 70) return 'Generating transcript';
    if (percent < 90) return 'Processing segments';
    return 'Finalizing transcript';
  }

  cancel(): void {
    if (this.currentProcess && this.isRunning) {
      this.logger.log('Cancelling Whisper transcription');
      this.aborted = true;

      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        try {
          execSync(`taskkill /pid ${this.currentProcess.pid} /T /F`);
        } catch (err) {
          // Silent fail
        }
      } else {
        this.currentProcess.kill('SIGTERM');
      }

      this.isRunning = false;
    }
  }
}
