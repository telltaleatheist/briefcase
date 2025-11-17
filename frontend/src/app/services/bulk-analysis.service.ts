import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, interval, Subscription } from 'rxjs';
import { environment } from '../../environment/environment';

export interface UnprocessedVideo {
  id: string;
  filename: string;
  current_path: string;
  upload_date?: string;
  download_date?: string;
  duration_seconds?: number;
  needs_transcript: number;
  needs_analysis: number;
}

export interface BulkAnalysisConfig {
  operationType: 'transcribe' | 'analyze';
  aiModel: string;
  whisperModel: string;
  sortOrder: 'oldest' | 'newest' | 'shortest' | 'longest';
}

export interface BulkAnalysisProgress {
  total: number;
  processed: number;
  failed: number;
  remaining: number;
  currentVideo?: string;
  isProcessing: boolean;
  errors: Array<{ videoId: string; filename: string; error: string }>;
  estimatedTimeRemaining?: number; // in seconds
  averageTimePerVideo?: number; // in seconds
}

@Injectable({
  providedIn: 'root'
})
export class BulkAnalysisService {
  private readonly apiUrl = environment.apiBaseUrl;

  // Queue management
  private queuedVideos = new BehaviorSubject<UnprocessedVideo[]>([]);
  private processedVideos = new BehaviorSubject<string[]>([]);
  private failedVideos = new BehaviorSubject<Array<{ videoId: string; filename: string; error: string }>>([]);

  // Processing state
  private isProcessing = new BehaviorSubject<boolean>(false);
  private currentVideoId = new BehaviorSubject<string | null>(null);
  private config: BulkAnalysisConfig | null = null;
  private sessionTotal: number = 0; // Total videos in current processing session
  private sessionStartTime: number = 0; // Timestamp when session started
  private videoProcessingTimes: number[] = []; // Array of processing times in seconds

  // Job tracking
  private currentJobIds: string[] = [];
  private pollingSubscription: Subscription | null = null;

  constructor(private http: HttpClient) {
    // Load state from localStorage on init
    this.loadStateFromStorage();
  }

  /**
   * Get observable of queued videos
   */
  getQueuedVideos(): Observable<UnprocessedVideo[]> {
    return this.queuedVideos.asObservable();
  }

  /**
   * Get observable of processed videos
   */
  getProcessedVideos(): Observable<string[]> {
    return this.processedVideos.asObservable();
  }

  /**
   * Get observable of failed videos
   */
  getFailedVideos(): Observable<Array<{ videoId: string; filename: string; error: string }>> {
    return this.failedVideos.asObservable();
  }

  /**
   * Get observable of processing state
   */
  getIsProcessing(): Observable<boolean> {
    return this.isProcessing.asObservable();
  }

  /**
   * Get observable of current video being processed
   */
  getCurrentVideoId(): Observable<string | null> {
    return this.currentVideoId.asObservable();
  }

  /**
   * Get progress statistics
   */
  getProgress(): BulkAnalysisProgress {
    const queued = this.queuedVideos.value;
    const processed = this.processedVideos.value;
    const failed = this.failedVideos.value;
    const currentVid = this.currentVideoId.value;

    const currentVideo = currentVid
      ? queued.find(v => v.id === currentVid)?.filename
      : undefined;

    // Use sessionTotal if processing, otherwise use current queue size
    const total = this.sessionTotal > 0 ? this.sessionTotal : queued.length;

    // Calculate average time per video and estimated remaining time
    let averageTimePerVideo: number | undefined;
    let estimatedTimeRemaining: number | undefined;

    if (this.videoProcessingTimes.length > 0 && queued.length > 0) {
      // Calculate average from completed videos
      const sum = this.videoProcessingTimes.reduce((a, b) => a + b, 0);
      averageTimePerVideo = sum / this.videoProcessingTimes.length;

      // Estimate remaining time
      estimatedTimeRemaining = averageTimePerVideo * queued.length;
    }

    return {
      total: total,
      processed: processed.length,
      failed: failed.length,
      remaining: queued.length,
      currentVideo,
      isProcessing: this.isProcessing.value,
      errors: failed,
      estimatedTimeRemaining,
      averageTimePerVideo
    };
  }

  /**
   * Fetch all unprocessed videos from backend
   */
  async fetchUnprocessedVideos(): Promise<UnprocessedVideo[]> {
    const response = await this.http.get<{ videos: UnprocessedVideo[]; count: number }>(
      `${this.apiUrl}/database/needs-analysis`
    ).toPromise();

    return response?.videos || [];
  }

