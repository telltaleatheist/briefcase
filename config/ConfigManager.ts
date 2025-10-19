// config/ConfigManager.ts
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import { app } from 'electron';

export interface PathConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  ytDlpPath?: string;
  lastUpdated?: string; // ISO string date
}

export class ConfigManager {
  private configPath: string;
  private config: PathConfig = {};
  private static instance: ConfigManager;

  private constructor() {
    // Make sure it's a directory that persists across app updates
    this.configPath = path.join(app.getPath('userData'), 'app-config.json');
    this.loadConfig();
  }

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(configData);
      } else {
        log.info(`No config file found at ${this.configPath}, using defaults`);
        this.config = {};
      }
    } catch (error) {
      log.error('Failed to load config:', error);
      this.config = {};
    }
  }

  saveConfig(): boolean {
    try {
      // Update last updated timestamp
      this.config.lastUpdated = new Date().toISOString();
      
      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      log.info(`Config saved to ${this.configPath}`);
      return true;
    } catch (error) {
      log.error('Failed to save config:', error);
      return false;
    }
  }

  getConfig(): PathConfig {
    return { ...this.config }; // Return a copy to prevent direct mutation
  }

  updateConfig(newConfig: Partial<PathConfig>): boolean {
    this.config = { ...this.config, ...newConfig };
    return this.saveConfig();
  }

  hasRequiredPaths(): boolean {
    return Boolean(
      this.config.ffmpegPath && 
      this.config.ffprobePath && 
      this.config.ytDlpPath
    );
  }

  clearConfig(): boolean {
    this.config = {};
    return this.saveConfig();
  }
}