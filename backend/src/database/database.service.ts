import { Injectable, Logger } from '@nestjs/common';
import * as Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ThumbnailService } from './thumbnail.service';

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
}

export interface VideoRecordWithFlags extends VideoRecord {
  has_transcript: number;
  has_analysis: number;
  has_children: number;
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

export interface TagRecord {
  id: string;
  video_id: string;
  tag_name: string;
  tag_type: string | null;
  confidence: number | null;
  source: string | null;
  created_at: string;
}

export interface SavedLinkRecord {
  id: string;
  url: string;
  title: string | null;
  status: string;
  date_added: string;
  date_completed: string | null;
  download_path: string | null;
  thumbnail_path: string | null;
  video_id: string | null;
  error_message: string | null;
  metadata: string | any | null;
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

export interface TextContentRecord {
  media_id: string;
  extracted_text: string;
  extraction_method: string | null;
  extracted_at: string;
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

export interface SearchResultRecord {
  id: string;
  score: number;
  matchType: string;
}

export interface TranscriptSearchRecord {
  video_id: string;
  snippet: string;
}

export interface AnalysisSearchRecord {
  video_id: string;
  snippet: string;
}

export interface TagWithCountRecord {
  tag_name: string;
  tag_type: string;
  count: number;
}

export interface TextContentSearchRecord {
  media_id: string;
  extracted_text: string;
  filename: string;
  media_type: string;
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
 * - Full-text search capabilities with FTS5
 *
 * Using better-sqlite3 for full SQLite support including FTS5
 */
@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database.Database | null = null;
  private dbPath: string | null = null;
  private readonly appDataPath: string;

  constructor(private readonly thumbnailService: ThumbnailService) {
    // Base directory - cross-platform app data location
    // Mac: ~/Library/Application Support/ClipChimp
    // Windows: %APPDATA%/ClipChimp
    // Linux: ~/.config/ClipChimp
    this.appDataPath = this.getAppDataPath();

    // Ensure directories exist
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }

    this.logger.log('DatabaseService created (not initialized)');
  }

