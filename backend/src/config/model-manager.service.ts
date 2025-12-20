/**
 * Model Manager Service
 * Handles downloading, listing, and deleting local AI models (GGUF files)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import axios from 'axios';

export interface ModelInfo {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  minRAM: number;
  description: string;
  downloaded: boolean;
  isDefault: boolean;
  downloadedAt?: string;
  filePath?: string;
}

export interface GpuInfo {
  name: string;
  vramGB: number;
  driver?: string;
}

export interface SystemInfo {
  totalMemoryGB: number;
  freeMemoryGB: number;
  cpuCores: number;
  platform: string;
  recommendedModel: string;
  gpu: GpuInfo | null;
  useGpu: boolean;
  effectiveMemoryGB: number; // GPU VRAM if available, otherwise system RAM
}

export interface DownloadProgress {
  modelId: string;
  progress: number;
  downloadedGB: number;
  totalGB: number;
  speed?: string;
  eta?: string;
}

// Cogito models available for download
// Using bartowski's quantizations from Hugging Face
// minRAM represents the minimum VRAM (GPU) or RAM (CPU) needed to run the model
const COGITO_MODELS: Omit<ModelInfo, 'downloaded' | 'isDefault'>[] = [
  {
    id: 'cogito-3b',
    name: 'Cogito 3B',
    filename: 'deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/deepcogito_cogito-v1-preview-llama-3B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf',
    sizeGB: 2.24,
    minRAM: 4, // ~3GB VRAM/RAM needed
    description: 'Lightweight and fast. Works on most GPUs (4GB+ VRAM) or CPU.',
  },
  {
    id: 'cogito-8b',
    name: 'Cogito 8B',
    filename: 'deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/deepcogito_cogito-v1-preview-llama-8B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf',
    sizeGB: 4.92,
    minRAM: 6, // ~5.5GB VRAM/RAM needed
    description: 'Good balance of quality and speed. Runs great on 6GB+ GPU.',
  },
  {
    id: 'cogito-14b',
    name: 'Cogito 14B',
    filename: 'cogito-v1-preview-qwen-14B-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/deepcogito_cogito-v1-preview-qwen-14B-GGUF/resolve/main/cogito-v1-preview-qwen-14B-Q4_K_M.gguf',
    sizeGB: 8.99,
    minRAM: 10, // ~10GB VRAM/RAM needed
    description: 'Higher quality results. Runs on 10GB+ GPU or 16GB+ RAM.',
  },
  {
    id: 'cogito-32b',
    name: 'Cogito 32B',
    filename: 'cogito-v1-preview-qwen-32B-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/deepcogito_cogito-v1-preview-qwen-32B-GGUF/resolve/main/cogito-v1-preview-qwen-32B-Q4_K_M.gguf',
    sizeGB: 19.85,
    minRAM: 24, // ~24GB VRAM/RAM needed
    description: 'Best quality for most systems. Needs 24GB+ GPU or Mac with 32GB+ unified memory.',
  },
];

@Injectable()
export class ModelManagerService implements OnModuleInit {
  private readonly logger = new Logger(ModelManagerService.name);
  private modelsDir: string;
  private configPath: string;
  private activeDownload: {
    modelId: string;
    controller: AbortController;
  } | null = null;
  private cachedGpuInfo: GpuInfo | null | undefined = undefined; // undefined = not detected yet

  constructor(private readonly eventEmitter: EventEmitter2) {
    // Set up paths based on platform
    const userDataPath =
      process.env.APPDATA ||
      (process.platform === 'darwin'
        ? path.join(process.env.HOME || '', 'Library', 'Application Support')
        : path.join(process.env.HOME || '', '.config'));

    this.modelsDir = path.join(userDataPath, 'ClipChimp', 'models');
    this.configPath = path.join(userDataPath, 'ClipChimp', 'app-config.json');
  }

  onModuleInit() {
    // Ensure models directory exists
    if (!fs.existsSync(this.modelsDir)) {
      fs.mkdirSync(this.modelsDir, { recursive: true });
      this.logger.log(`Created models directory: ${this.modelsDir}`);
    }
    this.logger.log(`Models directory: ${this.modelsDir}`);

    // Detect GPU on startup
    this.detectGpu();
  }

  /**
   * Detect GPU and VRAM
   */
  private detectGpu(): GpuInfo | null {
    if (this.cachedGpuInfo !== undefined) {
      return this.cachedGpuInfo;
    }

    try {
      if (process.platform === 'win32') {
        // Try NVIDIA first
        try {
          const nvidiaSmiOutput = execSync('nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits', {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          }).trim();

          if (nvidiaSmiOutput) {
            const parts = nvidiaSmiOutput.split(',').map(s => s.trim());
            if (parts.length >= 2) {
              const vramMB = parseInt(parts[1], 10);
              this.cachedGpuInfo = {
                name: parts[0],
                vramGB: Math.round((vramMB / 1024) * 10) / 10,
                driver: parts[2] || undefined,
              };
              this.logger.log(`Detected NVIDIA GPU: ${this.cachedGpuInfo.name} with ${this.cachedGpuInfo.vramGB}GB VRAM`);
              return this.cachedGpuInfo;
            }
          }
        } catch {
          // NVIDIA not available, try other methods
        }

        // Try WMI for AMD/Intel/other GPUs
        try {
          const wmicOutput = execSync('wmic path win32_VideoController get Name,AdapterRAM /format:csv', {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
          }).trim();

          const lines = wmicOutput.split('\n').filter(l => l.trim() && !l.includes('Node,'));
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length >= 3) {
              const adapterRAM = parseInt(parts[1], 10);
              const name = parts[2]?.trim();

              // Skip integrated graphics with very low VRAM
              if (adapterRAM > 0 && name && !name.toLowerCase().includes('microsoft basic')) {
                const vramGB = Math.round((adapterRAM / (1024 ** 3)) * 10) / 10;
                // Only consider GPUs with at least 2GB VRAM
                if (vramGB >= 2) {
                  this.cachedGpuInfo = { name, vramGB };
                  this.logger.log(`Detected GPU: ${name} with ${vramGB}GB VRAM`);
                  return this.cachedGpuInfo;
                }
              }
            }
          }
        } catch {
          // WMI failed
        }
      } else if (process.platform === 'darwin') {
        // macOS - use system_profiler for Metal GPUs
        try {
          const output = execSync('system_profiler SPDisplaysDataType -json', {
            encoding: 'utf8',
            timeout: 5000,
          });
          const data = JSON.parse(output);
          const displays = data.SPDisplaysDataType || [];

          for (const display of displays) {
            const name = display.sppci_model || display._name || 'Unknown GPU';
            // On Apple Silicon, GPU uses unified memory - report as system RAM available
            // On discrete GPUs, look for VRAM
            const vramString = display.spdisplays_vram || display.spdisplays_vram_shared || '';
            let vramGB = 0;

            if (vramString.includes('GB')) {
              vramGB = parseFloat(vramString);
            } else if (vramString.includes('MB')) {
              vramGB = parseFloat(vramString) / 1024;
            } else if (name.includes('Apple')) {
              // Apple Silicon uses unified memory - use total system RAM
              vramGB = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
            }

            if (vramGB >= 2) {
              this.cachedGpuInfo = { name, vramGB: Math.round(vramGB * 10) / 10 };
              this.logger.log(`Detected GPU: ${name} with ${this.cachedGpuInfo.vramGB}GB VRAM`);
              return this.cachedGpuInfo;
            }
          }
        } catch (err) {
          this.logger.warn(`Failed to detect macOS GPU: ${err}`);
        }
      } else {
        // Linux - try nvidia-smi or lspci
        try {
          const nvidiaSmiOutput = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
            encoding: 'utf8',
            timeout: 5000,
          }).trim();

          if (nvidiaSmiOutput) {
            const parts = nvidiaSmiOutput.split(',').map(s => s.trim());
            if (parts.length >= 2) {
              const vramMB = parseInt(parts[1], 10);
              this.cachedGpuInfo = {
                name: parts[0],
                vramGB: Math.round((vramMB / 1024) * 10) / 10,
              };
              this.logger.log(`Detected NVIDIA GPU: ${this.cachedGpuInfo.name} with ${this.cachedGpuInfo.vramGB}GB VRAM`);
              return this.cachedGpuInfo;
            }
          }
        } catch {
          // NVIDIA not available on Linux
        }
      }
    } catch (err) {
      this.logger.warn(`GPU detection error: ${err}`);
    }

    this.cachedGpuInfo = null;
    this.logger.log('No suitable GPU detected, will use CPU for inference');
    return null;
  }

  /**
   * Get system information and recommended model
   */
  getSystemInfo(): SystemInfo {
    const totalMemoryBytes = os.totalmem();
    const freeMemoryBytes = os.freemem();
    const totalMemoryGB = Math.round((totalMemoryBytes / (1024 ** 3)) * 10) / 10;
    const freeMemoryGB = Math.round((freeMemoryBytes / (1024 ** 3)) * 10) / 10;
    const cpuCores = os.cpus().length;

    // Get GPU info
    const gpu = this.detectGpu();
    const useGpu = gpu !== null && gpu.vramGB >= 4; // Use GPU if at least 4GB VRAM

    // Use GPU VRAM for recommendations if available, otherwise fall back to system RAM
    const effectiveMemoryGB = useGpu && gpu ? gpu.vramGB : totalMemoryGB;

    // Recommend model based on effective memory (GPU VRAM or system RAM)
    let recommendedModel: string;
    if (effectiveMemoryGB >= 24) {
      recommendedModel = 'cogito-32b';
    } else if (effectiveMemoryGB >= 10) {
      recommendedModel = 'cogito-14b';
    } else if (effectiveMemoryGB >= 6) {
      recommendedModel = 'cogito-8b';
    } else {
      recommendedModel = 'cogito-3b';
    }

    return {
      totalMemoryGB,
      freeMemoryGB,
      cpuCores,
      platform: process.platform,
      recommendedModel,
      gpu,
      useGpu,
      effectiveMemoryGB,
    };
  }

  /**
   * Get the models directory path
   */
  getModelsDir(): string {
    return this.modelsDir;
  }

  /**
   * List all available and downloaded models
   */
  async listModels(): Promise<ModelInfo[]> {
    const defaultModel = await this.getDefaultModel();

    return COGITO_MODELS.map((model) => {
      const filePath = path.join(this.modelsDir, model.filename);
      const downloaded = fs.existsSync(filePath);
      let downloadedAt: string | undefined;

      if (downloaded) {
        try {
          const stats = fs.statSync(filePath);
          downloadedAt = stats.mtime.toISOString();
        } catch {
          // Ignore stat errors
        }
      }

      return {
        ...model,
        downloaded,
        isDefault: defaultModel === model.id,
        downloadedAt,
        filePath: downloaded ? filePath : undefined,
      };
    });
  }

  /**
   * Get a specific model by ID
   */
  async getModel(modelId: string): Promise<ModelInfo | null> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId) || null;
  }

  /**
   * Get the default model ID
   */
  async getDefaultModel(): Promise<string | null> {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        return config.defaultLocalModel || null;
      }
    } catch {
      // Ignore read errors
    }
    return null;
  }

  /**
   * Set the default model
   */
  async setDefaultModel(modelId: string): Promise<void> {
    const model = COGITO_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const filePath = path.join(this.modelsDir, model.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Model not downloaded: ${modelId}`);
    }

    // Read existing config
    let config: any = {};
    if (fs.existsSync(this.configPath)) {
      config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    }

    // Update default model
    config.defaultLocalModel = modelId;
    config.lastUpdated = new Date().toISOString();

    // Save config
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

    this.logger.log(`Set default model to: ${modelId}`);
  }

  /**
   * Get the path to the default model file
   * Returns null if no model is downloaded
   */
  async getDefaultModelPath(): Promise<string | null> {
    const defaultModelId = await this.getDefaultModel();

    if (defaultModelId) {
      const model = COGITO_MODELS.find((m) => m.id === defaultModelId);
      if (model) {
        const filePath = path.join(this.modelsDir, model.filename);
        if (fs.existsSync(filePath)) {
          return filePath;
        }
      }
    }

    // Fall back to first available model
    for (const model of COGITO_MODELS) {
      const filePath = path.join(this.modelsDir, model.filename);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * Download a model from Hugging Face with retry logic
   */
  async downloadModel(modelId: string, retryCount = 0): Promise<void> {
    const MAX_RETRIES = 3;
    const model = COGITO_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    if (this.activeDownload && this.activeDownload.modelId !== modelId) {
      throw new Error(`Download already in progress: ${this.activeDownload.modelId}`);
    }

    const destPath = path.join(this.modelsDir, model.filename);
    const tempPath = `${destPath}.download`;

    // Check if we can resume from a partial download
    let resumeFromByte = 0;
    if (fs.existsSync(tempPath) && retryCount > 0) {
      const stats = fs.statSync(tempPath);
      resumeFromByte = stats.size;
      this.logger.log(`Resuming download from byte ${resumeFromByte}`);
    }

    // Create abort controller for cancellation
    const controller = new AbortController();
    this.activeDownload = { modelId, controller };

    this.logger.log(`Starting download: ${model.name} from ${model.url}${retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : ''}`);
    this.emitProgress(modelId, 0, 0, model.sizeGB);

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'ClipChimp/1.0',
      };

      // Add range header for resume support
      if (resumeFromByte > 0) {
        headers['Range'] = `bytes=${resumeFromByte}-`;
      }

      const response = await axios.get(model.url, {
        responseType: 'stream',
        signal: controller.signal,
        timeout: 30000, // 30 second timeout for initial connection
        maxRedirects: 5,
        headers,
      });

      // Handle content-length for both full and partial responses
      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      const totalBytes = resumeFromByte + contentLength;
      const totalGB = totalBytes / (1024 ** 3);
      let downloadedBytes = resumeFromByte;
      let lastProgressTime = Date.now();
      let lastDownloadedBytes = resumeFromByte;

      // Create write stream - append if resuming, otherwise create new
      const writeStream = fs.createWriteStream(tempPath, {
        highWaterMark: 16 * 1024 * 1024, // 16MB buffer
        flags: resumeFromByte > 0 ? 'a' : 'w', // Append if resuming
      });

      // Log download info
      this.logger.log(`Download info: ${contentLength} bytes to download, ${totalBytes} total bytes expected`);

      // Track download progress
      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        const downloadedGB = downloadedBytes / (1024 ** 3);
        const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

        // Calculate speed every second
        const now = Date.now();
        const elapsed = now - lastProgressTime;
        let speed: string | undefined;
        let eta: string | undefined;

        if (elapsed >= 1000) {
          const bytesPerSecond = ((downloadedBytes - lastDownloadedBytes) / elapsed) * 1000;
          const mbPerSecond = bytesPerSecond / (1024 * 1024);
          speed = `${mbPerSecond.toFixed(1)} MB/s`;

          const remainingBytes = totalBytes - downloadedBytes;
          const remainingSeconds = remainingBytes / bytesPerSecond;
          if (remainingSeconds < 60) {
            eta = `${Math.ceil(remainingSeconds)}s`;
          } else if (remainingSeconds < 3600) {
            eta = `${Math.ceil(remainingSeconds / 60)}m`;
          } else {
            eta = `${Math.ceil(remainingSeconds / 3600)}h`;
          }

          lastProgressTime = now;
          lastDownloadedBytes = downloadedBytes;
        }

        this.emitProgress(modelId, progress, downloadedGB, totalGB, speed, eta);
      });

      // Pipe to file with proper error handling
      response.data.pipe(writeStream);

      await new Promise<void>((resolve, reject) => {
        let finished = false;

        const cleanup = () => {
          if (finished) return;
          finished = true;
        };

        writeStream.on('finish', () => {
          cleanup();
          resolve();
        });

        writeStream.on('error', (err) => {
          cleanup();
          this.logger.error(`Write stream error: ${err.message}`);
          reject(err);
        });

        response.data.on('error', (err: Error) => {
          cleanup();
          this.logger.error(`Read stream error: ${err.message}`);
          // Destroy write stream to clean up
          writeStream.destroy();
          reject(err);
        });

        // Handle abort signal
        controller.signal.addEventListener('abort', () => {
          cleanup();
          response.data.destroy();
          writeStream.destroy();
          reject(new Error('aborted'));
        });
      });

      // Rename temp file to final name
      fs.renameSync(tempPath, destPath);

      this.logger.log(`Download complete: ${model.name}`);
      this.eventEmitter.emit('model.download.complete', { modelId });

      // Set as default if it's the first model
      const models = await this.listModels();
      const downloadedModels = models.filter((m) => m.downloaded);
      if (downloadedModels.length === 1) {
        await this.setDefaultModel(modelId);
      }

      // Clear active download on success
      this.activeDownload = null;
    } catch (error: any) {
      // Check if this was a cancellation (user-initiated or abort signal)
      const isCancelled = axios.isCancel(error) ||
                          error.name === 'AbortError' ||
                          error.name === 'CanceledError' ||
                          error.message === 'aborted' ||
                          error.code === 'ERR_CANCELED';

      if (isCancelled) {
        // User cancelled - clean up temp file and don't retry
        if (fs.existsSync(tempPath)) {
          try {
            fs.unlinkSync(tempPath);
          } catch (cleanupErr) {
            this.logger.warn(`Failed to clean up temp file: ${cleanupErr}`);
          }
        }
        this.logger.log(`Download cancelled: ${model.name}`);
        this.eventEmitter.emit('model.download.cancelled', { modelId });
        this.activeDownload = null;
        throw error;
      }

      // Log error details
      this.logger.error(`Download failed for ${model.name}:`, {
        message: error.message,
        code: error.code,
        name: error.name,
        response: error.response?.status,
        retry: retryCount,
      });

      // Check if we should retry (for network errors, not for user cancellation)
      const isRetryable = error.code === 'ECONNRESET' ||
                          error.code === 'ETIMEDOUT' ||
                          error.code === 'ECONNREFUSED' ||
                          error.code === 'ENOTFOUND' ||
                          error.code === 'EAI_AGAIN' ||
                          error.response?.status >= 500 ||
                          error.message?.includes('socket hang up') ||
                          error.message?.includes('network');

      if (isRetryable && retryCount < MAX_RETRIES) {
        this.logger.log(`Retrying download in 5 seconds... (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        this.activeDownload = null;

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Retry the download (will resume from partial file)
        return this.downloadModel(modelId, retryCount + 1);
      }

      // No more retries - clean up and emit error
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (cleanupErr) {
          this.logger.warn(`Failed to clean up temp file: ${cleanupErr}`);
        }
      }

      this.eventEmitter.emit('model.download.error', {
        modelId,
        error: error.message || 'Download failed unexpectedly'
      });
      this.activeDownload = null;
      throw error;
    }
  }

  /**
   * Cancel an active download
   */
  cancelDownload(): boolean {
    if (this.activeDownload) {
      this.activeDownload.controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Delete a downloaded model
   */
  async deleteModel(modelId: string): Promise<void> {
    const model = COGITO_MODELS.find((m) => m.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const filePath = path.join(this.modelsDir, model.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Model not downloaded: ${modelId}`);
    }

    // Delete the file
    fs.unlinkSync(filePath);
    this.logger.log(`Deleted model: ${model.name}`);

    // If this was the default model, clear it or set another
    const defaultModel = await this.getDefaultModel();
    if (defaultModel === modelId) {
      // Find another downloaded model to set as default
      const models = await this.listModels();
      const anotherModel = models.find((m) => m.downloaded && m.id !== modelId);

      if (anotherModel) {
        await this.setDefaultModel(anotherModel.id);
      } else {
        // Clear default model
        let config: any = {};
        if (fs.existsSync(this.configPath)) {
          config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        }
        delete config.defaultLocalModel;
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
      }
    }
  }

  /**
   * Check if any model is downloaded
   */
  async hasAnyModel(): Promise<boolean> {
    const models = await this.listModels();
    return models.some((m) => m.downloaded);
  }

  /**
   * Emit download progress event
   */
  private emitProgress(
    modelId: string,
    progress: number,
    downloadedGB: number,
    totalGB: number,
    speed?: string,
    eta?: string,
  ): void {
    const event: DownloadProgress = {
      modelId,
      progress: Math.round(progress * 10) / 10,
      downloadedGB: Math.round(downloadedGB * 100) / 100,
      totalGB: Math.round(totalGB * 100) / 100,
      speed,
      eta,
    };
    this.eventEmitter.emit('model.download.progress', event);
  }
}
