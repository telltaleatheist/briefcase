import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import { DatabaseVideo, DatabaseStats } from './database-library.service';

export interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

/**
 * LibraryStateService
 *
 * Central state management for the library feature.
 * Manages current library, videos, selection, and filtering.
 *
 * Uses RxJS BehaviorSubjects for reactive state updates.
 */
@Injectable({
  providedIn: 'root'
})
export class LibraryStateService {
  // Library state
  private _libraries = new BehaviorSubject<ClipLibrary[]>([]);
  private _currentLibrary = new BehaviorSubject<ClipLibrary | null>(null);
  private _isLoadingLibraries = new BehaviorSubject<boolean>(true);

  // Video list state
  private _videos = new BehaviorSubject<DatabaseVideo[]>([]);
  private _filteredVideos = new BehaviorSubject<DatabaseVideo[]>([]);
  private _isLoadingVideos = new BehaviorSubject<boolean>(false);
  private _isInitialLoad = new BehaviorSubject<boolean>(true);

  // Selection state
  private _selectedVideoIds = new BehaviorSubject<Set<string>>(new Set());
  private _highlightedVideoId = new BehaviorSubject<string | null>(null);

  // Stats state
  private _stats = new BehaviorSubject<DatabaseStats | null>(null);

  // Tags state
  private _allTags = new BehaviorSubject<{
    people: Array<{ name: string; count: number }>;
    topic: Array<{ name: string; count: number }>;
  } | null>(null);

  // Public observables
  public libraries$ = this._libraries.asObservable();
  public currentLibrary$ = this._currentLibrary.asObservable();
  public isLoadingLibraries$ = this._isLoadingLibraries.asObservable();

  public videos$ = this._videos.asObservable();
  public filteredVideos$ = this._filteredVideos.asObservable();
  public isLoadingVideos$ = this._isLoadingVideos.asObservable();
  public isInitialLoad$ = this._isInitialLoad.asObservable();

  public selectedVideoIds$ = this._selectedVideoIds.asObservable();
  public highlightedVideoId$ = this._highlightedVideoId.asObservable();

  public stats$ = this._stats.asObservable();
  public allTags$ = this._allTags.asObservable();

  // Computed observables
  public selectedVideos$: Observable<DatabaseVideo[]> = combineLatest([
    this.videos$,
    this.selectedVideoIds$
  ]).pipe(
    map(([videos, selectedIds]) =>
      videos.filter(v => selectedIds.has(v.id))
    )
  );

  public selectedCount$: Observable<number> = this.selectedVideoIds$.pipe(
    map(ids => ids.size)
  );

  public hasSelection$: Observable<boolean> = this.selectedCount$.pipe(
    map(count => count > 0)
  );

  constructor() {}

  // ==================== Library Methods ====================

  setLibraries(libraries: ClipLibrary[]): void {
    this._libraries.next(libraries);
  }

  getLibraries(): ClipLibrary[] {
    return this._libraries.value;
  }

  setCurrentLibrary(library: ClipLibrary | null): void {
    this._currentLibrary.next(library);
  }

  getCurrentLibrary(): ClipLibrary | null {
    return this._currentLibrary.value;
  }

  setLoadingLibraries(loading: boolean): void {
    this._isLoadingLibraries.next(loading);
  }

  // ==================== Video Methods ====================

  setVideos(videos: DatabaseVideo[]): void {
    this._videos.next(videos);
  }

  getVideos(): DatabaseVideo[] {
    return this._videos.value;
  }

  setFilteredVideos(videos: DatabaseVideo[]): void {
    this._filteredVideos.next(videos);
  }

  getFilteredVideos(): DatabaseVideo[] {
    return this._filteredVideos.value;
  }

  setLoadingVideos(loading: boolean): void {
    this._isLoadingVideos.next(loading);
  }

  setInitialLoad(isInitial: boolean): void {
    this._isInitialLoad.next(isInitial);
  }