  /**
   * Get cross-platform app data directory
   * Mac: ~/Library/Application Support/ClipChimp
   * Windows: %APPDATA%/ClipChimp
   * Linux: ~/.config/ClipChimp
   */
  private getAppDataPath(): string {
    const platform = process.platform;
    const appName = 'ClipChimp';

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
    // Use provided path or default to .clipchimp.db in app data directory
    this.dbPath = dbPath || path.join(this.appDataPath, '.clipchimp.db');

    this.logger.log(`Initializing database at: ${this.dbPath}`);

    // Ensure parent directory exists
    const parentDir = path.dirname(this.dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Create or open database (better-sqlite3 handles this automatically)
    const isNew = !fs.existsSync(this.dbPath);
    this.db = new Database(this.dbPath);

    if (isNew) {
      this.logger.log('Created new database');
    } else {
      this.logger.log('Loaded existing database');
    }

    this.initializeSchema();
    this.logger.log('Database initialized successfully');

    // Set the library path for thumbnail service
    this.thumbnailService.setLibraryPath(this.dbPath);

    // After initialization is complete, check if FTS5 needs population
    this.checkAndPopulateFTS5();
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
    // Normalize both paths for comparison
    const normalizedAbsolute = path.normalize(absolutePath);
    const normalizedClipsFolder = path.normalize(clipsFolderPath);

    // Check if path is inside clips folder
    if (normalizedAbsolute.startsWith(normalizedClipsFolder)) {
      // Get relative path from clips folder
      const relativePath = path.relative(normalizedClipsFolder, normalizedAbsolute);
      return relativePath;
    }

    // If outside clips folder, keep absolute (shouldn't happen in normal operation)
    this.logger.warn(`Path outside clips folder: ${absolutePath}`);
    return absolutePath;
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

      -- Full-text search virtual tables using FTS5 for fast search
      CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS analyses_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
        video_id UNINDEXED,
        filename,
        current_path,
        ai_description,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS tags_fts USING fts5(
        video_id UNINDEXED,
        tag_name,
        tokenize='porter unicode61'
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

      -- Video tab items: Junction table for videos in tabs (many-to-many relationship)
      CREATE TABLE IF NOT EXISTS video_tab_items (
        id TEXT PRIMARY KEY,
        tab_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        FOREIGN KEY (tab_id) REFERENCES video_tabs(id) ON DELETE CASCADE,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
        UNIQUE(tab_id, video_id)
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
      CREATE INDEX IF NOT EXISTS idx_custom_markers_video ON custom_markers(video_id);
      CREATE INDEX IF NOT EXISTS idx_saved_links_status ON saved_links(status);
      CREATE INDEX IF NOT EXISTS idx_saved_links_date_added ON saved_links(date_added);
      CREATE INDEX IF NOT EXISTS idx_saved_links_url ON saved_links(url);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_primary ON media_relationships(primary_media_id);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_related ON media_relationships(related_media_id);
      CREATE INDEX IF NOT EXISTS idx_text_content_media ON text_content(media_id);
      CREATE INDEX IF NOT EXISTS idx_library_analytics_library ON library_analytics(library_id);
      CREATE INDEX IF NOT EXISTS idx_library_analytics_generated ON library_analytics(generated_at);
      CREATE INDEX IF NOT EXISTS idx_video_tabs_display_order ON video_tabs(display_order);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_tab ON video_tab_items(tab_id);
      CREATE INDEX IF NOT EXISTS idx_video_tab_items_video ON video_tab_items(video_id);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
            this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
          }
        }
      }
    } catch (error: any) {
      // Table might not exist yet (new installation) - silently ignore
      if (!error.message || !error.message.includes('no such table')) {
        this.logger.warn(`Migration check failed: ${error?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
            const ext = row.filename.substring(row.filename.lastIndexOf('.')).toLowerCase();
            updateStmt.run(ext, row.id);
          }

          this.saveDatabase();
          this.logger.log('Migration complete: file_extension column added');
        } catch (migrationError: any) {
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
        // SQLite doesn't support column renaming directly, so we need to recreate the table
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

        this.saveDatabase();
        this.logger.log('Migration complete: Renamed created_at to upload_date and added download_date');
      } catch (migrationError: any) {
        this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
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
          this.logger.error(`Migration failed: ${migrationError?.message || 'Unknown error'}`);
        }
      }
    }

  }

  /**
   * Check if FTS5 tables need population and populate them if needed
   * Called after database initialization is complete
   */
  private checkAndPopulateFTS5(): void {
    try {
      const db = this.ensureInitialized();

      // First, check if FTS5 tables exist by querying sqlite_master
      const tableCheckStmt = db.prepare(`
        SELECT COUNT(*) as count
        FROM sqlite_master
        WHERE type='table' AND name IN ('videos_fts', 'transcripts_fts', 'analyses_fts', 'tags_fts')
      `);
      const tableCheck = tableCheckStmt.get() as any;

      // If not all 4 FTS5 tables exist, create them
      if (tableCheck.count < 4) {
        this.logger.log('[Migration] Creating missing FTS5 search tables...');
        this.createFTS5Tables();
        this.logger.log('[Migration] FTS5 tables created');
      }

      // Check if FTS5 tables need to be populated by checking if they're empty
      const stmt = db.prepare("SELECT COUNT(*) as count FROM videos_fts");
      const result = stmt.get() as any;

      if (result.count === 0) {
        // Count total videos to populate
        const countStmt = db.prepare("SELECT COUNT(*) as count FROM videos");
        const countResult = countStmt.get() as any;

        if (countResult.count > 0) {
          this.logger.log(`[Migration] Populating FTS5 search indexes for ${countResult.count} existing videos...`);
          this.rebuildFTS5Indexes();
          this.logger.log('[Migration] FTS5 search indexes populated successfully');
        }
      }
    } catch (error: any) {
      this.logger.error(`[Migration] FTS5 setup failed: ${error?.message || 'Unknown error'}`);
      this.logger.error(error?.stack || error);
    }
  }

  /**
   * Create FTS5 virtual tables
   */
  private createFTS5Tables(): void {
    const db = this.ensureInitialized();

    const fts5Schema = `
      -- Drop existing FTS5 tables if they exist (in case of corruption)
      DROP TABLE IF EXISTS transcripts_fts;
      DROP TABLE IF EXISTS analyses_fts;
      DROP TABLE IF EXISTS videos_fts;
      DROP TABLE IF EXISTS tags_fts;

      -- Full-text search virtual tables using FTS5 for fast search
      CREATE VIRTUAL TABLE transcripts_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE analyses_fts USING fts5(
        video_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE videos_fts USING fts5(
        video_id UNINDEXED,
        filename,
        current_path,
        ai_description,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE tags_fts USING fts5(
        video_id UNINDEXED,
        tag_name,
        tokenize='porter unicode61'
      );
    `;

    db.exec(fts5Schema);
    this.saveDatabase();
  }

  /**
   * Rebuild FTS5 full-text search indexes from existing data
   * Call this after importing data or if search isn't working properly
   */
  rebuildFTS5Indexes(): void {
    const db = this.ensureInitialized();

    this.logger.log('[FTS5 Rebuild] Starting rebuild of FTS5 search indexes...');
    const startTime = Date.now();

    try {
      // Clear existing FTS5 data
      this.logger.log('[FTS5 Rebuild] Clearing existing FTS5 tables...');
      db.prepare('DELETE FROM videos_fts').run();
      db.prepare('DELETE FROM transcripts_fts').run();
      db.prepare('DELETE FROM analyses_fts').run();
      db.prepare('DELETE FROM tags_fts').run();

      // Populate videos_fts
      this.logger.log('[FTS5 Rebuild] Populating videos_fts...');
      const videosStmt = db.prepare('SELECT id, filename, current_path, ai_description FROM videos');
      const videos = videosStmt.all() as any[];

      const videoInsertStmt = db.prepare('INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)');
      for (const row of videos) {
        videoInsertStmt.run(row.id, row.filename, row.current_path || '', row.ai_description || '');
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${videos.length} videos`);

      // Populate transcripts_fts
      this.logger.log('[FTS5 Rebuild] Populating transcripts_fts...');
      const transcriptsStmt = db.prepare('SELECT video_id, plain_text FROM transcripts');
      const transcripts = transcriptsStmt.all() as any[];

      const transcriptInsertStmt = db.prepare('INSERT INTO transcripts_fts (video_id, content) VALUES (?, ?)');
      for (const row of transcripts) {
        transcriptInsertStmt.run(row.video_id, row.plain_text);
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${transcripts.length} transcripts`);

      // Populate analyses_fts
      this.logger.log('[FTS5 Rebuild] Populating analyses_fts...');
      const analysesStmt = db.prepare('SELECT video_id, ai_analysis, summary FROM analyses');
      const analyses = analysesStmt.all() as any[];

      const analysisInsertStmt = db.prepare('INSERT INTO analyses_fts (video_id, content) VALUES (?, ?)');
      for (const row of analyses) {
        const contentForSearch = [row.ai_analysis, row.summary].filter(Boolean).join(' ');
        analysisInsertStmt.run(row.video_id, contentForSearch);
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${analyses.length} analyses`);

      // Populate tags_fts
      this.logger.log('[FTS5 Rebuild] Populating tags_fts...');
      const tagsStmt = db.prepare('SELECT video_id, tag_name FROM tags');
      const tags = tagsStmt.all() as any[];

      const tagInsertStmt = db.prepare('INSERT INTO tags_fts (video_id, tag_name) VALUES (?, ?)');
      for (const row of tags) {
        tagInsertStmt.run(row.video_id, row.tag_name);
      }
      this.logger.log(`[FTS5 Rebuild] Populated ${tags.length} tags`);

      this.saveDatabase();

      const duration = Date.now() - startTime;
      this.logger.log(`[FTS5 Rebuild] Rebuild complete in ${duration}ms (${videos.length} videos, ${transcripts.length} transcripts, ${analyses.length} analyses, ${tags.length} tags)`);
    } catch (error: any) {
      this.logger.error(`[FTS5 Rebuild] Failed to rebuild FTS5 indexes: ${error?.message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Full-text search across all content using FTS5
   * Searches: filenames, transcripts, analyses, tags, descriptions
   *
   * Search features:
   * - Multiple words: ALL words must match (AND logic), but can be in different fields
   *   e.g., "foo bar" matches if "foo" is in filename and "bar" is in transcript
   * - Wildcards: * for prefix matching (e.g., "test*" matches "testing", "tests")
   *              ? for single character (converted to * for FTS5)
   * - Quoted phrases: "exact phrase" for consecutive word matching
   * - Special operators: OR, NOT (must be uppercase)
   *
   * @param query - Search query
   * @param limit - Maximum results to return
   * @returns Array of video IDs with match info, sorted by relevance
   */
  searchFTS(query: string, limit: number = 100): { videoId: string; score: number; matches: string[] }[] {
    const db = this.ensureInitialized();

    if (!query || query.trim().length === 0) {
      return [];
    }

    const trimmedQuery = query.trim();

    // Parse the query into tokens (words, phrases, operators)
    const tokens = this.parseSearchQuery(trimmedQuery);

    if (tokens.length === 0) {
      return [];
    }

    // this.logger.log(`[FTS Search] Query: "${trimmedQuery}" -> Tokens: ${JSON.stringify(tokens)}`);

    try {
      // For each token, find matching videos across all FTS tables
      // Then intersect results to find videos matching ALL tokens (AND logic)
      const tokenMatches: Map<string, { score: number; matches: Set<string> }>[] = [];

      for (const token of tokens) {
        const tokenResults = this.searchSingleToken(db, token, limit * 3);
        tokenMatches.push(tokenResults);
      }

      // Intersect results: video must match ALL tokens
      let finalResults: Map<string, { score: number; matches: Set<string> }>;

      if (tokenMatches.length === 1) {
        finalResults = tokenMatches[0];
      } else {
        // Start with first token's results
        finalResults = new Map(tokenMatches[0]);

        // Intersect with each subsequent token
        for (let i = 1; i < tokenMatches.length; i++) {
          const currentToken = tokenMatches[i];
          const newResults = new Map<string, { score: number; matches: Set<string> }>();

          // Only keep videos that exist in both sets
          for (const [videoId, data] of finalResults) {
            if (currentToken.has(videoId)) {
              const otherData = currentToken.get(videoId)!;
              // Combine scores and matches
              newResults.set(videoId, {
                score: data.score + otherData.score,
                matches: new Set([...data.matches, ...otherData.matches])
              });
            }
          }

          finalResults = newResults;

          // Early exit if no matches
          if (finalResults.size === 0) {
            break;
          }
        }
      }

      // Also do LIKE-based substring search for better partial matching
      // This catches cases like "video" matching "MyVideo-final.mp4"
      try {
        // Build LIKE pattern that requires all words
        const words = trimmedQuery.match(/"[^"]+"|[^\s]+/g) || [];
        const cleanWords = words.map(w => w.replace(/^"|"$/g, '').replace(/[*?]/g, ''));

        if (cleanWords.length > 0 && cleanWords.every(w => w.length > 0)) {
          // Each word must appear somewhere in filename or path
          const conditions = cleanWords.map(() =>
            '(filename LIKE ? COLLATE NOCASE OR current_path LIKE ? COLLATE NOCASE OR ai_description LIKE ? COLLATE NOCASE)'
          ).join(' AND ');

          const params: string[] = [];
          for (const word of cleanWords) {
            const pattern = `%${word}%`;
            params.push(pattern, pattern, pattern);
          }
          params.push(String(limit * 2));

          const likeResults = db.prepare(`
            SELECT id as video_id
            FROM videos
            WHERE ${conditions}
            LIMIT ?
          `).all(...params) as any[];

          for (const row of likeResults) {
            if (!finalResults.has(row.video_id)) {
              finalResults.set(row.video_id, { score: 0, matches: new Set() });
            }
            const entry = finalResults.get(row.video_id)!;
            entry.score += 15; // High score for direct match
            entry.matches.add('filename');
          }
        }
      } catch (e) {
        this.logger.warn('Error in LIKE filename search:', e);
      }

      // Convert to array and sort by score
      const sortedResults = Array.from(finalResults.entries())
        .map(([videoId, data]) => ({
          videoId,
          score: data.score,
          matches: Array.from(data.matches)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      // this.logger.log(`[FTS Search] Found ${sortedResults.length} results for "${trimmedQuery}"`);
      return sortedResults;
    } catch (error: any) {
      this.logger.error(`[FTS Search] Search failed: ${error?.message || 'Unknown error'}`);
      return [];
    }
  }

  /**
   * Parse search query into tokens
   * Handles: quoted phrases, wildcards, operators
   */
  private parseSearchQuery(query: string): string[] {
    const tokens: string[] = [];

    // Match quoted phrases or individual words
    const regex = /"([^"]+)"|(\S+)/g;
    let match;

    while ((match = regex.exec(query)) !== null) {
      const token = match[1] || match[2]; // match[1] is quoted content, match[2] is word

      // Skip OR operator (will be handled within tokens)
      // Keep NOT operator as part of the token
      if (token.toUpperCase() === 'OR') {
        // If previous token exists, mark it for OR logic
        if (tokens.length > 0) {
          tokens[tokens.length - 1] += ' OR';
        }
        continue;
      }

      if (token && token.trim().length > 0) {
        tokens.push(token.trim());
      }
    }

    return tokens;
  }

  /**
   * Search for a single token across all FTS tables
   */
  private searchSingleToken(
    db: any,
    token: string,
    limit: number
  ): Map<string, { score: number; matches: Set<string> }> {
    const results = new Map<string, { score: number; matches: Set<string> }>();

    // Check if token has OR suffix (from parseSearchQuery)
    const hasOr = token.endsWith(' OR');
    const cleanToken = hasOr ? token.slice(0, -3) : token;

    // Convert token to FTS5 query
    let ftsQuery = this.tokenToFTS5Query(cleanToken);

    // Search videos_fts (filename, path, description)
    try {
      const videosResults = db.prepare(`
        SELECT video_id, rank
        FROM videos_fts
        WHERE videos_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of videosResults) {
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank) * 2; // Videos weighted higher
        entry.matches.add('filename');
      }
    } catch (e) {
      // FTS5 query syntax error - try escaping
      this.logger.debug(`FTS5 videos search error for "${ftsQuery}":`, e);
    }

    // Search transcripts_fts
    try {
      const transcriptResults = db.prepare(`
        SELECT video_id, rank
        FROM transcripts_fts
        WHERE transcripts_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of transcriptResults) {
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank);
        entry.matches.add('transcript');
      }
    } catch (e) {
      this.logger.debug(`FTS5 transcript search error for "${ftsQuery}":`, e);
    }

    // Search analyses_fts
    try {
      const analysesResults = db.prepare(`
        SELECT video_id, rank
        FROM analyses_fts
        WHERE analyses_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of analysesResults) {
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank) * 1.5; // Analysis weighted medium
        entry.matches.add('analysis');
      }
    } catch (e) {
      this.logger.debug(`FTS5 analysis search error for "${ftsQuery}":`, e);
    }

    // Search tags_fts
    try {
      const tagsResults = db.prepare(`
        SELECT video_id, rank
        FROM tags_fts
        WHERE tags_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];

      for (const row of tagsResults) {
        if (!results.has(row.video_id)) {
          results.set(row.video_id, { score: 0, matches: new Set() });
        }
        const entry = results.get(row.video_id)!;
        entry.score += Math.abs(row.rank) * 3; // Tags weighted highest
        entry.matches.add('tags');
      }
    } catch (e) {
      this.logger.debug(`FTS5 tags search error for "${ftsQuery}":`, e);
    }

    return results;
  }

  /**
   * Convert a token to FTS5 query syntax
   */
  private tokenToFTS5Query(token: string): string {
    // Check if it's a phrase (contains spaces, originally was quoted)
    if (token.includes(' ')) {
      // Phrase query - must match consecutively
      return `"${token}"`;
    }

    // Handle NOT prefix
    if (token.toUpperCase().startsWith('NOT ')) {
      const term = token.slice(4);
      return `NOT ${this.tokenToFTS5Query(term)}`;
    }

    // Handle wildcards
    // * is already FTS5 compatible for prefix matching
    // ? is converted to * (FTS5 doesn't support single-char wildcards)
    let processed = token.replace(/\?/g, '*');

    // If no wildcard at end, add * for prefix matching (more forgiving search)
    // But not if it already has special characters or is very short
    if (!processed.includes('*') && processed.length >= 2) {
      processed = processed + '*';
    }

    return processed;
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
   * Generate SHA-256 hash of first 1MB of a file
   * Used for video file identification (handles renames, detects duplicates)
   *
   * @param filePath - Absolute path to the video file
   * @returns SHA-256 hash string
   */
  async hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, {
        start: 0,
        end: 1024 * 1024, // First 1MB only
      });

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
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
  }) {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();
    const downloadDate = video.downloadDate || now;

    // Determine media type from file extension if not provided
    let mediaType = video.mediaType;
    let fileExtension = video.fileExtension;

    if (!fileExtension && video.filename) {
      fileExtension = video.filename.substring(video.filename.lastIndexOf('.')).toLowerCase();
    }

    if (!mediaType && fileExtension) {
      mediaType = this.getMediaTypeFromExtension(fileExtension);
    }

    db.prepare(
      `INSERT OR REPLACE INTO videos (
        id, filename, file_hash, current_path, upload_date,
        duration_seconds, file_size_bytes, source_url, media_type, file_extension,
        download_date, last_verified, added_at, is_linked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      video.id,
      video.filename,
      video.fileHash,
      video.currentPath,
      video.uploadDate || null,
      video.durationSeconds || null,
      video.fileSizeBytes || null,
      video.sourceUrl || null,
      mediaType || 'video',
      fileExtension || null,
      downloadDate, // File's creation timestamp (when you downloaded it)
      now, // last_verified
      now, // added_at (when database entry was created)
    );

    // Insert/update FTS5 table for video search
    // Delete existing entry first (if any)
    db.prepare(`DELETE FROM videos_fts WHERE video_id = ?`).run(video.id);
    // Insert new entry
    db.prepare(
      `INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)`
    ).run(video.id, video.filename, video.currentPath || '', ''); // ai_description is empty initially, updated later

    this.saveDatabase();
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
           upload_date = ?,
           last_verified = ?,
           is_linked = 1
       WHERE id = ?`
    ).run(relativePath, uploadDate || null, new Date().toISOString(), id);

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

      // Update FTS5 table for video search
      // Get filename and current_path for the FTS5 update
      const stmt = db.prepare('SELECT filename, current_path FROM videos WHERE id = ?');
      const row = stmt.get(id) as { filename: string; current_path: string } | undefined;
      if (row) {
        db.prepare(`DELETE FROM videos_fts WHERE video_id = ?`).run(id);
        db.prepare(
          `INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)`
        ).run(id, row.filename, row.current_path, description || '');
      }

      this.saveDatabase();
      this.logger.log(`[AI Description] Successfully updated description for video ${id}`);
    } catch (error: any) {
      // If column doesn't exist yet (pre-migration), just log and continue
      if (error.message && error.message.includes('no such column: ai_description')) {
        this.logger.warn('ai_description column does not exist yet - skipping description update');
      } else {
        this.logger.error(`[AI Description] Failed to update description: ${error.message}`);
        throw error;
      }
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
      // If column doesn't exist yet (pre-migration), just log and continue
      if (error.message && error.message.includes('no such column: suggested_title')) {
        this.logger.warn('suggested_title column does not exist yet - skipping suggested title update');
      } else {
        this.logger.error(`[Suggested Title] Failed to update suggested title: ${error.message}`);
        throw error;
      }
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

      // Update FTS5 table for video search
      // Get current_path and ai_description for the FTS5 update
      const stmt = db.prepare('SELECT current_path, ai_description FROM videos WHERE id = ?');
      const row = stmt.get(id) as { current_path: string; ai_description: string | null } | undefined;
      if (row) {
        db.prepare(`DELETE FROM videos_fts WHERE video_id = ?`).run(id);
        db.prepare(
          `INSERT INTO videos_fts (video_id, filename, current_path, ai_description) VALUES (?, ?, ?, ?)`
        ).run(id, filename, row.current_path, row.ai_description || '');
      }

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
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children
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

    // Delete associated thumbnail
    this.thumbnailService.deleteThumbnail(id);

    db.prepare('DELETE FROM videos WHERE id = ?').run(id);

    this.saveDatabase();

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

    // Delete thumbnails for all unlinked videos
    const videoIds = unlinkedVideos.map(v => v.id);
    this.thumbnailService.deleteThumbnails(videoIds);

    // Delete all unlinked videos (CASCADE will handle related records)
    db.prepare('DELETE FROM videos WHERE is_linked = 0').run();

    this.saveDatabase();

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
   * Get all videos (excluding children - they are fetched separately via getChildVideos)
   */
  getAllVideos(options?: { linkedOnly?: boolean; limit?: number; offset?: number; includeChildren?: boolean }): VideoRecordWithFlags[] {
    const db = this.ensureInitialized();
    // has_transcript and has_analysis are now actual columns (maintained by triggers/updates)
    // suggested_title comes from the videos table itself, not from analyses
    let query = `
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM videos WHERE parent_id = v.id) THEN 1 ELSE 0 END as has_children
      FROM videos v
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
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    const results = params.length > 0 ? stmt.all(...params) : stmt.all();

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
          has_transcript: 0,
          has_analysis: 0,
          has_children: 0,
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
      new Date().toISOString(),
      transcript.transcriptionTimeSeconds || null,
    );

