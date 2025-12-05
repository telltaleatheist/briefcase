import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap } from 'rxjs/operators';
import { WebsocketService } from './websocket.service';

export interface SavedLink {
  id: string;
  url: string;
  title?: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  date_added: string;
  date_completed?: string;
  download_path?: string;
  thumbnail_path?: string;
  video_id?: string;
  error_message?: string;
  metadata?: any;
  library_id?: string;
}

@Injectable({
  providedIn: 'root'
})
export class SavedLinksService {
  private readonly API_BASE = 'http://localhost:3000/api';

  private savedLinksSubject = new BehaviorSubject<SavedLink[]>([]);
  savedLinks$ = this.savedLinksSubject.asObservable();

  // Signal for reactive components
  savedLinks = signal<SavedLink[]>([]);

  constructor(
    private http: HttpClient,
    private websocket: WebsocketService
  ) {
    // Listen for WebSocket updates
    this.websocket.onSavedLinkAdded().subscribe(link => {
      const current = this.savedLinksSubject.value;
      // Check if link already exists to prevent duplicates
      if (!current.find(l => l.id === link.id)) {
        const updated = [...current, link];
        this.savedLinksSubject.next(updated);
        this.savedLinks.set(updated);
      }
    });

    this.websocket.onSavedLinkUpdated().subscribe(link => {
      const current = this.savedLinksSubject.value;
      const index = current.findIndex(l => l.id === link.id);
      if (index >= 0) {
        const updated = [...current];
        updated[index] = link;
        this.savedLinksSubject.next(updated);
        this.savedLinks.set(updated);
      }
    });

    this.websocket.onSavedLinkDeleted().subscribe(id => {
      const current = this.savedLinksSubject.value;
      const filtered = current.filter(l => l.id !== id);
      this.savedLinksSubject.next(filtered);
      this.savedLinks.set(filtered);
    });
  }

  /**
   * Add a new link
   */
  addLink(url: string, title?: string, libraryId?: string, shouldDownload?: boolean): Observable<SavedLink> {
    const apiUrl = `${this.API_BASE}/saved-links`;
    return this.http.post<SavedLink>(apiUrl, { url, title, libraryId, shouldDownload });
  }

  /**
   * Get all saved links
   */
  getAllLinks(status?: string): Observable<SavedLink[]> {
    const apiUrl = `${this.API_BASE}/saved-links${status ? `?status=${status}` : ''}`;
    return this.http.get<SavedLink[]>(apiUrl).pipe(
      tap(links => {
        this.savedLinksSubject.next(links);
        this.savedLinks.set(links);
      })
    );
  }

  /**
   * Get a specific saved link
   */
  getLinkById(id: string): Observable<SavedLink | null> {
    const apiUrl = `${this.API_BASE}/saved-links/${id}`;
    return this.http.get<SavedLink | null>(apiUrl);
  }

  /**
   * Update a saved link's title
   */
  updateLinkTitle(id: string, title: string): Observable<SavedLink> {
    const apiUrl = `${this.API_BASE}/saved-links/${id}`;
    return this.http.patch<SavedLink>(apiUrl, { title });
  }

  /**
   * Delete a saved link
   */
  deleteLink(id: string): Observable<void> {
    const apiUrl = `${this.API_BASE}/saved-links/${id}`;
    return this.http.delete<void>(apiUrl);
  }

  /**
   * Retry a failed link
   */
  retryLink(id: string): Observable<{ message: string }> {
    const apiUrl = `${this.API_BASE}/saved-links/${id}/retry`;
    return this.http.post<{ message: string }>(apiUrl, {});
  }

  /**
   * Add a downloaded video to the library
   */
  addToLibrary(id: string): Observable<{ success: boolean; videoId?: string; error?: string; message?: string }> {
    const apiUrl = `${this.API_BASE}/saved-links/${id}/add-to-library`;
    return this.http.post<{ success: boolean; videoId?: string; error?: string; message?: string }>(apiUrl, {});
  }

  /**
   * Get count of saved links
   */
  getCount(status?: string): Observable<{ count: number }> {
    const apiUrl = `${this.API_BASE}/saved-links/stats/count${status ? `?status=${status}` : ''}`;
    return this.http.get<{ count: number }>(apiUrl);
  }

  /**
   * Get count of active (pending/downloading) links
   */
  getActiveCount(): Observable<{ count: number }> {
    const apiUrl = `${this.API_BASE}/saved-links/stats/active`;
    return this.http.get<{ count: number }>(apiUrl);
  }
}
