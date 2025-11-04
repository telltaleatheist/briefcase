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
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  provider: string;
  model: string;
}

@Injectable()
export class AIProviderService {
  private readonly logger = new Logger(AIProviderService.name);
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  // Pricing per 1M tokens (as of January 2025)
  private readonly PRICING: Record<'claude' | 'openai', Record<string, { input: number; output: number }>> = {
    claude: {
      'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
      'claude-3-5-sonnet-latest': { input: 3.00, output: 15.00 },
      'claude-3-opus-20240229': { input: 15.00, output: 75.00 },
      'claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
    },
    openai: {
      'gpt-4o': { input: 2.50, output: 10.00 },
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      'gpt-4': { input: 30.00, output: 60.00 },
      'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
    },
  };

  /**
   * Calculate estimated cost based on token usage
   */
  private calculateCost(
    provider: 'claude' | 'openai',
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    const pricing = this.PRICING[provider]?.[model];
    if (!pricing) {
      this.logger.warn(`No pricing data for ${provider}:${model}`);
      return 0;
    }

    // Cost per 1M tokens, so divide by 1,000,000
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + outputCost;
  }

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

      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      const estimatedCost = this.calculateCost('claude', config.model, inputTokens, outputTokens);

      this.logger.log(
        `Claude tokens: ${inputTokens} input + ${outputTokens} output = ${inputTokens + outputTokens} total (≈$${estimatedCost.toFixed(4)})`,
      );

      return {
        text,
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        estimatedCost,
        provider: 'claude',
        model: config.model,
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

      const inputTokens = completion.usage?.prompt_tokens || 0;
      const outputTokens = completion.usage?.completion_tokens || 0;
      const tokensUsed = inputTokens + outputTokens;
      const estimatedCost = this.calculateCost('openai', config.model, inputTokens, outputTokens);

      this.logger.log(
        `OpenAI tokens: ${inputTokens} input + ${outputTokens} output = ${tokensUsed} total (≈$${estimatedCost.toFixed(4)})`,
      );

      return {
        text,
        tokensUsed,
        inputTokens,
        outputTokens,
        estimatedCost,
        provider: 'openai',
        model: config.model,
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

      this.logger.log(`Ollama response received (local model, no cost)`);

      return {
        text: data.response,
        provider: 'ollama',
        model: config.model,
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
