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
  maxConcurrent: number;
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
   * Start processing the queue
   * @param config - Configuration for processing
   * @param selectedVideoIds - Optional array of video IDs to process. If provided, only these will be processed.
   */
  async startProcessing(config: BulkAnalysisConfig, selectedVideoIds?: string[]): Promise<void> {
    if (this.isProcessing.value) {
      throw new Error('Processing already in progress');
    }

    // If specific videos are selected, filter the queue to only those
    if (selectedVideoIds && selectedVideoIds.length > 0) {
      const currentQueue = this.queuedVideos.value;
      const filteredQueue = currentQueue.filter(v => selectedVideoIds.includes(v.id));
      this.queuedVideos.next(filteredQueue);
    }

    // Set session total to the number of videos we're about to process
    this.sessionTotal = this.queuedVideos.value.length;

    // Reset session counters
    this.processedVideos.next([]);
    this.failedVideos.next([]);
    this.sessionStartTime = Date.now();
    this.videoProcessingTimes = [];

    this.config = config;
    this.isProcessing.next(true);
    this.saveStateToStorage();

    // Process videos one by one
    await this.processNextVideo();
  }

  /**
   * Process next video in queue
   */
  private async processNextVideo(): Promise<void> {
    if (!this.isProcessing.value || !this.config) {
      return;
    }

    const queue = this.queuedVideos.value;

    if (queue.length === 0) {
      // Queue complete
      this.stopProcessing();
      return;
    }

    const video = queue[0];
    this.currentVideoId.next(video.id);
    this.saveStateToStorage();

    const videoStartTime = Date.now();

    try {
      // Start analysis via backend
      const endpoint = this.config.operationType === 'transcribe'
        ? '/analysis/transcribe'
        : '/analysis/analyze';

      const body = this.config.operationType === 'transcribe'
        ? { videoId: video.id, whisperModel: this.config.whisperModel }
        : { videoId: video.id, aiModel: this.config.aiModel, forceReanalyze: false };

      const response = await this.http.post<{ success: boolean; jobIds: string[] }>(
        `${this.apiUrl}${endpoint}`,
        body
      ).toPromise();

      if (!response?.success || !response.jobIds || response.jobIds.length === 0) {
        throw new Error('Failed to start analysis job');
      }

      const jobId = response.jobIds[0];

      // Wait for job to complete
      await this.waitForJobCompletion(jobId);

      // Calculate processing time for this video
      const videoEndTime = Date.now();
      const processingTimeSeconds = (videoEndTime - videoStartTime) / 1000;
      this.videoProcessingTimes.push(processingTimeSeconds);

      // Mark as processed
      const processed = this.processedVideos.value;
      this.processedVideos.next([...processed, video.id]);

      // Remove from queue
      const newQueue = queue.slice(1);
      this.queuedVideos.next(newQueue);
      this.currentVideoId.next(null);
      this.saveStateToStorage();

      // Process next video
      setTimeout(() => this.processNextVideo(), 1000);
    } catch (error: any) {
      // Mark as failed
      const failed = this.failedVideos.value;
      this.failedVideos.next([...failed, {
        videoId: video.id,
        filename: video.filename,
        error: error.message || 'Unknown error'
      }]);

      // Remove from queue
      const newQueue = queue.slice(1);
      this.queuedVideos.next(newQueue);
      this.currentVideoId.next(null);
      this.saveStateToStorage();

      // Continue with next video
      setTimeout(() => this.processNextVideo(), 1000);
    }
  }

  /**
   * Wait for a job to complete by polling the backend
   */
  private waitForJobCompletion(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const poll = interval(2000).subscribe(async () => {
        try {
          const response = await this.http.get<{ success: boolean; job: any }>(
            `${this.apiUrl}/analysis/job/${jobId}`
          ).toPromise();

          if (!response?.job) {
            poll.unsubscribe();
            reject(new Error('Job not found'));
            return;
          }

          const status = response.job.status;

          if (status === 'completed') {
            poll.unsubscribe();
            resolve();
          } else if (status === 'failed') {
            poll.unsubscribe();
            reject(new Error(response.job.error || 'Job failed'));
          }
        } catch (error) {
          poll.unsubscribe();
          reject(error);
        }
      });
    });
  }

  /**
   * Pause processing
   */
  pauseProcessing(): void {
    this.isProcessing.next(false);
    this.currentVideoId.next(null);
    this.saveStateToStorage();
  }

  /**
   * Resume processing
   */
  async resumeProcessing(): Promise<void> {
    if (!this.config) {
      throw new Error('No configuration available. Please start processing from the beginning.');
    }

    this.isProcessing.next(true);
    this.saveStateToStorage();
    await this.processNextVideo();
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
      sessionTotal: this.sessionTotal
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

      // Don't auto-resume processing on load
      this.isProcessing.next(false);
      this.currentVideoId.next(null);
    } catch (error) {
      console.error('Failed to load bulk analysis state from localStorage:', error);
    }
  }
}