  /**
   * Initialize queue with unprocessed videos
   */
  async initializeQueue(sortOrder: 'oldest' | 'newest' | 'shortest' | 'longest' = 'oldest'): Promise<void> {
    const videos = await this.fetchUnprocessedVideos();
    const sorted = this.sortVideos(videos, sortOrder);

    this.queuedVideos.next(sorted);
    this.processedVideos.next([]);
    this.failedVideos.next([]);
    this.saveStateToStorage();
  }

  /**
   * Sort videos based on sort order
   */
  private sortVideos(videos: UnprocessedVideo[], sortOrder: string): UnprocessedVideo[] {
    const sorted = [...videos];

    switch (sortOrder) {
      case 'oldest':
        sorted.sort((a, b) => {
          const dateA = new Date(a.download_date || a.upload_date || 0).getTime();
          const dateB = new Date(b.download_date || b.upload_date || 0).getTime();
          return dateA - dateB;
        });
        break;
      case 'newest':
        sorted.sort((a, b) => {
          const dateA = new Date(a.download_date || a.upload_date || 0).getTime();
          const dateB = new Date(b.download_date || b.upload_date || 0).getTime();
          return dateB - dateA;
        });
        break;
      case 'shortest':
        sorted.sort((a, b) => (a.duration_seconds || 0) - (b.duration_seconds || 0));
        break;
      case 'longest':
        sorted.sort((a, b) => (b.duration_seconds || 0) - (a.duration_seconds || 0));
        break;
    }

    return sorted;
  }

  /**
   * Remove video from queue
   */
  removeFromQueue(videoId: string): void {
    const current = this.queuedVideos.value;
    const filtered = current.filter(v => v.id !== videoId);
    this.queuedVideos.next(filtered);
    this.saveStateToStorage();
  }

  /**
   * Start processing the queue using the new queue API
   * @param config - Configuration for processing
   * @param selectedVideoIds - Optional array of video IDs to process. If provided, only these will be processed.
   */
  async startProcessing(config: BulkAnalysisConfig, selectedVideoIds?: string[]): Promise<void> {
    if (this.isProcessing.value) {
      throw new Error('Processing already in progress');
    }

    // Get videos to process
    let videosToProcess: UnprocessedVideo[];
    if (selectedVideoIds && selectedVideoIds.length > 0) {
      videosToProcess = this.queuedVideos.value.filter(v => selectedVideoIds.includes(v.id));
    } else {
      videosToProcess = this.queuedVideos.value;
    }

    if (videosToProcess.length === 0) {
      throw new Error('No videos to process');
    }

    // Set session total
    this.sessionTotal = videosToProcess.length;

    // Reset session counters
    this.processedVideos.next([]);
    this.failedVideos.next([]);
    this.sessionStartTime = Date.now();
    this.videoProcessingTimes = [];

    this.config = config;
    this.isProcessing.next(true);

    // Build tasks based on operation type
    const tasks: Array<{ type: string; options?: any }> = [];

    // Always transcribe first
    tasks.push({
      type: 'transcribe',
      options: { whisperModel: config.whisperModel }
    });

    // Add analysis if requested
    if (config.operationType === 'analyze') {
      tasks.push({
        type: 'analyze',
        options: { aiModel: config.aiModel }
      });
    }

    // Create jobs array for bulk submission
    const jobs = videosToProcess.map(video => ({
      videoId: video.id,
      videoPath: video.current_path,
      displayName: video.filename,
      tasks: tasks
    }));

    try {
      // Submit all jobs to the queue at once
      const response = await this.http.post<{ success: boolean; jobIds: string[] }>(
        `${this.apiUrl}/queue/add-bulk`,
        {
          queueType: 'analysis',
          jobs: jobs
        }
      ).toPromise();

      if (!response?.success || !response.jobIds) {
        throw new Error('Failed to submit jobs to queue');
      }

      this.currentJobIds = response.jobIds;
      this.saveStateToStorage();

      // Start polling for job completion
      this.startPollingJobs();
    } catch (error: any) {
      this.isProcessing.next(false);
      throw new Error(`Failed to start processing: ${error.message}`);
    }
  }

  /**
   * Start polling for job status updates
   */
  private startPollingJobs(): void {
    // Poll every 2 seconds
    this.pollingSubscription = interval(2000).subscribe(async () => {
      try {
        await this.updateJobStatuses();
      } catch (error) {
        console.error('Error polling job statuses:', error);
      }
    });
  }

