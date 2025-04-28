import YTDlpWrap from 'yt-dlp-wrap-extended';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

export class YtDlpManager {
  private static instance: YTDlpWrap;
  private inputUrl: string | null = null;
  private outputTemplate: string | null = null;
  private options: string[] = [];

  constructor() {
    if (!YtDlpManager.instance) {
      YtDlpManager.instance = this.createYtDlpWrap();
    }
  }

  private createYtDlpWrap(): YTDlpWrap {
    const pathFromSystem = this.findBinaryInPath('yt-dlp');
    if (pathFromSystem) {
      log.info(`Found yt-dlp in system PATH: ${pathFromSystem}`);
      return new YTDlpWrap(pathFromSystem);
    }

    const fallbackPaths = this.getCommonYtDlpPaths();
    for (const possiblePath of fallbackPaths) {
      if (fs.existsSync(possiblePath)) {
        log.info(`Found fallback yt-dlp at: ${possiblePath}`);
        return new YTDlpWrap(possiblePath);
      }
    }

    log.warn('yt-dlp not found. Falling back to "yt-dlp" string.');
    return new YTDlpWrap('yt-dlp');
  }

  private findBinaryInPath(binaryName: string): string | null {
    try {
      const command = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${command} ${binaryName}`, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
      if (fs.existsSync(result)) {
        return result;
      }
      return null;
    } catch {
      return null;
    }
  }

  private getCommonYtDlpPaths(): string[] {
    const paths: string[] = [];

    if (process.platform === 'darwin') {
      paths.push(
        '/usr/local/bin/yt-dlp',
        '/opt/homebrew/bin/yt-dlp',
        '/Library/Frameworks/Python.framework/Versions/3.14/bin/yt-dlp'
      );
    } else if (process.platform === 'win32') {
      paths.push(
        'C:\\Program Files\\yt-dlp\\yt-dlp.exe',
        'C:\\ProgramData\\yt-dlp\\yt-dlp.exe'
      );
    } else if (process.platform === 'linux') {
      paths.push(
        '/usr/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/snap/bin/yt-dlp'
      );
    }

    paths.push(path.join(__dirname, '../bin/yt-dlp'));
    return paths;
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
