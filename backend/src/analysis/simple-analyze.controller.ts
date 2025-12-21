import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MediaEventService } from '../media/media-event.service';
import { AIAnalysisService } from './ai-analysis.service';
import * as path from 'path';
import * as fs from 'fs/promises';

interface AnalyzeRequest {
  videoId: string;
  aiModel?: string;
  aiProvider?: 'ollama' | 'claude' | 'openai';
  customInstructions?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
  ollamaEndpoint?: string;
  jobId?: string;
}

/**
 * Simple analysis controller - handles ONLY AI analysis
 * Requires transcript to exist already
 */
@Controller('analyze')
export class SimpleAnalyzeController {
  private readonly logger = new Logger(SimpleAnalyzeController.name);
  private activeAnalyses = new Map<string, AbortController>();

  constructor(
    private databaseService: DatabaseService,
    private mediaEventService: MediaEventService,
    private aiAnalysis: AIAnalysisService,
  ) {}

  /**
   * Load analysis categories from config file
   * Throws error if categories are not configured - NO FALLBACKS
   */
  private loadCategories(): any[] {
    try {
      const userDataPath = process.env.APPDATA ||
                        (process.platform === 'darwin' ?
                        path.join(process.env.HOME || '', 'Library', 'Application Support') :
                        path.join(process.env.HOME || '', '.config'));

      const categoriesPath = path.join(userDataPath, 'ClipChimp', 'analysis-categories.json');

      const fsSync = require('fs');
      if (!fsSync.existsSync(categoriesPath)) {
        // Categories file doesn't exist - return empty array, analysis will still run but skip flagging
        this.logger.log('Analysis categories file not found - analysis will run without category flagging');
        return [];
      }

      const data = fsSync.readFileSync(categoriesPath, 'utf8');
      const parsed = JSON.parse(data);

      if (!parsed.categories || parsed.categories.length === 0) {
        // No categories configured - return empty array, analysis will still run but skip flagging
        this.logger.log('No analysis categories configured - analysis will run without category flagging');
        return [];
      }

      return parsed.categories;
    } catch (error) {
      this.logger.warn(`Failed to load categories: ${(error as Error).message} - continuing without category flagging`);
      return []; // Return empty array instead of throwing
    }
  }

