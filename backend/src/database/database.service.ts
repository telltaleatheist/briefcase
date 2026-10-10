import { Injectable, Logger } from '@nestjs/common';
import * as Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ThumbnailService } from './thumbnail.service';
import { migrateAnalysisSectionsRanker } from './ranker-migration';
import { deleteChapterSubtree, migrateChaptersOutline } from './chapter-outline';
import { sweepOrphans } from './orphan-sweep';
import {
  ensureMomentSchema,
  indexPendingTranscripts,
  indexVideoMoments,
  pendingTranscriptCount,
  removeVideoMoments,
} from '../search/transcript-moments';
import { searchMeaning, type Embed, type MeaningSearchResult } from '../search/meaning-search';
import { ensureTitleIndex, searchLibrary, type LibrarySearchOptions, type LibrarySearchResult } from '../search/library-search';

/** Transcripts indexed per background tick (the whole clips library took ~9 s). */
const MOMENT_INDEX_BATCH = 50;

/** Background moment indexing: transcripts left to read, of all, and why it stopped if it did. */
export interface MomentIndexing {
  pending: number;
  total: number;
  error?: string;
}

// Type definitions for database records
export interface VideoRecord {
  id: string;
  filename: string;
  file_hash: string;
  current_path: string;
  upload_date: string | null;
  download_date: string;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  ai_description: string | null;
  source_url: string | null;
  last_verified: string;
  added_at: string;
  is_linked: number;
  media_type: string;
  file_extension: string | null;
  last_processed_date: string | null;
  parent_id: string | null;
  aspect_ratio_fixed: number;
  audio_normalized: number;
  suggested_title?: string | null;
  date_folder?: string | null;
  title?: string | null;
  // Video metadata
  width?: number | null;
  height?: number | null;
  fps?: number | null;
}

export interface VideoRecordWithFlags extends VideoRecord {
  has_transcript: number;
  has_analysis: number;
  has_children: number;
  has_connections: number;
}

export interface TranscriptRecord {
  video_id: string;
  plain_text: string;
  srt_format: string | null;
  whisper_model: string | null;
  language: string | null;
  transcribed_at: string;
  transcription_time_seconds: number | null;
}

export interface AnalysisRecord {
  video_id: string;
  ai_analysis: string;
  summary: string | null;
  sections_count: number | null;
  ai_model: string;
  ai_provider: string | null;
  analyzed_at: string;
  analysis_time_seconds: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  api_calls: number | null;
}

export interface AnalysisSectionRecord {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  timestamp_text: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  source: string;
  /**
   * The flag verifier's answer for this (passage, category): 'flag' when it
   * judged the speaker to be asserting the claim, 'skip' when it judged them to
   * be reporting, quoting, questioning or opposing it.
   *
   * NULL means LEGACY — a row written before verdicts were stored, or by the
   * discovery fallback path, which produces no rejected candidates. Readers
   * treat NULL as 'flag'.
   *
   * 'candidate' (snap engine only): a ranked passage the verify budget did not
   * reach. Never judged by the verifier; stored rather than discarded (plan
   * §5.6), shown only at the All filter position.
   */
  verdict: 'flag' | 'skip' | 'candidate' | null;
  /**
   * The NLI ranker's score for the category this row carries, 0-1. NULL on
   * legacy and discovery rows; readers treat NULL as passing every filter
   * threshold so old data renders unchanged.
   *
   * On a row with ranker = 'snap-v1' this is the snap ranker's per-category
   * span score s_c, not an NLI entailment probability: same column, different
   * scale, told apart by `ranker` (docs/snap-analysis-plan.md §5.6). NULL on
   * 'generate-v1' rows: the model named the passage, nothing scored it.
   */
  nli_score: number | null;
  /**
   * Which ranker produced the row's candidate: 'nli', 'snap-v1',
   * 'generate-v1' (the flags model reading the transcript,
   * analysis/flag-generate.ts), or NULL on legacy/discovery rows (migration
   * 26). Lets readers pick a per-ranker threshold for `nli_score`.
   */
  ranker: string | null;
}

/**
 * One cached answer from the flag verifier, keyed by the QUESTION it answers.
 * See the flag_verdict_cache DDL for why the key is shaped this way.
 */
export interface FlagVerdictCacheRecord {
  question_hash: string;
  category: string;
  verifier_model: string;
  prompt_version: string;
  verdict: 'flag' | 'skip';
  /** The verifier's written justification (prompt v4+); null on a row written before it. */
  reason: string | null;
  created_at: string;
  last_hit_at: string | null;
  hit_count: number;
}

export interface CustomMarkerRecord {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  timestamp_text: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  created_at: string;
  source?: string;
}

export interface MuteSectionRecord {
  id: string;
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  created_at: string;
}

export interface ChapterRecord {
  id: string;
  video_id: string;
  sequence: number;
  start_seconds: number;
  end_seconds: number;
  title: string;
  description: string | null;
  source: string;
  created_at: string;
  /** Outline level, 0 = top (migration 27). NULL on flat/legacy rows: top level. */
  level: number | null;
  /** The parent chapter's id, NULL at top level. */
  parent_id: string | null;
}

export interface TagRecord {
  id: string;
  video_id: string;
  tag_name: string;
  tag_type: string | null;
  confidence: number | null;
  source: string | null;
  created_at: string;
}

export interface MediaRelationshipRecord {
  id: string;
  primary_media_id: string;
  related_media_id: string;
  relationship_type: string;
  created_at: string;
  filename?: string;
  current_path?: string;
  media_type?: string;
  file_extension?: string;
}

/**
 * One OTHER member of a media item's connected group. `id` is the member's
 * video id (there is no single relationship id or direction for a member that
 * may be reachable only transitively). Shaped to match the video columns the
 * inspector's ConnectionsStore already maps (filename / media_type /
 * file_extension).
 */
export interface ConnectedGroupMember {
  id: string;
  filename?: string;
  media_type?: string;
  file_extension?: string;
}

export interface TextContentRecord {
  media_id: string;
  extracted_text: string;
  extraction_method: string | null;
  extracted_at: string;
}

export interface WebArchiveRecord {
  video_id: string;
  original_url: string | null;
  domain: string | null;
  favicon_path: string | null;
  page_title: string | null;
  capture_date: string | null;
  publish_date: string | null;
  capture_method: string | null;
  capture_status: string;
  error_message: string | null;
  text_extracted: number;
}

export interface LibraryAnalyticsRecord {
  id: string;
  library_id: string;
  generated_at: string;
  videos_analyzed_count: number;
  ai_insights: string;
  ai_model: string;
  generation_time_seconds: number | null;
}

export interface TagWithCountRecord {
  tag_name: string;
  tag_type: string;
  count: number;
}

export interface StatsRecord {
  totalVideos: number;
  linkedVideos: number;
  unlinkedVideos: number;
  withTranscripts: number;
  withAnalyses: number;
  totalTags: number;
}

export interface PruneResult {
  deletedCount: number;
  deletedVideos: Array<{ id: string; filename: string }>;
}

/**
 * DatabaseService - Manages SQLite database for the Bulk Analysis Library system
 *
 * This service provides:
 * - Database initialization and schema management
 * - CRUD operations for videos, transcripts, analyses, tags
 * - File hashing for video identification
 *
 * Search lives in search/ (library-search.ts over transcript-moments.ts), on
 * tables this service creates on open.
 */
