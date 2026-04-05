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
  private chunkedMode = false;
  private chunkIndex = 0;
  private totalChunks = 0;
  private cancelled = false;

  static readonly CHUNK_THRESHOLD_S = 1800;  // Chunk files longer than 30 minutes
  static readonly CHUNK_DURATION_S = 1800;   // 30-minute chunks

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
    // In chunked mode, remap per-chunk progress to overall progress
    this.whisper.on('progress', (progress: BridgeProgress) => {
      let percent = progress.percent;
      let task = progress.message;

      if (this.chunkedMode && this.totalChunks > 0) {
        percent = Math.round((this.chunkIndex * 100 + progress.percent) / this.totalChunks);
        task = `[${this.chunkIndex + 1}/${this.totalChunks}] ${progress.message}`;
      }

      this.emit('progress', { percent, task } as WhisperProgress);
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
   * @param audioFile - Path to the audio file
   * @param outputDir - Directory for output files
   * @param modelName - Whisper model to use (optional)
   * @param audioDurationSeconds - Duration of audio in seconds for progress estimation (optional)
   */
  async transcribe(audioFile: string, outputDir: string, modelName?: string, audioDurationSeconds?: number): Promise<string> {
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
    this.logger.log(`Audio duration: ${audioDurationSeconds ? `${audioDurationSeconds}s` : 'unknown'}`);

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

    // Use chunked transcription for long files to avoid whisper hallucination/looping
    if (audioDurationSeconds && audioDurationSeconds > WhisperManager.CHUNK_THRESHOLD_S) {
      this.logger.log(`Audio exceeds ${WhisperManager.CHUNK_THRESHOLD_S}s threshold, using chunked transcription`);
      return this.transcribeChunked(audioFile, outputDir, modelName, audioDurationSeconds);
    }

    // Generate a process ID for tracking
    const processId = `transcribe-${Date.now()}`;
    this.currentProcessId = processId;

    this.emit('progress', { percent: 5, task: 'Starting transcription' });

    try {
      const result = await this.whisper.transcribe(audioFile, outputDir, {
        model: modelName,
        processId,
        audioDurationSeconds,
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
   * Transcribe a long audio file in 1-hour chunks.
   * Runs whisper multiple times on the same file using --offset-t and --duration flags,
   * then combines the SRT outputs into a single transcript.
   */
  private async transcribeChunked(
    audioFile: string,
    outputDir: string,
    modelName: string | undefined,
    audioDurationSeconds: number,
  ): Promise<string> {
    const chunkDurationS = WhisperManager.CHUNK_DURATION_S;
    const totalChunks = Math.ceil(audioDurationSeconds / chunkDurationS);

    this.chunkedMode = true;
    this.totalChunks = totalChunks;
    this.cancelled = false;

    this.logger.log(`Chunked transcription: ${totalChunks} chunks of ${chunkDurationS}s each`);
    this.emit('progress', { percent: 0, task: `Starting chunked transcription (${totalChunks} chunks)` } as WhisperProgress);

    const srtPaths: string[] = [];

    try {
      for (let i = 0; i < totalChunks; i++) {
        if (this.cancelled) {
          throw new Error('Transcription was cancelled');
        }

        this.chunkIndex = i;
        const offsetMs = i * chunkDurationS * 1000;
        const remainingS = audioDurationSeconds - (i * chunkDurationS);
        const chunkS = Math.min(chunkDurationS, remainingS);
        const durationMs = chunkS * 1000;

        const processId = `transcribe-chunk${i}-${Date.now()}`;
        this.currentProcessId = processId;

        this.logger.log(`Chunk ${i + 1}/${totalChunks}: offset=${offsetMs}ms, duration=${durationMs}ms`);

        const result = await this.whisper.transcribe(audioFile, outputDir, {
          model: modelName,
          processId,
          audioDurationSeconds: chunkS,
          offsetMs,
          durationMs,
          outputSuffix: `_chunk${i}`,
        });

        if (!result.success) {
          if (result.error?.includes('aborted')) {
            throw new Error('Transcription was cancelled');
          }
          throw new Error(result.error || `Chunk ${i + 1} transcription failed`);
        }

        if (result.srtPath && fs.existsSync(result.srtPath)) {
          srtPaths.push(result.srtPath);
          this.logger.log(`Chunk ${i + 1}/${totalChunks} completed: ${result.srtPath}`);
        } else {
          this.logger.warn(`Chunk ${i + 1}/${totalChunks} produced no SRT file, skipping`);
        }
      }

      if (srtPaths.length === 0) {
        throw new Error('Chunked transcription produced no SRT files');
      }

      // Combine all chunk SRTs into one
      const basename = path.basename(audioFile, path.extname(audioFile));
      const combinedSrtPath = path.join(outputDir, `${basename}.srt`);
      this.combineSrtFiles(srtPaths, combinedSrtPath);

      // Clean up individual chunk SRT files
      for (const srtPath of srtPaths) {
        try { fs.unlinkSync(srtPath); } catch { /* ignore */ }
      }

      this.logger.log(`Chunked transcription completed: ${combinedSrtPath}`);
      this.emit('progress', { percent: 100, task: 'Transcription completed' } as WhisperProgress);
      return combinedSrtPath;

    } finally {
      this.chunkedMode = false;
      this.chunkIndex = 0;
      this.totalChunks = 0;
      this.currentProcessId = null;
    }
  }

  /**
   * Combine multiple SRT files into one with sequential numbering.
   * Assumes timestamps are absolute (whisper --offset-t produces absolute timestamps).
   */
  private combineSrtFiles(srtPaths: string[], outputPath: string): void {
    const allSegments: string[] = [];
    let segmentIndex = 1;

    for (const srtPath of srtPaths) {
      const content = fs.readFileSync(srtPath, 'utf-8').trim();
      if (!content) continue;

      // SRT blocks are separated by blank lines
      const blocks = content.split(/\n\n+/);

      for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;

        // Find the timestamp line (contains "-->")
        const timestampLine = lines.find(l => l.includes('-->'));
        if (!timestampLine) continue;

        const textStartIdx = lines.indexOf(timestampLine) + 1;
        const textLines = lines.slice(textStartIdx);
        if (textLines.length === 0) continue;

        allSegments.push(`${segmentIndex}\n${timestampLine}\n${textLines.join('\n')}`);
        segmentIndex++;
      }
    }

    fs.writeFileSync(outputPath, allSegments.join('\n\n') + '\n');
    this.logger.log(`Combined ${segmentIndex - 1} segments from ${srtPaths.length} chunk(s) into ${outputPath}`);
  }

  /**
   * Cancel the current transcription
   */
  cancel(): void {
    this.cancelled = true; // Stops chunked transcription between chunks
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
