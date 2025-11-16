import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { SocketService } from './socket.service';
import { DatabaseLibraryService } from './database-library.service';
import { VideoProcessingQueueService } from './video-processing-queue.service';

/**
 * Normalized video state model - SINGLE SOURCE OF TRUTH
 */
export interface VideoState {
  // Core identity
  id: string;
  filename: string;
  currentPath: string;

  // Processing status (from queue/websockets)
  processingStatus: 'idle' | 'queued' | 'processing' | 'completed' | 'failed';
  processingProgress: number;

  // Metadata flags (from database - determine dot color)
  hasTranscript: boolean;
  hasAnalysis: boolean;

  // Full metadata (contains all database fields)
  metadata: {
    suggestedTitle?: string;
    aiDescription?: string;
    uploadDate?: string;
    downloadDate?: string;
    addedAt?: string;
    duration?: number;
    fileSize?: number;
    parentId?: string;
    isLinked?: number;
    // Add other fields as needed
    [key: string]: any;
  };

  // Active job reference (if processing)
  activeJobId?: string;

  // Timestamps
  lastUpdated: Date;
}

/**
 * VideoStateService - Single source of truth for all video state
 *
 * Responsibilities:
 * - Maintain normalized Map<videoId, VideoState>
 * - Handle updates from database, websockets, processing queue
 * - Emit updates through observables
 * - Provide search/filter capabilities
 */
@Injectable({
  providedIn: 'root'
})
export class VideoStateService {
  // Single source of truth - all videos in memory
  private videosMap = new Map<string, VideoState>();

  // Observable for components to subscribe to
  private videosSubject = new BehaviorSubject<Map<string, VideoState>>(new Map());
  public videos$ = this.videosSubject.asObservable();

  // Loading state
  private loadingSubject = new BehaviorSubject<boolean>(false);
  public loading$ = this.loadingSubject.asObservable();

  // Error state
  private errorSubject = new BehaviorSubject<string | null>(null);
  public error$ = this.errorSubject.asObservable();

  constructor(
    private socketService: SocketService,
    private databaseLibraryService: DatabaseLibraryService,
    private videoProcessingQueueService: VideoProcessingQueueService
  ) {
    this.setupWebsocketListeners();
    this.setupProcessingQueueListeners();
  }

  /**
   * Initialize: Load all videos from database
   */
  async initialize(): Promise<void> {
    console.log('[VideoStateService] Initializing...');
    this.loadingSubject.next(true);

    try {
      // Clear existing state
      this.videosMap.clear();

      // Load all videos from database (just metadata, no full details yet)
      const result = await this.databaseLibraryService.getVideos(10000, 0, false);

      console.log(`[VideoStateService] Loaded ${result.videos.length} videos from database`);

      // DEBUG: Search for specific video ID in results
      const targetId = '1c4cc888-5d83-441f-b179-fcff863a00e3';
      const targetVideo = result.videos.find((v: any) => v.id === targetId);
      if (targetVideo) {
        console.log(`[VideoStateService] *** FOUND TARGET VIDEO IN BACKEND RESPONSE ***`, {
          id: targetVideo.id,
          filename: targetVideo.filename,
          has_transcript: targetVideo.has_transcript,
          has_analysis: targetVideo.has_analysis
        });
      } else {
        console.warn(`[VideoStateService] *** TARGET VIDEO NOT IN BACKEND RESPONSE ***`);
      }

      // Convert to VideoState and store in map
      for (const dbVideo of result.videos) {
        const videoState = this.createVideoStateFromDatabase(dbVideo);
        this.videosMap.set(videoState.id, videoState);

        // DEBUG: Log target video specifically
        if (dbVideo.id === targetId) {
          console.log(`[VideoStateService] *** MAPPED TARGET VIDEO TO VideoState ***`, {
            id: videoState.id,
            filename: videoState.filename,
            hasTranscript: videoState.hasTranscript,
            hasAnalysis: videoState.hasAnalysis
          });
        }
      }

      // Emit updated state
      this.emitUpdate();

      this.loadingSubject.next(false);
      console.log('[VideoStateService] Initialization complete');
    } catch (error) {
      console.error('[VideoStateService] Initialization failed:', error);
      this.errorSubject.next('Failed to load videos');
      this.loadingSubject.next(false);
      throw error;
    }
  }

  /**
   * Refresh: Reload all videos from database
   */
  async refresh(): Promise<void> {
    console.log('[VideoStateService] Refreshing...');
    await this.initialize();
  }

  /**
   * Get video by ID
   */
  getVideo(videoId: string): VideoState | undefined {
    return this.videosMap.get(videoId);
  }

  /**
   * Get all videos as array
   */
  getAllVideos(): VideoState[] {
    return Array.from(this.videosMap.values());
  }

