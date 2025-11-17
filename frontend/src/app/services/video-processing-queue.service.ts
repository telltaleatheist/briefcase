import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import {
  VideoProcessingJob,
  ChildProcess,
  AddVideoJobParams,
  ProcessType,
  getProcessDisplayName,
  ProcessTypeConfig,
  AIAnalysisConfig,
  TranscriptionConfig
} from '../models/video-processing.model';
import { SocketService } from './socket.service';
import { BackendUrlService } from './backend-url.service';

/**
 * Service for managing video processing jobs with hierarchical parent-child structure.
 * Each parent job represents one video with multiple child processes.
 */
@Injectable({
  providedIn: 'root'
})
export class VideoProcessingQueueService implements OnDestroy {
  private readonly STORAGE_KEY = 'video-processing-queue';
  private jobs = new BehaviorSubject<Map<string, VideoProcessingJob>>(new Map());
  public jobs$ = this.jobs.asObservable();

  // Event emitted when a new job is added (for auto-opening the queue panel)
  private jobAdded = new Subject<string>();
  public jobAdded$ = this.jobAdded.asObservable();

  private jobIdCounter = 0;

  // Throttling for job updates to prevent excessive re-renders
  private lastEmitTime = 0;
  private pendingEmit = false;
  private emitTimer: any = null;
  private readonly EMIT_THROTTLE_MS = 250; // Emit at most every 250ms

  // Store subscriptions for cleanup
  private subscriptions: Subscription[] = [];

  constructor(
    private socketService: SocketService,
    private backendUrlService: BackendUrlService,
    private http: HttpClient
  ) {
    console.log('[VideoProcessingQueueService] Service initialized');
    this.loadFromCache();
    this.setupProgressListeners();
    // Fetch current queue state from backend to sync with server
    this.syncWithBackend();
  }

  ngOnDestroy(): void {
    console.log('[VideoProcessingQueueService] Cleaning up subscriptions and timers');

    // Clear all subscriptions
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];

