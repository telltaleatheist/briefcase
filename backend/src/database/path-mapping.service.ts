import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface PathMappingConfig {
  computerId: string;
  computerName: string;
  os: string;
  nasRoot: string;
  pathMappings: {
    clips: string;
    downloads: string;
    imports: string;
    libraries: string;
    [key: string]: string; // Allow dynamic keys
  };
  createdAt: string;
  lastUpdated: string;
}

/**
 * PathMappingService
 *
 * Handles translation between NAS-relative paths (stored in database)
 * and absolute paths (used by the local computer).
 *
 * Example:
 *   Database stores: "clips/2025-01-15/video.mp4"
 *   Mac Studio translates to: "/Volumes/Callisto/clips/2025-01-15/video.mp4"
 *   MacBook Air translates to: "/Volumes/Enceladus/clips/2025-01-15/video.mp4"
 *   Windows PC translates to: "C:\Ariel\clips\2025-01-15\video.mp4"
 */
@Injectable()
export class PathMappingService {
  private readonly logger = new Logger(PathMappingService.name);
  private config: PathMappingConfig | null = null;
  private configPath: string;

  constructor() {
    // Store config in user's home directory (survives app updates)
    this.configPath = path.join(os.homedir(), '.clippy-path-mapping.json');
  }

  /**
   * Check if path mapping is configured
   */
  isConfigured(): boolean {
    return fs.existsSync(this.configPath);
  }

  /**
   * Load path mapping configuration
   */
  loadConfig(): PathMappingConfig {
    if (!this.config) {
      if (!this.isConfigured()) {
        throw new Error('Path mapping not configured. Please run setup wizard.');
      }

      const content = fs.readFileSync(this.configPath, 'utf-8');
      this.config = JSON.parse(content);
      this.logger.log(`Loaded path mapping for computer: ${this.config!.computerName}`);
    }

    return this.config!;
  }

  /**
   * Save path mapping configuration
   */
  saveConfig(config: PathMappingConfig): void {
    config.lastUpdated = new Date().toISOString();
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.config = config;
    this.logger.log(`Saved path mapping for computer: ${config.computerName}`);
  }

  /**
   * Get current computer ID
   */
  getComputerId(): string {
    const config = this.loadConfig();
    return config.computerId;
  }

  /**
   * Convert absolute path to NAS-relative path (for storing in database)
   *
   * Examples:
   *   "/Volumes/Callisto/clips/video.mp4" → "clips/video.mp4"
   *   "C:\Ariel\clips\video.mp4" → "clips/video.mp4"
   */
  toRelativePath(absolutePath: string): string {
    const config = this.loadConfig();

    // Normalize path separators to forward slashes
    const normalized = absolutePath.replace(/\\/g, '/');

    // Try each path mapping to find which one matches
    for (const [key, mountPoint] of Object.entries(config.pathMappings)) {
      const normalizedMount = mountPoint.replace(/\\/g, '/');

      if (normalized.startsWith(normalizedMount)) {
        // Strip mount point, keep relative path
        const relative = normalized.substring(normalizedMount.length);
        const result = `${key}${relative}`.replace(/^\/+/, '');

        this.logger.debug(`Converted absolute → relative: ${absolutePath} → ${result}`);
        return result;
      }
    }

    // Fallback: try nasRoot
    const normalizedRoot = config.nasRoot.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedRoot)) {
      const result = normalized.substring(normalizedRoot.length).replace(/^\/+/, '');
      this.logger.debug(`Converted absolute → relative (via nasRoot): ${absolutePath} → ${result}`);
      return result;
    }

    throw new Error(
      `Path "${absolutePath}" is not under NAS root. ` +
      `NAS root: ${config.nasRoot}, Mappings: ${JSON.stringify(config.pathMappings)}`
    );
  }

  /**
   * Convert NAS-relative path to absolute path (for reading from database)
   *
   * Examples:
   *   "clips/video.mp4" → "/Volumes/Callisto/clips/video.mp4" (Mac Studio)
   *   "clips/video.mp4" → "/Volumes/Enceladus/clips/video.mp4" (MacBook Air)
   *   "clips/video.mp4" → "C:\Ariel\clips\video.mp4" (Windows)
   */
  toAbsolutePath(relativePath: string): string {
    const config = this.loadConfig();

    // Normalize path separators
    const normalized = relativePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const rootFolder = parts[0]; // "clips", "downloads", "imports", "libraries"

    // Look up the mapping
    if (config.pathMappings[rootFolder]) {
      const mountPoint = config.pathMappings[rootFolder];
      const restOfPath = parts.slice(1).join(path.sep);
      const result = path.join(mountPoint, restOfPath);

      this.logger.debug(`Converted relative → absolute: ${relativePath} → ${result}`);
      return result;
    }

    // Fallback: append to nasRoot
    const result = path.join(config.nasRoot, normalized.replace(/\//g, path.sep));
    this.logger.debug(`Converted relative → absolute (via nasRoot): ${relativePath} → ${result}`);
    return result;
  }

  /**
   * Check if a file exists (automatically translates path)
   */
  exists(relativePath: string): boolean {
    try {
      const absolutePath = this.toAbsolutePath(relativePath);
      return fs.existsSync(absolutePath);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get file stats (automatically translates path)
   */
  stat(relativePath: string): fs.Stats | null {
    try {
      const absolutePath = this.toAbsolutePath(relativePath);
      return fs.statSync(absolutePath);
    } catch (error) {
      return null;
    }
  }

  /**
   * Generate a computer ID
   */
  static generateComputerId(): string {
    const platform = os.platform();
    const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '-');
    const timestamp = Date.now();
    return `${platform}-${hostname}-${timestamp}`;
  }

  /**
   * Create initial path mapping configuration
   */
  static createConfig(options: {
    computerName: string;
    nasRoot: string;
    clipsFolder: string;
    downloadsFolder?: string;
    importsFolder?: string;
    librariesFolder?: string;
  }): PathMappingConfig {
    return {
      computerId: PathMappingService.generateComputerId(),
      computerName: options.computerName,
      os: os.platform(),
      nasRoot: options.nasRoot,
      pathMappings: {
        clips: options.clipsFolder,
        downloads: options.downloadsFolder || path.join(options.nasRoot, 'downloads'),
        imports: options.importsFolder || path.join(options.nasRoot, 'imports'),
        libraries: options.librariesFolder || path.join(options.nasRoot, 'libraries'),
      },
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }
}