  /**
   * Update a single video's state
   */
  updateVideo(videoId: string, updates: Partial<VideoState>): void {
    const existing = this.videosMap.get(videoId);
    if (!existing) {
      console.warn(`[VideoStateService] Cannot update non-existent video: ${videoId}`);
      return;
    }

    // Merge updates
    const updated: VideoState = {
      ...existing,
      ...updates,
      metadata: {
        ...existing.metadata,
        ...(updates.metadata || {})
      },
      lastUpdated: new Date()
    };

    this.videosMap.set(videoId, updated);
    this.emitUpdate();

    console.log(`[VideoStateService] Updated video ${videoId}:`, updates);
  }

  /**
   * Add or update a video
   */
  upsertVideo(video: VideoState): void {
    this.videosMap.set(video.id, {
      ...video,
      lastUpdated: new Date()
    });
    this.emitUpdate();
  }

  /**
   * Remove a video
   */
  removeVideo(videoId: string): void {
    this.videosMap.delete(videoId);
    this.emitUpdate();
    console.log(`[VideoStateService] Removed video ${videoId}`);
  }

  /**
   * Setup websocket listeners for real-time updates
   */
  private setupWebsocketListeners(): void {
    console.log('[VideoStateService] Setting up websocket listeners');

    // Video imported
    this.socketService.onVideoImported().subscribe(event => {
      console.log('[VideoStateService] Video imported:', event);
      this.handleVideoImported(event);
    });

    // Transcription completed
    this.socketService.onTranscriptionCompleted().subscribe(event => {
      console.log('[VideoStateService] Transcription completed:', event);
      this.handleTranscriptionCompleted(event);
    });

    // Analysis progress
    this.socketService.onAnalysisProgress().subscribe(event => {
      console.log('[VideoStateService] Analysis progress:', event);
      this.handleAnalysisProgress(event);
    });

    // Processing progress
    this.socketService.onProcessingProgress().subscribe(event => {
      console.log('[VideoStateService] Processing progress:', event);
      this.handleProcessingProgress(event);
    });

    // Download progress
    this.socketService.onDownloadProgress().subscribe(event => {
      console.log('[VideoStateService] Download progress:', event);
      this.handleDownloadProgress(event);
    });
  }

  /**
   * Setup processing queue listeners
   */
  private setupProcessingQueueListeners(): void {
    console.log('[VideoStateService] Setting up processing queue listeners');

    this.videoProcessingQueueService.jobs$.subscribe(jobsMap => {
      // Update videos with active jobs
      jobsMap.forEach((job, jobId) => {
        if (job.videoId) {
          this.updateVideo(job.videoId, {
            processingStatus: this.mapJobStatusToProcessingStatus(job.overallStatus),
            processingProgress: job.overallProgress || 0,
            activeJobId: jobId
          });
        }
      });
    });
  }

  /**
   * Handle video imported event
   */
  private async handleVideoImported(event: any): Promise<void> {
    const videoId = event.videoId || event.video?.id;
    if (!videoId) return;

    // Reload this specific video from database
    try {
      const video = await this.databaseLibraryService.getVideoById(videoId);
      if (video) {
        const videoState = this.createVideoStateFromDatabase(video);
        this.upsertVideo(videoState);
      }
    } catch (error) {
      console.error('[VideoStateService] Failed to load imported video:', error);
    }
  }

  /**
   * Handle transcription completed event
   */
  private handleTranscriptionCompleted(event: any): void {
    const videoId = event.videoId;
    if (!videoId) return;

    this.updateVideo(videoId, {
      hasTranscript: true,
      processingStatus: 'completed'
    });
  }

  /**
   * Handle analysis progress event
   */
  private handleAnalysisProgress(event: any): void {
    const videoId = event.videoId;
    if (!videoId) return;

    const updates: Partial<VideoState> = {
      processingProgress: event.progress || 0
    };

    // If completed, reload from database to get all updated flags and metadata
    if (event.status === 'completed' || event.progress === 100) {
      // Don't update with partial data - let reloadVideoFromDatabase handle it
      // This ensures we get both has_transcript and has_analysis flags from DB
      this.reloadVideoFromDatabase(videoId);
    } else if (event.status === 'failed') {
      updates.processingStatus = 'failed';
      this.updateVideo(videoId, updates);
    } else {
      updates.processingStatus = 'processing';
      this.updateVideo(videoId, updates);
    }
  }

  /**
   * Handle processing progress event
   */
  private handleProcessingProgress(event: any): void {
    const videoId = event.videoId;
    if (!videoId) return;

    this.updateVideo(videoId, {
      processingProgress: event.progress || 0,
      processingStatus: event.status === 'completed' ? 'completed' : 'processing'
    });
  }

  /**
   * Handle download progress event
   */
  private handleDownloadProgress(event: any): void {
    const videoId = event.videoId;
    if (!videoId) return;

    this.updateVideo(videoId, {
      processingProgress: event.progress || 0,
      processingStatus: 'processing'
    });
  }