    // Update FTS5 table for transcript search
    // Delete existing entry first (if any)
    db.prepare(`DELETE FROM transcripts_fts WHERE video_id = ?`).run(transcript.videoId);
    // Insert new entry
    db.prepare(
      `INSERT INTO transcripts_fts (video_id, content) VALUES (?, ?)`
    ).run(transcript.videoId, transcript.plainText);

    // Update has_transcript flag in videos table
    db.prepare(
      `UPDATE videos SET has_transcript = 1 WHERE id = ?`
    ).run(transcript.videoId);

    this.saveDatabase();
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
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT OR REPLACE INTO analyses (
        video_id, ai_analysis, summary, sections_count, ai_model, ai_provider, analyzed_at, analysis_time_seconds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      analysis.videoId,
      analysis.aiAnalysis,
      analysis.summary || null,
      analysis.sectionsCount || null,
      analysis.aiModel,
      analysis.aiProvider || null,
      new Date().toISOString(),
      analysis.analysisTimeSeconds || null,
    );

    // Update FTS5 table for analysis search
    // Delete existing entry first (if any)
    db.prepare(`DELETE FROM analyses_fts WHERE video_id = ?`).run(analysis.videoId);
    // Insert new entry (combine analysis and summary for better search)
    const contentForSearch = [analysis.aiAnalysis, analysis.summary].filter(Boolean).join(' ');
    db.prepare(
      `INSERT INTO analyses_fts (video_id, content) VALUES (?, ?)`
    ).run(analysis.videoId, contentForSearch);

