import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { DatabaseService } from './database.service';

/**
 * Library configuration stored in settings
 */
export interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

interface LibraryManagerConfig {
  activeLibraryId: string | null;
  libraries: ClipLibrary[];
}

/**
 * LibraryManagerService - Manages multiple clip libraries
 *
 * Each library has:
 * - Unique ID
 * - Name (user-friendly)
 * - SQLite database file
 * - Clips folder (where imported videos are copied)
 *
 * Libraries are stored in: ~/Library/Application Support/clippy/libraries/
 * Configuration stored in: ~/Library/Application Support/clippy/libraries-config.json
 */
@Injectable()
export class LibraryManagerService implements OnModuleInit {
  private readonly logger = new Logger(LibraryManagerService.name);
  private readonly appDataPath: string;
  private readonly librariesBasePath: string;
  private readonly configFilePath: string;
  private config: LibraryManagerConfig;

  constructor(private readonly databaseService: DatabaseService) {
    // Base directory: ~/Library/Application Support/clippy
    this.appDataPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'clippy',
    );

    // Libraries directory: ~/Library/Application Support/clippy/libraries
    this.librariesBasePath = path.join(this.appDataPath, 'libraries');

    // Config file
    this.configFilePath = path.join(this.appDataPath, 'libraries-config.json');

    // Ensure directories exist
    if (!fs.existsSync(this.appDataPath)) {
      fs.mkdirSync(this.appDataPath, { recursive: true });
    }
    if (!fs.existsSync(this.librariesBasePath)) {
      fs.mkdirSync(this.librariesBasePath, { recursive: true });
    }

