// backend/src/analysis/ai-provider.service.ts
import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface AIProviderConfig {
  provider: 'ollama' | 'claude' | 'openai';
  model: string;
  apiKey?: string;
  ollamaEndpoint?: string;
}

export interface AIResponse {
  text: string;
  tokensUsed?: number;
  provider: string;
}

@Injectable()
export class AIProviderService {
  private readonly logger = new Logger(AIProviderService.name);
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  /**
   * Generate text using the specified AI provider
   */
  async generateText(
    prompt: string,
    config: AIProviderConfig,
  ): Promise<AIResponse> {
    this.logger.log(`Generating text with provider: ${config.provider}, model: ${config.model}`);

    switch (config.provider) {
      case 'claude':
        return this.generateWithClaude(prompt, config);
      case 'openai':
        return this.generateWithOpenAI(prompt, config);
      case 'ollama':
        return this.generateWithOllama(prompt, config);
      default:
        throw new Error(`Unsupported AI provider: ${config.provider}`);
    }
  }

  /**
   * Generate text using Claude API
   */
  private async generateWithClaude(
    prompt: string,
    config: AIProviderConfig,
  ): Promise<AIResponse> {
    if (!config.apiKey) {
      throw new Error('Claude API key is required');
    }

    // Initialize Anthropic client if needed
    if (!this.anthropic || this.anthropic.apiKey !== config.apiKey) {
      this.anthropic = new Anthropic({
        apiKey: config.apiKey,
      });
    }

    try {
      const message = await this.anthropic.messages.create({
        model: config.model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const textContent = message.content.find((block) => block.type === 'text');
      const text = textContent && 'text' in textContent ? textContent.text : '';

      return {
        text,
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
        provider: 'claude',
      };
    } catch (error) {
      this.logger.error(`Claude API error: ${(error as Error).message}`);
      throw new Error(`Claude API error: ${(error as Error).message}`);
    }
  }

  /**
   * Generate text using OpenAI API
   */
  private async generateWithOpenAI(
    prompt: string,
    config: AIProviderConfig,
  ): Promise<AIResponse> {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required');
    }

    // Initialize OpenAI client if needed
    if (!this.openai || this.openai.apiKey !== config.apiKey) {
      this.openai = new OpenAI({
        apiKey: config.apiKey,
      });
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 4096,
      });

      const text = completion.choices[0]?.message?.content || '';
      const tokensUsed = completion.usage
        ? completion.usage.prompt_tokens + completion.usage.completion_tokens
        : undefined;

      return {
        text,
        tokensUsed,
        provider: 'openai',
      };
    } catch (error) {
      this.logger.error(`OpenAI API error: ${(error as Error).message}`);
      throw new Error(`OpenAI API error: ${(error as Error).message}`);
    }
  }

  /**
   * Generate text using Ollama (existing implementation)
   */
  private async generateWithOllama(
    prompt: string,
    config: AIProviderConfig,
  ): Promise<AIResponse> {
    const ollamaEndpoint = config.ollamaEndpoint || 'http://localhost:11434';

    try {
      const response = await fetch(`${ollamaEndpoint}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          prompt: prompt,
          stream: false,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API returned status ${response.status}`);
      }

      const data = await response.json();

      return {
        text: data.response,
        provider: 'ollama',
      };
    } catch (error) {
      this.logger.error(`Ollama API error: ${(error as Error).message}`);
      throw new Error(`Ollama API error: ${(error as Error).message}`);
    }
  }

  /**
   * Test if an AI provider is accessible and configured correctly
   */
  async testProvider(config: AIProviderConfig): Promise<{ success: boolean; error?: string }> {
    try {
      await this.generateText('Test connection. Respond with "OK".', config);
      return { success: true };
    } catch (error) {
      this.logger.error(`Provider test failed: ${(error as Error).message}`);
      return { success: false, error: (error as Error).message };
    }
  }
}
