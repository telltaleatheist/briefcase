// backend/src/media/whisper-manager.ts
// Uses whisper.cpp on ALL platforms - standalone C++ implementation
// No Python, no VC++ runtime, no dependencies!

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
  private lastReportedPercent = 0;

  private whisperPath: string;
  private modelsDir: string;

  // Available models - these are bundled with the app
  private static readonly AVAILABLE_MODELS = ['tiny', 'base', 'small'];
  private static readonly DEFAULT_MODEL = 'base';

  constructor(private readonly sharedConfigService: SharedConfigService) {
    super();

    this.logger.log('='.repeat(60));
    this.logger.log('WHISPER MANAGER INITIALIZATION');
    this.logger.log('='.repeat(60));
    this.logger.log(`Platform: ${process.platform}`);
    this.logger.log(`Architecture: ${process.arch}`);
    this.logger.log(`Node version: ${process.version}`);
    this.logger.log(`Process CWD: ${process.cwd()}`);
    this.logger.log(`Resources path: ${(process as any).resourcesPath || 'NOT SET (development mode)'}`);
    this.logger.log(`__dirname: ${__dirname}`);

    this.whisperPath = this.getWhisperCppPath();
    this.modelsDir = this.getModelsDir();

    this.logger.log('-'.repeat(60));
    this.logger.log('RESOLVED PATHS:');
    this.logger.log(`  Whisper binary: ${this.whisperPath}`);
    this.logger.log(`  Whisper binary exists: ${fs.existsSync(this.whisperPath)}`);
    this.logger.log(`  Models directory: ${this.modelsDir}`);
    this.logger.log(`  Models directory exists: ${fs.existsSync(this.modelsDir)}`);

    if (fs.existsSync(this.whisperPath)) {
      const stats = fs.statSync(this.whisperPath);
      this.logger.log(`  Whisper binary size: ${(stats.size / 1024).toFixed(2)} KB`);
      this.logger.log(`  Whisper binary permissions: ${stats.mode.toString(8)}`);
    }

    // Log available models
    this.logger.log('  Available models:');
    for (const model of WhisperManager.AVAILABLE_MODELS) {
      const modelPath = path.join(this.modelsDir, `ggml-${model}.bin`);
      const exists = fs.existsSync(modelPath);
      this.logger.log(`    - ${model}: ${exists ? '✓' : '✗'}`);
    }

    this.logger.log('='.repeat(60));
  }

  /**
   * Get the path to the whisper.cpp executable
   */
  private getWhisperCppPath(): string {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'whisper-cli.exe' : 'whisper-cli';

    this.logger.log('-'.repeat(60));
    this.logger.log('RESOLVING WHISPER BINARY PATH');
    this.logger.log(`  Looking for: ${binaryName}`);

    // Check environment variable first (set by Electron)
    if (process.env.WHISPER_CPP_PATH) {
      this.logger.log(`  ENV WHISPER_CPP_PATH: ${process.env.WHISPER_CPP_PATH}`);
      if (fs.existsSync(process.env.WHISPER_CPP_PATH)) {
        this.logger.log(`  ✓ Found via WHISPER_CPP_PATH env var`);
        return process.env.WHISPER_CPP_PATH;
      } else {
        this.logger.warn(`  ✗ WHISPER_CPP_PATH set but file not found`);
      }
    } else {
      this.logger.log(`  ENV WHISPER_CPP_PATH: not set`);
    }

    // Check in utilities/bin relative to various locations
    const possiblePaths = [
      // Packaged app paths
      path.join((process as any).resourcesPath || '', 'utilities', 'bin', binaryName),
      // Development paths
      path.join(__dirname, '..', '..', '..', '..', 'utilities', 'bin', binaryName),
      path.join(process.cwd(), 'utilities', 'bin', binaryName),
    ];

    this.logger.log('  Checking paths:');
    for (const p of possiblePaths) {
      const exists = fs.existsSync(p);
      this.logger.log(`    ${exists ? '✓' : '✗'} ${p}`);
      if (exists) {
        this.logger.log(`  ✓ Using: ${p}`);
        return p;
      }
    }

    this.logger.warn(`  ✗ Whisper binary not found in any location!`);
    return possiblePaths[0];
  }

  /**
   * Get the models directory path
   */
  private getModelsDir(): string {
    this.logger.log('-'.repeat(60));
    this.logger.log('RESOLVING WHISPER MODELS DIRECTORY');

    // Check in utilities/models
    const possiblePaths = [
      // Packaged app paths
      path.join((process as any).resourcesPath || '', 'utilities', 'models'),
      // Development paths - backend runs from backend/ subdir
      // __dirname is backend/dist/media, need to go up 3 to get to backend/, then up 1 more for project root
      path.join(__dirname, '..', '..', '..', 'utilities', 'models'),
      // process.cwd() in dev is backend/, need to go up 1 for project root
      path.join(process.cwd(), '..', 'utilities', 'models'),
      // Also check if cwd is project root (when run directly)
      path.join(process.cwd(), 'utilities', 'models'),
    ];

    this.logger.log('  Checking paths:');
    for (const p of possiblePaths) {
      const exists = fs.existsSync(p);
      this.logger.log(`    ${exists ? '✓' : '✗'} ${p}`);
      if (exists) {
        this.logger.log(`  ✓ Using: ${p}`);
        return p;
      }
    }

    this.logger.warn(`  ✗ Models directory not found in any location!`);
    return possiblePaths[0];
  }

  /**
   * Get the path to a specific Whisper model file
   */
  private getModelPath(modelName: string = WhisperManager.DEFAULT_MODEL): string {
    // Normalize model name (remove 'ggml-' prefix and '.bin' suffix if present)
    let normalizedName = modelName.toLowerCase();
    if (normalizedName.startsWith('ggml-')) {
      normalizedName = normalizedName.substring(5);
    }
    if (normalizedName.endsWith('.bin')) {
      normalizedName = normalizedName.slice(0, -4);
    }

    // Validate model name
    if (!WhisperManager.AVAILABLE_MODELS.includes(normalizedName)) {
      this.logger.warn(`Invalid model name: ${modelName}, falling back to ${WhisperManager.DEFAULT_MODEL}`);
      normalizedName = WhisperManager.DEFAULT_MODEL;
    }

    const modelFile = `ggml-${normalizedName}.bin`;
    const modelPath = path.join(this.modelsDir, modelFile);

    // Check if model exists, fall back to default if not
    if (!fs.existsSync(modelPath)) {
      this.logger.warn(`Model ${modelFile} not found at ${modelPath}`);
      const defaultPath = path.join(this.modelsDir, `ggml-${WhisperManager.DEFAULT_MODEL}.bin`);
      if (fs.existsSync(defaultPath)) {
        this.logger.log(`Falling back to default model: ${WhisperManager.DEFAULT_MODEL}`);
        return defaultPath;
      }
      // Last resort: try tiny
      const tinyPath = path.join(this.modelsDir, 'ggml-tiny.bin');
      if (fs.existsSync(tinyPath)) {
        this.logger.log('Falling back to tiny model');
        return tinyPath;
      }
    }

    return modelPath;
  }

  /**
   * Get list of available models (those that exist on disk)
   */
  getAvailableModels(): string[] {
    const available: string[] = [];
    for (const model of WhisperManager.AVAILABLE_MODELS) {
      const modelPath = path.join(this.modelsDir, `ggml-${model}.bin`);
      if (fs.existsSync(modelPath)) {
        available.push(model);
      }
    }
    return available;
  }

  /**
   * Get environment with ffmpeg in PATH
   */
  private getEnvironment(): NodeJS.ProcessEnv {
    const ffmpegPath = this.sharedConfigService.getFfmpegPath();
    const ffmpegDir = path.dirname(ffmpegPath);
    const whisperDir = path.dirname(this.whisperPath);

    const env = { ...process.env };
    const pathSeparator = process.platform === 'win32' ? ';' : ':';

    env.PATH = `${ffmpegDir}${pathSeparator}${whisperDir}${pathSeparator}${env.PATH || ''}`;

    this.logger.log('-'.repeat(60));
    this.logger.log('ENVIRONMENT SETUP');
    this.logger.log(`  FFmpeg path: ${ffmpegPath}`);
    this.logger.log(`  FFmpeg dir added to PATH: ${ffmpegDir}`);
    this.logger.log(`  Whisper dir added to PATH: ${whisperDir}`);

    return env;
  }

  async transcribe(audioFile: string, outputDir: string, modelName?: string): Promise<string> {
    this.lastReportedPercent = 0;

    // Get the model path for the specified model (or default)
    const modelPath = this.getModelPath(modelName || WhisperManager.DEFAULT_MODEL);
    const actualModelName = path.basename(modelPath, '.bin').replace('ggml-', '');

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
    this.logger.log(`Whisper binary: ${this.whisperPath}`);
    this.logger.log(`Whisper binary exists: ${fs.existsSync(this.whisperPath)}`);
    this.logger.log(`Requested model: ${modelName || 'default'}`);
    this.logger.log(`Using model: ${actualModelName}`);
    this.logger.log(`Model file: ${modelPath}`);
    this.logger.log(`Model file exists: ${fs.existsSync(modelPath)}`);

    if (!audioFile || !fs.existsSync(audioFile)) {
      const error = `Audio file not found: ${audioFile}`;
      this.logger.error(error);
      throw new Error(error);
    }

    if (!fs.existsSync(this.whisperPath)) {
      const error = `whisper.cpp not found at: ${this.whisperPath}. Please reinstall the application or run: npm run download:binaries`;
      this.logger.error(error);
      throw new Error(error);
    }

    if (!fs.existsSync(modelPath)) {
      const error = `Whisper model not found at: ${modelPath}. Please reinstall the application or run: npm run download:binaries`;
      this.logger.error(error);
      throw new Error(error);
    }

    this.aborted = false;
    this.isRunning = true;

    const basename = path.basename(audioFile, path.extname(audioFile));
    const outputBase = path.join(outputDir, basename);
    const srtFile = `${outputBase}.srt`;

    this.logger.log('-'.repeat(60));
    this.logger.log('OUTPUT FILES');
    this.logger.log(`  Base name: ${basename}`);
    this.logger.log(`  Output base: ${outputBase}`);
    this.logger.log(`  Expected SRT: ${srtFile}`);

    // whisper.cpp command line arguments
    const args = [
      '-m', modelPath,
      '-f', audioFile,
      '-osrt',
      '-of', outputBase,
      '-pp',  // Print progress
    ];

    this.logger.log('-'.repeat(60));
    this.logger.log('COMMAND');
    this.logger.log(`  Executable: ${this.whisperPath}`);
    this.logger.log(`  Arguments: ${args.join(' ')}`);
    this.logger.log(`  Full command: "${this.whisperPath}" ${args.map(a => `"${a}"`).join(' ')}`);

    return new Promise<string>((resolve, reject) => {
      const env = this.getEnvironment();

      this.logger.log('-'.repeat(60));
      this.logger.log('SPAWNING PROCESS');
      this.logger.log(`  CWD: ${outputDir}`);

      const startTime = Date.now();

      this.currentProcess = spawn(this.whisperPath, args, {
        env,
        cwd: outputDir
      });

      this.logger.log(`  PID: ${this.currentProcess.pid}`);

      let stdoutBuffer = '';
      let stderrBuffer = '';

      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        this.logger.log(`[STDOUT] ${chunk.trim()}`);
        this.parseProgress(chunk);
      });

      this.currentProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        this.logger.log(`[STDERR] ${chunk.trim()}`);
        this.parseProgress(chunk);
      });

      this.currentProcess.on('close', (code) => {
        this.isRunning = false;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

        this.logger.log('-'.repeat(60));
        this.logger.log('PROCESS COMPLETED');
        this.logger.log(`  Exit code: ${code}`);
        this.logger.log(`  Elapsed time: ${elapsed}s`);
        this.logger.log(`  Was aborted: ${this.aborted}`);

        if (this.aborted) {
          this.logger.warn('Transcription was cancelled by user');
          reject(new Error('Transcription was cancelled'));
          return;
        }

        // Check for output files
        this.logger.log('-'.repeat(60));
        this.logger.log('CHECKING OUTPUT FILES');
        this.logger.log(`  Expected SRT exists: ${fs.existsSync(srtFile)}`);

        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          const srtFiles = files.filter(f => f.endsWith('.srt'));
          this.logger.log(`  SRT files in output dir: ${srtFiles.join(', ') || 'none'}`);
        }

        if (code === 0) {
          if (fs.existsSync(srtFile)) {
            const stats = fs.statSync(srtFile);
            this.logger.log(`  ✓ SRT file created: ${srtFile} (${stats.size} bytes)`);
            this.emit('progress', { percent: 100, task: 'Transcription completed' });
            resolve(srtFile);
          } else {
            // Try to find any SRT file created
            const files = fs.readdirSync(outputDir);
            const srtFiles = files.filter(f => f.endsWith('.srt') && f.startsWith(basename));
            if (srtFiles.length > 0) {
              const foundSrt = path.join(outputDir, srtFiles[0]);
              const stats = fs.statSync(foundSrt);
              this.logger.log(`  ✓ SRT file found: ${foundSrt} (${stats.size} bytes)`);
              this.emit('progress', { percent: 100, task: 'Transcription completed' });
              resolve(foundSrt);
            } else {
              this.logger.error('Transcription completed but no SRT file was created');
              this.logger.error(`STDOUT: ${stdoutBuffer}`);
              this.logger.error(`STDERR: ${stderrBuffer}`);
              reject(new Error('Transcription completed but no SRT file was created'));
            }
          }
        } else {
          this.logger.error(`Transcription failed with exit code ${code}`);
          this.logger.error(`STDOUT: ${stdoutBuffer}`);
          this.logger.error(`STDERR: ${stderrBuffer}`);

          const fullOutput = stdoutBuffer + stderrBuffer;
          if (fullOutput.includes('failed to open') || fullOutput.includes('error opening')) {
            reject(new Error(`Could not open audio file. Ensure the file format is supported.`));
          } else if (fullOutput.includes('model') && fullOutput.includes('failed')) {
            reject(new Error(`Could not load Whisper model. Please reinstall the application.`));
          } else {
            reject(new Error(`Transcription failed (exit code ${code}): ${stderrBuffer.substring(0, 500)}`));
          }
        }
      });

      this.currentProcess.on('error', (err) => {
        this.isRunning = false;
        this.logger.error('-'.repeat(60));
        this.logger.error('PROCESS ERROR');
        this.logger.error(`  Error: ${err.message}`);
        this.logger.error(`  Whisper path: ${this.whisperPath}`);
        this.logger.error(`  Whisper exists: ${fs.existsSync(this.whisperPath)}`);
        reject(new Error(`Failed to start whisper.cpp: ${err.message}. Please reinstall the application.`));
      });

      this.emit('progress', { percent: 5, task: 'Starting transcription' });
      this.logger.log('Process spawned, waiting for output...');
    });
  }

  /**
   * Parse progress from whisper.cpp output
   */
  private parseProgress(output: string): void {
    // whisper.cpp with -pp outputs: "progress = XX%"
    const progressMatch = output.match(/progress\s*=\s*(\d+)%/i);
    if (progressMatch) {
      const percent = Math.min(95, parseInt(progressMatch[1], 10));
      if (percent > this.lastReportedPercent) {
        this.lastReportedPercent = percent;
        this.emit('progress', { percent, task: this.getCurrentTask(percent) });
      }
      return;
    }

    // Simple percentage pattern
    const simpleMatch = output.match(/(\d+)%/);
    if (simpleMatch) {
      const percent = Math.min(95, parseInt(simpleMatch[1], 10));
      if (percent > this.lastReportedPercent + 5) {
        this.lastReportedPercent = percent;
        this.emit('progress', { percent, task: this.getCurrentTask(percent) });
      }
    }

    // Loading messages
    if (output.includes('loading model') || output.includes('whisper_init')) {
      if (this.lastReportedPercent < 10) {
        this.emit('progress', { percent: 10, task: 'Loading Whisper model' });
        this.lastReportedPercent = 10;
      }
    } else if (output.includes('processing') || output.includes('run_whisper')) {
      if (this.lastReportedPercent < 20) {
        this.emit('progress', { percent: 20, task: 'Processing audio' });
        this.lastReportedPercent = 20;
      }
    }
  }

  private getCurrentTask(percent: number): string {
    if (percent < 10) return 'Initializing';
    if (percent < 20) return 'Loading model';
    if (percent < 30) return 'Detecting language';
    if (percent < 50) return 'Processing audio';
    if (percent < 70) return 'Generating transcript';
    if (percent < 90) return 'Processing segments';
    return 'Finalizing transcript';
  }

  cancel(): void {
    if (this.currentProcess && this.isRunning) {
      this.logger.log('='.repeat(60));
      this.logger.log('CANCELLING TRANSCRIPTION');
      this.logger.log(`  PID: ${this.currentProcess.pid}`);
      this.aborted = true;

      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        try {
          execSync(`taskkill /pid ${this.currentProcess.pid} /T /F`, { stdio: 'ignore' });
          this.logger.log('  Killed via taskkill');
        } catch (err) {
          this.logger.warn('  taskkill failed (process may have already exited)');
        }
      } else {
        this.currentProcess.kill('SIGTERM');
        this.logger.log('  Sent SIGTERM');
      }

      this.isRunning = false;
      this.logger.log('='.repeat(60));
    }
  }
}
