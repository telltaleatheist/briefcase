// ClipChimp/electron/services/web-capture-service.ts
import { BrowserWindow, session } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';

export interface CaptureOptions {
  url: string;
  savePath: string;
  timeout?: number;
}

export interface CaptureResult {
  success: boolean;
  filePath?: string;
  method?: string;
  error?: string;
  pageTitle?: string;
}

/**
 * WebCaptureService - Captures web pages as MHTML files using Electron's BrowserWindow
 * Implements a strategy cascade for bypassing soft paywalls.
 */
export class WebCaptureService {

  /**
   * Capture a web page using a cascade of strategies
   */
  async captureWebPage(options: CaptureOptions): Promise<CaptureResult> {
    const { url, savePath, timeout = 30000 } = options;
    const strategies = [
      { name: 'google-referer', description: 'Load with Google referer' },
      { name: 'normal', description: 'Normal load' },
      { name: 'no-js', description: 'Load with JavaScript disabled' },
      { name: 'google-cache', description: 'Google Cache fallback' },
      { name: 'archive-org', description: 'Archive.org fallback' },
    ];

    for (const strategy of strategies) {
      log.info(`[WebCapture] Trying strategy: ${strategy.name} for ${url}`);
      try {
        const result = await this.doCapture(url, savePath, strategy.name, { timeout });
        if (result.success) {
          log.info(`[WebCapture] Success with strategy: ${strategy.name}`);
          return { ...result, method: strategy.name };
        }
      } catch (error: any) {
        log.warn(`[WebCapture] Strategy ${strategy.name} failed: ${error.message}`);
      }
    }

    return {
      success: false,
      error: 'All capture strategies failed',
    };
  }

  /**
   * Perform the actual capture with a hidden BrowserWindow
   */
  private async doCapture(
    url: string,
    savePath: string,
    method: string,
    options: { timeout: number },
  ): Promise<CaptureResult> {
    let captureUrl = url;
    const webPreferences: Electron.WebPreferences = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    };

    // Strategy-specific URL transformations
    if (method === 'google-cache') {
      captureUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    } else if (method === 'archive-org') {
      captureUrl = `https://web.archive.org/web/2/${url}`;
    }

    if (method === 'no-js') {
      webPreferences.javascript = false;
    }

    // Create a partition so capture sessions don't leak cookies
    const partitionName = `capture-${Date.now()}`;
    const captureSession = session.fromPartition(partitionName, { cache: false });

    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        ...webPreferences,
        session: captureSession,
      },
    });

    try {
      // Set Google referer for the first strategy
      if (method === 'google-referer') {
        captureSession.webRequest.onBeforeSendHeaders((details, callback) => {
          details.requestHeaders['Referer'] = 'https://www.google.com/';
          callback({ requestHeaders: details.requestHeaders });
        });
      }

      // Load the URL
      await win.loadURL(captureUrl, {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      // Wait for network idle
      await this.waitForNetworkIdle(win, options.timeout);

      // Get the page title
      const pageTitle = win.webContents.getTitle();

      // Ensure the save directory exists
      const saveDir = path.dirname(savePath);
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }

      // Save as MHTML
      await win.webContents.savePage(savePath, 'MHTML');

      // Verify the file was created
      if (!fs.existsSync(savePath) || fs.statSync(savePath).size === 0) {
        return { success: false, error: 'MHTML file was empty or not created' };
      }

      return { success: true, filePath: savePath, pageTitle };
    } finally {
      win.destroy();
    }
  }

  /**
   * Wait for network to become idle (no requests for 2 seconds)
   */
  private waitForNetworkIdle(win: BrowserWindow, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let pendingRequests = 0;
      let idleTimer: NodeJS.Timeout | null = null;
      const idleDelay = 2000; // 2 seconds of no activity

      const timeoutTimer = setTimeout(() => {
        cleanup();
        // Resolve even on timeout - we have some content loaded
        resolve();
      }, timeout);

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (pendingRequests <= 0) {
            cleanup();
            resolve();
          }
        }, idleDelay);
      };

      const onBeforeRequest = (details: any, callback: any) => {
        pendingRequests++;
        callback({});
      };

      const onCompleted = () => {
        pendingRequests = Math.max(0, pendingRequests - 1);
        resetIdleTimer();
      };

      const onErrorOccurred = () => {
        pendingRequests = Math.max(0, pendingRequests - 1);
        resetIdleTimer();
      };

      const webRequest = win.webContents.session.webRequest;
      webRequest.onBeforeRequest(onBeforeRequest);
      webRequest.onCompleted(onCompleted);
      webRequest.onErrorOccurred(onErrorOccurred);

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (idleTimer) clearTimeout(idleTimer);
        // Remove listeners by setting to null
        webRequest.onBeforeRequest(null as any);
        webRequest.onCompleted(null as any);
        webRequest.onErrorOccurred(null as any);
      };

      // Start the idle timer immediately in case page is already loaded
      resetIdleTimer();
    });
  }

  /**
   * Fetch a favicon for a domain
   * Uses Google's favicon service and caches locally
   */
  async fetchFavicon(domain: string, saveDir: string): Promise<string | null> {
    const faviconPath = path.join(saveDir, `${domain}.png`);

    // Return cached if exists
    if (fs.existsSync(faviconPath)) {
      return faviconPath;
    }

    // Ensure directory exists
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }

    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

    return new Promise((resolve) => {
      const request = https.get(faviconUrl, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            const mod = redirectUrl.startsWith('https') ? https : http;
            mod.get(redirectUrl, (res2) => {
              if (res2.statusCode === 200) {
                const fileStream = fs.createWriteStream(faviconPath);
                res2.pipe(fileStream);
                fileStream.on('finish', () => {
                  fileStream.close();
                  resolve(faviconPath);
                });
              } else {
                resolve(null);
              }
            }).on('error', () => resolve(null));
          } else {
            resolve(null);
          }
          return;
        }

        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }

        const fileStream = fs.createWriteStream(faviconPath);
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve(faviconPath);
        });
      });

      request.on('error', (error) => {
        log.error(`[WebCapture] Failed to fetch favicon for ${domain}:`, error);
        resolve(null);
      });

      request.setTimeout(10000, () => {
        request.destroy();
        resolve(null);
      });
    });
  }
}
