import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

/**
 * MigrationService - Migrates data from legacy library.json to SQLite database
 *
 * This is a one-time migration that imports:
 * - Existing analyzed videos from library.json
 * - Transcripts from ~/Library/Application Support/clippy/transcripts/
 * - Analyses from ~/Library/Application Support/clippy/analyses/
 * - Parsed metadata (sections, categories)
 */
@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);
  private readonly libraryPath: string;
  private readonly analysesDir: string;
  private readonly transcriptsDir: string;

  constructor(private readonly databaseService: DatabaseService) {
    const appDataPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'clippy',
    );

    this.libraryPath = path.join(appDataPath, 'library.json');
    this.analysesDir = path.join(appDataPath, 'analyses');
    this.transcriptsDir = path.join(appDataPath, 'transcripts');
  }

  /**
   * Check if migration is needed (library.json exists and database is empty)
   */
  async shouldMigrate(): Promise<boolean> {
    // Check if library.json exists
    if (!fsSync.existsSync(this.libraryPath)) {
      this.logger.log('No library.json found - migration not needed');
      return false;
    }

    // Check if database already has videos
    const stats = this.databaseService.getStats();
    if (stats.totalVideos > 0) {
      this.logger.log('Database already has videos - migration already done');
      return false;
    }

    this.logger.log('Migration needed: library.json exists and database is empty');
    return true;
  }

  /**
   * Perform migration from library.json to database
   */
  async migrate(): Promise<MigrationResult> {
    this.logger.log('Starting migration from library.json to database...');
    const startTime = Date.now();

    const result: MigrationResult = {
      videosImported: 0,
      transcriptsImported: 0,
      analysesImported: 0,
      sectionsImported: 0,
      tagsImported: 0,
      errors: [],
      duration: 0,
    };

    try {
      // Load library.json
      const libraryContent = await fs.readFile(this.libraryPath, 'utf-8');
      const library = JSON.parse(libraryContent) as LegacyLibrary;

      this.logger.log(`Found ${library.analyses.length} analyses in library.json`);

      // Process each analysis
      for (const analysis of library.analyses) {
        try {
          await this.migrateAnalysis(analysis, result);
        } catch (error) {
          const err = error as Error;
          this.logger.error(
            `Failed to migrate analysis ${analysis.id}: ${err.message}`,
          );
          result.errors.push(`Analysis ${analysis.title}: ${err.message}`);
        }
      }

      result.duration = Date.now() - startTime;

      this.logger.log(
        `Migration complete in ${(result.duration / 1000).toFixed(1)}s:\n` +
          `  Videos: ${result.videosImported}\n` +
          `  Transcripts: ${result.transcriptsImported}\n` +
          `  Analyses: ${result.analysesImported}\n` +
          `  Sections: ${result.sectionsImported}\n` +
          `  Tags: ${result.tagsImported}\n` +
          `  Errors: ${result.errors.length}`,
      );

      return result;
    } catch (error) {
      const err = error as Error;
      this.logger.error(`Migration failed: ${err.message}`, err.stack);
      throw error;
    }
  }

  /**
   * Migrate a single analysis with all its associated data
   */
  private async migrateAnalysis(
    analysis: LegacyAnalysis,
    result: MigrationResult,
  ): Promise<void> {
    const videoId = analysis.id; // Use same ID for consistency

    // 1. Import video metadata
    try {
      // Get file stats if video exists
      let fileSizeBytes: number | undefined;
      let fileHash: string | undefined;

      if (analysis.video.isLinked && fsSync.existsSync(analysis.video.currentPath)) {
        const stats = fsSync.statSync(analysis.video.currentPath);
        fileSizeBytes = stats.size;

        // Compute hash for the video
        try {
          fileHash = await this.databaseService.hashFile(analysis.video.currentPath);
        } catch (error) {
          const err = error as Error;
          this.logger.warn(`Could not hash video ${analysis.video.filename}: ${err.message}`);
        }
      }

      this.databaseService.insertVideo({
        id: videoId,
        filename: analysis.video.filename,
        fileHash: fileHash || `legacy-${videoId}`, // Fallback for missing files
        currentPath: analysis.video.currentPath,
        dateFolder: analysis.video.clipsWeekFolder,
        durationSeconds: analysis.video.durationSeconds,
        fileSizeBytes,
      });

      // If video is not linked, mark it
      if (!analysis.video.isLinked) {
        this.databaseService.markVideoUnlinked(videoId);
      }

      result.videosImported++;
    } catch (error) {
      // Check if video already exists (duplicate)
      const existing = this.databaseService.findVideoById(videoId);
      if (!existing) {
        throw error; // Re-throw if it's not a duplicate
      }
      this.logger.warn(`Video ${videoId} already exists, skipping`);
    }

    // 2. Import transcript
    if (analysis.files.transcriptTxt && fsSync.existsSync(analysis.files.transcriptTxt)) {
      try {
        const plainText = await fs.readFile(analysis.files.transcriptTxt, 'utf-8');
        let srtFormat = '';

        if (analysis.files.transcriptSrt && fsSync.existsSync(analysis.files.transcriptSrt)) {
          srtFormat = await fs.readFile(analysis.files.transcriptSrt, 'utf-8');
        }

        this.databaseService.insertTranscript({
          videoId,
          plainText,
          srtFormat: srtFormat || plainText, // Fallback to plain text if no SRT
          whisperModel: analysis.metadata.transcriptionModel,
          language: 'en', // Assume English for legacy data
        });

        result.transcriptsImported++;
      } catch (error) {
        const err = error as Error;
        this.logger.warn(`Could not import transcript for ${videoId}: ${err.message}`);
      }
    }

    // 3. Import analysis report
    if (analysis.files.analysis && fsSync.existsSync(analysis.files.analysis)) {
      try {
        const analysisText = await fs.readFile(analysis.files.analysis, 'utf-8');

        // Try to load parsed metadata
        let parsedMetadata: ParsedAnalysisMetadata | null = null;
        if (
          analysis.files.analysisMetadata &&
          fsSync.existsSync(analysis.files.analysisMetadata)
        ) {
          const metadataContent = await fs.readFile(
            analysis.files.analysisMetadata,
            'utf-8',
          );
          parsedMetadata = JSON.parse(metadataContent);
        }

        // Determine AI provider from model name
        let aiProvider = 'unknown';
        if (analysis.metadata.analysisModel.includes('claude')) {
          aiProvider = 'claude';
        } else if (analysis.metadata.analysisModel.includes('gpt')) {
          aiProvider = 'openai';
        } else if (analysis.metadata.analysisModel.includes('qwen')) {
          aiProvider = 'ollama';
        }

        this.databaseService.insertAnalysis({
          videoId,
          aiAnalysis: analysisText,
          summary: analysis.title,
          sectionsCount: parsedMetadata?.sections.length,
          aiModel: analysis.metadata.analysisModel,
          aiProvider,
        });

        result.analysesImported++;

        // 4. Import analysis sections
        if (parsedMetadata?.sections) {
          for (const section of parsedMetadata.sections) {
            try {
              this.databaseService.insertAnalysisSection({
                id: uuidv4(),
                videoId,
                startSeconds: section.startSeconds,
                endSeconds: section.endSeconds || section.startSeconds + 10, // Default 10 sec if no end
                timestampText: section.timeRange,
                title: section.category,
                description: section.description,
                category: section.category,
              });

              result.sectionsImported++;
            } catch (error) {
              const err = error as Error;
              this.logger.warn(
                `Could not import section for ${videoId}: ${err.message}`,
              );
            }
          }
        }

        // 5. Import tags (from categories)
        if (analysis.metadata.categories && analysis.metadata.categories.length > 0) {
          for (const category of analysis.metadata.categories) {
            try {
              this.databaseService.insertTag({
                id: uuidv4(),
                videoId,
                tagName: category.toLowerCase(),
                tagType: 'topic',
                source: 'ai',
                confidence: 0.8, // Legacy data, assume medium confidence
              });

              result.tagsImported++;
            } catch (error) {
              // Ignore tag errors (might be duplicates)
            }
          }
        }
      } catch (error) {
        const err = error as Error;
        this.logger.warn(`Could not import analysis for ${videoId}: ${err.message}`);
      }
    }
  }

  /**
   * Create backup of library.json before migration
   */
  async backupLibrary(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = this.libraryPath.replace('.json', `.backup-${timestamp}.json`);

    await fs.copyFile(this.libraryPath, backupPath);
    this.logger.log(`Created backup at ${backupPath}`);

    return backupPath;
  }
}

// Legacy types (from library.json)

interface LegacyLibrary {
  version: string;
  lastUpdated: string;
  analyses: LegacyAnalysis[];
  clips: Record<string, any>;
}

interface LegacyAnalysis {
  id: string;
  title: string;
  createdAt: string;
  archived: boolean;
  video: {
    originalPath: string;
    currentPath: string;
    clipsWeekFolder?: string;
    filename: string;
    durationSeconds?: number;
    isLinked: boolean;
    lastVerified: string;
  };
  files: {
    analysis: string;
    analysisMetadata: string;
    transcriptSrt: string;
    transcriptTxt: string;
  };
  metadata: {
    analysisModel: string;
    transcriptionModel: string;
    categories: string[];
  };
  clips: string[];
}

interface ParsedAnalysisMetadata {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds?: number;
  sections: {
    timeRange: string;
    startSeconds: number;
    endSeconds?: number;
    category: string;
    description: string;
    quotes: any[];
  }[];
}

export interface MigrationResult {
  videosImported: number;
  transcriptsImported: number;
  analysesImported: number;
  sectionsImported: number;
  tagsImported: number;
  errors: string[];
  duration: number;
}
