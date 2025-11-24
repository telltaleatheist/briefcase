// backend/src/config/api-keys.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ApiKeysConfig {
  claudeApiKey?: string;
  openaiApiKey?: string;
  lastUsedProvider?: 'ollama' | 'claude' | 'openai';
  lastUsedModel?: string;
}

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);
  private configPath: string;
  private config: ApiKeysConfig = {};

  constructor() {
    // Store in user's app data directory (won't transfer with app)
    const userDataPath = this.getUserDataPath();
    this.configPath = path.join(userDataPath, 'clipchimp', 'api-keys.json');

    this.ensureConfigDirectoryExists();
    this.loadConfig();
  }

  /**
   * Get the appropriate user data path for each platform
   */
  private getUserDataPath(): string {
    const platform = process.platform;

    if (platform === 'win32') {
      return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else if (platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support');
    } else {
      return path.join(os.homedir(), '.config');
    }
  }

  /**
   * Ensure the config directory exists
   */
  private ensureConfigDirectoryExists(): void {
    const configDir = path.dirname(this.configPath);

    if (!fs.existsSync(configDir)) {
      try {
        fs.mkdirSync(configDir, { recursive: true });
        this.logger.log(`Created config directory: ${configDir}`);
      } catch (error) {
        this.logger.error(`Failed to create config directory: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Load configuration from file
   */
  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(data);
        this.logger.log('API keys configuration loaded');
      } else {
        this.logger.log('No existing API keys config found, starting fresh');
        this.config = {};
      }
    } catch (error) {
      this.logger.error(`Failed to load API keys config: ${(error as Error).message}`);
      this.config = {};
    }
  }

  /**
   * Save configuration to file
   */
  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      this.logger.log('API keys configuration saved');
    } catch (error) {
      this.logger.error(`Failed to save API keys config: ${(error as Error).message}`);
    }
  }

  /**
   * Get Claude API key
   */
  getClaudeApiKey(): string | undefined {
    return this.config.claudeApiKey;
  }

  /**
   * Set Claude API key
   */
  setClaudeApiKey(apiKey: string): void {
    this.config.claudeApiKey = apiKey;
    this.saveConfig();
  }

  /**
   * Get OpenAI API key
   */
  getOpenAiApiKey(): string | undefined {
    return this.config.openaiApiKey;
  }

  /**
   * Set OpenAI API key
   */
  setOpenAiApiKey(apiKey: string): void {
    this.config.openaiApiKey = apiKey;
    this.saveConfig();
  }

  /**
   * Get last used provider
   */
  getLastUsedProvider(): string | undefined {
    return this.config.lastUsedProvider;
  }

  /**
   * Set last used provider
   */
  setLastUsedProvider(provider: 'ollama' | 'claude' | 'openai'): void {
    this.config.lastUsedProvider = provider;
    this.saveConfig();
  }

  /**
   * Get last used model
   */
  getLastUsedModel(): string | undefined {
    return this.config.lastUsedModel;
  }

  /**
   * Set last used model
   */
  setLastUsedModel(model: string): void {
    this.config.lastUsedModel = model;
    this.saveConfig();
  }

  /**
   * Get all API keys (for settings display - keys will be masked)
   */
  getAllKeys(): { claude: boolean; openai: boolean } {
    return {
      claude: !!this.config.claudeApiKey,
      openai: !!this.config.openaiApiKey,
    };
  }

  /**
   * Clear all API keys
   */
  clearAllKeys(): void {
    this.config.claudeApiKey = undefined;
    this.config.openaiApiKey = undefined;
    this.saveConfig();
  }

  /**
   * Get full config (for returning to frontend)
   */
  getConfig(): ApiKeysConfig {
    return {
      lastUsedProvider: this.config.lastUsedProvider,
      lastUsedModel: this.config.lastUsedModel,
      // Don't return actual API keys - just indicate if they exist
      claudeApiKey: this.config.claudeApiKey ? '***' : undefined,
      openaiApiKey: this.config.openaiApiKey ? '***' : undefined,
    };
  }

  /**
   * Update full config
   */
  updateConfig(updates: Partial<ApiKeysConfig>): void {
    // Only update keys if new values are provided and not masked
    if (updates.claudeApiKey && updates.claudeApiKey !== '***') {
      this.config.claudeApiKey = updates.claudeApiKey;
    }

    if (updates.openaiApiKey && updates.openaiApiKey !== '***') {
      this.config.openaiApiKey = updates.openaiApiKey;
    }

    if (updates.lastUsedProvider) {
      this.config.lastUsedProvider = updates.lastUsedProvider;
    }

    if (updates.lastUsedModel) {
      this.config.lastUsedModel = updates.lastUsedModel;
    }

    this.saveConfig();
  }
}
