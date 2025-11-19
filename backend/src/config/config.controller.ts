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
}
