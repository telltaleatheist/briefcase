// clippy/backend/src/downloader/batch-downloader.service.ts
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { MediaEventService } from '../media/media-event.service';
import {
  DownloadOptions,
  JobResponse,
  JobStatus,
  BatchQueueStatus
} from '../common/interfaces/download.interface';
import { AnalysisService } from '../analysis/analysis.service';

@Injectable()
export class BatchDownloaderService {
  private readonly logger = new Logger(BatchDownloaderService.name);

  constructor(
    private readonly eventService: MediaEventService,
    @Inject(forwardRef(() => AnalysisService))
    private readonly analysisService: AnalysisService
  ) {
    this.logger.log('Batch downloader service initialized (delegating to analysis queue)');
  }

  // Add a new job to the system - queues to analysis service with 'download-and-process' mode
  addToBatchQueue(options: DownloadOptions, providedJobId?: string): string {
    // Use provided jobId if available, otherwise generate one
    const jobId = providedJobId || `batch-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    this.logger.log(`Queuing batch job ${jobId} to analysis service with mode 'download-and-process'`);

    // Queue directly to analysis service with download-and-process mode
    this.analysisService.startAnalysis({
      input: options.url,
      inputType: 'url',
      mode: 'download-and-process',
      aiModel: '', // Not needed for download-and-process
      ollamaEndpoint: '', // Not needed for download-and-process
      outputPath: options.outputDir,
    }, jobId).catch(error => {
      this.logger.error(`Failed to queue batch job ${jobId}: ${error}`);
    });

    this.logger.log(`Batch job ${jobId} queued to analysis service`);

    return jobId;
  }

  // Add multiple jobs
  addMultipleToBatchQueue(optionsArray: DownloadOptions[]): string[] {
    return optionsArray.map(options => this.addToBatchQueue(options));
  }

  // Get current queue status - queries analysis service for 'download-and-process' jobs
  getBatchStatus(): BatchQueueStatus {
    // Get all jobs from analysis service with mode 'download-and-process'
    const allAnalysisJobs = this.analysisService.getAllJobs();
    const batchJobs = allAnalysisJobs.filter(job => job.mode === 'download-and-process');

    // Map analysis jobs to batch job format
    const mapToJobResponse = (analysisJob: any): JobResponse => ({
      id: analysisJob.id,
      url: '', // Analysis jobs don't store URL separately
      displayName: analysisJob.title || 'Batch Download',
      status: this.mapAnalysisStatusToJobStatus(analysisJob.status),
      progress: analysisJob.progress,
      currentTask: analysisJob.currentPhase,
      error: analysisJob.error,
      createdAt: analysisJob.createdAt?.toISOString() || new Date().toISOString(),
      outputFile: analysisJob.videoPath,
    });

    // Categorize jobs by status
    const queuedJobs = batchJobs.filter(j => j.status === 'pending').map(mapToJobResponse);
    const downloadingJobs = batchJobs.filter(j => j.status === 'downloading').map(mapToJobResponse);
    const processingJobs = batchJobs.filter(j => j.status === 'processing').map(mapToJobResponse);
    const completedJobs = batchJobs.filter(j => j.status === 'completed').map(mapToJobResponse);
    const failedJobs = batchJobs.filter(j => j.status === 'failed').map(mapToJobResponse);

    return {
      queuedJobs,
      downloadingJobs,
      downloadedJobs: [], // Not used in new flow
      processingJobs,
      transcribingJobs: [], // Not used in new flow
      completedJobs,
      failedJobs,
      activeDownloadCount: downloadingJobs.length + processingJobs.length,
      maxConcurrentDownloads: 1, // Analysis queue processes 1 at a time
      isProcessing: processingJobs.length > 0
    };
  }

  // Map analysis job status to batch job status
  private mapAnalysisStatusToJobStatus(analysisStatus: string): JobStatus {
    switch (analysisStatus) {
      case 'pending':
        return 'queued';
      case 'downloading':
        return 'downloading';
      case 'processing':
      case 'extracting':
        return 'processing';
      case 'completed':
        return 'completed';
      case 'failed':
        return 'failed';
      default:
        return 'queued';
    }
  }

  // Delete a single job - delegates to analysis service
  async deleteJob(jobId: string): Promise<boolean> {
    this.logger.log(`Deleting batch job ${jobId} from analysis service`);
    return await this.analysisService.deleteJob(jobId);
  }

  // Retry a failed job - not implemented yet (would need analysis service support)
  retryJob(jobId: string): boolean {
    this.logger.warn(`Retry not yet implemented for batch jobs (job ${jobId})`);
    return false;
  }

  // Skip a job - not applicable for batch downloads
  skipJob(jobId: string): boolean {
    this.logger.warn(`Skip not applicable for batch downloads (job ${jobId})`);
    return false;
  }

  // Cancel a job - not implemented yet (would need analysis service support)
  cancelJob(jobId: string): boolean {
    this.logger.warn(`Cancel not yet implemented for batch jobs (job ${jobId})`);
    return false;
  }

  // Clear ALL batch jobs - delegates to analysis service
  clearQueues(): void {
    this.logger.log('Clearing all batch download jobs from analysis service');

    // Get all batch jobs and delete them
    const allAnalysisJobs = this.analysisService.getAllJobs();
    const batchJobs = allAnalysisJobs.filter(job => job.mode === 'download-and-process');

    batchJobs.forEach(job => {
      this.analysisService.deleteJob(job.id);
    });

    this.logger.log(`Cleared ${batchJobs.length} batch jobs from analysis queue`);
  }

  // Clear completed jobs - delegates to analysis service
  clearCompletedJobs(): void {
    const allAnalysisJobs = this.analysisService.getAllJobs();
    const completedBatchJobs = allAnalysisJobs.filter(
      job => job.mode === 'download-and-process' && job.status === 'completed'
    );

    completedBatchJobs.forEach(job => {
      this.analysisService.deleteJob(job.id);
    });

    this.logger.log(`Cleared ${completedBatchJobs.length} completed batch jobs`);
  }

  // Clear failed jobs - delegates to analysis service
  clearFailedJobs(): void {
    const allAnalysisJobs = this.analysisService.getAllJobs();
    const failedBatchJobs = allAnalysisJobs.filter(
      job => job.mode === 'download-and-process' && job.status === 'failed'
    );

    failedBatchJobs.forEach(job => {
      this.analysisService.deleteJob(job.id);
    });

    this.logger.log(`Cleared ${failedBatchJobs.length} failed batch jobs`);
  }

  // Legacy methods kept for compatibility
  setMaxConcurrentDownloads(max: number): void {
    this.logger.log(`setMaxConcurrentDownloads called with ${max}, but analysis queue handles concurrency (fixed at 1)`);
  }

  getMaxConcurrentDownloads(): number {
    return 1; // Analysis queue processes 1 job at a time
  }

  updateJobProgress(jobId: string, progress: number, task: string): void {
    // Progress updates are handled by analysis service
    this.logger.debug(`Job progress update for ${jobId}: ${progress}% - ${task}`);
  }
}
