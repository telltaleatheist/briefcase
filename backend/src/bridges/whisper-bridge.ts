/**
 * Whisper Bridge - Process wrapper for whisper.cpp binary
 * Supports multiple concurrent transcription processes with individualized feedback
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';

export interface WhisperProgress {
  processId: string;
  percent: number;
  message: string;
}

export interface WhisperProcessInfo {
  id: string;
  process: ChildProcess;
  audioPath: string;
  modelPath: string;
  startTime: number;
  aborted: boolean;
  lastReportedPercent: number;
}

export interface WhisperResult {
  processId: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  srtPath?: string;
  error?: string;
}

export interface WhisperConfig {
  binaryPath: string;
  modelsDir: string;
  libraryPath?: string;  // DYLD_LIBRARY_PATH for macOS
}

export class WhisperBridge extends EventEmitter {
  private config: WhisperConfig;
  private activeProcesses = new Map<string, WhisperProcessInfo>();
  private readonly logger = new Logger(WhisperBridge.name);

  // Supported models
  static readonly AVAILABLE_MODELS = ['tiny', 'base', 'small', 'medium', 'large'];
  static readonly DEFAULT_MODEL = 'base';

  constructor(config: WhisperConfig) {
    super();
    this.config = config;
    this.logger.log(`Initialized with binary: ${config.binaryPath}`);
    this.logger.log(`Models directory: ${config.modelsDir}`);
  }

  /**
   * Get the binary path
   */
  get path(): string {
    return this.config.binaryPath;
  }

  /**
   * Get the models directory
   */
  get modelsDir(): string {
    return this.config.modelsDir;
  }

  /**
   * Get path to a specific model file
   */
  getModelPath(modelName: string = WhisperBridge.DEFAULT_MODEL): string {
    let normalizedName = modelName.toLowerCase();

    // Strip prefixes/suffixes
    if (normalizedName.startsWith('ggml-')) {
      normalizedName = normalizedName.substring(5);
    }
    if (normalizedName.endsWith('.bin')) {
      normalizedName = normalizedName.slice(0, -4);
    }

    // Validate model
    if (!WhisperBridge.AVAILABLE_MODELS.includes(normalizedName)) {
      this.logger.warn(`Invalid model: ${modelName}, using ${WhisperBridge.DEFAULT_MODEL}`);
      normalizedName = WhisperBridge.DEFAULT_MODEL;
    }

    const modelFile = `ggml-${normalizedName}.bin`;
    const modelPath = path.join(this.config.modelsDir, modelFile);

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model ${modelFile} not found at ${modelPath}`);
    }

    return modelPath;
  }

  /**
   * Get list of available models on disk
   */
  getAvailableModels(): string[] {
    const available: string[] = [];
    for (const model of WhisperBridge.AVAILABLE_MODELS) {
      const modelPath = path.join(this.config.modelsDir, `ggml-${model}.bin`);
      if (fs.existsSync(modelPath)) {
        available.push(model);
      }
    }
    return available;
  }

  /**
   * Transcribe an audio file
   * Returns a process ID for tracking
   */
  transcribe(
    audioPath: string,
    outputDir: string,
    options?: {
      model?: string;
      processId?: string;
      language?: string;
      translate?: boolean;
    }
  ): Promise<WhisperResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');
    const modelPath = this.getModelPath(options?.model);

    return new Promise((resolve, reject) => {
      // Prepare output paths
      const basename = path.basename(audioPath, path.extname(audioPath));
      const outputBase = path.join(outputDir, basename);
      const srtPath = `${outputBase}.srt`;

      const args = [
        '-m', modelPath,
        '-f', audioPath,
        '-osrt',              // Output SRT format
        '-of', outputBase,    // Output file base
        '-pp',                // Print progress
      ];

      // Optional language specification
      if (options?.language) {
        args.push('-l', options.language);
      }

      // Translation mode (to English)
      if (options?.translate) {
        args.push('--translate');
      }

      this.logger.log(`[${processId}] Starting: whisper-cli ${args.join(' ')}`);

      // Set up environment for dylib loading
      const env = { ...process.env };
      if (this.config.libraryPath) {
        env.DYLD_LIBRARY_PATH = `${this.config.libraryPath}:${env.DYLD_LIBRARY_PATH || ''}`;
      }

      const proc = spawn(this.config.binaryPath, args, {
        cwd: outputDir,
        env,
      });

      const startTime = Date.now();

      const processInfo: WhisperProcessInfo = {
        id: processId,
        process: proc,
        audioPath,
        modelPath,
        startTime,
        aborted: false,
        lastReportedPercent: 0,
      };

      this.activeProcesses.set(processId, processInfo);

      let stdoutBuffer = '';
      let stderrBuffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        this.parseProgress(processId, chunk);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        this.parseProgress(processId, chunk);
      });

      proc.on('close', (code) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        if (processInfo.aborted) {
          this.logger.log(`[${processId}] Aborted after ${duration}ms`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: 'Transcription was aborted',
          });
          return;
        }

        if (code === 0) {
          // Verify SRT was created
          if (!fs.existsSync(srtPath)) {
            this.logger.error(`[${processId}] No SRT file created at ${srtPath}`);
            resolve({
              processId,
              success: false,
              exitCode: code,
              duration,
              error: 'Transcription completed but no SRT file was created',
            });
            return;
          }

          this.logger.log(`[${processId}] Completed successfully in ${duration}ms`);
          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
            srtPath,
          });
        } else {
          this.logger.error(`[${processId}] Failed with code ${code}`);
          this.logger.error(`[${processId}] stderr: ${stderrBuffer.slice(-500)}`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: `Whisper exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        this.logger.error(`[${processId}] Spawn error: ${err.message}`);

        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`Whisper binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`Whisper binary not found at: ${this.config.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Abort a running transcription
   */
  abort(processId: string): boolean {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) {
      this.logger.warn(`Cannot abort ${processId}: not found`);
      return false;
    }

    this.logger.log(`[${processId}] Aborting transcription`);
    processInfo.aborted = true;

    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${processInfo.process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        processInfo.process.kill('SIGKILL');
      }
    } else {
      processInfo.process.kill('SIGTERM');
    }

    return true;
  }

  /**
   * Abort all running transcriptions
   */
  abortAll(): void {
    this.logger.log(`Aborting all ${this.activeProcesses.size} transcriptions`);
    for (const processId of this.activeProcesses.keys()) {
      this.abort(processId);
    }
  }

  /**
   * Get list of active process IDs
   */
  getActiveProcesses(): string[] {
    return Array.from(this.activeProcesses.keys());
  }

  /**
   * Check if a transcription is running
   */
  isRunning(processId: string): boolean {
    return this.activeProcesses.has(processId);
  }

  /**
   * Parse progress from whisper.cpp output
   */
  private parseProgress(processId: string, output: string): void {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) return;

    let percent: number | null = null;
    let message: string | null = null;

    // whisper.cpp with -pp outputs: "progress = XX%"
    const progressMatch = output.match(/progress\s*=\s*(\d+)%/i);
    if (progressMatch) {
      percent = Math.min(95, parseInt(progressMatch[1], 10));
    }

    // Simple percentage pattern
    if (percent === null) {
      const simpleMatch = output.match(/(\d+)%/);
      if (simpleMatch) {
        const parsed = parseInt(simpleMatch[1], 10);
        if (parsed > processInfo.lastReportedPercent + 5) {
          percent = Math.min(95, parsed);
        }
      }
    }

    // Status messages
    if (output.includes('loading model') || output.includes('whisper_init')) {
      if (processInfo.lastReportedPercent < 20) {
        percent = 20;
        message = 'Loading Whisper model';
      }
    } else if (output.includes('processing') || output.includes('run_whisper')) {
      if (processInfo.lastReportedPercent < 30) {
        percent = 30;
        message = 'Processing audio';
      }
    }

    // Emit progress if we have an update
    if (percent !== null && percent > processInfo.lastReportedPercent) {
      processInfo.lastReportedPercent = percent;

      if (!message) {
        message = this.getProgressMessage(percent);
      }

      this.emit('progress', {
        processId,
        percent,
        message,
      } as WhisperProgress);
    }
  }

  /**
   * Get human-readable progress message
   */
  private getProgressMessage(percent: number): string {
    if (percent < 20) return 'Initializing';
    if (percent < 30) return 'Loading model';
    if (percent < 40) return 'Detecting language';
    if (percent < 60) return 'Processing audio';
    if (percent < 80) return 'Generating transcript';
    if (percent < 95) return 'Processing segments';
    return 'Finalizing transcript';
  }
}
