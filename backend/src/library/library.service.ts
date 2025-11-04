// clippy/backend/src/library/library.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as lockfile from 'proper-lockfile';
import { v4 as uuidv4 } from 'uuid';
import {
  Library,
  LibraryAnalysis,
  LibraryClip,
  CreateLibraryAnalysisRequest,
  UpdateLibraryAnalysisRequest,
  CreateClipRequest,
} from './interfaces/library.interface';

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);
  private library: Library | null = null;
  private readonly libraryPath: string;
  private readonly libraryDir: string;
  private readonly analysesDir: string;
  private readonly transcriptsDir: string;
  private readonly clipsDir: string;

  constructor() {
    // Set up paths
    this.libraryDir = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'clippy'
    );
    this.libraryPath = path.join(this.libraryDir, 'library.json');
    this.analysesDir = path.join(this.libraryDir, 'analyses');
    this.transcriptsDir = path.join(this.libraryDir, 'transcripts');
    this.clipsDir = path.join(this.libraryDir, 'clips');

    this.logger.log(`Library directory: ${this.libraryDir}`);
  }

  /**
   * Initialize the library (create directories and load library.json)
   */
  async initialize(): Promise<void> {
    try {
      // Create directories if they don't exist
      await fs.mkdir(this.libraryDir, { recursive: true });
      await fs.mkdir(this.analysesDir, { recursive: true });
      await fs.mkdir(this.transcriptsDir, { recursive: true });
      await fs.mkdir(this.clipsDir, { recursive: true });

      // Load library.json or create if it doesn't exist
      if (fsSync.existsSync(this.libraryPath)) {
        await this.loadLibrary();
        this.logger.log('Library loaded successfully');
      } else {
        await this.createEmptyLibrary();
        this.logger.log('Created new empty library');
      }
    } catch (error) {
      this.logger.error(`Failed to initialize library: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Create an empty library structure
   */
  private async createEmptyLibrary(): Promise<void> {
    const emptyLibrary: Library = {
      version: '1.0',
      lastUpdated: new Date().toISOString(),
      analyses: [],
      clips: {},
    };

    this.library = emptyLibrary;
    await this.saveLibrary();
  }

  /**
   * Load library from disk
   */
  private async loadLibrary(): Promise<Library> {
    try {
      const content = await fs.readFile(this.libraryPath, 'utf-8');
      this.library = JSON.parse(content);
      return this.library!;
    } catch (error) {
      this.logger.error(`Failed to load library: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Save library to disk with atomic write and locking
   */
  private async saveLibrary(): Promise<void> {
    if (!this.library) {
      throw new Error('Library not initialized');
    }

    // Use lockfile to ensure atomic writes
    let release: () => Promise<void>;

    try {
      // Acquire lock
      release = await lockfile.lock(this.libraryPath, {
        retries: {
          retries: 5,
          minTimeout: 100,
          maxTimeout: 1000,
        },
        realpath: false,
        fs: {
          ...fsSync,
        } as any,
      });

      // Create backup
      if (fsSync.existsSync(this.libraryPath)) {
        await fs.copyFile(this.libraryPath, `${this.libraryPath}.backup`);
      }

      // Update lastUpdated
      this.library.lastUpdated = new Date().toISOString();

      // Write to temp file first
      const tempPath = `${this.libraryPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(this.library, null, 2), 'utf-8');

      // Atomic rename
      await fs.rename(tempPath, this.libraryPath);

      this.logger.log('Library saved successfully');
    } catch (error) {
      this.logger.error(`Failed to save library: ${(error as Error).message}`);
      throw error;
    } finally {
      // Release lock
      if (release!) {
        await release();
      }
    }
  }

  /**
   * Update library with a modification function
   */
  private async updateLibrary(
    updateFn: (library: Library) => Library
  ): Promise<void> {
    // Reload from disk to get latest version
    await this.loadLibrary();

    if (!this.library) {
      throw new Error('Library not initialized');
    }

    // Apply modification
    this.library = updateFn(this.library);

    // Save
    await this.saveLibrary();
  }

  /**
   * Get all analyses (optionally filtered by archived status)
   */
  async getAnalyses(archived?: boolean): Promise<LibraryAnalysis[]> {
    if (!this.library) {
      await this.initialize();
    }

    if (archived === undefined) {
      return this.library!.analyses;
    }

    return this.library!.analyses.filter(a => a.archived === archived);
  }

  /**
   * Get a single analysis by ID
   */
  async getAnalysis(id: string): Promise<LibraryAnalysis | null> {
    if (!this.library) {
      await this.initialize();
    }

    return this.library!.analyses.find(a => a.id === id) || null;
  }

  /**
   * Create a new analysis in the library
   */
  async createAnalysis(
    request: CreateLibraryAnalysisRequest
  ): Promise<LibraryAnalysis> {
    const analysisId = uuidv4();
    const now = new Date().toISOString();

    // Extract filename from video path
    const filename = path.basename(request.videoPath);

    // Calculate week folder from current date
    const weekFolder = this.calculateWeekFolder(new Date());

    const analysis: LibraryAnalysis = {
      id: analysisId,
      title: request.title,
      createdAt: now,
      archived: false,

      video: {
        originalPath: request.videoPath,
        currentPath: request.videoPath,
        clipsWeekFolder: weekFolder,
        filename: filename,
        durationSeconds: request.durationSeconds,
        isLinked: fsSync.existsSync(request.videoPath),
        lastVerified: now,
      },

      files: {
        analysis: path.join(this.analysesDir, `${analysisId}.txt`),
        analysisMetadata: path.join(this.analysesDir, `${analysisId}.json`),
        transcriptSrt: path.join(this.transcriptsDir, `${analysisId}.srt`),
        transcriptTxt: path.join(this.transcriptsDir, `${analysisId}.txt`),
      },

      metadata: {
        analysisModel: request.analysisModel,
        transcriptionModel: request.transcriptionModel,
        categories: [], // Will be populated by parser
      },

      clips: [],
    };

    // Copy files to library directories
    try {
      // Copy analysis report
      await fs.copyFile(request.analysisReportPath, analysis.files.analysis);

      // Copy transcripts
      await fs.copyFile(request.transcriptSrtPath, analysis.files.transcriptSrt);
      await fs.copyFile(request.transcriptTxtPath, analysis.files.transcriptTxt);

      this.logger.log(`Copied analysis files for ${analysisId}`);
    } catch (error) {
      this.logger.error(`Failed to copy analysis files: ${(error as Error).message}`);
      throw error;
    }

    // Add to library
    await this.updateLibrary((library) => {
      library.analyses.push(analysis);
      return library;
    });

    this.logger.log(`Created analysis ${analysisId}: ${request.title}`);
    return analysis;
  }

  /**
   * Update an existing analysis
   */
  async updateAnalysis(
    id: string,
    update: UpdateLibraryAnalysisRequest
  ): Promise<LibraryAnalysis> {
    let updatedAnalysis: LibraryAnalysis | null = null;

    await this.updateLibrary((library) => {
      const analysisIndex = library.analyses.findIndex(a => a.id === id);

      if (analysisIndex === -1) {
        throw new Error(`Analysis not found: ${id}`);
      }

      const analysis = library.analyses[analysisIndex];

      // Apply updates
      if (update.archived !== undefined) {
        analysis.archived = update.archived;
      }

      if (update.videoCurrentPath !== undefined) {
        analysis.video.currentPath = update.videoCurrentPath;
        analysis.video.lastVerified = new Date().toISOString();
      }

      if (update.videoIsLinked !== undefined) {
        analysis.video.isLinked = update.videoIsLinked;
        analysis.video.lastVerified = new Date().toISOString();
      }

      if (update.clipsWeekFolder !== undefined) {
        analysis.video.clipsWeekFolder = update.clipsWeekFolder;
      }

      library.analyses[analysisIndex] = analysis;
      updatedAnalysis = analysis;

      return library;
    });

    this.logger.log(`Updated analysis ${id}`);
    return updatedAnalysis!;
  }

  /**
   * Delete an analysis
   */
  async deleteAnalysis(id: string): Promise<void> {
    await this.updateLibrary((library) => {
      const analysisIndex = library.analyses.findIndex(a => a.id === id);

      if (analysisIndex === -1) {
        throw new Error(`Analysis not found: ${id}`);
      }

      // Remove associated clips
      const analysis = library.analyses[analysisIndex];
      for (const clipId of analysis.clips) {
        delete library.clips[clipId];
      }

      // Remove analysis
      library.analyses.splice(analysisIndex, 1);

      return library;
    });

    this.logger.log(`Deleted analysis ${id}`);
  }

  /**
   * Get all clips for an analysis
   */
  async getClipsForAnalysis(analysisId: string): Promise<LibraryClip[]> {
    if (!this.library) {
      await this.initialize();
    }

    const analysis = await this.getAnalysis(analysisId);
    if (!analysis) {
      throw new Error(`Analysis not found: ${analysisId}`);
    }

    return analysis.clips.map(clipId => this.library!.clips[clipId]).filter(Boolean);
  }

  /**
   * Get a single clip by ID
   */
  async getClip(id: string): Promise<LibraryClip | null> {
    if (!this.library) {
      await this.initialize();
    }

    return this.library!.clips[id] || null;
  }

  /**
   * Create a new clip
   */
  async createClip(request: CreateClipRequest): Promise<LibraryClip> {
    const clipId = uuidv4();
    const now = new Date().toISOString();

    const clip: LibraryClip = {
      id: clipId,
      analysisId: request.analysisId,
      name: request.name,
      startSeconds: request.startSeconds,
      endSeconds: request.endSeconds,
      outputPath: request.outputPath,
      createdAt: now,
      notes: request.notes || '',
    };

    await this.updateLibrary((library) => {
      // Add clip to clips collection
      library.clips[clipId] = clip;

      // Add clip ID to parent analysis
      const analysis = library.analyses.find(a => a.id === request.analysisId);
      if (analysis) {
        analysis.clips.push(clipId);
      }

      return library;
    });

    this.logger.log(`Created clip ${clipId}: ${request.name}`);
    return clip;
  }

  /**
   * Delete a clip
   */
  async deleteClip(id: string): Promise<void> {
    await this.updateLibrary((library) => {
      const clip = library.clips[id];

      if (!clip) {
        throw new Error(`Clip not found: ${id}`);
      }

      // Remove clip ID from parent analysis
      const analysis = library.analyses.find(a => a.id === clip.analysisId);
      if (analysis) {
        analysis.clips = analysis.clips.filter(clipId => clipId !== id);
      }

      // Remove clip
      delete library.clips[id];

      return library;
    });

    this.logger.log(`Deleted clip ${id}`);
  }

  /**
   * Calculate week folder (Sunday-based) for a given date
   */
  calculateWeekFolder(date: Date): string {
    const d = new Date(date);
    const dayOfWeek = d.getDay(); // 0 = Sunday
    const sunday = new Date(d);
    sunday.setDate(d.getDate() - dayOfWeek);

    // Format as YYYY-MM-DD
    return sunday.toISOString().split('T')[0];
  }

  /**
   * Get library file paths
   */
  getLibraryPaths() {
    return {
      libraryDir: this.libraryDir,
      libraryPath: this.libraryPath,
      analysesDir: this.analysesDir,
      transcriptsDir: this.transcriptsDir,
      clipsDir: this.clipsDir,
    };
  }

  /**
   * Check if library is initialized
   */
  isInitialized(): boolean {
    return this.library !== null;
  }

  /**
   * Get library statistics
   */
  async getStats() {
    if (!this.library) {
      await this.initialize();
    }

    const activeAnalyses = this.library!.analyses.filter(a => !a.archived).length;
    const archivedAnalyses = this.library!.analyses.filter(a => a.archived).length;
    const totalClips = Object.keys(this.library!.clips).length;

    return {
      totalAnalyses: this.library!.analyses.length,
      activeAnalyses,
      archivedAnalyses,
      totalClips,
      lastUpdated: this.library!.lastUpdated,
      version: this.library!.version,
    };
  }
}
