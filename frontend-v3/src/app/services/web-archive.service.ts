import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ElectronService } from './electron.service';
import { LibraryService } from './library.service';

export interface WebArchiveDomain {
  domain: string;
  count: number;
  favicon_path: string | null;
}

export interface WebArchiveItem {
  video_id: string;
  original_url: string | null;
  domain: string | null;
  favicon_path: string | null;
  page_title: string | null;
  capture_date: string | null;
  publish_date: string | null;
  capture_method: string | null;
  capture_status: string;
  error_message: string | null;
  text_extracted: number;
  filename: string;
  current_path: string;
  file_size_bytes: number;
  upload_date: string | null;
  download_date: string;
  suggested_title: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class WebArchiveService {
  private http = inject(HttpClient);
  private electronService = inject(ElectronService);
  private libraryService = inject(LibraryService);

  private readonly API_BASE = 'http://localhost:3000/api';

  domains = signal<WebArchiveDomain[]>([]);
  archives = signal<WebArchiveItem[]>([]);
  captureInProgress = signal(false);

  /**
   * Capture a URL as an MHTML web archive
   */
  async captureUrl(url: string): Promise<{ success: boolean; error?: string }> {
    this.captureInProgress.set(true);

    try {
      // Generate filename from URL (use local date, not UTC, so the date in
      // the filename matches the user's calendar day)
      const domain = this.extractDomain(url);
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const title = this.extractTitleFromUrl(url);
      const filename = `${date} ${title}.mhtml`;

      // Get the library's clips folder for saving
      const libraryInfo = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/database/libraries/active`)
      );
      const clipsFolder = libraryInfo?.library?.clipsFolderPath;
      if (!clipsFolder) {
        return { success: false, error: 'No library clips folder found' };
      }

      const savePath = `${clipsFolder}/${filename}`;

      // Use Electron IPC to capture the page
      const captureResult = await this.electronService.captureWebPage({
        url,
        savePath,
        timeout: 30000,
      });

      if (!captureResult.success) {
        return { success: false, error: captureResult.error || 'Capture failed' };
      }

      // Import the file into the library via backend
      const importResult = await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/database/import`, {
          filePaths: [savePath],
        })
      );

      // The import endpoint returns { success, results: [{ success, videoId, ... }] }
      const successResult = importResult?.results?.find((r: any) => r.success && r.videoId);
      if (successResult) {
        const videoId = successResult.videoId;

        // Create web_archives record with the URL info
        await firstValueFrom(
          this.http.post<any>(`${this.API_BASE}/web-archives/import`, {
            videoId,
            filePath: savePath,
            filename,
            originalUrl: url,
            pageTitle: captureResult.pageTitle || title,
            captureMethod: captureResult.method || 'electron',
          })
        );

        // Fetch favicon
        if (domain) {
          await this.electronService.fetchFavicon(domain, `${clipsFolder}/.favicons`);
        }
      }

      // Refresh data
      await this.loadDomains();
      await this.loadArchives();

      return { success: true };
    } catch (error: any) {
      console.error('Failed to capture URL:', error);
      return { success: false, error: error.message };
    } finally {
      this.captureInProgress.set(false);
    }
  }

  /**
   * Load all archives from backend
   */
  async loadArchives(domain?: string) {
    try {
      const params = domain ? `?domain=${encodeURIComponent(domain)}` : '';
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/web-archives${params}`)
      );
      if (response?.success) {
        this.archives.set(response.archives || []);
      }
    } catch (error) {
      console.error('Failed to load archives:', error);
    }
  }

  /**
   * Load domain list with counts
   */
  async loadDomains() {
    try {
      const response = await firstValueFrom(
        this.http.get<any>(`${this.API_BASE}/web-archives/domains`)
      );
      if (response?.success) {
        this.domains.set(response.domains || []);
      }
    } catch (error) {
      console.error('Failed to load domains:', error);
    }
  }

  /**
   * Get favicon URL for a domain (served by backend)
   */
  getFaviconUrl(domain: string): string {
    return `${this.API_BASE}/web-archives/favicon/${encodeURIComponent(domain)}`;
  }

  /**
   * Open an MHTML file in the default browser
   */
  async openInBrowser(filePath: string) {
    await this.electronService.openFile(filePath);
  }

  /**
   * Trigger backfill of existing MHTML files
   */
  async backfillExisting(): Promise<{ backfilled: number; total: number }> {
    try {
      const response = await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/web-archives/backfill`, {})
      );
      return { backfilled: response?.backfilled || 0, total: response?.total || 0 };
    } catch (error) {
      console.error('Backfill failed:', error);
      return { backfilled: 0, total: 0 };
    }
  }

  /**
   * Refresh all data
   */
  async refresh() {
    await Promise.all([this.loadDomains(), this.loadArchives()]);
  }

  private extractDomain(url: string): string | null {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  private extractTitleFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split('/').filter(p => p.length > 0);
      if (pathParts.length > 0) {
        const last = pathParts[pathParts.length - 1];
        return decodeURIComponent(last)
          .replace(/[-_]/g, ' ')
          .replace(/\.[^.]+$/, '')
          .substring(0, 80);
      }
      return parsed.hostname;
    } catch {
      return 'webpage';
    }
  }
}
