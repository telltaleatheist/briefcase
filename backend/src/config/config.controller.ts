import { Controller, Post, Body, Get } from '@nestjs/common';
import { SharedConfigService } from './shared-config.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('config')
export class ConfigController {
  private configPath: string;

  constructor(private readonly configService: SharedConfigService) {
    const userDataPath = process.env.APPDATA ||
                      (process.platform === 'darwin' ?
                      path.join(process.env.HOME || '', 'Library', 'Application Support') :
                      path.join(process.env.HOME || '', '.config'));

    this.configPath = path.join(userDataPath, 'clippy', 'app-config.json');
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
      const logsDir = path.join(process.env.HOME || '', 'Library', 'Logs', 'clippy');

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
}
