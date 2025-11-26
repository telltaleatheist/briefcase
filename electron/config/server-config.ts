// ClipChimp/electron/config/server-config.ts
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
   * Note: Uses localhost if host is 0.0.0.0 since that's for binding, not connecting
   */
  static get backendUrl(): string {
    const { host, port } = this.config.nestBackend;
    const connectHost = host === '0.0.0.0' ? 'localhost' : host;
    return `http://${connectHost}:${port}`;
  }

  /**
   * Get the frontend URL
   * Note: Uses localhost if host is 0.0.0.0 since that's for binding, not connecting
   */
  static get frontendUrl(): string {
    const { host, port } = this.config.electronServer;
    const connectHost = host === '0.0.0.0' ? 'localhost' : host;
    return `http://${connectHost}:${port}`;
  }

  /**
   * Check if the backend server is running
   */
  static async isBackendRunning(): Promise<boolean> {
    const { host, port } = this.config.nestBackend;
    // Use localhost if host is 0.0.0.0 since that's for binding, not connecting
    const connectHost = host === '0.0.0.0' ? 'localhost' : host;

    return new Promise((resolve) => {
      const http = require('http');
      const req = http.request({
        hostname: connectHost,
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