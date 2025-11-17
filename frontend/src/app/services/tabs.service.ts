import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap } from 'rxjs/operators';
import { BackendUrlService } from './backend-url.service';

export interface VideoTab {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  display_order: number;
  video_count: number;
}

@Injectable({
  providedIn: 'root'
})
export class TabsService {
  private baseUrl = '';
  private tabsSubject = new BehaviorSubject<VideoTab[]>([]);
  public tabs$ = this.tabsSubject.asObservable();

  constructor(
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {
    this.initializeBaseUrl();
  }

  private async initializeBaseUrl() {
    this.baseUrl = await this.backendUrlService.getBackendUrl();
  }

  /**
   * Load all tabs from the backend
   */
  async loadTabs(): Promise<VideoTab[]> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    return new Promise((resolve, reject) => {
      this.http.get<VideoTab[]>(`${this.baseUrl}/api/tabs`).subscribe({
        next: (tabs) => {
          this.tabsSubject.next(tabs);
          resolve(tabs);
        },
        error: (error) => {
          console.error('Failed to load tabs:', error);
          reject(error);
        }
      });
    });
  }

  /**
   * Get a single tab by ID
   */
  async getTab(id: string): Promise<VideoTab> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    return this.http.get<VideoTab>(`${this.baseUrl}/api/tabs/${id}`).toPromise() as Promise<VideoTab>;
  }

  /**
   * Create a new tab
   */
  async createTab(name: string): Promise<{ id: string; name: string }> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    const result = await this.http.post<{ id: string; name: string }>(
      `${this.baseUrl}/api/tabs`,
      { name }
    ).toPromise() as { id: string; name: string };

    // Reload tabs to update the list
    await this.loadTabs();
    return result;
  }

  /**
   * Update a tab's name
   */
  async updateTab(id: string, name: string): Promise<void> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    await this.http.patch(`${this.baseUrl}/api/tabs/${id}`, { name }).toPromise();

    // Reload tabs to update the list
    await this.loadTabs();
  }

  /**
   * Delete a tab
   */
  async deleteTab(id: string): Promise<void> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    await this.http.delete(`${this.baseUrl}/api/tabs/${id}`).toPromise();

    // Reload tabs to update the list
    await this.loadTabs();
  }

  /**
   * Get all videos in a tab
   */
  async getTabVideos(tabId: string): Promise<any[]> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    return this.http.get<any[]>(`${this.baseUrl}/api/tabs/${tabId}/videos`).toPromise() as Promise<any[]>;
  }

  /**
   * Add a video to a tab
   */
  async addVideoToTab(tabId: string, videoId: string): Promise<void> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    await this.http.post(`${this.baseUrl}/api/tabs/${tabId}/videos`, { videoId }).toPromise();

    // Reload tabs to update video counts
    await this.loadTabs();
  }

  /**
   * Remove a video from a tab
   */
  async removeVideoFromTab(tabId: string, videoId: string): Promise<void> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    await this.http.delete(`${this.baseUrl}/api/tabs/${tabId}/videos/${videoId}`).toPromise();

    // Reload tabs to update video counts
    await this.loadTabs();
  }

  /**
   * Get all tabs that contain a specific video
   */
  async getTabsForVideo(videoId: string): Promise<Array<{ id: string; name: string; created_at: string; updated_at: string }>> {
    if (!this.baseUrl) {
      this.baseUrl = await this.backendUrlService.getBackendUrl();
    }

    return this.http.get<Array<{ id: string; name: string; created_at: string; updated_at: string }>>(
      `${this.baseUrl}/api/tabs/video/${videoId}`
    ).toPromise() as Promise<Array<{ id: string; name: string; created_at: string; updated_at: string }>>;
  }

  /**
   * Get current tabs from the subject (synchronous)
   */
  getCurrentTabs(): VideoTab[] {
    return this.tabsSubject.value;
  }
}