@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database.Database | null = null;
  /** The open library's background moment indexing, while it has work left. */
  private momentIndexing: MomentIndexing | null = null;
  /** Told when the library's transcript index may have new work (see onTranscriptsIndexed). */
  private readonly transcriptsIndexedListeners = new Set<() => void>();
  private dbPath: string | null = null;
  private readonly appDataPath: string;

  constructor(private readonly thumbnailService: ThumbnailService) {
    // Base directory - cross-platform app data location
    // Mac: ~/Library/Application Support/briefcase
    // Windows: %APPDATA%/briefcase
    // Linux: ~/.config/briefcase
    this.appDataPath = this.getAppDataPath();

    // Ensure directories exist
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }

    this.logger.log('DatabaseService created (not initialized)');
  }

  /**
   * Get cross-platform app data directory
   * Mac: ~/Library/Application Support/briefcase
   * Windows: %APPDATA%/briefcase
   * Linux: ~/.config/briefcase
   *
   * Must match Electron's app.getPath('userData') which comes from
   * package.json name = "briefcase" (lowercase).
   */
  private getAppDataPath(): string {
    const platform = process.platform;
    const appName = 'briefcase';

    if (platform === 'darwin') {
      // macOS
      return path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else if (platform === 'win32') {
      // Windows - use APPDATA environment variable
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, appName);
    } else {
      // Linux and others - use XDG_CONFIG_HOME or fallback to ~/.config
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      return path.join(configHome, appName);
    }
  }

  /**
   * Initialize database connection with a specific database file
   * @param dbPath - Path to the database file (optional, uses default if not provided)
   */
  initializeDatabase(dbPath?: string) {
    // Use provided path or default to .briefcase.db in app data directory
    this.dbPath = dbPath || path.join(this.appDataPath, '.briefcase.db');

    this.logger.log(`Initializing database at: ${this.dbPath}`);

    // Refuse to auto-create a library into an unmounted external volume.
    // On macOS external volumes live under /Volumes/<name>; if that mount root
    // is absent the volume is not mounted and mkdir would silently recreate the
    // tree on the boot disk and open an empty database.
    const volumesMatch = this.dbPath.match(/^(\/Volumes\/[^/]+)(?:\/|$)/);
    if (volumesMatch && !fs.existsSync(volumesMatch[1])) {
      throw new Error(`Library volume not mounted: ${volumesMatch[1]}`);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(this.dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Create or open database (better-sqlite3 handles this automatically)
    const isNew = !fs.existsSync(this.dbPath);
    if (this.db) {
      try {
        this.db.close();
      } catch {}
    }
    this.db = new Database(this.dbPath);
    // Said, not assumed: every cascade into `videos` depends on it, and a
    // connection without it is how the library collected orphans (orphan-sweep.ts).
    this.db.pragma('foreign_keys = ON');

    if (isNew) {
      this.logger.log('Created new database');
    } else {
      this.logger.log('Loaded existing database');
    }

    this.initializeSchema();
    ensureMomentSchema(this.db);
    ensureTitleIndex(this.db);
    const swept = sweepOrphans(this.db);
    if (Object.keys(swept).length > 0) {
      this.logger.warn(`Removed rows whose video is gone: ${Object.entries(swept).map(([table, n]) => `${table} ${n}`).join(', ')}`);
    }
    this.logger.log('Database initialized successfully');

    // Set the library path for thumbnail service
    this.thumbnailService.setLibraryPath(this.dbPath);

    this.indexMomentsInBackground();
    this.notifyTranscriptsIndexed();
  }

  /**
   * Call `listener` whenever the open library's transcript index may hold
   * transcripts that later stages (meaning search's vectors) have not seen: a
   * library opened, the background moment indexing finished, a transcript was
   * saved. Returns the unsubscribe.
   */
  onTranscriptsIndexed(listener: () => void): () => void {
    this.transcriptsIndexedListeners.add(listener);
    return () => this.transcriptsIndexedListeners.delete(listener);
  }

  private notifyTranscriptsIndexed(): void {
    for (const listener of this.transcriptsIndexedListeners) {
      try {
        listener();
      } catch (error) {
        this.logger.error(`[Search] A transcript-index listener failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Fill the transcript moment index (search/transcript-moments.ts) with the
   * transcripts it has not seen, a batch per tick so the server stays
   * responsive, keeping its progress for the search to report. Stops when
   * the library is switched: a batch only ever writes to the handle it
   * started on.
   */
  private indexMomentsInBackground(): void {
    const db = this.db;
    this.momentIndexing = null;
    if (!db) return;
    const counts = pendingTranscriptCount(db);
    if (counts.pending === 0) return;
    const progress: MomentIndexing = { pending: counts.pending, total: counts.total };
    this.momentIndexing = progress;
    this.logger.log(`[Search] Indexing ${counts.pending} transcripts for moment search`);
    const started = Date.now();
    const step = () => {
      if (this.db !== db || !db.open) {
        this.logger.log(`[Search] Library changed; moment indexing stopped with ${progress.pending} transcripts left`);
        return;
      }
      try {
        const n = indexPendingTranscripts(db, MOMENT_INDEX_BATCH);
        progress.pending = n > 0 ? Math.max(0, progress.pending - n) : 0;
        if (n > 0) {
          setTimeout(step, 0);
          return;
        }
        this.logger.log(`[Search] Indexed ${counts.pending} transcripts for moment search in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        this.notifyTranscriptsIndexed();
      } catch (error) {
        progress.error = (error as Error).message;
        this.logger.error(`[Search] Moment indexing stopped with ${progress.pending} transcripts left: ${progress.error}`);
      }
    };
    setTimeout(step, 0);
  }

  /** Scout's expanded search in one video's transcript (search/meaning-search.ts). */
  searchTranscriptMeaning(videoId: string, query: string, embed: Embed): Promise<MeaningSearchResult> {
    return searchMeaning(this.ensureInitialized(), videoId, query, embed);
  }

  /**
   * The library search: titles and transcript moments
   * (search/library-search.ts), with the background indexing's progress
   * while it runs (transcripts not yet read are not searched).
   */
  searchLibrary(query: string, options?: LibrarySearchOptions): LibrarySearchResult & { indexing: MomentIndexing | null } {
    const db = this.ensureInitialized();
    const indexing = this.momentIndexing && this.momentIndexing.pending > 0 ? { ...this.momentIndexing } : null;
    return { ...searchLibrary(db, query, options), indexing };
  }


  /**
   * Close database connection
   */
  closeDatabase(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.logger.log('Database connection closed');
    }
  }

  /**
   * Check if database is initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Get the current database path
   */
  getCurrentDbPath(): string | null {
    return this.dbPath;
  }

  /**
   * Ensure database is initialized (throws error if not)
   */
  private ensureInitialized(): Database.Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initializeDatabase() first or create a library.');
    }
    return this.db;
  }

  /**
   * Convert absolute path to relative path (relative to clips folder)
   * Stores paths relative to enable cross-platform library sharing
   * @param absolutePath - Full absolute path to video file
   * @param clipsFolderPath - Root clips folder path
   * @returns Relative path from clips folder, or absolute path if outside clips folder
   */
  toRelativePath(absolutePath: string, clipsFolderPath: string): string {
    // Check if path is already relative (doesn't start with / or drive letter on Windows)
    if (!path.isAbsolute(absolutePath)) {
      // Already relative - just normalize slashes and return
      return absolutePath.replace(/\\/g, '/');
    }

    // Normalize both paths for comparison
    const normalizedAbsolute = path.normalize(absolutePath);
    const normalizedClipsFolder = path.normalize(clipsFolderPath);

    // Check if path is inside clips folder
    if (normalizedAbsolute.startsWith(normalizedClipsFolder)) {
      // Get relative path from clips folder
      let relativePath = path.relative(normalizedClipsFolder, normalizedAbsolute);

      // CRITICAL: Always use forward slashes for cross-platform compatibility
      // This ensures paths work on both Windows and Unix systems
      // Windows accepts forward slashes, but Unix doesn't accept backslashes
      relativePath = relativePath.replace(/\\/g, '/');

      return relativePath;
    }

    // If outside clips folder, keep absolute (shouldn't happen in normal operation)
    this.logger.warn(`Path outside clips folder: ${absolutePath}`);
    // Still normalize the absolute path to use forward slashes
    return absolutePath.replace(/\\/g, '/');
  }

  /**
   * Convert relative path to absolute path (resolved from clips folder)
   * @param relativePath - Relative path from database
   * @param clipsFolderPath - Root clips folder path
   * @returns Absolute path to video file
   */
  toAbsolutePath(relativePath: string, clipsFolderPath: string): string {
    // If already absolute, return as-is (backward compatibility)
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }

    // Resolve relative path from clips folder
    return path.join(clipsFolderPath, relativePath);
  }

  /**
   * Get the clips folder path for the current database
   * Looks for .library.db location as the clips folder
   * @returns Clips folder path or null if database not initialized
   */
  getClipsFolderPath(): string | null {
    if (!this.dbPath) {
      return null;
    }

    // Database is stored as .library.db in the clips folder
    // So the clips folder is the parent directory of the database file
    return path.dirname(this.dbPath);
  }

  /**
   * Resolve video paths from relative to absolute
   * Modifies the video record in place
   * @param video - Video record to resolve paths for
   */
  private resolveVideoPaths<T extends VideoRecord>(video: T): T {
    const clipsFolder = this.getClipsFolderPath();
    if (!clipsFolder) {
      return video;
    }

    // Resolve current_path from relative to absolute
    if (video.current_path) {
      video.current_path = this.toAbsolutePath(video.current_path, clipsFolder);

      // Normalize path separators: replace backslashes with forward slashes
      // This fixes cross-platform compatibility issues where paths may have been
      // imported from Windows systems or stored with incorrect separators
      video.current_path = video.current_path.replace(/\\/g, '/');
    }

    return video;
  }

  /**
   * Resolve paths for an array of videos
   * @param videos - Array of video records
   */
  private resolveVideoPathsArray<T extends VideoRecord>(videos: T[]): T[] {
    return videos.map(video => this.resolveVideoPaths(video));
  }

  /**
   * Initialize database schema with all tables and indexes
   */
  private initializeSchema() {
    const db = this.ensureInitialized();

    // First, create all tables WITHOUT indexes (in case they exist with old schema)
    const tableSchema = `
      -- Videos table: Core metadata for each video file
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        file_hash TEXT,
        current_path TEXT NOT NULL,
        upload_date TEXT,
        download_date TEXT NOT NULL,
        duration_seconds REAL,
        file_size_bytes INTEGER,
        ai_description TEXT,
        source_url TEXT,
        last_verified TEXT NOT NULL,
        added_at TEXT NOT NULL,
        is_linked INTEGER DEFAULT 1,
        media_type TEXT DEFAULT 'video',
        file_extension TEXT,
        parent_id TEXT,
        aspect_ratio_fixed INTEGER DEFAULT 0,
        audio_normalized INTEGER DEFAULT 0,
        last_processed_date TEXT,
        width INTEGER,
        height INTEGER,
        fps REAL,
        FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
        CHECK (is_linked IN (0, 1)),
        CHECK (aspect_ratio_fixed IN (0, 1)),
        CHECK (audio_normalized IN (0, 1))
      );

      -- Transcripts table: Stores both plain text and SRT format transcripts
      CREATE TABLE IF NOT EXISTS transcripts (
        video_id TEXT PRIMARY KEY,
        plain_text TEXT NOT NULL,
        srt_format TEXT,
        whisper_model TEXT,
        language TEXT,
        transcribed_at TEXT NOT NULL,
        transcription_time_seconds REAL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Analyses table: Analysis reports (AI-generated and user notes)
      CREATE TABLE IF NOT EXISTS analyses (
        video_id TEXT PRIMARY KEY,
        ai_analysis TEXT NOT NULL,
        summary TEXT,
        sections_count INTEGER,
        ai_model TEXT NOT NULL,
        ai_provider TEXT,
        analyzed_at TEXT NOT NULL,
        analysis_time_seconds REAL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Analysis sections: Interesting moments (AI-identified)
      --
      -- verdict / nli_score carry the FLAG PIPELINE's full record, not just its
      -- accepted findings. The ranked path captures every candidate at its
      -- widest setting and asks the verifier about all of them, then stores BOTH
      -- answers: 'flag' for a passage the verifier accepted, 'skip' for one it
      -- rejected (reported / opposed / questioned rather than asserted).
      -- nli_score is the ranker's score for the category the row carries, and it
      -- is what the display filter thresholds on (STRICT >= 0.9, MODERATE >= 0.7,
      -- LOOSE everything including the skips).
      --
      -- BOTH ARE NULLABLE AND NULL MEANS "LEGACY". Rows written before this
      -- change, and rows written by the discovery fallback path (which has no
      -- per-candidate score and no rejected-candidate list), carry NULL in both.
      -- Every reader treats NULL verdict as 'flag' and NULL score as
      -- "passes every threshold", so old libraries render exactly as they did.
      CREATE TABLE IF NOT EXISTS analysis_sections (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        timestamp_text TEXT,
        title TEXT,
        description TEXT,
        category TEXT,
        source TEXT DEFAULT 'ai',
        verdict TEXT,
        nli_score REAL,
        ranker TEXT,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Flag verdict cache: one row per QUESTION the flag verifier has answered.
      --
      -- The question is (passage text, category, stance proposition, verifier
      -- model, prompt identity), hashed into question_hash. The verifier is a
      -- deterministic grader (temperature 0, schema-constrained) asked the same
      -- question over and over across re-runs of the same video, re-analyses
      -- after an interrupted run, and different videos that happen to contain the
      -- same passage. Answering it twice costs ~3s on the 27b and buys nothing.
      --
      -- WHY IT IS KEYED ON THE QUESTION AND NOT ON THE VIDEO. A cache keyed by
      -- (video, window index) is invalidated by anything that shifts window
      -- boundaries — a re-transcribe, a category toggled on, a threshold change —
      -- which is exactly when a re-run happens. Keying on the text of the
      -- question means only the questions that actually CHANGED are re-asked;
      -- the ones whose passage and claim are unchanged are free. It also means
      -- the cache survives a widened capture: the new candidates are new
      -- questions, and every question the previous run already answered is a hit.
      --
      -- The model and the prompt identity are IN the key, not columns checked
      -- afterwards, so switching verifier models or editing the prompt template
      -- (bump FLAG_VERIFICATION_PROMPT_VERSION) produces different keys rather
      -- than silently reusing another grader's answers. They are ALSO stored as
      -- plain columns so a human can read the table and so a stale-model sweep is
      -- a DELETE ... WHERE rather than a full wipe.
      CREATE TABLE IF NOT EXISTS flag_verdict_cache (
        question_hash TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        verifier_model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        last_hit_at TEXT,
        hit_count INTEGER NOT NULL DEFAULT 0
      );

      -- Chapters: Topic/subject-based segments covering entire video timeline
      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        source TEXT DEFAULT 'ai',
        created_at TEXT NOT NULL,
        level INTEGER,
        parent_id TEXT,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Custom markers: User-created markers (separate from AI analysis)
      CREATE TABLE IF NOT EXISTS custom_markers (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        timestamp_text TEXT,
        title TEXT,
        description TEXT,
        category TEXT DEFAULT 'custom',
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Mute sections: Ranges of audio to mute for censoring
      CREATE TABLE IF NOT EXISTS mute_sections (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Tags: AI-generated and manual tags
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        video_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        tag_type TEXT,
        confidence REAL,
        source TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Saved links: Links saved from mobile/web for later processing
      CREATE TABLE IF NOT EXISTS saved_links (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        date_added TEXT NOT NULL,
        date_completed TEXT,
        download_path TEXT,
        thumbnail_path TEXT,
        video_id TEXT,
        error_message TEXT,
        metadata TEXT,
        CHECK (status IN ('pending', 'downloading', 'completed', 'failed')),
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL
      );

      -- Media relationships: Link multiple files together (e.g. PDF + audiobook)
      CREATE TABLE IF NOT EXISTS media_relationships (
        id TEXT PRIMARY KEY,
        primary_media_id TEXT NOT NULL,
        related_media_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (primary_media_id) REFERENCES videos(id) ON DELETE CASCADE,
        FOREIGN KEY (related_media_id) REFERENCES videos(id) ON DELETE CASCADE,
        UNIQUE(primary_media_id, related_media_id)
      );

      -- Web archives: Metadata for archived web pages (MHTML files)
      CREATE TABLE IF NOT EXISTS web_archives (
        video_id TEXT PRIMARY KEY,
        original_url TEXT,
        domain TEXT,
        favicon_path TEXT,
        page_title TEXT,
        capture_date TEXT,
        publish_date TEXT,
        capture_method TEXT,
        capture_status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        text_extracted INTEGER DEFAULT 0,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
        CHECK (capture_status IN ('pending', 'capturing', 'completed', 'failed')),
        CHECK (text_extracted IN (0, 1))
      );

      -- Text content: Extracted text from documents (PDFs, EPUBs, etc.) for searching
      CREATE TABLE IF NOT EXISTS text_content (
        media_id TEXT PRIMARY KEY,
        extracted_text TEXT NOT NULL,
        extraction_method TEXT,
        extracted_at TEXT NOT NULL,
        FOREIGN KEY (media_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      -- Library analytics: Cached AI-generated insights about the entire library
      CREATE TABLE IF NOT EXISTS library_analytics (
        id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        videos_analyzed_count INTEGER NOT NULL,
        ai_insights TEXT NOT NULL,
        ai_model TEXT NOT NULL,
        generation_time_seconds REAL
      );

      -- Video tabs: Named groups/collections for organizing videos (e.g. streaming playlists)
      CREATE TABLE IF NOT EXISTS video_tabs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        display_order INTEGER DEFAULT 0
      );

      -- Video tab items: Junction table for items in tabs (videos, links, etc.)
      CREATE TABLE IF NOT EXISTS video_tab_items (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL,
        video_id TEXT,
        saved_link_id TEXT,
        url TEXT,
        title TEXT,
        item_type TEXT DEFAULT 'video',
        added_at TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        FOREIGN KEY (tab_id) REFERENCES video_tabs(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
        FOREIGN KEY (saved_link_id) REFERENCES saved_links(id) ON DELETE CASCADE
      );
    `;

    // Execute table creation
    db.exec(tableSchema);
    this.logger.log('Database tables created');

    // Run schema migrations for existing databases BEFORE creating indexes
    this.runSchemaMigrations();

    // Now create indexes (after migrations have run)
    const indexSchema = `
      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(file_hash);
      CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);
      CREATE INDEX IF NOT EXISTS idx_videos_download_date ON videos(download_date);
      CREATE INDEX IF NOT EXISTS idx_videos_is_linked ON videos(is_linked);
      CREATE INDEX IF NOT EXISTS idx_videos_parent_id ON videos(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tags_video ON tags(video_id);
      CREATE INDEX IF NOT EXISTS idx_sections_video ON analysis_sections(video_id);
      CREATE INDEX IF NOT EXISTS idx_flag_verdict_cache_model ON flag_verdict_cache(verifier_model, prompt_version);
      CREATE INDEX IF NOT EXISTS idx_custom_markers_video ON custom_markers(video_id);
      CREATE INDEX IF NOT EXISTS idx_mute_sections_video ON mute_sections(video_id);
      CREATE INDEX IF NOT EXISTS idx_saved_links_status ON saved_links(status);
      CREATE INDEX IF NOT EXISTS idx_saved_links_date_added ON saved_links(date_added);
      CREATE INDEX IF NOT EXISTS idx_saved_links_url ON saved_links(url);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_primary ON media_relationships(primary_media_id);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_related ON media_relationships(related_media_id);
      CREATE INDEX IF NOT EXISTS idx_text_content_media ON text_content(media_id);
      CREATE INDEX IF NOT EXISTS idx_web_archives_domain ON web_archives(domain);
      CREATE INDEX IF NOT EXISTS idx_web_archives_capture_date ON web_archives(capture_date);
      CREATE INDEX IF NOT EXISTS idx_web_archives_original_url ON web_archives(original_url);
      CREATE INDEX IF NOT EXISTS idx_library_analytics_library ON library_analytics(library_id);
      CREATE INDEX IF NOT EXISTS idx_library_analytics_generated ON library_analytics(generated_at);
      CREATE INDEX IF NOT EXISTS idx_video_tabs_display_order ON video_tabs(display_order);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_tab ON video_tab_items(tab_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_video ON video_tab_items(video_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_saved_link ON video_tab_items(saved_link_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_display_order ON video_tab_items(display_order);
    `;

    db.exec(indexSchema);
    this.logger.log('Database schema initialized');
  }

  /**
   * Run schema migrations to update existing databases
   */
  private runSchemaMigrations() {
    const db = this.ensureInitialized();

    try {
      // Migration 1: Add added_at column to videos table if it doesn't exist
      db.exec("SELECT added_at FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: added_at')) {
        this.logger.log('Running migration: Adding added_at column to videos table');
        try {
          // Add the column with a default value (use created_at as default for existing records)
          db.exec(`
            ALTER TABLE videos ADD COLUMN added_at TEXT;
            UPDATE videos SET added_at = created_at WHERE added_at IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: added_at column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 2: Add ai_description column to videos table if it doesn't exist
      db.exec("SELECT ai_description FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: ai_description')) {
        this.logger.log('Running migration: Adding ai_description column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN ai_description TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: ai_description column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 3: Add source_url column to videos table if it doesn't exist
      db.exec("SELECT source_url FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: source_url')) {
        this.logger.log('Running migration: Adding source_url column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN source_url TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: source_url column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 4: Add source column to analysis_sections table if it doesn't exist
      db.exec("SELECT source FROM analysis_sections LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: source')) {
        this.logger.log('Running migration: Adding source column to analysis_sections table');
        try {
          db.exec(`
            ALTER TABLE analysis_sections ADD COLUMN source TEXT DEFAULT 'ai';
            UPDATE analysis_sections SET source = 'ai' WHERE source IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: source column added to analysis_sections');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 5: Move custom markers from analysis_sections to custom_markers table
      // Check if custom_markers table exists by querying it
      const stmt = db.prepare("SELECT COUNT(*) as count FROM custom_markers");
      const result = stmt.get() as any;

      // If table exists and is empty, check for custom markers in analysis_sections
      if (result.count === 0) {
        const checkStmt = db.prepare("SELECT COUNT(*) as count FROM analysis_sections WHERE source = 'user' OR category = 'custom'");
        const checkResult = checkStmt.get() as any;

        if (checkResult.count > 0) {
          this.logger.log(`Running migration: Moving ${checkResult.count} custom markers from analysis_sections to custom_markers table`);
          try {
            db.exec(`
              INSERT INTO custom_markers (id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, created_at)
              SELECT id, video_id, start_seconds, end_seconds, timestamp_text, title, description,
                     COALESCE(category, 'custom') as category,
                     COALESCE((SELECT created_at FROM videos WHERE id = video_id), datetime('now')) as created_at
              FROM analysis_sections
              WHERE source = 'user' OR category = 'custom';

              DELETE FROM analysis_sections WHERE source = 'user' OR category = 'custom';
            `);
            this.saveDatabase();
            this.logger.log(`Migration complete: Moved ${checkResult.count} custom markers to custom_markers table`);
          } catch (migrationError: any) {
            // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
          }
        }
      }
    } catch (error: any) {
      // Table might not exist yet (new installation) - silently ignore.
      // Any other error (including an aborted migration re-thrown above) must
      // propagate so startup fails loudly instead of running on a broken schema.
      if (!error.message || !error.message.includes('no such table')) {
        throw error;
      }
    }

    try {
      // Migration 6: Add media_type column to videos table if it doesn't exist
      db.exec("SELECT media_type FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: media_type')) {
        this.logger.log('Running migration: Adding media_type column to videos table');
        try {
          // Add the column with default value 'video' for existing records
          db.exec(`
            ALTER TABLE videos ADD COLUMN media_type TEXT DEFAULT 'video';
            UPDATE videos SET media_type = 'video' WHERE media_type IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: media_type column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 7: Add file_extension column to videos table if it doesn't exist
      db.exec("SELECT file_extension FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: file_extension')) {
        this.logger.log('Running migration: Adding file_extension column to videos table');
        try {
          // Add the column and populate from filename
          db.exec(`
            ALTER TABLE videos ADD COLUMN file_extension TEXT;
          `);
          // Update existing records to extract extension from filename
          const stmt = db.prepare('SELECT id, filename FROM videos');
          const rows = stmt.all() as any[];

          // Apply updates
          const updateStmt = db.prepare('UPDATE videos SET file_extension = ? WHERE id = ?');
          for (const row of rows) {
            const dotIndex = row.filename.lastIndexOf('.');
            const ext = dotIndex === -1 ? null : row.filename.substring(dotIndex).toLowerCase();
            updateStmt.run(ext, row.id);
          }

          this.saveDatabase();
          this.logger.log('Migration complete: file_extension column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 8: Add parent_id column to videos table if it doesn't exist
      db.exec("SELECT parent_id FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: parent_id')) {
        this.logger.log('Running migration: Adding parent_id column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN parent_id TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: parent_id column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 9: Check if we need to add created_at column (old databases might have this instead of upload_date)
    // Check table schema to see which columns exist
    let hasCreatedAt = false;
    let hasUploadDate = false;
    let hasDownloadDate = false;

    try {
      const stmt = db.prepare("PRAGMA table_info(videos)");
      const rows = stmt.all() as any[];
      const columns = rows.map(row => row.name);

      hasCreatedAt = columns.includes('created_at');
      hasUploadDate = columns.includes('upload_date');
      hasDownloadDate = columns.includes('download_date');

      this.logger.log(`Migration check: hasCreatedAt=${hasCreatedAt}, hasUploadDate=${hasUploadDate}, hasDownloadDate=${hasDownloadDate}`);
    } catch (error: any) {
      this.logger.warn(`Could not check table schema: ${error?.message || 'Unknown error'}`);
    }

    // If we have created_at but not upload_date/download_date, we need to migrate
    if (hasCreatedAt && (!hasUploadDate || !hasDownloadDate)) {
      this.logger.log('Running migration: Renaming created_at to upload_date and adding download_date');
      try {
        // SQLite doesn't support column renaming directly, so we need to recreate the table.
        // This is DESTRUCTIVE (it DROPs the videos table partway through), so it MUST be
        // atomic: run it inside a transaction. If any statement fails, better-sqlite3 rolls
        // the whole thing back, leaving the original videos table fully intact.
        //
        // Foreign keys are OFF around it (SQLite's documented table-rebuild
        // procedure; the pragma cannot change inside a transaction): with
        // them on, DROP TABLE videos is an implicit DELETE that CASCADES, and
        // would empty every transcript, analysis and tag in the library. The
        // check before commit proves every child still points at a video.
        db.pragma('foreign_keys = OFF');
        // Orphans already there are the sweep's to remove (after the schema
        // is up), not a reason to refuse the migration.
        const brokenBefore = (db.pragma('foreign_key_check') as unknown[]).length;
        const rebuildVideosTable = db.transaction(() => {
          db.exec(`
          -- Create new table with updated schema
          CREATE TABLE videos_new (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            file_hash TEXT,
            current_path TEXT NOT NULL,
            upload_date TEXT,
            download_date TEXT NOT NULL,
            duration_seconds REAL,
            file_size_bytes INTEGER,
            ai_description TEXT,
            source_url TEXT,
            last_verified TEXT NOT NULL,
            added_at TEXT NOT NULL,
            is_linked INTEGER DEFAULT 1,
            media_type TEXT DEFAULT 'video',
            file_extension TEXT,
            parent_id TEXT,
            FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
            CHECK (is_linked IN (0, 1))
          );

          -- Copy data from old table to new table
          INSERT INTO videos_new (
            id, filename, file_hash, current_path, upload_date, download_date,
            duration_seconds, file_size_bytes, ai_description, source_url,
            last_verified, added_at, is_linked, media_type, file_extension, parent_id
          )
          SELECT
            id, filename, file_hash, current_path,
            created_at as upload_date,
            added_at as download_date,
            duration_seconds, file_size_bytes, ai_description, source_url,
            last_verified, added_at, is_linked, media_type, file_extension, NULL as parent_id
          FROM videos;

          -- Drop old table
          DROP TABLE videos;

          -- Rename new table to videos
          ALTER TABLE videos_new RENAME TO videos;
        `);
          const broken = (db.pragma('foreign_key_check') as unknown[]).length;
          if (broken > brokenBefore) throw new Error(`the rebuilt videos table leaves ${broken - brokenBefore} more rows pointing at no video`);
        });
        try {
          rebuildVideosTable();
        } finally {
          db.pragma('foreign_keys = ON');
        }

        this.saveDatabase();
        this.logger.log('Migration complete: Renamed created_at to upload_date and added download_date');
      } catch (migrationError: any) {
        // A failure here means the videos table may have been dropped/half-rebuilt.
        // The transaction has already rolled back, so the DB is intact — but we must
        // NOT swallow this and continue running against a schema we couldn't migrate.
        // Fail loudly so startup aborts and the problem is visible.
        this.logger.error(`Destructive videos-table migration failed and was rolled back: ${migrationError?.message || 'Unknown error'}`);
        throw migrationError;
      }
    }

    try {
      // Migration 10: Add suggested_title column to videos table if it doesn't exist
      db.exec("SELECT suggested_title FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: suggested_title')) {
        this.logger.log('Running migration: Adding suggested_title column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN suggested_title TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: suggested_title column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 11: Add transcription_time_seconds column to transcripts table if it doesn't exist
      db.exec("SELECT transcription_time_seconds FROM transcripts LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: transcription_time_seconds')) {
        this.logger.log('Running migration: Adding transcription_time_seconds column to transcripts table');
        try {
          db.exec(`
            ALTER TABLE transcripts ADD COLUMN transcription_time_seconds REAL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: transcription_time_seconds column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 12: Add analysis_time_seconds column to analyses table if it doesn't exist
      db.exec("SELECT analysis_time_seconds FROM analyses LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: analysis_time_seconds')) {
        this.logger.log('Running migration: Adding analysis_time_seconds column to analyses table');
        try {
          db.exec(`
            ALTER TABLE analyses ADD COLUMN analysis_time_seconds REAL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: analysis_time_seconds column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 13: Add has_transcript column to videos table if it doesn't exist
      db.exec("SELECT has_transcript FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: has_transcript')) {
        this.logger.log('Running migration: Adding has_transcript column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN has_transcript INTEGER DEFAULT 0;
          `);
          // Update existing rows based on whether they have transcripts
          db.exec(`
            UPDATE videos
            SET has_transcript = CASE
              WHEN EXISTS (SELECT 1 FROM transcripts WHERE video_id = videos.id) THEN 1
              ELSE 0
            END;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: has_transcript column added and populated');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 14: Add has_analysis column to videos table if it doesn't exist
      db.exec("SELECT has_analysis FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: has_analysis')) {
        this.logger.log('Running migration: Adding has_analysis column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN has_analysis INTEGER DEFAULT 0;
          `);
          // Update existing rows based on whether they have analyses
          db.exec(`
            UPDATE videos
            SET has_analysis = CASE
              WHEN EXISTS (SELECT 1 FROM analyses WHERE video_id = videos.id) THEN 1
              ELSE 0
            END;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: has_analysis column added and populated');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 15: Add aspect_ratio_fixed column to videos table if it doesn't exist
      db.exec("SELECT aspect_ratio_fixed FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: aspect_ratio_fixed')) {
        this.logger.log('Running migration: Adding aspect_ratio_fixed column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN aspect_ratio_fixed INTEGER DEFAULT 0;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: aspect_ratio_fixed column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 16: Add audio_normalized column to videos table if it doesn't exist
      db.exec("SELECT audio_normalized FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: audio_normalized')) {
        this.logger.log('Running migration: Adding audio_normalized column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN audio_normalized INTEGER DEFAULT 0;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: audio_normalized column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 17: Add last_processed_date column to videos table if it doesn't exist
      db.exec("SELECT last_processed_date FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: last_processed_date')) {
        this.logger.log('Running migration: Adding last_processed_date column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN last_processed_date TEXT;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: last_processed_date column added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    try {
      // Migration 18: Create video_relationships junction table for many-to-many parent-child relationships
      db.exec("SELECT * FROM video_relationships LIMIT 1");
      // If we get here without error, table exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such table: video_relationships')) {
        this.logger.log('Running migration: Creating video_relationships junction table');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS video_relationships (
              id TEXT PRIMARY KEY,
              parent_id TEXT NOT NULL,
              child_id TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
              FOREIGN KEY (child_id) REFERENCES videos(id) ON DELETE CASCADE,
              UNIQUE (parent_id, child_id)
            );

            CREATE INDEX IF NOT EXISTS idx_video_relationships_parent ON video_relationships(parent_id);
            CREATE INDEX IF NOT EXISTS idx_video_relationships_child ON video_relationships(child_id);
          `);

          // Migrate existing parent_id data to the junction table
          const existingRelationships = db.prepare(`
            SELECT id, parent_id FROM videos WHERE parent_id IS NOT NULL
          `).all() as any[];

          if (existingRelationships.length > 0) {
            this.logger.log(`Migrating ${existingRelationships.length} existing parent-child relationships`);
            const insertStmt = db.prepare(`
              INSERT INTO video_relationships (id, parent_id, child_id, created_at)
              VALUES (?, ?, ?, ?)
            `);

            const { v4: uuidv4 } = require('uuid');
            for (const rel of existingRelationships) {
              insertStmt.run(
                uuidv4(),
                rel.parent_id,
                rel.id,
                new Date().toISOString()
              );
            }
          }

          this.saveDatabase();
          this.logger.log('Migration complete: video_relationships table created and existing data migrated');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 19: Backfill undirected connections (media_relationships) from
    // parent/child pairs (video_relationships). Idempotent — the NOT EXISTS
    // guard checks both directions, so this is safe to run on every startup.
    try {
      const result = db.prepare(`
        INSERT INTO media_relationships (id, primary_media_id, related_media_id, relationship_type, created_at)
        SELECT lower(hex(randomblob(16))), vr.parent_id, vr.child_id, 'connected', vr.created_at
        FROM video_relationships vr
        WHERE NOT EXISTS (
          SELECT 1 FROM media_relationships mr
          WHERE (mr.primary_media_id = vr.parent_id AND mr.related_media_id = vr.child_id)
             OR (mr.primary_media_id = vr.child_id AND mr.related_media_id = vr.parent_id)
        )
      `).run();
      if (result.changes > 0) {
        this.saveDatabase();
        this.logger.log(`Migration: backfilled ${result.changes} connections from parent/child relationships`);
      }
    } catch (migrationError: any) {
      this.logger.error(`Connections backfill migration failed: ${migrationError?.message || 'Unknown error'}`);
    }

    // Migration: Recreate video_tab_items to allow nullable video_id and add new columns
    // This is needed because SQLite doesn't allow changing NOT NULL constraints
    try {
      // Check if video_id is nullable by trying to insert a NULL and rolling back
      const testStmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='video_tab_items'");
      const tableInfo = testStmt.get() as { sql: string } | undefined;

      if (tableInfo && tableInfo.sql && tableInfo.sql.includes('video_id TEXT NOT NULL')) {
        this.logger.log('Running migration: Recreating video_tab_items to support multiple item types');
        try {
          // Destructive (DROPs video_tab_items partway through), so it must be
          // atomic: on any failure better-sqlite3 rolls back and leaves the
          // original table intact.
          const rebuildTabItemsTable = db.transaction(() => {
            db.exec(`
            -- Create new table with correct schema
            CREATE TABLE video_tab_items_new (
              id TEXT PRIMARY KEY,
              tab_id TEXT NOT NULL,
              video_id TEXT,
              saved_link_id TEXT,
              url TEXT,
              title TEXT,
              item_type TEXT DEFAULT 'video',
              added_at TEXT NOT NULL,
              display_order INTEGER DEFAULT 0,
              FOREIGN KEY (tab_id) REFERENCES video_tabs(id) ON DELETE CASCADE,
              FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
              FOREIGN KEY (saved_link_id) REFERENCES saved_links(id) ON DELETE CASCADE
            );

            -- Copy existing data
            INSERT INTO video_tab_items_new (id, tab_id, video_id, added_at, display_order, item_type)
            SELECT id, tab_id, video_id, added_at, display_order, 'video'
            FROM video_tab_items;

            -- Drop old table
            DROP TABLE video_tab_items;

            -- Rename new table
            ALTER TABLE video_tab_items_new RENAME TO video_tab_items;

            -- Recreate indexes
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_tab ON video_tab_items(tab_id);
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_video ON video_tab_items(video_id);
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_saved_link ON video_tab_items(saved_link_id);
            CREATE INDEX IF NOT EXISTS idx_video_tab_items_display_order ON video_tab_items(display_order);
          `);
          });
          rebuildTabItemsTable();
          this.saveDatabase();
          this.logger.log('Migration complete: video_tab_items now supports multiple item types');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      } else if (tableInfo && tableInfo.sql && !tableInfo.sql.includes('item_type')) {
        // Table exists with nullable video_id but missing new columns
        this.logger.log('Running migration: Adding flexible item type columns to video_tab_items');
        try {
          db.exec(`
            ALTER TABLE video_tab_items ADD COLUMN item_type TEXT DEFAULT 'video';
            ALTER TABLE video_tab_items ADD COLUMN saved_link_id TEXT;
            ALTER TABLE video_tab_items ADD COLUMN url TEXT;
            ALTER TABLE video_tab_items ADD COLUMN title TEXT;
            UPDATE video_tab_items SET item_type = 'video' WHERE item_type IS NULL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: Added item_type columns');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    } catch (error: any) {
      // A brand-new library without the table yet is benign; anything else
      // (including an aborted migration re-thrown above) must propagate.
      if (error.message && error.message.includes('no such table')) {
        this.logger.error(`Error checking video_tab_items schema: ${error?.message}`);
      } else {
        throw error;
      }
    }

    // Migration: Enforce one row per (tab_id, video_id) so addVideoToTab's
    // UNIQUE-constraint dedup actually fires. Dedup any pre-existing rows first,
    // then create the partial unique index (video_id is NULL for link items).
    try {
      const dedupeTabItems = db.transaction(() => {
        db.exec(`
          DELETE FROM video_tab_items
          WHERE video_id IS NOT NULL
            AND rowid NOT IN (
              SELECT MIN(rowid) FROM video_tab_items
              WHERE video_id IS NOT NULL
              GROUP BY tab_id, video_id
            );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_video_tab_items_unique
            ON video_tab_items(tab_id, video_id)
            WHERE video_id IS NOT NULL;
        `);
      });
      dedupeTabItems();
    } catch (error: any) {
      if (!error.message || !error.message.includes('no such table')) {
        throw error;
      }
    }

    // Migration 20: Add width, height, fps columns to videos table
    try {
      db.exec("SELECT width FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: width')) {
        this.logger.log('Running migration: Adding video metadata columns (width, height, fps) to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN width INTEGER;
            ALTER TABLE videos ADD COLUMN height INTEGER;
            ALTER TABLE videos ADD COLUMN fps REAL;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: width, height, fps columns added');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 20b: Add needs_metadata flag to videos table.
    // Set when ffprobe failed during import (fallback audit #12) so
    // half-populated records are identifiable and retryable instead of
    // silently carrying NULL duration/width/height forever.
    try {
      db.exec("SELECT needs_metadata FROM videos LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: needs_metadata')) {
        this.logger.log('Running migration: Adding needs_metadata column to videos table');
        try {
          db.exec(`
            ALTER TABLE videos ADD COLUMN needs_metadata INTEGER DEFAULT 0;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: needs_metadata column added');
        } catch (migrationError: any) {
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 21: Create custom_instructions_history table
    try {
      db.exec("SELECT 1 FROM custom_instructions_history LIMIT 1");
      // Table exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such table')) {
        this.logger.log('Running migration: Creating custom_instructions_history table');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS custom_instructions_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              instruction_text TEXT NOT NULL,
              used_at TEXT NOT NULL,
              use_count INTEGER DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_instructions_used_at ON custom_instructions_history(used_at DESC);
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: custom_instructions_history table created');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration 22: Add token stats columns to analyses table
    try {
      db.exec("SELECT input_tokens FROM analyses LIMIT 1");
      // If we get here without error, column exists
    } catch (error: any) {
      if (error.message && error.message.includes('no such column: input_tokens')) {
        this.logger.log('Running migration: Adding token stats columns to analyses table');
        try {
          db.exec(`
            ALTER TABLE analyses ADD COLUMN input_tokens INTEGER;
            ALTER TABLE analyses ADD COLUMN output_tokens INTEGER;
            ALTER TABLE analyses ADD COLUMN total_tokens INTEGER;
            ALTER TABLE analyses ADD COLUMN estimated_cost REAL;
            ALTER TABLE analyses ADD COLUMN api_calls INTEGER;
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: token stats columns added to analyses table');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    }

    // Migration: the old video-level search is gone (2026-10-09; search/ replaced
    // it). Its hand-kept FTS5 mirrors and the transcripts' soundex column held a
    // second copy of every transcript; drop them. Idempotent, so it runs on
    // every open and costs nothing once done. A failure aborts the load, as
    // every migration here does.
    try {
      db.exec(`
        DROP TABLE IF EXISTS videos_fts;
        DROP TABLE IF EXISTS transcripts_fts;
        DROP TABLE IF EXISTS transcripts_soundex_fts;
        DROP TABLE IF EXISTS analyses_fts;
        DROP TABLE IF EXISTS tags_fts;
      `);
      const hasSoundex = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('transcripts') WHERE name = 'soundex_content'`).get() as { n: number }).n > 0;
      if (hasSoundex) {
        this.logger.log('Running migration: removing the old search index (FTS mirrors, transcripts.soundex_content)');
        db.exec(`ALTER TABLE transcripts DROP COLUMN soundex_content`);
      }
    } catch (migrationError: any) {
      throw new Error(
        `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
        `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
        `Check that the library volume is mounted and writable, then reopen the library.`,
      );
    }

    // Migration 23: Create web_archives table for archived web pages
    try {
      const waCheck = db.prepare(`
        SELECT COUNT(*) as count FROM sqlite_master
        WHERE type='table' AND name='web_archives'
      `).get() as { count: number };

      if (waCheck.count === 0) {
        this.logger.log('Running migration: Creating web_archives table');
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS web_archives (
              video_id TEXT PRIMARY KEY,
              original_url TEXT,
              domain TEXT,
              favicon_path TEXT,
              page_title TEXT,
              capture_date TEXT,
              publish_date TEXT,
              capture_method TEXT,
              capture_status TEXT NOT NULL DEFAULT 'completed',
              error_message TEXT,
              text_extracted INTEGER DEFAULT 0,
              FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
              CHECK (capture_status IN ('pending', 'capturing', 'completed', 'failed')),
              CHECK (text_extracted IN (0, 1))
            );
            CREATE INDEX IF NOT EXISTS idx_web_archives_domain ON web_archives(domain);
            CREATE INDEX IF NOT EXISTS idx_web_archives_capture_date ON web_archives(capture_date);
            CREATE INDEX IF NOT EXISTS idx_web_archives_original_url ON web_archives(original_url);
          `);
          this.saveDatabase();
          this.logger.log('Migration complete: web_archives table created');
        } catch (migrationError: any) {
          // Fallback audit #6: a half-migrated schema corrupts every later
          // write to the missing column. Abort the library load loudly —
          // the log line above names the migration that failed.
          throw new Error(
            `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
            `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
            `Check that the library volume is mounted and writable, then reopen the library.`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Error checking web_archives table: ${error?.message || 'Unknown error'}`);
    }

    // Migration 24: Add verdict + nli_score to analysis_sections.
    //
    // The flag pipeline now stores EVERY verifier verdict, not only the accepted
    // ones, so a section row has to say which it is and what the ranker scored.
    //
    // BOTH COLUMNS ARE DELIBERATELY LEFT NULL FOR EXISTING ROWS — no backfill,
    // no DEFAULT. A legacy row was written by a pipeline that only ever stored
    // accepted findings, so its verdict IS 'flag'; but writing that in would be
    // asserting a score it never had, and every reader already reads NULL as
    // "legacy: treat as flag, passes every filter". Backfilling would buy
    // nothing and would make it impossible to tell a real 'flag' verdict from an
    // inferred one. Migration 4 above is the pattern this follows: probe the
    // column with a SELECT, ALTER on 'no such column'.
    for (const column of ['verdict TEXT', 'nli_score REAL']) {
      const name = column.split(' ')[0];
      try {
        db.exec(`SELECT ${name} FROM analysis_sections LIMIT 1`);
      } catch (error: any) {
        if (error?.message && error.message.includes(`no such column: ${name}`)) {
          this.logger.log(`Running migration: Adding ${name} column to analysis_sections table`);
          try {
            db.exec(`ALTER TABLE analysis_sections ADD COLUMN ${column};`);
            this.saveDatabase();
            this.logger.log(`Migration complete: ${name} column added to analysis_sections`);
          } catch (migrationError: any) {
            // Fallback audit #6: a half-migrated schema corrupts every later
            // write to the missing column. Abort the library load loudly —
            // the log line above names the migration that failed.
            throw new Error(
              `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
              `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
              `Check that the library volume is mounted and writable, then reopen the library.`,
            );
          }
        } else {
          // 'no such table' on a brand-new database, which initializeSchema has
          // already created with both columns present. Anything else propagates.
          if (!error?.message || !error.message.includes('no such table')) throw error;
        }
      }
    }

    // Migration 25: Create flag_verdict_cache.
    //
    // No probe/ALTER pair here because there is nothing to migrate: the table is
    // created unconditionally by initializeSchema's CREATE TABLE IF NOT EXISTS,
    // which runs on every open, so an existing library picks it up empty on the
    // next load. This comment exists so the next person looking for "where does
    // flag_verdict_cache get created for old libraries" stops here.

    // Migration 26: Add ranker to analysis_sections, with its backfill, in one
    // transaction (see ranker-migration.ts for why both matter).
    try {
      if (migrateAnalysisSectionsRanker(db)) {
        this.saveDatabase();
        this.logger.log('Migration complete: ranker column added to analysis_sections');
      }
    } catch (migrationError: any) {
      // Fallback audit #6: a half-migrated schema corrupts every later write
      // to the missing column. Abort the library load loudly.
      throw new Error(
        `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
        `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
        `Check that the library volume is mounted and writable, then reopen the library.`,
      );
    }

    // Migration 27: chapters.level + chapters.parent_id (the chapter outline;
    // see chapter-outline.ts). Additive and nullable: old rows are top level.
    try {
      if (migrateChaptersOutline(db)) {
        this.saveDatabase();
        this.logger.log('Migration complete: level and parent_id columns added to chapters');
      }
    } catch (migrationError: any) {
      throw new Error(
        `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
        `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
        `Check that the library volume is mounted and writable, then reopen the library.`,
      );
    }

    // Migration 28: flag_verdict_cache.reason, the verifier's written
    // justification (prompt v4). Additive and nullable: a row from an older
    // prompt has none, and its hash (which carries the prompt version) is never
    // asked for again.
    try {
      const columns = db.prepare('PRAGMA table_info(flag_verdict_cache)').all() as Array<{ name: string }>;
      if (columns.length > 0 && !columns.some((c) => c.name === 'reason')) {
        db.exec('ALTER TABLE flag_verdict_cache ADD COLUMN reason TEXT');
        this.saveDatabase();
        this.logger.log('Migration complete: reason column added to flag_verdict_cache');
      }
    } catch (migrationError: any) {
      throw new Error(
        `Library database migration failed: ${migrationError?.message || 'Unknown error'}. ` +
        `Loading was aborted because continuing with an out-of-date schema would corrupt data. ` +
        `Check that the library volume is mounted and writable, then reopen the library.`,
      );
    }

  }

  /**
   * Get the database instance for raw queries
   */
  getDatabase(): Database.Database {
    return this.ensureInitialized();
  }

  /**
   * Save the database to disk
   * Note: better-sqlite3 is synchronous and auto-commits, so this is a no-op
   * Kept for API compatibility with sql.js version
   */
  private saveDatabase() {
    // No-op: better-sqlite3 is synchronous and auto-commits
    // All changes are immediately persisted to disk
  }

  /**
   * Save the database to disk
   * Expose this publicly for services that need to save after raw queries
   */
  saveDatabaseToDisk() {
    this.saveDatabase();
  }

  /**
   * Flush any pending WAL frames into the main database file so an external
   * file-copy backup captures a consistent, fully-checkpointed database.
   * No-op when the DB is closed or not in WAL journal mode.
   */
  checkpointWal(): void {
    if (!this.db) {
      return;
    }
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error: any) {
      this.logger.warn(`WAL checkpoint failed: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Canonical file_hash: SHA-256 of the file size plus 1MB samples taken from
   * the beginning, middle, and end (whole file when it is small). This is the
   * single algorithm used everywhere file_hash is written or compared —
   * FileScannerService.quickHashFile and RelinkingService.quickHashFile
   * delegate here so scan-added and import-added videos share one identity.
   *
   * @param filePath - Absolute path to the media file
   * @param fileSize - Optional pre-computed size; stat'd from disk when omitted
   * @returns SHA-256 hash string
   */
  async hashFile(filePath: string, fileSize?: number): Promise<string> {
    const size = fileSize ?? fs.statSync(filePath).size;
    const SAMPLE_SIZE = 1024 * 1024; // 1MB sample
    const hash = crypto.createHash('sha256');

    hash.update(size.toString());

    if (size <= SAMPLE_SIZE * 3) {
      // Small file - hash the whole thing
      hash.update(fs.readFileSync(filePath));
    } else {
      // Large file - sample beginning, middle, and end
      const sampleSize = Math.min(SAMPLE_SIZE, Math.floor(size / 3));
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(sampleSize);
        fs.readSync(fd, buffer, 0, sampleSize, 0);
        hash.update(buffer);
        fs.readSync(fd, buffer, 0, sampleSize, Math.floor(size / 2) - Math.floor(sampleSize / 2));
        hash.update(buffer);
        fs.readSync(fd, buffer, 0, sampleSize, size - sampleSize);
        hash.update(buffer);
      } finally {
        fs.closeSync(fd);
      }
    }

    return hash.digest('hex');
  }

  /**
   * Insert a new video/media record
   */
  insertVideo(video: {
    id: string;
    filename: string;
    fileHash: string;
    currentPath: string;
    uploadDate?: string; // Date from filename - when content was created/filmed
    durationSeconds?: number;
    fileSizeBytes?: number;
    sourceUrl?: string;
    mediaType?: string;
    fileExtension?: string;
    downloadDate?: string; // File's creation timestamp (when you downloaded it)
    width?: number;
    height?: number;
    fps?: number;
    /** True when ffprobe failed at import time — record is half-populated and retryable. */
    needsMetadata?: boolean;
  }): { inserted: boolean; existingId?: string } {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();
    const downloadDate = video.downloadDate || now;

    // Convert to relative path for cross-platform compatibility
    const clipsFolder = this.getClipsFolderPath();
    const pathToStore = clipsFolder ? this.toRelativePath(video.currentPath, clipsFolder) : video.currentPath;

    // Determine media type from file extension if not provided
    let mediaType = video.mediaType;
    let fileExtension = video.fileExtension;

    if (!fileExtension && video.filename) {
      const dotIndex = video.filename.lastIndexOf('.');
      fileExtension = dotIndex === -1 ? undefined : video.filename.substring(dotIndex).toLowerCase();
    }

    if (!mediaType && fileExtension) {
      mediaType = this.getMediaTypeFromExtension(fileExtension);
    }

    // The dedup check and the insert run inside one synchronous transaction so
    // concurrent imports of the same file can never both pass the "not in DB"
    // check and double-insert.
    const insertVideoTxn = db.transaction((): { inserted: boolean; existingId?: string } => {
      // Check for existing video by hash (most reliable - same content)
      if (video.fileHash) {
        const existingByHash = db.prepare(
          `SELECT id FROM videos WHERE file_hash = ? LIMIT 1`
        ).get(video.fileHash) as { id: string } | undefined;

        if (existingByHash) {
          this.logger.warn(`Duplicate detected by hash: ${video.filename} matches existing ${existingByHash.id}`);
          return { inserted: false, existingId: existingByHash.id };
        }
      }

      // Check for existing video by filename (fallback)
      const existingByFilename = db.prepare(
        `SELECT id FROM videos WHERE filename = ? LIMIT 1`
      ).get(video.filename) as { id: string } | undefined;

      if (existingByFilename) {
        this.logger.warn(`Duplicate detected by filename: ${video.filename} matches existing ${existingByFilename.id}`);
        return { inserted: false, existingId: existingByFilename.id };
      }

      db.prepare(
        `INSERT OR REPLACE INTO videos (
          id, filename, file_hash, current_path, upload_date,
          duration_seconds, file_size_bytes, source_url, media_type, file_extension,
          download_date, last_verified, added_at, is_linked, width, height, fps,
          needs_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      ).run(
        video.id,
        video.filename,
        video.fileHash,
        pathToStore,
        video.uploadDate || null,
        video.durationSeconds || null,
        video.fileSizeBytes || null,
        video.sourceUrl || null,
        mediaType || 'video',
        fileExtension || null,
        downloadDate, // File's creation timestamp (when you downloaded it)
        now, // last_verified
        now, // added_at (when database entry was created)
        video.width || null,
        video.height || null,
        video.fps || null,
        video.needsMetadata ? 1 : 0
      );

      return { inserted: true };
    });
    const result = insertVideoTxn();

    this.saveDatabase();
    return result;
  }

  /**
   * Helper to determine media type from file extension
   */
  private getMediaTypeFromExtension(extension: string): string {
    const ext = extension.toLowerCase();

    // Video extensions
    if (['.mov', '.mp4', '.avi', '.mkv', '.webm', '.m4v', '.flv'].includes(ext)) {
      return 'video';
    }

    // Audio extensions
    if (['.mp3', '.m4a', '.m4b', '.aac', '.flac', '.wav', '.ogg'].includes(ext)) {
      return 'audio';
    }

    // Document extensions
    if (['.pdf', '.epub', '.mobi', '.txt', '.md'].includes(ext)) {
      return 'document';
    }

    // Image extensions
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      return 'image';
    }

    // Web archive extensions
    if (['.html', '.htm', '.mhtml'].includes(ext)) {
      return 'webpage';
    }

    return 'video'; // default to video for unknown types
  }

  /**
   * Find video by filename
   */
  findVideoByFilename(filename: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE filename = ?');
    const result = stmt.get(filename) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Find video by file hash
   */
  findVideoByHash(hash: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE file_hash = ?');
    const result = stmt.get(hash) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Find video by source URL
   */
  findVideoByUrl(url: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE source_url = ?');
    const result = stmt.get(url) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Find video by ID
   */
  findVideoById(id: string): VideoRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE id = ?');
    const result = stmt.get(id) as VideoRecord | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Update video path (for relinking moved files)
   */
  updateVideoPath(id: string, newPath: string, uploadDate?: string) {
    const db = this.ensureInitialized();

    // Convert to relative path for cross-platform compatibility
    const clipsFolder = this.getClipsFolderPath();
    const relativePath = clipsFolder ? this.toRelativePath(newPath, clipsFolder) : newPath;

    db.prepare(
      `UPDATE videos
       SET current_path = ?,
           upload_date = COALESCE(?, upload_date),
           last_verified = ?,
           is_linked = 1
       WHERE id = ?`
    ).run(relativePath, uploadDate ?? null, new Date().toISOString(), id);

    this.saveDatabase();
  }

  /**
   * Update video metadata (upload_date, download_date, added_at, ai_description)
   */
  updateVideoMetadata(
    id: string,
    uploadDate?: string | null,
    downloadDate?: string,
    addedAt?: string,
    aiDescription?: string | null
  ) {
    const db = this.ensureInitialized();

    // Build dynamic UPDATE query based on provided fields
    const updates: string[] = [];
    const values: any[] = [];

    if (uploadDate !== undefined) {
      updates.push('upload_date = ?');
      values.push(uploadDate);
    }
    if (downloadDate !== undefined) {
      updates.push('download_date = ?');
      values.push(downloadDate);
    }
    if (addedAt !== undefined) {
      updates.push('added_at = ?');
      values.push(addedAt);
    }
    if (aiDescription !== undefined) {
      updates.push('ai_description = ?');
      values.push(aiDescription);
    }

    if (updates.length > 0) {
      values.push(id);
      db.prepare(`UPDATE videos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      this.saveDatabase();
    }
  }

  /**
   * Update video technical metadata (duration, width, height, fps)
   * Used to verify/correct metadata during analysis
   */
  updateVideoTechnicalMetadata(
    id: string,
    metadata: {
      durationSeconds?: number;
      width?: number;
      height?: number;
      fps?: number;
    }
  ) {
    const db = this.ensureInitialized();

    const updates: string[] = [];
    const values: any[] = [];

    if (metadata.durationSeconds !== undefined) {
      updates.push('duration_seconds = ?');
      values.push(metadata.durationSeconds);
    }
    if (metadata.width !== undefined) {
      updates.push('width = ?');
      values.push(metadata.width);
    }
    if (metadata.height !== undefined) {
      updates.push('height = ?');
      values.push(metadata.height);
    }
    if (metadata.fps !== undefined) {
      updates.push('fps = ?');
      values.push(metadata.fps);
    }

    if (updates.length > 0) {
      values.push(id);
      db.prepare(`UPDATE videos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      this.saveDatabase();
      this.logger.log(`[Technical Metadata] Updated video ${id}: ${JSON.stringify(metadata)}`);
    }
  }

  /**
   * Update video's source URL
   */
  updateVideoSourceUrl(id: string, sourceUrl: string | null) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET source_url = ?
         WHERE id = ?`
      ).run(sourceUrl, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update source URL for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's AI-generated description
   */
  updateVideoDescription(id: string, description: string | null) {
    const db = this.ensureInitialized();

    this.logger.log(`[AI Description] Updating description for video ${id}: ${description ? description.substring(0, 100) + '...' : 'null'}`);

    try {
      db.prepare(
        `UPDATE videos
         SET ai_description = ?
         WHERE id = ?`
      ).run(description, id);

      this.saveDatabase();
      this.logger.log(`[AI Description] Successfully updated description for video ${id}`);
    } catch (error: any) {
      this.logger.error(`[AI Description] Failed to update description: ${error.message}`);
      throw error;
    }
  }

  updateVideoSuggestedTitle(id: string, suggestedTitle: string | null) {
    const db = this.ensureInitialized();

    this.logger.log(`[Suggested Title] Updating suggested title for video ${id}: ${suggestedTitle || 'null'}`);

    try {
      db.prepare(
        `UPDATE videos
         SET suggested_title = ?
         WHERE id = ?`
      ).run(suggestedTitle, id);

      this.saveDatabase();
      this.logger.log(`[Suggested Title] Successfully updated suggested title for video ${id}`);
    } catch (error: any) {
      this.logger.error(`[Suggested Title] Failed to update suggested title: ${error.message}`);
      throw error;
    }
  }

  /**
   * Update video's filename
   */
  updateVideoFilename(id: string, filename: string) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET filename = ?
         WHERE id = ?`
      ).run(filename, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update filename for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's download date
   */
  updateVideoDownloadDate(id: string, downloadDate: string) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET download_date = ?
         WHERE id = ?`
      ).run(downloadDate, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update download date for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's upload date
   */
  updateVideoUploadDate(id: string, uploadDate: string | null) {
    const db = this.ensureInitialized();

    try {
      db.prepare(
        `UPDATE videos
         SET upload_date = ?
         WHERE id = ?`
      ).run(uploadDate, id);

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update upload date for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Update video's last processed date (set when any task completes on this video)
   */
  updateLastProcessedDate(id: string, date?: string) {
    const db = this.ensureInitialized();
    const processedDate = date || new Date().toISOString();

    try {
      db.prepare(
        `UPDATE videos
         SET last_processed_date = ?
         WHERE id = ?`
      ).run(processedDate, id);

      this.saveDatabase();
      this.logger.log(`Updated last_processed_date for video ${id}: ${processedDate}`);
    } catch (error) {
      this.logger.error(`Failed to update last_processed_date for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Get video by ID with computed flags
   */
  getVideoById(id: string): VideoRecordWithFlags | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children,
        CASE WHEN EXISTS (SELECT 1 FROM media_relationships mr WHERE mr.primary_media_id = v.id OR mr.related_media_id = v.id) THEN 1 ELSE 0 END as has_connections
      FROM videos v
      WHERE v.id = ?
    `);
    const result = stmt.get(id) as VideoRecordWithFlags | undefined;
    return result ? this.resolveVideoPaths(result) : null;
  }

  /**
   * Mark video as unlinked (file not found)
   */
  markVideoUnlinked(id: string) {
    const db = this.ensureInitialized();
    db.prepare('UPDATE videos SET is_linked = 0 WHERE id = ?').run(id);
    this.saveDatabase();
  }

  /**
   * Delete a video from the database
   * This will cascade delete all related records (transcripts, analyses, tags, sections)
   * Also deletes the associated thumbnail file
   * Returns the video record before deletion so caller can delete physical file
   */
  deleteVideo(id: string): VideoRecord {
    const db = this.ensureInitialized();

    // Get video info before deleting (for file path)
    const video = this.getVideoById(id);
    if (!video) {
      throw new Error('Video not found');
    }

    this.logger.log(`Deleting video ${id} and all related data`);

    // The row's children (transcript, analyses, tags, sections, the search
    // index) go with it through ON DELETE CASCADE.
    db.prepare('DELETE FROM videos WHERE id = ?').run(id);

    this.saveDatabase();

    // Delete associated thumbnail only after the row delete has committed, so a
    // rolled-back transaction never leaves a live row with a missing thumbnail.
    this.thumbnailService.deleteThumbnail(id);

    return video;
  }

  /**
   * Prune/cleanup orphaned videos (videos marked as unlinked)
   * Deletes all database records for videos where is_linked = 0
   * Also deletes associated thumbnails
   * Returns count of deleted videos
   */
  pruneOrphanedVideos(): PruneResult {
    const db = this.ensureInitialized();

    // Get list of unlinked videos before deleting
    const stmt = db.prepare('SELECT id, filename FROM videos WHERE is_linked = 0');
    const unlinkedVideos = stmt.all() as Array<{ id: string; filename: string }>;

    if (unlinkedVideos.length === 0) {
      this.logger.log('No orphaned videos to prune');
      return { deletedCount: 0, deletedVideos: [] };
    }

    this.logger.log(`Pruning ${unlinkedVideos.length} orphaned videos from database`);

    // Their children go with them through ON DELETE CASCADE.
    db.prepare('DELETE FROM videos WHERE is_linked = 0').run();

    this.saveDatabase();

    // Delete thumbnails only after the row deletes have committed.
    this.thumbnailService.deleteThumbnails(unlinkedVideos.map((v) => v.id));

    return {
      deletedCount: unlinkedVideos.length,
      deletedVideos: unlinkedVideos
    };
  }

  /**
   * Clean up orphaned thumbnails
   * Finds and deletes thumbnails that don't have corresponding video records
   * Returns count of deleted orphaned thumbnails
   */
  cleanupOrphanedThumbnails(): { deletedCount: number; orphanedThumbnails: string[] } {
    const db = this.ensureInitialized();

    // Get all valid video IDs from database
    const videos = db.prepare('SELECT id FROM videos').all() as Array<{ id: string }>;
    const validVideoIds = new Set(videos.map(v => v.id));

    // Use ThumbnailService to find orphaned thumbnails
    const orphanedPaths = this.thumbnailService.findOrphanedThumbnails(validVideoIds);

    // Clean up orphaned thumbnails
    const deletedCount = this.thumbnailService.cleanupOrphanedThumbnails(validVideoIds);

    // Extract just the filenames from the paths
    const orphaned = orphanedPaths.map(p => path.basename(p));

    return {
      deletedCount,
      orphanedThumbnails: orphaned
    };
  }

  /**
   * Clean up duplicate video entries where filename doesn't match current_path basename
   * This fixes data integrity issues from improper file renames
   */
  cleanupDuplicateEntries(): { deletedCount: number; deletedEntries: Array<{ id: string; filename: string; current_path: string }> } {
    const db = this.ensureInitialized();

    // Find all videos where the filename doesn't match the current_path basename
    const mismatchedStmt = db.prepare(`
      SELECT id, filename, current_path
      FROM videos
      WHERE filename != REPLACE(current_path, RTRIM(current_path, REPLACE(current_path, '/', '')), '')
    `);
    const mismatched = mismatchedStmt.all() as Array<{ id: string; filename: string; current_path: string }>;

    // Filter to only entries where basename(current_path) != filename
    const toDelete = mismatched.filter(v => {
      const basename = path.basename(v.current_path);
      return basename !== v.filename;
    });

    if (toDelete.length === 0) {
      this.logger.log('[Cleanup] No mismatched duplicate entries found');
      return { deletedCount: 0, deletedEntries: [] };
    }

    this.logger.log(`[Cleanup] Found ${toDelete.length} entries with mismatched filename/path`);

    // Delete the mismatched entries
    const deleteStmt = db.prepare('DELETE FROM videos WHERE id = ?');
    let deletedCount = 0;

    for (const entry of toDelete) {
      try {
        deleteStmt.run(entry.id);
        deletedCount++;
        this.logger.log(`[Cleanup] Deleted entry: id=${entry.id}, filename=${entry.filename}, path=${entry.current_path}`);
      } catch (error: any) {
        this.logger.error(`[Cleanup] Failed to delete entry ${entry.id}: ${error.message}`);
      }
    }

    this.saveDatabase();
    this.logger.log(`[Cleanup] Successfully deleted ${deletedCount} mismatched duplicate entries`);

    return {
      deletedCount,
      deletedEntries: toDelete
    };
  }

  /**
   * Get all videos (excluding children - they are fetched separately via getChildVideos)
   */
  getAllVideos(options?: { linkedOnly?: boolean; limit?: number; offset?: number; includeChildren?: boolean }): VideoRecordWithFlags[] {
    const db = this.ensureInitialized();
    // has_transcript and has_analysis are now actual columns (maintained by triggers/updates)
    // suggested_title comes from the videos table itself, not from analyses
    let query = `
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children,
        CASE WHEN EXISTS (SELECT 1 FROM media_relationships mr WHERE mr.primary_media_id = v.id OR mr.related_media_id = v.id) THEN 1 ELSE 0 END as has_connections,
        wa.domain as wa_domain,
        wa.favicon_path as wa_favicon_path,
        wa.original_url as wa_original_url,
        wa.page_title as wa_page_title
      FROM videos v
      LEFT JOIN web_archives wa ON wa.video_id = v.id
    `;
    const params: any[] = [];

    const conditions: string[] = [];

    if (options?.linkedOnly) {
      conditions.push('v.is_linked = 1');
    }

    // By default, only show parent/root videos (not children)
    // Children will be fetched separately via getChildVideos()
    if (!options?.includeChildren) {
      conditions.push('v.parent_id IS NULL');
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY v.download_date DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    } else if (options?.offset) {
      // SQLite requires a LIMIT when OFFSET is present; -1 means "no limit".
      query += ' LIMIT -1';
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    const results = params.length > 0 ? stmt.all(...params) : stmt.all();
    this.logger.debug(`[getAllVideos] SQL returned ${results.length} rows`);

    return this.resolveVideoPathsArray(results as VideoRecordWithFlags[]);
  }

  /**
   * Get all videos in hierarchical structure (parents with their children)
   * Returns a flat array with children immediately following their parent
   */
  getAllVideosHierarchical(options?: { linkedOnly?: boolean }): Array<VideoRecordWithFlags & { isParent: boolean; isChild: boolean }> {
    // Get all parent/root videos
    const parents = this.getAllVideos({
      linkedOnly: options?.linkedOnly,
      includeChildren: false
    });

    const results: Array<VideoRecordWithFlags & { isParent: boolean; isChild: boolean }> = [];

    // For each parent, add it and then its children
    for (const parent of parents) {
      results.push({
        ...parent,
        isParent: true,
        isChild: false
      });

      // Get children for this parent
      const children = this.getChildVideos(parent.id);
      for (const child of children) {
        results.push({
          ...child,
          has_transcript: (child as any).has_transcript ?? 0,
          has_analysis: (child as any).has_analysis ?? 0,
          has_children: 0,
          has_connections: 0,
          isParent: false,
          isChild: true,
          parent_id: parent.id
        });
      }
    }

    return results;
  }

  /**
   * Insert transcript for a video
   */
  insertTranscript(transcript: {
    videoId: string;
    plainText: string;
    srtFormat: string;
    whisperModel?: string;
    language?: string;
    transcriptionTimeSeconds?: number;
  }) {
    const db = this.ensureInitialized();

    const transcribedAt = new Date().toISOString();

    const insertTranscriptTxn = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO transcripts (
          video_id, plain_text, srt_format, whisper_model, language, transcribed_at, transcription_time_seconds
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        transcript.videoId,
        transcript.plainText,
        transcript.srtFormat,
        transcript.whisperModel || null,
        transcript.language || null,
        transcribedAt,
        transcript.transcriptionTimeSeconds || null,
      );

      // Search: the transcript's segments and windows, in the same transaction.
      indexVideoMoments(db, transcript.videoId, transcript.srtFormat, transcribedAt);

      // Update has_transcript flag in videos table
      db.prepare(
        `UPDATE videos SET has_transcript = 1 WHERE id = ?`
      ).run(transcript.videoId);
    });
    insertTranscriptTxn();

    this.saveDatabase();
    this.notifyTranscriptsIndexed();
    this.logger.log(`Set has_transcript flag for video ${transcript.videoId}`);
  }

  /**
   * Get transcript for a video
   */
  getTranscript(videoId: string): TranscriptRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM transcripts WHERE video_id = ?');
    const result = stmt.get(videoId) as TranscriptRecord | undefined;
    return result || null;
  }

  /**
   * Insert analysis for a video
   */
  insertAnalysis(analysis: {
    videoId: string;
    aiAnalysis: string;
    summary?: string;
    sectionsCount?: number;
    aiModel: string;
    aiProvider?: string;
    analysisTimeSeconds?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
    apiCalls?: number;
  }) {
    const db = this.ensureInitialized();

    const insertAnalysisTxn = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO analyses (
          video_id, ai_analysis, summary, sections_count, ai_model, ai_provider, analyzed_at, analysis_time_seconds,
          input_tokens, output_tokens, total_tokens, estimated_cost, api_calls
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        analysis.videoId,
        analysis.aiAnalysis,
        analysis.summary || null,
        analysis.sectionsCount || null,
        analysis.aiModel,
        analysis.aiProvider || null,
        new Date().toISOString(),
        analysis.analysisTimeSeconds || null,
        analysis.inputTokens || null,
        analysis.outputTokens || null,
        analysis.totalTokens || null,
        analysis.estimatedCost || null,
        analysis.apiCalls || null,
      );

      // Update has_analysis flag in videos table
      db.prepare(
        `UPDATE videos SET has_analysis = 1 WHERE id = ?`
      ).run(analysis.videoId);
    });
    insertAnalysisTxn();

    this.saveDatabase();
    this.logger.log(`Set has_analysis flag for video ${analysis.videoId}`);
  }

  /**
   * Get analysis for a video
   */
  getAnalysis(videoId: string): AnalysisRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM analyses WHERE video_id = ?');
    const result = stmt.get(videoId) as AnalysisRecord | undefined;
    return result || null;
  }

  /**
   * Delete analysis for a video (only deletes AI-generated sections, preserves user markers)
   */
  deleteAnalysis(videoId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      // Delete only AI-generated sections (preserve user-created custom markers)
      this.deleteAIAnalysisSections(id);
      // Then delete the analysis record
      db.prepare('DELETE FROM analyses WHERE video_id = ?').run(id);
      // Clear the denormalized flag so the videos table stays consistent
      db.prepare('UPDATE videos SET has_analysis = 0 WHERE id = ?').run(id);
    });
    txn(videoId);
    this.logger.log(`Deleted AI analysis for video ${videoId}`);
  }

  /**
   * Delete only AI-generated analysis sections for a video (preserves user markers)
   */
  deleteAIAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM analysis_sections WHERE video_id = ? AND source = ?').run(videoId, 'ai');
    this.logger.log(`Deleted AI analysis sections for video ${videoId} (preserving user markers)`);
  }

  /**
   * Delete the AI sections that START inside [startSeconds, endSeconds): what a
   * flag analysis of one chapter replaces. Sections that start before or after
   * it (other chapters' flags) and user markers are kept. Returns the count.
   */
  deleteAIAnalysisSectionsInRange(videoId: string, startSeconds: number, endSeconds: number): number {
    const db = this.ensureInitialized();
    const { changes } = db
      .prepare('DELETE FROM analysis_sections WHERE video_id = ? AND source = ? AND start_seconds >= ? AND start_seconds < ?')
      .run(videoId, 'ai', startSeconds, endSeconds);
    this.logger.log(`Deleted ${changes} AI analysis section(s) for video ${videoId} inside ${startSeconds}-${endSeconds}s`);
    return changes;
  }

  /** How many AI sections a video has stored (the analysis row's sections_count). */
  countAIAnalysisSections(videoId: string): number {
    const db = this.ensureInitialized();
    const row = db
      .prepare('SELECT COUNT(*) as count FROM analysis_sections WHERE video_id = ? AND source = ?')
      .get(videoId, 'ai') as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Delete all analysis sections for a video (including user markers)
   * WARNING: This deletes everything. Use deleteAIAnalysisSections to preserve user markers.
   */
  deleteAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM analysis_sections WHERE video_id = ?').run(videoId);
    this.logger.log(`Deleted ALL analysis sections for video ${videoId}`);
  }

  /**
   * Delete a specific analysis section by ID
   */
  deleteAnalysisSection(sectionId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM analysis_sections WHERE id = ?').run(sectionId);
    this.logger.log(`Deleted analysis section ${sectionId}`);
  }

  /**
   * Delete all tags for a video
   */
  deleteTagsForVideo(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM tags WHERE video_id = ?').run(videoId);
    this.logger.log(`Deleted tags for video ${videoId}`);
  }

  /**
   * Delete only AI-generated tags for a video (preserves user-created tags)
   */
  deleteAITagsForVideo(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM tags WHERE video_id = ? AND source = ?').run(videoId, 'ai');
    this.saveDatabase();
    this.logger.log(`Deleted AI-generated tags for video ${videoId}`);
  }

  /**
   * Delete a specific tag by ID
   */
  deleteTag(tagId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    this.saveDatabase();
    this.logger.log(`Deleted tag ${tagId}`);
  }

  /**
   * Delete transcript for a video
   */
  deleteTranscript(videoId: string) {
    const db = this.ensureInitialized();
    const txn = db.transaction((id: string) => {
      db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(id);
      removeVideoMoments(db, id);
      // Clear the denormalized flag so the videos table stays consistent
      db.prepare('UPDATE videos SET has_transcript = 0 WHERE id = ?').run(id);
    });
    txn(videoId);
    this.logger.log(`Deleted transcript for video ${videoId}`);
  }

  /**
   * Insert an analysis section
   */
  insertAnalysisSection(section: {
    id: string;
    videoId: string;
    startSeconds: number;
    endSeconds: number;
    timestampText?: string;
    title?: string;
    description?: string;
    category?: string;
    source?: string;
    /**
     * The verifier's verdict for this row. OMITTED means legacy/discovery — the
     * column is written NULL and every reader treats it as 'flag'. Callers on
     * the ranked path always pass one, including 'skip'.
     */
    verdict?: 'flag' | 'skip' | 'candidate';
    /** The ranker's score for this row's category. Omitted on paths with no score. */
    nliScore?: number;
    /** Which ranker produced the row ('nli' | 'snap-v1' | 'generate-v1'). Omitted on paths with no ranker. */
    ranker?: string;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO analysis_sections (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, source,
        verdict, nli_score, ranker
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      section.id,
      section.videoId,
      section.startSeconds,
      section.endSeconds,
      section.timestampText || null,
      section.title || null,
      section.description || null,
      section.category || null,
      section.source || 'ai',
      section.verdict ?? null,
      typeof section.nliScore === 'number' && Number.isFinite(section.nliScore)
        ? section.nliScore
        : null,
      section.ranker ?? null,
    );

    this.saveDatabase();
  }

  // ---------------------------------------------------------------- flag verdict cache

  /**
   * Look up a previously answered verification question. Returns null on a miss
   * and on any error — the cache is an optimization and must never be able to
   * take an analysis down, so a broken or missing table degrades to "ask the
   * model", which is exactly the behavior before the cache existed.
   */
  getFlagVerdict(questionHash: string): FlagVerdictCacheRecord | null {
    try {
      const db = this.ensureInitialized();
      const row = db
        .prepare('SELECT * FROM flag_verdict_cache WHERE question_hash = ?')
        .get(questionHash) as FlagVerdictCacheRecord | undefined;
      return row || null;
    } catch (error: any) {
      this.logger.debug(`Flag verdict cache lookup failed: ${error?.message || 'unknown error'}`);
      return null;
    }
  }

  /**
   * Record an answer. INSERT OR REPLACE, because the only way the same hash is
   * written twice with a different verdict is a non-deterministic grader, and in
   * that case the newest answer is the one to keep.
   *
   * Deliberately does NOT call saveDatabase(): a flag run writes hundreds of
   * these and the cache is disposable. The rows are committed by better-sqlite3
   * the moment they are written; saveDatabase() is the library's own bookkeeping
   * hook and running it per verdict would cost more than the cache saves.
   */
  putFlagVerdict(entry: {
    questionHash: string;
    category: string;
    verifierModel: string;
    promptVersion: string;
    verdict: 'flag' | 'skip';
    reason: string | null;
  }): void {
    try {
      const db = this.ensureInitialized();
      db.prepare(
        `INSERT OR REPLACE INTO flag_verdict_cache (
          question_hash, category, verifier_model, prompt_version, verdict, reason, created_at, last_hit_at, hit_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`
      ).run(
        entry.questionHash,
        entry.category,
        entry.verifierModel,
        entry.promptVersion,
        entry.verdict,
        entry.reason,
        new Date().toISOString(),
      );
    } catch (error: any) {
      this.logger.debug(`Flag verdict cache write failed: ${error?.message || 'unknown error'}`);
    }
  }

  /** Count a hit, so the table itself shows which questions keep coming back. */
  recordFlagVerdictHit(questionHash: string): void {
    try {
      const db = this.ensureInitialized();
      db.prepare(
        'UPDATE flag_verdict_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE question_hash = ?'
      ).run(new Date().toISOString(), questionHash);
    } catch (error: any) {
      this.logger.debug(`Flag verdict cache hit bump failed: ${error?.message || 'unknown error'}`);
    }
  }

  /** Row count, for logging a run's cache state. Returns 0 when unavailable. */
  countFlagVerdicts(): number {
    try {
      const db = this.ensureInitialized();
      const row = db.prepare('SELECT COUNT(*) as count FROM flag_verdict_cache').get() as
        | { count: number }
        | undefined;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get all sections for a video (both AI and custom markers)
   */
  getAnalysisSections(videoId: string): Array<AnalysisSectionRecord | CustomMarkerRecord> {
    const db = this.ensureInitialized();

    // Get AI-generated sections
    const aiStmt = db.prepare(
      'SELECT *, \'ai\' as source FROM analysis_sections WHERE video_id = ? ORDER BY start_seconds'
    );
    const aiResults = aiStmt.all(videoId) as AnalysisSectionRecord[];

    // Get custom markers
    const customStmt = db.prepare(
      'SELECT *, \'user\' as source FROM custom_markers WHERE video_id = ? ORDER BY start_seconds'
    );
    const customResults = customStmt.all(videoId) as CustomMarkerRecord[];

    // Merge and sort by start time
    const allSections: Array<AnalysisSectionRecord | CustomMarkerRecord> = [...aiResults, ...customResults];
    allSections.sort((a, b) => a.start_seconds - b.start_seconds);

    return allSections;
  }

  /**
   * Insert a custom marker
   */
  insertCustomMarker(marker: {
    id: string;
    videoId: string;
    startSeconds: number;
    endSeconds: number;
    timestampText?: string;
    title?: string;
    description?: string;
    category?: string;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO custom_markers (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      marker.id,
      marker.videoId,
      marker.startSeconds,
      marker.endSeconds,
      marker.timestampText || null,
      marker.title || null,
      marker.description || null,
      marker.category || 'custom',
      new Date().toISOString(),
    );

    this.saveDatabase();
  }

  /**
   * Get all custom markers for a video
   */
  getCustomMarkers(videoId: string): CustomMarkerRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM custom_markers WHERE video_id = ? ORDER BY start_seconds'
    );
    const results = stmt.all(videoId) as CustomMarkerRecord[];
    return results;
  }

  /**
   * Delete a specific custom marker by ID
   */
  deleteCustomMarker(markerId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM custom_markers WHERE id = ?').run(markerId);
    this.saveDatabase();
    this.logger.log(`Deleted custom marker ${markerId}`);
  }

  /**
   * Delete all custom markers for a video
   */
  deleteCustomMarkers(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM custom_markers WHERE video_id = ?').run(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted all custom markers for video ${videoId}`);
  }

  /**
   * Update a custom marker
   */
  updateCustomMarker(marker: {
    id: string;
    startSeconds?: number;
    endSeconds?: number;
    timestampText?: string;
    title?: string;
    description?: string;
    category?: string;
  }) {
    const db = this.ensureInitialized();

    const updates: string[] = [];
    const values: any[] = [];

    if (marker.startSeconds !== undefined) {
      updates.push('start_seconds = ?');
      values.push(marker.startSeconds);
    }
    if (marker.endSeconds !== undefined) {
      updates.push('end_seconds = ?');
      values.push(marker.endSeconds);
    }
    if (marker.timestampText !== undefined) {
      updates.push('timestamp_text = ?');
      values.push(marker.timestampText);
    }
    if (marker.title !== undefined) {
      updates.push('title = ?');
      values.push(marker.title);
    }
    if (marker.description !== undefined) {
      updates.push('description = ?');
      values.push(marker.description);
    }
    if (marker.category !== undefined) {
      updates.push('category = ?');
      values.push(marker.category);
    }

    if (updates.length === 0) return;

    values.push(marker.id);
    const sql = `UPDATE custom_markers SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...values);
    this.saveDatabase();
    this.logger.log(`Updated custom marker ${marker.id}`);
  }

  // ==================== MUTE SECTIONS ====================

  /**
   * Insert a mute section
   */
  insertMuteSection(section: {
    id: string;
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO mute_sections (
        id, video_id, start_seconds, end_seconds, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      section.id,
      section.videoId,
      section.startSeconds,
      section.endSeconds,
      new Date().toISOString(),
    );

    this.saveDatabase();
    this.logger.log(`Inserted mute section ${section.id} for video ${section.videoId}`);
  }

  /**
   * Get all mute sections for a video
   */
  getMuteSections(videoId: string): MuteSectionRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM mute_sections WHERE video_id = ? ORDER BY start_seconds'
    );
    return stmt.all(videoId) as MuteSectionRecord[];
  }

  /**
   * Delete a specific mute section by ID
   */
  deleteMuteSection(sectionId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM mute_sections WHERE id = ?').run(sectionId);
    this.saveDatabase();
    this.logger.log(`Deleted mute section ${sectionId}`);
  }

  /**
   * Update a mute section's start/end times
   */
  updateMuteSection(sectionId: string, startSeconds: number, endSeconds: number) {
    const db = this.ensureInitialized();
    db.prepare('UPDATE mute_sections SET start_seconds = ?, end_seconds = ? WHERE id = ?')
      .run(startSeconds, endSeconds, sectionId);
    this.saveDatabase();
    this.logger.log(`Updated mute section ${sectionId}: ${startSeconds}s - ${endSeconds}s`);
  }

  /**
   * Delete all mute sections for a video
   */
  deleteMuteSections(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM mute_sections WHERE video_id = ?').run(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted all mute sections for video ${videoId}`);
  }

  // ==================== CHAPTERS ====================

  /**
   * Insert a chapter
   */
  insertChapter(chapter: {
    id: string;
    videoId: string;
    sequence: number;
    startSeconds: number;
    endSeconds: number;
    title: string;
    description?: string;
    source?: string;
    /** Outline level (nested analyses); absent writes NULL, read as top level. */
    level?: number | null;
    parentId?: string | null;
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO chapters (
        id, video_id, sequence, start_seconds, end_seconds, title, description, source, created_at, level, parent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      chapter.id,
      chapter.videoId,
      chapter.sequence,
      chapter.startSeconds,
      chapter.endSeconds,
      chapter.title,
      chapter.description || null,
      chapter.source || 'ai',
      new Date().toISOString(),
      chapter.level ?? null,
      chapter.parentId ?? null,
    );

    this.saveDatabase();
  }

  /**
   * Get all chapters for a video, ordered by sequence
   */
  getChapters(videoId: string): ChapterRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM chapters WHERE video_id = ? ORDER BY sequence'
    );
    return stmt.all(videoId) as ChapterRecord[];
  }

  /**
   * Delete a specific chapter by ID, with the chapters nested under it
   */
  deleteChapter(chapterId: string) {
    const db = this.ensureInitialized();
    deleteChapterSubtree(db, chapterId);
    this.saveDatabase();
    this.logger.log(`Deleted chapter ${chapterId}`);
  }

  /**
   * Delete all chapters for a video
   */
  deleteChapters(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM chapters WHERE video_id = ?').run(videoId);
    this.saveDatabase();
    this.logger.log(`Deleted all chapters for video ${videoId}`);
  }

  /**
   * Update a chapter
   */
  updateChapter(chapter: {
    id: string;
    sequence?: number;
    startSeconds?: number;
    endSeconds?: number;
    title?: string;
    description?: string;
  }) {
    const db = this.ensureInitialized();

    const updates: string[] = [];
    const values: any[] = [];

    if (chapter.sequence !== undefined) {
      updates.push('sequence = ?');
      values.push(chapter.sequence);
    }
    if (chapter.startSeconds !== undefined) {
      updates.push('start_seconds = ?');
      values.push(chapter.startSeconds);
    }
    if (chapter.endSeconds !== undefined) {
      updates.push('end_seconds = ?');
      values.push(chapter.endSeconds);
    }
    if (chapter.title !== undefined) {
      updates.push('title = ?');
      values.push(chapter.title);
    }
    if (chapter.description !== undefined) {
      updates.push('description = ?');
      values.push(chapter.description);
    }

    if (updates.length === 0) return;

    values.push(chapter.id);
    const sql = `UPDATE chapters SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...values);
    this.saveDatabase();
    this.logger.log(`Updated chapter ${chapter.id}`);
  }

  /**
   * Insert a tag
   */
  insertTag(
    videoIdOrTag: string | {
      id: string;
      videoId: string;
      tagName: string;
      tagType?: string;
      confidence?: number;
      source?: string;
    },
    tagName?: string,
    tagType?: string,
    confidence?: number,
    source?: string
  ): string {
    const db = this.ensureInitialized();

    let tag: {
      id: string;
      videoId: string;
      tagName: string;
      tagType?: string;
      confidence?: number;
      source?: string;
    };

    // Support both object and individual parameters
    if (typeof videoIdOrTag === 'string') {
      const { v4: uuidv4 } = require('uuid');
      tag = {
        id: uuidv4(),
        videoId: videoIdOrTag,
        tagName: tagName!,
        tagType,
        confidence,
        source
      };
    } else {
      tag = videoIdOrTag;
    }

    db.prepare(
      `INSERT INTO tags (id, video_id, tag_name, tag_type, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tag.id,
      tag.videoId,
      tag.tagName,
      tag.tagType || null,
      tag.confidence || null,
      tag.source || null,
      new Date().toISOString(),
    );

    this.saveDatabase();
    return tag.id;
  }

  /**
   * Get all tags for a video
   */
  getTags(videoId: string): TagRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM tags WHERE video_id = ?');
    const results = stmt.all(videoId) as TagRecord[];
    return results;
  }

  /**
   * Get all tags across all videos
   */
  getAllTags(): TagRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM tags');
    const results = stmt.all() as TagRecord[];
    return results;
  }

  /**
   * Get all tags with counts, grouped by type
   */
  getAllTagsWithCounts(): Record<string, Array<{ name: string; count: number }>> {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT tag_name, tag_type, COUNT(*) as count
      FROM tags
      GROUP BY tag_name, tag_type
      ORDER BY count DESC, tag_name ASC
    `);

    const tags = stmt.all() as TagWithCountRecord[];

    // Group by type
    const grouped: Record<string, Array<{ name: string; count: number }>> = {
      people: [],
      topic: [],
      other: [],
    };

    for (const tag of tags) {
      const type = tag.tag_type || 'other';
      const group = grouped[type] || grouped.other;
      group.push({ name: tag.tag_name, count: tag.count });
    }

    return grouped;
  }

  /**
   * Get video IDs that have all of the specified tags
   */
  getVideoIdsByTags(tagNames: string[]): string[] {
    if (tagNames.length === 0) {
      return [];
    }

    // Build a query that finds videos with ANY of the specified tags (case-insensitive)
    const placeholders = tagNames.map(() => '?').join(',');
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT DISTINCT video_id
      FROM tags
      WHERE LOWER(tag_name) IN (${placeholders})
    `);
    // Convert tag names to lowercase for case-insensitive matching
    const rows = stmt.all(...tagNames.map(t => t.toLowerCase())) as any[];
    const results = rows.map(row => row.video_id);

    console.log(`[getVideoIdsByTags] Searching for tags:`, tagNames, `Found ${results.length} videos`);

    // Debug: Let's see what tags exist in the database
    const allTagsStmt = db.prepare(`SELECT DISTINCT tag_name FROM tags LIMIT 20`);
    const sampleTagRows = allTagsStmt.all() as any[];
    const sampleTags = sampleTagRows.map(row => row.tag_name);
    console.log(`[getVideoIdsByTags] Sample tags in database:`, sampleTags);

    return results;
  }

  /**
   * Get database statistics
   */
  getStats(): StatsRecord {
    const db = this.ensureInitialized();

    const getCount = (query: string): number => {
      const stmt = db.prepare(query);
      const result = stmt.get() as { count: number };
      return result.count;
    };

    const totalVideos = getCount('SELECT COUNT(*) as count FROM videos');
    const linkedVideos = getCount('SELECT COUNT(*) as count FROM videos WHERE is_linked = 1');
    const withTranscripts = getCount('SELECT COUNT(*) as count FROM transcripts');
    const withAnalyses = getCount('SELECT COUNT(*) as count FROM analyses');
    const totalTags = getCount('SELECT COUNT(*) as count FROM tags');

    return {
      totalVideos,
      linkedVideos,
      unlinkedVideos: totalVideos - linkedVideos,
      withTranscripts,
      withAnalyses,
      totalTags,
    };
  }

  // ============================================================================
  // MEDIA RELATIONSHIPS OPERATIONS
  // ============================================================================

  /**
   * Create a media relationship (link two media items together)
   */
  insertMediaRelationship(relationship: {
    id: string;
    primaryMediaId: string;
    relatedMediaId: string;
    relationshipType: string;
  }) {
    const db = this.ensureInitialized();

    if (relationship.primaryMediaId === relationship.relatedMediaId) {
      throw new Error('An item cannot be connected to itself');
    }

    // Connections are undirected: enforce symmetric uniqueness (a↔b equals b↔a).
    const existing = db.prepare(
      `SELECT id FROM media_relationships
       WHERE (primary_media_id = ? AND related_media_id = ?)
          OR (primary_media_id = ? AND related_media_id = ?)`
    ).get(
      relationship.primaryMediaId, relationship.relatedMediaId,
      relationship.relatedMediaId, relationship.primaryMediaId,
    );
    if (existing) {
      this.logger.log(`Media relationship already exists between ${relationship.primaryMediaId} and ${relationship.relatedMediaId}`);
      return;
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_relationships (
        id, primary_media_id, related_media_id, relationship_type, created_at
      ) VALUES (?, ?, ?, ?, ?)`
    ).run(
      relationship.id,
      relationship.primaryMediaId,
      relationship.relatedMediaId,
      relationship.relationshipType,
      now,
    );

    this.saveDatabase();
  }

  /**
   * Delete the connection between two items regardless of direction.
   */
  deleteConnectionBetween(mediaIdA: string, mediaIdB: string) {
    const db = this.ensureInitialized();
    db.prepare(
      `DELETE FROM media_relationships
       WHERE (primary_media_id = ? AND related_media_id = ?)
          OR (primary_media_id = ? AND related_media_id = ?)`
    ).run(mediaIdA, mediaIdB, mediaIdB, mediaIdA);
    this.saveDatabase();
  }

  /**
   * Get all related media for a given media item
   */
  getRelatedMedia(mediaId: string): MediaRelationshipRecord[] {
    const db = this.ensureInitialized();

    // Get relationships where this item is primary
    const primaryStmt = db.prepare(`
      SELECT r.*, v.filename, v.current_path, v.media_type, v.file_extension
      FROM media_relationships r
      JOIN videos v ON r.related_media_id = v.id
      WHERE r.primary_media_id = ?
    `);
    const primaryResults = primaryStmt.all(mediaId) as MediaRelationshipRecord[];

    // Get relationships where this item is related
    const relatedStmt = db.prepare(`
      SELECT r.*, v.filename, v.current_path, v.media_type, v.file_extension
      FROM media_relationships r
      JOIN videos v ON r.primary_media_id = v.id
      WHERE r.related_media_id = ?
    `);
    const relatedResults = relatedStmt.all(mediaId) as MediaRelationshipRecord[];

    return [...primaryResults, ...relatedResults];
  }

  /**
   * Get every OTHER member of a media item's connected group (its whole
   * relationship component), treating media_relationships as undirected edges.
   *
   * A recursive CTE walks outward from `mediaId`: at each hop it follows an
   * edge in either direction (CASE picks the neighbor), incrementing a depth
   * counter. UNION dedups the frontier so cycles terminate; the depth < 100
   * guard caps runaway walks on pathological data (real components are tiny).
   * The self node is excluded from the result.
   */
  getConnectedGroup(mediaId: string): ConnectedGroupMember[] {
    const db = this.ensureInitialized();

    return db.prepare(`
      WITH RECURSIVE component(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT
          CASE WHEN r.primary_media_id = c.node THEN r.related_media_id
               ELSE r.primary_media_id END,
          c.depth + 1
        FROM media_relationships r
        JOIN component c
          ON (r.primary_media_id = c.node OR r.related_media_id = c.node)
        WHERE c.depth < 100
      )
      SELECT DISTINCT v.id, v.filename, v.media_type, v.file_extension
      FROM component
      JOIN videos v ON v.id = component.node
      WHERE component.node != ?
      LIMIT 500
    `).all(mediaId, mediaId) as ConnectedGroupMember[];
  }

  /**
   * Delete a media relationship
   */
  deleteMediaRelationship(relationshipId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM media_relationships WHERE id = ?').run(relationshipId);
    this.saveDatabase();
    this.logger.log(`Deleted media relationship ${relationshipId}`);
  }

  /**
   * Delete all relationships for a media item
   */
  deleteAllMediaRelationships(mediaId: string) {
    const db = this.ensureInitialized();
    db.prepare(
      'DELETE FROM media_relationships WHERE primary_media_id = ? OR related_media_id = ?'
    ).run(mediaId, mediaId);
    this.saveDatabase();
    this.logger.log(`Deleted all media relationships for ${mediaId}`);
  }

  /**
   * Remove a media item from its connected group entirely. Every edge of an
   * item is by definition within its own component, so deleting all of the
   * item's edges cleanly detaches it (and splits the component wherever it was
   * the only bridge). Equivalent to deleteAllMediaRelationships, exposed under
   * the group vocabulary the connections rework speaks in.
   */
  removeFromGroup(mediaId: string) {
    this.deleteAllMediaRelationships(mediaId);
  }

  // ============================================================================
  // PARENT-CHILD OPERATIONS
  // ============================================================================

  /**
   * Set a video as a child of another video (parent-child relationship)
   * Now uses many-to-many junction table
   * @param childId - ID of the child video
   * @param parentId - ID of the parent video (null to remove ALL parents)
   */
  setVideoParent(childId: string, parentId: string | null) {
    const db = this.ensureInitialized();

    // Validate that the child exists
    const child = this.getVideoById(childId);
    if (!child) {
      throw new Error(`Child video not found: ${childId}`);
    }

    // If parentId is null, remove all parent relationships for this child
    if (parentId === null) {
      // Mirror the removal into the connections model (dual-write transition)
      const parents = this.getParentVideos(childId);
      for (const p of parents) {
        this.deleteConnectionBetween(p.id, childId);
      }

      db.prepare(
        'DELETE FROM video_relationships WHERE child_id = ?'
      ).run(childId);

      // Also clear the deprecated parent_id column for backwards compatibility
      db.prepare(
        'UPDATE videos SET parent_id = NULL WHERE id = ?'
      ).run(childId);

      this.saveDatabase();
      this.logger.log(`Removed all parents from video ${childId}`);
      return;
    }

    // Validate that the parent exists
    const parent = this.getVideoById(parentId);
    if (!parent) {
      throw new Error(`Parent video not found: ${parentId}`);
    }

    // Prevent child from being its own parent
    if (childId === parentId) {
      throw new Error('A video cannot be its own parent');
    }

    // Check if relationship already exists
    const existing = db.prepare(
      'SELECT id FROM video_relationships WHERE parent_id = ? AND child_id = ?'
    ).get(parentId, childId);

    if (existing) {
      this.logger.warn(`Child ${childId} is already linked to parent ${parentId}`);
      return;
    }

    // Create the relationship
    const { v4: uuidv4 } = require('uuid');
    db.prepare(`
      INSERT INTO video_relationships (id, parent_id, child_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      uuidv4(),
      parentId,
      childId,
      new Date().toISOString()
    );

    // Dual-write into the connections model (transition: connections are the
    // UI's source of truth; parent/child stays for legacy flows)
    this.insertMediaRelationship({
      id: uuidv4(),
      primaryMediaId: parentId,
      relatedMediaId: childId,
      relationshipType: 'connected',
    });

    this.saveDatabase();
    this.logger.log(`Linked video ${childId} as child of ${parentId}`);
  }

  /**
   * Get all children of a parent video
   * Now uses many-to-many junction table
   * @param parentId - ID of the parent video
   * @returns Array of child videos
   */
  getChildVideos(parentId: string): VideoRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT v.* FROM videos v
      INNER JOIN video_relationships vr ON v.id = vr.child_id
      WHERE vr.parent_id = ?
      ORDER BY vr.created_at ASC
    `);
    const results = stmt.all(parentId) as VideoRecord[];
    return this.resolveVideoPathsArray(results);
  }

  /**
   * Get all parents of a video (now supports multiple parents)
   * @param videoId - ID of the video
   * @returns Array of parent videos
   */
  getParentVideos(videoId: string): VideoRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT v.* FROM videos v
      INNER JOIN video_relationships vr ON v.id = vr.parent_id
      WHERE vr.child_id = ?
      ORDER BY vr.created_at ASC
    `);
    const results = stmt.all(videoId) as VideoRecord[];
    return this.resolveVideoPathsArray(results);
  }

  /**
   * Get the parent of a video (if it has one)
   * @deprecated Use getParentVideos() instead for multiple parents support
   * @param videoId - ID of the video
   * @returns First parent video or null
   */
  getParentVideo(videoId: string): VideoRecord | null {
    const parents = this.getParentVideos(videoId);
    return parents.length > 0 ? parents[0] : null;
  }

  /**
   * Check if a video has any children
   * Now uses many-to-many junction table
   * @param videoId - ID of the video
   * @returns True if video has children
   */
  hasChildren(videoId: string): boolean {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM video_relationships WHERE parent_id = ?');
    const result = stmt.get(videoId) as any;
    return result.count > 0;
  }

  /**
   * Remove all children from a parent
   * @param parentId - ID of the parent video
   */
  removeAllChildren(parentId: string) {
    const db = this.ensureInitialized();

    // Mirror the removal into the connections model (dual-write transition)
    const children = this.getChildVideos(parentId);
    for (const c of children) {
      this.deleteConnectionBetween(parentId, c.id);
    }

    db.prepare('DELETE FROM video_relationships WHERE parent_id = ?').run(parentId);

    // Also clear deprecated parent_id column for backwards compatibility
    db.prepare('UPDATE videos SET parent_id = NULL WHERE parent_id = ?').run(parentId);

    this.saveDatabase();
    this.logger.log(`Removed all children from parent ${parentId}`);
  }

  /**
   * Remove a specific parent-child relationship
   * @param parentId - ID of the parent video
   * @param childId - ID of the child video
   */
  removeParentChildRelationship(parentId: string, childId: string) {
    const db = this.ensureInitialized();

    // Mirror the removal into the connections model (dual-write transition)
    this.deleteConnectionBetween(parentId, childId);

    db.prepare('DELETE FROM video_relationships WHERE parent_id = ? AND child_id = ?').run(parentId, childId);

    // Also clear deprecated parent_id column if this was the only relationship
    const remainingParents = this.getParentVideos(childId);
    if (remainingParents.length === 0) {
      db.prepare('UPDATE videos SET parent_id = NULL WHERE id = ?').run(childId);
    }

    this.saveDatabase();
    this.logger.log(`Removed parent-child relationship: ${parentId} -> ${childId}`);
  }

  // ============================================================================
  // TEXT CONTENT OPERATIONS (for documents)
  // ============================================================================

  /**
   * Insert extracted text content for a document
   */
  insertTextContent(textContent: {
    mediaId: string;
    extractedText: string;
    extractionMethod?: string;
  }) {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT OR REPLACE INTO text_content (
        media_id, extracted_text, extraction_method, extracted_at
      ) VALUES (?, ?, ?, ?)`
    ).run(
      textContent.mediaId,
      textContent.extractedText,
      textContent.extractionMethod || null,
      now,
    );

    this.saveDatabase();
  }

  /**
   * Get extracted text content for a document
   */
  getTextContent(mediaId: string): TextContentRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM text_content WHERE media_id = ?');
    const result = stmt.get(mediaId) as TextContentRecord | undefined;
    return result || null;
  }

  /**
   * Delete text content for a document
   */
  deleteTextContent(mediaId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM text_content WHERE media_id = ?').run(mediaId);
    this.saveDatabase();
    this.logger.log(`Deleted text content for ${mediaId}`);
  }

  // ========================================
  // Web Archives CRUD
  // ========================================

  insertWebArchive(archive: {
    videoId: string;
    originalUrl?: string;
    domain?: string;
    faviconPath?: string;
    pageTitle?: string;
    captureDate?: string;
    publishDate?: string;
    captureMethod?: string;
    captureStatus?: string;
    errorMessage?: string;
    textExtracted?: boolean;
  }) {
    const db = this.ensureInitialized();
    db.prepare(
      `INSERT OR REPLACE INTO web_archives (
        video_id, original_url, domain, favicon_path, page_title,
        capture_date, publish_date, capture_method, capture_status,
        error_message, text_extracted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      archive.videoId,
      archive.originalUrl || null,
      archive.domain || null,
      archive.faviconPath || null,
      archive.pageTitle || null,
      archive.captureDate || new Date().toISOString(),
      archive.publishDate || null,
      archive.captureMethod || null,
      archive.captureStatus || 'completed',
      archive.errorMessage || null,
      archive.textExtracted ? 1 : 0,
    );
    this.saveDatabase();
  }

  getWebArchive(videoId: string): WebArchiveRecord | null {
    const db = this.ensureInitialized();
    const result = db.prepare('SELECT * FROM web_archives WHERE video_id = ?').get(videoId) as WebArchiveRecord | undefined;
    return result || null;
  }

  getWebArchiveByUrl(url: string): (WebArchiveRecord & { filename: string; current_path: string }) | null {
    const db = this.ensureInitialized();
    const result = db.prepare(`
      SELECT wa.*, v.filename, v.current_path
      FROM web_archives wa
      JOIN videos v ON wa.video_id = v.id
      WHERE wa.original_url = ?
      LIMIT 1
    `).get(url) as (WebArchiveRecord & { filename: string; current_path: string }) | undefined;
    return result || null;
  }

  getAllWebArchives(domain?: string): (WebArchiveRecord & { filename: string; current_path: string; file_size_bytes: number; upload_date: string | null; download_date: string; suggested_title: string | null })[] {
    const db = this.ensureInitialized();
    let query = `
      SELECT wa.*, v.filename, v.current_path, v.file_size_bytes, v.upload_date, v.download_date, v.suggested_title
      FROM web_archives wa
      JOIN videos v ON wa.video_id = v.id
      WHERE v.is_linked = 1
    `;
    const params: any[] = [];
    if (domain) {
      query += ' AND wa.domain = ?';
      params.push(domain);
    }
    query += ' ORDER BY wa.capture_date DESC';
    const rows = db.prepare(query).all(...params) as any[];

    // Resolve current_path from relative (as stored) to absolute, so the
    // frontend can pass it to electronService.showInFolder / openInBrowser etc.
    const clipsFolder = this.getClipsFolderPath();
    if (clipsFolder) {
      for (const row of rows) {
        if (row.current_path) {
          row.current_path = this.toAbsolutePath(row.current_path, clipsFolder).replace(/\\/g, '/');
        }
      }
    }

    return rows;
  }

  getWebArchiveDomains(): { domain: string; count: number; favicon_path: string | null }[] {
    const db = this.ensureInitialized();
    return db.prepare(`
      SELECT wa.domain, COUNT(*) as count, MAX(wa.favicon_path) as favicon_path
      FROM web_archives wa
      JOIN videos v ON wa.video_id = v.id
      WHERE v.is_linked = 1 AND wa.domain IS NOT NULL
      GROUP BY wa.domain
      ORDER BY wa.domain ASC
    `).all() as any[];
  }

  updateWebArchiveStatus(videoId: string, status: string, errorMessage?: string) {
    const db = this.ensureInitialized();
    db.prepare(`
      UPDATE web_archives SET capture_status = ?, error_message = ? WHERE video_id = ?
    `).run(status, errorMessage || null, videoId);
    this.saveDatabase();
  }

  deleteWebArchive(videoId: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM web_archives WHERE video_id = ?').run(videoId);
    this.saveDatabase();
  }

  /**
   * Get the latest library analytics for a library
   */
  getLatestLibraryAnalytics(libraryId: string): LibraryAnalyticsRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT * FROM library_analytics
      WHERE library_id = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `);
    const result = stmt.get(libraryId) as LibraryAnalyticsRecord | undefined;
    return result || null;
  }

  /**
   * Save library analytics
   */
  saveLibraryAnalytics(analytics: {
    libraryId: string;
    videosAnalyzedCount: number;
    aiInsights: string;
    aiModel: string;
    generationTimeSeconds?: number;
  }) {
    const db = this.ensureInitialized();
    const id = `analytics_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    db.prepare(
      `INSERT INTO library_analytics (
        id, library_id, generated_at, videos_analyzed_count,
        ai_insights, ai_model, generation_time_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      analytics.libraryId,
      new Date().toISOString(),
      analytics.videosAnalyzedCount,
      analytics.aiInsights,
      analytics.aiModel,
      analytics.generationTimeSeconds || null,
    );

    this.saveDatabase();
    return id;
  }

  /**
   * Delete old library analytics (keep only the most recent N)
   */
  cleanupOldAnalytics(libraryId: string, keepCount: number = 5) {
    const db = this.ensureInitialized();

    // Delete all but the most recent N entries
    db.prepare(`
      DELETE FROM library_analytics
      WHERE library_id = ?
      AND id NOT IN (
        SELECT id FROM library_analytics
        WHERE library_id = ?
        ORDER BY generated_at DESC
        LIMIT ?
      )
    `).run(libraryId, libraryId, keepCount);

    this.saveDatabase();
  }

  // ========================
  // VIDEO TABS MANAGEMENT
  // ========================

  /**
   * Get all video tabs
   */
  getAllTabs(): Array<{ id: string; name: string; created_at: string; updated_at: string; display_order: number; video_count: number }> {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        vt.*,
        (SELECT COUNT(*) FROM video_tab_items WHERE tab_id = vt.id) as video_count
      FROM video_tabs vt
      ORDER BY vt.display_order ASC, vt.created_at DESC
    `);
    return stmt.all() as any[];
  }

  /**
   * Get a single tab by ID
   */
  getTabById(tabId: string): { id: string; name: string; created_at: string; updated_at: string; display_order: number } | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM video_tabs WHERE id = ?');
    return stmt.get(tabId) as any || null;
  }

  /**
   * Create a new video tab
   */
  createTab(name: string): string {
    const db = this.ensureInitialized();
    const id = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO video_tabs (id, name, created_at, updated_at, display_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, now, now, 0);

    this.saveDatabase();
    return id;
  }

  /**
   * Update tab name
   */
  updateTab(tabId: string, name: string): void {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();

    db.prepare('UPDATE video_tabs SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, now, tabId);

    this.saveDatabase();
  }

  /**
   * Delete a tab (cascade will remove all tab items)
   */
  deleteTab(tabId: string): void {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM video_tabs WHERE id = ?').run(tabId);
    this.saveDatabase();
  }

  /**
   * Get all videos in a tab
   */
  getTabVideos(tabId: string): VideoRecordWithFlags[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM transcripts WHERE video_id = v.id) THEN 1 ELSE 0 END as has_transcript,
        CASE WHEN EXISTS (SELECT 1 FROM analyses WHERE video_id = v.id) OR v.suggested_title IS NOT NULL THEN 1 ELSE 0 END as has_analysis,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children,
        vti.added_at as tab_added_at,
        vti.display_order as tab_display_order
      FROM video_tab_items vti
      JOIN videos v ON vti.video_id = v.id
      WHERE vti.tab_id = ?
      ORDER BY vti.display_order ASC, vti.added_at DESC
    `);
    return this.resolveVideoPathsArray(stmt.all(tabId) as VideoRecordWithFlags[]);
  }

  /**
   * Add a video to a tab
   */
  addVideoToTab(tabId: string, videoId: string): string {
    const db = this.ensureInitialized();
    const id = require('crypto').randomUUID();
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO video_tab_items (id, tab_id, video_id, added_at, display_order, item_type)
        VALUES (?, ?, ?, ?, ?, 'video')
      `).run(id, tabId, videoId, now, 0);

      // Update tab's updated_at timestamp
      db.prepare('UPDATE video_tabs SET updated_at = ? WHERE id = ?')
        .run(now, tabId);

      this.saveDatabase();
      return id;
    } catch (error: any) {
      if (error.message && error.message.includes('UNIQUE constraint failed')) {
        throw new Error('Video is already in this tab');
      }
      throw error;
    }
  }

  /**
   * Add a URL directly to a tab (for external links)
   */
  addUrlToTab(tabId: string, url: string, title?: string): string {
    const db = this.ensureInitialized();
    const id = require('crypto').randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO video_tab_items (id, tab_id, url, added_at, display_order, item_type, title)
      VALUES (?, ?, ?, ?, ?, 'link', ?)
    `).run(id, tabId, url, now, 0, title || null);

    // Update tab's updated_at timestamp
    db.prepare('UPDATE video_tabs SET updated_at = ? WHERE id = ?')
      .run(now, tabId);

    this.saveDatabase();
    return id;
  }

  /**
   * Get all items in a tab (videos, links, etc.)
   */
  getTabItems(tabId: string): any[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT
        vti.id,
        vti.tab_id,
        vti.video_id,
        vti.saved_link_id,
        vti.url,
        vti.title as item_title,
        vti.item_type,
        vti.added_at,
        vti.display_order,
        -- Video fields (if item_type = 'video')
        v.filename,
        v.current_path,
        v.duration_seconds,
        v.file_size_bytes,
        v.suggested_title,
        v.ai_description,
        v.source_url as video_source_url,
        v.media_type,
        v.file_extension,
        v.has_transcript,
        v.has_analysis,
        v.upload_date,
        -- Saved link fields (if item_type = 'link')
        sl.url as saved_link_url,
        sl.title as saved_link_title,
        sl.status as saved_link_status,
        sl.thumbnail_path as saved_link_thumbnail
      FROM video_tab_items vti
      LEFT JOIN videos v ON vti.video_id = v.id AND vti.item_type = 'video'
      LEFT JOIN saved_links sl ON vti.saved_link_id = sl.id AND vti.item_type = 'link'
      WHERE vti.tab_id = ?
      ORDER BY vti.display_order ASC, vti.added_at DESC
    `);
    return stmt.all(tabId) as any[];
  }

  /**
   * Remove a video from a tab
   */
  removeVideoFromTab(tabId: string, videoId: string): void {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM video_tab_items WHERE tab_id = ? AND video_id = ?')
      .run(tabId, videoId);

    // Update tab's updated_at timestamp
    const now = new Date().toISOString();
    db.prepare('UPDATE video_tabs SET updated_at = ? WHERE id = ?')
      .run(now, tabId);

    this.saveDatabase();
  }

  /**
   * Get all tabs that contain a specific video
   */
  getTabsForVideo(videoId: string): Array<{ id: string; name: string; created_at: string; updated_at: string }> {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT vt.id, vt.name, vt.created_at, vt.updated_at
      FROM video_tabs vt
      JOIN video_tab_items vti ON vt.id = vti.tab_id
      WHERE vti.video_id = ?
      ORDER BY vt.name ASC
    `);
    return stmt.all(videoId) as any[];
  }

  /**
   * Get all video IDs that are in at least one tab
   */
  getAllTabbedVideoIds(): string[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT DISTINCT video_id FROM video_tab_items WHERE video_id IS NOT NULL
    `);
    return (stmt.all() as any[]).map(row => row.video_id);
  }

  // =====================================================
  // CUSTOM INSTRUCTIONS HISTORY
  // =====================================================

  /**
   * Save custom instruction to history (upsert - update if exists, insert if new)
   */
  saveCustomInstruction(instructionText: string): void {
    if (!instructionText || instructionText.trim().length === 0) {
      return;
    }

    const db = this.ensureInitialized();
    const trimmedText = instructionText.trim();
    const now = new Date().toISOString();

    // Check if this instruction already exists
    const existing = db.prepare(
      'SELECT id, use_count FROM custom_instructions_history WHERE instruction_text = ?'
    ).get(trimmedText) as { id: number; use_count: number } | undefined;

    if (existing) {
      // Update existing entry
      db.prepare(
        'UPDATE custom_instructions_history SET used_at = ?, use_count = ? WHERE id = ?'
      ).run(now, existing.use_count + 1, existing.id);
    } else {
      // Insert new entry
      db.prepare(
        'INSERT INTO custom_instructions_history (instruction_text, used_at, use_count) VALUES (?, ?, 1)'
      ).run(trimmedText, now);

      // Keep only the most recent 25 entries
      db.prepare(`
        DELETE FROM custom_instructions_history
        WHERE id NOT IN (
          SELECT id FROM custom_instructions_history
          ORDER BY used_at DESC
          LIMIT 25
        )
      `).run();
    }

    this.saveDatabase();
  }

  /**
   * Get recent custom instructions (last 25, most recent first)
   */
  getCustomInstructionsHistory(): Array<{ id: number; instruction_text: string; used_at: string; use_count: number }> {
    const db = this.ensureInitialized();
    return db.prepare(`
      SELECT id, instruction_text, used_at, use_count
      FROM custom_instructions_history
      ORDER BY used_at DESC
      LIMIT 25
    `).all() as any[];
  }

  /**
   * Clear custom instructions history
   */
  clearCustomInstructionsHistory(): void {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM custom_instructions_history').run();
    this.saveDatabase();
  }

  /**
   * Close database connection
   */
  onModuleDestroy() {
    if (this.db) {
      // better-sqlite3 automatically saves all changes, no need to call saveDatabase()
      this.db.close();
      this.logger.log('Database connection closed');
    }
  }
}