    // Update has_analysis flag in videos table
    db.prepare(
      `UPDATE videos SET has_analysis = 1 WHERE id = ?`
    ).run(analysis.videoId);

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
    // Delete only AI-generated sections (preserve user-created custom markers)
    this.deleteAIAnalysisSections(videoId);
    // Then delete the analysis record
    db.prepare('DELETE FROM analyses WHERE video_id = ?').run(videoId);
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
    db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(videoId);
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
  }) {
    const db = this.ensureInitialized();

    db.prepare(
      `INSERT INTO analysis_sections (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    );

    this.saveDatabase();
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

    // Update FTS5 table for tag search
    // Insert into tags_fts (don't delete first since multiple tags per video)
    db.prepare(
      `INSERT INTO tags_fts (video_id, tag_name) VALUES (?, ?)`
    ).run(tag.videoId, tag.tagName);

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
   * Full-text search in transcripts
   */
  searchTranscripts(query: string, limit = 50): TranscriptSearchRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT video_id, snippet(transcripts_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM transcripts_fts
      WHERE content MATCH ?
      LIMIT ?
    `);
    const results = stmt.all(query, limit) as TranscriptSearchRecord[];
    return results;
  }

  /**
   * Full-text search in analyses
   */
  searchAnalyses(query: string, limit = 50): AnalysisSearchRecord[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT video_id, snippet(analyses_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM analyses_fts
      WHERE content MATCH ?
      LIMIT ?
    `);
    const results = stmt.all(query, limit) as AnalysisSearchRecord[];
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

  /**
   * Build FTS5 query from user input with improved search logic
   *
   * Features:
   * - AND by default: "dad vax bribe" → matches videos with ALL terms
   * - Exclusion: "-full" → excludes videos containing "full"
   * - Quoted phrases: "exact phrase" → matches exact phrase
   * - Wildcards: dad* → matches dad, dads, daddy, etc.
   * - Explicit OR: dad OR vax → matches either term
   * - Prefix matching: partial terms automatically get * suffix
   *
   * Examples:
   * - "dad vax bribe" → dad AND vax AND bribe
   * - "vax -full" → vax AND NOT full (has vax, excludes full)
   * - '"anti vax"' → exact phrase "anti vax"
   * - "dad* vax*" → dad* AND vax* (prefix matching)
   * - "dad OR vax" → dad OR vax (explicit OR)
   * - "vax -full -complete" → vax AND NOT full AND NOT complete
   */
  private buildFTS5Query(query: string): string {
    query = query.trim();

    // Handle quoted phrases first (preserve them)
    const phrases: string[] = [];
    let processedQuery = query.replace(/"([^"]+)"/g, (match, phrase) => {
      const placeholder = `__PHRASE_${phrases.length}__`;
      phrases.push(`"${phrase}"`);
      return placeholder;
    });

    // Check if user explicitly used OR (case insensitive)
    const hasExplicitOr = /\s+OR\s+/i.test(processedQuery);

    // Split by whitespace and filter empty strings
    const terms = processedQuery.split(/\s+/).filter(t => t.length > 0);

    // Separate positive and negative terms
    const positiveTerms: string[] = [];
    const negativeTerms: string[] = [];

    // Process each term
    for (let term of terms) {
      // Restore phrases
      if (term.startsWith('__PHRASE_')) {
        const index = parseInt(term.replace('__PHRASE_', '').replace('__', ''));
        positiveTerms.push(phrases[index]);
        continue;
      }

      // Skip OR operator
      if (term.toUpperCase() === 'OR') {
        positiveTerms.push('OR');
        continue;
      }

      // Handle exclusion (NOT) with - prefix
      const isExclusion = term.startsWith('-');
      if (isExclusion) {
        term = term.substring(1); // Remove the - prefix
      }

      // Remove special characters except wildcards
      term = term.replace(/[^\w*]/g, '');

      // Skip empty terms
      if (!term) {
        continue;
      }

      // Add prefix wildcard if term doesn't already have one and is longer than 2 chars
      // This allows partial matching: "vax" matches "vaccine", "vax", "vaxxed", etc.
      if (!term.includes('*') && term.length > 2) {
        term = term + '*';
      }

      // Add to appropriate array
      if (isExclusion) {
        negativeTerms.push(term);
      } else {
        positiveTerms.push(term);
      }
    }

    // FTS5 requires at least one positive term before using NOT
    // If only negative terms exist, add a wildcard to match everything
    if (positiveTerms.length === 0 && negativeTerms.length > 0) {
      positiveTerms.push('*');
    }

    // Build the query
    let result = '';

    if (hasExplicitOr) {
      // User explicitly used OR, join positive terms as-is
      result = positiveTerms.join(' ');
    } else {
      // Default to implicit AND (space-separated)
      result = positiveTerms.join(' ');
    }

    // Add NOT terms (FTS5 syntax: "positive_term NOT negative_term")
    for (const negTerm of negativeTerms) {
      result += ` NOT ${negTerm}`;
    }

    return result;
  }

  /**
   * Search videos with full-text search across filename, AI description, transcripts, analyses, and tags
   * Uses FTS5 for high-performance full-text search
   * Returns video IDs that match the search query
   */
  searchVideos(
    query: string,
    limit: number = 1000,
    filters?: {
      filename?: boolean;
      aiDescription?: boolean;
      transcript?: boolean;
      analysis?: boolean;
      tags?: boolean;
    }
  ): SearchResultRecord[] {
    const db = this.ensureInitialized();

    if (!query || query.trim() === '') {
      return [];
    }

    // Prepare FTS5 query with improved search logic
    const searchTerm = this.buildFTS5Query(query);
    const results = new Map<string, { id: string; score: number; matchType: string }>();

    // Default all filters to true if not specified
    const searchFilters = {
      filename: filters?.filename !== false,
      aiDescription: filters?.aiDescription !== false,
      transcript: filters?.transcript !== false,
      analysis: filters?.analysis !== false,
      tags: filters?.tags !== false,
    };

    // Helper to add or update result
    const addResult = (videoId: string, score: number, matchType: string) => {
      const existing = results.get(videoId);
      if (!existing || existing.score < score) {
        results.set(videoId, { id: videoId, score, matchType });
      }
    };

    // 1. Search in video filename and AI description using FTS5 (highest priority)
    if (searchFilters.filename || searchFilters.aiDescription) {
      try {
        const stmt = db.prepare(`
          SELECT video_id, bm25(videos_fts) as score
          FROM videos_fts
          WHERE videos_fts MATCH ?
          ORDER BY bm25(videos_fts)
          LIMIT ?
        `);
        const rows = stmt.all(searchTerm, limit) as Array<{ video_id: string; score: number }>;

        for (const row of rows) {
          // FTS5 bm25 scores are negative, more negative = better match
          // Convert to positive score (100 = best, lower = worse)
          const score = 100 + Math.min(0, row.score);
          addResult(row.video_id, score, 'filename');
        }
      } catch (error) {
        this.logger.warn('Error searching videos FTS5 table:', error);
      }

      // Also do LIKE-based substring search on filename for better partial matching
      // This catches cases like "video" matching "MyVideo-final.mp4"
      try {
        const likePattern = `%${query.trim().replace(/\s+/g, '%')}%`;
        const stmt = db.prepare(`
          SELECT id as video_id
          FROM videos
          WHERE filename LIKE ? COLLATE NOCASE
             OR current_path LIKE ? COLLATE NOCASE
          LIMIT ?
        `);
        const rows = stmt.all(likePattern, likePattern, limit) as Array<{ video_id: string }>;

        for (const row of rows) {
          // Give LIKE matches high priority (95) since they're direct filename matches
          addResult(row.video_id, 95, 'filename');
        }
      } catch (error) {
        this.logger.warn('Error in LIKE filename search:', error);
      }
    }

    // 2. Search in transcripts using FTS5 (high priority)
    if (searchFilters.transcript) {
      try {
        const stmt = db.prepare(`
          SELECT video_id, bm25(transcripts_fts) as score
          FROM transcripts_fts
          WHERE transcripts_fts MATCH ?
          ORDER BY bm25(transcripts_fts)
          LIMIT ?
        `);
        const rows = stmt.all(searchTerm, limit) as Array<{ video_id: string; score: number }>;

        for (const row of rows) {
          const score = 80 + Math.min(0, row.score);
          addResult(row.video_id, score, 'transcript');
        }
      } catch (error) {
        this.logger.warn('Error searching transcripts FTS5:', error);
      }
    }

    // 3. Search in analyses using FTS5 (medium priority)
    if (searchFilters.analysis) {
      try {
        const stmt = db.prepare(`
          SELECT video_id, bm25(analyses_fts) as score
          FROM analyses_fts
          WHERE analyses_fts MATCH ?
          ORDER BY bm25(analyses_fts)
          LIMIT ?
        `);
        const rows = stmt.all(searchTerm, limit) as Array<{ video_id: string; score: number }>;

        for (const row of rows) {
          const score = 70 + Math.min(0, row.score);
          addResult(row.video_id, score, 'analysis');
        }
      } catch (error) {
        this.logger.warn('Error searching analyses FTS5:', error);
      }

      // Also search in analysis sections (still using LIKE since no FTS5 table for sections)
      try {
        const searchLike = `%${query.toLowerCase().trim()}%`;
        const stmt = db.prepare(`
          SELECT DISTINCT video_id
          FROM analysis_sections
          WHERE lower(title) LIKE ? OR lower(description) LIKE ?
          LIMIT ?
        `);
        const rows = stmt.all(searchLike, searchLike, limit) as Array<{ video_id: string }>;

        for (const row of rows) {
          addResult(row.video_id, 65, 'section');
        }
      } catch (error) {
        this.logger.warn('Error searching analysis sections:', error);
      }
    }

    // 4. Search in tags using FTS5 (lower priority)
    if (searchFilters.tags) {
      try {
        const stmt = db.prepare(`
          SELECT video_id, bm25(tags_fts) as score
          FROM tags_fts
          WHERE tags_fts MATCH ?
          ORDER BY bm25(tags_fts)
          LIMIT ?
        `);
        const rows = stmt.all(searchTerm, limit) as Array<{ video_id: string; score: number }>;

        for (const row of rows) {
          const score = 60 + Math.min(0, row.score);
          addResult(row.video_id, score, 'tag');
        }
      } catch (error) {
        this.logger.warn('Error searching tags FTS5:', error);
      }
    }

    // Convert map to array and sort by score (descending)
    const sortedResults = Array.from(results.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return sortedResults;
  }

  // ============================================================================
  // SAVED LINKS OPERATIONS
  // ============================================================================

  /**
   * Insert a new saved link
   */
  insertSavedLink(savedLink: {
    id: string;
    url: string;
    title?: string;
    status?: string;
    metadata?: any;
  }) {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();
    const metadataJson = savedLink.metadata ? JSON.stringify(savedLink.metadata) : null;

    db.prepare(
      `INSERT INTO saved_links (
        id, url, title, status, date_added, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      savedLink.id,
      savedLink.url,
      savedLink.title || null,
      savedLink.status || 'pending',
      now,
      metadataJson,
    );

    this.saveDatabase();
  }

  /**
   * Find saved link by ID
   */
  findSavedLinkById(id: string): SavedLinkRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM saved_links WHERE id = ?');
    const result = stmt.get(id) as SavedLinkRecord | undefined;

    // Parse metadata JSON if present
    if (result && result.metadata) {
      try {
        result.metadata = JSON.parse(result.metadata as string);
      } catch (e) {
        this.logger.warn(`Failed to parse metadata for saved link ${id}`);
      }
    }

    return result || null;
  }

