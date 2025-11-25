// backend/src/media/whisper-manager.ts - Update to use correct command line args

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { spawn, ChildProcess, exec } from 'child_process';
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
  private whisperPath: string;
  private whisperVersion: string = 'unknown';
  private progressCounter = 0;
  private startTime: number = 0;
  private audioDuration: number = 0;
  private lastReportedPercent = 0;

  constructor(private readonly sharedConfigService: SharedConfigService) {
    super();
    this.whisperPath = this.sharedConfigService.getWhisperPath();
    this.logger.log(`Using whisper binary at: ${this.whisperPath}`);
    this.detectWhisperVersion();
  }

  /**
   * Get environment with ffmpeg in PATH
   * The Whisper Python library needs ffmpeg to be available in PATH
   */
  private getEnvironmentWithFfmpeg(): NodeJS.ProcessEnv {
    const ffmpegPath = this.sharedConfigService.getFfmpegPath();
    const ffmpegDir = path.dirname(ffmpegPath);

    // Add ffmpeg directory to PATH
    const env = { ...process.env };
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    env.PATH = `${ffmpegDir}${pathSeparator}${env.PATH || ''}`;

    this.logger.log(`Added ffmpeg directory to PATH: ${ffmpegDir}`);
    return env;
  }

  // Detect whisper command line format by running help
  private async detectWhisperVersion(): Promise<void> {
    // Skip version detection on Windows to avoid Unicode encoding errors
    // The --help command contains Unicode characters that cause issues with Windows console encoding
    if (process.platform === 'win32') {
      this.logger.log('Skipping whisper version detection on Windows (using default arguments)');
      this.whisperVersion = 'openai-whisper'; // Assume standard OpenAI whisper
      return;
    }

    try {
      exec(`"${this.whisperPath}" --help`, (error, stdout, stderr) => {
        if (error) {
          this.logger.warn(`Error checking whisper version: ${(error as Error).message}`);
          return;
        }

        // Store output for later reference
        this.whisperVersion = stdout + stderr;

        this.logger.log('Detected whisper help information');
      });
    } catch (error) {
      this.logger.warn(`Failed to detect whisper version: ${error}`);
    }
  }

  // Determine the correct arguments based on help output
  private getCommandLineArgs(audioFile: string, outputDir: string): string[] {
    // Default arguments for the most common whisper.cpp version
    let args = [
      '--model', 'tiny',
      '--output_format', 'srt',
      '--output_dir', outputDir,
      audioFile
    ];

    // Alternative format for some versions
    if (this.whisperVersion.includes('--output-format') || 
        this.whisperVersion.includes('--output-dir')) {
      args = [
        '--model', 'tiny',
        '--output-format', 'srt',
        '--output-dir', outputDir,
        audioFile
      ];
    }

    // For OpenAI's version which uses different format
    if (this.whisperVersion.includes('temperature_increment_on_fallback')) {
      args = [
        '--model', 'tiny',
        '--output_format', 'srt',
        '--output_dir', outputDir,
        audioFile
      ];
    }

    // Last resort - try simplest version with one argument
    if (this.whisperVersion.includes('error: unrecognized arguments')) {
      args = [
        '--model', 'tiny',
        audioFile
      ];
      
      // If output directory is not current directory, we need to cd there first
      const currentDir = process.cwd();
      if (currentDir !== outputDir) {
        process.chdir(outputDir);
      }
    }

    this.logger.log(`Using whisper arguments: ${args.join(' ')}`);
    return args;
  }

  async transcribe(audioFile: string, outputDir: string): Promise<string> {
    this.progressCounter = 0;
    this.lastReportedPercent = 0;
    this.startTime = Date.now();

    console.log('Starting Whisper transcription with extensive logging');
    console.log('Audio file:', audioFile);
    console.log('Output directory:', outputDir);

    if (!audioFile || !fs.existsSync(audioFile)) {
      throw new Error(`Audio file not found: ${audioFile}`);
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
    }, 1000); // Update every second

    // Create output filename for SRT
    const basename = path.basename(audioFile, path.extname(audioFile));
    const srtFile = path.join(outputDir, `${basename}.srt`);

    // Get the appropriate arguments for this whisper version
    const args = this.getCommandLineArgs(audioFile, outputDir);

    this.logger.log(`Starting Whisper transcription: ${this.whisperPath} ${args.join(' ')}`);

    return new Promise<string>((resolve, reject) => {
      // Get environment with ffmpeg in PATH so Whisper can find it
      const env = this.getEnvironmentWithFfmpeg();
      this.currentProcess = spawn(this.whisperPath, args, { env });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        this.logger.log(`[WHISPER STDOUT] ${chunk.trim()}`);
        this.parseProgress(chunk);
      });

      this.currentProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        this.logger.log(`[WHISPER STDERR] ${chunk.trim()}`);
        this.parseProgress(chunk);
      });

      this.currentProcess.on('close', (code) => {
        this.isRunning = false;
        clearInterval(progressInterval);

        this.logger.log(`Whisper process exited with code ${code}`);
        this.logger.log(`Full stdout: ${stdoutBuffer.substring(0, 500)}`);
        this.logger.log(`Full stderr: ${stderrBuffer.substring(0, 500)}`);

        if (this.aborted) {
          reject(new Error('Transcription was cancelled'));
          return;
        }

        if (code === 0) {
          // Check if SRT file was created using the expected naming convention
          if (fs.existsSync(srtFile)) {
            this.emit('progress', { percent: 100, task: 'Transcription completed' });
            resolve(srtFile);
          } else {
            // Try to find any SRT file in the output directory
            try {
              this.logger.log(`Expected SRT file not found: ${srtFile}`);
              this.logger.log(`Searching in output directory: ${outputDir}`);

              // Verify output directory exists
              if (!fs.existsSync(outputDir)) {
                reject(new Error(`Output directory does not exist: ${outputDir}`));
                return;
              }

              const files = fs.readdirSync(outputDir);
              this.logger.log(`Found ${files.length} files in output directory`);

              const srtFiles = files.filter(file =>
                file.startsWith(basename) && file.endsWith('.srt')
              );

              if (srtFiles.length > 0) {
                const foundSrtFile = path.join(outputDir, srtFiles[0]);
                this.logger.log(`Found SRT file with different name: ${foundSrtFile}`);
                resolve(foundSrtFile);
              } else {
                // If still not found, check for .txt file and convert it
                const txtFiles = files.filter(file =>
                  file.startsWith(basename) && file.endsWith('.txt')
                );

                if (txtFiles.length > 0) {
                  const txtFile = path.join(outputDir, txtFiles[0]);
                  this.logger.log(`Found TXT file, converting to SRT: ${txtFile}`);
                  const convertedSrtFile = this.convertTxtToSrt(txtFile, srtFile);
                  if (convertedSrtFile) {
                    resolve(convertedSrtFile);
                  } else {
                    reject(new Error('Transcription completed but SRT file could not be created'));
                  }
                } else {
                  // Log all files found for debugging
                  this.logger.error(`No matching output files found. All files in directory: ${files.join(', ')}`);
                  this.logger.error(`Looking for files starting with: ${basename}`);
                  reject(new Error(`Transcription completed but no output file found. Expected: ${srtFile}, Basename: ${basename}`));
                }
              }
            } catch (error) {
              this.logger.error(`Error reading output directory: ${(error as Error).message}`);
              reject(new Error(`Failed to read output directory ${outputDir}: ${(error as Error).message}`));
            }
          }
        } else {
          // If we failed with the initial arguments, try without output format options
          if (args.includes('--output_format') || args.includes('--output-format')) {
            this.logger.log('Trying simplified whisper command...');
            // Try without the problematic arguments
            const simpleArgs = [
              '--model', 'tiny',
              audioFile
            ];
            
            this.emit('progress', { percent: 10, task: 'Retrying with simpler command...' });

            // Execute whisper with simplified arguments
            const env = this.getEnvironmentWithFfmpeg();
            const simpleProcess = spawn(this.whisperPath, simpleArgs, { cwd: outputDir, env });

            let simpleStdoutBuffer = '';
            let simpleStderrBuffer = '';

            // Handle spawn errors (e.g., ENOENT when whisper not found)
            simpleProcess.on('error', (err) => {
              this.isRunning = false;
              this.logger.error(`Failed to spawn whisper retry process: ${err.message}`);
              reject(new Error(`Failed to start Whisper retry: ${err.message}`));
            });

            simpleProcess.stdout.on('data', (data) => {
              simpleStdoutBuffer += data.toString();
              this.parseProgress(data.toString());
            });

            simpleProcess.stderr.on('data', (data) => {
              simpleStderrBuffer += data.toString();
              this.parseProgress(data.toString());
            });

            simpleProcess.on('close', (simpleCode) => {
              if (simpleCode === 0) {
                // Look for any SRT or TXT file created
                const files = fs.readdirSync(outputDir);
                const possibleOutputs = files.filter(file => 
                  (file.startsWith(basename) && (file.endsWith('.srt') || file.endsWith('.txt'))) ||
                  file.endsWith('.srt') || 
                  (file.startsWith('subtitles') && file.endsWith('.srt'))
                );
                
                if (possibleOutputs.length > 0) {
                  const outputFile = path.join(outputDir, possibleOutputs[0]);
                  this.logger.log(`Found output file with retry: ${outputFile}`);
                  
                  // If it's a TXT file, convert to SRT
                  if (outputFile.endsWith('.txt')) {
                    const convertedFile = this.convertTxtToSrt(outputFile, srtFile);
                    if (convertedFile) {
                      resolve(convertedFile);
                    } else {
                      reject(new Error('Could not convert TXT to SRT'));
                    }
                  } else {
                    resolve(outputFile);
                  }
                } else {
                  reject(new Error('Retry succeeded but no output file found'));
                }
              } else {
                reject(new Error(`Whisper retry failed with code ${simpleCode}: ${simpleStderrBuffer}`));
              }
            });
            
            return;
          }
          
          reject(new Error(`Whisper exited with code ${code}: ${stderrBuffer}`));
        }
      });

      this.currentProcess.on('error', (err) => {
        this.isRunning = false;
        clearInterval(progressInterval);
        this.logger.error(`Failed to spawn whisper process: ${err.message}`);
        this.logger.error(`Whisper path: ${this.whisperPath}`);
        this.logger.error(`Whisper exists: ${fs.existsSync(this.whisperPath)}`);
        reject(new Error(`Failed to start Whisper: ${err.message}`));
      });
    });
  }

  // Convert text file to SRT format
  private convertTxtToSrt(txtFile: string, outputFile: string): string | null {
    try {
      if (!fs.existsSync(txtFile)) {
        return null;
      }
      
      const content = fs.readFileSync(txtFile, 'utf8');
      const lines = content.split('\n').filter(line => line.trim().length > 0);
      
      let srtContent = '';
      let index = 1;
      
      // Simple conversion - one line per subtitle
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        
        // Estimated timing - 5 seconds per line
        const startTime = i * 5;
        const endTime = (i + 1) * 5;
        
        srtContent += `${index}\n`;
        srtContent += `00:00:${this.formatTime(startTime)},000 --> 00:00:${this.formatTime(endTime)},000\n`;
        srtContent += `${line}\n\n`;
        
        index++;
      }
      
      fs.writeFileSync(outputFile, srtContent);
      return outputFile;
    } catch (error) {
      this.logger.error(`Error converting TXT to SRT: ${error}`);
      return null;
    }
  }
  
  private formatTime(seconds: number): string {
    return seconds < 10 ? `0${seconds}` : `${seconds}`;
  }

  /**
   * Get audio duration using ffprobe
   */
  private async getAudioDuration(audioFile: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobePath = this.sharedConfigService.getFfprobePath();
      exec(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`, (error, stdout) => {
        if (error) {
          this.logger.warn(`Could not get audio duration: ${error.message}`);
          resolve(180); // Default to 3 minutes if we can't detect
          return;
        }
        const duration = parseFloat(stdout.trim());
        resolve(isNaN(duration) ? 180 : duration);
      });
    });
  }

  /**
   * Update progress based on elapsed time vs audio duration
   * Whisper typically processes at 10-20x realtime speed
   */
  private updateTimeBasedProgress(): void {
    if (this.audioDuration === 0) return;

    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    // Assume Whisper processes at 15x realtime (conservative estimate)
    const estimatedProgress = Math.min(95, (elapsedSeconds * 15 / this.audioDuration) * 100);

    // Only emit if progress changed by at least 5%
    if (Math.floor(estimatedProgress / 5) > Math.floor(this.lastReportedPercent / 5)) {
      this.lastReportedPercent = estimatedProgress;
      this.emit('progress', {
        percent: Math.round(estimatedProgress),
        task: this.getCurrentTask(estimatedProgress)
      });
      this.logger.log(`Time-based progress: ${Math.round(estimatedProgress)}%`);
    }
  }

  private parseProgress(output: string): void {
    // Log output for debugging
    if (output.trim().length > 0) {
      this.logger.debug(`Whisper: ${output.trim()}`);
    }

    // Skip model download progress bars (they contain | and iB/s)
    // Example: "5%|█▉| 3.84M/72.1M [00:00<00:01, 40.3MiB/s]"
    if (output.includes('|') && output.includes('iB/s')) {
      return;
    }

    // Check for explicit percentage in output
    const percentMatch = output.match(/(\d+)%/);
    if (percentMatch) {
      const percent = Math.min(100, parseInt(percentMatch[1], 10));
      if (percent > this.lastReportedPercent) {
        this.lastReportedPercent = percent;
        this.emit('progress', {
          percent,
          task: this.getCurrentTask(percent)
        });
      }
    }

    // Check for milestone events
    const milestones = [
      { pattern: 'Loading model', percent: 10, task: 'Loading Whisper model' },
      { pattern: 'Detecting language', percent: 20, task: 'Detecting language' },
      { pattern: 'Running on:', percent: 25, task: 'Preparing transcription' },
    ];

    for (const milestone of milestones) {
      if (output.includes(milestone.pattern) && milestone.percent > this.lastReportedPercent) {
        this.lastReportedPercent = milestone.percent;
        this.emit('progress', {
          percent: milestone.percent,
          task: milestone.task
        });
        break;
      }
    }
  }
  
  private getCurrentTask(percent: number): string {
    if (percent < 10) return 'Loading Whisper model';
    if (percent < 30) return 'Detecting language';
    if (percent < 50) return 'Preparing transcription';
    if (percent < 70) return 'Processing audio segments';
    if (percent < 90) return 'Generating transcript';
    return 'Finalizing transcript';
  }
  
  cancel(): void {
    if (this.currentProcess && this.isRunning) {
      this.logger.log('Cancelling Whisper transcription');
      this.aborted = true;
      
      // Kill the process
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