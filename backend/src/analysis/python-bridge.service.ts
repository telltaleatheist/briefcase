import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';
import { getPythonCommand, getPythonConfig } from '../shared/python-config';

export interface PythonProgress {
  type: 'progress';
  phase: string;
  progress: number;
  message: string;
}

export interface PythonError {
  type: 'error';
  message: string;
}

export interface PythonResult {
  type: 'result';
  data: any;
}

export type PythonMessage = PythonProgress | PythonError | PythonResult;

@Injectable()
export class PythonBridgeService {
  private readonly logger = new Logger(PythonBridgeService.name);
  private readonly pythonScriptPath: string;

  constructor() {
    // Path to the Python service script
    // In packaged apps, Python files are unpacked from the asar archive
    const isPackaged = process.env.NODE_ENV === 'production' ||
                       (process as any).resourcesPath !== undefined ||
                       (process as any).defaultApp === false;

    if (isPackaged && (process as any).resourcesPath) {
      // In production, use the extraResources location (outside asar)
      this.pythonScriptPath = path.join(
        (process as any).resourcesPath,
        'backend',
        'python',
        'video_analysis_service.py',
      );
    } else {
      // In development, use relative path from dist folder
      this.pythonScriptPath = path.join(
        __dirname,
        '..',
        '..',
        'python',
        'video_analysis_service.py',
      );
    }

    this.logger.log(`Python script path: ${this.pythonScriptPath}`);
  }

