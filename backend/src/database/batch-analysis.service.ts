import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { FileScannerService } from './file-scanner.service';
import { QueueManagerService } from '../queue/queue-manager.service';
import { Task } from '../common/interfaces/task.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SharedConfigService } from '../config/shared-config.service';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

/**
 * BatchAnalysisService - Manages batch processing of videos for transcription and analysis
 *
 * Features:
 * - Queue-based processing of thousands of videos
 * - Progress tracking with resume capability
 * - Stores results in database
 * - Handles errors gracefully (logs and continues)
 * - Pause/resume support
 * - Configurable concurrency
 */

export interface BatchJob {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  totalVideos: number;
  processedVideos: number;
  failedVideos: number;
  skippedVideos: number; // Videos skipped due to existing analysis
  currentVideoId?: string;
  currentVideoFilename?: string;
  startedAt: string;
  completedAt?: string;
  pausedAt?: string;
  estimatedTimeRemaining?: number; // seconds
  errors: BatchError[];
}

export interface BatchError {
  videoId: string;
  filename: string;
  error: string;
  timestamp: string;
}

export interface BatchProgress {
  jobId: string;
  status: string;
  totalVideos: number;
  processedVideos: number;
  failedVideos: number;
  skippedVideos: number;
  currentVideoFilename?: string;
  progress: number; // 0-100
  estimatedTimeRemaining?: number;
  errors: BatchError[];
}

