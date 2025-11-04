// clippy/backend/src/library/relink.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { LibraryService } from './library.service';
import { RelinkResult } from './interfaces/library.interface';

@Injectable()
export class RelinkService {
  private readonly logger = new Logger(RelinkService.name);
  private readonly clipsBasePath = '/Volumes/Callisto/clips';

  constructor(private libraryService: LibraryService) {}

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
   * Auto-relink video by searching in clips collection
   */
  async autoRelinkVideo(analysisId: string): Promise<RelinkResult> {
    try {
      const analysis = await this.libraryService.getAnalysis(analysisId);

      if (!analysis) {
        return { success: false, reason: 'Analysis not found' };
      }

      // Calculate expected week folder
      const weekFolder = this.calculateWeekFolder(new Date(analysis.createdAt));
      const weekPath = path.join(this.clipsBasePath, weekFolder);

      // Check if week folder exists
      if (!fsSync.existsSync(weekPath)) {
        return {
          success: false,
          reason: `Week folder not found: ${weekFolder}`
        };
      }

      // Get all video files in week folder
      const files = await fs.readdir(weekPath);
      const videoFiles = files.filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));

      if (videoFiles.length === 0) {
        return {
          success: false,
          reason: 'No video files found in week folder'
        };
      }

      // Score each file by similarity to analysis title
      const candidates = await Promise.all(
        videoFiles.map(async (filename) => {
          const fullPath = path.join(weekPath, filename);
          const score = this.calculateSimilarity(analysis.title, filename);

          // Get file stats
          const stats = await fs.stat(fullPath);

          return {
            filename,
            fullPath,
            score,
            size: stats.size,
          };
        })
      );

      // Sort by score (highest first)
      candidates.sort((a, b) => b.score - a.score);

      if (candidates.length === 0) {
        return {
          success: false,
          reason: 'No suitable candidates found'
        };
      }

      // If top match is very confident (>0.7), suggest it
      if (candidates[0].score > 0.7) {
        return {
          success: true,
          suggestedPath: candidates[0].fullPath,
          confidence: 'high',
          candidates: candidates.slice(0, 5), // Return top 5
        };
      }

