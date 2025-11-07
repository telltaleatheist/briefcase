import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { environment } from '../../environment/environment';
import { BackendUrlService } from './backend-url.service';

/**
 * Database Library Service - Communicates with the new SQLite-based library API
 *
 * This service provides access to the batch analysis library system built in Phase 1-2.
 * It queries the database for analyzed videos, transcripts, and analysis sections.
 */

export interface DatabaseVideo {
  id: string;
  filename: string;
  file_hash: string;
  current_path: string;
  date_folder: string | null;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  ai_description: string | null;
  created_at: string;
  last_verified: string;
  added_at: string;
  is_linked: number; // 0 or 1 (SQLite boolean)
}

export interface DatabaseTranscript {
  video_id: string;
  plain_text: string;
  srt_format: string;
  whisper_model: string | null;
  language: string | null;
  transcribed_at: string;
}

export interface DatabaseAnalysis {
  video_id: string;
  ai_analysis: string;
  summary: string | null;
  sections_count: number | null;
  ai_model: string;
  ai_provider: string | null;
  analyzed_at: string;
}

export interface DatabaseAnalysisSection {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  timestamp_text: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
}

export interface DatabaseTag {
  id: string;
  video_id: string;
  tag_name: string;
  tag_type: string | null;
  confidence: number | null;
  source: string | null;
  created_at: string;
}

export interface DatabaseStats {
  totalVideos: number;
  linkedVideos: number;
  unlinkedVideos: number;
  withTranscripts: number;
  withAnalyses: number;
  totalTags: number;
}

export interface ScanResult {
  success: boolean;
  totalFiles: number;
  newVideos: number;
  updatedPaths: number;
  markedMissing: number;
  errorCount: number;
  duration: number;
  newVideoIds: string[];
  errors: string[];
}

export interface BatchProgress {
  running: boolean;
  jobId?: string;
  status?: string;
  totalVideos?: number;
  processedVideos?: number;
  failedVideos?: number;
  skippedVideos?: number;
  currentVideoFilename?: string;
  progress?: number;
  estimatedTimeRemaining?: number;
  errors?: Array<{
    videoId: string;
    filename: string;
    error: string;
    timestamp: string;
  }>;
  message?: string;
}

export interface LibraryVideoWithDetails extends DatabaseVideo {
  hasTranscript: boolean;
  hasAnalysis: boolean;
  sectionsCount?: number;
  tags?: DatabaseTag[];
  transcriptSnippet?: string;
  analysisSnippet?: string;
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseLibraryService {
  private baseUrl: string | null = null;
  private baseUrlPromise: Promise<string> | null = null;

  // Cache for preloaded data
  private cachedStats: DatabaseStats | null = null;
  private cachedVideos: { videos: DatabaseVideo[]; count: number } | null = null;
  private cachedTags: { people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }>; other: Array<{ name: string; count: number }> } | null = null;
  private preloadPromise: Promise<void> | null = null;

