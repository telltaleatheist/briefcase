// Atomic media operations service - each operation is standalone and emits progress

import { Injectable, Logger } from '@nestjs/common';
import { MediaEventService } from './media-event.service';
import { MediaProcessingService } from './media-processing.service';
import { WhisperService } from './whisper.service';
import { DownloaderService } from '../downloader/downloader.service';
import { FileScannerService } from '../database/file-scanner.service';
import { DatabaseService } from '../database/database.service';
import { AIAnalysisService } from '../analysis/ai-analysis.service';
import { ApiKeysService } from '../config/api-keys.service';
import { FfmpegService } from '../ffmpeg/ffmpeg.service';
import {
  GetInfoResult,
  DownloadResult,
  ImportResult,
  FixAspectRatioResult,
  NormalizeAudioResult,
  ProcessVideoResult,
  TranscribeResult,
  AnalyzeResult,
} from '../common/interfaces/task.interface';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MediaOperationsService {
  private readonly logger = new Logger(MediaOperationsService.name);

  constructor(
    private readonly downloaderService: DownloaderService,
    private readonly fileScannerService: FileScannerService,
    private readonly databaseService: DatabaseService,
    private readonly mediaProcessingService: MediaProcessingService,
    private readonly whisperService: WhisperService,
    private readonly aiAnalysisService: AIAnalysisService,
    private readonly eventService: MediaEventService,
    private readonly apiKeysService: ApiKeysService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  /**
   * Get video info/metadata without downloading
   */
  async getVideoInfo(url: string, jobId?: string): Promise<GetInfoResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Getting video info for: ${url}`);

      this.eventService.emitTaskProgress(jobId || '', 'get-info', 10, 'Fetching video metadata...');

      const info = await this.downloaderService.getVideoInfo(url);

      this.eventService.emitTaskProgress(jobId || '', 'get-info', 100, 'Metadata retrieved');

      return {
        success: true,
        data: {
          title: info.title,
          uploader: info.uploader,
          duration: info.duration,
          uploadDate: info.uploadDate,
          thumbnail: info.thumbnail,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get video info: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get video info',
      };
    }
  }

  /**
   * Download video only (no import, no processing)
   */
  async downloadVideo(
    url: string,
    options: {
      quality?: string;
      convertToMp4?: boolean;
      useCookies?: boolean;
      browser?: string;
      displayName?: string;
      outputDir?: string;
    },
    jobId?: string,
  ): Promise<DownloadResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Downloading video: ${url}`);

      this.eventService.emitTaskProgress(jobId || '', 'download', 0, 'Starting download...');

      const result = await this.downloaderService.downloadVideo(
        {
          url,
          quality: options.quality || '720',
          convertToMp4: options.convertToMp4 !== false,
          useCookies: options.useCookies !== false,
          browser: options.browser || 'auto',
          displayName: options.displayName,
          outputDir: options.outputDir,
          fixAspectRatio: false, // Never process during download
          useRmsNormalization: false,
          useCompression: false,
        },
        jobId,
      );

      if (!result.success || !result.outputFile) {
        throw new Error(result.error || 'Download failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'download', 100, 'Download complete');

      // Extract title from the actual output filename - no fallbacks
      const path = require('path');
      const filename = path.basename(result.outputFile, path.extname(result.outputFile));

      return {
        success: true,
        data: {
          videoPath: result.outputFile,
          title: filename,
        },
      };
    } catch (error) {
      this.logger.error(`Download failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Download failed',
      };
    }
  }

  /**
   * Import video to library database
   */
  async importToLibrary(
    videoPath: string,
    options: {
      duplicateHandling?: 'skip' | 'replace' | 'keep-both';
    } = {},
    jobId?: string,
  ): Promise<ImportResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Importing video: ${videoPath}`);

      this.eventService.emitTaskProgress(jobId || '', 'import', 10, 'Checking for duplicates...');

      const duplicateHandling = new Map<string, 'skip' | 'replace' | 'keep-both'>();
      duplicateHandling.set(videoPath, options.duplicateHandling || 'keep-both');

      this.eventService.emitTaskProgress(jobId || '', 'import', 30, 'Calculating file hash...');

      const importResult = await this.fileScannerService.importVideos([videoPath], duplicateHandling);

      this.eventService.emitTaskProgress(jobId || '', 'import', 70, 'Extracting metadata...');

      let videoId: string | undefined;
      let wasAlreadyImported = false;

      if (importResult.imported.length > 0) {
        videoId = importResult.imported[0];
        this.logger.log(`[${jobId || 'standalone'}] Video imported with ID: ${videoId}`);
      } else if (importResult.errors.some(err => err.includes('Already imported'))) {
        // Video already exists - find it by hash
        const fileHash = await this.databaseService.hashFile(videoPath);
        const existingVideo = this.databaseService.findVideoByHash(fileHash);

        if (existingVideo) {
          videoId = existingVideo.id as string;
          wasAlreadyImported = true;
          this.logger.log(`[${jobId || 'standalone'}] Video already in library with ID: ${videoId}`);

          // Update download date
          this.databaseService.updateVideoDownloadDate(videoId, new Date().toISOString());

          // Delete the duplicate file
          if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            this.logger.log(`[${jobId || 'standalone'}] Deleted duplicate file: ${videoPath}`);
          }
        }
      }

      if (!videoId) {
        throw new Error('Failed to import video: ' + importResult.errors.join(', '));
      }

      this.eventService.emitTaskProgress(jobId || '', 'import', 100, 'Import complete');

      // Emit video-imported event so frontend refreshes
      this.eventService.emitVideoImported(videoId, path.basename(videoPath), videoPath);

      return {
        success: true,
        data: {
          videoId,
          wasAlreadyImported,
        },
      };
    } catch (error) {
      this.logger.error(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Import failed',
      };
    }
  }

  /**
   * Fix aspect ratio for vertical videos
   */
  async fixAspectRatio(
    videoIdOrPath: string,
    options: {} = {},
    jobId?: string,
  ): Promise<FixAspectRatioResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Fixing aspect ratio for: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.logger.log(`[${jobId || 'standalone'}] Fix aspect ratio using path: ${videoPath}`);
      this.eventService.emitTaskProgress(jobId || '', 'fix-aspect-ratio', 5, 'Analyzing video dimensions...');

      const result = await this.mediaProcessingService.processMedia(
        videoPath,
        { fixAspectRatio: true },
        jobId,
        'fix-aspect-ratio'  // Pass task type for progress relay
      );

      if (!result.success) {
        throw new Error(result.error || 'Aspect ratio fix failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'fix-aspect-ratio', 100, 'Aspect ratio fixed');

      return {
        success: true,
        data: {
          outputPath: result.outputFile || videoPath,
          wasProcessed: result.outputFile !== videoPath, // False if video didn't need processing
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Fix aspect ratio failed';
      this.logger.error(`Fix aspect ratio failed: ${errorMsg}`);
      // Emit failure progress so UI updates immediately
      this.eventService.emitTaskProgress(jobId || '', 'fix-aspect-ratio', -1, `Failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Normalize audio levels
   */
  async normalizeAudio(
    videoIdOrPath: string,
    options: {
      level?: number;
      method?: 'rms' | 'ebu-r128';
    } = {},
    jobId?: string,
  ): Promise<NormalizeAudioResult> {
    try {
      console.log('=== MediaOperationsService.normalizeAudio CALLED ===');
      console.log(`VideoIdOrPath: ${videoIdOrPath}, Options: ${JSON.stringify(options)}, JobId: ${jobId}`);
      this.logger.log(`[${jobId || 'standalone'}] Normalizing audio for: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.eventService.emitTaskProgress(jobId || '', 'normalize-audio', 5, 'Analyzing audio levels...');

      // Use loudnorm filter for proper audio normalization (EBU R128 standard)
      // This normalizes to target integrated loudness (LUFS) so all videos have consistent perceived volume
      const targetLoudness = options.level || -16;  // Default to -16 LUFS (typical for web content)
      const normalizedPath = await this.ffmpegService.normalizeAudio(videoPath, targetLoudness, jobId);

      if (!normalizedPath) {
        throw new Error('Audio normalization failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'normalize-audio', 100, 'Audio normalized');

      return {
        success: true,
        data: {
          outputPath: normalizedPath,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Audio normalization failed';
      this.logger.error(`Normalize audio failed: ${errorMsg}`);
      // Emit failure progress so UI updates immediately
      this.eventService.emitTaskProgress(jobId || '', 'normalize-audio', -1, `Failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Process video with combined operations (aspect ratio + audio normalization)
   * This does both in a single FFmpeg pass to avoid double re-encoding
   */
  async processVideo(
    videoIdOrPath: string,
    options: {
      fixAspectRatio?: boolean;
      normalizeAudio?: boolean;
      level?: number;
      method?: 'rms' | 'ebu-r128';
    } = {},
    jobId?: string,
  ): Promise<ProcessVideoResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Processing video: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.eventService.emitTaskProgress(jobId || '', 'process-video', 5, 'Analyzing video...');

      // Single re-encode with both aspect ratio and audio normalization
      const result = await this.mediaProcessingService.processMedia(
        videoPath,
        {
          fixAspectRatio: options.fixAspectRatio || false,
          useRmsNormalization: options.normalizeAudio && (options.method === 'rms' || !options.method),
          rmsNormalizationLevel: options.level || -16,
        },
        jobId,
        'process-video'  // Pass task type for progress relay
      );

      if (!result.success) {
        throw new Error(result.error || 'Video processing failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'process-video', 100, 'Video processed');

      return {
        success: true,
        data: {
          outputPath: result.outputFile || videoPath,
          aspectRatioFixed: options.fixAspectRatio || false,
          audioNormalized: options.normalizeAudio || false,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Video processing failed';
      this.logger.error(`Process video failed: ${errorMsg}`);
      // Emit failure progress so UI updates immediately
      this.eventService.emitTaskProgress(jobId || '', 'process-video', -1, `Failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Transcribe video using Whisper
   */
  async transcribeVideo(
    videoIdOrPath: string,
    options: {
      model?: string;
      language?: string;
    } = {},
    jobId?: string,
  ): Promise<TranscribeResult> {
    try {
      this.logger.log(`[${jobId || 'standalone'}] Transcribing video: ${videoIdOrPath}`);

      // Determine if this is a video ID or file path
      // UUIDs follow pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      let videoPath: string;
      let videoId: string | undefined;

      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const isUUID = uuidPattern.test(videoIdOrPath);

      if (isUUID || !fs.existsSync(videoIdOrPath)) {
        // It's a video ID - get path from database
        const video = this.databaseService.getVideoById(videoIdOrPath);
        if (!video) {
          throw new Error(`Video not found: ${videoIdOrPath}`);
        }
        videoPath = video.current_path as string;
        videoId = videoIdOrPath;
      } else {
        // It's a file path
        videoPath = videoIdOrPath;
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 0, 'Starting transcription...');

      const transcriptFile = await this.whisperService.transcribeVideo(videoPath, jobId, options.model);

      if (!transcriptFile) {
        throw new Error('Transcription failed');
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 95, 'Saving transcript...');

      // Read transcript files
      const transcriptSrt = fs.readFileSync(transcriptFile, 'utf8');
      const transcriptTxtFile = transcriptFile.replace('.srt', '.txt');
      const transcriptText = fs.existsSync(transcriptTxtFile)
        ? fs.readFileSync(transcriptTxtFile, 'utf8')
        : transcriptSrt;

      // If we have a videoId, save to database
      if (videoId) {
        this.databaseService.insertTranscript({
          videoId,
          plainText: transcriptText,
          srtFormat: transcriptSrt,
          whisperModel: options.model || 'base',
          language: options.language || 'en',
        });
        this.logger.log(`[${jobId || 'standalone'}] Transcript saved to database for video ${videoId}`);

        // Clean up temp files
        if (fs.existsSync(transcriptFile)) fs.unlinkSync(transcriptFile);
        if (fs.existsSync(transcriptTxtFile)) fs.unlinkSync(transcriptTxtFile);
      }

      this.eventService.emitTaskProgress(jobId || '', 'transcribe', 100, 'Transcription complete');

      return {
        success: true,
        data: {
          transcriptPath: videoId ? undefined : transcriptFile, // Only return path if not saved to DB
        },
      };
    } catch (error) {
      this.logger.error(`Transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Transcription failed',
      };
    }
  }

  /**
   * AI analysis of video transcript
   */
  async analyzeVideo(
    videoId: string,
    options: {
      aiModel: string;
      aiProvider?: 'ollama' | 'claude' | 'openai';
      apiKey?: string;
      ollamaEndpoint?: string;
      customInstructions?: string;
    },
    jobId?: string,
  ): Promise<AnalyzeResult> {
    console.log('=== MediaOperationsService.analyzeVideo CALLED ===');
    console.log(`VideoId: ${videoId}, Options: ${JSON.stringify(options)}, JobId: ${jobId}`);

    try {
      this.logger.log(`[${jobId || 'standalone'}] Analyzing video: ${videoId}`);

      // Get video and transcript from database
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        throw new Error('Video not found');
      }

      const transcript = this.databaseService.getTranscript(videoId);
      if (!transcript) {
        throw new Error('Transcript not found - transcribe video first');
      }

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 0, 'Starting AI analysis...');

      const transcriptText = transcript.plain_text as string;
      const transcriptSrt = transcript.srt_format as string;

      // Parse SRT to segments
      const segments = this.parseSrtToSegments(transcriptSrt);

      // Create temp file for analysis output
      const os = require('os');
      const tmpDir = os.tmpdir();
      const analysisOutputPath = path.join(tmpDir, `${jobId || 'analysis'}_analysis.txt`);

      // Extract provider from model name prefix if not explicitly set
      // Model format: "provider:model" (e.g., "openai:gpt-4o", "ollama:qwen2.5:7b", "claude:claude-3-5-sonnet-latest")
      let cleanModelName = options.aiModel;
      let provider = options.aiProvider || 'ollama';

      // Check if model name has a provider prefix
      const knownProviders = ['ollama', 'openai', 'claude'];
      const colonIndex = cleanModelName.indexOf(':');
      if (colonIndex > 0) {
        const possibleProvider = cleanModelName.substring(0, colonIndex);
        if (knownProviders.includes(possibleProvider)) {
          // Extract provider from model name if not explicitly set or if it matches
          if (!options.aiProvider || possibleProvider === options.aiProvider) {
            provider = possibleProvider as 'ollama' | 'openai' | 'claude';
            cleanModelName = cleanModelName.substring(colonIndex + 1);
            this.logger.log(`[${jobId || 'standalone'}] Extracted provider '${provider}' from model name: ${options.aiModel} -> ${cleanModelName}`);
          }
        }
      }

      // Get API key from options or from stored config
      let apiKey = options.apiKey;
      if (!apiKey && provider !== 'ollama') {
        // Get API key from the API keys service
        if (provider === 'openai') {
          apiKey = this.apiKeysService.getOpenAiApiKey();
          this.logger.log(`[${jobId || 'standalone'}] Using stored OpenAI API key`);
        } else if (provider === 'claude') {
          apiKey = this.apiKeysService.getClaudeApiKey();
          this.logger.log(`[${jobId || 'standalone'}] Using stored Claude API key`);
        }

        if (!apiKey) {
          throw new Error(`No API key found for ${provider}. Please configure your ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key in settings.`);
        }
      }

      // Use filename (always present) - strip extension for display
      const videoTitle = video.filename.replace(/\.[^/.]+$/, '');

      // Load categories from config
      const categories = this.loadCategories();

      // Use native AIAnalysisService (replaces Python bridge)
      const analysisResult = await this.aiAnalysisService.analyzeTranscript({
        provider,
        model: cleanModelName,
        transcript: transcriptText,
        segments,
        outputFile: analysisOutputPath,
        customInstructions: options.customInstructions,
        videoTitle,
        categories,
        apiKey,
        ollamaEndpoint: options.ollamaEndpoint || 'http://localhost:11434',
        onProgress: (progress) => {
          this.eventService.emitTaskProgress(jobId || '', 'analyze', progress.progress, progress.message);
        },
      });

      // Log analysis result
      this.logger.log(`[${jobId || 'standalone'}] Analysis result:`, JSON.stringify({
        sections_count: analysisResult.sections_count,
        has_sections: !!analysisResult.sections,
        sections_length: analysisResult.sections?.length || 0,
        has_tags: !!analysisResult.tags,
        has_description: !!analysisResult.description,
        description_preview: analysisResult.description?.substring(0, 50),
        has_suggested_title: !!analysisResult.suggested_title,
        suggested_title: analysisResult.suggested_title,
      }));

      // Read analysis file
      const analysisText = fs.readFileSync(analysisOutputPath, 'utf8');

      // Save analysis to database (including title suggestion in summary field)
      this.databaseService.insertAnalysis({
        videoId,
        aiAnalysis: analysisText,
        summary: analysisResult.suggested_title || undefined,  // Save title suggestion as summary
        sectionsCount: analysisResult.sections_count || 0,
        aiModel: cleanModelName,
        aiProvider: provider,
      });

      this.logger.log(`[${jobId || 'standalone'}] Analysis saved to database (${analysisResult.sections_count} sections, title: ${analysisResult.suggested_title || 'none'})`);

      // Extract and save tags from analysis result
      if (analysisResult.tags) {
        // Delete existing AI tags first
        this.databaseService.deleteAITagsForVideo(videoId);

        // Add new AI-generated tags from people and topics
        const allTags: string[] = [];
        if (analysisResult.tags.people) {
          allTags.push(...analysisResult.tags.people);
        }
        if (analysisResult.tags.topics) {
          allTags.push(...analysisResult.tags.topics);
        }

        for (const tagName of allTags) {
          const tagId = `ai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          this.databaseService.insertTag({
            id: tagId,
            videoId,
            tagName: tagName,
            source: 'ai',
            confidence: 0.8,
          });
        }
        this.logger.log(`[${jobId || 'standalone'}] Saved ${allTags.length} AI tags`);
      }

      // Save AI description
      if (analysisResult.description) {
        this.databaseService.updateVideoDescription(videoId, analysisResult.description);
        this.logger.log(`[${jobId || 'standalone'}] Saved AI description`);
      }

      // Save suggested title
      if (analysisResult.suggested_title) {
        this.databaseService.updateVideoSuggestedTitle(videoId, analysisResult.suggested_title);
        this.logger.log(`[${jobId || 'standalone'}] Saved suggested title: ${analysisResult.suggested_title}`);
      }

      // Save analysis sections
      if (analysisResult.sections && Array.isArray(analysisResult.sections)) {
        for (const section of analysisResult.sections) {
          const sectionId = `section-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          const startSeconds = this.parseTimeToSeconds(section.start_time);
          const endSeconds = section.end_time ? this.parseTimeToSeconds(section.end_time) : startSeconds + 30;
          this.databaseService.insertAnalysisSection({
            id: sectionId,
            videoId,
            startSeconds,
            endSeconds,
            timestampText: `${section.start_time}${section.end_time ? ' - ' + section.end_time : ''}`,
            title: section.category,
            description: section.description,
            category: section.category,
            source: 'ai',
          });
        }
        this.logger.log(`[${jobId || 'standalone'}] Saved ${analysisResult.sections.length} analysis sections`);
      }

      // Emit finalizing progress before completing
      this.eventService.emitTaskProgress(jobId || '', 'analyze', 95, 'Finalizing and saving results...');

      // Clean up temp file
      if (fs.existsSync(analysisOutputPath)) fs.unlinkSync(analysisOutputPath);

      this.eventService.emitTaskProgress(jobId || '', 'analyze', 100, 'Analysis complete');

      // Emit analysis-completed event AFTER all data is saved
      // This ensures the frontend can reload and get ALL the data at once
      this.eventService.emitAnalysisCompleted(
        videoId,
        analysisResult.suggested_title || '',
        analysisResult.description || ''
      );

      this.logger.log(`[${jobId || 'standalone'}] Emitted analysis-completed event for video ${videoId}`);

      return {
        success: true,
        data: {
          sectionsCount: analysisResult.sections_count || 0,
        },
      };
    } catch (error) {
      this.logger.error(`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Analysis failed',
      };
    }
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
          text: textLines.join(' '),
        });
      }
    }

    return segments;
  }

  /**
   * Parse time string (HH:MM:SS or MM:SS) to seconds
   */
  private parseTimeToSeconds(timeStr: string): number {
    if (!timeStr) return 0;

    const parts = timeStr.trim().split(':');
    let seconds = 0;

    if (parts.length === 3) {
      // HH:MM:SS
      seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
    } else if (parts.length === 2) {
      // MM:SS
      seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
    } else if (parts.length === 1) {
      // Just seconds
      seconds = parseInt(parts[0]);
    }

    return seconds;
  }

  /**
   * Set a video flag in the database
   * Used to track processing state (aspect_ratio_fixed, audio_normalized, etc.)
   */
  async setVideoFlag(
    videoId: string,
    flagName: 'aspect_ratio_fixed' | 'audio_normalized',
    value: 0 | 1,
  ): Promise<void> {
    const db = this.databaseService.getDatabase();
    db.prepare(`UPDATE videos SET ${flagName} = ? WHERE id = ?`).run(value, videoId);
    this.logger.log(`Set ${flagName} = ${value} for video ${videoId}`);
  }

  /**
   * Load analysis categories from config file
   * Throws error if categories not configured - forces proper initialization via Settings
   */
  private loadCategories(): any[] {
    const userDataPath = process.env.APPDATA ||
                      (process.platform === 'darwin' ?
                      path.join(process.env.HOME || '', 'Library', 'Application Support') :
                      path.join(process.env.HOME || '', '.config'));

    const categoriesPath = path.join(userDataPath, 'ClipChimp', 'analysis-categories.json');

    if (!fs.existsSync(categoriesPath)) {
      throw new Error(
        'Analysis categories not initialized. ' +
        'The categories file should be created automatically when the app starts. ' +
        'Try opening Settings or restart the app.'
      );
    }

    const data = fs.readFileSync(categoriesPath, 'utf8');
    const parsed = JSON.parse(data);

    // Handle both formats: array directly or { categories: [...] }
    const categories = Array.isArray(parsed) ? parsed : parsed.categories;

    if (!categories || categories.length === 0) {
      throw new Error(
        'No analysis categories found in config file. ' +
        'Please configure categories in Settings > Analysis Categories.'
      );
    }

    return categories;
  }
}
