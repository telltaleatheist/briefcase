import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ElectronService } from './electron.service';

interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error' | 'info';
  message: string;
  data?: any;
}

@Injectable({
  providedIn: 'root'
})
export class LoggerService {
  private http = inject(HttpClient);
  private electronService = inject(ElectronService);
  private readonly API_BASE = 'http://localhost:3000/api';
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private autoSaveInterval: any;
  private lastSavedCount = 0;

  constructor() {
    this.interceptConsole();
    this.setupAutoSave();
    this.setupBeforeUnload();
  }

  private setupAutoSave() {
    // Auto-save logs every 30 seconds if there are new logs
    this.autoSaveInterval = setInterval(() => {
      if (this.logs.length > this.lastSavedCount) {
        this.saveLogsToFile();
      }
    }, 30000);
  }

  private setupBeforeUnload() {
    // Save logs when the window is about to close
    window.addEventListener('beforeunload', () => {
      this.saveLogsToFile();
    });
  }

  private async saveLogsToFile() {
    if (!this.electronService.isElectron || this.logs.length === 0) {
      return;
    }

    const content = this.exportLogs();
    const filename = `clipchimp-console-${new Date().toISOString().split('T')[0]}.txt`;

    try {
      await this.electronService.saveConsoleLogs(filename, content);
      this.lastSavedCount = this.logs.length;
    } catch (error) {
      // Don't log this error to avoid infinite loop
    }
  }

  private interceptConsole() {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalInfo = console.info;

    console.log = (...args: any[]) => {
      this.addLog('log', args);
      originalLog.apply(console, args);
    };

    console.warn = (...args: any[]) => {
      this.addLog('warn', args);
      originalWarn.apply(console, args);
    };

    console.error = (...args: any[]) => {
      this.addLog('error', args);
      originalError.apply(console, args);
    };

    console.info = (...args: any[]) => {
      this.addLog('info', args);
      originalInfo.apply(console, args);
    };
  }

  private addLog(level: LogEntry['level'], args: any[]) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: args.map(arg => {
        try {
          if (typeof arg === 'object') {
            return JSON.stringify(arg, null, 2);
          }
          return String(arg);
        } catch {
          return '[Unserializable]';
        }
      }).join(' ')
    };

    this.logs.push(entry);

    // Keep only last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
  }

  exportLogs(): string {
    return this.logs.map(entry =>
      `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`
    ).join('\n');
  }

  downloadLogs() {
    const content = this.exportLogs();

    // Save to backend (which saves to ~/Library/Logs/clipchimp/)
    this.http.post<any>(`${this.API_BASE}/config/save-logs`, { content }).subscribe({
      next: (response) => {
        if (response.success) {
          console.log('Logs saved to:', response.path);
        } else {
          console.error('Failed to save logs:', response.message);
        }
      },
      error: (error) => {
        console.error('Failed to save logs:', error);
      }
    });
  }
}
