// backend/src/media/whisper-manager.ts
// Uses whisper.cpp via WhisperBridge on ALL platforms - standalone C++ implementation
// No Python, no VC++ runtime, no dependencies!

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  WhisperBridge,
  getRuntimePaths,
  getWhisperLibraryPath,
  verifyBinary,
  type WhisperProgress as BridgeProgress,
  type WhisperGpuMode,
} from '../bridges';

export interface WhisperProgress {
  percent: number;
  task: string;
}

@Injectable()
export class WhisperManager extends EventEmitter {
  private readonly logger = new Logger(WhisperManager.name);
  private whisper: WhisperBridge;
  private currentProcessId: string | null = null;

  constructor() {
    super();

    this.logger.log('='.repeat(60));
    this.logger.log('WHISPER MANAGER INITIALIZATION');
    this.logger.log('='.repeat(60));
    this.logger.log(`Platform: ${process.platform}`);
    this.logger.log(`Architecture: ${process.arch}`);
    this.logger.log(`Node version: ${process.version}`);
    this.logger.log(`Process CWD: ${process.cwd()}`);
    this.logger.log(`Resources path: ${(process as any).resourcesPath || 'NOT SET (development mode)'}`);

    // ALWAYS use bundled binaries from getRuntimePaths() - NEVER use system binaries
    // This ensures consistent behavior across all platforms and prevents using
    // user's system-installed binaries which may be incompatible versions
    const runtimePaths = getRuntimePaths();
    const whisperPath = runtimePaths.whisper;
    const modelsDir = runtimePaths.whisperModelsDir;

    this.logger.log('-'.repeat(60));
    this.logger.log('RESOLVED PATHS:');
    this.logger.log(`  Whisper binary: ${whisperPath}`);
    this.logger.log(`  Whisper binary exists: ${fs.existsSync(whisperPath)}`);
    this.logger.log(`  Models directory: ${modelsDir}`);
    this.logger.log(`  Models directory exists: ${fs.existsSync(modelsDir)}`);

    if (fs.existsSync(whisperPath)) {
      const stats = fs.statSync(whisperPath);
      this.logger.log(`  Whisper binary size: ${(stats.size / 1024).toFixed(2)} KB`);
      this.logger.log(`  Whisper binary permissions: ${stats.mode.toString(8)}`);
    }

    // Initialize the WhisperBridge
    this.whisper = new WhisperBridge({
      binaryPath: whisperPath,
      modelsDir: modelsDir,
      libraryPath: getWhisperLibraryPath(),
    });

    // Forward progress events from bridge to this manager
    this.whisper.on('progress', (progress: BridgeProgress) => {
      this.emit('progress', {
        percent: progress.percent,
        task: progress.message,
      } as WhisperProgress);
    });

    // Forward GPU fallback events
    this.whisper.on('gpu-fallback', (data: { processId: string; reason: string }) => {
      this.logger.warn(`GPU fallback triggered: ${data.reason}`);
      this.emit('gpu-fallback', data);
    });

    // Log available models (dynamically discovered from disk)
    const availableModels = this.whisper.getAvailableModels();
    this.logger.log(`  Available models (${availableModels.length} found):`);
    for (const model of availableModels) {
      const info = WhisperBridge.MODEL_INFO[model];
      this.logger.log(`    - ${model}: ${info?.description || 'Custom model'}`);
    }

    this.logger.log('='.repeat(60));
  }

  /**
   * Get list of available models (those that exist on disk)
   */
  getAvailableModels(): string[] {
    return this.whisper.getAvailableModels();
  }

  /**
   * Get available models with display info
   */
  getAvailableModelsWithInfo(): Array<{ id: string; name: string; description: string }> {
    return this.whisper.getAvailableModelsWithInfo();
  }

