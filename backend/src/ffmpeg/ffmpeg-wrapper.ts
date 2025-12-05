// Lightweight wrapper for FFmpeg/FFprobe binary calls
import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface FfprobeResult {
  streams: any[];
  format: any;
}

export interface FfmpegProgress {
  percent: number;
  time: string;
  speed?: string;
}

export class FfmpegWrapper extends EventEmitter {
  constructor(
    private ffmpegPath: string,
    private ffprobePath: string
  ) {
    super();
  }

  /**
   * Run ffprobe and return parsed JSON metadata
   */
  probe(filePath: string): Promise<FfprobeResult> {
    return new Promise((resolve, reject) => {
      const args = [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ];

      const proc = spawn(this.ffprobePath, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Run ffmpeg with arguments, with optional progress tracking
   */
  run(
    args: string[],
    options?: {
      duration?: number;
      onProgress?: (progress: FfmpegProgress) => void;
    }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args);
      let stderrBuffer = '';

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrBuffer += text;

        if (options?.onProgress && options.duration) {
          const lines = stderrBuffer.split('\r');
          stderrBuffer = lines.pop() || '';

          for (const line of lines) {
            const progress = this.parseProgress(line, options.duration);
            if (progress) {
              options.onProgress(progress);
            }
          }
        }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        resolve();
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Run ffmpeg and pipe stdout (for extracting raw audio data)
   */
  runWithPipe(
    args: string[],
    onData: (chunk: Buffer) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args);

      proc.stdout.on('data', onData);

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        resolve();
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Parse FFmpeg progress from stderr line
   */
  private parseProgress(line: string, totalDuration: number): FfmpegProgress | null {
    const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
    const speedMatch = line.match(/speed=\s*(\d+\.?\d*)x/);

    if (!timeMatch) return null;

    const timeStr = timeMatch[1];
    const timeParts = timeStr.split(/[:.]/);

    if (timeParts.length < 3) return null;

    const hours = parseInt(timeParts[0]);
    const minutes = parseInt(timeParts[1]);
    const seconds = parseInt(timeParts[2]);
    const millis = timeParts.length > 3 ? parseInt(timeParts[3]) : 0;

    const currentTime = hours * 3600 + minutes * 60 + seconds + (millis / 100);
    const percent = Math.min(Math.round((currentTime / totalDuration) * 100), 100);

    return {
      percent,
      time: timeStr,
      speed: speedMatch ? speedMatch[1] : undefined
    };
  }

  get ffmpeg(): string {
    return this.ffmpegPath;
  }

  get ffprobe(): string {
    return this.ffprobePath;
  }
}
