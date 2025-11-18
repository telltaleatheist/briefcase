import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { VideoWeek, VideoItem } from '../models/video.model';
import { JobRequest } from '../models/task.model';
import { Library, NewLibrary } from '../models/library.model';

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface JobResponse {
  id: string;
  status: string;
  tasks: any[];
}

// Video editor types (from legacy frontend)
export interface VideoInfo {
  originalPath: string;
  currentPath: string;
  clipsWeekFolder?: string;
  filename: string;
  durationSeconds?: number;
  isLinked: boolean;
  lastVerified: string;
}

export interface AnalysisFiles {
  analysis: string;
  analysisMetadata: string;
  transcriptSrt: string;
  transcriptTxt: string;
}

export interface AnalysisMetadata {
  analysisModel: string;
  transcriptionModel: string;
  categories: string[];
}

export interface AnalysisQuote {
  timestamp: string;
  timestampSeconds: number;
  text: string;
  significance: string;
}

export interface AnalysisSection {
  timeRange: string;
  startSeconds: number;
  endSeconds?: number;
  category: string;
  description: string;
  quotes: AnalysisQuote[];
}

export interface ParsedAnalysisMetadata {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds?: number;
  sections: AnalysisSection[];
}

export interface LibraryAnalysis {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  video: VideoInfo;
  files: AnalysisFiles;
  metadata: AnalysisMetadata;
  clips: string[];
}

export interface LibraryClip {
  id: string;
  analysisId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
  createdAt: string;
  notes?: string;
}

@Injectable({
  providedIn: 'root'
})
export class LibraryService {
  private readonly API_BASE = 'http://localhost:3001/api';

  // State management
  videos = signal<VideoItem[]>([]);
  selectedIds = signal<Set<string>>(new Set());
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  // Library management
  currentLibrary = signal<Library | null>(null);
  libraries = signal<Library[]>([]);

  constructor(private http: HttpClient) {
    // Don't load here - let components control when to load
  }