  /**
   * Transcribe an audio file
   */
  async transcribe(audioFile: string, outputDir: string, modelName?: string): Promise<string> {
    this.logger.log('='.repeat(60));
    this.logger.log('STARTING TRANSCRIPTION');
    this.logger.log('='.repeat(60));
    this.logger.log(`Timestamp: ${new Date().toISOString()}`);
    this.logger.log(`Audio file: ${audioFile}`);
    this.logger.log(`Audio file exists: ${fs.existsSync(audioFile)}`);
    if (fs.existsSync(audioFile)) {
      const stats = fs.statSync(audioFile);
      this.logger.log(`Audio file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }
    this.logger.log(`Output directory: ${outputDir}`);
    this.logger.log(`Output directory exists: ${fs.existsSync(outputDir)}`);
    this.logger.log(`Whisper binary: ${this.whisper.path}`);
    this.logger.log(`Whisper binary exists: ${fs.existsSync(this.whisper.path)}`);
    this.logger.log(`Requested model: ${modelName || 'default'}`);

    if (!audioFile || !fs.existsSync(audioFile)) {
      const error = `Audio file not found: ${audioFile}`;
      this.logger.error(error);
      throw new Error(error);
    }

    if (!fs.existsSync(this.whisper.path)) {
      const error = `whisper.cpp not found at: ${this.whisper.path}. Please reinstall the application or run: npm run download:binaries`;
      this.logger.error(error);
      throw new Error(error);
    }

    // Generate a process ID for tracking
    const processId = `transcribe-${Date.now()}`;
    this.currentProcessId = processId;

    this.emit('progress', { percent: 5, task: 'Starting transcription' });

    try {
      const result = await this.whisper.transcribe(audioFile, outputDir, {
        model: modelName,
        processId,
      });

      this.currentProcessId = null;

      if (!result.success) {
        const error = result.error || 'Transcription failed';
        this.logger.error(error);

        if (error.includes('wrong architecture')) {
          throw new Error(`Whisper binary has wrong architecture. Please reinstall the application.`);
        } else if (error.includes('not found')) {
          throw new Error(`Whisper binary not found. Please reinstall the application or run: npm run download:binaries`);
        } else if (error.includes('aborted')) {
          throw new Error('Transcription was cancelled');
        }

        throw new Error(error);
      }

      if (!result.srtPath || !fs.existsSync(result.srtPath)) {
        // Try to find any SRT file created
        const basename = path.basename(audioFile, path.extname(audioFile));
        const files = fs.readdirSync(outputDir);
        const srtFiles = files.filter(f => f.endsWith('.srt') && f.startsWith(basename));

        if (srtFiles.length > 0) {
          const foundSrt = path.join(outputDir, srtFiles[0]);
          const stats = fs.statSync(foundSrt);
          this.logger.log(`SRT file found: ${foundSrt} (${stats.size} bytes)`);
          this.emit('progress', { percent: 100, task: 'Transcription completed' });
          return foundSrt;
        }

        throw new Error('Transcription completed but no SRT file was created');
      }

      this.logger.log(`Transcription completed: ${result.srtPath}`);
      this.emit('progress', { percent: 100, task: 'Transcription completed' });
      return result.srtPath;
    } catch (err) {
      this.currentProcessId = null;
      throw err;
    }
  }

  /**
   * Cancel the current transcription
   */
  cancel(): void {
    if (this.currentProcessId && this.whisper.isRunning(this.currentProcessId)) {
      this.logger.log('='.repeat(60));
      this.logger.log('CANCELLING TRANSCRIPTION');
      this.logger.log(`  Process ID: ${this.currentProcessId}`);
      this.whisper.abort(this.currentProcessId);
      this.currentProcessId = null;
      this.logger.log('='.repeat(60));
    }
  }

  /**
   * Get current GPU mode
   */
  getGpuMode(): WhisperGpuMode {
    return this.whisper.getGpuMode();
  }

  /**
   * Set GPU mode (auto, gpu, cpu)
   */
  setGpuMode(mode: WhisperGpuMode): void {
    this.whisper.setGpuMode(mode);
  }

  /**
   * Check if GPU has failed (useful for status display)
   */
  hasGpuFailed(): boolean {
    return this.whisper.hasGpuFailed();
  }
}
