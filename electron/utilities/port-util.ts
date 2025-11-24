// ClipChimp/electron/utilities/port-util.ts
import * as net from 'net';
import * as log from 'electron-log';

/**
 * Port utility for checking port availability and finding free ports
 */
export class PortUtil {
  /**
   * Check if a port is available on both IPv4 and IPv6
   */
  static async isPortAvailable(port: number, host: string = 'localhost'): Promise<boolean> {
    // Check IPv4
    const ipv4Available = await this.checkPortOnHost(port, host);
    if (!ipv4Available) {
      return false;
    }

    // Check IPv6 (backend binds to :: which is IPv6 all interfaces)
    const ipv6Available = await this.checkPortOnHost(port, '::');
    return ipv6Available;
  }

  /**
   * Check if a port is available on a specific host
   */
  private static async checkPortOnHost(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();

      server.once('error', (err: NodeJS.ErrnoException) => {
        resolve(false);
      });

      server.once('listening', () => {
        server.close();
        resolve(true);
      });

      server.listen(port, host);
    });
  }

  /**
   * Find an available port starting from a given port
   * @param startPort - The port to start checking from
   * @param maxAttempts - Maximum number of ports to try
   * @returns Available port number or null if none found
   */
  static async findAvailablePort(startPort: number, maxAttempts: number = 10): Promise<number | null> {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      const available = await this.isPortAvailable(port);

      if (available) {
        log.info(`Found available port: ${port}`);
        return port;
      }

      log.info(`Port ${port} is in use, trying next port...`);
    }

    log.error(`Could not find available port after ${maxAttempts} attempts`);
    return null;
  }

  /**
   * Kill process using a specific port (cross-platform)
   */
  static async killProcessOnPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      let command: string;

      if (process.platform === 'win32') {
        // Windows: Find and kill process using port
        command = `FOR /F "tokens=5" %P IN ('netstat -a -n -o ^| findstr :${port}') DO TaskKill.exe /PID %P /F`;
      } else {
        // Unix-like (macOS, Linux): Find and kill process using port
        // Use -9 to force kill, and loop to make sure we get all processes
        command = `lsof -ti:${port} | while read pid; do kill -9 $pid 2>/dev/null; done; exit 0`;
      }

      exec(command, (error: Error | null) => {
        if (error) {
          log.warn(`Could not kill process on port ${port}: ${error.message}`);
          resolve(false);
        } else {
          log.info(`Successfully attempted to kill process on port ${port}`);
          resolve(true);
        }
      });
    });
  }

  /**
   * Attempt to free a port by killing the process using it
   * @param port - The port to free
   * @param timeout - Time to wait after killing process (ms)
   */
  static async attemptToFreePort(port: number, timeout: number = 2000): Promise<boolean> {
    const wasAvailable = await this.isPortAvailable(port);
    if (wasAvailable) {
      return true;
    }

    log.info(`Attempting to free port ${port}...`);
    const killed = await this.killProcessOnPort(port);

    if (killed) {
      // Wait for the port to be released - increased from 1s to 2s for zombie processes
      await new Promise(resolve => setTimeout(resolve, timeout));

      // Check if port is now available
      const isNowAvailable = await this.isPortAvailable(port);
      if (isNowAvailable) {
        log.info(`Successfully freed port ${port}`);
      } else {
        log.warn(`Port ${port} still in use after kill attempt`);
      }
      return isNowAvailable;
    }

    return false;
  }
}