    // Clear emit timer
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }

    // Complete subjects
    this.jobs.complete();
    this.jobAdded.complete();
  }

  /**
   * Load jobs from localStorage cache
   */
  private loadFromCache(): void {
    try {
      const cached = localStorage.getItem(this.STORAGE_KEY);
      if (cached) {
        const jobsArray: VideoProcessingJob[] = JSON.parse(cached);
        const jobsMap = new Map<string, VideoProcessingJob>();

        jobsArray.forEach(job => {
          jobsMap.set(job.id, job);
        });

        this.jobs.next(jobsMap);
        console.log('[VideoProcessingQueueService] Loaded', jobsMap.size, 'jobs from cache');
      }
    } catch (error) {
      console.error('[VideoProcessingQueueService] Failed to load cache:', error);
    }
  }

  /**
   * Save jobs to localStorage cache
   */
  private saveToCache(): void {
    try {
      const jobsMap = this.jobs.getValue();
      const jobsArray = Array.from(jobsMap.values());
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(jobsArray));
      console.log('[VideoProcessingQueueService] Saved', jobsArray.length, 'jobs to cache');
    } catch (error) {
      console.error('[VideoProcessingQueueService] Failed to save cache:', error);
    }
  }

  /**
   * Clear all jobs from cache (called on app close)
   */
  clearCache(): void {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
      this.jobs.next(new Map());
      console.log('[VideoProcessingQueueService] Cache cleared');
    } catch (error) {
      console.error('[VideoProcessingQueueService] Failed to clear cache:', error);
    }
  }

  /**
   * Sync with backend queue state on initialization
   * Ensures frontend stays subscribed to active backend jobs after page refresh
   */
  private async syncWithBackend(): Promise<void> {
    try {
      console.log('[VideoProcessingQueueService] Syncing with backend queue state...');

      // Fetch both batch and analysis queue jobs
      const batchUrl = `${this.backendUrlService.getBackendUrl()}/queue/jobs?type=batch`;
      const analysisUrl = `${this.backendUrlService.getBackendUrl()}/queue/jobs?type=analysis`;

      const [batchResponse, analysisResponse] = await Promise.all([
        this.http.get<{ success: boolean; jobs: any[] }>(batchUrl).toPromise(),
        this.http.get<{ success: boolean; jobs: any[] }>(analysisUrl).toPromise()
      ]);

      const backendJobs = [
        ...(batchResponse?.jobs || []),
        ...(analysisResponse?.jobs || [])
      ];

      if (backendJobs.length === 0) {
        console.log('[VideoProcessingQueueService] No active jobs on backend');
        return;
      }

      console.log(`[VideoProcessingQueueService] Found ${backendJobs.length} active jobs on backend`);

      // Get current local jobs
      const currentJobs = this.jobs.getValue();
      const backendJobIds = new Set(backendJobs.map((j: any) => j.id));

      // Clean up completed/failed jobs that are no longer on backend
      let removedCount = 0;
      Array.from(currentJobs.keys()).forEach(localJobId => {
        const localJob = currentJobs.get(localJobId);
        // Remove jobs that finished and are no longer tracked by backend
        if (localJob &&
            (localJob.overallStatus === 'completed' || localJob.overallStatus === 'failed') &&
            !backendJobIds.has(localJob.backendJobId || '')) {
          console.log(`[VideoProcessingQueueService] Removing completed job ${localJobId} that's no longer on backend`);
          currentJobs.delete(localJobId);
          removedCount++;
        }
      });

      if (removedCount > 0) {
        // Emit updated jobs
        this.emitJobs();
        console.log(`[VideoProcessingQueueService] Removed ${removedCount} completed jobs`);
      }

      console.log('[VideoProcessingQueueService] Sync with backend complete - WebSocket will handle live updates');

    } catch (error) {
      console.error('[VideoProcessingQueueService] Failed to sync with backend:', error);
      // Don't throw - allow app to continue with cached state
    }
  }

  /**
   * Get observable of all jobs
   */
  getJobs(): Observable<Map<string, VideoProcessingJob>> {
    return this.jobs$;
  }

  /**
   * Get current jobs synchronously
   */
  getCurrentJobs(): Map<string, VideoProcessingJob> {
    return this.jobs.getValue();
  }

  /**
   * Get a specific job by ID
   */
  getJob(jobId: string): VideoProcessingJob | undefined {
    return this.jobs.getValue().get(jobId);
  }

  /**
   * Add a new video processing job with multiple child processes
   */
  addVideoJob(params: AddVideoJobParams): string {
    const parentJobId = `video-job-${Date.now()}-${this.jobIdCounter++}`;

    console.log('[VideoProcessingQueueService] Adding new video job:', parentJobId, params);

    // Create child processes from process configurations
    const childProcesses: ChildProcess[] = params.processes.map((processConfig, index) => {
      const childId = `${parentJobId}-child-${index}`;

      const child: ChildProcess = {
        id: childId,
        type: processConfig.type,
        status: 'pending',
        progress: 0,
        displayName: getProcessDisplayName(processConfig.type),
      };

      // Add type-specific configuration
      if (processConfig.config) {
        this.applyProcessConfig(child, processConfig.type, processConfig.config);
      }

      return child;
    });

    const job: VideoProcessingJob = {
      id: parentJobId,
      videoId: params.videoId,
      videoPath: params.videoPath,
      displayName: params.displayName,
      childProcesses,
      overallProgress: 0,
      overallStatus: 'pending',
      createdAt: new Date(),
      expanded: false
    };

    // Add to jobs map
    const currentJobs = this.jobs.getValue();
    currentJobs.set(parentJobId, job);
    this.jobs.next(new Map(currentJobs));
    this.saveToCache();

    console.log('[VideoProcessingQueueService] Job added:', job);

    // Emit event to notify listeners (for auto-opening queue panel)
    this.jobAdded.next(parentJobId);

    return parentJobId;
  }

  /**
   * Apply type-specific configuration to a child process
   */
  private applyProcessConfig(child: ChildProcess, type: ProcessType, config: ProcessTypeConfig): void {
    switch (type) {
      case 'download':
        const downloadConfig = config as any; // DownloadConfig
        child.downloadUrl = downloadConfig.downloadUrl;
        child.postTitle = downloadConfig.postTitle;
        child.outputDir = downloadConfig.outputDir;
        child.quality = downloadConfig.quality;
        child.convertToMp4 = downloadConfig.convertToMp4;
        break;

      case 'import':
        const importConfig = config as any;
        child.postTitle = importConfig.postTitle || importConfig.displayName;
        break;

      case 'analyze':
        const aiConfig = config as AIAnalysisConfig;
        child.aiModel = aiConfig.aiModel;
        child.apiKey = aiConfig.apiKey;
        child.ollamaEndpoint = aiConfig.ollamaEndpoint;
        child.customInstructions = aiConfig.customInstructions;
        break;

      case 'transcribe':
        const transcribeConfig = config as TranscriptionConfig;
        child.whisperModel = transcribeConfig.whisperModel || 'base';
        child.language = transcribeConfig.language || 'en';
        break;

      // 'process' and 'normalize' don't need additional config
    }
  }

  /**
   * Submit a job to the new queue system
   * All child processes are submitted as tasks in a single queue job
   */
  async submitJob(parentJobId: string): Promise<void> {
    const job = this.jobs.getValue().get(parentJobId);
    if (!job) {
      console.error('[VideoProcessingQueueService] Job not found:', parentJobId);
      return;
    }

    console.log('[VideoProcessingQueueService] Submitting job to new queue system:', parentJobId);

    job.overallStatus = 'processing';
    this.updateJob(parentJobId, job, true); // Immediate - status change

    try {
      // Build task list from child processes
      const tasks: any[] = [];

      // Check if we have BOTH process and normalize - combine into process-video
      const hasProcess = job.childProcesses.some(c => c.type === 'process');
      const hasNormalize = job.childProcesses.some(c => c.type === 'normalize');
      const shouldCombine = hasProcess && hasNormalize;

      // Track which child types we've already handled
      const handledTypes = new Set<string>();
      let combinedTaskAdded = false;

      for (const child of job.childProcesses) {
        // Skip if already handled by combination
        if (handledTypes.has(child.type)) {
          continue;
        }

        switch (child.type) {
          case 'download':
            // Download and import are combined in new system
            tasks.push({ type: 'download', options: { quality: child.quality || '1080', outputDir: child.outputDir } });
            tasks.push({ type: 'import', options: {} });
            break;

          case 'import':
            // Skip - already handled by download
            break;

          case 'process':
            // Add combined task if we should combine, otherwise add individual task
            if (shouldCombine && !combinedTaskAdded) {
              tasks.push({
                type: 'process-video',
                options: {
                  fixAspectRatio: true,
                  normalizeAudio: true,
                  level: -16,
                  method: 'rms'
                }
              });
              handledTypes.add('process');
              handledTypes.add('normalize');
              combinedTaskAdded = true;
              console.log('[VideoProcessingQueueService] Combining fix-aspect-ratio + normalize-audio into single process-video task');
            } else if (!shouldCombine) {
              tasks.push({ type: 'fix-aspect-ratio', options: {} });
            }
            break;

          case 'normalize':
            // Add combined task if we should combine and haven't added it yet
            if (shouldCombine && !combinedTaskAdded) {
              tasks.push({
                type: 'process-video',
                options: {
                  fixAspectRatio: true,
                  normalizeAudio: true,
                  level: -16,
                  method: 'rms'
                }
              });
              handledTypes.add('process');
              handledTypes.add('normalize');
              combinedTaskAdded = true;
              console.log('[VideoProcessingQueueService] Combining fix-aspect-ratio + normalize-audio into single process-video task');
            } else if (!shouldCombine) {
              tasks.push({ type: 'normalize-audio', options: { level: -16 } });
            }
            break;

          case 'transcribe':
            tasks.push({
              type: 'transcribe',
              options: {
                model: child.whisperModel || 'base',
                language: child.language || 'en'
              }
            });
            break;

          case 'analyze':
            tasks.push({
              type: 'analyze',
              options: {
                aiModel: child.aiModel || 'qwen2.5:7b',
                aiProvider: 'ollama',
                ollamaEndpoint: child.ollamaEndpoint || 'http://localhost:11434',
                customInstructions: child.customInstructions
              }
            });
            break;
        }
      }

      // Submit to new queue system
      const url = await this.backendUrlService.getApiUrl('/queue/add');
      const response = await this.http.post<any>(url, {
        queueType: 'batch',
        url: job.videoPath, // The download URL
        displayName: job.displayName,
        tasks
      }).toPromise();

      if (!response.success) {
        throw new Error(response.error || 'Failed to start queue job');
      }

      // Store backend job ID for progress tracking
      job.backendJobId = response.jobId;
      console.log('[VideoProcessingQueueService] Queue job created:', response.jobId);

      // Mark all children as processing (backend will handle them sequentially)
      job.childProcesses.forEach(child => {
        child.status = 'processing';
      });

      this.updateJob(parentJobId, job, true);

    } catch (error: any) {
      console.error('[VideoProcessingQueueService] ❌ Error submitting job:', error);
      job.overallStatus = 'failed';
      job.childProcesses.forEach(child => {
        if (child.status === 'pending' || child.status === 'processing') {
          child.status = 'failed';
          child.error = error.message || 'Failed to submit job';
        }
      });
      this.updateJob(parentJobId, job, true);
    }
  }

  /**
   * OLD METHOD - Kept for backward compatibility but not used with new queue system
   */
  async submitJobOld(parentJobId: string): Promise<void> {
    const job = this.jobs.getValue().get(parentJobId);
    if (!job) {
      console.error('[VideoProcessingQueueService] Job not found:', parentJobId);
      return;
    }

    console.log('[VideoProcessingQueueService] Submitting job:', parentJobId);

    job.overallStatus = 'processing';
    this.updateJob(parentJobId, job, true); // Immediate - status change

    // Submit each child process sequentially
    for (let i = 0; i < job.childProcesses.length; i++) {
      const child = job.childProcesses[i];

      console.log(`[VideoProcessingQueueService] ========================================`);
      console.log(`[VideoProcessingQueueService] Processing child ${i + 1}/${job.childProcesses.length}:`, child.type, child.displayName);
      console.log(`[VideoProcessingQueueService] Parent job:`, parentJobId, job.displayName);

      // Check if job was removed before processing next child
      const currentJob = this.jobs.getValue().get(parentJobId);
      if (!currentJob) {
        console.log('[VideoProcessingQueueService] ❌ Job removed during processing:', parentJobId);
        return; // Exit gracefully
      }

      try {
        console.log(`[VideoProcessingQueueService] ⏩ Submitting child process:`, child.type);
        await this.submitChildProcess(parentJobId, child);
        console.log(`[VideoProcessingQueueService] ✅ Child process submitted successfully:`, child.type);

        // Wait for process to complete before submitting next one
        console.log(`[VideoProcessingQueueService] ⏳ Waiting for child to complete:`, child.type, child.id);
        await this.waitForChildCompletion(parentJobId, child.id);
        console.log(`[VideoProcessingQueueService] ✅ Child completed:`, child.type);

      } catch (error: any) {
        console.error('[VideoProcessingQueueService] ❌ Error with child process:', child.type, error);
        child.status = 'failed';
        child.error = error.message || 'Failed to submit process';

        // Check if job still exists before updating
        if (this.jobs.getValue().has(parentJobId)) {
          this.updateJob(parentJobId, job, true); // Immediate - failure

          // Stop processing further children if one fails
          job.overallStatus = 'failed';
          this.updateJob(parentJobId, job, true); // Immediate - status change
        }
        console.error('[VideoProcessingQueueService] ❌ Stopping job due to child failure:', parentJobId);
        break;
      }
    }

    console.log(`[VideoProcessingQueueService] ========================================`);
    console.log(`[VideoProcessingQueueService] All children processed for job:`, parentJobId);

    // Check if job still exists and all children completed successfully
    const finalJob = this.jobs.getValue().get(parentJobId);
    if (finalJob) {
      const allCompleted = finalJob.childProcesses.every(c => c.status === 'completed');
      if (allCompleted) {
        finalJob.overallStatus = 'completed';
        finalJob.completedAt = new Date();
        this.updateJob(parentJobId, finalJob, true); // Immediate - completion
        console.log('[VideoProcessingQueueService] Job completed:', parentJobId);
      }
    } else {
      console.log('[VideoProcessingQueueService] Job removed before completion:', parentJobId);
    }
  }

  /**
   * Wait for a child process to complete
   */
  private async waitForChildCompletion(parentJobId: string, childId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const maxWaitTime = 30 * 60 * 1000; // 30 minutes timeout
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        // Check for timeout
        if (Date.now() - startTime > maxWaitTime) {
          clearInterval(checkInterval);
          reject(new Error('Process timeout - exceeded 30 minutes'));
          return;
        }

        const job = this.jobs.getValue().get(parentJobId);
        if (!job) {
          clearInterval(checkInterval);
          console.log('[VideoProcessingQueueService] Job removed while waiting for child completion:', parentJobId);
          // Don't reject - job was removed by user, just resolve silently
          resolve();
          return;
        }

        const child = job.childProcesses.find(c => c.id === childId);
        if (!child) {
          clearInterval(checkInterval);
          reject(new Error('Child process not found'));
          return;
        }

        if (child.status === 'completed') {
          clearInterval(checkInterval);
          resolve();
        } else if (child.status === 'failed') {
          clearInterval(checkInterval);
          reject(new Error(child.error || 'Process failed'));
        }
      }, 500); // Check every 500ms
    });
  }

  /**
   * Submit a single child process to the backend
   */
  private async submitChildProcess(parentJobId: string, child: ChildProcess): Promise<void> {
    const job = this.jobs.getValue().get(parentJobId);
    if (!job) return;

    console.log('[VideoProcessingQueueService] Submitting child process:', child.type, child.id);

    child.status = 'processing';
    child.progress = 0;
    this.updateJob(parentJobId, job, true); // Immediate - child starting

    try {
      let backendJobId: string;
      let skipped = false;

      switch (child.type) {
        case 'download':
          const downloadResult = await this.submitDownload(job, child);
          backendJobId = downloadResult.jobId;
          // Update job with downloaded file info
          if (downloadResult.videoPath) {
            job.videoPath = downloadResult.videoPath;
            console.log('[VideoProcessingQueueService] Updated job videoPath:', job.videoPath);
          }
          if (downloadResult.videoId) {
            job.videoId = downloadResult.videoId;
            console.log('[VideoProcessingQueueService] Updated job videoId:', job.videoId);
          }
          break;

        case 'import':
          const importResult = await this.submitImport(job, child);
          backendJobId = importResult.jobId;
          // Update job.videoId with the imported video ID
          if (importResult.videoId) {
            job.videoId = importResult.videoId;
          }
          break;

        case 'process':
          const processResult = await this.submitProcessing(job, child.id);
          backendJobId = processResult.jobId;
          skipped = processResult.skipped || false;
          break;

        case 'normalize':
          const normalizeResult = await this.submitNormalize(job, child.id);
          backendJobId = normalizeResult.jobId;
          skipped = normalizeResult.skipped || false;
          break;

        case 'transcribe':
          backendJobId = await this.submitTranscribe(job, child, child.id);
          break;

        case 'analyze':
          backendJobId = await this.submitAnalyze(job, child, child.id);
          break;

        default:
          throw new Error(`Unknown process type: ${child.type}`);
      }

      child.backendJobId = backendJobId;

      // If step was skipped, mark as completed immediately
      if (skipped) {
        console.log('[VideoProcessingQueueService] Step was skipped, marking as completed:', child.type);
        child.status = 'completed';
        child.progress = 100;
      }

      this.updateJob(parentJobId, job, true); // Immediate - child submitted or completed

      console.log('[VideoProcessingQueueService] Child process submitted:', child.type, 'Backend Job ID:', backendJobId, 'Skipped:', skipped);

      // For processing steps (aspect ratio, normalize), refresh video path from database after completion
      // because the file path may have changed
      if ((child.type === 'process' || child.type === 'normalize') && !skipped) {
        console.log('[VideoProcessingQueueService] Will refresh video path from database after', child.type, 'completes');
      }

    } catch (error: any) {
      console.error('[VideoProcessingQueueService] Error submitting child process:', error);
      child.status = 'failed';
      child.error = error.message || 'Failed to submit';
      this.updateJob(parentJobId, job, true); // Immediate - child failed
      throw error;
    }
  }

  /**
   * Submit aspect ratio processing (FFmpeg)
   * Returns {jobId, skipped} where skipped indicates the step was already complete
   */
  private async submitProcessing(job: VideoProcessingJob, childJobId: string): Promise<{jobId: string, skipped?: boolean}> {
    const url = await this.backendUrlService.getApiUrl('/process/fix-aspect-ratio');

    const response = await this.http.post<any>(url, {
      videoId: job.videoId,
      filePath: job.videoPath,
      jobId: childJobId  // Send the child's jobId to backend
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || response.message || 'Failed to start processing');
    }

    // If skipped, return immediately - the step is already done
    if (response.skipped) {
      console.log('[VideoProcessingQueueService] Step skipped:', response.message);
    }

    return {
      jobId: childJobId,  // Return the same jobId we sent
      skipped: response.skipped
    };
  }

  /**
   * Submit audio normalization (FFmpeg)
   * Returns {jobId, skipped} where skipped indicates the step was already complete
   */
  private async submitNormalize(job: VideoProcessingJob, childJobId: string): Promise<{jobId: string, skipped?: boolean}> {
    const url = await this.backendUrlService.getApiUrl('/process/normalize-audio');

    const response = await this.http.post<any>(url, {
      videoId: job.videoId,
      filePath: job.videoPath,
      jobId: childJobId  // Send the child's jobId to backend
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || response.message || 'Failed to start normalization');
    }

    // If skipped, return immediately - the step is already done
    if (response.skipped) {
      console.log('[VideoProcessingQueueService] Step skipped:', response.message);
    }

    return {
      jobId: childJobId,  // Return the same jobId we sent
      skipped: response.skipped
    };
  }

  /**
   * Submit transcription (NEW simple endpoint - no complex job management)
   */
  private async submitTranscribe(job: VideoProcessingJob, child: ChildProcess, childJobId: string): Promise<string> {
    if (!job.videoId) {
      throw new Error('Video ID required for transcription');
    }

    const url = await this.backendUrlService.getApiUrl('/transcribe');

    console.log('[VideoProcessingQueueService] Submitting transcription to NEW endpoint:', url);

    const response = await this.http.post<any>(url, {
      videoId: job.videoId,
      whisperModel: child.whisperModel || 'base',
      jobId: childJobId  // Send the child's jobId to backend
    }).toPromise();

    if (!response.success) {
      throw new Error(response.message || 'Failed to start transcription');
    }

    console.log('[VideoProcessingQueueService] Transcription started:', response);

    return childJobId;  // Return the same jobId we sent
  }

  /**
   * Submit AI analysis (NEW simple endpoint - requires transcript to exist)
   */
  private async submitAnalyze(job: VideoProcessingJob, child: ChildProcess, childJobId: string): Promise<string> {
    if (!job.videoId) {
      throw new Error('Video ID required for AI analysis');
    }

    const url = await this.backendUrlService.getApiUrl('/analyze');

    console.log('[VideoProcessingQueueService] Submitting analysis to NEW endpoint:', url);

    // Parse AI model to get provider
    const aiModel = child.aiModel || 'qwen2.5:7b';
    let aiProvider: 'ollama' | 'claude' | 'openai' = 'ollama';

    if (aiModel.startsWith('claude:')) {
      aiProvider = 'claude';
    } else if (aiModel.startsWith('openai:')) {
      aiProvider = 'openai';
    }

    const response = await this.http.post<any>(url, {
      videoId: job.videoId,
      aiModel: aiModel,
      aiProvider: aiProvider,
      claudeApiKey: aiProvider === 'claude' ? child.apiKey : undefined,
      openaiApiKey: aiProvider === 'openai' ? child.apiKey : undefined,
      customInstructions: child.customInstructions,
      jobId: childJobId  // Send the child's jobId to backend
    }).toPromise();

    if (!response.success) {
      throw new Error(response.message || 'Failed to start AI analysis');
    }

    console.log('[VideoProcessingQueueService] Analysis started:', response);

    return childJobId;  // Return the same jobId we sent
  }

  /**
   * Submit download task (downloads video and imports to library)
   * Uses the batch download endpoint which handles filename sanitization and library import
   */
  private async submitDownload(job: VideoProcessingJob, child: ChildProcess): Promise<{jobId: string, videoPath?: string, videoId?: string}> {
    if (!child.downloadUrl) {
      throw new Error('Download URL required for download task');
    }

    const url = await this.backendUrlService.getApiUrl('/queue/add');

    console.log('[VideoProcessingQueueService] Submitting download to new queue system:', child.downloadUrl);

    const childJobId = `${job.id}-child-download`;

    // Build task list using new queue system
    const tasks = [
      { type: 'download', options: { quality: child.quality || '1080', outputDir: child.outputDir } },
      { type: 'import', options: {} }
    ];

    const response = await this.http.post<any>(url, {
      queueType: 'batch',
      url: child.downloadUrl,
      displayName: child.postTitle || job.displayName,
      tasks
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || response.message || 'Failed to start download');
    }

    console.log('[VideoProcessingQueueService] Download job added to new queue:', response.jobId);

    // Note: New queue system handles download + import via tasks
    // We'll get progress updates via WebSocket (task-progress events)

    // Return job ID - path and videoId will be updated via WebSocket events
    return {
      jobId: response.jobId,
      videoPath: undefined,  // Will be set when download completes
      videoId: undefined,     // Will be set when import completes
    };
  }

  /**
   * Submit import task (imports downloaded file to library)
   */
  private async submitImport(job: VideoProcessingJob, child: ChildProcess): Promise<{jobId: string, videoId?: string}> {
    if (!job.videoPath) {
      throw new Error('Video path required for import task');
    }

    const url = await this.backendUrlService.getApiUrl('/library/import-file');

    console.log('[VideoProcessingQueueService] Submitting import:', job.videoPath);

    const response = await this.http.post<any>(url, {
      filePath: job.videoPath,
      displayName: child.postTitle,
    }).toPromise();

    if (!response.success) {
      throw new Error(response.error || response.message || 'Failed to import file');
    }

    console.log('[VideoProcessingQueueService] Import completed:', response);

    // Return job ID and video ID
    return {
      jobId: `import-${Date.now()}`,
      videoId: response.videoId,
    };
  }

  /**
   * Setup WebSocket listeners for progress updates
   */
  private setupProgressListeners(): void {
    console.log('[VideoProcessingQueueService] Setting up progress listeners');

    // Listen to NEW QUEUE SYSTEM task progress events
    const taskProgressSub = this.socketService.onTaskProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Task progress received:', data);
      const backendJobId = data.jobId;

      if (backendJobId) {
        // Find the parent job that matches this backend job ID
        const jobsMap = this.jobs.getValue();
        for (const [parentJobId, job] of jobsMap.entries()) {
          if (job.backendJobId === backendJobId) {
            // Update the job's overall progress
            job.overallProgress = data.progress;

            // Update the current child process based on task type
            // Special case: process-video updates BOTH process and normalize children
            if (data.taskType === 'process-video') {
              const processChild = job.childProcesses.find(c => c.type === 'process');
              const normalizeChild = job.childProcesses.find(c => c.type === 'normalize');

              // Update both children with the same progress
              [processChild, normalizeChild].forEach(child => {
                if (child) {
                  child.progress = data.progress;
                  if (data.progress >= 100) {
                    child.status = 'completed';
                    console.log(`[VideoProcessingQueueService] Child ${child.type} completed (combined task)`);
                  } else if (child.status !== 'processing') {
                    child.status = 'processing';
                  }
                }
              });

              console.log(`[VideoProcessingQueueService] Updated combined task progress: ${data.progress}%`);
            } else {
              // Normal single-task mapping
              const currentChild = job.childProcesses.find(child => {
                // Map task types to child process types
                if (data.taskType === 'download' && child.type === 'download') return true;
                if (data.taskType === 'import' && child.type === 'import') return true;
                if (data.taskType === 'fix-aspect-ratio' && child.type === 'process') return true;
                if (data.taskType === 'normalize-audio' && child.type === 'normalize') return true;
                if (data.taskType === 'transcribe' && child.type === 'transcribe') return true;
                if (data.taskType === 'analyze' && child.type === 'analyze') return true;
                return false;
              });

              if (currentChild) {
                currentChild.progress = data.progress;

                // Mark as completed when reaching 100%
                if (data.progress >= 100) {
                  currentChild.status = 'completed';
                  console.log(`[VideoProcessingQueueService] Child ${currentChild.type} completed`);
                } else if (currentChild.status !== 'processing') {
                  currentChild.status = 'processing';
                }

                console.log(`[VideoProcessingQueueService] Updated child ${currentChild.type} progress: ${data.progress}% (status: ${currentChild.status})`);
              }
            }

            // Calculate overall progress from all children
            const totalProgress = job.childProcesses.reduce((sum, child) => sum + child.progress, 0);
            job.overallProgress = Math.round(totalProgress / job.childProcesses.length);

            this.updateJob(parentJobId, job, false);
            break;
          }
        }
      }
    });
    this.subscriptions.push(taskProgressSub);

    // Listen to queue status updates to sync job completion
    const queueStatusSub = this.socketService.onQueueStatusUpdated().subscribe(data => {
      console.log('[VideoProcessingQueueService] Queue status updated:', data);

      if (data.queueType === 'batch' && data.status) {
        const allJobs = [
          ...data.status.pendingJobs,
          ...data.status.processingJobs,
          ...data.status.completedJobs,
          ...data.status.failedJobs
        ];

        // Update our jobs based on backend queue status
        const jobsMap = this.jobs.getValue();
        for (const [parentJobId, job] of jobsMap.entries()) {
          if (job.backendJobId) {
            const backendJob = allJobs.find(j => j.id === job.backendJobId);
            if (backendJob) {
              // Update overall status
              if (backendJob.status === 'completed') {
                job.overallStatus = 'completed';
                job.completedAt = new Date();
                // Mark all children as completed
                job.childProcesses.forEach(child => {
                  if (child.status !== 'completed') {
                    child.status = 'completed';
                    child.progress = 100;
                  }
                });
                console.log(`[VideoProcessingQueueService] Job ${parentJobId} completed`);
              } else if (backendJob.status === 'failed') {
                job.overallStatus = 'failed';
                job.childProcesses.forEach(child => {
                  if (child.status === 'processing') {
                    child.status = 'failed';
                    child.error = backendJob.error || 'Task failed';
                  }
                });
                console.log(`[VideoProcessingQueueService] Job ${parentJobId} failed:`, backendJob.error);
              }

              // Update overall progress
              job.overallProgress = backendJob.progress;

              // Update videoId if available
              if (backendJob.videoId) {
                job.videoId = backendJob.videoId;
                console.log(`[VideoProcessingQueueService] Updated videoId for job ${parentJobId}:`, backendJob.videoId);
              }

              this.updateJob(parentJobId, job, false);
            }
          }
        }
      }
    });
    this.subscriptions.push(queueStatusSub);

    // Listen to download progress (OLD SYSTEM - for backward compatibility)
    const downloadProgressSub = this.socketService.onDownloadProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Download progress received:', data);
      const backendJobId = data.jobId;
      if (backendJobId) {
        this.updateChildProgressByBackendJobId(backendJobId, data.progress);
      } else {
        console.warn('[VideoProcessingQueueService] Download progress missing jobId:', data);
      }
    });
    this.subscriptions.push(downloadProgressSub);

    // Listen to processing progress (FFmpeg operations)
    const processingProgressSub = this.socketService.onProcessingProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Processing progress received:', data);
      if (data.jobId) {
        this.updateChildProgressByBackendJobId(data.jobId, data.progress);
      } else {
        console.warn('[VideoProcessingQueueService] Processing progress missing jobId:', data);
      }
    });
    this.subscriptions.push(processingProgressSub);

    // Listen to transcription progress (Whisper operations)
    const transcriptionProgressSub = this.socketService.onTranscriptionProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Transcription progress received:', data);

      const backendJobId = data.jobId;
      if (backendJobId) {
        console.log('[VideoProcessingQueueService] Looking for child with backendJobId:', backendJobId);
        this.updateChildProgressByBackendJobId(backendJobId, data.progress);
      } else {
        console.warn('[VideoProcessingQueueService] Transcription progress missing jobId:', data);
      }
    });
    this.subscriptions.push(transcriptionProgressSub);

    // Listen to analysis progress (AI operations)
    const analysisProgressSub = this.socketService.onAnalysisProgress().subscribe(data => {
      console.log('[VideoProcessingQueueService] Analysis progress received:', data);

      const backendJobId = data.jobId;
      if (backendJobId) {
        console.log('[VideoProcessingQueueService] Looking for child with backendJobId:', backendJobId);
        this.updateChildProgressByBackendJobId(backendJobId, data.progress);
      } else {
        console.warn('[VideoProcessingQueueService] Analysis progress missing jobId:', data);
      }
    });
    this.subscriptions.push(analysisProgressSub);

    // Listen for processing failures
    const processingFailedSub = this.socketService.onProcessingFailed().subscribe(data => {
      console.log('[VideoProcessingQueueService] Processing failed:', data);
      if (data.jobId) {
        this.markChildAsFailed(data.jobId, data.error);
      }
    });
    this.subscriptions.push(processingFailedSub);

    // Listen for batch download job status updates (download + import completion)
    const jobStatusSub = this.socketService.onJobStatusUpdated().subscribe(data => {
      console.log('[VideoProcessingQueueService] Job status updated:', data);

      if (data.status === 'completed' && data.jobId) {
        // Find the child process with this backend job ID
        const currentJobs = this.jobs.getValue();

        for (const [parentId, job] of currentJobs.entries()) {
          const child = job.childProcesses.find(c => c.backendJobId === data.jobId);

          if (child && child.type === 'download') {
            console.log('[VideoProcessingQueueService] Batch download completed for:', data.jobId);

            // Mark child as 100% complete
            child.progress = 100;
            child.status = 'completed';

            // Update job with videoId and videoPath from the import
            if ((data as any).videoId) {
              job.videoId = (data as any).videoId;
              console.log('[VideoProcessingQueueService] Updated job videoId:', job.videoId);
            }
            if ((data as any).videoPath) {
              job.videoPath = (data as any).videoPath;
              console.log('[VideoProcessingQueueService] Updated job videoPath:', job.videoPath);
            }

            // Update the job
            this.updateJob(parentId, job, false);

            // The waitForChildCompletion() loop will detect the status change and continue automatically
            break;
          }
        }
      } else if (data.status === 'failed' && data.jobId) {
        // Mark download as failed
        this.markChildAsFailed(data.jobId, data.task || 'Download failed');
      }
    });
    this.subscriptions.push(jobStatusSub);
  }

  /**
   * Update child process progress by backend job ID
   */
  private updateChildProgressByBackendJobId(backendJobId: string, progress: number): void {
    const currentJobs = this.jobs.getValue();
    let found = false;

    for (const [parentId, job] of currentJobs.entries()) {
      const child = job.childProcesses.find(c => c.backendJobId === backendJobId);

      if (child) {
        found = true;
        console.log(`[VideoProcessingQueueService] Updating progress for ${child.displayName}: ${progress}%`);

        child.progress = Math.min(100, Math.max(0, progress));

        // Auto-mark as completed when progress reaches 100%
        // EXCEPT for download tasks - they complete via job-status-updated event after import finishes
        const wasCompleted = child.progress >= 100 && child.status === 'processing' && child.type !== 'download';
        if (wasCompleted) {
          child.status = 'completed';
          console.log(`[VideoProcessingQueueService] ${child.displayName} auto-completed (progress: 100%)`);

          // Refresh video path from database after processing/normalize steps
          // because the file path may have changed
          if (child.type === 'process' || child.type === 'normalize') {
            this.refreshVideoPathFromDatabase(parentId, job).catch(err => {
              console.error(`[VideoProcessingQueueService] Failed to refresh video path after ${child.type}:`, err);
            });
          }
        }

        // Recalculate parent progress
        this.recalculateProgress(job);

        // Immediate emit if child was just completed, otherwise throttled
        this.updateJob(parentId, job, wasCompleted);
        break;
      }
    }

    if (!found) {
      console.warn(`[VideoProcessingQueueService] ❌ No child process found with backendJobId: ${backendJobId}`);
      console.log('[VideoProcessingQueueService] 🔍 Current jobs and their backendJobIds:');

      Array.from(currentJobs.values()).forEach(j => {
        console.log(`  Job ${j.id} (${j.displayName}):`);
        j.childProcesses.forEach(c => {
          console.log(`    - ${c.type}: backendJobId = "${c.backendJobId}" (status: ${c.status})`);
        });
      });
    }
  }

  /**
   * Refresh video path from database after processing/normalize steps
   * because the file path may have changed
   */
  private async refreshVideoPathFromDatabase(parentId: string, job: VideoProcessingJob): Promise<void> {
    if (!job.videoId) {
      console.warn('[VideoProcessingQueueService] Cannot refresh path - no videoId');
      return;
    }

    try {
      console.log(`[VideoProcessingQueueService] Refreshing video path from database for ${job.videoId}`);

      const url = await this.backendUrlService.getApiUrl(`/library/videos/${job.videoId}`);
      const video = await this.http.get<any>(url).toPromise();

      if (video && video.current_path) {
        const oldPath = job.videoPath;
        job.videoPath = video.current_path;
        console.log(`[VideoProcessingQueueService] Updated video path: ${oldPath} -> ${job.videoPath}`);
        this.updateJob(parentId, job, false); // Update without immediate emit (throttled)
      } else {
        console.warn('[VideoProcessingQueueService] Video path not found in database response');
      }
    } catch (error) {
      console.error('[VideoProcessingQueueService] Error refreshing video path:', error);
      throw error;
    }
  }

  /**
   * Mark a child process as completed
   */
  private markChildAsComplete(backendJobId: string): void {
    const currentJobs = this.jobs.getValue();

    for (const [parentId, job] of currentJobs.entries()) {
      const child = job.childProcesses.find(c => c.backendJobId === backendJobId);

      if (child) {
        console.log(`[VideoProcessingQueueService] Marking ${child.displayName} as completed`);

        child.status = 'completed';
        child.progress = 100;

        this.recalculateProgress(job);
        this.updateJob(parentId, job, true); // Immediate - child completed
        break;
      }
    }
  }

  /**
   * Mark a child process as failed
   */
  private markChildAsFailed(backendJobId: string, error: string): void {
    const currentJobs = this.jobs.getValue();

    for (const [parentId, job] of currentJobs.entries()) {
      const child = job.childProcesses.find(c => c.backendJobId === backendJobId);

      if (child) {
        console.log(`[VideoProcessingQueueService] Marking ${child.displayName} as failed:`, error);

        child.status = 'failed';
        child.error = error;

        this.recalculateProgress(job);
        this.updateJob(parentId, job, true); // Immediate - child failed
        break;
      }
    }
  }

  /**
   * Calculate overall progress as average of all children
   */
  private recalculateProgress(job: VideoProcessingJob): void {
    if (job.childProcesses.length === 0) {
      job.overallProgress = 0;
      return;
    }

    const totalProgress = job.childProcesses.reduce((sum, child) => sum + child.progress, 0);
    job.overallProgress = Math.round(totalProgress / job.childProcesses.length);

    // Update overall status
    const allCompleted = job.childProcesses.every(c => c.status === 'completed');
    const anyFailed = job.childProcesses.some(c => c.status === 'failed');
    const anyProcessing = job.childProcesses.some(c => c.status === 'processing');

    if (allCompleted) {
      job.overallStatus = 'completed';
      job.completedAt = new Date();
    } else if (anyFailed) {
      job.overallStatus = 'failed';
    } else if (anyProcessing) {
      job.overallStatus = 'processing';
    } else {
      job.overallStatus = 'pending';
    }
  }

  /**
   * Update a job in the jobs map with throttling
   * Updates are throttled to prevent excessive re-renders (max 1 emit per 250ms)
   */
  private updateJob(jobId: string, job: VideoProcessingJob, immediate: boolean = false): void {
    const currentJobs = this.jobs.getValue();
    currentJobs.set(jobId, job);

    // Save to cache immediately (cheap operation)
    this.saveToCache();

    // Emit with throttling to prevent UI jank
    if (immediate) {
      // Force immediate emit for critical updates (status changes, job completion)
      this.emitJobs();
    } else {
      // Throttle progress updates
      this.scheduleEmit();
    }
  }

  /**
   * Schedule a throttled emit
   */
  private scheduleEmit(): void {
    this.pendingEmit = true;

    // If we already have a timer scheduled, don't create another
    if (this.emitTimer) {
      return;
    }

    const now = Date.now();
    const timeSinceLastEmit = now - this.lastEmitTime;

    if (timeSinceLastEmit >= this.EMIT_THROTTLE_MS) {
      // Enough time has passed, emit immediately
      this.emitJobs();
    } else {
      // Schedule emit after throttle period
      const delay = this.EMIT_THROTTLE_MS - timeSinceLastEmit;
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        if (this.pendingEmit) {
          this.emitJobs();
        }
      }, delay);
    }
  }

  /**
   * Emit jobs observable
   */
  private emitJobs(): void {
    const currentJobs = this.jobs.getValue();
    this.jobs.next(new Map(currentJobs));
    this.lastEmitTime = Date.now();
    this.pendingEmit = false;
  }

  /**
   * Remove a job from the queue
   */
  removeJob(jobId: string): void {
    const currentJobs = this.jobs.getValue();
    currentJobs.delete(jobId);
    this.emitJobs(); // Immediate - job removed
    this.saveToCache();
    console.log('[VideoProcessingQueueService] Job removed:', jobId);
  }

  /**
   * Clear all jobs
   */
  clearAllJobs(): void {
    this.emitJobs(); // Clear the map
    this.jobs.next(new Map());
    this.saveToCache();
    console.log('[VideoProcessingQueueService] All jobs cleared');
  }

  /**
   * Toggle job expansion state
   */
  toggleJobExpansion(jobId: string): void {
    const job = this.jobs.getValue().get(jobId);
    if (job) {
      job.expanded = !job.expanded;
      this.updateJob(jobId, job, true); // Immediate - UI interaction
    }
  }
}
