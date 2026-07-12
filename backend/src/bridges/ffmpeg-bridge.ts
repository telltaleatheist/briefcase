/**
 * FFmpeg Bridge - Process wrapper for FFmpeg binary
 * Supports multiple concurrent processes with individualized feedback
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';

export interface FfmpegProgress {
  processId: string;
  percent: number;
  time: string;
  speed?: string;
  fps?: number;
  bitrate?: string;
  size?: string;
}

export interface FfmpegProcessInfo {
  id: string;
  process: ChildProcess;
  args: string[];
  startTime: number;
  duration?: number;
  aborted: boolean;
}

export interface FfmpegResult {
  processId: string;
  success: boolean;
  exitCode: number | null;
  duration: number;
  error?: string;
}

export class FfmpegBridge extends EventEmitter {
  private binaryPath: string;
  private activeProcesses = new Map<string, FfmpegProcessInfo>();
  private readonly logger = new Logger(FfmpegBridge.name);

  constructor(ffmpegPath: string) {
    super();
    this.binaryPath = ffmpegPath;
    this.logger.log(`Initialized with binary: ${ffmpegPath}`);
  }

  /**
   * Get the binary path
   */
  get path(): string {
    return this.binaryPath;
  }

  /**
   * Run FFmpeg with given arguments
   * Returns a process ID for tracking
   */
  run(
    args: string[],
    options?: {
      duration?: number;  // Total duration in seconds for progress calculation
      processId?: string; // Custom process ID, auto-generated if not provided
    }
  ): Promise<FfmpegResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    return new Promise((resolve, reject) => {
      this.logger.log(`[${processId}] Starting: ffmpeg ${args.join(' ')}`);

      const proc = spawn(this.binaryPath, args);
      const startTime = Date.now();

      const processInfo: FfmpegProcessInfo = {
        id: processId,
        process: proc,
        args,
        startTime,
        duration: options?.duration,
        aborted: false,
      };

      this.activeProcesses.set(processId, processInfo);

      let stderrBuffer = '';

      proc.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrBuffer += text;

        // Parse progress if we have duration info
        if (options?.duration) {
          const progress = this.parseProgress(text, processId, options.duration);
          if (progress) {
            this.emit('progress', progress);
          }
        }
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
            error: 'Process was aborted',
          });
          return;
        }

        if (code === 0) {
          this.logger.log(`[${processId}] Completed successfully in ${duration}ms`);
          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
          });
        } else {
          this.logger.error(`[${processId}] Failed with code ${code}`);
          this.logger.error(`[${processId}] stderr: ${stderrBuffer.slice(-500)}`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: `FFmpeg exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        this.logger.error(`[${processId}] Spawn error: ${err.message}`);

        // Check for architecture mismatch
        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`FFmpeg binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`FFmpeg binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Run FFmpeg and pipe stdout (for extracting raw audio data)
   */
  runWithPipe(
    args: string[],
    onData: (chunk: Buffer) => void,
    options?: {
      processId?: string;
    }
  ): Promise<FfmpegResult> {
    const processId = options?.processId || crypto.randomBytes(8).toString('hex');

    return new Promise((resolve, reject) => {
      this.logger.log(`[${processId}] Starting with pipe: ffmpeg ${args.join(' ')}`);

      const proc = spawn(this.binaryPath, args);
      const startTime = Date.now();

      const processInfo: FfmpegProcessInfo = {
        id: processId,
        process: proc,
        args,
        startTime,
        aborted: false,
      };

      this.activeProcesses.set(processId, processInfo);

      let stderrBuffer = '';

      proc.stdout?.on('data', onData);

      proc.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on('close', (code) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        if (processInfo.aborted) {
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: 'Process was aborted',
          });
          return;
        }

        if (code === 0) {
          resolve({
            processId,
            success: true,
            exitCode: code,
            duration,
          });
        } else {
          this.logger.error(`[${processId}] Pipe failed with code ${code}`);
          resolve({
            processId,
            success: false,
            exitCode: code,
            duration,
            error: `FFmpeg exited with code ${code}`,
          });
        }
      });

      proc.on('error', (err) => {
        const duration = Date.now() - startTime;
        this.activeProcesses.delete(processId);

        if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          reject(new Error(`FFmpeg binary has wrong architecture for this system (${process.arch})`));
        } else if (err.message.includes('ENOENT')) {
          reject(new Error(`FFmpeg binary not found at: ${this.binaryPath}`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Extract audio from video file
   */
  async extractAudio(
    inputPath: string,
    outputPath: string,
    options?: {
      sampleRate?: number;
      channels?: number;
      format?: string;
      processId?: string;
      duration?: number;
      normalize?: boolean;  // Normalize audio levels for better transcription
      startOffset?: number; // Skip first N seconds of the input
    }
  ): Promise<FfmpegResult> {
    const args = ['-y'];

    // Add start offset if specified (must come before -i)
    if (options?.startOffset && options.startOffset > 0) {
      args.push('-ss', String(options.startOffset));
    }

    args.push('-i', inputPath, '-vn');

    // Add normalization filter if requested
    // This helps with videos that have very quiet audio at the start
    if (options?.normalize) {
      args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    }

    args.push(
      '-acodec', 'pcm_s16le',
      '-ar', String(options?.sampleRate || 16000),
      '-ac', String(options?.channels || 1),
      '-f', options?.format || 'wav',
      outputPath,
    );

    return this.run(args, {
      processId: options?.processId,
      duration: options?.duration,
    });
  }

  /**
   * Quick volume check on a portion of a file
   * Returns mean and max volume in dB
   */
  async getVolumeLevel(
    inputPath: string,
    startSeconds: number = 0,
    durationSeconds: number = 10,
    callerProcessId?: string
  ): Promise<{ mean: number; max: number }> {
    // A caller may pass a deterministic id (e.g. volumedetect-<jobId>) so it can
    // abort()/abortAll() this probe on cancel; otherwise keep the random id.
    const processId = callerProcessId ?? `volumedetect-${crypto.randomBytes(6).toString('hex')}`;
    const args = [
      '-ss', String(startSeconds),
      '-t', String(durationSeconds),
      '-i', inputPath,
      '-af', 'volumedetect',
      '-f', 'null',
      '-',
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, args);

      // Register so abort()/abortAll() can reach this probe; otherwise it
      // orphans until it finishes on its own.
      const processInfo: FfmpegProcessInfo = {
        id: processId,
        process: proc,
        args,
        startTime: Date.now(),
        aborted: false,
      };
      this.activeProcesses.set(processId, processInfo);

      let stderrBuffer = '';

      proc.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on('close', (code) => {
        this.activeProcesses.delete(processId);

        if (processInfo.aborted) {
          reject(new Error('Volume detection was aborted'));
          return;
        }

        // Parse: mean_volume: -41.1 dB, max_volume: -15.9 dB
        const meanMatch = stderrBuffer.match(/mean_volume:\s*([-\d.]+)\s*dB/);
        const maxMatch = stderrBuffer.match(/max_volume:\s*([-\d.]+)\s*dB/);

        // NO SILENT FALLBACK: a fabricated -100 dB reads as genuinely-silent
        // audio and triggers a needless full silence scan. Fail loudly instead.
        if (!meanMatch || !maxMatch) {
          reject(new Error(`Volume detection produced no volumedetect output (exit ${code}): ${stderrBuffer.slice(-300)}`));
          return;
        }

        resolve({ mean: parseFloat(meanMatch[1]), max: parseFloat(maxMatch[1]) });
      });

      proc.on('error', (err) => {
        this.activeProcesses.delete(processId);
        reject(err);
      });
    });
  }

  /**
   * Detect when meaningful audio starts in a file
   * Uses silencedetect filter to find the end of initial silence
   * Returns the timestamp in seconds where audio becomes audible, or 0 if no silence detected
   */
  async detectAudioStart(
    inputPath: string,
    options?: {
      silenceThreshold?: number;  // dB threshold (default -45)
      minSilenceDuration?: number; // Minimum silence duration in seconds (default 1)
      maxSearchDuration?: number;  // How far into the file to search (default 600 = 10 min)
      processId?: string;          // Caller-provided id so this probe can be aborted on cancel
    }
  ): Promise<number> {
    const threshold = options?.silenceThreshold ?? -45;
    const minDuration = options?.minSilenceDuration ?? 1;
    const maxSearch = options?.maxSearchDuration ?? 600;
    // A caller may pass a deterministic id (e.g. silencedetect-<jobId>) so it can
    // abort()/abortAll() this probe on cancel; otherwise keep the random id.
    const processId = options?.processId ?? `silencedetect-${crypto.randomBytes(6).toString('hex')}`;

    return new Promise((resolve, reject) => {
      const args = [
        '-i', inputPath,
        '-t', String(maxSearch),
        '-af', `silencedetect=noise=${threshold}dB:d=${minDuration}`,
        '-f', 'null',
        '-',
      ];

      const proc = spawn(this.binaryPath, args);

      // Register so abort()/abortAll() can reach this probe; otherwise it
      // orphans until it finishes on its own.
      const processInfo: FfmpegProcessInfo = {
        id: processId,
        process: proc,
        args,
        startTime: Date.now(),
        aborted: false,
      };
      this.activeProcesses.set(processId, processInfo);

      let stderrBuffer = '';

      proc.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on('close', (code) => {
        this.activeProcesses.delete(processId);

        if (processInfo.aborted) {
          reject(new Error('Silence detection was aborted'));
          return;
        }

        // NO SILENT FALLBACK: a real ffmpeg failure must not be reported as
        // "0s of leading silence" (a legitimate success value). Fail loudly.
        if (code !== 0) {
          reject(new Error(`Silence detection failed (exit ${code}): ${stderrBuffer.slice(-300)}`));
          return;
        }

        // silencedetect emits paired markers, e.g.:
        //   [silencedetect @ ...] silence_start: 0
        //   [silencedetect @ ...] silence_end: 45.2 | silence_duration: 45.2
        // We must pair each start with its end so we only skip silence that
        // actually LEADS the clip. Picking the longest silence anywhere would
        // start extraction mid-clip and drop real speech before it.
        const eventMatches = [...stderrBuffer.matchAll(/silence_start:\s*(-?[\d.]+)|silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];

        const silences: { start: number; end: number; duration: number }[] = [];
        let pendingStart: number | null = null;
        for (const match of eventMatches) {
          if (match[1] !== undefined) {
            pendingStart = parseFloat(match[1]);
          } else if (pendingStart !== null) {
            silences.push({ start: pendingStart, end: parseFloat(match[2]), duration: parseFloat(match[3]) });
            pendingStart = null;
          }
        }

        // A silence is "leading" only if it starts at (or very near) the
        // beginning of the clip and lasts past the significant-silence
        // threshold. If several qualify, prefer the earliest-starting one.
        let leading = { start: Infinity, end: 0, duration: 0 };
        for (const silence of silences) {
          if (silence.start < 1.0 && silence.duration > 30 && silence.start < leading.start) {
            leading = silence;
          }
        }

        if (leading.end > 0) {
          this.logger.log(`Detected ${leading.duration.toFixed(1)}s of leading silence ending at ${leading.end.toFixed(1)}s`);
          resolve(leading.end);
        } else {
          // No leading silence; audio starts immediately.
          this.logger.log(`No significant silence detected at start`);
          resolve(0);
        }
      });

      proc.on('error', (err) => {
        this.activeProcesses.delete(processId);
        this.logger.warn(`Silence detection failed: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Abort a running process
   */
  abort(processId: string): boolean {
    const processInfo = this.activeProcesses.get(processId);
    if (!processInfo) {
      this.logger.warn(`Cannot abort ${processId}: not found`);
      return false;
    }

    this.logger.log(`[${processId}] Aborting process`);
    processInfo.aborted = true;

    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        execSync(`taskkill /pid ${processInfo.process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        processInfo.process.kill('SIGKILL');
      }
    } else {
      const proc = processInfo.process;
      proc.kill('SIGTERM');
      // Escalate to SIGKILL if the process hasn't exited shortly after SIGTERM.
      // The 'close' handler removes it from activeProcesses on exit, so a still
      // present entry means it's hung.
      setTimeout(() => {
        if (this.activeProcesses.has(processId)) {
          this.logger.warn(`[${processId}] Still running after SIGTERM; sending SIGKILL`);
          try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        }
      }, 5000).unref();
    }

    return true;
  }

  /**
   * Abort all running processes
   */
  abortAll(): void {
    this.logger.log(`Aborting all ${this.activeProcesses.size} processes`);
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
   * Check if a process is running
   */
  isRunning(processId: string): boolean {
    return this.activeProcesses.has(processId);
  }

  /**
   * Parse FFmpeg progress from stderr
   */
  private parseProgress(text: string, processId: string, totalDuration: number): FfmpegProgress | null {
    // FFmpeg outputs progress like: frame=  123 fps= 25 q=28.0 size=    1234kB time=00:00:05.12 bitrate= 1976.5kbits/s speed=1.02x
    const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
    if (!timeMatch) return null;

    const timeStr = timeMatch[1];
    const timeParts = timeStr.split(/[:.]/);
    if (timeParts.length < 4) return null;

    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);
    const seconds = parseInt(timeParts[2]);
    const centiseconds = parseInt(timeParts[3]);

    const currentTime = hours * 3600 + minutes * 60 + seconds + (centiseconds / 100);
    const percent = Math.min(Math.round((currentTime / totalDuration) * 100), 100);

    const progress: FfmpegProgress = {
      processId,
      percent,
      time: timeStr,
    };

    // Parse optional fields
    const speedMatch = text.match(/speed=\s*(\d+\.?\d*)x/);
    if (speedMatch) progress.speed = speedMatch[1];

    const fpsMatch = text.match(/fps=\s*(\d+)/);
    if (fpsMatch) progress.fps = parseInt(fpsMatch[1]);

    const bitrateMatch = text.match(/bitrate=\s*([^\s]+)/);
    if (bitrateMatch) progress.bitrate = bitrateMatch[1];

    const sizeMatch = text.match(/size=\s*([^\s]+)/);
    if (sizeMatch) progress.size = sizeMatch[1];

    return progress;
  }
}
