import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Settings } from '../models/settings.model';
import { PathService } from './path.service';
import { LoggerService } from '../core/logger.service';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private pathService = inject(PathService);
  
  private readonly STORAGE_KEY = 'clippy_settings';
  private defaultSettings: Settings = {
    quality: "720",
    convertToMp4: true,
    fixAspectRatio: true,
    useCookies: false,
    browser: "auto",
    theme: "light",
    outputDir: "",
    batchProcessingEnabled: true,
    maxConcurrentDownloads: 2
  };

  private settingsSubject = new BehaviorSubject<Settings>(this.defaultSettings);
  
  constructor(private logger: LoggerService) {
    this.logger.debug('Logger initialized in settings');
    this.loadSettings();
  }

  /**
   * Load settings from local storage
   */
  private loadSettings(): void {
    const storedSettings = localStorage.getItem(this.STORAGE_KEY);
    
    if (storedSettings) {
      try {
        const parsedSettings = JSON.parse(storedSettings);
        this.settingsSubject.next({
          ...this.defaultSettings,
          ...parsedSettings
        });
      } catch (error) {
        console.error('Error parsing stored settings:', error);
        this.settingsSubject.next(this.defaultSettings);
      }
    } else {
      // If no settings found, initialize with default settings and get default path
      this.initializeDefaultPath();
    }
  }
  
  /**
   * Get the default download path from the server and save it in settings
   */
  private initializeDefaultPath(): void {
    this.pathService.getDefaultPath().subscribe({
      next: (response) => {
        if (response.success) {
          const settings = {
            ...this.defaultSettings,
            outputDir: response.path
          };
          this.settingsSubject.next(settings);
          this.saveSettingsToStorage(settings);
        }
      },
      error: (error) => {
        console.error('Error getting default path:', error);
        this.settingsSubject.next(this.defaultSettings);
      }
    });
  }
  
  /**
   * Save settings to local storage
   */
  private saveSettingsToStorage(settings: Settings): void {
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
  }
  
  /**
   * Get current settings as observable
   */
  getSettings(): Observable<Settings> {
    return this.settingsSubject.asObservable();
  }
  
  /**
   * Get current settings value
   */
  getCurrentSettings(): Settings {
    return this.settingsSubject.getValue();
  }
  
  /**
   * Update settings
   */
  updateSettings(settings: Settings): void {
    const updatedSettings = {
      ...this.settingsSubject.getValue(),
      ...settings
    };
    
    this.settingsSubject.next(updatedSettings);
    this.saveSettingsToStorage(updatedSettings);
  }
  
  /**
   * Reset settings to defaults
   */
  resetSettings(): void {
    // When resetting, fetch the default path from the server
    this.pathService.getDefaultPath().subscribe({
      next: (response) => {
        if (response.success) {
          const resetSettings = {
            ...this.defaultSettings,
            outputDir: response.path
          };
          this.settingsSubject.next(resetSettings);
          this.saveSettingsToStorage(resetSettings);
        } else {
          this.settingsSubject.next(this.defaultSettings);
          this.saveSettingsToStorage(this.defaultSettings);
        }
      },
      error: (_) => {
        // If we can't get the default path, just use empty string
        this.settingsSubject.next(this.defaultSettings);
        this.saveSettingsToStorage(this.defaultSettings);
      }
    });
  }
}