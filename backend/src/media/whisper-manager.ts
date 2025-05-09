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

  constructor(private readonly sharedConfigService: SharedConfigService) {
    super();
    this.whisperPath = this.getWhisperPath();
    this.detectWhisperVersion();
  }

  private getWhisperPath(): string {
    // Try environment variable first
    if (process.env.WHISPER_PATH && fs.existsSync(process.env.WHISPER_PATH)) {
      return process.env.WHISPER_PATH;
    }

    // Try standard installation paths
    const possiblePaths = [
      '/usr/local/bin/whisper',
      '/usr/bin/whisper',
      'C:\\Program Files\\whisper\\whisper.exe',
      'whisper' // System PATH
    ];

    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        return path;
      }
    }

    // Default to system PATH
    return 'whisper';
  }

  // Detect whisper command line format by running help
  private async detectWhisperVersion(): Promise<void> {
    try {
      exec(`${this.whisperPath} --help`, (error, stdout, stderr) => {
        if (error) {
          this.logger.warn(`Error checking whisper version: ${error.message}`);
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
    if (!audioFile || !fs.existsSync(audioFile)) {
      throw new Error(`Audio file not found: ${audioFile}`);
    }

    this.aborted = false;
    this.isRunning = true;

    // Create output filename for SRT
    const basename = path.basename(audioFile, path.extname(audioFile));
    const srtFile = path.join(outputDir, `${basename}.srt`);

    // Get the appropriate arguments for this whisper version
    const args = this.getCommandLineArgs(audioFile, outputDir);

    this.logger.log(`Starting Whisper transcription: ${this.whisperPath} ${args.join(' ')}`);

    return new Promise<string>((resolve, reject) => {
      this.currentProcess = spawn(this.whisperPath, args);

      let stdoutBuffer = '';
      let stderrBuffer = '';

      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        this.parseProgress(chunk);
      });

      this.currentProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        this.parseProgress(chunk);
      });

      this.currentProcess.on('close', (code) => {
        this.isRunning = false;

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
            const files = fs.readdirSync(outputDir);
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
                const convertedSrtFile = this.convertTxtToSrt(txtFile, srtFile);
                if (convertedSrtFile) {
                  resolve(convertedSrtFile);
                } else {
                  reject(new Error('Transcription completed but SRT file could not be created'));
                }
              } else {
                reject(new Error('Transcription completed but no output file found'));
              }
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
            const simpleProcess = spawn(this.whisperPath, simpleArgs, { cwd: outputDir });
            
            let simpleStdoutBuffer = '';
            let simpleStderrBuffer = '';
            
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

  private parseProgress(output: string): void {
    // More granular and dynamic progress tracking
    const percentMatch = output.match(/(\d+)%/);
    const milestones = [
      { pattern: 'Loading model', percent: 10, task: 'Loading Whisper model' },
      { pattern: 'Detecting language', percent: 20, task: 'Detecting language' },
      { pattern: 'Running on:', percent: 30, task: 'Preparing transcription' },
      { pattern: 'Processing', percent: 50, task: 'Processing audio' },
      { pattern: 'Adding segments', percent: 70, task: 'Processing audio segments' },
      { pattern: 'Writing', percent: 90, task: 'Writing transcript file' }
    ];
  
    // Check milestone events first
    for (const milestone of milestones) {
      if (output.includes(milestone.pattern)) {
        this.emit('progress', { 
          percent: milestone.percent, 
          task: milestone.task 
        });
        return;
      }
    }
  
    // Use actual percentage if available
    if (percentMatch && !output.includes('Estimated duration:')) {
      const percent = parseInt(percentMatch[1], 10);
      const scaledPercent = Math.min(100, percent);
      
      this.emit('progress', { 
        percent: scaledPercent, 
        task: 'Transcribing audio' 
      });
    }
  
    // Periodic update to show activity if no progress detected
    if (!percentMatch && this.isRunning) {
      this.emit('progress', { 
        percent: Math.min(90, (this.progressCounter++ * 5)), 
        task: 'Transcribing audio' 
      });
    }
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