  /**
   * Update a single video in the list
   */
  updateVideo(updatedVideo: DatabaseVideo): void {
    const videos = this._videos.value.map(v =>
      v.id === updatedVideo.id ? updatedVideo : v
    );
    this.setVideos(videos);

    // Also update filtered videos if present
    const filteredVideos = this._filteredVideos.value.map(v =>
      v.id === updatedVideo.id ? updatedVideo : v
    );
    this.setFilteredVideos(filteredVideos);
  }

  /**
   * Remove videos by IDs
   */
  removeVideos(videoIds: string[]): void {
    const videoIdSet = new Set(videoIds);
    const videos = this._videos.value.filter(v => !videoIdSet.has(v.id));
    this.setVideos(videos);

    const filteredVideos = this._filteredVideos.value.filter(v => !videoIdSet.has(v.id));
    this.setFilteredVideos(filteredVideos);

    // Clear selection for removed videos
    const selectedIds = new Set(this._selectedVideoIds.value);
    videoIds.forEach(id => selectedIds.delete(id));
    this.setSelectedVideoIds(selectedIds);
  }

  /**
   * Add videos to the list
   */
  addVideos(newVideos: DatabaseVideo[]): void {
    const videos = [...this._videos.value, ...newVideos];
    this.setVideos(videos);
  }

  // ==================== Selection Methods ====================

  setSelectedVideoIds(ids: Set<string>): void {
    this._selectedVideoIds.next(ids);
  }

  getSelectedVideoIds(): Set<string> {
    return this._selectedVideoIds.value;
  }

  selectVideo(videoId: string): void {
    const selectedIds = new Set(this._selectedVideoIds.value);
    selectedIds.add(videoId);
    this.setSelectedVideoIds(selectedIds);
  }

  deselectVideo(videoId: string): void {
    const selectedIds = new Set(this._selectedVideoIds.value);
    selectedIds.delete(videoId);
    this.setSelectedVideoIds(selectedIds);
  }

  toggleVideoSelection(videoId: string): void {
    const selectedIds = new Set(this._selectedVideoIds.value);
    if (selectedIds.has(videoId)) {
      selectedIds.delete(videoId);
    } else {
      selectedIds.add(videoId);
    }
    this.setSelectedVideoIds(selectedIds);
  }

  selectAllVideos(): void {
    const allIds = new Set(this._filteredVideos.value.map(v => v.id));
    this.setSelectedVideoIds(allIds);
  }

  clearSelection(): void {
    this.setSelectedVideoIds(new Set());
  }

  selectVideosMatchingCondition(predicate: (video: DatabaseVideo) => boolean): void {
    const matchingIds = new Set(
      this._filteredVideos.value
        .filter(predicate)
        .map(v => v.id)
    );
    this.setSelectedVideoIds(matchingIds);
  }

  // ==================== Highlight Methods ====================

  setHighlightedVideoId(videoId: string | null): void {
    this._highlightedVideoId.next(videoId);
  }

  getHighlightedVideoId(): string | null {
    return this._highlightedVideoId.value;
  }

  // ==================== Stats Methods ====================

  setStats(stats: DatabaseStats | null): void {
    this._stats.next(stats);
  }

  getStats(): DatabaseStats | null {
    return this._stats.value;
  }

  // ==================== Tags Methods ====================

  setAllTags(tags: { people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }> } | null): void {
    this._allTags.next(tags);
  }

  getAllTags(): { people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }> } | null {
    return this._allTags.value;
  }

  // ==================== Reset Methods ====================

  /**
   * Reset all state (useful when switching libraries)
   */
  resetState(): void {
    this.setVideos([]);
    this.setFilteredVideos([]);
    this.clearSelection();
    this.setHighlightedVideoId(null);
    this.setStats(null);
    this.setAllTags(null);
    this.setInitialLoad(true);
  }

  /**
   * Reset only selection state
   */
  resetSelection(): void {
    this.clearSelection();
    this.setHighlightedVideoId(null);
  }
}
