import { Injectable, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface VideoTab {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  display_order: number;
  video_count?: number;
}

export interface TabWithVideos extends VideoTab {
  videos: any[];
}

export interface AddVideoToTabResponse {
  success: boolean;
  results?: { videoId: string; success: boolean; itemId?: string; error?: string }[];
  addedCount?: number;
  totalCount?: number;
  itemId?: string; // For single video
}

@Injectable({
  providedIn: 'root'
})
export class TabsService {
  private baseUrl = 'http://localhost:3000/api';

  // Cached tabs list (signal)
  tabs = signal<VideoTab[]>([]);

  // Computed: Most recently created tabs (for context menu)
  recentTabs = computed(() => {
    const allTabs = this.tabs();
    // Sort by created_at descending and take first 7
    return [...allTabs]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 7);
  });

  constructor(private http: HttpClient) {}

  /**
   * Load all tabs and update the cache
   */
  loadTabs(): Observable<VideoTab[]> {
    return this.http.get<VideoTab[]>(`${this.baseUrl}/tabs`).pipe(
      map(tabs => {
        this.tabs.set(tabs);
        return tabs;
      })
    );
  }

  /**
   * Get all tabs (returns cached if available, otherwise fetches)
   */
  getAllTabs(): Observable<VideoTab[]> {
    if (this.tabs().length > 0) {
      return new Observable(observer => {
        observer.next(this.tabs());
        observer.complete();
      });
    }
    return this.loadTabs();
  }

  /**
   * Get a single tab by ID
   */
  getTabById(id: string): Observable<VideoTab> {
    return this.http.get<VideoTab>(`${this.baseUrl}/tabs/${id}`);
  }

  /**
   * Create a new tab
   */
  createTab(name: string): Observable<{ id: string; name: string }> {
    return this.http.post<{ id: string; name: string }>(`${this.baseUrl}/tabs`, { name }).pipe(
      map(result => {
        // Reload tabs to update cache
        this.loadTabs().subscribe();
        return result;
      })
    );
  }

  /**
   * Update a tab's name
   */
  updateTab(id: string, name: string): Observable<{ success: boolean }> {
    return this.http.patch<{ success: boolean }>(`${this.baseUrl}/tabs/${id}`, { name }).pipe(
      map(result => {
        // Reload tabs to update cache
        this.loadTabs().subscribe();
        return result;
      })
    );
  }

  /**
   * Delete a tab
   */
  deleteTab(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.baseUrl}/tabs/${id}`).pipe(
      map(result => {
        // Reload tabs to update cache
        this.loadTabs().subscribe();
        return result;
      })
    );
  }

  /**
   * Get all videos in a tab
   */
  getTabVideos(id: string): Observable<any[]> {
    return this.http.get<any[]>(`${this.baseUrl}/tabs/${id}/videos`);
  }

  /**
   * Add one or more videos to a tab
   */
  addVideosToTab(tabId: string, videoIds: string[]): Observable<AddVideoToTabResponse> {
    return this.http.post<AddVideoToTabResponse>(`${this.baseUrl}/tabs/${tabId}/videos`, {
      videoId: videoIds
    }).pipe(
      map(result => {
        // Reload tabs to update video counts
        this.loadTabs().subscribe();
        return result;
      })
    );
  }

  /**
   * Remove a video from a tab
   */
  removeVideoFromTab(tabId: string, videoId: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.baseUrl}/tabs/${tabId}/videos/${videoId}`).pipe(
      map(result => {
        // Reload tabs to update video counts
        this.loadTabs().subscribe();
        return result;
      })
    );
  }

  /**
   * Get all tabs that contain a specific video
   */
  getTabsForVideo(videoId: string): Observable<VideoTab[]> {
    return this.http.get<VideoTab[]>(`${this.baseUrl}/tabs/video/${videoId}`);
  }
}