  /**
   * Load all videos from library
   * GET /api/database/videos
   */
  loadVideos(): Observable<ApiResponse<VideoItem[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos`).pipe(
      map(response => ({
        success: true,
        data: this.transformVideos(response.videos || [])
      }))
    );
  }

  /**
   * Get videos organized by week
   */
  getVideosByWeek(): Observable<ApiResponse<VideoWeek[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos`).pipe(
      map(response => {
        console.log('Raw API response:', response);
        const videos = this.transformVideos(response.videos || []);
        console.log('Transformed videos:', videos.length);
        const weeks = this.groupVideosByWeek(videos);
        console.log('Grouped into weeks:', weeks.length);
        return {
          success: true,
          data: weeks
        };
      })
    );
  }

  /**
   * Search videos
   * GET /api/database/search?q=query
   */
  searchVideos(query: string): Observable<ApiResponse<VideoItem[]>> {
    return this.http.get<any>(
      `${this.API_BASE}/database/search`,
      { params: { q: query } }
    ).pipe(
      map(response => ({
        success: true,
        data: this.transformVideos(response.results || [])
      }))
    );
  }

  /**
   * Get single video with details
   * GET /api/database/videos/:id
   */
  getVideo(id: string): Observable<ApiResponse<VideoItem>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${id}`).pipe(
      map(response => ({
        success: true,
        data: this.transformVideo(response.video || response)
      }))
    );
  }

  /**
   * Delete video from library
   * DELETE /api/database/videos/:id
   */
  deleteVideo(id: string): Observable<ApiResponse<void>> {
    return this.http.delete<any>(`${this.API_BASE}/database/videos/${id}`).pipe(
      map(response => ({
        success: response.success !== false,
        data: undefined
      }))
    );
  }

  /**
   * Transform backend video to frontend VideoItem format
   */
  private transformVideo(video: any): VideoItem {
    return {
      id: video.id,
      name: video.filename || video.name || 'Untitled',
      suggestedFilename: video.suggested_title || video.filename || 'Untitled',
      duration: this.formatDuration(video.duration || video.duration_seconds || 0),
      size: video.file_size || video.file_size_bytes,
      downloadDate: video.download_date ? new Date(video.download_date) : undefined,
      thumbnailUrl: video.id ? `${this.API_BASE}/database/videos/${video.id}/thumbnail` : undefined,
      // Additional fields for context menu actions
      filePath: video.file_path || video.filepath,
      suggestedTitle: video.suggested_title,
      hasTranscript: video.has_transcript === 1 || video.has_transcript === true,
      hasAnalysis: video.has_analysis === 1 || video.has_analysis === true
    };
  }

  /**
   * Transform array of backend videos
   */
  private transformVideos(videos: any[]): VideoItem[] {
    return videos.map(v => this.transformVideo(v));
  }

  /**
   * Format duration from seconds to hh:mm:ss
   */
  private formatDuration(seconds: number): string {
    if (!seconds || seconds <= 0) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Group videos by date (folder format) with special "Past 24 hours" section
   */
  private groupVideosByWeek(videos: VideoItem[]): VideoWeek[] {
    const dateMap = new Map<string, VideoItem[]>();
    const now = new Date();
    const past24Hours: VideoItem[] = [];

    // Sort videos by download date (newest first)
    const sortedVideos = [...videos].sort((a, b) => {
      const dateA = a.downloadDate ? new Date(a.downloadDate).getTime() : 0;
      const dateB = b.downloadDate ? new Date(b.downloadDate).getTime() : 0;
      return dateB - dateA;
    });

    for (const video of sortedVideos) {
      if (!video.downloadDate) {
        const key = 'Unknown';
        if (!dateMap.has(key)) {
          dateMap.set(key, []);
        }
        dateMap.get(key)!.push(video);
        continue;
      }

      const videoDate = new Date(video.downloadDate);
      const hoursDiff = (now.getTime() - videoDate.getTime()) / (1000 * 60 * 60);

      // Check if within past 24 hours
      if (hoursDiff <= 24) {
        past24Hours.push(video);
      }

      // Always add to date group as well
      const dateKey = this.getDateKey(videoDate);
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, []);
      }
      dateMap.get(dateKey)!.push(video);
    }

    // Build result array
    const result: VideoWeek[] = [];

    // Add "Past 24 hours" section first if it has items
    if (past24Hours.length > 0) {
      result.push({
        weekLabel: 'Past 24 Hours',
        videos: past24Hours
      });
    }

    // Convert date groups to array and sort by date (newest first)
    const dateGroups = Array.from(dateMap.entries())
      .map(([dateKey, dateVideos]) => ({
        weekLabel: dateKey,
        videos: dateVideos
      }))
      .sort((a, b) => {
        // Sort "Unknown" to the end
        if (a.weekLabel === 'Unknown') return 1;
        if (b.weekLabel === 'Unknown') return -1;
        // Sort dates descending (newest first)
        return b.weekLabel.localeCompare(a.weekLabel);
      });

    result.push(...dateGroups);

    return result;
  }

  /**
   * Get date key in folder format (YYYY-MM-DD)
   */
  private getDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get week key for grouping (format: YYYY-WW)
   */
  private getWeekKey(date?: Date): string {
    if (!date) return 'Unknown';
    const d = new Date(date);
    const year = d.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-${weekNum.toString().padStart(2, '0')}`;
  }

  /**
   * Format week key to readable label
   */
  private formatWeekLabel(weekKey: string): string {
    if (weekKey === 'Unknown') return 'Unknown Date';

    const [year, weekStr] = weekKey.split('-');
    const weekNum = parseInt(weekStr, 10);

    // Calculate the start date of the week
    const startOfYear = new Date(parseInt(year, 10), 0, 1);
    const daysOffset = (weekNum - 1) * 7 - startOfYear.getDay();
    const weekStart = new Date(startOfYear);
    weekStart.setDate(startOfYear.getDate() + daysOffset);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    const startStr = weekStart.toLocaleDateString('en-US', options);
    const endStr = weekEnd.toLocaleDateString('en-US', { ...options, year: 'numeric' });

    return `Week of ${startStr}-${endStr}`;
  }

  /**
   * Create a new job with tasks
   * POST /api/queue/jobs
   */
  createJob(request: JobRequest): Observable<ApiResponse<JobResponse>> {
    return this.http.post<ApiResponse<JobResponse>>(
      `${this.API_BASE}/queue/jobs`,
      request
    );
  }

  /**
   * Quick add from URL (uses default task preset)
   * POST /api/queue/quick-add
   */
  quickAddUrl(url: string, pageTitle?: string): Observable<ApiResponse<JobResponse>> {
    return this.http.post<ApiResponse<JobResponse>>(
      `${this.API_BASE}/queue/quick-add`,
      { url, pageTitle }
    );
  }

  /**
   * Get queue status
   * GET /api/queue/status
   */
  getQueueStatus(): Observable<ApiResponse<any>> {
    return this.http.get<ApiResponse<any>>(`${this.API_BASE}/queue/status`);
  }

  /**
   * Update filename for a video
   * PATCH /api/library/videos/:id
   */
  updateVideoFilename(id: string, filename: string): Observable<ApiResponse<VideoItem>> {
    return this.http.patch<ApiResponse<VideoItem>>(
      `${this.API_BASE}/library/videos/${id}`,
      { filename }
    );
  }

  // Local state management helpers
  selectVideo(id: string) {
    const selected = new Set(this.selectedIds());
    selected.add(id);
    this.selectedIds.set(selected);
  }

  deselectVideo(id: string) {
    const selected = new Set(this.selectedIds());
    selected.delete(id);
    this.selectedIds.set(selected);
  }

  toggleVideoSelection(id: string) {
    if (this.selectedIds().has(id)) {
      this.deselectVideo(id);
    } else {
      this.selectVideo(id);
    }
  }

  clearSelection() {
    this.selectedIds.set(new Set());
  }

  isVideoSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  // Library management methods
  // Note: Library management endpoints are on /api/database, not /api/library

  /**
   * Get all libraries
   * GET /api/database/libraries
   */
  getLibraries(): Observable<ApiResponse<Library[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/libraries`).pipe(
      map(response => ({
        success: true,
        data: response.libraries || []
      }))
    );
  }

  /**
   * Get current active library
   * GET /api/database/libraries/active
   */
  getCurrentLibrary(): Observable<ApiResponse<Library>> {
    return this.http.get<any>(`${this.API_BASE}/database/libraries/active`).pipe(
      map(response => ({
        success: !!response.library,
        data: response.library
      }))
    );
  }

  /**
   * Switch to a different library
   * POST /api/database/libraries/:id/switch
   */
  switchLibrary(libraryId: string): Observable<ApiResponse<Library>> {
    return this.http.post<any>(`${this.API_BASE}/database/libraries/${libraryId}/switch`, {}).pipe(
      map(response => ({
        success: response.success,
        data: response.library
      }))
    );
  }

  /**
   * Create a new library
   * POST /api/database/libraries
   */
  createLibrary(library: NewLibrary): Observable<ApiResponse<Library>> {
    return this.http.post<any>(`${this.API_BASE}/database/libraries`, {
      name: library.name,
      clipsFolderPath: library.path
    }).pipe(
      map(response => ({
        success: response.success,
        data: response.library
      }))
    );
  }

  /**
   * Relink an existing library to a new path
   * PATCH /api/database/libraries/:id
   */
  relinkLibrary(libraryId: string, newPath: string): Observable<ApiResponse<Library>> {
    return this.http.patch<any>(
      `${this.API_BASE}/database/libraries/${libraryId}`,
      { clipsFolderPath: newPath }
    ).pipe(
      map(response => ({
        success: response.success,
        data: response.library
      }))
    );
  }

  /**
   * Import/discover a library from a path containing .library.db
   * POST /api/database/libraries/open
   */
  importLibrary(path: string): Observable<ApiResponse<Library>> {
    return this.http.post<any>(
      `${this.API_BASE}/database/libraries/open`,
      { clipsFolderPath: path }
    ).pipe(
      map(response => {
        if (!response.success) {
          throw new Error(response.error || 'Failed to import library');
        }
        return {
          success: true,
          data: response.library
        };
      })
    );
  }

  /**
   * Delete a library
   * DELETE /api/database/libraries/:id
   */
  deleteLibrary(libraryId: string): Observable<ApiResponse<void>> {
    return this.http.delete<any>(`${this.API_BASE}/database/libraries/${libraryId}`).pipe(
      map(response => ({
        success: response.success,
        data: undefined
      }))
    );
  }

  /**
   * Load current library from backend
   */
  private loadCurrentLibrary(): void {
    this.getCurrentLibrary().subscribe({
      next: (response) => {
        if (response.success) {
          this.currentLibrary.set(response.data);
        }
      },
      error: (error) => {
        console.error('Failed to load current library:', error);
      }
    });
  }

  /**
   * Refresh libraries list
   */
  refreshLibraries(): void {
    this.getLibraries().subscribe({
      next: (response) => {
        if (response.success) {
          this.libraries.set(response.data);
        }
      },
      error: (error) => {
        console.error('Failed to load libraries:', error);
      }
    });
  }

  // Video editor methods

  /**
   * Extract a clip from video
   */
  extractClip(analysisId: string, clipData: any): Promise<any> {
    return firstValueFrom(
      this.http.post(`${this.API_BASE}/library/analyses/${analysisId}/clips`, clipData)
    );
  }

  /**
   * Auto-relink video to find new path
   */
  autoRelinkVideo(analysisId: string): Promise<any> {
    return firstValueFrom(
      this.http.post(`${this.API_BASE}/library/analyses/${analysisId}/relink/auto`, {})
    );
  }

  /**
   * Manually relink video to new path
   */
  manualRelinkVideo(analysisId: string, newPath: string): Promise<any> {
    return firstValueFrom(
      this.http.post(`${this.API_BASE}/library/analyses/${analysisId}/relink/manual`, { newPath })
    );
  }

  /**
   * Get analysis by ID
   */
  getAnalysis(id: string): Promise<LibraryAnalysis> {
    return firstValueFrom(
      this.http.get<LibraryAnalysis>(`${this.API_BASE}/library/analyses/${id}`)
    );
  }

  /**
   * Get all analyses
   */
  async getAnalyses(archived?: boolean): Promise<LibraryAnalysis[]> {
    const params: Record<string, string> = {};
    if (archived !== undefined) {
      params['archived'] = archived.toString();
    }
    return firstValueFrom(
      this.http.get<LibraryAnalysis[]>(`${this.API_BASE}/library/analyses`, { params })
    );
  }
}