  /**
   * Execute Python service with command and get streaming results
   */
  async executeCommand(
    command: object,
    onProgress?: (progress: PythonProgress) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const emitter = new EventEmitter();
      let resultData: any = null;
      let errorMessage: string | null = null;

      // Use centralized Python configuration
      // This ensures we use the SAME Python everywhere in the app
      const pythonConfig = getPythonConfig();
      const pythonPath = pythonConfig.command;

      // CRITICAL: Verify we're using an absolute path in production
      // This prevents accidentally using system Python from PATH
      const isPackaged = process.env.NODE_ENV === 'production' ||
                         (process as any).resourcesPath !== undefined ||
                         (process as any).defaultApp === false;

      if (isPackaged && !path.isAbsolute(pythonPath)) {
        throw new Error(
          `SECURITY: Refusing to use non-absolute Python path in production: ${pythonPath}. ` +
          `This would use system PATH which is unsafe. Check python-config.ts`
        );
      }

      this.logger.log(`Using Python: ${pythonPath}`);
      this.logger.log(`Python config: packaged=${isPackaged}, absolute=${path.isAbsolute(pythonPath)}`);

      // Get FFmpeg path for Whisper (it needs FFmpeg for audio extraction)
      let ffmpegPath: string | undefined;

      // In packaged apps, FFmpeg is in extraResources, not in asar
      if (isPackaged && (process as any).resourcesPath) {
        const platform = process.platform;
        const arch = process.arch;
        let platformFolder = '';
        if (platform === 'darwin') {
          platformFolder = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
        } else if (platform === 'win32') {
          platformFolder = 'win32-x64';
        } else if (platform === 'linux') {
          platformFolder = 'linux-x64';
        }

        const binaryName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
        ffmpegPath = path.join(
          (process as any).resourcesPath,
          'node_modules',
          '@ffmpeg-installer',
          platformFolder,
          binaryName
        );
        this.logger.log(`FFmpeg path for Python (packaged): ${ffmpegPath}`);
      } else {
        // In development, use the npm package
        try {
          const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
          if (ffmpegInstaller && ffmpegInstaller.path) {
            ffmpegPath = ffmpegInstaller.path;
            this.logger.log(`FFmpeg path for Python (dev): ${ffmpegPath}`);
          }
        } catch (e) {
          this.logger.warn('Could not load FFmpeg installer for Python environment');
        }
      }

      // Spawn Python process with EXPLICIT path (no shell, no PATH lookup)
      const pythonProcess: ChildProcess = spawn(pythonPath, [
        this.pythonScriptPath,
      ], {
        shell: false,  // CRITICAL: Never use shell (prevents PATH lookup)
        env: {
          ...process.env,
          // Clear Python-related environment variables to avoid conflicts
          PYTHONHOME: undefined,
          PYTHONPATH: undefined,
          // Add FFmpeg to PATH so Whisper can find it
          PATH: ffmpegPath ? `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}` : process.env.PATH,
        }
      });

      // Send command via stdin
      pythonProcess.stdin?.write(JSON.stringify(command));
      pythonProcess.stdin?.end();

      // Collect stdout data
      let stdoutBuffer = '';

      pythonProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();

        // Process complete JSON lines
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const message: PythonMessage = JSON.parse(line);

            if (message.type === 'progress') {
              // Only log important progress milestones (skip routine chunk updates)
              const isImportantMilestone =
                message.message.includes('Starting') ||
                message.message.includes('complete') ||
                message.message.includes('Loading') ||
                message.progress === 0 ||
                message.progress >= 90 ||
                message.progress % 25 === 0; // Log every 25%

              if (isImportantMilestone) {
                this.logger.log(
                  `Python: ${message.phase} - ${message.progress}% - ${message.message}`,
                );
              }

              if (onProgress) {
                onProgress(message);
              }
            } else if (message.type === 'error') {
              this.logger.error(`Python error: ${message.message}`);
              errorMessage = message.message;
            } else if (message.type === 'result') {
              this.logger.log('Python result received');
              resultData = message.data;
            }
          } catch (e) {
            this.logger.warn(`Failed to parse Python output: ${line}`);
          }
        }
      });

      // Handle stderr - filter out progress bars and only log actual errors
      pythonProcess.stderr?.on('data', (data: Buffer) => {
        const errorText = data.toString();

        // Ignore progress bars (containing %, |, frames/s, eta patterns)
        // and model check info messages (containing [Model Check])
        const isProgressBar = /\d+%\|.*\|.*frames\/s/.test(errorText);
        const isModelCheckInfo = /\[Model Check\]/.test(errorText);

        // Only log if it's not a progress bar or model check info
        if (!isProgressBar && !isModelCheckInfo) {
          this.logger.warn(`Python stderr: ${errorText}`);
        }
      });

      // Handle process exit
      pythonProcess.on('close', (code: number) => {
        if (code === 0 && resultData !== null) {
          resolve(resultData);
        } else if (errorMessage) {
          reject(new Error(errorMessage));
        } else {
          reject(new Error(`Python process exited with code ${code}`));
        }
      });

      // Handle process errors
      pythonProcess.on('error', (err: Error) => {
        this.logger.error(`Python process error: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Transcribe audio file using Whisper
   */
  async transcribe(
    audioPath: string,
    model: string = 'base',
    language: string = 'en',
    onProgress?: (progress: PythonProgress) => void,
  ): Promise<{
    text: string;
    segments: any[];
    srt: string;
    language: string;
  }> {
    const command = {
      command: 'transcribe',
      audio_path: audioPath,
      model,
      language,
    };

    return this.executeCommand(command, onProgress);
  }

  /**
   * Analyze transcript using AI (Ollama, OpenAI, or Claude)
   */
  async analyze(
    ollamaEndpoint: string,
    aiModel: string,
    transcriptText: string,
    segments: any[],
    outputFile: string,
    onProgress?: (progress: PythonProgress) => void,
    customInstructions?: string,
    aiProvider?: 'ollama' | 'openai' | 'claude',
    apiKey?: string,
  ): Promise<{ sections_count: number; sections: any[] }> {
    const command = {
      command: 'analyze',
      ai_provider: aiProvider || 'ollama',
      ollama_endpoint: ollamaEndpoint,
      api_key: apiKey,
      ai_model: aiModel,
      transcript_text: transcriptText,
      segments,
      output_file: outputFile,
      custom_instructions: customInstructions || '',
    };

    return this.executeCommand(command, onProgress);
  }

  /**
   * Check if AI model is available in Ollama
   */
  async checkModel(
    ollamaEndpoint: string,
    aiModel: string,
  ): Promise<{ available: boolean }> {
    const command = {
      command: 'check_model',
      ollama_endpoint: ollamaEndpoint,
      ai_model: aiModel,
    };

    return this.executeCommand(command);
  }

  /**
   * Check if Python dependencies are installed
   */
  async checkDependencies(): Promise<{
    whisper: boolean;
    requests: boolean;
  }> {
    try {
      const command = {
        command: 'check_dependencies',
      };

      // Simple check - try to import the modules
      const result = await this.executeCommand(command);
      return result;
    } catch (error) {
      // If check fails, assume dependencies aren't installed
      return { whisper: false, requests: false };
    }
  }
}
