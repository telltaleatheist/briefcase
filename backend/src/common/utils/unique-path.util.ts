// Briefcase/backend/src/common/utils/unique-path.util.ts

import * as fs from 'fs';
import * as path from 'path';

/**
 * Utility for resolving non-colliding destination paths.
 *
 * Downloaded/imported files land at `<weekFolder>/YYYY-MM-DD <title>.ext`. Two
 * DIFFERENT videos that share an upload date + sanitized title in the same week
 * would otherwise resolve to the identical path and the second write would
 * clobber the first's bytes on disk (data loss). These helpers append a
 * " (2)", " (3)", … suffix before the extension until the target no longer
 * exists, guaranteeing a differing file is never overwritten.
 *
 * Content-level de-duplication (same bytes being re-processed) is handled
 * upstream by hash checks; by the time these helpers run, a collision means a
 * genuinely different file, so uniquifying is always the safe choice.
 */
export class UniquePathUtil {
  /**
   * Given a fully-qualified target file path, return a path that does not yet
   * exist on disk. If nothing is at `targetPath` it is returned unchanged;
   * otherwise " (2)", " (3)", … is inserted before the extension until a free
   * path is found.
   */
  static resolveUniquePath(targetPath: string): string {
    if (!fs.existsSync(targetPath)) {
      return targetPath;
    }

    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath);
    const base = path.basename(targetPath, ext);

    let counter = 2;
    let candidate: string;
    do {
      candidate = path.join(dir, `${base} (${counter})${ext}`);
      counter++;
    } while (fs.existsSync(candidate));

    return candidate;
  }

  /**
   * Given a directory and a base name WITHOUT extension, return a base name for
   * which no file `<baseName>.<anything>` already exists in the directory. Used
   * for download tools (yt-dlp) that pick the extension themselves, so the
   * concrete filename can't be known before the download starts. Returns just
   * the (possibly suffixed) base name; the caller rebuilds its own template.
   */
  static resolveUniqueBaseName(dir: string, baseName: string): string {
    const collides = (name: string): boolean => {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        // Directory doesn't exist yet → nothing to collide with.
        return false;
      }
      const prefix = `${name.toLowerCase()}.`;
      return entries.some((entry) => entry.toLowerCase().startsWith(prefix));
    };

    if (!collides(baseName)) {
      return baseName;
    }

    let counter = 2;
    let candidate: string;
    do {
      candidate = `${baseName} (${counter})`;
      counter++;
    } while (collides(candidate));

    return candidate;
  }
}
