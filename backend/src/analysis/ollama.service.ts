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

  /**
   * Check if Ollama is running and accessible
   */
  async checkConnection(endpoint?: string): Promise<boolean> {
    const url = endpoint || this.defaultEndpoint;
    try {
      const response = await axios.get(`${url}/api/tags`, { timeout: 5000 });
      return response.status === 200;
    } catch (error: any) {
      this.logger.warn(`Cannot connect to Ollama at ${url}: ${error.message || 'Unknown error'}`);
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
      this.logger.error(`Failed to list Ollama models: ${error.message || 'Unknown error'}`);
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
        this.logger.error(`[Model Check] ✗ Error checking model ${modelName}: ${error.message}`);
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

4. Return to Clippy and the model will be available

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
}
