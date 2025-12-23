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
  audioDurationSeconds?: number;
  progressTimer?: NodeJS.Timeout;
  inferenceStartTime?: number;
}

export interface WhisperResult {
  processId: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  srtPath?: string;
  error?: string;
}

export type WhisperGpuMode = 'auto' | 'gpu' | 'cpu';

export interface WhisperConfig {
  binaryPath: string;
  modelsDir: string;
  libraryPath?: string;  // DYLD_LIBRARY_PATH for macOS
  gpuMode?: WhisperGpuMode;  // GPU preference: auto (try GPU, fallback to CPU), gpu (force), cpu (force)
}

export class WhisperBridge extends EventEmitter {
  private config: WhisperConfig;
  private activeProcesses = new Map<string, WhisperProcessInfo>();
  private readonly logger = new Logger(WhisperBridge.name);
  private gpuFailedOnce = false;  // Track if GPU failed, for auto mode fallback

  // All known whisper models (for display names)
  // Only tiny and base are bundled with the app
  static readonly MODEL_INFO: Record<string, { name: string; description: string }> = {
    'tiny': { name: 'Tiny', description: 'Fastest, lower accuracy' },
    'base': { name: 'Base', description: 'Good balance of speed and accuracy' },
  };
  static readonly DEFAULT_MODEL = 'base';

  constructor(config: WhisperConfig) {
    super();
    this.config = { ...config, gpuMode: config.gpuMode || 'auto' };
    this.logger.log(`Initialized with binary: ${config.binaryPath}`);
    this.logger.log(`Models directory: ${config.modelsDir}`);
    this.logger.log(`GPU mode: ${this.config.gpuMode}`);
  }

  /**
   * Get current GPU mode
   */
  getGpuMode(): WhisperGpuMode {
    return this.config.gpuMode || 'auto';
  }

  /**
   * Set GPU mode
   */
  setGpuMode(mode: WhisperGpuMode): void {
    this.config.gpuMode = mode;
    this.logger.log(`GPU mode set to: ${mode}`);
    // Reset the GPU failed flag when mode is changed
    if (mode !== 'auto') {
      this.gpuFailedOnce = false;
    }
  }

  /**
   * Check if GPU has failed (for status reporting)
   */
  hasGpuFailed(): boolean {
    return this.gpuFailedOnce;
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

    const modelFile = `ggml-${normalizedName}.bin`;
    const modelPath = path.join(this.config.modelsDir, modelFile);

    // Check if this model exists on disk
    if (!fs.existsSync(modelPath)) {
      // Fall back to default if requested model doesn't exist
      const availableModels = this.getAvailableModels();
      if (availableModels.length === 0) {
        throw new Error(`No whisper models found in ${this.config.modelsDir}`);
      }

      if (!availableModels.includes(normalizedName)) {
        // Try default, otherwise use first available
        const fallback = availableModels.includes(WhisperBridge.DEFAULT_MODEL)
          ? WhisperBridge.DEFAULT_MODEL
          : availableModels[0];
        this.logger.warn(`Model ${modelName} not found, using ${fallback}`);
        normalizedName = fallback;
        return path.join(this.config.modelsDir, `ggml-${normalizedName}.bin`);
      }
    }

    return modelPath;
  }

