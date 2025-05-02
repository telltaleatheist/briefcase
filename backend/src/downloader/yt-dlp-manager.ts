import YTDlpWrap from 'yt-dlp-wrap-extended';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { SharedConfigService } from '../config/shared-config.service';

export class YtDlpManager {
  private static instance: YTDlpWrap;
  private inputUrl: string | null = null;
  private outputTemplate: string | null = null;
  private options: string[] = [];
  private readonly sharedConfigService: SharedConfigService;

  constructor() {
    if (!YtDlpManager.instance) {
      YtDlpManager.instance = this.createYtDlpWrap();
    }
  }

  private createYtDlpWrap(): YTDlpWrap {
    // First try to use the configured path from environment variable
    if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
      log.info(`Using configured yt-dlp path: ${process.env.YT_DLP_PATH}`);
      return new YTDlpWrap(process.env.YT_DLP_PATH);
    }

    log.warn('yt-dlp not found. Falling back to "yt-dlp" string.');
    const ytDlpPath = this.sharedConfigService.getYtDlpPath();
    if (!ytDlpPath) {
      throw new Error('yt-dlp path is not defined in the shared configuration.');
    }
    return new YTDlpWrap(ytDlpPath);
  }

  input(url: string): YtDlpManager {
    this.inputUrl = url;
    return this;
  }

  output(template: string): YtDlpManager {
    this.outputTemplate = template;
    return this;
  }

  addOption(option: string, value?: string): YtDlpManager {
    if (value !== undefined) {
      this.options.push(option, value);
    } else {
      this.options.push(option);
    }
    return this;
  }

  async run(): Promise<string> {
    if (!this.inputUrl) {
      throw new Error('No input URL specified.');
    }

    const finalArgs: string[] = [];

    if (this.outputTemplate) {
      finalArgs.push('-o', this.outputTemplate);
    }

    finalArgs.push(...this.options);
    finalArgs.push(this.inputUrl);

    log.info(`Executing yt-dlp with args: ${finalArgs.join(' ')}`);

    try {
      const output = await YtDlpManager.instance.execPromise(finalArgs);
      return output;
    } catch (error) {
      log.error('yt-dlp execution failed:', error);
      throw error;
    }
  }
}