  /**
   * Find saved link by URL
   */
  findSavedLinkByUrl(url: string): SavedLinkRecord | null {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM saved_links WHERE url = ?');
    const result = stmt.get(url) as SavedLinkRecord | undefined;

    // Parse metadata JSON if present
    if (result && result.metadata) {
      try {
        result.metadata = JSON.parse(result.metadata as string);
      } catch (e) {
        this.logger.warn(`Failed to parse metadata for saved link with url ${url}`);
      }
    }

    return result || null;
  }

  /**
   * Get all saved links
   */
  getAllSavedLinks(status?: string): SavedLinkRecord[] {
    const db = this.ensureInitialized();
    let query = 'SELECT * FROM saved_links';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY date_added DESC';

    const stmt = db.prepare(query);
    const results = (params.length > 0 ? stmt.all(...params) : stmt.all()) as SavedLinkRecord[];

    // Parse metadata JSON if present
    for (const row of results) {
      if (row.metadata) {
        try {
          row.metadata = JSON.parse(row.metadata as string);
        } catch (e) {
          this.logger.warn(`Failed to parse metadata for saved link ${row.id}`);
        }
      }
    }

    return results;
  }

  /**
   * Update saved link status
   */
  updateSavedLinkStatus(
    id: string,
    status: string,
    errorMessage?: string,
    downloadPath?: string,
    thumbnailPath?: string,
  ) {
    const db = this.ensureInitialized();
    const now = new Date().toISOString();

    const dateCompleted = (status === 'completed' || status === 'failed') ? now : null;

    db.prepare(
      `UPDATE saved_links
       SET status = ?,
           error_message = ?,
           download_path = ?,
           thumbnail_path = ?,
           date_completed = ?
       WHERE id = ?`
    ).run(
      status,
      errorMessage || null,
      downloadPath || null,
      thumbnailPath || null,
      dateCompleted,
      id,
    );

    this.saveDatabase();
  }

