// ClipChimp/backend/src/common/utils/filename-date.util.ts

/**
 * Utility for managing dates in video filenames
 *
 * Enforces the format: YYYY-MM-DD [title] or YYYY-MM-T[1-3] [title]
 * - Standard format: 2025-01-15 Video Title.mp4
 * - Trimester format: 2025-01-T1 Video Title.mp4
 *   - T1 = 1st-9th of month
 *   - T2 = 10th-19th of month
 *   - T3 = 20th-last day of month
 */

export interface DateInfo {
  /** The extracted date string (e.g., "2025-01-15" or "2025-01-T1") */
  date: string;
  /** The original date format found */
  originalFormat: 'YYYY-MM-DD' | 'YYYY-MM-T#' | 'YYYY-MM' | 'YYYY' | 'YYYYMMDD' | 'none';
  /** The title portion after the date */
  title: string;
  /** Whether a valid date was found */
  hasDate: boolean;
}

export class FilenameDateUtil {
  // Standard date format: YYYY-MM-DD
  private static readonly STANDARD_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/;

  // Trimester format: YYYY-MM-T[1-3]
  private static readonly TRIMESTER_DATE_PATTERN = /^(\d{4}-\d{2}-T[123])\s+(.+)$/;

  // Partial date format: YYYY-MM (month only)
  private static readonly MONTH_DATE_PATTERN = /^(\d{4}-\d{2})\s+(.+)$/;

  // Year only format: YYYY
  private static readonly YEAR_DATE_PATTERN = /^(\d{4})\s+(.+)$/;

  // Old format: YYYYMMDD
  private static readonly OLD_DATE_PATTERN = /^(\d{8})[-_ ](.+)$/;

  // Combined pattern to detect any date at start
  private static readonly ANY_DATE_AT_START = /^(\d{4}-\d{2}-(?:\d{2}|T[123])|\d{4}-\d{2}|\d{4})\s+/;

  /**
   * Extract date information from a filename
   */
  static extractDateInfo(filename: string): DateInfo {
    // Remove extension for processing
    const ext = this.getExtension(filename);
    const nameWithoutExt = ext ? filename.slice(0, -ext.length) : filename;

    // Check for standard date format (YYYY-MM-DD)
    const standardMatch = nameWithoutExt.match(this.STANDARD_DATE_PATTERN);
    if (standardMatch) {
      return {
        date: standardMatch[1],
        originalFormat: 'YYYY-MM-DD',
        title: standardMatch[2],
        hasDate: true
      };
    }

    // Check for trimester format (YYYY-MM-T#)
    const trimesterMatch = nameWithoutExt.match(this.TRIMESTER_DATE_PATTERN);
    if (trimesterMatch) {
      return {
        date: trimesterMatch[1],
        originalFormat: 'YYYY-MM-T#',
        title: trimesterMatch[2],
        hasDate: true
      };
    }

    // Check for month format (YYYY-MM) - must check after trimester to avoid false matches
    const monthMatch = nameWithoutExt.match(this.MONTH_DATE_PATTERN);
    if (monthMatch) {
      return {
        date: monthMatch[1],
        originalFormat: 'YYYY-MM',
        title: monthMatch[2],
        hasDate: true
      };
    }

    // Check for year only format (YYYY)
    const yearMatch = nameWithoutExt.match(this.YEAR_DATE_PATTERN);
    if (yearMatch) {
      return {
        date: yearMatch[1],
        originalFormat: 'YYYY',
        title: yearMatch[2],
        hasDate: true
      };
    }

    // Check for old format (YYYYMMDD)
    const oldMatch = nameWithoutExt.match(this.OLD_DATE_PATTERN);
    if (oldMatch) {
      // Convert to standard format
      const dateStr = oldMatch[1];
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      return {
        date: `${year}-${month}-${day}`,
        originalFormat: 'YYYYMMDD',
        title: oldMatch[2],
        hasDate: true
      };
    }

    // No date found
    return {
      date: '',
      originalFormat: 'none',
      title: nameWithoutExt,
      hasDate: false
    };
  }

  /**
   * Ensure filename starts with a date (YYYY-MM-DD format)
   * If no date exists, adds the provided date
   * If date exists, keeps it (no duplication)
   * IMPORTANT: Only adds a date if uploadDate is explicitly provided.
   * Does NOT fall back to current date - upload date must be the actual content creation date.
   */
  static ensureDatePrefix(filename: string, uploadDate?: string): string {
    const ext = this.getExtension(filename);
    const dateInfo = this.extractDateInfo(filename);

    // If already has a date, return as-is (sanitized)
    if (dateInfo.hasDate) {
      const sanitizedTitle = this.sanitizeTitle(dateInfo.title);
      return `${dateInfo.date} ${sanitizedTitle}${ext}`;
    }

    // No date in filename - add one ONLY if uploadDate is provided
    if (uploadDate) {
      const sanitizedTitle = this.sanitizeTitle(dateInfo.title);
      return `${uploadDate} ${sanitizedTitle}${ext}`;
    }

    // No date available - return filename without date prefix
    const sanitizedTitle = this.sanitizeTitle(dateInfo.title);
    return `${sanitizedTitle}${ext}`;
  }

