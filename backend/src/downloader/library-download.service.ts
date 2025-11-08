// backend/src/downloader/library-download.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DownloaderService } from './downloader.service';
import { MediaEventService } from '../media/media-event.service';
import { FileScannerService } from '../database/file-scanner.service';
import { WhisperService } from '../media/whisper.service';
import { PythonBridgeService } from '../analysis/python-bridge.service';
import { DatabaseService } from '../database/database.service';
import { DownloadOptions } from '../common/interfaces/download.interface';

export interface LibraryDownloadJob {
  id: string;
  url: string;
  displayName: string;
  status: 'downloading' | 'importing' | 'transcribing' | 'analyzing' | 'completed' | 'failed';
  progress: number; // 0-100
  currentTask: string;
  error?: string;
  outputFile?: string;
  videoId?: string; // Database video ID after import
  transcriptFile?: string;
  analysisFile?: string;
  startedAt: Date;
  completedAt?: Date;
}

@Injectable()
export class LibraryDownloadService {
  private readonly logger = new Logger(LibraryDownloadService.name);
  private jobs: Map<string, LibraryDownloadJob> = new Map();
  private userActionResolvers: Map<string, (action: 'replace' | 'cancel') => void> = new Map();

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly fileScannerService: FileScannerService,
    private readonly whisperService: WhisperService,
    private readonly pythonBridgeService: PythonBridgeService,
    private readonly databaseService: DatabaseService,
    private readonly eventService: MediaEventService
  ) {
    this.setupListeners();
  }

  private setupListeners() {
    // Listen for download progress
    this.eventService.server?.on('download-progress', (data: { progress: number; task: string; jobId?: string }) => {
      if (data.jobId) {
        const job = this.jobs.get(data.jobId);
        if (job && job.status === 'downloading') {
          job.progress = data.progress;
          job.currentTask = data.task;
          this.emitJobUpdate(job);
        }
      }
    });

    // Listen for transcription progress
    this.eventService.server?.on('transcription-progress', (data: { progress: number; task: string; jobId?: string }) => {
      if (data.jobId) {
        const job = this.jobs.get(data.jobId);
        if (job && job.status === 'transcribing') {
          job.progress = data.progress;
          job.currentTask = data.task || 'Transcribing';
          this.emitJobUpdate(job);
        }
      }
    });

    // Listen for user action responses from frontend
    this.eventService.server?.on('library-download-user-action', (data: { jobId: string; action: 'replace' | 'cancel' }) => {
      this.logger.log(`Received user action for job ${data.jobId}: ${data.action}`);
      const resolver = this.userActionResolvers.get(data.jobId);
      if (resolver) {
        resolver(data.action);
        this.userActionResolvers.delete(data.jobId);
      }
    });
  }

  /**
   * Start a new library download with full processing pipeline
   */
  async startLibraryDownload(url: string, displayName?: string, shouldTranscribe: boolean = true, shouldAnalyze: boolean = true): Promise<string> {
    const jobId = `download-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const job: LibraryDownloadJob = {
      id: jobId,
      url,
      displayName: displayName || url,
      status: 'downloading',
      progress: 0,
      currentTask: 'Starting download...',
      startedAt: new Date()
    };

    this.jobs.set(jobId, job);
    this.emitJobUpdate(job);

    // Start the processing pipeline (don't await - run in background)
    this.processLibraryDownload(job, shouldTranscribe, shouldAnalyze).catch(error => {
      this.logger.error(`Error in library download pipeline for job ${jobId}:`, error);
      job.status = 'failed';
      job.error = error.message;
      job.completedAt = new Date();
      this.emitJobUpdate(job);
    });

    return jobId;
  }

  /**
   * Main processing pipeline: download → import → transcribe → analyze
   */
  private async processLibraryDownload(job: LibraryDownloadJob, shouldTranscribe: boolean, shouldAnalyze: boolean): Promise<void> {
    try {
      // Step 1: Download
      this.logger.log(`[${job.id}] Step 1: Downloading`);
      await this.downloadStep(job);

      // Step 2: Import to library
      this.logger.log(`[${job.id}] Step 2: Importing to library`);
      await this.importStep(job);

      // Step 3: Transcribe (if requested)
      if (shouldTranscribe && job.videoId) {
        this.logger.log(`[${job.id}] Step 3: Transcribing`);
        await this.transcribeStep(job);
      }

      // Step 4: AI Analysis (if requested and transcription is available)
      if (shouldAnalyze && job.videoId && job.transcriptFile) {
        this.logger.log(`[${job.id}] Step 4: AI Analysis`);
        await this.analyzeStep(job);
      }

      // Mark as completed
      job.status = 'completed';
      job.progress = 100;
      job.currentTask = 'Processing complete';
      job.completedAt = new Date();
      this.emitJobUpdate(job);

      this.logger.log(`[${job.id}] Library download pipeline completed successfully`);
    } catch (error) {
      this.logger.error(`[${job.id}] Pipeline failed:`, error);
      throw error;
    }
  }

  /**
   * Step 1: Download the video using downloaderService (which handles all the complex download logic)
   */
  private async downloadStep(job: LibraryDownloadJob): Promise<void> {
    job.status = 'downloading';
    job.progress = 0;
    job.currentTask = 'Downloading video...';
    this.emitJobUpdate(job);

    const downloadOptions: DownloadOptions = {
      url: job.url,
      displayName: job.displayName,
      shouldImport: false, // We'll handle import separately in our pipeline
      quality: '720', // Default quality
      convertToMp4: true,
      useCookies: true,
      browser: 'auto'
    };

    // Use the downloaderService which has all the complex download logic for YouTube, Rumble, etc.
    const result = await this.downloaderService.downloadVideo(downloadOptions, job.id);

    if (!result.success || !result.outputFile) {
      throw new Error('Download failed: ' + (result.error || 'Unknown error'));
    }

    job.outputFile = result.outputFile;
    job.progress = 100;
    this.logger.log(`[${job.id}] Download completed: ${result.outputFile}`);
  }

  /**
   * Step 2: Import video to library database
   */
  private async importStep(job: LibraryDownloadJob): Promise<void> {
    job.status = 'importing';
    job.progress = 0;
    job.currentTask = 'Adding to library...';
    this.emitJobUpdate(job);

    if (!job.outputFile) {
      throw new Error('No output file available for import');
    }

    const importResult = await this.fileScannerService.importVideos([job.outputFile]);

    // Get the video from database (whether newly imported or already existing)
    // First try by path, then by hash if not found
    const videos = await this.databaseService.getAllVideos();
    let importedVideo = videos.find((v: any) => v.file_path === job.outputFile || v.current_path === job.outputFile);

    // If not found by path, try by hash (in case video was moved or has different path)
    if (!importedVideo && importResult.errors.some(err => err.includes('Already imported'))) {
      const fileHash = await this.databaseService.hashFile(job.outputFile);
      importedVideo = this.databaseService.findVideoByHash(fileHash);
    }

    if (importResult.imported.length === 0) {
      // Check if it failed because it already exists
      const alreadyImportedError = importResult.errors.some(err => err.includes('Already imported'));

      if (alreadyImportedError && importedVideo) {
        // Video already exists in database - ask user what to do
        const fs = require('fs');
        const path = require('path');
        const filename = path.basename(job.outputFile);

        this.logger.log(`[${job.id}] Video already in library with ID: ${importedVideo.id}. Waiting for user action...`);

        // Emit duplicate detection event to frontend
        this.eventService.emitLibraryDownloadDuplicate(job.id, importedVideo.id, filename);

        // Update job status to indicate waiting for user
        job.currentTask = 'Video already exists - waiting for user action...';
        this.emitJobUpdate(job);

        // Wait for user response (replace or cancel)
        const userAction = await this.waitForUserAction(job.id);

        if (userAction === 'cancel') {
          // User chose to cancel - fail the job
          throw new Error('User cancelled: Video already exists in library');
        } else if (userAction === 'replace') {
          // User chose to replace - delete entire database entry and all associated files
          this.logger.log(`[${job.id}] User chose to replace existing video. Deleting database entry and all data...`);

          const appDataPath = path.join(require('os').homedir(), 'Library', 'Application Support', 'clippy');
          const transcriptsDir = path.join(appDataPath, 'transcripts');
          const analysesDir = path.join(appDataPath, 'analyses');

          // Delete transcript files
          const transcriptSrt = path.join(transcriptsDir, `${importedVideo.id}.srt`);
          const transcriptTxt = path.join(transcriptsDir, `${importedVideo.id}.txt`);
          if (fs.existsSync(transcriptSrt)) fs.unlinkSync(transcriptSrt);
          if (fs.existsSync(transcriptTxt)) fs.unlinkSync(transcriptTxt);

          // Delete analysis file
          const analysisFile = path.join(analysesDir, `${importedVideo.id}.txt`);
          if (fs.existsSync(analysisFile)) fs.unlinkSync(analysisFile);

          // Delete the database entry completely
          await this.databaseService.deleteVideo(importedVideo.id);
          this.logger.log(`[${job.id}] Deleted database entry for video ID: ${importedVideo.id}`);

          // Now re-import as a fresh video
          const reimportResult = await this.fileScannerService.importVideos([job.outputFile]);

          if (reimportResult.imported.length > 0) {
            // Get the newly imported video
            const videos = await this.databaseService.getAllVideos();
            const newVideo = videos.find((v: any) => v.file_path === job.outputFile || v.current_path === job.outputFile);

            if (newVideo) {
              job.videoId = newVideo.id;
              this.logger.log(`[${job.id}] Re-imported video with new ID: ${job.videoId}`);
            } else {
              throw new Error('Failed to find re-imported video in database');
            }
          } else {
            throw new Error('Failed to re-import video: ' + (reimportResult.errors.join(', ') || 'Unknown error'));
          }
        }
      } else {
        // Actual error - fail the import
        throw new Error('Failed to import video: ' + (importResult.errors.join(', ') || 'Unknown error'));
      }
    } else {
      // Successfully imported
      if (importedVideo) {
        job.videoId = importedVideo.id;
        this.logger.log(`[${job.id}] Video imported with ID: ${job.videoId}`);
      }
    }

    job.progress = 100;
  }

  /**
   * Wait for user action (replace or cancel) when duplicate is detected
   */
  private async waitForUserAction(jobId: string): Promise<'replace' | 'cancel'> {
    return new Promise<'replace' | 'cancel'>((resolve) => {
      this.userActionResolvers.set(jobId, resolve);
    });
  }

  /**
   * Step 3: Transcribe the video
   */
  private async transcribeStep(job: LibraryDownloadJob): Promise<void> {
    job.status = 'transcribing';
    job.progress = 0;
    job.currentTask = 'Transcribing audio...';
    this.emitJobUpdate(job);

    if (!job.outputFile) {
      throw new Error('No output file available for transcription');
    }

    // Transcribe the video using WhisperService
    const transcriptFile = await this.whisperService.transcribeVideo(job.outputFile, job.id);

    if (!transcriptFile) {
      throw new Error('Transcription failed');
    }

    job.transcriptFile = transcriptFile;
    job.progress = 100;
    this.logger.log(`[${job.id}] Transcription completed: ${transcriptFile}`);
  }

  /**
   * Step 4: AI analysis of the transcript
   */
  private async analyzeStep(job: LibraryDownloadJob): Promise<void> {
    job.status = 'analyzing';
    job.progress = 0;
    job.currentTask = 'Running AI analysis...';
    this.emitJobUpdate(job);

    if (!job.videoId || !job.transcriptFile) {
      throw new Error('No video ID or transcript file available for analysis');
    }

    // Run AI analysis using PythonBridgeService
    // Get the video from database to get its title
    const video = await this.databaseService.getVideoById(job.videoId);
    if (!video) {
      throw new Error('Video not found in database');
    }

    // Read transcript file (SRT format)
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const transcriptSrt = fs.readFileSync(job.transcriptFile, 'utf8');

    // Also read the plain text transcript (same path but .txt extension)
    const transcriptTxtFile = job.transcriptFile.replace('.srt', '.txt');
    const transcriptText = fs.existsSync(transcriptTxtFile)
      ? fs.readFileSync(transcriptTxtFile, 'utf8')
      : transcriptSrt; // Fallback to SRT if .txt doesn't exist

    // Parse SRT to segments (needed for timestamp correlation)
    const segments = this.parseSrtToSegments(transcriptSrt);

    // Determine output path for analysis file
    // Store in ~/Library/Application Support/clippy/analyses/
    const appDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'clippy');
    const analysesDir = path.join(appDataPath, 'analyses');

    // Create directory if it doesn't exist
    if (!fs.existsSync(analysesDir)) {
      fs.mkdirSync(analysesDir, { recursive: true });
    }

    const analysisOutputPath = path.join(analysesDir, `${job.videoId}.txt`);

    // Get AI config (model and endpoint)
    // For now, we'll use defaults - this should be configurable
    const ollamaEndpoint = 'http://localhost:11434';
    const aiModel = 'qwen2.5:7b';

    const analysisResult = await this.pythonBridgeService.analyze(
      ollamaEndpoint,
      aiModel,
      transcriptText,
      segments,
      analysisOutputPath,
      (progress) => {
        // Update progress during analysis
        job.progress = progress.progress;
        job.currentTask = progress.message;
        this.emitJobUpdate(job);
      },
      undefined, // customInstructions
      'ollama',  // aiProvider
      undefined, // apiKey
      String(video.title || job.displayName)  // videoTitle (10th parameter)
    );

    // The result has sections_count and sections properties
    job.analysisFile = analysisOutputPath;
    job.progress = 100;
    this.logger.log(`[${job.id}] AI analysis completed: ${analysisOutputPath} (${analysisResult.sections_count} sections)`);
  }

  /**
   * Parse SRT content into segments for AI analysis
   */
  private parseSrtToSegments(srtContent: string): any[] {
    const segments: any[] = [];
    const blocks = srtContent.split('\n\n').filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;

      // Line 0: sequence number
      // Line 1: timestamp (00:00:01,500 --> 00:00:04,200)
      // Line 2+: text
      const timestampLine = lines[1];
      const textLines = lines.slice(2);

      const match = timestampLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      if (match) {
        const startHours = parseInt(match[1]);
        const startMinutes = parseInt(match[2]);
        const startSeconds = parseInt(match[3]);
        const startMs = parseInt(match[4]);

        const endHours = parseInt(match[5]);
        const endMinutes = parseInt(match[6]);
        const endSeconds = parseInt(match[7]);
        const endMs = parseInt(match[8]);

        const start = startHours * 3600 + startMinutes * 60 + startSeconds + startMs / 1000;
        const end = endHours * 3600 + endMinutes * 60 + endSeconds + endMs / 1000;

        segments.push({
          start,
          end,
          text: textLines.join(' ')
        });
      }
    }

    return segments;
  }

  /**
   * Emit job update to frontend via WebSocket
   */
  private emitJobUpdate(job: LibraryDownloadJob): void {
    this.eventService.emitJobStatusUpdate(job.id, job.status, job.currentTask);
    this.eventService.emitJobProgress(job.id, job.progress, job.status, job.currentTask);

    // Also emit specific events based on status
    switch (job.status) {
      case 'downloading':
        this.eventService.emitDownloadProgress(job.progress, job.currentTask, job.id);
        break;
      case 'transcribing':
        this.eventService.emitTranscriptionProgress(job.progress, job.currentTask, job.id);
        break;
    }
  }

  /**
   * Get job status
   */
  getJob(jobId: string): LibraryDownloadJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all jobs
   */
  getAllJobs(): LibraryDownloadJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Cancel a job
   */
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'completed' || job.status === 'failed') {
      return false;
    }

    job.status = 'failed';
    job.error = 'Cancelled by user';
    job.completedAt = new Date();
    this.emitJobUpdate(job);

    return true;
  }

  /**
   * Clear completed/failed jobs
   */
  clearCompletedJobs(): void {
    const activeJobs = new Map(
      Array.from(this.jobs.entries()).filter(([_, job]) =>
        job.status !== 'completed' && job.status !== 'failed'
      )
    );
    this.jobs = activeJobs;
  }
}