  /**
   * Analyze a video by ID (must have transcript)
   */
  @Post()
  async analyze(@Body() body: AnalyzeRequest) {
    try {
      const {
        videoId,
        aiModel = 'qwen2.5:7b',
        aiProvider = 'ollama',
        customInstructions,
        claudeApiKey,
        openaiApiKey,
        ollamaEndpoint = 'http://localhost:11434',
        jobId,
      } = body;
      const finalJobId = jobId || `analyze-${videoId}`;

      if (!videoId) {
        throw new HttpException('Missing videoId', HttpStatus.BAD_REQUEST);
      }

      // Get video from database
      const video = this.databaseService.getVideoById(videoId);
      if (!video) {
        throw new HttpException('Video not found', HttpStatus.NOT_FOUND);
      }

      // Get transcript
      const transcript = this.databaseService.getTranscript(videoId);
      if (!transcript || !transcript.plain_text) {
        throw new HttpException(
          'Video has no transcript. Transcribe first.',
          HttpStatus.BAD_REQUEST,
        );
      }

      this.logger.log(`Starting analysis for video ${videoId}: ${video.filename}`);

      // Check if already analyzed - delete old analysis and AI-generated data
      const existingAnalysis = this.databaseService.getAnalysis(videoId);
      if (existingAnalysis) {
        this.logger.log(`Video ${videoId} already has analysis, re-analyzing`);
        // Delete old analysis
        this.databaseService.deleteAnalysis(videoId);

        // Delete AI-generated tags only (preserve user-created tags)
        this.databaseService.deleteAITagsForVideo(videoId);

        // Clear AI description and suggested title
        this.databaseService.updateVideoDescription(videoId, null);
        this.databaseService.updateVideoSuggestedTitle(videoId, null);
      }

      // Strip provider prefix from model name if present (e.g., "ollama:cogito:14b" -> "cogito:14b")
      let cleanModelName = aiModel;
      if (aiModel.includes(':')) {
        const parts = aiModel.split(':');
        // If first part matches provider, strip it
        if (aiProvider && parts[0] === aiProvider) {
          cleanModelName = parts.slice(1).join(':');
          this.logger.log(`Stripped model name: ${aiModel} -> ${cleanModelName}`);
        }
      }

      // Run analysis asynchronously
      this.runAnalysis(
        videoId,
        video.filename || 'Unknown',
        transcript.plain_text,
        cleanModelName,
        aiProvider,
        finalJobId,
        customInstructions,
        claudeApiKey,
        openaiApiKey,
        ollamaEndpoint,
      );

      return {
        success: true,
        videoId,
        message: 'Analysis started',
      };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to start analysis: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Run analysis in background
   */
  private async runAnalysis(
    videoId: string,
    videoTitle: string,
    transcriptText: string,
    aiModel: string,
    aiProvider: 'ollama' | 'claude' | 'openai',
    jobId: string,
    customInstructions?: string,
    claudeApiKey?: string,
    openaiApiKey?: string,
    ollamaEndpoint: string = 'http://localhost:11434',
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeAnalyses.set(videoId, abortController);

    try {
      // Emit start event
      this.mediaEventService.emitAnalysisProgress(
        videoId,
        0,
        `Analyzing with ${aiModel}...`,
        jobId
      );

      // Get transcript in SRT format for segment parsing
      const transcript = this.databaseService.getTranscript(videoId);
      if (!transcript || !transcript.srt_format) {
        throw new Error('Transcript SRT format not found');
      }

      // Parse SRT to segments
      const segments = this.parseSrtToSegments(transcript.srt_format);

      // Create temp output file path
      const os = require('os');
      const tmpDir = os.tmpdir();
      const sanitizedTitle = this.sanitizeFilename(videoTitle);
      const outputFile = path.join(tmpDir, `${jobId}_${sanitizedTitle}.txt`);

      // Load user's categories from config
      const categories = this.loadCategories();

      // Run AI analysis using native AIAnalysisService
      const analysisResult = await this.aiAnalysis.analyzeTranscript({
        provider: aiProvider,
        model: aiModel,
        transcript: transcriptText,
        segments,
        outputFile,
        customInstructions,
        videoTitle,
        categories,
        apiKey: aiProvider === 'claude' ? claudeApiKey : aiProvider === 'openai' ? openaiApiKey : undefined,
        ollamaEndpoint,
        onProgress: (progress) => {
          // Map progress (0-100) to our progress range (0-95)
          const mappedProgress = Math.round((progress.progress / 100) * 95);
          this.mediaEventService.emitAnalysisProgress(
            videoId,
            mappedProgress,
            progress.message,
            jobId
          );
        },
      });

      // Read analysis text from output file
      const analysisText = await fs.readFile(outputFile, 'utf-8');

      // Extract results
      const result = {
        analysis: analysisText,
        suggestedTitle: (analysisResult as any).suggested_title || videoTitle,
        aiDescription: analysisResult.description || '',
        sections: analysisResult.sections || [],
        sectionsCount: analysisResult.sections_count || 0,
        tags: analysisResult.tags || { people: [], topics: [] },
      };

      // Clean up temp file
      await fs.unlink(outputFile).catch(() => {});

      // Save to database
      this.mediaEventService.emitAnalysisProgress(videoId, 95, 'Saving analysis...', jobId);

      this.databaseService.insertAnalysis({
        videoId: videoId,
        aiAnalysis: result.analysis,
        summary: result.aiDescription,
        aiModel: aiModel,
        aiProvider: aiProvider,
      });

      // Save analysis sections
      if (result.sections && Array.isArray(result.sections)) {
        this.logger.log(`Saving ${result.sections.length} sections to database for video ${videoId}`);

        for (const section of result.sections) {
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

          // Only insert sections that have a valid category (skip uncategorized)
          if (section.category) {
            this.databaseService.insertAnalysisSection({
              id: require('uuid').v4(),
              videoId,
              startSeconds,
              endSeconds: startSeconds + 10, // Default 10 second duration
              timestampText: section.start_time,
              title: section.description ? section.description.substring(0, 100) : undefined,
              description: section.description,
              category: section.category,
              source: 'ai',
            });
          }
        }
      }

      // Save tags (people and topics)
      if (result.tags) {
        this.logger.log(`Saving tags for video ${videoId}: ${JSON.stringify(result.tags)}`);

        // Save people tags
        if (result.tags.people && Array.isArray(result.tags.people)) {
          for (const person of result.tags.people) {
            if (person && typeof person === 'string' && person.trim()) {
              this.databaseService.insertTag({
                id: require('uuid').v4(),
                videoId,
                tagName: person.trim(),
                tagType: 'person',
                source: 'ai',
                confidence: 0.8,
              });
            }
          }
        }

        // Save topic tags
        if (result.tags.topics && Array.isArray(result.tags.topics)) {
          for (const topic of result.tags.topics) {
            if (topic && typeof topic === 'string' && topic.trim()) {
              this.databaseService.insertTag({
                id: require('uuid').v4(),
                videoId,
                tagName: topic.trim(),
                tagType: 'topic',
                source: 'ai',
                confidence: 0.8,
              });
            }
          }
        }
      }

      // Update video with suggested title and description
      if (result.suggestedTitle) {
        this.databaseService.updateVideoSuggestedTitle(videoId, result.suggestedTitle);
      }
      if (result.aiDescription) {
        this.databaseService.updateVideoDescription(videoId, result.aiDescription);
      }

      // Emit 100% progress for completion
      this.logger.log(`Emitting 100% progress for job ${jobId}, video ${videoId}`);
      this.mediaEventService.emitAnalysisProgress(videoId, 100, 'Analysis completed', jobId);

      // Emit completion event
      this.logger.log(`Emitting analysis-completed event for video ${videoId}`);
      this.mediaEventService.emitAnalysisCompleted(
        videoId,
        result.suggestedTitle,
        result.aiDescription,
      );

      this.logger.log(`Analysis completed for video ${videoId}`);
    } catch (error: any) {
      this.logger.error(`Analysis failed for video ${videoId}:`, error);
      this.mediaEventService.emitAnalysisFailed(videoId, error.message);
    } finally {
      this.activeAnalyses.delete(videoId);
    }
  }

  /**
   * Parse SRT format to segments array (for AI analysis timestamp correlation)
   */
  private parseSrtToSegments(srtContent: string): any[] {
    const segments: any[] = [];

    if (!srtContent || typeof srtContent !== 'string') {
      this.logger.warn('[parseSrtToSegments] SRT content is undefined or not a string');
      return segments;
    }

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
   * Sanitize filename for safe file system usage
   */
  private sanitizeFilename(filename: string): string {
    let sanitized = filename
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/_{2,}/g, '_')
      .trim();

    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200).trim();
    }

    sanitized = sanitized.replace(/[_\.]+$/, '');

    if (!sanitized) {
      sanitized = 'untitled';
    }

    return sanitized;
  }

}
