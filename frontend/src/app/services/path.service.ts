import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ValidationResult } from '../models/settings.model';

/**
 * Service to handle path operations (get default path, validate path)
 */
@Injectable({
  providedIn: 'root'
})
export class PathService {
  private http = inject(HttpClient);
  private readonly API_URL = '/api/path';

  /**
   * Gets the default download path from the server based on OS
   */
  getDefaultPath(): Observable<{ path: string, success: boolean }> {
    return this.http.get<{ path: string, success: boolean }>(`${this.API_URL}/default`);
  }

  /**
   * Validates if a path is valid and writable
   */
  validatePath(path: string): Observable<ValidationResult> {
    return this.http.post<ValidationResult>(`${this.API_URL}/validate`, { path });
  }

  /**
   * Opens a native directory picker dialog
   * (Only works in electron, not in web)
   */
  openDirectoryPicker(): Observable<string | null> {
    // Check if we're in Electron environment
    if ((window as any).electron && typeof (window as any).electron.selectDirectory === 'function') {
      return new Observable<string | null>(observer => {
        (window as any).electron.selectDirectory()
          .then((result: string | null) => {
            // The IPC handler returns the path directly as a string, or null if canceled
            observer.next(result);
            observer.complete();
          })
          .catch((error: any) => {
            console.error('Error in directory picker:', error);
            observer.error(error);
            observer.complete();
          });
      });
    }

    // If not in Electron or the function doesn't exist, return null
    return new Observable<string | null>(observer => {
      observer.next(null);
      observer.complete();
    });
  }
}