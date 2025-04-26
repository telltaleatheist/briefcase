import { Injectable } from '@angular/core';
import { environment } from '../../environment/environment';

@Injectable({
  providedIn: 'root',
})
export class LoggerService {
  info(message: string, ...optionalParams: any[]) {
    console.info(`[INFO] ${message}`, ...optionalParams);
    this.logToElectron(`[INFO] ${message}`, optionalParams);
  }

  warn(message: string, ...optionalParams: any[]) {
    console.warn(`[WARN] ${message}`, ...optionalParams);
    this.logToElectron(`[WARN] ${message}`, optionalParams);
  }

  error(message: string, ...optionalParams: any[]) {
    console.error(`[ERROR] ${message}`, ...optionalParams);
    this.logToElectron(`[ERROR] ${message}`, optionalParams);
  }

  debug(message: string, ...optionalParams: any[]) {
    if (environment.production) return;
    console.debug(`[DEBUG] ${message}`, ...optionalParams);
    this.logToElectron(`[DEBUG] ${message}`, optionalParams);
  }

  private logToElectron(message: string, optionalParams: any[]) {
    try {
      (window as any).logger?.info?.(message, ...optionalParams);
    } catch {
      // Fail silently if Electron context isn’t available
    }
  }
}
