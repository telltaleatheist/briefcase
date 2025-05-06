// clippy/frontend/src/app/services/api.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { environment } from '../../environment/environment';
import { DownloadOptions, DownloadResult, HistoryItem } from '../models/download.model';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly apiUrl = environment.apiBaseUrl;

  constructor(private http: HttpClient) {
  }
  
  private getFullUrl(path: string): string {
    return `${this.apiUrl}${path}`;
  }
  
  /**
   * Start a video download
   */
  downloadVideo(options: DownloadOptions): Observable<DownloadResult> {
    return this.http.post<DownloadResult>(this.getFullUrl('/downloader'), options);
  }

  /**
   * Get download history
   */
  getDownloadHistory(): Observable<HistoryItem[]> {
    return this.http.get<HistoryItem[]>(this.getFullUrl('/downloader/history'));
  }

  /**
   * Remove an item from download history
   */
  removeFromHistory(id: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(
      this.getFullUrl(`/downloader/history/${id}`)
    );
  }

  /**
   * Clear all download history
   */
  clearHistory(): Observable<{ success: boolean; message: string }> {
    return this.http.delete<{ success: boolean; message: string }>(
      this.getFullUrl('/downloader/history')
    );
  }

  /**
   * Check if a URL is valid and get video info
   */
  checkUrl(url: string): Observable<{ valid: boolean; message: string; info?: any }> {
    return this.http.get<{ valid: boolean; message: string; info?: any }>(
      this.getFullUrl('/downloader/check'), 
      { params: { url } }
    ).pipe(
      catchError(error => {
        console.error('URL check error:', error);
        // Basic validation fallback
        if (this.isVideoUrlFormat(url)) {
          return of({ 
            valid: true, 
            message: 'URL format appears to be valid',
            info: { title: 'Video' }
          });
        }
        return of({ valid: false, message: 'Invalid URL format' });
      })
    );
  }

  // Simple client-side URL validation
  private isVideoUrlFormat(url: string): boolean {
    try {
      const parsed = new URL(url);
      const videoDomains = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com'];
      return videoDomains.some(domain => parsed.hostname.includes(domain)) || 
              url.includes('/watch') || url.includes('/video');
    } catch {
      return false;
    }
  }

  /**
   * Get file download URL
   */
  getFileUrl(id: string): string {
    return this.getFullUrl(`/downloader/file/${id}`);
  }

  /**
   * Get file streaming URL
   */
  getStreamUrl(id: string): string {
    return this.getFullUrl(`/downloader/stream/${id}`);
  }
}