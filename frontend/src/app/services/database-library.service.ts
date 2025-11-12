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
  upload_date: string | null; // Date from filename - when content was created/filmed
  download_date: string | null; // File creation date - when user downloaded it
  duration_seconds: number | null;
  file_size_bytes: number | null;
  ai_description: string | null;
  source_url: string | null;
  media_type: string; // 'video', 'audio', 'document', 'image', 'webpage'
  file_extension: string | null; // '.mp4', '.pdf', '.jpg', etc.
  last_verified: string;
  added_at: string;
  is_linked: number; // 0 or 1 (SQLite boolean)
  has_transcript: number; // 0 or 1
  has_analysis: number; // 0 or 1
  has_children?: number; // 0 or 1 - indicates if this video has children
  parent_id: string | null; // ID of parent video (null if root-level)
  isParent?: boolean; // Helper flag for UI rendering
  isChild?: boolean; // Helper flag for UI rendering
  searchScore?: number; // Added by search results
  matchType?: string; // Added by search results (filename, transcript, analysis, etc.)
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
   * Prune orphaned videos from the database
   * Deletes all videos marked as unlinked (is_linked = 0)
   */
  async pruneOrphanedVideos(): Promise<{ success: boolean; deletedCount: number; deletedVideos: Array<{ id: string; filename: string }>; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{ success: boolean; deletedCount: number; deletedVideos: Array<{ id: string; filename: string }>; message: string }>(`${baseUrl}/prune`, {})
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
  async getVideos(limit = 100, offset = 0, useCache = true, hierarchical = true): Promise<{ videos: DatabaseVideo[]; count: number }> {
    // Return cached videos if available and requesting from start
    if (useCache && offset === 0 && this.cachedVideos && this.cachedVideos.videos.length >= limit) {
      return {
        videos: this.cachedVideos.videos.slice(0, limit),
        count: this.cachedVideos.count
      };
    }

    const result = await this.fetchVideos(limit, offset, hierarchical);

    // Cache if this is the initial load
    if (offset === 0) {
      this.cachedVideos = result;
    }

    return result;
  }

  private async fetchVideos(limit: number, offset: number, hierarchical = true): Promise<{ videos: DatabaseVideo[]; count: number }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.get<{ videos: DatabaseVideo[]; count: number }>(
        `${baseUrl}/videos?limit=${limit}&offset=${offset}&hierarchical=${hierarchical}`
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
    claudeApiKey?: string;
    openaiApiKey?: string;
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
   * Queue videos for analysis without starting processing
   */
  async queueVideosForAnalysis(options: {
    videoIds: string[];
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
  }): Promise<{ success: boolean; jobId: string; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{ success: boolean; jobId: string; message: string }>(
        `${baseUrl}/batch/queue`,
        options
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
   * Search videos by keyword across filenames, AI descriptions, transcripts, analyses, and tags
   * Uses backend full-text search for comprehensive results
   */
  async searchVideos(
    query: string,
    videos: DatabaseVideo[],
    filters?: {
      filename?: boolean;
      aiDescription?: boolean;
      transcript?: boolean;
      analysis?: boolean;
      tags?: boolean;
    }
  ): Promise<DatabaseVideo[]> {
    if (!query || query.trim() === '') {
      return videos;
    }

    try {
      // Build query params for filters
      const baseUrl = await this.getBaseUrl();
      let url = `${baseUrl}/search?q=${encodeURIComponent(query)}`;

      if (filters) {
        if (filters.filename !== undefined) url += `&filename=${filters.filename}`;
        if (filters.aiDescription !== undefined) url += `&aiDescription=${filters.aiDescription}`;
        if (filters.transcript !== undefined) url += `&transcript=${filters.transcript}`;
        if (filters.analysis !== undefined) url += `&analysis=${filters.analysis}`;
        if (filters.tags !== undefined) url += `&tags=${filters.tags}`;
      }

      const response = await firstValueFrom(
        this.http.get<{ results: DatabaseVideo[]; count: number; query: string }>(url)
      );

      // Return the search results (backend already returns full video objects with search scores)
      return response.results;
    } catch (error) {
      console.error('Backend search failed, falling back to client-side search:', error);

      // Fallback to client-side search if backend fails
      const lowerQuery = query.toLowerCase();
      return videos.filter(video => {
        const searchFilename = !filters || filters.filename !== false;
        const searchAiDesc = !filters || filters.aiDescription !== false;

        return (
          (searchFilename && video.filename.toLowerCase().includes(lowerQuery)) ||
          (searchFilename && video.upload_date && video.upload_date.toLowerCase().includes(lowerQuery)) ||
          (searchAiDesc && video.ai_description && video.ai_description.toLowerCase().includes(lowerQuery))
        );
      });
    }
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
      if (!video.upload_date) return false;

      const videoDate = new Date(video.upload_date);

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
    sortBy: 'date' | 'date-added' | 'filename' | 'size' | 'no-transcript' | 'no-analysis' = 'date',
    order: 'asc' | 'desc' = 'desc'
  ): DatabaseVideo[] {
    const sorted = [...videos].sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'date':
          // Sort by upload_date (date from video filename - "Date Created/Uploaded")
          const dateA = a.upload_date ? new Date(a.upload_date).getTime() : 0;
          const dateB = b.upload_date ? new Date(b.upload_date).getTime() : 0;
          comparison = dateA - dateB;
          break;

        case 'date-added':
          // Sort by download_date (when file was downloaded - "Date Downloaded")
          const addedA = a.download_date ? new Date(a.download_date).getTime() : 0;
          const addedB = b.download_date ? new Date(b.download_date).getTime() : 0;
          comparison = addedA - addedB;
          break;

        case 'filename':
          comparison = a.filename.localeCompare(b.filename);
          break;

        case 'size':
          const sizeA = a.file_size_bytes || 0;
          const sizeB = b.file_size_bytes || 0;
          comparison = sizeA - sizeB;
          break;

        case 'no-transcript':
          // Sort by has_transcript (0 = no transcript = higher priority when desc)
          comparison = (a.has_transcript || 0) - (b.has_transcript || 0);
          break;

        case 'no-analysis':
          // Sort by has_analysis (0 = no analysis = higher priority when desc)
          comparison = (a.has_analysis || 0) - (b.has_analysis || 0);
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
   * Get a single video by ID
   */
  async getVideoById(videoId: string): Promise<DatabaseVideo | null> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.get<DatabaseVideo>(`${baseUrl}/videos/${videoId}`)
      );
      return result;
    } catch (error) {
      console.error('[DatabaseLibraryService] Error getting video by ID:', error);
      return null;
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
   * Update video source URL
   */
  async updateVideoSourceUrl(videoId: string, sourceUrl: string | null): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      return await firstValueFrom(
        this.http.patch<{ success: boolean; message?: string; error?: string }>(
          `${baseUrl}/videos/${videoId}/source-url`,
          { sourceUrl }
        )
      );
    } catch (error) {
      console.error('[DatabaseLibraryService] Error updating source URL:', error);
      return { success: false, error: 'Failed to update source URL' };
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
   * Delete an analysis section
   */
  async deleteAnalysisSection(videoId: string, sectionId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      return await firstValueFrom(
        this.http.delete<{ success: boolean; error?: string }>(
          `${baseUrl}/videos/${videoId}/sections/${sectionId}`
        )
      );
    } catch (error) {
      console.error('[DatabaseLibraryService] Error deleting analysis section:', error);
      return { success: false, error: 'Failed to delete section' };
    }
  }

  /**
   * Delete a video from the library
   */
  async deleteVideo(videoId: string, deleteFiles: boolean = true): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.delete<{ success: boolean; message: string }>(
        `${baseUrl}/videos/${videoId}?deleteFiles=${deleteFiles}`
      )
    );
  }

  /**
   * Delete multiple videos from the library in a batch operation
   */
  async deleteVideoBatch(videoIds: string[], deleteFiles: boolean = true): Promise<{
    success: boolean;
    successCount: number;
    errorCount: number;
    message: string;
    errors?: Array<{ videoId: string; error: string }>;
  }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.post<{
        success: boolean;
        successCount: number;
        errorCount: number;
        message: string;
        errors?: Array<{ videoId: string; error: string }>;
      }>(`${baseUrl}/videos/delete-batch`, {
        videoIds,
        deleteFiles
      })
    );
  }

  /**
   * Delete transcript for a video
   */
  async deleteTranscript(videoId: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.delete<{ success: boolean; message: string }>(
        `${baseUrl}/videos/${videoId}/transcript`
      )
    );
  }

  /**
   * Delete analysis for a video (including sections)
   */
  async deleteAnalysis(videoId: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this.getBaseUrl();
    return firstValueFrom(
      this.http.delete<{ success: boolean; message: string }>(
        `${baseUrl}/videos/${videoId}/analysis`
      )
    );
  }

  /**
   * Get tags for a specific video
   */
  async getVideoTags(videoId: string): Promise<DatabaseTag[]> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.get<{ tags: DatabaseTag[]; count: number }>(
          `${baseUrl}/videos/${videoId}/tags`
        )
      );
      return result.tags;
    } catch (error) {
      console.error('[DatabaseLibraryService] Error getting video tags:', error);
      return [];
    }
  }

  /**
   * Add a tag to a video
   */
  async addVideoTag(
    videoId: string,
    tagName: string,
    tagType?: string,
    confidence?: number,
    source?: string
  ): Promise<{ success: boolean; tagId?: string; message?: string; error?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      return await firstValueFrom(
        this.http.post<{ success: boolean; tagId?: string; message?: string; error?: string }>(
          `${baseUrl}/videos/${videoId}/tags`,
          { tagName, tagType, confidence, source }
        )
      );
    } catch (error) {
      console.error('[DatabaseLibraryService] Error adding tag:', error);
      return { success: false, error: 'Failed to add tag' };
    }
  }

  /**
   * Delete a tag from a video
   */
  async deleteVideoTag(
    videoId: string,
    tagId: string
  ): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      return await firstValueFrom(
        this.http.delete<{ success: boolean; message?: string; error?: string }>(
          `${baseUrl}/videos/${videoId}/tags/${tagId}`
        )
      );
    } catch (error) {
      console.error('[DatabaseLibraryService] Error deleting tag:', error);
      return { success: false, error: 'Failed to delete tag' };
    }
  }

  /**
   * Update video filename (renames both database record AND physical file)
   */
  async updateVideoFilename(
    videoId: string,
    newFilename: string
  ): Promise<{ success: boolean; message?: string; error?: string; newPath?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.patch<{ success: boolean; message?: string; error?: string; newPath?: string }>(
          `${baseUrl}/videos/${videoId}/filename`,
          { filename: newFilename }
        )
      );

      // Clear cache if successful since data changed
      if (result.success) {
        this.clearCache();
      }

      return result;
    } catch (error: any) {
      console.error('[DatabaseLibraryService] Error updating filename:', error);
      return { success: false, error: error.error?.error || 'Failed to update filename' };
    }
  }

  // ============================================================================
  // PARENT-CHILD OPERATIONS
  // ============================================================================

  /**
   * Set a parent for a video (create parent-child relationship)
   */
  async setVideoParent(childId: string, parentId: string | null): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.post<{ success: boolean; message?: string; error?: string }>(
          `${baseUrl}/videos/${childId}/set-parent`,
          { parentId }
        )
      );

      // Clear cache if successful since data changed
      if (result.success) {
        this.clearCache();
      }

      return result;
    } catch (error: any) {
      console.error('[DatabaseLibraryService] Error setting parent:', error);
      return { success: false, error: error.error?.error || 'Failed to set parent' };
    }
  }

  /**
   * Remove parent from a video (make it a root video)
   */
  async removeVideoParent(childId: string): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.post<{ success: boolean; message?: string; error?: string }>(
          `${baseUrl}/videos/${childId}/remove-parent`,
          {}
        )
      );

      // Clear cache if successful since data changed
      if (result.success) {
        this.clearCache();
      }

      return result;
    } catch (error: any) {
      console.error('[DatabaseLibraryService] Error removing parent:', error);
      return { success: false, error: error.error?.error || 'Failed to remove parent' };
    }
  }

  /**
   * Get all children of a parent video
   */
  async getChildVideos(parentId: string): Promise<DatabaseVideo[]> {
    try {
      const baseUrl = await this.getBaseUrl();
      const response = await firstValueFrom(
        this.http.get<{ success: boolean; children: DatabaseVideo[] }>(
          `${baseUrl}/videos/${parentId}/children`
        )
      );
      return response.children || [];
    } catch (error) {
      console.error('[DatabaseLibraryService] Error getting children:', error);
      return [];
    }
  }

  /**
   * Link multiple files to a parent video
   * If files don't exist in library, they will be imported
   */
  async linkFilesToParent(parentId: string, filePaths: string[]): Promise<{
    success: boolean;
    message?: string;
    error?: string;
    results?: Array<{ filename: string; videoId: string; status: string }>;
    errors?: Array<{ filePath: string; error: string }>;
  }> {
    try {
      const baseUrl = await this.getBaseUrl();
      const result = await firstValueFrom(
        this.http.post<{
          success: boolean;
          message?: string;
          error?: string;
          results?: Array<{ filename: string; videoId: string; status: string }>;
          errors?: Array<{ filePath: string; error: string }>;
        }>(
          `${baseUrl}/videos/link-files`,
          { parentId, filePaths }
        )
      );

      // Clear cache if successful since data changed
      if (result.success) {
        this.clearCache();
      }

      return result;
    } catch (error: any) {
      console.error('[DatabaseLibraryService] Error linking files:', error);
      return { success: false, error: error.error?.error || 'Failed to link files' };
    }
  }
}
