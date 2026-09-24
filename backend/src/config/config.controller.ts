import { Controller, Post, Body, Get, OnModuleInit } from '@nestjs/common';
import { SharedConfigService } from './shared-config.service';
import { DEFAULT_PROMPTS, DEFAULT_CATEGORIES } from '../analysis/prompts/analysis-prompts';
import * as fs from 'fs';
import * as path from 'path';

@Controller('config')
export class ConfigController implements OnModuleInit {
  private configPath: string;
  private logsDir: string;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  // Log retention settings
  private readonly LOG_MAX_AGE_DAYS = 7; // Keep logs for 7 days
  private readonly LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // Run cleanup every 6 hours

  constructor(private readonly configService: SharedConfigService) {
    const userDataPath = process.env.APPDATA ||
                      (process.platform === 'darwin' ?
                      path.join(process.env.HOME || '', 'Library', 'Application Support') :
                      path.join(process.env.HOME || '', '.config'));

    this.configPath = path.join(userDataPath, 'briefcase', 'app-config.json');
    this.logsDir = ConfigController.getLogsDirectory();
  }

  /**
   * Resolve the platform-appropriate logs directory.
   * Must match the location used by the Winston logger (common/logger.ts).
   */
  private static getLogsDirectory(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '.';

    if (process.platform === 'darwin') {
      // macOS: ~/Library/Logs/briefcase
      return path.join(homeDir, 'Library', 'Logs', 'briefcase');
    } else if (process.platform === 'win32') {
      // Windows: %APPDATA%/briefcase/logs
      const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
      return path.join(appData, 'briefcase', 'logs');
    } else {
      // Linux: ~/.config/briefcase/logs
      return path.join(homeDir, '.config', 'briefcase', 'logs');
    }
  }

  onModuleInit() {
    // Run cleanup on startup
    this.cleanupOldLogs();

    // Schedule periodic cleanup
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupOldLogs();
    }, this.LOG_CLEANUP_INTERVAL_MS);
  }

  /**
   * Clean up old log files (console logs older than LOG_MAX_AGE_DAYS)
   */
  private cleanupOldLogs(): void {
    try {
      if (!fs.existsSync(this.logsDir)) {
        return;
      }

      const now = Date.now();
      const maxAge = this.LOG_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const files = fs.readdirSync(this.logsDir);

      let deletedCount = 0;
      for (const file of files) {
        // Only clean up frontend console log files (not Winston's backend.log files)
        if (!file.startsWith('briefcase-console-')) {
          continue;
        }

        const filePath = path.join(this.logsDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        console.log(`[LogCleanup] Deleted ${deletedCount} old log file(s)`);
      }
    } catch (error) {
      console.error('[LogCleanup] Error cleaning up logs:', error);
    }
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
      // Get logs directory (platform-aware; matches common/logger.ts)
      const logsDir = ConfigController.getLogsDirectory();

      // Ensure logs directory exists
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      // Create filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `briefcase-console-${timestamp}.txt`;
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
   * Reset analysis categories to defaults
   */
  @Post('analysis-categories/reset')
  async resetAnalysisCategories() {
    try {
      const categoriesPath = path.join(path.dirname(this.configPath), 'analysis-categories.json');

      if (fs.existsSync(categoriesPath)) {
        fs.unlinkSync(categoriesPath);
      }

      return {
        success: true,
        message: 'Analysis categories reset to defaults',
        categories: DEFAULT_CATEGORIES
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to reset analysis categories: ${(error as Error).message}`
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
   * Get custom analysis prompts
   * Returns user's custom prompts merged with defaults
   */
  @Get('analysis-prompts')
  async getAnalysisPrompts() {
    try {
      const promptsPath = path.join(path.dirname(this.configPath), 'analysis-prompts.json');

      let customPrompts: any = {};
      if (fs.existsSync(promptsPath)) {
        const data = fs.readFileSync(promptsPath, 'utf8');
        customPrompts = JSON.parse(data).prompts || {};
      }

      // Merge with defaults - custom prompts override defaults
      return {
        success: true,
        prompts: {
          description: customPrompts.description || DEFAULT_PROMPTS.description,
          title: customPrompts.title || DEFAULT_PROMPTS.title,
          tags: customPrompts.tags || DEFAULT_PROMPTS.tags,
          quotes: customPrompts.quotes || DEFAULT_PROMPTS.quotes,
        },
        defaults: DEFAULT_PROMPTS,
        hasCustom: {
          description: !!customPrompts.description,
          title: !!customPrompts.title,
          tags: !!customPrompts.tags,
          quotes: !!customPrompts.quotes,
        }
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to get analysis prompts: ${(error as Error).message}`,
        prompts: DEFAULT_PROMPTS,
        defaults: DEFAULT_PROMPTS,
        hasCustom: { description: false, title: false, tags: false, quotes: false }
      };
    }
  }

  /**
   * Save custom analysis prompts
   * Pass null or empty string to reset a prompt to default
   */
  @Post('analysis-prompts')
  async saveAnalysisPrompts(@Body() body: { prompts: { description?: string; title?: string; tags?: string; quotes?: string } }) {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const promptsPath = path.join(configDir, 'analysis-prompts.json');

      // Read existing prompts
      let existingPrompts: any = {};
      if (fs.existsSync(promptsPath)) {
        const data = fs.readFileSync(promptsPath, 'utf8');
        existingPrompts = JSON.parse(data).prompts || {};
      }

      // Merge new prompts (null/empty removes the custom prompt)
      const updatedPrompts: any = { ...existingPrompts };
      for (const [key, value] of Object.entries(body.prompts)) {
        if (value && value.trim()) {
          updatedPrompts[key] = value.trim();
        } else {
          delete updatedPrompts[key]; // Reset to default
        }
      }

      // Save prompts
      fs.writeFileSync(promptsPath, JSON.stringify({
        prompts: updatedPrompts,
        lastUpdated: new Date().toISOString()
      }, null, 2), 'utf8');

      return {
        success: true,
        message: 'Analysis prompts saved'
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to save analysis prompts: ${(error as Error).message}`
      };
    }
  }

  /**
   * Reset all analysis prompts to defaults
   */
  @Post('analysis-prompts/reset')
  async resetAnalysisPrompts() {
    try {
      const promptsPath = path.join(path.dirname(this.configPath), 'analysis-prompts.json');

      if (fs.existsSync(promptsPath)) {
        fs.unlinkSync(promptsPath);
      }

      return {
        success: true,
        message: 'Analysis prompts reset to defaults',
        prompts: DEFAULT_PROMPTS
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to reset analysis prompts: ${(error as Error).message}`
      };
    }
  }
}