  /**
   * Update job statuses from the queue API
   */
  private async updateJobStatuses(): Promise<void> {
    if (!this.isProcessing.value || this.currentJobIds.length === 0) {
      return;
    }

    try {
      // Get queue status for analysis queue
      const response = await this.http.get<{ success: boolean; status: any }>(
        `${this.apiUrl}/queue/status?type=analysis`
      ).toPromise();

      if (!response?.success || !response.status) {
        return;
      }

      const status = response.status;
      const allJobs = [
        ...status.pendingJobs,
        ...status.processingJobs,
        ...status.completedJobs,
        ...status.failedJobs
      ];

      // Find our jobs
      const ourJobs = allJobs.filter(job => this.currentJobIds.includes(job.id));

      // Update progress based on job statuses
      const completedJobs = ourJobs.filter(job => job.status === 'completed');
      const failedJobs = ourJobs.filter(job => job.status === 'failed');
      const processingJobs = ourJobs.filter(job => job.status === 'processing');

      // Update processed videos
      const processedVideoIds = completedJobs.map(job => job.videoId).filter(Boolean);
      this.processedVideos.next(processedVideoIds);

      // Update failed videos
      const failedVideosList = failedJobs.map(job => {
        const video = this.queuedVideos.value.find(v => v.id === job.videoId);
        return {
          videoId: job.videoId || '',
          filename: video?.filename || job.displayName || 'Unknown',
          error: job.error || 'Unknown error'
        };
      });
      this.failedVideos.next(failedVideosList);

      // Update current video
      if (processingJobs.length > 0) {
        this.currentVideoId.next(processingJobs[0].videoId || null);
      } else {
        this.currentVideoId.next(null);
      }

      // Remove completed and failed videos from queue
      const processedOrFailedIds = [...processedVideoIds, ...failedVideosList.map(f => f.videoId)];
      const remainingVideos = this.queuedVideos.value.filter(v => !processedOrFailedIds.includes(v.id));
      this.queuedVideos.next(remainingVideos);

      // Check if all jobs are complete
      const allComplete = ourJobs.every(job => job.status === 'completed' || job.status === 'failed');
      if (allComplete) {
        this.stopProcessing();
      }

      this.saveStateToStorage();
    } catch (error) {
      console.error('Error updating job statuses:', error);
    }
  }

  /**
   * Pause processing (stops polling but doesn't cancel jobs)
   */
  pauseProcessing(): void {
    this.isProcessing.next(false);
    this.currentVideoId.next(null);

    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }

    this.saveStateToStorage();
  }

  /**
   * Resume processing (restarts polling)
   */
  async resumeProcessing(): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration available. Please start processing from the beginning.');
    }

    this.isProcessing.next(true);
    this.saveStateToStorage();

    // Restart polling
    this.startPollingJobs();
  }

  /**
   * Stop processing completely
   */
  stopProcessing(): void {
    this.isProcessing.next(false);
    this.currentVideoId.next(null);
    this.config = null;
    this.sessionTotal = 0;
    this.sessionStartTime = 0;
    this.videoProcessingTimes = [];

    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }

    this.saveStateToStorage();
  }

  /**
   * Clear the entire queue and reset
   */
  clearQueue(): void {
    this.queuedVideos.next([]);
    this.processedVideos.next([]);
    this.failedVideos.next([]);
    this.isProcessing.next(false);
    this.currentVideoId.next(null);
    this.config = null;
    this.sessionTotal = 0;
    this.sessionStartTime = 0;
    this.videoProcessingTimes = [];
    this.saveStateToStorage();
  }

  /**
   * Save state to localStorage for persistence
   */
  private saveStateToStorage(): void {
    const state = {
      queued: this.queuedVideos.value,
      processed: this.processedVideos.value,
      failed: this.failedVideos.value,
      isProcessing: this.isProcessing.value,
      currentVideoId: this.currentVideoId.value,
      config: this.config,
      sessionTotal: this.sessionTotal,
      currentJobIds: this.currentJobIds
    };

    localStorage.setItem('bulk-analysis-state', JSON.stringify(state));
  }

  /**
   * Load state from localStorage
   */
  private loadStateFromStorage(): void {
    const stored = localStorage.getItem('bulk-analysis-state');

    if (!stored) return;

    try {
      const state = JSON.parse(stored);

      this.queuedVideos.next(state.queued || []);
      this.processedVideos.next(state.processed || []);
      this.failedVideos.next(state.failed || []);
      this.config = state.config || null;
      this.sessionTotal = state.sessionTotal || 0;
      this.currentJobIds = state.currentJobIds || [];

      // Don't auto-resume processing on load
      this.isProcessing.next(false);
      this.currentVideoId.next(null);
    } catch (error) {
      console.error('Failed to load bulk analysis state from localStorage:', error);
    }
  }
}
