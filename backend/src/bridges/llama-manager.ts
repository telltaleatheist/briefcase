/**
 * Llama Manager - NestJS service wrapper for LlamaBridge
 * Manages the local AI server lifecycle for text generation
 */

import { Injectable, Logger, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import {
  LlamaBridge,
  type LlamaProgress,
  type LlamaServerStatus,
  type LlamaGenerateResult,
} from './llama-bridge';
import { getRuntimePaths, getLlamaLibraryPath } from './runtime-paths';

export interface LocalAIProgress {
  percent: number;
  task: string;
  phase: string;
}

@Injectable()
export class LlamaManager extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new Logger(LlamaManager.name);
  private llama: LlamaBridge;
  private modelsDir: string;

  constructor() {
    super();

    this.logger.log('='.repeat(60));
    this.logger.log('LLAMA MANAGER INITIALIZATION');
    this.logger.log('='.repeat(60));
    this.logger.log(`Platform: ${process.platform}`);
    this.logger.log(`Architecture: ${process.arch}`);

    const runtimePaths = getRuntimePaths();
    const llamaPath = runtimePaths.llama;

    // Models are now stored in user data directory, not bundled
    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config'));
    this.modelsDir = path.join(userDataPath, 'ClipChimp', 'models');

    this.logger.log('-'.repeat(60));
    this.logger.log('RESOLVED PATHS:');
    this.logger.log(`  Llama binary: ${llamaPath}`);
    this.logger.log(`  Llama binary exists: ${fs.existsSync(llamaPath)}`);
    this.logger.log(`  Models directory: ${this.modelsDir}`);
    this.logger.log(`  Models directory exists: ${fs.existsSync(this.modelsDir)}`);

    if (fs.existsSync(llamaPath)) {
      const stats = fs.statSync(llamaPath);
      this.logger.log(`  Llama binary size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    // Initialize the LlamaBridge (model path will be set later)
    this.llama = new LlamaBridge({
      binaryPath: llamaPath,
      modelsDir: this.modelsDir,
      libraryPath: getLlamaLibraryPath(),
    });

    // Forward progress events from bridge to this manager
    this.llama.on('progress', (progress: LlamaProgress) => {
      this.emit('progress', {
        percent: progress.percent,
        task: progress.message,
        phase: progress.phase,
      } as LocalAIProgress);
    });

    // Try to find and set a default model
    this.initializeDefaultModel();

    this.logger.log('='.repeat(60));
  }

  /**
   * Initialize by finding a default model to use
   */
  private initializeDefaultModel(): void {
    // Check for default model in config
    const configPath = path.join(path.dirname(this.modelsDir), 'app-config.json');
    let defaultModelId: string | null = null;

    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        defaultModelId = config.defaultLocalModel || null;
      }
    } catch {
      // Ignore config read errors
    }

    // Try to find the default model or any available model
    if (fs.existsSync(this.modelsDir)) {
      const models = fs.readdirSync(this.modelsDir).filter((f) => f.endsWith('.gguf'));
      if (models.length > 0) {
        // If we have a default model ID, try to find its file
        let modelToUse = models[0]; // Fallback to first model

        if (defaultModelId) {
          // Map model ID to filename patterns
          const modelPatterns: Record<string, string> = {
            'cogito-3b': 'cogito-v1-preview-llama-3B',
            'cogito-8b': 'cogito-v1-preview-llama-8B',
            'cogito-70b': 'cogito-v1-preview-llama-70B',
          };
          const pattern = modelPatterns[defaultModelId];
          if (pattern) {
            const foundModel = models.find((m) => m.includes(pattern));
            if (foundModel) {
              modelToUse = foundModel;
            }
          }
        }

        const modelPath = path.join(this.modelsDir, modelToUse);
        this.llama.setModelPath(modelPath);
        this.logger.log(`  Default model set: ${modelToUse}`);
      } else {
        this.logger.log('  No models found in models directory');
      }
    } else {
      this.logger.log('  Models directory does not exist');
    }
  }

  /**
   * Set a specific model to use
   */
  setModelPath(modelPath: string): void {
    this.llama.setModelPath(modelPath);
  }

  /**
   * Check if local AI is available (model exists)
   */
  isAvailable(): boolean {
    return this.llama.isModelAvailable();
  }

  /**
   * Check if the server is running and ready
   */
  isReady(): boolean {
    return this.llama.isServerReady();
  }

  /**
   * Get server status
   */
  getStatus(): LlamaServerStatus {
    return this.llama.getStatus();
  }

  /**
   * Ensure the server is started and ready
   * Useful for pre-warming before analysis
   */
  async ensureReady(): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('Local AI model not available');
    }
    if (!this.llama.isServerReady()) {
      this.logger.log('Starting llama-server (pre-warming)...');
      await this.llama.startServer();
    }
  }

  /**
   * Generate text using the local AI
   */
  async generateText(prompt: string): Promise<LlamaGenerateResult> {
    if (!this.isAvailable()) {
      throw new Error('Local AI model not available');
    }

    this.logger.log('Generating text with local AI...');
    this.logger.log(`Prompt length: ${prompt.length} characters`);

    try {
      const result = await this.llama.generateText(prompt);

      this.logger.log(
        `Generation complete: ${result.inputTokens} input + ${result.outputTokens} output = ${result.totalTokens} tokens`
      );

      return result;
    } catch (error) {
      this.logger.error(`Generation failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Stop the server immediately
   */
  stopServer(): void {
    this.llama.stopServer();
  }

  /**
   * Cleanup on module destroy (app shutdown)
   */
  onModuleDestroy(): void {
    this.logger.log('Module destroying - stopping llama-server');
    this.llama.stopServer();
  }
}
