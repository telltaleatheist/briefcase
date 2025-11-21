import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { LibraryManagerService } from './library-manager.service';

@Injectable()
export class IgnoreService {
  private readonly logger = new Logger(IgnoreService.name);
  private ignorePatterns: string[] = [];
  private ignoreFilePath: string | null = null;

  constructor(private libraryManager: LibraryManagerService) {}

  /**
   * Get the ignore file path for the active library
   */
  private getIgnoreFilePath(): string | null {
    const activeLibrary = this.libraryManager.getActiveLibrary();
    if (!activeLibrary) {
      this.logger.warn('No active library found');
      return null;
    }

    return path.join(activeLibrary.clipsFolderPath, '.clippyignore');
  }

  /**
   * Load ignore patterns from .clippyignore file
   */
  loadIgnorePatterns(): string[] {
    this.ignoreFilePath = this.getIgnoreFilePath();

    if (!this.ignoreFilePath) {
      return [];
    }

    try {
      if (!fs.existsSync(this.ignoreFilePath)) {
        // Create default ignore file with common patterns
        const defaultPatterns = [
          '# Clippy Ignore File',
          '# Add patterns to ignore files (supports wildcards like .gitignore)',
          '',
          '# macOS metadata files',
          '._*',
          '.DS_Store',
          '',
          '# Thumbnails',
          'Thumbs.db',
        ].join('\n');

        fs.writeFileSync(this.ignoreFilePath, defaultPatterns, 'utf-8');
        this.logger.log(`Created default .clippyignore file at: ${this.ignoreFilePath}`);
      }

      const content = fs.readFileSync(this.ignoreFilePath, 'utf-8');

      // Parse patterns: ignore comments and empty lines
      this.ignorePatterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      return this.ignorePatterns;
    } catch (error: any) {
      this.logger.error(`Failed to load ignore patterns: ${error.message}`);
      return [];
    }
  }

  /**
   * Check if a file should be ignored based on patterns
   */
  shouldIgnore(filePath: string): boolean {
    const filename = path.basename(filePath);

    // Always reload patterns to ensure they're up to date
    this.loadIgnorePatterns();

    // Get the clips folder path to make relative paths
    const activeLibrary = this.libraryManager.getActiveLibrary();
    const clipsFolder = activeLibrary?.clipsFolderPath || '';

    for (const pattern of this.ignorePatterns) {
      // If pattern contains a slash, match against relative path
      if (pattern.includes('/') || pattern.includes('\\')) {
        // Get relative path from clips folder
        let relativePath = filePath;
        if (clipsFolder && filePath.startsWith(clipsFolder)) {
          relativePath = filePath.substring(clipsFolder.length);
          // Remove leading slash
          if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
            relativePath = relativePath.substring(1);
          }
        }

        // Normalize path separators
        relativePath = relativePath.replace(/\\/g, '/');
        const normalizedPattern = pattern.replace(/\\/g, '/');

        if (this.matchPattern(relativePath, normalizedPattern)) {
          return true;
        }
      } else {
        // Pattern has no slash, match against filename only
        if (this.matchPattern(filename, pattern)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Match a filename or path against a pattern (supports wildcards)
   * Similar to .gitignore pattern matching
   */
  private matchPattern(target: string, pattern: string): boolean {
    // Convert glob pattern to regex
    // Escape special regex characters except * and ?
    let regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special chars
      .replace(/\*/g, '.*')                   // * matches anything
      .replace(/\?/g, '.');                   // ? matches single char

    // If pattern doesn't start with *, also try matching if target contains the pattern
    const hasLeadingWildcard = pattern.startsWith('*');

    // Add anchors for exact match
    regexPattern = `^${regexPattern}$`;

    const regex = new RegExp(regexPattern, 'i'); // Case-insensitive

    // First try exact match
    if (regex.test(target)) {
      return true;
    }

    // If pattern doesn't have leading wildcard, try matching against end of path
    // This allows "folder/*" to match "path/to/folder/*"
    if (!hasLeadingWildcard && pattern.includes('/')) {
      const wildcardPattern = `.*${regexPattern.substring(1)}`;
      const wildcardRegex = new RegExp(wildcardPattern, 'i');
      return wildcardRegex.test(target);
    }

    return false;
  }

  /**
   * Get all ignore patterns
   */
  getIgnorePatterns(): string[] {
    this.loadIgnorePatterns();
    return this.ignorePatterns;
  }

  /**
   * Get the raw content of .clippyignore file
   */
  getIgnoreFileContent(): string | null {
    this.ignoreFilePath = this.getIgnoreFilePath();

    if (!this.ignoreFilePath) {
      return null;
    }

    try {
      // Create file if it doesn't exist
      this.loadIgnorePatterns();

      return fs.readFileSync(this.ignoreFilePath, 'utf-8');
    } catch (error: any) {
      this.logger.error(`Failed to read ignore file: ${error.message}`);
      return null;
    }
  }

  /**
   * Update the .clippyignore file content
   */
  updateIgnoreFileContent(content: string): boolean {
    this.ignoreFilePath = this.getIgnoreFilePath();

    if (!this.ignoreFilePath) {
      this.logger.error('Cannot update ignore file: no active library');
      return false;
    }

    try {
      fs.writeFileSync(this.ignoreFilePath, content, 'utf-8');
      this.logger.log('Updated .clippyignore file');

      // Reload patterns
      this.loadIgnorePatterns();

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to update ignore file: ${error.message}`);
      return false;
    }
  }

  /**
   * Add a pattern to the ignore file
   */
  addIgnorePattern(pattern: string): boolean {
    this.ignoreFilePath = this.getIgnoreFilePath();

    if (!this.ignoreFilePath) {
      this.logger.error('Cannot add pattern: no active library');
      return false;
    }

    try {
      // Load current content
      this.loadIgnorePatterns();

      // Check if pattern already exists
      if (this.ignorePatterns.includes(pattern)) {
        this.logger.log(`Pattern already exists: ${pattern}`);
        return true;
      }

      // Append pattern to file
      const content = fs.readFileSync(this.ignoreFilePath, 'utf-8');
      const newContent = content.trim() + '\n' + pattern + '\n';

      fs.writeFileSync(this.ignoreFilePath, newContent, 'utf-8');
      this.logger.log(`Added pattern to .clippyignore: ${pattern}`);

      // Reload patterns
      this.loadIgnorePatterns();

      return true;
    } catch (error: any) {
      this.logger.error(`Failed to add pattern: ${error.message}`);
      return false;
    }
  }

  /**
   * Get the ignore file path
   */
  getIgnoreFilePathString(): string | null {
    return this.getIgnoreFilePath();
  }
}
