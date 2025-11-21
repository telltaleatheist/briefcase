import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

export interface OllamaModelList {
  models: OllamaModel[];
}

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private defaultEndpoint = 'http://localhost:11434';

  // Model keep-alive tracking
  private loadedModels = new Map<string, { endpoint: string; lastUsed: Date; unloadTimer?: NodeJS.Timeout }>();
  private readonly KEEP_ALIVE_DURATION = 5 * 60 * 1000; // 5 minutes in milliseconds

  /**
   * Check if Ollama is running and accessible
   */
  async checkConnection(endpoint?: string): Promise<boolean> {
    const url = endpoint || this.defaultEndpoint;
    try {
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      return response.status === 200;
    } catch (error: any) {
      this.logger.warn(`Cannot connect to Ollama at ${url}: ${(error as Error).message || 'Unknown error'}`);
      return false;
    }
  }

  /**
   * List all available models
   */
  async listModels(endpoint?: string): Promise<OllamaModel[]> {
    const url = endpoint || this.defaultEndpoint;
    try {
      const response = await axios.get<OllamaModelList>(`${url}/api/tags`, {
        timeout: 5000,
      });
      return response.data.models || [];
    } catch (error: any) {
      this.logger.error(`Failed to list Ollama models: ${(error as Error).message || 'Unknown error'}`);
      throw new Error(`Cannot connect to Ollama at ${url}`);
    }
  }

  /**
   * Check if a specific model is available
   * Uses ContentStudio's approach: actually test the model with a simple request
   */
  async isModelAvailable(
    modelName: string,
    endpoint?: string,
  ): Promise<boolean> {
    const url = endpoint || this.defaultEndpoint;
    const startTime = Date.now();

    try {
      this.logger.log(`[Model Check] Testing availability for: ${modelName}`);
      this.logger.log(`[Model Check] Ollama endpoint: ${url}`);
      this.logger.log(`[Model Check] Timeout: 300 seconds (5 minutes)`);

      // First check if Ollama server is reachable
      try {
        this.logger.log(`[Model Check] Step 1: Checking Ollama server connection...`);
        const tagsResponse = await axios.get(`${url}/api/tags`, { timeout: 5000 });
        this.logger.log(`[Model Check] ✓ Ollama server is reachable (HTTP ${tagsResponse.status})`);

        // List available models for debugging
        const models = tagsResponse.data.models || [];
        const modelNames = models.map((m: any) => m.name);
        this.logger.log(`[Model Check] Available models in Ollama: ${modelNames.join(', ')}`);

        // Check if model name exists in list
        const modelExists = modelNames.includes(modelName) || modelNames.includes(`${modelName}:latest`);
        if (!modelExists) {
          this.logger.error(`[Model Check] ✗ Model "${modelName}" not found in Ollama model list`);
          this.logger.error(`[Model Check] Please run: ollama pull ${modelName}`);
          return false;
        }
        this.logger.log(`[Model Check] ✓ Model "${modelName}" found in Ollama model list`);

      } catch (serverError: any) {
        this.logger.error(`[Model Check] ✗ Cannot connect to Ollama server at ${url}`);
        this.logger.error(`[Model Check] Error: ${serverError.message}`);
        this.logger.error(`[Model Check] Make sure Ollama is running (try: ollama serve)`);
        return false;
      }

      // Test model with simple prompt (ContentStudio's approach)
      this.logger.log(`[Model Check] Step 2: Testing model response with generate request...`);
      const response = await axios.post(
        `${url}/api/generate`,
        {
          model: modelName,
          prompt: 'Ready.',
          stream: false,
          keep_alive: '5m',  // Keep model loaded for 5 minutes after check
          options: { num_predict: 5 }
        },
        { timeout: 300000 } // 300 second (5 minute) timeout to allow large model loading
      );

      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

      if (response.status === 200) {
        this.logger.log(`[Model Check] ✓ Model ${modelName} is available and responding (took ${elapsedTime}s)`);
        this.logger.log(`[Model Check] Response: ${JSON.stringify(response.data).substring(0, 100)}...`);
        return true;
      } else {
        this.logger.error(`[Model Check] ✗ Model ${modelName} returned unexpected status ${response.status}`);
        return false;
      }
    } catch (error: any) {
      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        this.logger.error(`[Model Check] ✗ Model ${modelName} loading timed out after ${elapsedTime}s`);
        this.logger.error(`[Model Check] This model may be too large or Ollama may be busy`);
        this.logger.error(`[Model Check] Try a smaller model like qwen2.5:7b or llama3.2:3b`);
      } else if (error.code === 'ECONNREFUSED') {
        this.logger.error(`[Model Check] ✗ Connection refused to Ollama at ${url}`);
        this.logger.error(`[Model Check] Make sure Ollama is running`);
      } else if (error.response) {
        this.logger.error(`[Model Check] ✗ Ollama returned error: HTTP ${error.response.status}`);
        this.logger.error(`[Model Check] Response: ${JSON.stringify(error.response.data)}`);
      } else {
        this.logger.error(`[Model Check] ✗ Error checking model ${modelName}: ${(error as Error).message}`);
        this.logger.error(`[Model Check] Error code: ${error.code || 'unknown'}`);
      }

      return false;
    }
  }

  /**
   * Get installation instructions for a model
   */
  getInstallInstructions(modelName: string): string {
    return `
To install the ${modelName} model:

1. Make sure Ollama is installed and running
   - Download from: https://ollama.ai

2. Open a terminal and run:
   ollama pull ${modelName}

3. Wait for the download to complete

4. Return to ClipChimp and the model will be available

Current model status: Not installed
    `.trim();
  }

  /**
   * Get recommended models based on system resources
   */
  getRecommendedModels(): Array<{ name: string; size: string; description: string }> {
    return [
      {
        name: 'llama3.2:3b',
        size: '~2 GB',
        description: 'Fast, lightweight model - good for most users',
      },
      {
        name: 'qwen2.5:7b',
        size: '~4 GB',
        description: 'Balanced performance and quality',
      },
      {
        name: 'cogito:70b',
        size: '~40 GB',
        description: 'Best quality, requires significant RAM',
      },
    ];
  }

  /**
   * Preload a model to keep it in memory
   * This sends a simple request to warm up the model
   */
  async preloadModel(modelName: string, endpoint?: string): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    const modelKey = `${url}:${modelName}`;

    this.logger.log(`[Keep-Alive] Preloading model: ${modelName} at ${url}`);

    try {
      // Send a simple request to load the model into memory
      await axios.post(
        `${url}/api/generate`,
        {
          model: modelName,
          prompt: 'Ready.',
          stream: false,
          keep_alive: '5m',  // Keep model loaded for 5 minutes
          options: { num_predict: 1 }
        },
        { timeout: 300000 } // 5 minute timeout for large models
      );

      // Track this model as loaded
      this.registerModelAsLoaded(modelName, url);

      this.logger.log(`[Keep-Alive] Model ${modelName} preloaded successfully`);
    } catch (error: any) {
      this.logger.error(`[Keep-Alive] Failed to preload model ${modelName}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Register a model as loaded and start keep-alive timer
   */
  private registerModelAsLoaded(modelName: string, endpoint: string): void {
    const url = endpoint || this.defaultEndpoint;
    const modelKey = `${url}:${modelName}`;

    // Clear existing timer if any
    const existing = this.loadedModels.get(modelKey);
    if (existing?.unloadTimer) {
      clearTimeout(existing.unloadTimer);
    }

    // Set up new keep-alive timer
    const unloadTimer = setTimeout(() => {
      this.logger.log(`[Keep-Alive] Model ${modelName} idle timeout reached, unloading...`);
      this.unloadModel(modelName, endpoint).catch(err => {
        this.logger.warn(`[Keep-Alive] Failed to unload idle model ${modelName}: ${err.message}`);
      });
    }, this.KEEP_ALIVE_DURATION);

    this.loadedModels.set(modelKey, {
      endpoint: url,
      lastUsed: new Date(),
      unloadTimer
    });

    this.logger.log(`[Keep-Alive] Model ${modelName} registered as loaded (will unload after ${this.KEEP_ALIVE_DURATION / 60000} minutes of inactivity)`);
  }

  /**
   * Refresh keep-alive timer for a model
   * Call this before using a model to extend its keep-alive
   */
  async touchModel(modelName: string, endpoint?: string): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    const modelKey = `${url}:${modelName}`;

    const existing = this.loadedModels.get(modelKey);
    if (!existing) {
      // Model not loaded, preload it first
      await this.preloadModel(modelName, endpoint);
      return;
    }

    // Send a keep-alive request to Ollama to refresh ITS timer too
    try {
      await axios.post(
        `${url}/api/generate`,
        {
          model: modelName,
          prompt: '',
          stream: false,
          keep_alive: '5m',  // Refresh Ollama's keep-alive timer
          options: { num_predict: 0 }  // Don't generate anything
        },
        { timeout: 10000 }
      );
      this.logger.log(`[Keep-Alive] Sent keep-alive refresh to Ollama for model ${modelName}`);
    } catch (error: any) {
      this.logger.warn(`[Keep-Alive] Failed to refresh Ollama keep-alive for ${modelName}: ${(error as Error).message}`);
      // Continue anyway - the Python script will also send keep_alive
    }

    // Clear old timer
    if (existing.unloadTimer) {
      clearTimeout(existing.unloadTimer);
    }

    // Set up new timer
    const unloadTimer = setTimeout(() => {
      this.logger.log(`[Keep-Alive] Model ${modelName} idle timeout reached, unloading...`);
      this.unloadModel(modelName, endpoint).catch(err => {
        this.logger.warn(`[Keep-Alive] Failed to unload idle model ${modelName}: ${err.message}`);
      });
    }, this.KEEP_ALIVE_DURATION);

    this.loadedModels.set(modelKey, {
      endpoint: url,
      lastUsed: new Date(),
      unloadTimer
    });

    this.logger.log(`[Keep-Alive] Model ${modelName} keep-alive refreshed`);
  }

  /**
   * Unload a model from memory
   */
  async unloadModel(modelName: string, endpoint?: string): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    const modelKey = `${url}:${modelName}`;

    this.logger.log(`[Keep-Alive] Unloading model: ${modelName}`);

    try {
      // Clear timer
      const existing = this.loadedModels.get(modelKey);
      if (existing?.unloadTimer) {
        clearTimeout(existing.unloadTimer);
      }

      // Remove from tracking
      this.loadedModels.delete(modelKey);

      // Tell Ollama to unload the model by setting keep_alive to 0
      await axios.post(
        `${url}/api/generate`,
        {
          model: modelName,
          prompt: '',
          keep_alive: 0  // This tells Ollama to unload the model immediately
        },
        { timeout: 10000 }
      );

      this.logger.log(`[Keep-Alive] Model ${modelName} unloaded successfully`);
    } catch (error: any) {
      this.logger.warn(`[Keep-Alive] Error unloading model ${modelName}: ${(error as Error).message}`);
      // Don't throw - unloading is best-effort
    }
  }

  /**
   * Prepare to use a specific model - unload others if needed
   */
  async prepareModel(modelName: string, endpoint?: string): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    const modelKey = `${url}:${modelName}`;

    this.logger.log(`[Keep-Alive] prepareModel called for ${modelName} at ${url}`);
    this.logger.log(`[Keep-Alive] Model key: ${modelKey}`);
    this.logger.log(`[Keep-Alive] Currently loaded models: ${Array.from(this.loadedModels.keys()).join(', ') || 'none'}`);

    // Check if this model is already loaded
    const isAlreadyLoaded = this.loadedModels.has(modelKey);

    if (isAlreadyLoaded) {
      // Just refresh keep-alive
      this.logger.log(`[Keep-Alive] Model ${modelName} found in tracking map, refreshing keep-alive...`);
      await this.touchModel(modelName, endpoint);
      this.logger.log(`[Keep-Alive] Model ${modelName} already loaded, keep-alive refreshed`);
      return;
    }

    this.logger.log(`[Keep-Alive] Model ${modelName} NOT in tracking map, checking for other models to unload...`);

    // Unload all other models at this endpoint to free up memory
    const modelsToUnload: string[] = [];
    for (const [key, info] of this.loadedModels.entries()) {
      if (info.endpoint === url && key !== modelKey) {
        // Extract model name from key (format: "endpoint:modelname")
        const otherModelName = key.substring(url.length + 1);
        modelsToUnload.push(otherModelName);
      }
    }

    // Unload other models in parallel
    if (modelsToUnload.length > 0) {
      this.logger.log(`[Keep-Alive] Unloading ${modelsToUnload.length} other model(s) to make room for ${modelName}: ${modelsToUnload.join(', ')}`);
      await Promise.all(
        modelsToUnload.map(m => this.unloadModel(m, endpoint))
      );
    }

    // Now preload the new model
    this.logger.log(`[Keep-Alive] Loading new model ${modelName}...`);
    await this.preloadModel(modelName, endpoint);
  }

  /**
   * Get list of currently loaded models
   */
  getLoadedModels(): Array<{ model: string; endpoint: string; lastUsed: Date }> {
    const result: Array<{ model: string; endpoint: string; lastUsed: Date }> = [];

    for (const [key, info] of this.loadedModels.entries()) {
      // Extract model name from key (format: "endpoint:modelname")
      const modelName = key.substring(info.endpoint.length + 1);
      result.push({
        model: modelName,
        endpoint: info.endpoint,
        lastUsed: info.lastUsed
      });
    }

    return result;
  }

  /**
   * Pull/download a model from Ollama registry
   * Returns a stream of progress updates
   */
  async pullModel(
    modelName: string,
    endpoint?: string,
    onProgress?: (data: { status: string; completed?: number; total?: number; digest?: string }) => void
  ): Promise<void> {
    const url = endpoint || this.defaultEndpoint;
    this.logger.log(`[Ollama Pull] Starting download of model: ${modelName}`);

    try {
      const response = await axios.post(
        `${url}/api/pull`,
        { name: modelName },
        {
          responseType: 'stream',
          timeout: 3600000 // 1 hour timeout for large models
        }
      );

      return new Promise((resolve, reject) => {
        let buffer = '';

        response.data.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const data = JSON.parse(line);
              this.logger.log(`[Ollama Pull] ${data.status} ${data.completed && data.total ? `(${Math.round(data.completed / data.total * 100)}%)` : ''}`);

              if (onProgress) {
                onProgress(data);
              }

              // Check for completion or error
              if (data.status === 'success') {
                resolve();
              } else if (data.error) {
                reject(new Error(data.error));
              }
            } catch (parseError) {
              this.logger.warn(`[Ollama Pull] Failed to parse progress: ${line}`);
            }
          }
        });

        response.data.on('end', () => {
          this.logger.log(`[Ollama Pull] Model ${modelName} downloaded successfully`);
          resolve();
        });

        response.data.on('error', (error: Error) => {
          this.logger.error(`[Ollama Pull] Download failed: ${error.message}`);
          reject(error);
        });
      });
    } catch (error: any) {
      this.logger.error(`[Ollama Pull] Failed to pull model ${modelName}: ${(error as Error).message}`);
      throw new Error(`Failed to download model: ${(error as Error).message}`);
    }
  }

  /**
   * Cleanup all timers (call on service shutdown)
   */
  onModuleDestroy(): void {
    this.logger.log('[Keep-Alive] Cleaning up all model keep-alive timers');
    for (const [_, info] of this.loadedModels.entries()) {
      if (info.unloadTimer) {
        clearTimeout(info.unloadTimer);
      }
    }
    this.loadedModels.clear();
  }
}
