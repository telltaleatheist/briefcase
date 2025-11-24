import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, firstValueFrom } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
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

// Backend task types (different from frontend TaskType)
export type BackendTaskType =
  | 'get-info'
  | 'download'
  | 'import'
  | 'fix-aspect-ratio'
  | 'normalize-audio'
  | 'process-video'
  | 'transcribe'
  | 'analyze';

export interface BackendTask {
  type: BackendTaskType;
  options?: any;
}

export interface BackendJobRequest {
  url?: string;
  videoId?: string;
  videoPath?: string;
  displayName?: string;
  libraryId?: string;
  tasks: BackendTask[];
}

export interface BulkJobRequest {
  jobs: BackendJobRequest[];
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
  private readonly API_BASE = 'http://localhost:3000/api';

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
    return this.http.get<any>(`${this.API_BASE}/database/videos`, {
      params: { includeRelationships: 'true' }
    }).pipe(
      map(response => {
        console.log('Raw API response:', response);
        const videos = this.transformVideos(response.videos || []);
        console.log('Transformed videos:', videos.length);
        const weeks = this.groupVideosByWeekWithHierarchy(videos);
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
   * @param mode - 'database-only' (keep file), 'file-only' (keep db entry), 'everything' (delete both)
   */
  deleteVideo(id: string, mode: 'database-only' | 'file-only' | 'everything' = 'everything'): Observable<ApiResponse<void>> {
    return this.http.delete<any>(`${this.API_BASE}/database/videos/${id}`, {
      body: { mode }
    }).pipe(
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
      suggestedFilename: video.suggested_title || undefined,
      duration: this.formatDuration(video.duration || video.duration_seconds || 0),
      size: video.file_size || video.file_size_bytes,
      uploadDate: video.upload_date ? this.parseLocalDate(video.upload_date) : undefined,
      downloadDate: video.download_date ? this.parseLocalDate(video.download_date) : undefined,
      lastProcessedDate: video.last_processed_date ? this.parseLocalDate(video.last_processed_date) : undefined,
      thumbnailUrl: video.id ? `${this.API_BASE}/database/videos/${video.id}/thumbnail` : undefined,
      // Additional fields for context menu actions
      filePath: video.file_path || video.filepath || video.current_path,
      suggestedTitle: video.suggested_title,
      hasTranscript: video.has_transcript === 1 || video.has_transcript === true,
      hasAnalysis: video.has_analysis === 1 || video.has_analysis === true,
      // Searchable fields
      aiDescription: video.ai_description,
      sourceUrl: video.source_url,
      tags: video.tags || [],
      // Media type info
      mediaType: video.media_type,
      fileExtension: video.file_extension,
      // Parent-child relationships
      parentIds: video.parent_ids || [],
      childIds: video.child_ids || [],
      children: video.children ? video.children.map((c: any) => this.transformVideo(c)) : [],
      parents: video.parents ? video.parents.map((p: any) => this.transformVideo(p)) : [],
      isGhost: video.is_ghost || false
    };
  }

  /**
   * Transform array of backend videos
   */
  private transformVideos(videos: any[]): VideoItem[] {
    return videos.map(v => this.transformVideo(v));
  }

  /**
   * Parse date string as local time to avoid timezone shift
   * "2025-11-17" should display as Nov 17, not Nov 16
   */
  private parseLocalDate(dateStr: string): Date {
    // If it's an ISO string with time (e.g., "2025-11-17T12:00:00Z"), parse normally
    if (dateStr.includes('T')) {
      return new Date(dateStr);
    }
    // For date-only strings (e.g., "2025-11-17"), parse as local time
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
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
   * Videos appear in "Past 24 Hours" based on lastProcessedDate (or downloadDate as fallback)
   */
  private groupVideosByWeek(videos: VideoItem[]): VideoWeek[] {
    const dateMap = new Map<string, VideoItem[]>();
    const now = new Date();
    const past24Hours: VideoItem[] = [];

    // Sort videos by most recent activity (lastProcessedDate or downloadDate)
    const sortedVideos = [...videos].sort((a, b) => {
      const dateA = (a.lastProcessedDate || a.downloadDate) ? new Date(a.lastProcessedDate || a.downloadDate!).getTime() : 0;
      const dateB = (b.lastProcessedDate || b.downloadDate) ? new Date(b.lastProcessedDate || b.downloadDate!).getTime() : 0;
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

      // Use lastProcessedDate for "New" section, fall back to downloadDate
      const activityDate = video.lastProcessedDate || video.downloadDate;
      const videoDate = new Date(activityDate);
      const hoursDiff = (now.getTime() - videoDate.getTime()) / (1000 * 60 * 60);

      // Check if within past 24 hours (based on recent activity)
      if (hoursDiff <= 24) {
        past24Hours.push(video);
      }

      // Always add to date group based on download date
      const dateKey = this.getDateKey(new Date(video.downloadDate));
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
   * Group videos by week with hierarchical parent-child relationships and ghost items
   */
  private groupVideosByWeekWithHierarchy(videos: VideoItem[]): VideoWeek[] {
    // First, group videos by week normally
    const weeks = this.groupVideosByWeek(videos);

    // Create a map of video ID to video for quick lookup
    const videoMap = new Map<string, VideoItem>();
    videos.forEach(v => videoMap.set(v.id, v));

    // Process each week to add hierarchical structure
    weeks.forEach(week => {
      const processedVideos: VideoItem[] = [];
      const handledIds = new Set<string>();

      week.videos.forEach(video => {
        // Skip if already handled as a child
        if (handledIds.has(video.id)) return;

        // Only show parent videos (videos with no parents)
        // or root-level videos (no parent relationships)
        const isChild = video.parentIds && video.parentIds.length > 0;

        if (!isChild) {
          // Add the parent/root video
          processedVideos.push(video);
          handledIds.add(video.id);

          // Add its children if they're in the same week
          if (video.childIds && video.childIds.length > 0) {
            const ghostChildren: VideoItem[] = [];

            video.childIds.forEach(childId => {
              const child = videoMap.get(childId);
              if (child && week.videos.some(v => v.id === childId)) {
                // Child is in the same week - add it normally (will be indented by cascade)
                processedVideos.push(child);
                handledIds.add(childId);
              } else if (child) {
                // Child is in a different week - collect as ghost item
                ghostChildren.push(child);
              }
            });

            // Add ghost children with relationship indicator only on the first one
            ghostChildren.forEach((child, index) => {
              const isFirstGhost = index === 0;
              const ghostCount = ghostChildren.length;

              const ghostChild: VideoItem = {
                ...child,
                isGhost: true,
                // Only add relationship metadata to first ghost child
                ...(isFirstGhost && {
                  ghostType: 'child' as const,
                  ghostRelatedName: ghostCount === 1 ? video.name : `${video.name} (${ghostCount} children)`
                })
              };
              processedVideos.push(ghostChild);
              // Don't add to handledIds - it can still appear in its own week
            });
          }
        }
      });

      // Check for children whose parents are in other weeks
      // Group children by their parent IDs to avoid duplicate ghost parents
      const childrenByParent = new Map<string, VideoItem[]>();

      week.videos.forEach(video => {
        if (handledIds.has(video.id)) return;

        // This is a child whose parent is in a different week
        if (video.parentIds && video.parentIds.length > 0) {
          video.parentIds.forEach(parentId => {
            // Only consider parents that aren't in this week
            if (!week.videos.some(v => v.id === parentId)) {
              if (!childrenByParent.has(parentId)) {
                childrenByParent.set(parentId, []);
              }
              childrenByParent.get(parentId)!.push(video);
            }
          });
        }
      });

      // Add ghost parents with their children
      // We need to track which child videos we've already added indicators for
      const childrenWithIndicators = new Set<string>();

      childrenByParent.forEach((children, parentId) => {
        const parent = videoMap.get(parentId);
        if (parent) {
          // Check if any of these children already have an indicator
          const firstChildWithoutIndicator = children.find(c => !childrenWithIndicators.has(c.id));
          const shouldShowIndicator = firstChildWithoutIndicator !== undefined;

          // Count how many children this parent has
          const childCount = children.length;

          // Add ghost parent once with info about all children
          const ghostParent: VideoItem = {
            ...parent,
            isGhost: true,
            // Only add indicator if this is the first ghost parent for these children
            ...(shouldShowIndicator && {
              ghostType: 'parent' as const,
              ghostRelatedName: childCount === 1 ? children[0].name : `${childCount} videos`
            })
          };
          processedVideos.push(ghostParent);

          // Add all children of this parent (only once)
          children.forEach(child => {
            if (!handledIds.has(child.id)) {
              processedVideos.push(child);
              handledIds.add(child.id);
              if (shouldShowIndicator) {
                childrenWithIndicators.add(child.id);
              }
            }
          });
        }
      });

      week.videos = processedVideos;
    });

    return weeks;
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
  createJob(request: BackendJobRequest): Observable<ApiResponse<JobResponse>> {
    return this.http.post<any>(
      `${this.API_BASE}/queue/jobs`,
      request
    ).pipe(
      map(response => ({
        success: response.success,
        data: {
          id: response.jobId,
          status: 'pending',
          tasks: request.tasks
        }
      }))
    );
  }

  /**
   * Create multiple jobs in bulk
   * POST /api/queue/jobs/bulk
   */
  createBulkJobs(jobs: BackendJobRequest[]): Observable<ApiResponse<{ jobIds: string[] }>> {
    return this.http.post<any>(
      `${this.API_BASE}/queue/jobs/bulk`,
      { jobs }
    ).pipe(
      map(response => ({
        success: response.success,
        data: {
          jobIds: response.jobIds || []
        }
      }))
    );
  }

  /**
   * Convert frontend task type to backend tasks
   * e.g., 'download-import' → ['get-info', 'download', 'import']
   */
  convertToBackendTasks(frontendTaskType: string, config?: any): BackendTask[] {
    switch (frontendTaskType) {
      case 'download-import':
        return [
          { type: 'get-info' },
          { type: 'download', options: config?.download || {} },
          { type: 'import', options: config?.import || {} }
        ];

      case 'fix-aspect-ratio':
        return [{ type: 'fix-aspect-ratio', options: config || {} }];

      case 'normalize-audio':
        return [{
          type: 'normalize-audio',
          options: {
            level: config?.targetLevel || -16,
            method: config?.method || 'ebu-r128'
          }
        }];

      case 'transcribe':
        return [{
          type: 'transcribe',
          options: {
            model: config?.model || 'base',
            language: config?.language || 'en'
          }
        }];

      case 'ai-analyze':
        // Parse model value in format "provider:model" (e.g., "ollama:qwen2.5:7b")
        const modelValue = config?.aiModel || 'ollama:qwen2.5:7b';
        let aiProvider = 'ollama';
        let aiModel = modelValue;

        if (modelValue.includes(':')) {
          const colonIndex = modelValue.indexOf(':');
          aiProvider = modelValue.substring(0, colonIndex);
          aiModel = modelValue.substring(colonIndex + 1);
        }

        return [{
          type: 'analyze',
          options: {
            aiModel,
            aiProvider,
            customInstructions: config?.customInstructions || ''
          }
        }];

      default:
        console.warn(`Unknown task type: ${frontendTaskType}`);
        return [];
    }
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
    return this.http.get<any>(`${this.API_BASE}/queue/status`).pipe(
      map(response => ({
        success: response.success,
        data: response.status
      }))
    );
  }

  /**
   * Get all jobs in queue
   * GET /api/queue/jobs
   */
  getQueueJobs(): Observable<ApiResponse<any[]>> {
    return this.http.get<any>(`${this.API_BASE}/queue/jobs`).pipe(
      map(response => ({
        success: response.success,
        data: response.jobs || []
      }))
    );
  }

  /**
   * Get a specific job
   * GET /api/queue/job/:jobId
   */
  getJob(jobId: string): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/queue/job/${jobId}`).pipe(
      map(response => ({
        success: response.success,
        data: response.job
      }))
    );
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

  /**
   * Update suggested title for a video
   * PATCH /api/database/videos/:id/suggested-title
   */
  updateSuggestedTitle(id: string, suggestedTitle: string): Observable<ApiResponse<any>> {
    return this.http.patch<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/suggested-title`,
      { suggestedTitle }
    );
  }

  /**
   * Rename video file (renames both database record AND physical file)
   * PATCH /api/database/videos/:id/filename
   */
  renameVideoFile(id: string, filename: string): Observable<ApiResponse<any>> {
    return this.http.patch<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/filename`,
      { filename }
    );
  }

  /**
   * Accept suggested title - renames file and clears suggested title
   * POST /api/database/videos/:id/accept-suggested-title
   */
  acceptSuggestedTitle(id: string, customFilename: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/accept-suggested-title`,
      { customFilename }
    );
  }

  /**
   * Clear/reject the AI-suggested title from the database
   * POST /api/database/videos/:id/reject-suggested-title
   */
  clearSuggestedTitle(id: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${id}/reject-suggested-title`,
      {}
    );
  }

  /**
   * Remove parent-child relationship between two videos
   * POST /api/database/videos/:parentId/remove-child/:childId
   */
  removeParentChildRelationship(parentId: string, childId: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/videos/${parentId}/remove-child/${childId}`,
      {}
    );
  }

  /**
   * Get the .clippyignore file content
   * GET /api/database/ignore
   */
  getIgnoreFile(): Observable<ApiResponse<{ content: string; filePath: string; patterns: string[] }>> {
    return this.http.get<ApiResponse<{ content: string; filePath: string; patterns: string[] }>>(
      `${this.API_BASE}/database/ignore`
    );
  }

  /**
   * Update the .clippyignore file content
   * POST /api/database/ignore
   */
  updateIgnoreFile(content: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/ignore`,
      { content }
    );
  }

  /**
   * Add a pattern to the .clippyignore file
   * POST /api/database/ignore/add
   */
  addIgnorePattern(pattern: string): Observable<ApiResponse<any>> {
    return this.http.post<ApiResponse<any>>(
      `${this.API_BASE}/database/ignore/add`,
      { pattern }
    );
  }

  /**
   * Scan database for ignored entries and remove them
   * POST /api/database/scan-ignored
   */
  scanAndRemoveIgnored(): Observable<ApiResponse<{ removed: string[]; message: string }>> {
    return this.http.post<ApiResponse<{ removed: string[]; message: string }>>(
      `${this.API_BASE}/database/scan-ignored`,
      {}
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
      map(response => {
        // Update the signal when we get the current library
        if (response.library) {
          this.currentLibrary.set(response.library);
        }
        return {
          success: !!response.library,
          data: response.library
        };
      })
    );
  }

  /**
   * Switch to a different library
   * POST /api/database/libraries/:id/switch
   */
  switchLibrary(libraryId: string): Observable<ApiResponse<Library>> {
    return this.http.post<any>(`${this.API_BASE}/database/libraries/${libraryId}/switch`, {}).pipe(
      map(response => {
        // Update the signal when switching libraries
        if (response.success && response.library) {
          this.currentLibrary.set(response.library);
        }
        return {
          success: response.success,
          data: response.library
        };
      })
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
      map(response => {
        // Update the signal when creating a new library (it becomes active)
        if (response.success && response.library) {
          this.currentLibrary.set(response.library);
        }
        return {
          success: response.success,
          data: response.library
        };
      })
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
   * Update a library's name and path
   * PUT /api/database/libraries/:id
   */
  updateLibrary(libraryId: string, name: string, path: string): Observable<ApiResponse<Library>> {
    return this.http.put<any>(`${this.API_BASE}/database/libraries/${libraryId}`, { name, path }).pipe(
      map(response => ({
        success: response.success,
        data: response.library
      }))
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

  /**
   * Get video transcript by video ID
   * GET /api/database/videos/:id/transcript
   */
  getVideoTranscript(videoId: string): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/transcript`).pipe(
      map(response => ({
        success: true,
        data: response.transcript || response
      })),
      catchError(error => {
        if (error.status === 404) {
          return of({ success: true, data: null });
        }
        throw error;
      })
    );
  }

  /**
   * Get video analysis by video ID
   * GET /api/database/videos/:id/analysis
   */
  getVideoAnalysis(videoId: string): Observable<ApiResponse<any>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/analysis`).pipe(
      map(response => ({
        success: true,
        data: response.analysis || response
      })),
      catchError(error => {
        if (error.status === 404) {
          return of({ success: true, data: null });
        }
        throw error;
      })
    );
  }

  /**
   * Get video tags by video ID
   * GET /api/database/videos/:id/tags
   */
  getVideoTags(videoId: string): Observable<ApiResponse<string[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/tags`).pipe(
      map(response => ({
        success: true,
        data: response.tags || []
      }))
    );
  }

  /**
   * Get video analysis sections by video ID
   * GET /api/database/videos/:id/sections
   */
  getVideoSections(videoId: string): Observable<ApiResponse<any[]>> {
    return this.http.get<any>(`${this.API_BASE}/database/videos/${videoId}/sections`).pipe(
      map(response => ({
        success: true,
        data: response.sections || []
      }))
    );
  }

  /**
   * Get video info from URL (title, duration, etc.)
   * GET /api/downloader/info?url=...
   */
  getVideoInfo(url: string): Observable<ApiResponse<{ title: string; duration?: number; thumbnail?: string }>> {
    return this.http.get<any>(`${this.API_BASE}/downloader/info`, {
      params: { url }
    }).pipe(
      map(response => ({
        success: !response.error,
        data: {
          title: response.title || 'Unknown Video',
          duration: response.duration,
          thumbnail: response.thumbnail
        }
      })),
      catchError(error => {
        console.error('Failed to fetch video info:', error);
        return of({
          success: false,
          data: { title: 'Unknown Video' }
        });
      })
    );
  }

  /**
   * Get default AI settings
   * GET /api/config/default-ai
   */
  getDefaultAI(): Observable<{ success: boolean; defaultAI: { provider: string; model: string } | null }> {
    return this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
      `${this.API_BASE}/config/default-ai`
    );
  }

  /**
   * Save default AI settings
   * POST /api/config/default-ai
   */
  saveDefaultAI(provider: string, model: string): Observable<{ success: boolean; message: string; defaultAI: { provider: string; model: string } }> {
    return this.http.post<{ success: boolean; message: string; defaultAI: { provider: string; model: string } }>(
      `${this.API_BASE}/config/default-ai`,
      { provider, model }
    );
  }
}
