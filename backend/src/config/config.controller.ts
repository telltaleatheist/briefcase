import { Controller, Post, Body, Get, Inject, forwardRef } from '@nestjs/common';
import { SharedConfigService } from './shared-config.service';
import { ApiKeysService } from './api-keys.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('config')
export class ConfigController {
  private configPath: string;

  constructor(
    private readonly configService: SharedConfigService,
    private readonly apiKeysService: ApiKeysService,
  ) {
    const userDataPath = process.env.APPDATA ||
                      (process.platform === 'darwin' ?
                      path.join(process.env.HOME || '', 'Library', 'Application Support') :
                      path.join(process.env.HOME || '', '.config'));

    this.configPath = path.join(userDataPath, 'ClipChimp', 'app-config.json');
  }

  /**
   * Save output directory to config
   */
  @Post('output-dir')
  async saveOutputDir(@Body() body: { outputDir: string }) {
    try {
      // Ensure config directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Read existing config or create new one
      let config: any = {};
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        config = JSON.parse(configData);
      }

      // Update output directory
      config.outputDir = body.outputDir;
      config.lastUpdated = new Date().toISOString();

      // Save config
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

      // Refresh the config service
      this.configService.refreshConfig();

      return {
        success: true,
        message: 'Output directory saved',
        outputDir: body.outputDir
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to save output directory: ${(error as Error).message}`
      };
    }
  }

  /**
   * Get current output directory from config
   */
  @Get('output-dir')
  async getOutputDir() {
    try {
      const outputDir = this.configService.getOutputDir();
      return {
        success: true,
        outputDir: outputDir || null
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to get output directory: ${(error as Error).message}`
      };
    }
  }

  /**
   * Save console logs to the logs directory
   */
  @Post('save-logs')
  async saveLogs(@Body() body: { content: string }) {
    try {
      // Get logs directory
      const logsDir = path.join(process.env.HOME || '', 'Library', 'Logs', 'ClipChimp');

      // Ensure logs directory exists
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      // Create filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `clipchimp-console-${timestamp}.txt`;
      const filePath = path.join(logsDir, filename);

      // Save logs
      fs.writeFileSync(filePath, body.content, 'utf8');

      return {
        success: true,
        message: 'Logs saved successfully',
        path: filePath
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to save logs: ${(error as Error).message}`
      };
    }
  }

  /**
   * Get analysis categories
   */
  @Get('analysis-categories')
  async getAnalysisCategories() {
    try {
      const categoriesPath = path.join(path.dirname(this.configPath), 'analysis-categories.json');

      if (fs.existsSync(categoriesPath)) {
        const data = fs.readFileSync(categoriesPath, 'utf8');
        return JSON.parse(data);
      }

      return { categories: null }; // Frontend will use defaults
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to get analysis categories: ${(error as Error).message}`
      };
    }
  }

  /**
   * Save analysis categories
   */
  @Post('analysis-categories')
  async saveAnalysisCategories(@Body() body: { categories: any[] }) {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const categoriesPath = path.join(configDir, 'analysis-categories.json');

      // Save categories
      fs.writeFileSync(categoriesPath, JSON.stringify({
        categories: body.categories,
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf8');

      // Also update the Python prompt file with the new categories
      await this.updateAnalysisPrompt(body.categories);

      return {
        success: true,
        message: 'Analysis categories saved'
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to save analysis categories: ${(error as Error).message}`
      };
    }
  }

  /**
   * Save default AI settings
   */
  @Post('default-ai')
  async saveDefaultAI(@Body() body: { provider: string; model: string }) {
    try {
      // Ensure config directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Read existing config or create new one
      let config: any = {};
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        config = JSON.parse(configData);
      }

      // Update default AI settings
      config.defaultAI = {
        provider: body.provider,
        model: body.model
      };
      config.lastUpdated = new Date().toISOString();

      // Save config
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');

      return {
        success: true,
        message: 'Default AI settings saved',
        defaultAI: config.defaultAI
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to save default AI settings: ${(error as Error).message}`
      };
    }
  }

  /**
   * Get default AI settings
   */
  @Get('default-ai')
  async getDefaultAI() {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const config = JSON.parse(configData);

        return {
          success: true,
          defaultAI: config.defaultAI || null
        };
      }

      return {
        success: true,
        defaultAI: null
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to get default AI settings: ${(error as Error).message}`
      };
    }
  }

  /**
   * Update the analysis prompt Python file with new categories
   */
  private async updateAnalysisPrompt(categories: any[]) {
    try {
      // Build categories list for the prompt
      const enabledCategories = categories.filter(c => c.enabled);

      // Create the category descriptions for the prompt
      const categoryDescriptions = enabledCategories
        .filter(c => c.name !== 'routine')
        .map(c => `- **${c.name}** - ${c.description}`)
        .join('\n');

      // Create the category list for JSON format
      const categoryList = enabledCategories.map(c => c.name).join(', ');

      // Path to prompt file
      const promptPath = path.join(__dirname, '..', '..', 'python', 'analysis_prompts.py');

      if (fs.existsSync(promptPath)) {
        let content = fs.readFileSync(promptPath, 'utf8');

        // Update the category list in the IMPORTANT RULES section
        const categoryRuleRegex = /- Category must be EXACTLY ONE of: [^\n]+/;
        const newCategoryRule = `- Category must be EXACTLY ONE of: ${categoryList} (pick the SINGLE most relevant category, do NOT combine multiple)`;
        content = content.replace(categoryRuleRegex, newCategoryRule);

        // Update the example category list in the JSON format section
        const jsonCategoryRegex = /"category": "ONE of: [^"]+"/g;
        const newJsonCategory = `"category": "ONE of: ${categoryList}"`;
        content = content.replace(jsonCategoryRegex, newJsonCategory);

        fs.writeFileSync(promptPath, content, 'utf8');
      }
    } catch (error) {
      console.error('Failed to update analysis prompt:', error);
      // Don't throw - saving categories should still succeed
    }
  }

  /**
   * Fetch available models from OpenAI API
   * Returns top 3 GPT-4 class models sorted by creation date (newest first)
   */
  @Get('openai-models')
  async getOpenAIModels() {
    try {
      const apiKey = this.apiKeysService.getOpenAiApiKey();
      if (!apiKey) {
        return { success: false, models: [], message: 'No OpenAI API key configured' };
      }

      const response = await fetch('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (!response.ok) {
        return { success: false, models: [], message: `OpenAI API error: ${response.status}` };
      }

      const data = await response.json();

      // Only include specific known chat models - whitelist approach
      const allowedModels = [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4-turbo-preview',
        'gpt-4',
        'o1',
        'o1-mini',
        'o1-preview',
      ];

      const gptModels = data.data
        .filter((m: any) => allowedModels.includes(m.id))
        .sort((a: any, b: any) => b.created - a.created)
        .map((m: any) => ({
          value: `openai:${m.id}`,
          label: this.formatOpenAIModelName(m.id),
          id: m.id,
          created: m.created,
        }));

      return { success: true, models: gptModels };
    } catch (error: any) {
      return { success: false, models: [], message: error.message };
    }
  }

  /**
   * Fetch available models from Anthropic/Claude API
   * Returns models sorted by release date (newest first)
   */
  @Get('claude-models')
  async getClaudeModels() {
    try {
      const apiKey = this.apiKeysService.getClaudeApiKey();
      if (!apiKey) {
        return { success: false, models: [], message: 'No Claude API key configured' };
      }

      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });

      if (!response.ok) {
        return { success: false, models: [], message: `Anthropic API error: ${response.status}` };
      }

      const data = await response.json();

      // Only include text-based Claude chat models (exclude audio, vision-only, etc.)
      const claudeModels = data.data
        .filter((m: any) => {
          const id = m.id.toLowerCase();
          // Must be a Claude model
          if (!id.includes('claude')) return false;
          // Exclude audio models
          if (id.includes('audio')) return false;
          // Exclude vision-only models (but claude-3-5-sonnet with vision is ok for text too)
          if (id.includes('vision') && !id.includes('sonnet') && !id.includes('opus')) return false;
          return true;
        })
        .slice(0, 5) // Get top 5
        .map((m: any) => ({
          value: `claude:${m.id}`,
          label: this.formatClaudeModelName(m.id, m.display_name),
          id: m.id,
          created: m.created_at,
        }));

      return { success: true, models: claudeModels };
    } catch (error: any) {
      return { success: false, models: [], message: error.message };
    }
  }

  /**
   * Format OpenAI model ID to human-readable name
   */
  private formatOpenAIModelName(modelId: string): string {
    const nameMap: Record<string, string> = {
      'gpt-4o': 'GPT-4o',
      'gpt-4o-mini': 'GPT-4o Mini',
      'gpt-4-turbo': 'GPT-4 Turbo',
      'gpt-4-turbo-preview': 'GPT-4 Turbo Preview',
      'gpt-4': 'GPT-4',
      'o1': 'O1',
      'o1-mini': 'O1 Mini',
      'o1-preview': 'O1 Preview',
    };
    return nameMap[modelId] || modelId.toUpperCase().replace(/-/g, ' ');
  }

  /**
   * Format Claude model ID to human-readable name
   */
  private formatClaudeModelName(modelId: string, displayName?: string): string {
    if (displayName) return displayName;

    // Convert model ID like "claude-sonnet-4-20250514" to "Claude Sonnet 4"
    return modelId
      .replace('claude-', 'Claude ')
      .replace(/-\d{8}$/, '') // Remove date suffix
      .replace(/-latest$/, '')
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