  /**
   * Update the title portion while handling date preservation
   * Priority order:
   * 1. Date in new title (if user explicitly provides one)
   * 2. Provided uploadDate parameter
   * 3. Date from old filename
   * 4. No date
   *
   * IMPORTANT: If user provides a date in newTitle, that takes precedence.
   * This allows users to change the upload date during rename.
   * Does NOT fall back to current date.
   */
  static updateTitle(filename: string, newTitle: string, uploadDate?: string): string {
    const ext = this.getExtension(filename);
    const oldDateInfo = this.extractDateInfo(filename);
    const newTitleInfo = this.extractDateInfo(newTitle);
    const cleanNewTitle = this.sanitizeTitle(newTitleInfo.title);

    // Priority 1: If new title has a date, use that (user is explicitly setting a new date)
    if (newTitleInfo.hasDate) {
      return `${newTitleInfo.date} ${cleanNewTitle}${ext}`;
    }

    // Priority 2: Use provided uploadDate parameter
    if (uploadDate) {
      return `${uploadDate} ${cleanNewTitle}${ext}`;
    }

    // Priority 3: Use date from old filename
    if (oldDateInfo.hasDate) {
      return `${oldDateInfo.date} ${cleanNewTitle}${ext}`;
    }

    // No date available - return title without date
    return `${cleanNewTitle}${ext}`;
  }

  /**
   * Validate if a date string is in valid format
   */
  static isValidDateFormat(dateStr: string): boolean {
    // Check standard format YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const [year, month, day] = dateStr.split('-').map(Number);
      return year >= 1900 && year <= 2100 &&
             month >= 1 && month <= 12 &&
             day >= 1 && day <= 31;
    }

    // Check trimester format YYYY-MM-T[1-3]
    if (/^\d{4}-\d{2}-T[123]$/.test(dateStr)) {
      const [year, month] = dateStr.split('-').map(s => s.replace(/T\d/, ''));
      return Number(year) >= 1900 && Number(year) <= 2100 &&
             Number(month) >= 1 && Number(month) <= 12;
    }

    return false;
  }

  /**
   * Convert trimester format to standard date (first day of range)
   * T1 -> 01 (first day of 1-9)
   * T2 -> 10 (first day of 10-19)
   * T3 -> 20 (first day of 20-31)
   */
  static trimesterToStandardDate(trimesterDate: string): string {
    const match = trimesterDate.match(/^(\d{4})-(\d{2})-T([123])$/);
    if (!match) return trimesterDate;

    const [, year, month, trimester] = match;
    const dayMap: { [key: string]: string } = {
      '1': '01',
      '2': '10',
      '3': '20'
    };

    return `${year}-${month}-${dayMap[trimester]}`;
  }

  /**
   * Convert any filename date format to ISO date string for database storage
   * Handles: YYYY-MM-DD, YYYY-MM-T#, YYYY-MM, YYYY
   * Returns null if no valid date
   */
  static toISODate(dateStr: string): string | null {
    if (!dateStr) return null;

    // Standard format YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }

    // Trimester format YYYY-MM-T#
    if (/^\d{4}-\d{2}-T[123]$/.test(dateStr)) {
      return this.trimesterToStandardDate(dateStr);
    }

    // Month only YYYY-MM -> first day of month
    if (/^\d{4}-\d{2}$/.test(dateStr)) {
      return `${dateStr}-01`;
    }

    // Year only YYYY -> first day of year
    if (/^\d{4}$/.test(dateStr)) {
      return `${dateStr}-01-01`;
    }

    return null;
  }

  /**
   * Get current date in YYYY-MM-DD format
   */
  private static getCurrentDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Sanitize title by removing/replacing invalid filename characters
   */
  private static sanitizeTitle(title: string): string {
    return title
      .replace(/[\/\\:*?"<>|]/g, '-')  // Replace invalid chars
      .replace(/\s+/g, ' ')             // Normalize spaces
      .trim();
  }

  /**
   * Get file extension including the dot
   */
  private static getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot > 0 ? filename.substring(lastDot) : '';
  }

  /**
   * Format an upload date from yt-dlp format (YYYYMMDD) to YYYY-MM-DD
   */
  static formatUploadDate(ytDlpDate: string): string {
    if (!ytDlpDate || ytDlpDate.length !== 8) {
      return this.getCurrentDate();
    }

    const year = ytDlpDate.substring(0, 4);
    const month = ytDlpDate.substring(4, 6);
    const day = ytDlpDate.substring(6, 8);
    return `${year}-${month}-${day}`;
  }
}
