// frontend/src/app/services/config.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, from } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';

export interface PathConfig {
  ffmpegPath?: string;
  ffprobePath?: string;
  ytDlpPath?: string;
  lastUpdated?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ConfigService {
  private pathConfigSubject = new BehaviorSubject<PathConfig | null>(null);
  private configStatus = new BehaviorSubject<boolean | null>(null);

  constructor() {
    // Check configuration on initialization
    this.checkPathConfiguration();
  }

  /**
   * Check if path configuration is valid
   */
  checkPathConfiguration(): Observable<boolean> {
    return from(window.electronAPI.checkPathConfig()).pipe(
      tap((result: any) => {
        this.configStatus.next(result.isValid);
        
        if (result.isValid) {
          // If config is valid, get the current configuration
          this.getPathConfiguration().subscribe();
        }
      }),
      catchError(error => {
        console.error('Error checking path configuration:', error);
        this.configStatus.next(false);
        throw error;
      })
    );
  }

  /**
   * Get current path configuration
   */
  getPathConfiguration(): Observable<PathConfig> {
    return from(window.electronAPI.getPathConfig()).pipe(
      tap((config: PathConfig) => {
        this.pathConfigSubject.next(config);
      }),
      catchError(error => {
        console.error('Error getting path configuration:', error);
        throw error;
      })
    );
  }

  /**
   * Update path configuration
   */
  updatePathConfiguration(config: PathConfig): Observable<{ success: boolean }> {
    return from(window.electronAPI.updatePathConfig(config)).pipe(
      tap((result: { success: boolean }) => {
        if (result.success) {
          this.pathConfigSubject.next(config);
          this.configStatus.next(true);
        }
      }),
      catchError(error => {
        console.error('Error updating path configuration:', error);
        throw error;
      })
    );
  }

  /**
   * Show path configuration dialog
   */
  showPathConfigDialog(): Observable<boolean> {
    return from(window.electronAPI.showPathConfigDialog()).pipe(
      tap((result: boolean) => {
        if (result) {
          // Dialog was confirmed, check config again
          this.checkPathConfiguration().subscribe();
        }
      }),
      catchError(error => {
        console.error('Error showing path configuration dialog:', error);
        throw error;
      })
    );
  }

  /**
   * Get path configuration as observable
   */
  get pathConfig$(): Observable<PathConfig | null> {
    return this.pathConfigSubject.asObservable();
  }

  /**
   * Get config status as observable
   */
  get configStatus$(): Observable<boolean | null> {
    return this.configStatus.asObservable();
  }
}