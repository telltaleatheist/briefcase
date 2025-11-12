import { Injectable, Logger } from '@nestjs/common';
import initSqlJs, { Database } from 'sql.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * DatabaseService - Manages SQLite database for the Bulk Analysis Library system
 *
 * This service provides:
 * - Database initialization and schema management
 * - CRUD operations for videos, transcripts, analyses, tags
 * - File hashing for video identification
 * - Full-text search capabilities
 *
 * Now using sql.js (pure JavaScript SQLite) instead of better-sqlite3
 */
@Injectable()
export class DatabaseService {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database | null = null;
  private dbPath: string | null = null;
  private readonly appDataPath: string;
  private SQL: any = null;

  constructor() {
    // Base directory: ~/Library/Application Support/clippy
    this.appDataPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'clippy',
    );

    // Ensure directory exists
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }

    this.logger.log('DatabaseService created (not initialized)');
  }

  /**
   * Initialize database connection with a specific database file
   * @param dbPath - Path to the database file (optional, uses default if not provided)
   */
  async initializeDatabase(dbPath?: string) {
    // Use provided path or default to clippy.db
    this.dbPath = dbPath || path.join(this.appDataPath, 'clippy.db');

    this.logger.log(`Initializing database at: ${this.dbPath}`);

    // Initialize sql.js
    if (!this.SQL) {
      this.SQL = await initSqlJs();
    }

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
      this.logger.log('Loaded existing database');
    } else {
      this.db = new this.SQL.Database();
      this.logger.log('Created new database');
    }

    this.initializeSchema();
    this.saveDatabase();
    this.logger.log('Database initialized successfully');
  }

  /**
   * Save database to disk
   */
  private saveDatabase() {
    if (!this.db || !this.dbPath) {
      return;
    }

    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (error: any) {
      this.logger.error(`Error saving database: ${error?.message || 'Unknown error'}`);
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
  private ensureInitialized(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initializeDatabase() first or create a library.');
    }
    return this.db;
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
        FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
        CHECK (is_linked IN (0, 1))
      );

      -- Transcripts table: Stores both plain text and SRT format transcripts
      CREATE TABLE IF NOT EXISTS transcripts (
        video_id TEXT PRIMARY KEY,
        plain_text TEXT NOT NULL,
        srt_format TEXT,
        whisper_model TEXT,
        language TEXT,
        transcribed_at TEXT NOT NULL,
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

      -- Full-text search tables (using regular tables since sql.js doesn't include FTS5)
      CREATE TABLE IF NOT EXISTS transcripts_fts (
        video_id TEXT NOT NULL,
        content TEXT,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS analyses_fts (
        video_id TEXT NOT NULL,
        content TEXT,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
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
    `;

    // Execute table creation
    db.exec(tableSchema);
    this.logger.log('Database tables created');

    // Run schema migrations for existing databases BEFORE creating indexes
    this.runSchemaMigrations();

    // Now create indexes (after migrations have run)
    const indexSchema = `
      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_videos_filename ON videos(filename);
      CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(file_hash);
      CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);
      CREATE INDEX IF NOT EXISTS idx_videos_download_date ON videos(download_date);
      CREATE INDEX IF NOT EXISTS idx_videos_is_linked ON videos(is_linked);
      CREATE INDEX IF NOT EXISTS idx_videos_parent_id ON videos(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tags_video ON tags(video_id);
      CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(tag_name);
      CREATE INDEX IF NOT EXISTS idx_sections_video ON analysis_sections(video_id);
      CREATE INDEX IF NOT EXISTS idx_custom_markers_video ON custom_markers(video_id);
      CREATE INDEX IF NOT EXISTS idx_saved_links_status ON saved_links(status);
      CREATE INDEX IF NOT EXISTS idx_saved_links_date_added ON saved_links(date_added);
      CREATE INDEX IF NOT EXISTS idx_saved_links_url ON saved_links(url);
      CREATE INDEX IF NOT EXISTS idx_transcripts_fts_video ON transcripts_fts(video_id);
      CREATE INDEX IF NOT EXISTS idx_analyses_fts_video ON analyses_fts(video_id);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_primary ON media_relationships(primary_media_id);
      CREATE INDEX IF NOT EXISTS idx_media_relationships_related ON media_relationships(related_media_id);
      CREATE INDEX IF NOT EXISTS idx_text_content_media ON text_content(media_id);
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
      stmt.step();
      const result = stmt.getAsObject() as any;
      stmt.free();

      // If table exists and is empty, check for custom markers in analysis_sections
      if (result.count === 0) {
        const checkStmt = db.prepare("SELECT COUNT(*) as count FROM analysis_sections WHERE source = 'user' OR category = 'custom'");
        checkStmt.step();
        const checkResult = checkStmt.getAsObject() as any;
        checkStmt.free();

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
          const updates: Array<{id: string, ext: string}> = [];
          while (stmt.step()) {
            const row = stmt.getAsObject() as any;
            const ext = row.filename.substring(row.filename.lastIndexOf('.')).toLowerCase();
            updates.push({id: row.id, ext});
          }
          stmt.free();

          // Apply updates
          for (const update of updates) {
            db.run('UPDATE videos SET file_extension = ? WHERE id = ?', [update.ext, update.id]);
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
      const columns: string[] = [];

      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        columns.push(row.name);
      }
      stmt.free();

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
  }

  /**
   * Get the database instance for raw queries
   */
  getDatabase(): Database {
    return this.ensureInitialized();
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

    db.run(
      `INSERT INTO videos (
        id, filename, file_hash, current_path, upload_date,
        duration_seconds, file_size_bytes, source_url, media_type, file_extension,
        download_date, last_verified, added_at, is_linked
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
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
      ]
    );

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
  findVideoByFilename(filename: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE filename = ?');
    stmt.bind([filename]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
  }

  /**
   * Find video by file hash
   */
  findVideoByHash(hash: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE file_hash = ?');
    stmt.bind([hash]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
  }

  /**
   * Find video by ID
   */
  findVideoById(id: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE id = ?');
    stmt.bind([id]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
  }

  /**
   * Update video path (for relinking moved files)
   */
  updateVideoPath(id: string, newPath: string, uploadDate?: string) {
    const db = this.ensureInitialized();

    db.run(
      `UPDATE videos
       SET current_path = ?,
           upload_date = ?,
           last_verified = ?,
           is_linked = 1
       WHERE id = ?`,
      [newPath, uploadDate || null, new Date().toISOString(), id]
    );

    this.saveDatabase();
  }

  /**
   * Update video metadata (upload_date and added_at)
   */
  updateVideoMetadata(id: string, uploadDate: string | null, addedAt: string) {
    const db = this.ensureInitialized();

    db.run(
      `UPDATE videos
       SET upload_date = ?,
           added_at = ?
       WHERE id = ?`,
      [uploadDate, addedAt, id]
    );

    this.saveDatabase();
  }

  /**
   * Update video's source URL
   */
  updateVideoSourceUrl(id: string, sourceUrl: string | null) {
    const db = this.ensureInitialized();

    try {
      db.run(
        `UPDATE videos
         SET source_url = ?
         WHERE id = ?`,
        [sourceUrl, id]
      );

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
      db.run(
        `UPDATE videos
         SET ai_description = ?
         WHERE id = ?`,
        [description, id]
      );

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

  /**
   * Update video's filename
   */
  updateVideoFilename(id: string, filename: string) {
    const db = this.ensureInitialized();

    try {
      db.run(
        `UPDATE videos
         SET filename = ?
         WHERE id = ?`,
        [filename, id]
      );

      this.saveDatabase();
    } catch (error) {
      this.logger.error(`Failed to update filename for video ${id}:`, error);
      throw error;
    }
  }

  /**
   * Get video by ID
   */
  getVideoById(id: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM videos WHERE id = ?');
    stmt.bind([id]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
  }

  /**
   * Mark video as unlinked (file not found)
   */
  markVideoUnlinked(id: string) {
    const db = this.ensureInitialized();
    db.run('UPDATE videos SET is_linked = 0 WHERE id = ?', [id]);
    this.saveDatabase();
  }

  /**
   * Delete a video from the database
   * This will cascade delete all related records (transcripts, analyses, tags, sections)
   * Returns the video record before deletion so caller can delete physical file
   */
  deleteVideo(id: string) {
    const db = this.ensureInitialized();

    // Get video info before deleting (for file path)
    const video = this.getVideoById(id);
    if (!video) {
      throw new Error('Video not found');
    }

    this.logger.log(`Deleting video ${id} and all related data`);

    db.run('DELETE FROM videos WHERE id = ?', [id]);

    this.saveDatabase();

    return video;
  }

  /**
   * Prune/cleanup orphaned videos (videos marked as unlinked)
   * Deletes all database records for videos where is_linked = 0
   * Returns count of deleted videos
   */
  pruneOrphanedVideos(): { deletedCount: number; deletedVideos: Array<{ id: string; filename: string }> } {
    const db = this.ensureInitialized();

    // Get list of unlinked videos before deleting
    const stmt = db.prepare('SELECT id, filename FROM videos WHERE is_linked = 0');
    const unlinkedVideos: Array<{ id: string; filename: string }> = [];

    while (stmt.step()) {
      unlinkedVideos.push(stmt.getAsObject() as any);
    }
    stmt.free();

    if (unlinkedVideos.length === 0) {
      this.logger.log('No orphaned videos to prune');
      return { deletedCount: 0, deletedVideos: [] };
    }

    this.logger.log(`Pruning ${unlinkedVideos.length} orphaned videos from database`);

    // Delete all unlinked videos (CASCADE will handle related records)
    db.run('DELETE FROM videos WHERE is_linked = 0');

    this.saveDatabase();

    return {
      deletedCount: unlinkedVideos.length,
      deletedVideos: unlinkedVideos
    };
  }

  /**
   * Get all videos (excluding children - they are fetched separately via getChildVideos)
   */
  getAllVideos(options?: { linkedOnly?: boolean; limit?: number; offset?: number; includeChildren?: boolean }) {
    const db = this.ensureInitialized();
    // Use subqueries instead of LEFT JOINs to prevent duplicate rows
    // when there are multiple transcripts or analyses for a video
    let query = `
      SELECT
        v.*,
        CASE WHEN EXISTS (SELECT 1 FROM transcripts WHERE video_id = v.id) THEN 1 ELSE 0 END as has_transcript,
        CASE WHEN EXISTS (SELECT 1 FROM analyses WHERE video_id = v.id) THEN 1 ELSE 0 END as has_analysis,
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

    query += ' ORDER BY v.added_at DESC';

    if (options?.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    stmt.bind(params);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Get all videos in hierarchical structure (parents with their children)
   * Returns a flat array with children immediately following their parent
   */
  getAllVideosHierarchical(options?: { linkedOnly?: boolean }) {
    // Get all parent/root videos
    const parents = this.getAllVideos({
      linkedOnly: options?.linkedOnly,
      includeChildren: false
    });

    const results: any[] = [];

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
  }) {
    const db = this.ensureInitialized();

    db.run(
      `INSERT OR REPLACE INTO transcripts (
        video_id, plain_text, srt_format, whisper_model, language, transcribed_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        transcript.videoId,
        transcript.plainText,
        transcript.srtFormat,
        transcript.whisperModel || null,
        transcript.language || null,
        new Date().toISOString(),
      ]
    );

    // Insert into FTS table
    db.run(
      `INSERT INTO transcripts_fts (video_id, content) VALUES (?, ?)`,
      [transcript.videoId, transcript.plainText]
    );

    this.saveDatabase();
  }

  /**
   * Get transcript for a video
   */
  getTranscript(videoId: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM transcripts WHERE video_id = ?');
    stmt.bind([videoId]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
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
  }) {
    const db = this.ensureInitialized();

    db.run(
      `INSERT OR REPLACE INTO analyses (
        video_id, ai_analysis, summary, sections_count, ai_model, ai_provider, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        analysis.videoId,
        analysis.aiAnalysis,
        analysis.summary || null,
        analysis.sectionsCount || null,
        analysis.aiModel,
        analysis.aiProvider || null,
        new Date().toISOString(),
      ]
    );

    // Insert into FTS table
    db.run(
      `INSERT INTO analyses_fts (video_id, content) VALUES (?, ?)`,
      [analysis.videoId, analysis.aiAnalysis]
    );

    this.saveDatabase();
  }

  /**
   * Get analysis for a video
   */
  getAnalysis(videoId: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM analyses WHERE video_id = ?');
    stmt.bind([videoId]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
  }

  /**
   * Delete analysis for a video (only deletes AI-generated sections, preserves user markers)
   */
  deleteAnalysis(videoId: string) {
    const db = this.ensureInitialized();
    // Delete only AI-generated sections (preserve user-created custom markers)
    this.deleteAIAnalysisSections(videoId);
    // Then delete the analysis record
    db.run('DELETE FROM analyses WHERE video_id = ?', [videoId]);
    this.logger.log(`Deleted AI analysis for video ${videoId}`);
  }

  /**
   * Delete only AI-generated analysis sections for a video (preserves user markers)
   */
  deleteAIAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM analysis_sections WHERE video_id = ? AND source = ?', [videoId, 'ai']);
    this.logger.log(`Deleted AI analysis sections for video ${videoId} (preserving user markers)`);
  }

  /**
   * Delete all analysis sections for a video (including user markers)
   * WARNING: This deletes everything. Use deleteAIAnalysisSections to preserve user markers.
   */
  deleteAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM analysis_sections WHERE video_id = ?', [videoId]);
    this.logger.log(`Deleted ALL analysis sections for video ${videoId}`);
  }

  /**
   * Delete a specific analysis section by ID
   */
  deleteAnalysisSection(sectionId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM analysis_sections WHERE id = ?', [sectionId]);
    this.logger.log(`Deleted analysis section ${sectionId}`);
  }

  /**
   * Delete all tags for a video
   */
  deleteTagsForVideo(videoId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM tags WHERE video_id = ?', [videoId]);
    this.logger.log(`Deleted tags for video ${videoId}`);
  }

  /**
   * Delete a specific tag by ID
   */
  deleteTag(tagId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM tags WHERE id = ?', [tagId]);
    this.saveDatabase();
    this.logger.log(`Deleted tag ${tagId}`);
  }

  /**
   * Delete transcript for a video
   */
  deleteTranscript(videoId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM transcripts WHERE video_id = ?', [videoId]);
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

    db.run(
      `INSERT INTO analysis_sections (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        section.id,
        section.videoId,
        section.startSeconds,
        section.endSeconds,
        section.timestampText || null,
        section.title || null,
        section.description || null,
        section.category || null,
        section.source || 'ai',
      ]
    );

    this.saveDatabase();
  }

  /**
   * Get all sections for a video (both AI and custom markers)
   */
  getAnalysisSections(videoId: string) {
    const db = this.ensureInitialized();

    // Get AI-generated sections
    const aiStmt = db.prepare(
      'SELECT *, \'ai\' as source FROM analysis_sections WHERE video_id = ? ORDER BY start_seconds'
    );
    aiStmt.bind([videoId]);

    const aiResults: any[] = [];
    while (aiStmt.step()) {
      aiResults.push(aiStmt.getAsObject());
    }
    aiStmt.free();

    // Get custom markers
    const customStmt = db.prepare(
      'SELECT *, \'user\' as source FROM custom_markers WHERE video_id = ? ORDER BY start_seconds'
    );
    customStmt.bind([videoId]);

    const customResults: any[] = [];
    while (customStmt.step()) {
      customResults.push(customStmt.getAsObject());
    }
    customStmt.free();

    // Merge and sort by start time
    const allSections = [...aiResults, ...customResults];
    allSections.sort((a: any, b: any) => a.start_seconds - b.start_seconds);

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

    db.run(
      `INSERT INTO custom_markers (
        id, video_id, start_seconds, end_seconds, timestamp_text, title, description, category, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        marker.id,
        marker.videoId,
        marker.startSeconds,
        marker.endSeconds,
        marker.timestampText || null,
        marker.title || null,
        marker.description || null,
        marker.category || 'custom',
        new Date().toISOString(),
      ]
    );

    this.saveDatabase();
  }

  /**
   * Get all custom markers for a video
   */
  getCustomMarkers(videoId: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare(
      'SELECT * FROM custom_markers WHERE video_id = ? ORDER BY start_seconds'
    );
    stmt.bind([videoId]);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Delete a specific custom marker by ID
   */
  deleteCustomMarker(markerId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM custom_markers WHERE id = ?', [markerId]);
    this.saveDatabase();
    this.logger.log(`Deleted custom marker ${markerId}`);
  }

  /**
   * Delete all custom markers for a video
   */
  deleteCustomMarkers(videoId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM custom_markers WHERE video_id = ?', [videoId]);
    this.saveDatabase();
    this.logger.log(`Deleted all custom markers for video ${videoId}`);
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

    db.run(
      `INSERT INTO tags (id, video_id, tag_name, tag_type, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        tag.id,
        tag.videoId,
        tag.tagName,
        tag.tagType || null,
        tag.confidence || null,
        tag.source || null,
        new Date().toISOString(),
      ]
    );

    this.saveDatabase();
    return tag.id;
  }

  /**
   * Get all tags for a video
   */
  getTags(videoId: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM tags WHERE video_id = ?');
    stmt.bind([videoId]);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Get all tags with counts, grouped by type
   */
  getAllTagsWithCounts() {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT tag_name, tag_type, COUNT(*) as count
      FROM tags
      GROUP BY tag_name, tag_type
      ORDER BY count DESC, tag_name ASC
    `);

    const tags: Array<{ tag_name: string; tag_type: string; count: number }> = [];
    while (stmt.step()) {
      tags.push(stmt.getAsObject() as any);
    }
    stmt.free();

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
    stmt.bind(tagNames.map(t => t.toLowerCase()));

    const results: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push(row.video_id);
    }

    console.log(`[getVideoIdsByTags] Searching for tags:`, tagNames, `Found ${results.length} videos`);

    // Debug: Let's see what tags exist in the database
    const allTagsStmt = db.prepare(`SELECT DISTINCT tag_name FROM tags LIMIT 20`);
    const sampleTags: string[] = [];
    while (allTagsStmt.step()) {
      const row = allTagsStmt.getAsObject() as any;
      sampleTags.push(row.tag_name);
    }
    allTagsStmt.free();
    console.log(`[getVideoIdsByTags] Sample tags in database:`, sampleTags);
    stmt.free();

    return results;
  }

  /**
   * Full-text search in transcripts
   */
  searchTranscripts(query: string, limit = 50) {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT video_id, snippet(transcripts_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM transcripts_fts
      WHERE content MATCH ?
      LIMIT ?
    `);
    stmt.bind([query, limit]);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Full-text search in analyses
   */
  searchAnalyses(query: string, limit = 50) {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT video_id, snippet(analyses_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
      FROM analyses_fts
      WHERE content MATCH ?
      LIMIT ?
    `);
    stmt.bind([query, limit]);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Get database statistics
   */
  getStats() {
    const db = this.ensureInitialized();

    const getCount = (query: string): number => {
      const stmt = db.prepare(query);
      stmt.step();
      const result = stmt.getAsObject() as any;
      stmt.free();
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
   * Search videos with full-text search across filename, AI description, transcripts, analyses, and tags
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
  ): Array<{ id: string; score: number; matchType: string }> {
    const db = this.ensureInitialized();

    if (!query || query.trim() === '') {
      return [];
    }

    const searchTerm = query.toLowerCase().trim();
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

    // 1. Search in video filename and AI description (highest priority)
    if (searchFilters.filename || searchFilters.aiDescription) {
      try {
        const conditions: string[] = [];
        if (searchFilters.filename) conditions.push('lower(filename) LIKE ?');
        if (searchFilters.aiDescription) conditions.push('lower(ai_description) LIKE ?');

        const stmt = db.prepare(`
          SELECT id, filename, ai_description
          FROM videos
          WHERE ${conditions.join(' OR ')}
          LIMIT ?
        `);

        const bindParams: any[] = [];
        if (searchFilters.filename) bindParams.push(`%${searchTerm}%`);
        if (searchFilters.aiDescription) bindParams.push(`%${searchTerm}%`);
        bindParams.push(limit);

        stmt.bind(bindParams);

        while (stmt.step()) {
          const row = stmt.getAsObject() as { id: string; filename: string; ai_description: string | null };
          const filename = (row.filename || '').toLowerCase();
          const aiDesc = (row.ai_description || '').toLowerCase();

          if (searchFilters.filename && filename.includes(searchTerm)) {
            addResult(row.id, 100, 'filename');
          } else if (searchFilters.aiDescription && aiDesc.includes(searchTerm)) {
            addResult(row.id, 90, 'ai_description');
          }
        }
        stmt.free();
      } catch (error) {
        this.logger.warn('Error searching videos table:', error);
      }
    }

    // 2. Search in transcripts (high priority)
    if (searchFilters.transcript) {
      try {
      const stmt = db.prepare(`
        SELECT video_id, plain_text
        FROM transcripts
        WHERE lower(plain_text) LIKE ?
        LIMIT ?
      `);
      stmt.bind([`%${searchTerm}%`, limit]);

      while (stmt.step()) {
        const row = stmt.getAsObject() as { video_id: string; plain_text: string };
        addResult(row.video_id, 80, 'transcript');
      }
        stmt.free();
      } catch (error) {
        this.logger.warn('Error searching transcripts:', error);
      }
    }

    // 3. Search in analyses (medium priority)
    if (searchFilters.analysis) {
      try {
      const stmt = db.prepare(`
        SELECT video_id, ai_analysis, summary
        FROM analyses
        WHERE lower(ai_analysis) LIKE ? OR lower(summary) LIKE ?
        LIMIT ?
      `);
      stmt.bind([`%${searchTerm}%`, `%${searchTerm}%`, limit]);

      while (stmt.step()) {
        const row = stmt.getAsObject() as { video_id: string };
        addResult(row.video_id, 70, 'analysis');
      }
        stmt.free();
      } catch (error) {
        this.logger.warn('Error searching analyses:', error);
      }

      // Also search in analysis sections
      try {
        const stmt = db.prepare(`
          SELECT DISTINCT video_id, title, description
          FROM analysis_sections
          WHERE lower(title) LIKE ? OR lower(description) LIKE ?
          LIMIT ?
        `);
        stmt.bind([`%${searchTerm}%`, `%${searchTerm}%`, limit]);

        while (stmt.step()) {
          const row = stmt.getAsObject() as { video_id: string };
          addResult(row.video_id, 65, 'section');
        }
        stmt.free();
      } catch (error) {
        this.logger.warn('Error searching analysis sections:', error);
      }
    }

    // 4. Search in tags (lower priority)
    if (searchFilters.tags) {
      try{
      const stmt = db.prepare(`
        SELECT DISTINCT video_id, tag_name
        FROM tags
        WHERE lower(tag_name) LIKE ?
        LIMIT ?
      `);
      stmt.bind([`%${searchTerm}%`, limit]);

      while (stmt.step()) {
        const row = stmt.getAsObject() as { video_id: string };
        addResult(row.video_id, 60, 'tag');
      }
        stmt.free();
      } catch (error) {
        this.logger.warn('Error searching tags:', error);
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

    db.run(
      `INSERT INTO saved_links (
        id, url, title, status, date_added, metadata
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        savedLink.id,
        savedLink.url,
        savedLink.title || null,
        savedLink.status || 'pending',
        now,
        metadataJson,
      ]
    );

    this.saveDatabase();
  }

  /**
   * Find saved link by ID
   */
  findSavedLinkById(id: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM saved_links WHERE id = ?');
    stmt.bind([id]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    // Parse metadata JSON if present
    if (result && result.metadata) {
      try {
        result.metadata = JSON.parse(result.metadata as string);
      } catch (e) {
        this.logger.warn(`Failed to parse metadata for saved link ${id}`);
      }
    }

    return result;
  }

  /**
   * Find saved link by URL
   */
  findSavedLinkByUrl(url: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM saved_links WHERE url = ?');
    stmt.bind([url]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    // Parse metadata JSON if present
    if (result && result.metadata) {
      try {
        result.metadata = JSON.parse(result.metadata as string);
      } catch (e) {
        this.logger.warn(`Failed to parse metadata for saved link with url ${url}`);
      }
    }

    return result;
  }

  /**
   * Get all saved links
   */
  getAllSavedLinks(status?: string): any[] {
    const db = this.ensureInitialized();
    let query = 'SELECT * FROM saved_links';
    const params: any[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY date_added DESC';

    const stmt = db.prepare(query);
    if (params.length > 0) {
      stmt.bind(params);
    }

    const results: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      // Parse metadata JSON if present
      if (row.metadata) {
        try {
          row.metadata = JSON.parse(row.metadata as string);
        } catch (e) {
          this.logger.warn(`Failed to parse metadata for saved link ${row.id}`);
        }
      }
      results.push(row);
    }
    stmt.free();

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

    db.run(
      `UPDATE saved_links
       SET status = ?,
           error_message = ?,
           download_path = ?,
           thumbnail_path = ?,
           date_completed = ?
       WHERE id = ?`,
      [
        status,
        errorMessage || null,
        downloadPath || null,
        thumbnailPath || null,
        dateCompleted,
        id,
      ]
    );

    this.saveDatabase();
  }

  /**
   * Link saved link to a video
   */
  linkSavedLinkToVideo(savedLinkId: string, videoId: string) {
    const db = this.ensureInitialized();

    db.run(
      `UPDATE saved_links SET video_id = ? WHERE id = ?`,
      [videoId, savedLinkId]
    );

    this.saveDatabase();
  }

  /**
   * Update saved link title
   */
  updateSavedLinkTitle(id: string, title: string) {
    const db = this.ensureInitialized();

    db.run(
      `UPDATE saved_links SET title = ? WHERE id = ?`,
      [title, id]
    );

    this.saveDatabase();
  }

  /**
   * Delete saved link by ID
   */
  deleteSavedLink(id: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM saved_links WHERE id = ?', [id]);
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
    if (params.length > 0) {
      stmt.bind(params);
    }

    const result = stmt.step() ? stmt.getAsObject() : { count: 0 };
    stmt.free();

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

    db.run(
      `INSERT INTO media_relationships (
        id, primary_media_id, related_media_id, relationship_type, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        relationship.id,
        relationship.primaryMediaId,
        relationship.relatedMediaId,
        relationship.relationshipType,
        now,
      ]
    );

    this.saveDatabase();
  }

  /**
   * Get all related media for a given media item
   */
  getRelatedMedia(mediaId: string) {
    const db = this.ensureInitialized();

    // Get relationships where this item is primary
    const primaryStmt = db.prepare(`
      SELECT r.*, v.filename, v.current_path, v.media_type, v.file_extension
      FROM media_relationships r
      JOIN videos v ON r.related_media_id = v.id
      WHERE r.primary_media_id = ?
    `);
    primaryStmt.bind([mediaId]);

    const primaryResults: any[] = [];
    while (primaryStmt.step()) {
      primaryResults.push(primaryStmt.getAsObject());
    }
    primaryStmt.free();

    // Get relationships where this item is related
    const relatedStmt = db.prepare(`
      SELECT r.*, v.filename, v.current_path, v.media_type, v.file_extension
      FROM media_relationships r
      JOIN videos v ON r.primary_media_id = v.id
      WHERE r.related_media_id = ?
    `);
    relatedStmt.bind([mediaId]);

    const relatedResults: any[] = [];
    while (relatedStmt.step()) {
      relatedResults.push(relatedStmt.getAsObject());
    }
    relatedStmt.free();

    return [...primaryResults, ...relatedResults];
  }

  /**
   * Delete a media relationship
   */
  deleteMediaRelationship(relationshipId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM media_relationships WHERE id = ?', [relationshipId]);
    this.saveDatabase();
    this.logger.log(`Deleted media relationship ${relationshipId}`);
  }

  /**
   * Delete all relationships for a media item
   */
  deleteAllMediaRelationships(mediaId: string) {
    const db = this.ensureInitialized();
    db.run(
      'DELETE FROM media_relationships WHERE primary_media_id = ? OR related_media_id = ?',
      [mediaId, mediaId]
    );
    this.saveDatabase();
    this.logger.log(`Deleted all media relationships for ${mediaId}`);
  }

  // ============================================================================
  // PARENT-CHILD OPERATIONS
  // ============================================================================

  /**
   * Set a video as a child of another video (parent-child relationship)
   * @param childId - ID of the child video
   * @param parentId - ID of the parent video (null to remove parent)
   */
  setVideoParent(childId: string, parentId: string | null) {
    const db = this.ensureInitialized();

    // Validate that the child exists
    const child = this.getVideoById(childId);
    if (!child) {
      throw new Error(`Child video not found: ${childId}`);
    }

    // Validate that the parent exists (if provided)
    if (parentId) {
      const parent = this.getVideoById(parentId);
      if (!parent) {
        throw new Error(`Parent video not found: ${parentId}`);
      }

      // Prevent child from being its own parent
      if (childId === parentId) {
        throw new Error('A video cannot be its own parent');
      }

      // Prevent a child from becoming a parent (children can't have children)
      if (parent.parent_id) {
        throw new Error('Cannot set a child video as a parent. Only root-level videos can be parents.');
      }

      // Prevent circular references - check if parent is already a child of this video
      const parentRecord = this.getVideoById(parentId);
      if (parentRecord && parentRecord.parent_id === childId) {
        throw new Error('Circular parent-child relationship not allowed');
      }
    }

    db.run(
      'UPDATE videos SET parent_id = ? WHERE id = ?',
      [parentId, childId]
    );

    this.saveDatabase();
    this.logger.log(`Set parent for video ${childId}: ${parentId || 'none'}`);
  }

  /**
   * Get all children of a parent video
   * @param parentId - ID of the parent video
   * @returns Array of child videos
   */
  getChildVideos(parentId: string): any[] {
    const db = this.ensureInitialized();
    const stmt = db.prepare(`
      SELECT * FROM videos
      WHERE parent_id = ?
      ORDER BY added_at ASC
    `);
    stmt.bind([parentId]);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Get the parent of a video (if it has one)
   * @param videoId - ID of the video
   * @returns Parent video or null
   */
  getParentVideo(videoId: string): any | null {
    const video = this.getVideoById(videoId);

    if (!video || !video.parent_id) {
      return null;
    }

    return this.getVideoById(video.parent_id as string);
  }

  /**
   * Check if a video has any children
   * @param videoId - ID of the video
   * @returns True if video has children
   */
  hasChildren(videoId: string): boolean {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM videos WHERE parent_id = ?');
    stmt.bind([videoId]);
    stmt.step();
    const result = stmt.getAsObject() as any;
    stmt.free();

    return result.count > 0;
  }

  /**
   * Remove all children from a parent (set their parent_id to null)
   * @param parentId - ID of the parent video
   */
  removeAllChildren(parentId: string) {
    const db = this.ensureInitialized();
    db.run('UPDATE videos SET parent_id = NULL WHERE parent_id = ?', [parentId]);
    this.saveDatabase();
    this.logger.log(`Removed all children from parent ${parentId}`);
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

    db.run(
      `INSERT OR REPLACE INTO text_content (
        media_id, extracted_text, extraction_method, extracted_at
      ) VALUES (?, ?, ?, ?)`,
      [
        textContent.mediaId,
        textContent.extractedText,
        textContent.extractionMethod || null,
        now,
      ]
    );

    this.saveDatabase();
  }

  /**
   * Get extracted text content for a document
   */
  getTextContent(mediaId: string) {
    const db = this.ensureInitialized();
    const stmt = db.prepare('SELECT * FROM text_content WHERE media_id = ?');
    stmt.bind([mediaId]);

    const result = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();

    return result;
  }

  /**
   * Delete text content for a document
   */
  deleteTextContent(mediaId: string) {
    const db = this.ensureInitialized();
    db.run('DELETE FROM text_content WHERE media_id = ?', [mediaId]);
    this.saveDatabase();
    this.logger.log(`Deleted text content for ${mediaId}`);
  }

  /**
   * Search text content (for documents)
   */
  searchTextContent(query: string, limit = 50) {
    const db = this.ensureInitialized();
    const searchTerm = query.toLowerCase().trim();

    const stmt = db.prepare(`
      SELECT tc.media_id, tc.extracted_text, v.filename, v.media_type
      FROM text_content tc
      JOIN videos v ON tc.media_id = v.id
      WHERE lower(tc.extracted_text) LIKE ?
      LIMIT ?
    `);
    stmt.bind([`%${searchTerm}%`, limit]);

    const results: any[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  }

  /**
   * Close database connection
   */
  onModuleDestroy() {
    if (this.db) {
      this.saveDatabase();
      this.db.close();
      this.logger.log('Database connection closed');
    }
  }
}