  /**
   * Reload a specific video from database
   */
  private async reloadVideoFromDatabase(videoId: string): Promise<void> {
    try {
      console.log(`[VideoStateService] Reloading video ${videoId} from database...`);
      const video = await this.databaseLibraryService.getVideoById(videoId);
      if (video) {
        console.log(`[VideoStateService] Reloaded video ${videoId} - has_transcript: ${video.has_transcript}, has_analysis: ${video.has_analysis}, suggested_title: ${video.suggested_title?.substring(0, 50)}`);
        const videoState = this.createVideoStateFromDatabase(video);
        this.upsertVideo(videoState);
      } else {
        console.warn(`[VideoStateService] Video ${videoId} not found in database`);
      }
    } catch (error) {
      console.error(`[VideoStateService] Failed to reload video ${videoId}:`, error);
    }
  }

  /**
   * Public method to refresh a video's state from database
   * Use this when external events (like polling) detect changes
   */
  async refreshVideo(videoId: string): Promise<void> {
    console.log(`[VideoStateService] Refreshing video ${videoId} from database`);
    await this.reloadVideoFromDatabase(videoId);
  }

  /**
   * Create VideoState from database video
   */
  private createVideoStateFromDatabase(dbVideo: any): VideoState {
    const videoState: VideoState = {
      id: dbVideo.id,
      filename: dbVideo.filename || '',
      currentPath: dbVideo.current_path || '',

      // Flags from database
      hasTranscript: Boolean(dbVideo.has_transcript),
      hasAnalysis: Boolean(dbVideo.has_analysis),

      // Processing status (default to idle if no active job)
      processingStatus: 'idle' as const,
      processingProgress: 0,

      // Full metadata
      metadata: {
        suggestedTitle: dbVideo.suggested_title,
        aiDescription: dbVideo.ai_description,
        uploadDate: dbVideo.upload_date,
        downloadDate: dbVideo.download_date,
        addedAt: dbVideo.added_at,
        duration: dbVideo.duration_seconds, // Map from duration_seconds to duration
        fileSize: dbVideo.file_size,
        parentId: dbVideo.parent_id,
        isLinked: dbVideo.is_linked,
        // Additional fields
        file_hash: dbVideo.file_hash,
        file_extension: dbVideo.file_extension,
        thumbnail_path: dbVideo.thumbnail_path
      },

      lastUpdated: new Date()
    };

    // DEBUG: Log if video has suggested_title
    if (dbVideo.suggested_title) {
      console.log(`[VideoStateService] Video ${dbVideo.filename} has suggested_title from DB: "${dbVideo.suggested_title}"`);
      console.log(`[VideoStateService] Mapped to VideoState.metadata.suggestedTitle: "${videoState.metadata.suggestedTitle}"`);
    }

    return videoState;
  }

  /**
   * Map job status to processing status
   */
  private mapJobStatusToProcessingStatus(jobStatus: string): VideoState['processingStatus'] {
    switch (jobStatus) {
      case 'pending': return 'queued';
      case 'processing': return 'processing';
      case 'completed': return 'completed';
      case 'failed': return 'failed';
      default: return 'idle';
    }
  }

  /**
   * Emit updated state to subscribers
   */
  private emitUpdate(): void {
    // Create a new Map to trigger change detection
    const newMap = new Map(this.videosMap);
    this.videosSubject.next(newMap);
  }

  /**
   * Get dot color for a video based on metadata flags
   */
  getDotColor(video: VideoState): 'green' | 'blue' | 'purple' | 'red' {
    const hasT = video.hasTranscript;
    const hasA = video.hasAnalysis;

    if (hasT && hasA) return 'green';   // Both
    if (hasT && !hasA) return 'blue';   // Transcript only
    if (!hasT && hasA) return 'purple'; // Analysis only
    return 'red';                        // Neither
  }

  /**
   * Search videos by filename or metadata
   */
  searchVideos(query: string): VideoState[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllVideos().filter(video => {
      return video.filename.toLowerCase().includes(lowerQuery) ||
             video.metadata.suggestedTitle?.toLowerCase().includes(lowerQuery) ||
             video.metadata.aiDescription?.toLowerCase().includes(lowerQuery);
    });
  }

  /**
   * Filter videos by processing status
   */
  filterByProcessingStatus(status: VideoState['processingStatus']): VideoState[] {
    return this.getAllVideos().filter(video => video.processingStatus === status);
  }

  /**
   * Filter videos by metadata flags
   */
  filterByFlags(hasTranscript?: boolean, hasAnalysis?: boolean): VideoState[] {
    return this.getAllVideos().filter(video => {
      if (hasTranscript !== undefined && video.hasTranscript !== hasTranscript) return false;
      if (hasAnalysis !== undefined && video.hasAnalysis !== hasAnalysis) return false;
      return true;
    });
  }
}