@Injectable()
export class BatchAnalysisService implements OnModuleInit {
  private readonly logger = new Logger(BatchAnalysisService.name);
  private currentBatchJob: BatchJob | null = null;
  private isPaused = false;
  private shouldStop = false;
  private processingStartTime = 0;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly fileScannerService: FileScannerService,
    private readonly queueManager: QueueManagerService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: SharedConfigService,
  ) {}

  async onModuleInit() {
    // Check for interrupted batch job on startup
    await this.checkForInterruptedJob();
  }

  /**
   * Check if there's an interrupted batch job that can be resumed
   */
  private async checkForInterruptedJob() {
    // This would load from database in production
    // For now, we'll just log
    this.logger.log('Checking for interrupted batch jobs...');
  }

  /**
   * Start a new batch analysis job
   */
  async startBatchAnalysis(options?: {
    aiModel?: string;
    aiProvider?: 'ollama' | 'claude' | 'openai';
    whisperModel?: string;
    ollamaEndpoint?: string;
    limit?: number; // Process only first N videos (for testing)
    videoIds?: string[]; // Specific video IDs to process
    transcribeOnly?: boolean; // Only transcribe, skip AI analysis
    forceReanalyze?: boolean; // Force re-analysis even if analysis exists (default: false)
    claudeApiKey?: string; // Claude API key (if provided, overrides saved key)
    openaiApiKey?: string; // OpenAI API key (if provided, overrides saved key)
  }): Promise<string> {
    if (this.currentBatchJob && this.currentBatchJob.status === 'running') {
      throw new Error('A batch job is already running. Please pause or stop it first.');
    }

    // Get default config
    const config = await this.configService.getConfig();
    const transcribeOnly = options?.transcribeOnly || false;
    const forceReanalyze = options?.forceReanalyze || false;
    const aiModel = options?.aiModel || config.aiModel || 'qwen2.5:7b';
    const aiProvider = options?.aiProvider || 'ollama';
    const whisperModel = options?.whisperModel || 'base';
    const ollamaEndpoint = options?.ollamaEndpoint || config.ollamaEndpoint || 'http://localhost:11434';
    const claudeApiKey = options?.claudeApiKey;
    const openaiApiKey = options?.openaiApiKey;

    // Get videos to process
    let videosToProcess: Array<{ id: string; filename: string; current_path: string; upload_date?: string | null; download_date?: string | null; duration_seconds?: number | null }>;

    if (options?.videoIds && options.videoIds.length > 0) {
      // Process specific videos by ID
      const dbVideos = options.videoIds
        .map(id => this.databaseService.getVideoById(id))
        .filter(video => video !== null); // Filter out any videos not found

      if (dbVideos.length === 0) {
        throw new Error('None of the specified videos were found in the database');
      }

      // Convert database objects to expected format
      videosToProcess = dbVideos.map(video => ({
        id: video.id as string,
        filename: video.filename as string,
        current_path: video.current_path as string,
        upload_date: video.upload_date as string | null,
        download_date: video.download_date as string | null,
        duration_seconds: video.duration_seconds as number | null,
      }));
    } else {
      // Get all videos that need analysis
      const videosNeedingAnalysis = this.fileScannerService.getNeedsAnalysis();

      // Apply limit if specified (for testing)
      videosToProcess = options?.limit
        ? videosNeedingAnalysis.slice(0, options.limit)
        : videosNeedingAnalysis;

      if (videosToProcess.length === 0) {
        throw new Error('No videos need analysis');
      }
    }

    const batchJobId = uuidv4();
    this.currentBatchJob = {
      id: batchJobId,
      status: 'pending',
      totalVideos: videosToProcess.length,
      processedVideos: 0,
      failedVideos: 0,
      skippedVideos: 0,
      startedAt: new Date().toISOString(),
      errors: [],
    };

    this.logger.log(
      `Starting batch ${transcribeOnly ? 'transcription' : 'analysis'} job ${batchJobId} for ${videosToProcess.length} videos`,
    );
    this.logger.log(`Config: ${aiProvider}/${aiModel}, Whisper: ${whisperModel}, Transcribe-only: ${transcribeOnly}, Force-reanalyze: ${forceReanalyze}`);

    // Start processing asynchronously
    this.processBatch(videosToProcess, {
      aiModel,
      aiProvider,
      whisperModel,
      ollamaEndpoint,
      transcribeOnly,
      forceReanalyze,
      claudeApiKey,
      openaiApiKey,
    }).catch((error) => {
      const err = error as Error;
      this.logger.error(`Batch job failed: ${err.message}`, err.stack);
      if (this.currentBatchJob) {
        this.currentBatchJob.status = 'failed';
        this.currentBatchJob.errors.push({
          videoId: 'system',
          filename: 'batch-system',
          error: err.message,
          timestamp: new Date().toISOString(),
        });
      }
    });

    return batchJobId;
  }

  /**
   * Queue videos for analysis without starting processing
   * Creates a paused batch job that the user can manually start from the analysis dialog
   */
  async queueVideosForAnalysis(options: {
    videoIds: string[];
    transcribeOnly?: boolean;
    forceReanalyze?: boolean;
  }): Promise<string> {
    if (this.currentBatchJob && (this.currentBatchJob.status === 'running' || this.currentBatchJob.status === 'paused')) {
      throw new Error('A batch job already exists. Please complete or stop it first.');
    }

    const transcribeOnly = options?.transcribeOnly || false;
    const forceReanalyze = options?.forceReanalyze || false;

    // Get videos to queue
    const dbVideos = options.videoIds
      .map(id => this.databaseService.getVideoById(id))
      .filter(video => video !== null);

    if (dbVideos.length === 0) {
      throw new Error('None of the specified videos were found in the database');
    }

    // Convert database objects to expected format
    const videosToQueue = dbVideos.map(video => ({
      id: video.id as string,
      filename: video.filename as string,
      current_path: video.current_path as string,
      upload_date: video.upload_date as string | null,
      download_date: video.download_date as string | null,
      duration_seconds: video.duration_seconds as number | null,
    }));

    const batchJobId = uuidv4();
    this.currentBatchJob = {
      id: batchJobId,
      status: 'paused',  // Start as paused so user can manually start
      totalVideos: videosToQueue.length,
      processedVideos: 0,
      failedVideos: 0,
      skippedVideos: 0,
      startedAt: new Date().toISOString(),
      pausedAt: new Date().toISOString(),
      errors: [],
    };

    this.logger.log(
      `Queued ${videosToQueue.length} videos for ${transcribeOnly ? 'transcription' : 'analysis'} (Job ID: ${batchJobId})`,
    );
    this.logger.log(`Transcribe-only: ${transcribeOnly}, Force-reanalyze: ${forceReanalyze}`);

    return batchJobId;
  }

  /**
   * Process batch of videos
   */
  private async processBatch(
    videos: Array<{ id: string; filename: string; current_path: string }>,
    config: {
      aiModel: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      whisperModel: string;
      ollamaEndpoint: string;
      transcribeOnly?: boolean;
      forceReanalyze?: boolean;
      claudeApiKey?: string;
      openaiApiKey?: string;
    },
  ): Promise<void> {
    if (!this.currentBatchJob) return;

    this.currentBatchJob.status = 'running';
    this.isPaused = false;
    this.shouldStop = false;
    this.processingStartTime = Date.now();

    for (let i = 0; i < videos.length; i++) {
      // Check for pause/stop requests
      if (this.shouldStop) {
        this.logger.log('Batch job stopped by user');
        if (this.currentBatchJob) {
          this.currentBatchJob.status = 'paused';
          this.currentBatchJob.pausedAt = new Date().toISOString();
        }
        return;
      }

      if (this.isPaused) {
        this.logger.log('Batch job paused by user');
        if (this.currentBatchJob) {
          this.currentBatchJob.status = 'paused';
          this.currentBatchJob.pausedAt = new Date().toISOString();
        }
        return;
      }

      const video = videos[i];

      try {
        this.logger.log(
          `Processing video ${i + 1}/${videos.length}: ${video.filename}`,
        );

        if (this.currentBatchJob) {
          this.currentBatchJob.currentVideoId = video.id;
          this.currentBatchJob.currentVideoFilename = video.filename;

          // Calculate estimated time remaining
          const elapsed = Date.now() - this.processingStartTime;
          const avgTimePerVideo = elapsed / (i + 1);
          const remaining = (videos.length - i - 1) * avgTimePerVideo;
          this.currentBatchJob.estimatedTimeRemaining = Math.round(remaining / 1000);
        }

        // Emit progress event
        this.emitProgress();

        // Process the video through AnalysisService
        await this.processVideo(video, config);

        if (this.currentBatchJob) {
          this.currentBatchJob.processedVideos++;
        }

        this.logger.log(`✓ Completed: ${video.filename}`);
      } catch (error) {
        const err = error as Error;
        this.logger.error(
          `✗ Failed to process ${video.filename}: ${err.message}`,
        );

        if (this.currentBatchJob) {
          this.currentBatchJob.failedVideos++;
          this.currentBatchJob.errors.push({
            videoId: video.id,
            filename: video.filename,
            error: err.message,
            timestamp: new Date().toISOString(),
          });
        }

        // Continue with next video (don't stop entire batch on error)
      }
    }

    // Batch complete
    if (this.currentBatchJob) {
      this.currentBatchJob.status = 'completed';
      this.currentBatchJob.completedAt = new Date().toISOString();
      this.currentBatchJob.currentVideoId = undefined;
      this.currentBatchJob.currentVideoFilename = undefined;

      this.logger.log(
        `Batch analysis complete! Processed: ${this.currentBatchJob.processedVideos}, ` +
          `Skipped: ${this.currentBatchJob.skippedVideos}, ` +
          `Failed: ${this.currentBatchJob.failedVideos}`,
      );

      // Emit completion event
      this.emitProgress();
    }
  }

  /**
   * Process a single video through the analysis pipeline using new queue system
   */
  private async processVideo(
    video: { id: string; filename: string; current_path: string },
    config: {
      aiModel: string;
      aiProvider: 'ollama' | 'claude' | 'openai';
      whisperModel: string;
      ollamaEndpoint: string;
      transcribeOnly?: boolean;
      forceReanalyze?: boolean;
      claudeApiKey?: string;
      openaiApiKey?: string;
    },
  ): Promise<void> {
    // Re-fetch video data from database to get the most current path
    // (in case the video was renamed after being queued)
    const currentVideoData = this.databaseService.getVideoById(video.id);
    if (!currentVideoData) {
      throw new Error(`Video ${video.id} not found in database`);
    }

    // Use the current path from database instead of the queued path
    const currentPath = currentVideoData.current_path as string;
    const currentFilename = currentVideoData.filename as string;

    this.logger.log(`Processing video: ${currentFilename} at path: ${currentPath}`);

    // Check if transcript and analysis already exist
    const existingTranscript = this.databaseService.getTranscript(video.id);
    const existingAnalysis = this.databaseService.getAnalysis(video.id);
    const hasTranscript = !!existingTranscript;
    const hasAnalysis = !!existingAnalysis;

    // Build task list based on what needs to be done
    const tasks: Task[] = [];

    if (config.transcribeOnly) {
      // User explicitly requested transcribe-only
      if (hasTranscript) {
        this.logger.log(`Transcript already exists for ${currentFilename}, skipping transcription`);
        return; // Skip this video entirely
      }
      tasks.push({ type: 'transcribe', options: { model: config.whisperModel } });
    } else {
      // User requested full analysis
      // Check if analysis already exists and if we should skip
      if (hasAnalysis && !config.forceReanalyze) {
        this.logger.log(`Analysis already exists for ${currentFilename}, skipping (use forceReanalyze to override)`);
        if (this.currentBatchJob) {
          this.currentBatchJob.skippedVideos++;
        }
        return; // Skip this video entirely
      }

      if (!hasTranscript) {
        // Need to transcribe first
        tasks.push({ type: 'transcribe', options: { model: config.whisperModel } });
      }

      // Always add analyze task for full analysis
      const apiKey = config.aiProvider === 'claude' ? config.claudeApiKey : config.aiProvider === 'openai' ? config.openaiApiKey : undefined;
      tasks.push({
        type: 'analyze',
        options: {
          aiModel: config.aiModel,
          aiProvider: config.aiProvider,
          ollamaEndpoint: config.ollamaEndpoint,
          apiKey, // Single apiKey field for all providers
        },
      });
    }

    this.logger.log(`Creating queue job for ${currentFilename} with tasks: ${tasks.map(t => t.type).join(', ')}`);

    // Create queue job with videoId and tasks
    const jobId = this.queueManager.addJob({
      queueType: 'analysis',
      videoId: video.id,
      displayName: currentFilename,
      tasks,
    });

    // Wait for completion
    await this.waitForQueueJobCompletion(jobId);

    // Get the job result
    const job = this.queueManager.getJob(jobId);
    if (!job) {
      throw new Error('Queue job not found');
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'Analysis failed');
    }

    // Results are already saved by the queue manager's task execution
    this.logger.log(`Completed processing ${currentFilename}`);
  }

  /**
   * Wait for a queue job to complete
   */
  private async waitForQueueJobCompletion(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const job = this.queueManager.getJob(jobId);

        if (!job) {
          clearInterval(checkInterval);
          reject(new Error('Job disappeared'));
          return;
        }

        if (job.status === 'completed') {
          clearInterval(checkInterval);
          resolve();
        } else if (job.status === 'failed') {
          clearInterval(checkInterval);
          reject(new Error(job.error || 'Analysis failed'));
        }
      }, 1000); // Check every second
    });
  }

  /**
   * Store analysis results in database
   */
  private async storeAnalysisResults(
    videoId: string,
    job: {
      transcriptPath?: string;
      analysisPath?: string;
      analysisResult?: { sections: any[]; tags?: { people: string[]; topics: string[] }; sections_count?: number };
      tags?: { people: string[]; topics: string[] };
      timing?: any;
    },
    skipTranscript = false, // Flag to skip transcript insertion if it already exists
  ): Promise<void> {
    try {
      // Read and store transcript files (only if new transcription was done)
      if (job.transcriptPath && !skipTranscript) {
        const srtPath = job.transcriptPath;
        const txtPath = job.transcriptPath.replace('.srt', '.txt');

        const srtContent = await fs.readFile(srtPath, 'utf-8');
        const txtContent = await fs.readFile(txtPath, 'utf-8');

        // Check if transcript already exists
        const existingTranscript = this.databaseService.getTranscript(videoId);

        if (existingTranscript) {
          // Delete existing transcript before inserting new one
          this.logger.log(`Deleting existing transcript for video ${videoId} before inserting new one`);
          this.databaseService.deleteTranscript(videoId);
        }

        // Store new transcript
        this.databaseService.insertTranscript({
          videoId,
          plainText: txtContent,
          srtFormat: srtContent,
          whisperModel: 'base', // Get from job if available
          language: 'en',
        });
        this.logger.log(`Stored transcript for video ${videoId}`);

        // Clean up transcript files after importing to database
        try {
          await fs.unlink(srtPath);
          await fs.unlink(txtPath);
          this.logger.log(`Deleted transcript files: ${srtPath}, ${txtPath}`);
        } catch (error) {
          this.logger.warn(`Failed to delete transcript files: ${error}`);
        }
      }

      // Read and store analysis
      if (job.analysisPath) {
        const analysisContent = await fs.readFile(job.analysisPath, 'utf-8');

        // Try to get sections from analysisResult first (from Python's return value)
        let sections: any[] = [];
        this.logger.log(`[DEBUG] job.analysisResult exists: ${!!job.analysisResult}`);
        if (job.analysisResult) {
          this.logger.log(`[DEBUG] job.analysisResult.sections exists: ${!!job.analysisResult.sections}`);
          this.logger.log(`[DEBUG] job.analysisResult.sections is array: ${Array.isArray(job.analysisResult.sections)}`);
          this.logger.log(`[DEBUG] job.analysisResult.sections length: ${job.analysisResult.sections?.length || 0}`);
        }
        if (job.analysisResult && job.analysisResult.sections && Array.isArray(job.analysisResult.sections)) {
          // Convert Python sections to database format
          sections = job.analysisResult.sections.map((section: any) => {
            // Parse time string like "0:42" or "1:23:45" to seconds
            let startSeconds = 0;
            if (section.start_time) {
              const parts = section.start_time.split(':').map((p: string) => parseInt(p));
              if (parts.length === 2) {
                // M:SS format
                startSeconds = parts[0] * 60 + parts[1];
              } else if (parts.length === 3) {
                // H:MM:SS format
                startSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
              }
            }

            return {
              id: uuidv4(),
              videoId,
              startSeconds,
              endSeconds: startSeconds + 10, // Default 10 second duration
              timestampText: section.start_time,
              title: section.description ? section.description.substring(0, 100) : undefined,
              description: section.description,
              category: section.category || 'routine',
            };
          });
          this.logger.log(`Loaded ${sections.length} sections from analysisResult`);
        } else {
          // Fall back to parsing from text if analysisResult not available
          this.logger.warn('No analysisResult.sections found, falling back to text parsing');
          sections = await this.parseAnalysisForSections(analysisContent, videoId);
        }

        // Check if analysis already exists
        const existingAnalysis = this.databaseService.getAnalysis(videoId);

        if (existingAnalysis) {
          // Delete existing analysis (this will cascade to sections via FK constraint)
          this.logger.log(`Deleting existing analysis for video ${videoId} before inserting new one`);
          this.databaseService.deleteAnalysis(videoId);
        }

        // Extract summary from analysis content (it's between **VIDEO OVERVIEW** and the first -----)
        let summary: string | null = null;
        const overviewMatch = analysisContent.match(/\*\*VIDEO OVERVIEW\*\*\s*\n\n([\s\S]*?)\n\n-{3,}/);
        if (overviewMatch && overviewMatch[1]) {
          summary = overviewMatch[1].trim();
          this.logger.log(`[AI Description] Extracted summary for video ${videoId}: ${summary.substring(0, 100)}...`);
        } else {
          this.logger.warn(`[AI Description] Failed to extract summary from analysis for video ${videoId}`);
          this.logger.debug(`[AI Description] Analysis content preview: ${analysisContent.substring(0, 500)}`);
        }

        // Store new analysis
        this.databaseService.insertAnalysis({
          videoId,
          aiAnalysis: analysisContent,
          summary: summary || undefined,
          sectionsCount: sections.length,
          aiModel: 'qwen2.5:7b', // Get from job config
          aiProvider: 'ollama',
        });

        // Update video's ai_description with the summary
        if (summary) {
          try {
            this.databaseService.updateVideoDescription(videoId, summary);
          } catch (error) {
            this.logger.warn(`Failed to update video description: ${error}`);
            // Continue anyway - not critical
          }
        }

        // Store sections
        for (const section of sections) {
          this.databaseService.insertAnalysisSection(section);
        }

        // Delete existing tags for this video before inserting new ones
        // (Tags are re-extracted from the new analysis)
        try {
          this.databaseService.deleteTagsForVideo(videoId);
        } catch (error) {
          this.logger.warn(`Failed to delete existing tags: ${error}`);
        }

        // Store tags from AI analysis (if available)
        if (job.tags) {
          const tags = this.convertJobTagsToDbTags(job.tags, videoId);
          for (const tag of tags) {
            try {
              this.databaseService.insertTag(tag);
            } catch (error) {
              // Ignore duplicate tag errors (shouldn't happen after delete)
            }
          }
        } else {
          // Fallback: Extract tags from analysis text (old method)
          const tags = await this.extractTagsFromAnalysis(analysisContent, videoId);
          for (const tag of tags) {
            try {
              this.databaseService.insertTag(tag);
            } catch (error) {
              // Ignore duplicate tag errors
            }
          }
        }
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Failed to store analysis results: ${err.message}`);
      throw error;
    }
  }

  /**
   * Parse analysis report to extract sections
   */
  private async parseAnalysisForSections(
    analysisText: string,
    videoId: string,
  ): Promise<
    Array<{
      id: string;
      videoId: string;
      startSeconds: number;
      endSeconds: number;
      timestampText?: string;
      title?: string;
      description?: string;
      category?: string;
    }>
  > {
    const sections: any[] = [];

    // Parse format: "**0:00 - Description [category]**"
    // or "**0:01:23 - Description [category]**"
    const timestampRegex = /\*\*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*-\s*(.+?)\s*\[(\w+)\]\*\*/g;

    let match;
    while ((match = timestampRegex.exec(analysisText)) !== null) {
      const firstNum = parseInt(match[1]);
      const secondNum = parseInt(match[2]);
      const thirdNum = match[3] ? parseInt(match[3]) : undefined;
      const description = match[4].trim();
      const category = match[5].trim();

      // Determine if format is M:SS or H:MM:SS
      let startSeconds: number;
      let timestampText: string;

      if (thirdNum !== undefined) {
        // Format: H:MM:SS
        const hours = firstNum;
        const minutes = secondNum;
        const seconds = thirdNum;
        startSeconds = hours * 3600 + minutes * 60 + seconds;
        timestampText = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
      } else {
        // Format: M:SS
        const minutes = firstNum;
        const seconds = secondNum;
        startSeconds = minutes * 60 + seconds;
        timestampText = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }

      sections.push({
        id: uuidv4(),
        videoId,
        startSeconds,
        endSeconds: startSeconds + 10, // Default 10 second section
        timestampText,
        title: description.substring(0, 100), // First 100 chars as title
        description,
        category,
      });
    }

    this.logger.log(`Parsed ${sections.length} sections from analysis`);
    return sections;
  }

  /**
   * Extract tags from analysis text
   */
  private async extractTagsFromAnalysis(
    analysisText: string,
    videoId: string,
  ): Promise<
    Array<{
      id: string;
      videoId: string;
      tagName: string;
      tagType: string;
      source: string;
      confidence: number;
    }>
  > {
    const tags: any[] = [];

    // Simple keyword extraction (can be improved with NLP later)
    const commonTopics = [
      'covid', 'vaccine', 'election', 'trump', 'biden', 'prophecy',
      'conspiracy', 'q-anon', 'lockdown', 'mask', 'fraud', 'stolen',
    ];

    const lowerText = analysisText.toLowerCase();

    for (const topic of commonTopics) {
      if (lowerText.includes(topic)) {
        tags.push({
          id: uuidv4(),
          videoId,
          tagName: topic,
          tagType: 'topic',
          source: 'ai',
          confidence: 0.7,
        });
      }
    }

    return tags;
  }

  /**
   * Convert job tags from Python analysis to database format
   */
  private convertJobTagsToDbTags(
    jobTags: { people: string[]; topics: string[] },
    videoId: string,
  ): Array<{
    id: string;
    videoId: string;
    tagName: string;
    tagType: string;
    source: string;
    confidence: number;
  }> {
    const tags: any[] = [];

    // Add people tags
    for (const person of jobTags.people || []) {
      tags.push({
        id: uuidv4(),
        videoId,
        tagName: person,
        tagType: 'person',
        source: 'ai',
        confidence: 0.9, // High confidence from AI extraction
      });
    }

    // Add topic tags
    for (const topic of jobTags.topics || []) {
      tags.push({
        id: uuidv4(),
        videoId,
        tagName: topic,
        tagType: 'topic',
        source: 'ai',
        confidence: 0.9, // High confidence from AI extraction
      });
    }

    return tags;
  }

  /**
   * Pause the current batch job
   */
  pauseBatch(): boolean {
    if (!this.currentBatchJob || this.currentBatchJob.status !== 'running') {
      return false;
    }

    this.isPaused = true;
    this.logger.log('Batch job pause requested');
    return true;
  }

  /**
   * Resume a paused batch job
   */
  async resumeBatch(): Promise<boolean> {
    if (!this.currentBatchJob || this.currentBatchJob.status !== 'paused') {
      return false;
    }

    this.logger.log('Resuming batch job');

    // Get remaining videos
    const allVideos = this.fileScannerService.getNeedsAnalysis();
    const config = await this.configService.getConfig();

    // Restart processing
    this.processBatch(allVideos, {
      aiModel: config.aiModel || 'qwen2.5:7b',
      aiProvider: 'ollama',
      whisperModel: 'base',
      ollamaEndpoint: config.ollamaEndpoint || 'http://localhost:11434',
    }).catch((error) => {
      const err = error as Error;
      this.logger.error(`Batch resume failed: ${err.message}`);
    });

    return true;
  }

  /**
   * Stop the current batch job
   */
  stopBatch(): boolean {
    if (!this.currentBatchJob || this.currentBatchJob.status !== 'running') {
      return false;
    }

    this.shouldStop = true;
    this.logger.log('Batch job stop requested');
    return true;
  }

  /**
   * Get current batch job status
   */
  getBatchProgress(): BatchProgress | null {
    if (!this.currentBatchJob) {
      return null;
    }

    const progress =
      this.currentBatchJob.totalVideos > 0
        ? (this.currentBatchJob.processedVideos / this.currentBatchJob.totalVideos) * 100
        : 0;

    return {
      jobId: this.currentBatchJob.id,
      status: this.currentBatchJob.status,
      totalVideos: this.currentBatchJob.totalVideos,
      processedVideos: this.currentBatchJob.processedVideos,
      failedVideos: this.currentBatchJob.failedVideos,
      skippedVideos: this.currentBatchJob.skippedVideos,
      currentVideoFilename: this.currentBatchJob.currentVideoFilename,
      progress: Math.round(progress),
      estimatedTimeRemaining: this.currentBatchJob.estimatedTimeRemaining,
      errors: this.currentBatchJob.errors,
    };
  }

  /**
   * Emit progress event
   */
  private emitProgress() {
    const progress = this.getBatchProgress();
    if (progress) {
      this.eventEmitter.emit('batch.progress', progress);
    }
  }
}
