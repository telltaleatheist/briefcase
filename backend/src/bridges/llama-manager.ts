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
  type LlamaGenerateOptions,
} from './llama-bridge';
import { getRuntimePaths, getLlamaLibraryPath } from './runtime-paths';
import { detectGpuVram, type DetectedGpu } from './gpu-info';
import { COGITO_MODELS } from '../config/model-catalog';

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
  private cachedGpu: DetectedGpu | null | undefined = undefined; // undefined = not detected yet

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
    this.modelsDir = path.join(userDataPath, 'briefcase', 'models');

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
   * Initialize by finding a default model to use (logs the outcome at startup).
   */
  private initializeDefaultModel(): void {
    if (!this.resolveModel()) {
      this.logger.log(
        fs.existsSync(this.modelsDir)
          ? '  No models found in models directory'
          : '  Models directory does not exist',
      );
    }
  }

  /**
   * Find the best model on disk (config default, else first available .gguf) and
   * point the bridge at it. Safe to call repeatedly — used to pick up models
   * downloaded after startup without an app restart. Returns true if a model is set.
   */
  private resolveModel(): boolean {
    if (!fs.existsSync(this.modelsDir)) return false;

    const models = fs.readdirSync(this.modelsDir).filter((f) => f.endsWith('.gguf'));
    if (models.length === 0) return false;

    let defaultModelId: string | null = null;
    const configPath = path.join(path.dirname(this.modelsDir), 'app-config.json');
    try {
      if (fs.existsSync(configPath)) {
        defaultModelId = JSON.parse(fs.readFileSync(configPath, 'utf8')).defaultLocalModel || null;
      }
    } catch {
      // Ignore config read errors
    }

    let modelToUse = models[0]; // Fallback to first model
    if (defaultModelId) {
      // Map model ID to a filename pattern (matches model-catalog filenames).
      const modelPatterns: Record<string, string> = {
        'cogito-3b': 'cogito-v1-preview-llama-3B',
        'cogito-8b': 'cogito-v1-preview-llama-8B',
        'cogito-14b': 'cogito-v1-preview-qwen-14B',
        'cogito-32b': 'cogito-v1-preview-qwen-32B',
        'cogito-70b': 'cogito-v1-preview-llama-70B',
      };
      const pattern = modelPatterns[defaultModelId];
      if (pattern) {
        const found = models.find((m) => m.includes(pattern));
        if (found) modelToUse = found;
      }
    }

    const modelPath = path.join(this.modelsDir, modelToUse);
    this.llama.setModelPath(modelPath);
    this.llama.setGpuLayers(this.computeGpuLayers(modelToUse));
    this.logger.log(`  Default model set: ${modelToUse}`);
    return true;
  }

  /**
   * Compute how many transformer layers to offload to the GPU (-ngl), mirroring
   * BookForge: full offload on Apple Silicon (Metal/unified memory); on CUDA,
   * full offload if the model fits in VRAM (minus headroom), otherwise a partial
   * offload proportional to the VRAM budget; CPU-only when there's no usable GPU.
   * Prevents VRAM overflow → empty output on the larger Cogito models.
   */
  private computeGpuLayers(filename: string): number {
    const FULL = 99;
    if (process.platform === 'darwin') {
      return FULL; // unified memory — offload everything
    }

    if (this.cachedGpu === undefined) {
      this.cachedGpu = detectGpuVram();
    }
    const vram = this.cachedGpu?.vramGB ?? 0;
    if (vram < 4) {
      this.logger.log('No usable GPU (>=4GB) — running on CPU (-ngl 0)');
      return 0;
    }

    const model = COGITO_MODELS.find((m) => m.filename === filename);
    const sizeGB = model?.sizeGB ?? 0;
    const layers = model?.layers ?? 0;
    const HEADROOM_GB = 1.5; // KV cache + compute buffers + display
    const budget = vram - HEADROOM_GB;

    if (sizeGB > 0 && sizeGB <= budget) {
      return FULL; // fits entirely in VRAM
    }
    if (layers > 0 && budget > 0 && sizeGB > 0) {
      const n = Math.max(0, Math.min(layers, Math.floor(layers * (budget / sizeGB))));
      this.logger.log(`Partial GPU offload: ${n}/${layers} layers (${sizeGB}GB model, ${vram}GB VRAM)`);
      return n;
    }
    return 0;
  }

  /**
   * Set a specific model to use
   */
  setModelPath(modelPath: string): void {
    this.llama.setModelPath(modelPath);
  }

  /**
   * Check if local AI is available (model exists). Re-resolves on demand so a
   * model downloaded after startup is picked up without restarting.
   */
  isAvailable(): boolean {
    if (this.llama.isModelAvailable()) return true;
    this.resolveModel();
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
  async generateText(prompt: string, options?: LlamaGenerateOptions): Promise<LlamaGenerateResult> {
    if (!this.isAvailable()) {
      throw new Error('Local AI model not available');
    }

    this.logger.log('Generating text with local AI...');
    this.logger.log(`Prompt length: ${prompt.length} characters`);

    try {
      const result = await this.llama.generateText(prompt, options);

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