  /**
   * Link saved link to a video
   */
  linkSavedLinkToVideo(savedLinkId: string, videoId: string) {
    const db = this.ensureInitialized();

    db.prepare(
      `UPDATE saved_links SET video_id = ? WHERE id = ?`
    ).run(videoId, savedLinkId);

    this.saveDatabase();
  }

  /**
   * Update saved link title
   */
  updateSavedLinkTitle(id: string, title: string) {
    const db = this.ensureInitialized();

    db.prepare(
      `UPDATE saved_links SET title = ? WHERE id = ?`
    ).run(title, id);

    this.saveDatabase();
  }

  /**
   * Delete saved link by ID
   */
  deleteSavedLink(id: string) {
    const db = this.ensureInitialized();
    db.prepare('DELETE FROM saved_links WHERE id = ?').run(id);
    this.saveDatabase();
  }

  /**
   * Count saved links by status
   */
  countSavedLinksByStatus(status?: string): number {
    const db = this.ensureInitialized();
    let query = 'SELECT COUNT(*) as count FROM saved_links';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    const stmt = db.prepare(query);
    const result = (params.length > 0 ? stmt.get(...params) : stmt.get()) as { count: number };

    return Number(result.count) || 0;
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

  /**
   * Search text content (for documents)
   */
  searchTextContent(query: string, limit = 50): TextContentSearchRecord[] {
    const db = this.ensureInitialized();
    const searchTerm = query.toLowerCase().trim();

    const stmt = db.prepare(`
      SELECT tc.media_id, tc.extracted_text, v.filename, v.media_type
      FROM text_content tc
      JOIN videos v ON tc.media_id = v.id
      WHERE lower(tc.extracted_text) LIKE ?
      LIMIT ?
    `);
    const results = stmt.all(`%${searchTerm}%`, limit) as TextContentSearchRecord[];
    return results;
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
        INSERT INTO video_tab_items (id, tab_id, video_id, added_at, display_order)
        VALUES (?, ?, ?, ?, ?)
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