    // Load or initialize config
    this.config = this.loadConfig();
    this.logger.log(`Loaded library configuration: ${this.config.libraries.length} libraries`);
  }

  /**
   * Lifecycle hook - called after module initialization
   * Automatically loads the active library database on startup
   */
  async onModuleInit() {
    const startTime = Date.now();
    this.logger.log('[onModuleInit] Starting library manager initialization...');

    const activeLibrary = this.getActiveLibrary();
    if (activeLibrary) {
      this.logger.log(`[onModuleInit] Auto-loading active library: ${activeLibrary.name} (${activeLibrary.id})`);
      const initStart = Date.now();
      await this.initializeActiveLibrary();
      this.logger.log(`[onModuleInit] ✓ Library initialized in ${Date.now() - initStart}ms`);
    } else {
      this.logger.log('[onModuleInit] No active library to load on startup');
    }

    this.logger.log(`[onModuleInit] Total initialization took ${Date.now() - startTime}ms`);
  }

  /**
   * Load library configuration from disk
   */
  private loadConfig(): LibraryManagerConfig {
    if (fs.existsSync(this.configFilePath)) {
      try {
        const data = fs.readFileSync(this.configFilePath, 'utf8');
        return JSON.parse(data);
      } catch (error: any) {
        this.logger.error(`Error loading library config: ${error?.message || 'Unknown error'}`);
      }
    }

    // Default: empty configuration
    return {
      activeLibraryId: null,
      libraries: [],
    };
  }

  /**
   * Save library configuration to disk
   */
  private saveConfig() {
    try {
      fs.writeFileSync(
        this.configFilePath,
        JSON.stringify(this.config, null, 2),
        'utf8',
      );
    } catch (error: any) {
      this.logger.error(`Error saving library config: ${error?.message || 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Get all libraries
   */
  getAllLibraries(): ClipLibrary[] {
    return this.config.libraries;
  }

  /**
   * Get active library
   */
  getActiveLibrary(): ClipLibrary | null {
    if (!this.config.activeLibraryId) {
      return null;
    }
    return this.config.libraries.find(
      (lib) => lib.id === this.config.activeLibraryId,
    ) || null;
  }

  /**
   * Create a new clip library
   * @param name - Library name
   * @param clipsFolderPath - User-selected path where videos will be stored
   */
  async createLibrary(name: string, clipsFolderPath: string): Promise<ClipLibrary> {
    const id = `lib_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const libraryPath = path.join(this.librariesBasePath, id);

    // Create library directory for database
    fs.mkdirSync(libraryPath, { recursive: true });

    // Ensure clips folder exists (user-provided path)
    if (!fs.existsSync(clipsFolderPath)) {
      fs.mkdirSync(clipsFolderPath, { recursive: true });
    }

    // Database path (stored in system location)
    const databasePath = path.join(libraryPath, 'library.db');

    const library: ClipLibrary = {
      id,
      name,
      databasePath,
      clipsFolderPath, // Use user-provided path
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    };

    // Add to config
    this.config.libraries.push(library);

    // Set as active if it's the first library
    if (this.config.libraries.length === 1) {
      this.config.activeLibraryId = id;
    }

    this.saveConfig();

    this.logger.log(`Created new library: ${name} (${id}) with clips folder: ${clipsFolderPath}`);

    // Initialize database for this library if it's now active
    if (this.config.activeLibraryId === id) {
      await this.databaseService.initializeDatabase(databasePath);
    }

    return library;
  }

  /**
   * Switch to a different library
   */
  async switchLibrary(libraryId: string): Promise<boolean> {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    // Update active library
    this.config.activeLibraryId = libraryId;
    library.lastAccessedAt = new Date().toISOString();
    this.saveConfig();

    // Initialize database for this library
    await this.databaseService.initializeDatabase(library.databasePath);

    this.logger.log(`Switched to library: ${library.name} (${libraryId})`);
    return true;
  }

  /**
   * Delete a library (removes from config and optionally deletes files)
   */
  async deleteLibrary(libraryId: string, deleteFiles = false): Promise<boolean> {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    // If deleting the active library, switch to another one first
    if (this.config.activeLibraryId === libraryId) {
      const otherLibraries = this.config.libraries.filter((lib) => lib.id !== libraryId);
      if (otherLibraries.length > 0) {
        // Switch to the first available library
        this.config.activeLibraryId = otherLibraries[0].id;
        this.logger.log(`Switched to library: ${otherLibraries[0].name} (${otherLibraries[0].id})`);
      } else {
        // No other libraries, set to null
        this.config.activeLibraryId = null;
        this.logger.log('No libraries remaining, setting activeLibraryId to null');
      }
    }

    // Remove from config
    this.config.libraries = this.config.libraries.filter(
      (lib) => lib.id !== libraryId,
    );
    this.saveConfig();

    // Optionally delete files
    if (deleteFiles) {
      const libraryPath = path.dirname(library.databasePath);
      try {
        fs.rmSync(libraryPath, { recursive: true, force: true });
        this.logger.log(`Deleted library files: ${libraryPath}`);
      } catch (error: any) {
        this.logger.error(`Error deleting library files: ${error?.message || 'Unknown error'}`);
      }
    }

    this.logger.log(`Deleted library: ${library.name} (${libraryId})`);
    return true;
  }

  /**
   * Rename a library
   */
  renameLibrary(libraryId: string, newName: string): boolean {
    const library = this.config.libraries.find((lib) => lib.id === libraryId);

    if (!library) {
      this.logger.warn(`Library not found: ${libraryId}`);
      return false;
    }

    library.name = newName;
    this.saveConfig();

    this.logger.log(`Renamed library ${libraryId} to: ${newName}`);
    return true;
  }

  /**
   * Check if database is initialized and ready
   */
  isDatabaseReady(): boolean {
    return this.databaseService.isInitialized();
  }

  /**
   * Initialize the active library's database (for app startup)
   */
  async initializeActiveLibrary(): Promise<boolean> {
    const activeLibrary = this.getActiveLibrary();

    if (!activeLibrary) {
      this.logger.warn('No active library found');
      return false;
    }

    await this.databaseService.initializeDatabase(activeLibrary.databasePath);
    activeLibrary.lastAccessedAt = new Date().toISOString();
    this.saveConfig();

    return true;
  }
}