      // Otherwise, return list of candidates for user to choose
      return {
        success: true,
        confidence: 'low',
        candidates: candidates.slice(0, 5),
      };

    } catch (error) {
      this.logger.error(`Auto-relink failed: ${(error as Error).message}`);
      return {
        success: false,
        reason: `Error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Manual relink - verify video exists and update library
   */
  async manualRelink(analysisId: string, newVideoPath: string): Promise<RelinkResult> {
    try {
      // Check if file exists
      if (!fsSync.existsSync(newVideoPath)) {
        return {
          success: false,
          reason: 'Video file does not exist'
        };
      }

      // Check if it's a video file
      const ext = path.extname(newVideoPath).toLowerCase();
      if (!['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
        return {
          success: false,
          reason: 'Not a valid video file'
        };
      }

      // Update analysis in library
      const analysis = await this.libraryService.getAnalysis(analysisId);
      if (!analysis) {
        return { success: false, reason: 'Analysis not found' };
      }

      // Calculate week folder from path if in clips collection
      let weekFolder = analysis.video.clipsWeekFolder;
      if (newVideoPath.startsWith(this.clipsBasePath)) {
        const relativePath = path.relative(this.clipsBasePath, newVideoPath);
        const parts = relativePath.split(path.sep);
        if (parts.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
          weekFolder = parts[0];
        }
      }

      await this.libraryService.updateAnalysis(analysisId, {
        videoCurrentPath: newVideoPath,
        videoIsLinked: true,
        clipsWeekFolder: weekFolder,
      });

      this.logger.log(`Relinked video for analysis ${analysisId}: ${newVideoPath}`);

      return {
        success: true,
        suggestedPath: newVideoPath,
        confidence: 'high',
      };

    } catch (error) {
      this.logger.error(`Manual relink failed: ${(error as Error).message}`);
      return {
        success: false,
        reason: `Error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Verify all analyses and mark broken links
   */
  async verifyAllVideos(): Promise<{
    total: number;
    linked: number;
    broken: number;
    fixed: number;
  }> {
    const analyses = await this.libraryService.getAnalyses();
    let linked = 0;
    let broken = 0;
    let fixed = 0;

    for (const analysis of analyses) {
      const exists = fsSync.existsSync(analysis.video.currentPath);

      if (exists && !analysis.video.isLinked) {
        // Was broken, now exists - mark as fixed
        await this.libraryService.updateAnalysis(analysis.id, {
          videoIsLinked: true,
        });
        linked++;
        fixed++;
      } else if (exists) {
        // Still linked
        linked++;
      } else if (analysis.video.isLinked) {
        // Was linked, now broken
        await this.libraryService.updateAnalysis(analysis.id, {
          videoIsLinked: false,
        });
        broken++;
      } else {
        // Still broken
        broken++;
      }
    }

    this.logger.log(
      `Verified ${analyses.length} videos: ${linked} linked, ${broken} broken, ${fixed} fixed`
    );

    return {
      total: analyses.length,
      linked,
      broken,
      fixed,
    };
  }

  /**
   * Calculate similarity score between two strings (0-1)
   * Uses a combination of techniques for fuzzy matching
   */
  private calculateSimilarity(str1: string, str2: string): number {
    // Normalize strings
    const norm1 = this.normalizeString(str1);
    const norm2 = this.normalizeString(str2);

    // Exact match
    if (norm1 === norm2) return 1.0;

    // Contains check
    if (norm2.includes(norm1) || norm1.includes(norm2)) {
      return 0.9;
    }

    // Calculate Levenshtein distance
    const distance = this.levenshteinDistance(norm1, norm2);
    const maxLength = Math.max(norm1.length, norm2.length);
    const levenScore = 1 - distance / maxLength;

    // Calculate token overlap (word-based)
    const tokens1 = norm1.split(/\s+/);
    const tokens2 = norm2.split(/\s+/);
    const overlap = tokens1.filter(t => tokens2.includes(t)).length;
    const tokenScore = overlap / Math.max(tokens1.length, tokens2.length);

    // Weighted average
    return levenScore * 0.6 + tokenScore * 0.4;
  }

  /**
   * Normalize string for comparison
   */
  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // Remove special chars
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = [];

    // Initialize DP table
    for (let i = 0; i <= m; i++) {
      dp[i] = [i];
    }
    for (let j = 0; j <= n; j++) {
      dp[0][j] = j;
    }

    // Fill DP table
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1, // deletion
            dp[i][j - 1] + 1, // insertion
            dp[i - 1][j - 1] + 1 // substitution
          );
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Search for video in entire clips collection
   */
  async searchClipsCollection(filename: string): Promise<string[]> {
    const results: string[] = [];

    try {
      if (!fsSync.existsSync(this.clipsBasePath)) {
        return results;
      }

      // Get all week folders
      const weekFolders = await fs.readdir(this.clipsBasePath);

      for (const folder of weekFolders) {
        // Skip if not a date folder
        if (!/^\d{4}-\d{2}-\d{2}$/.test(folder)) {
          continue;
        }

        const folderPath = path.join(this.clipsBasePath, folder);
        const stats = await fs.stat(folderPath);

        if (!stats.isDirectory()) {
          continue;
        }

        // Search for files in this folder
        const files = await fs.readdir(folderPath);
        for (const file of files) {
          if (file.toLowerCase().includes(filename.toLowerCase())) {
            results.push(path.join(folderPath, file));
          }
        }
      }

      return results;
    } catch (error) {
      this.logger.error(`Search failed: ${(error as Error).message}`);
      return results;
    }
  }
}