  /**
   * Get list of available models on disk (scans directory for ggml-*.bin files)
   */
  getAvailableModels(): string[] {
    try {
      if (!fs.existsSync(this.config.modelsDir)) {
        this.logger.warn(`Models directory not found: ${this.config.modelsDir}`);
        return [];
      }

      const files = fs.readdirSync(this.config.modelsDir);
      const models: string[] = [];

      for (const file of files) {
        // Match ggml-{modelname}.bin pattern
        const match = file.match(/^ggml-([a-z0-9-]+)\.bin$/i);
        if (match) {
          models.push(match[1].toLowerCase());
        }
      }

      // Sort by model size (tiny < base < small < medium < large)
      const sizeOrder = ['tiny', 'base', 'small', 'medium', 'large'];
      models.sort((a, b) => {
        const aIndex = sizeOrder.indexOf(a);
        const bIndex = sizeOrder.indexOf(b);
        if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      });

      return models;
    } catch (error) {
      this.logger.error(`Error scanning models directory: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Get available models with their display info
   */
  getAvailableModelsWithInfo(): Array<{ id: string; name: string; description: string }> {
    const models = this.getAvailableModels();
    return models.map(id => ({
      id,
      name: WhisperBridge.MODEL_INFO[id]?.name || id.charAt(0).toUpperCase() + id.slice(1),
      description: WhisperBridge.MODEL_INFO[id]?.description || 'Whisper model',
    }));
  }

  /**
   * Transcribe an audio file
   * Returns a process ID for tracking
   * Implements GPU fallback: in 'auto' mode, tries GPU first, falls back to CPU if GPU fails
   */
  async transcribe(
    audioPath: string,
    outputDir: string,
    options?: {
      model?: string;
      processId?: string;
      language?: string;
      translate?: boolean;
      audioDurationSeconds?: number;  // For time-based progress estimation
    }
  ): Promise<WhisperResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');
    const gpuMode = this.config.gpuMode || 'auto';

    // Determine if we should use GPU
    let useGpu = gpuMode === 'gpu' || (gpuMode === 'auto' && !this.gpuFailedOnce);

    if (gpuMode === 'cpu') {
      useGpu = false;
    }

    this.logger.log(`[${processId}] GPU mode: ${gpuMode}, using GPU: ${useGpu}, gpuFailedOnce: ${this.gpuFailedOnce}`);

    // First attempt
    const result = await this._runTranscription(audioPath, outputDir, processId, useGpu, options);

    // Check if GPU failed and we should retry with CPU (auto mode only)
    if (!result.success && gpuMode === 'auto' && useGpu && this.isGpuError(result)) {
      this.logger.warn(`[${processId}] GPU transcription failed, retrying with CPU...`);
      this.gpuFailedOnce = true;

      // Emit event so frontend knows GPU failed
      this.emit('gpu-fallback', { processId, reason: result.error });

      // Retry with CPU
      const cpuResult = await this._runTranscription(audioPath, outputDir, processId + '-cpu', false, options);
      return cpuResult;
    }

    return result;
  }

  /**
   * Check if an error is a GPU-related error
   */
  private isGpuError(result: WhisperResult): boolean {
    if (!result.error) return false;

    const gpuErrorPatterns = [
      'GGML_ASSERT',
      'device',
      'CUDA',
      'cuda',
      'GPU',
      'gpu',
      'metal',
      'Metal',
      'vulkan',
      'Vulkan',
      '3221226505',  // Windows STATUS_STACK_BUFFER_OVERRUN often from GPU issues
      'backend',
    ];

    return gpuErrorPatterns.some(pattern => result.error?.includes(pattern));
  }

  /**
   * Internal method to run transcription with specific GPU setting
   */
  private _runTranscription(
    audioPath: string,
    outputDir: string,
    processId: string,
    useGpu: boolean,
    options?: {
      model?: string;
      language?: string;
      translate?: boolean;
      audioDurationSeconds?: number;
    }
  ): Promise<WhisperResult> {
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

      // Add no-GPU flag if not using GPU
      if (!useGpu) {
        args.push('-ng');
      }

      // Optional language specification
      if (options?.language) {
        args.push('-l', options.language);
      }

      // Translation mode (to English)
      if (options?.translate) {
        args.push('--translate');
      }

      this.logger.log(`[${processId}] Starting: whisper-cli ${args.join(' ')} (GPU: ${useGpu})`);

      // Set up environment for dylib loading and GPU control
      const env = { ...process.env };
      if (this.config.libraryPath) {
        env.DYLD_LIBRARY_PATH = `${this.config.libraryPath}:${env.DYLD_LIBRARY_PATH || ''}`;
      }

      // If not using GPU, try to disable CUDA/GPU via environment variables
      if (!useGpu) {
        // Disable CUDA
        env.CUDA_VISIBLE_DEVICES = '';
        env.GGML_CUDA_NO_PINNED = '1';
        // Force CPU backend in ggml
        env.GGML_SCHED_DISABLE_GPU = '1';
        // Disable OpenCL
        env.GGML_OPENCL_DISABLE = '1';
        this.logger.log(`[${processId}] GPU disabled via environment variables`);
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
        audioDurationSeconds: options?.audioDurationSeconds,
      };

      this.activeProcesses.set(processId, processInfo);

      // Start time-based progress estimation if we know the audio duration
      // This provides progress updates during the inference phase (35%-95%)
      if (options?.audioDurationSeconds && options.audioDurationSeconds > 0) {
        this.startProgressEstimation(processId, options.audioDurationSeconds, useGpu);
      }

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
        this.stopProgressEstimation(processId);
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
        this.stopProgressEstimation(processId);
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
    this.stopProgressEstimation(processId);

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

  /**
   * Start time-based progress estimation during transcription
   * Whisper.cpp doesn't emit granular progress during inference,
   * so we estimate based on audio duration and elapsed time.
   */
  private startProgressEstimation(processId: string, audioDurationSeconds: number, useGpu: boolean): void {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) return;

    // Estimate transcription time based on audio duration
    // These are rough estimates: GPU is typically 0.3-0.5x realtime, CPU is 1-3x realtime
    const speedMultiplier = useGpu ? 0.4 : 2.0;
    const estimatedTranscriptionMs = audioDurationSeconds * 1000 * speedMultiplier;

    // We'll emit progress updates every 2 seconds
    const PROGRESS_INTERVAL_MS = 2000;

    // Start the progress timer once we reach the inference phase (after 35%)
    // We delay start slightly to allow whisper to initialize
    const startDelay = 3000; // 3 seconds after process start

    setTimeout(() => {
      const currentProcessInfo = this.activeProcesses.get(processId);
      if (!currentProcessInfo || currentProcessInfo.aborted) return;

      // Record when inference estimation starts
      currentProcessInfo.inferenceStartTime = Date.now();

      this.logger.log(`[${processId}] Starting progress estimation: audio=${audioDurationSeconds}s, estimated=${Math.round(estimatedTranscriptionMs / 1000)}s`);

      currentProcessInfo.progressTimer = setInterval(() => {
        const pi = this.activeProcesses.get(processId);
        if (!pi || pi.aborted || !pi.inferenceStartTime) {
          this.stopProgressEstimation(processId);
          return;
        }

        // Don't emit if we already completed (process closed)
        if (pi.lastReportedPercent >= 95) {
          this.stopProgressEstimation(processId);
          return;
        }

        const elapsed = Date.now() - pi.inferenceStartTime;
        const progress = Math.min(elapsed / estimatedTranscriptionMs, 1.0);

        // Map progress to 35%-95% range
        // 35% = inference start, 95% = inference end (before finalization)
        const percent = Math.round(35 + (progress * 60));

        // Only emit if we've made progress and haven't exceeded 94%
        if (percent > pi.lastReportedPercent && percent <= 94) {
          pi.lastReportedPercent = percent;

          this.emit('progress', {
            processId,
            percent,
            message: this.getProgressMessage(percent),
          } as WhisperProgress);
        }

        // Stop the timer if we've exceeded our estimate (inference taking longer than expected)
        if (progress >= 1.0) {
          this.logger.log(`[${processId}] Progress estimation reached 100%, waiting for completion`);
          this.stopProgressEstimation(processId);
        }
      }, PROGRESS_INTERVAL_MS);

    }, startDelay);
  }

  /**
   * Stop the progress estimation timer for a process
   */
  private stopProgressEstimation(processId: string): void {
    const processInfo = this.activeProcesses.get(processId);
    if (processInfo?.progressTimer) {
      clearInterval(processInfo.progressTimer);
      processInfo.progressTimer = undefined;
      this.logger.log(`[${processId}] Stopped progress estimation timer`);
    }
  }
}
