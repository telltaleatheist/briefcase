// clippy/electron/config/server-config.ts
import * as log from 'electron-log';
import { EnvironmentUtil, ServerConfig as EnvServerConfig } from '../environment.util';

/**
 * Server configuration service
 * Manages server configuration for both backend and frontend servers
 */
export class ServerConfig {
  private static _config: EnvServerConfig | null = null;

  /**
   * Get server configuration, with environment variable overrides
   */
  static get config(): EnvServerConfig {
    if (!this._config) {
      this._config = EnvironmentUtil.getServerConfig();
    }
    return this._config;
  }

  /**
   * Get the backend URL
   */
  static get backendUrl(): string {
    const { host, port } = this.config.nestBackend;
    return `http://${host}:${port}`;
  }

  /**
   * Get the frontend URL
   */
  static get frontendUrl(): string {
    const { host, port } = this.config.electronServer;
    return `http://${host}:${port}`;
  }

  /**
   * Check if the backend server is running
   */
  static async isBackendRunning(): Promise<boolean> {
    const { host, port } = this.config.nestBackend;
    
    return new Promise((resolve) => {
      const http = require('http');
      const req = http.request({
        hostname: host,
        port: port,
        path: '/api',
        method: 'GET',
        timeout: 2000
      }, (res: { statusCode: number; }) => {
        log.info(`Backend check response status: ${res.statusCode}`);
        resolve(res.statusCode === 200);
      });
      
      req.on('error', (err: { message: any; }) => {
        log.error(`Backend check error: ${err.message}`);
        resolve(false);
      });
      
      req.on('timeout', () => {
        log.error('Backend check timeout');
        req.destroy();
        resolve(false);
      });
      
      req.end();
    });
  }
}