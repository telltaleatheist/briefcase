import { Injectable } from '@angular/core';
import { environment } from '../../environment/environment';

@Injectable({
  providedIn: 'root'
})
export class ConsoleLoggerService {
  private logs: string[] = [];
  private maxLogs = 5000; // Keep last 5000 logs
  private isCapturing = false;
  private autoSaveInterval: any;

  constructor() {
    // Auto-enable capturing
    this.startCapturing();

    // Auto-save logs every 5 minutes
    this.autoSaveInterval = setInterval(() => {
      this.autoSaveLogs();
    }, 5 * 60 * 1000);
  }

  /**
   * Start capturing console logs
   */
  startCapturing(): void {
    if (this.isCapturing) return;

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: any[]) => {
      this.addLog('LOG', args);
      originalLog.apply(console, args);
    };

    console.warn = (...args: any[]) => {
      this.addLog('WARN', args);
      originalWarn.apply(console, args);
    };

    console.error = (...args: any[]) => {
      this.addLog('ERROR', args);
      originalError.apply(console, args);
    };

    this.isCapturing = true;
    console.log('[ConsoleLogger] Started capturing console logs');
  }

  /**
   * Add log entry
   */
  private addLog(level: string, args: any[]): void {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    const logEntry = `[${timestamp}] [${level}] ${message}`;

    this.logs.push(logEntry);

    // Keep only last N logs to prevent memory issues
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  /**
   * Get all captured logs
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Auto-save logs to file (using Electron IPC)
   */
  private async autoSaveLogs(): Promise<void> {
    if (this.logs.length === 0) return;

    try {
      const logText = this.logs.join('\n');
      const filename = `frontend-console-${new Date().toISOString().split('T')[0]}.log`;

      // Use Electron IPC to save to logs directory
      if ((window as any).electron?.saveConsoleLogs) {
        await (window as any).electron.saveConsoleLogs(filename, logText);
        console.log(`[ConsoleLogger] Auto-saved ${this.logs.length} logs to ${filename}`);
      }
    } catch (error) {
      console.error('[ConsoleLogger] Failed to auto-save logs:', error);
    }
  }

  /**
   * Export logs as text file (download)
   */
  exportLogs(): void {
    const logText = this.logs.join('\n');
    const blob = new Blob([logText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `console-logs-${new Date().toISOString()}.txt`;
    link.click();
    window.URL.revokeObjectURL(url);
  }

  /**
   * Save logs to file using Electron
   */
  async saveLogs(): Promise<void> {
    if (this.logs.length === 0) {
      console.warn('[ConsoleLogger] No logs to save');
      return;
    }

    try {
      const logText = this.logs.join('\n');
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const filename = `frontend-console-${timestamp}.log`;

      // Use Electron IPC to save to logs directory
      if ((window as any).electron?.saveConsoleLogs) {
        await (window as any).electron.saveConsoleLogs(filename, logText);
        console.log(`[ConsoleLogger] Saved ${this.logs.length} logs to ${filename}`);
        return;
      }

      // Fallback to browser download
      this.exportLogs();
    } catch (error) {
      console.error('[ConsoleLogger] Failed to save logs:', error);
      // Fallback to browser download
      this.exportLogs();
    }
  }

  /**
   * Clear captured logs
   */
  clearLogs(): void {
    this.logs = [];
    console.log('[ConsoleLogger] Logs cleared');
  }

  /**
   * Stop capturing
   */
  stopCapturing(): void {
    // Note: Can't easily restore original console methods after override
    // Would need to store references before overriding
    this.isCapturing = false;
  }
}
