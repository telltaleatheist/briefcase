/**
 * Llama Manager - NestJS service wrapper for LlamaBridge
 * Manages the local AI server lifecycle for text generation
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as fs from 'fs';
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

  constructor() {
    super();

    this.logger.log('='.repeat(60));
    this.logger.log('LLAMA MANAGER INITIALIZATION');
    this.logger.log('='.repeat(60));
    this.logger.log(`Platform: ${process.platform}`);
    this.logger.log(`Architecture: ${process.arch}`);

    const runtimePaths = getRuntimePaths();
    const llamaPath = runtimePaths.llama;
    const modelsDir = runtimePaths.llamaModelsDir;

    this.logger.log('-'.repeat(60));
    this.logger.log('RESOLVED PATHS:');
    this.logger.log(`  Llama binary: ${llamaPath}`);
    this.logger.log(`  Llama binary exists: ${fs.existsSync(llamaPath)}`);
    this.logger.log(`  Models directory: ${modelsDir}`);
    this.logger.log(`  Models directory exists: ${fs.existsSync(modelsDir)}`);

    if (fs.existsSync(llamaPath)) {
      const stats = fs.statSync(llamaPath);
      this.logger.log(`  Llama binary size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    // Initialize the LlamaBridge
    this.llama = new LlamaBridge({
      binaryPath: llamaPath,
      modelsDir: modelsDir,
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

    // Check model availability
    const modelAvailable = this.llama.isModelAvailable();
    this.logger.log(`  Model available: ${modelAvailable}`);
    if (modelAvailable) {
      this.logger.log(`  Model path: ${this.llama.getModelPath()}`);
    }

    this.logger.log('='.repeat(60));
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