  constructor(
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {}

  /**
   * Get the base URL for database API calls (cached)
   */
  private async getBaseUrl(): Promise<string> {
    // Return cached value immediately
    if (this.baseUrl) {
      return this.baseUrl;
    }

    // If a request is already in progress, wait for it
    if (this.baseUrlPromise) {
      return this.baseUrlPromise;
    }

    // Create new promise and cache it
    this.baseUrlPromise = this.backendUrlService.getApiUrl('/database');

    try {
      this.baseUrl = await this.baseUrlPromise;
      return this.baseUrl;
    } finally {
      this.baseUrlPromise = null;
    }
  }

  /**
   * Preload library data in the background
   * Call this on app startup to have data ready when user navigates to library
   */
  async preloadLibraryData(): Promise<void> {
    // If already preloading, return the existing promise
    if (this.preloadPromise) {
      return this.preloadPromise;
    }

    // If already cached, no need to preload
    if (this.cachedStats && this.cachedVideos && this.cachedTags) {
      return Promise.resolve();
    }

    this.preloadPromise = this.performPreload();

    try {
      await this.preloadPromise;
    } finally {
      this.preloadPromise = null;
    }
  }

  private async performPreload(): Promise<void> {
    console.log('[DatabaseLibraryService] Preloading library data...');
    const startTime = performance.now();

    try {
      // Load all data in parallel
      const [stats, videos, tags] = await Promise.all([
        this.fetchStats(),
        this.fetchVideos(100, 0), // Initial batch of 100
        this.fetchTags()
      ]);

      this.cachedStats = stats;
      this.cachedVideos = videos;
      this.cachedTags = tags;

      console.log(`[DatabaseLibraryService] Preload complete in ${(performance.now() - startTime).toFixed(0)}ms`);
    } catch (error) {
      console.error('[DatabaseLibraryService] Preload failed:', error);
      // Don't throw - let the component handle loading on demand
    }
  }

  /**
   * Clear cached data (call after updates to force refresh)
   */
  clearCache(): void {
    this.cachedStats = null;
    this.cachedVideos = null;
    this.cachedTags = null;
  }

  /**
   * Get database statistics (uses cache if available)
   */
  async getStats(useCache = true): Promise<DatabaseStats> {
    if (useCache && this.cachedStats) {
      return this.cachedStats;
    }

    const stats = await this.fetchStats();
    this.cachedStats = stats;
    return stats;
  }

  private async fetchStats(): Promise<DatabaseStats> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<DatabaseStats>(`${baseUrl}/stats`)
    );
  }

  /**
   * Trigger a full library scan
   */
  async scanLibrary(clipsFolder?: string): Promise<ScanResult> {
    const body = clipsFolder ? { clipsFolder } : {};
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<ScanResult>(`${baseUrl}/scan`, body)
    );
  }

  /**
   * Get videos that need analysis
   */
  async getVideosNeedingAnalysis(): Promise<{ count: number; videos: any[] }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<{ count: number; videos: any[] }>(`${baseUrl}/needs-analysis`)
    );
  }

  /**
   * Get all videos (paginated, uses cache if available)
   */
  async getVideos(limit = 100, offset = 0, useCache = true): Promise<{ videos: DatabaseVideo[]; count: number }> {
    // Return cached videos if available and requesting from start
    if (useCache && offset === 0 && this.cachedVideos && this.cachedVideos.videos.length >= limit) {
      return {
        videos: this.cachedVideos.videos.slice(0, limit),
        count: this.cachedVideos.count
      };
    }

    const result = await this.fetchVideos(limit, offset);

    // Cache if this is the initial load
    if (offset === 0) {
      this.cachedVideos = result;
    }

    return result;
  }

  private async fetchVideos(limit: number, offset: number): Promise<{ videos: DatabaseVideo[]; count: number }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<{ videos: DatabaseVideo[]; count: number }>(
        `${baseUrl}/videos?limit=${limit}&offset=${offset}`
      )
    );
  }

  /**
   * Start batch analysis
   */
  async startBatchAnalysis(options?: {
    aiModel?: string;
    aiProvider?: 'ollama' | 'claude' | 'openai';
    whisperModel?: string;
    ollamaEndpoint?: string;
    limit?: number;
    videoIds?: string[];
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
  }): Promise<{ success: boolean; jobId: string; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{ success: boolean; jobId: string; message: string }>(
        `${baseUrl}/batch/start`,
        options || {}
      )
    );
  }

  /**
   * Get batch analysis progress
   */
  async getBatchProgress(): Promise<BatchProgress> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<BatchProgress>(`${baseUrl}/batch/progress`)
    );
  }

  /**
   * Pause batch analysis
   */
  async pauseBatch(): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{ success: boolean; message: string }>(
        `${baseUrl}/batch/pause`,
        {}
      )
    );
  }

  /**
   * Resume batch analysis
   */
  async resumeBatch(): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{ success: boolean; message: string }>(
        `${baseUrl}/batch/resume`,
        {}
      )
    );
  }

  /**
   * Stop batch analysis
   */
  async stopBatch(): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{ success: boolean; message: string }>(
        `${baseUrl}/batch/stop`,
        {}
      )
    );
  }

  /**
   * Get all tags with counts (grouped by type: people, topic, other, uses cache if available)
   */
  async getTags(useCache = true): Promise<{ people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }>; other: Array<{ name: string; count: number }> }> {
    if (useCache && this.cachedTags) {
      return this.cachedTags;
    }

    const tags = await this.fetchTags();
    this.cachedTags = tags;
    return tags;
  }

  private async fetchTags(): Promise<{ people: Array<{ name: string; count: number }>; topic: Array<{ name: string; count: number }>; other: Array<{ name: string; count: number }> }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<any>(`${baseUrl}/tags`)
    );
  }

  /**
   * Get videos filtered by tags
   */
  async getVideosByTags(tagNames: string[]): Promise<{ videos: DatabaseVideo[]; count: number }> {
    const tagsParam = tagNames.join(',');
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<{ videos: DatabaseVideo[]; count: number }>(
        `${baseUrl}/videos?tags=${encodeURIComponent(tagsParam)}`
      )
    );
  }

  /**
   * Search videos by keyword (searches filenames, transcripts, analyses)
   * This is a client-side search for Phase 3 - will be enhanced with backend search in Phase 4
   */
  async searchVideos(query: string, videos: DatabaseVideo[]): Promise<DatabaseVideo[]> {
    if (!query || query.trim() === '') {
      return videos;
    }

    const lowerQuery = query.toLowerCase();
    return videos.filter(video =>
      video.filename.toLowerCase().includes(lowerQuery) ||
      (video.date_folder && video.date_folder.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Filter videos by date range
   */
  filterByDateRange(
    videos: DatabaseVideo[],
    startDate?: Date,
    endDate?: Date
  ): DatabaseVideo[] {
    if (!startDate && !endDate) {
      return videos;
    }

    return videos.filter(video => {
      if (!video.date_folder) return false;

      const videoDate = new Date(video.date_folder);

      if (startDate && videoDate < startDate) return false;
      if (endDate && videoDate > endDate) return false;

      return true;
    });
  }

  /**
   * Sort videos by various criteria
   */
  sortVideos(
    videos: DatabaseVideo[],
    sortBy: 'date' | 'filename' | 'size' = 'date',
    order: 'asc' | 'desc' = 'desc'
  ): DatabaseVideo[] {
    const sorted = [...videos].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'date':
          const dateA = a.date_folder ? new Date(a.date_folder).getTime() : 0;
          const dateB = b.date_folder ? new Date(b.date_folder).getTime() : 0;
          comparison = dateA - dateB;
          break;

        case 'filename':
          comparison = a.filename.localeCompare(b.filename);
          break;

        case 'size':
          const sizeA = a.file_size_bytes || 0;
          const sizeB = b.file_size_bytes || 0;
          comparison = sizeA - sizeB;
          break;
      }

      return order === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes: number | null): string {
    if (!bytes) return 'Unknown';

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * Format duration for display
   */
  formatDuration(seconds: number | null): string {
    if (!seconds) return 'Unknown';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Check if a video has an analysis
   */
  async hasAnalysis(videoId: string): Promise<boolean> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.get<{ exists: boolean }>(`${baseUrl}/videos/${videoId}/has-analysis`)
      );
      return result.exists;
    } catch (error) {
      console.error('[DatabaseLibraryService] Error checking for analysis:', error);
      return false;
    }
  }

  /**
   * Check if a video has a transcript
   */
  async hasTranscript(videoId: string): Promise<boolean> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.get<{ exists: boolean }>(`${baseUrl}/videos/${videoId}/has-transcript`)
      );
      return result.exists;
    } catch (error) {
      console.error('[DatabaseLibraryService] Error checking for transcript:', error);
      return false;
    }
  }

  /**
   * Get analysis for a video
   */
  async getAnalysis(videoId: string): Promise<DatabaseAnalysis | null> {
    try {
      const baseUrl = await this.getBaseUrl();
      return await firstValueFrom(
        this.http.get<DatabaseAnalysis>(`${baseUrl}/videos/${videoId}/analysis`)
      );
    } catch (error) {
      console.error('[DatabaseLibraryService] Error getting analysis:', error);
      return null;
    }
  }

  /**
   * Get transcript for a video
   */
  async getTranscript(videoId: string): Promise<DatabaseTranscript | null> {
    try {
      const baseUrl = await this.getBaseUrl();
      return await firstValueFrom(
        this.http.get<DatabaseTranscript>(`${baseUrl}/videos/${videoId}/transcript`)
      );
    } catch (error) {
      console.error('[DatabaseLibraryService] Error getting transcript:', error);
      return null;
    }
  }

  /**
   * Get analysis sections for a video
   */
  async getAnalysisSections(videoId: string): Promise<DatabaseAnalysisSection[]> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.get<{ sections: DatabaseAnalysisSection[]; count: number }>(`${baseUrl}/videos/${videoId}/sections`)
      );
      return result.sections;
    } catch (error) {
      console.error('[DatabaseLibraryService] Error getting analysis sections:', error);
      return [];
    }
  }

  /**
   * Delete a video from the library
   */
  async deleteVideo(videoId: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.delete<{ success: boolean; message: string }>(
        `${baseUrl}/videos/${videoId}`
      )
    );
  }
}
