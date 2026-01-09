/**
 * Shared filename utilities
 * Single source of truth for filename parsing logic used by both frontend and backend
 *
 * IMPORTANT: This module uses the same date patterns as backend/src/common/utils/filename-date.util.ts
 * to ensure consistent behavior across the application.
 *
 * Date pattern matches (in priority order):
 * - YYYY-MM-DD (e.g., "2025-01-15")
 * - YYYY-MM-T# where # is 1, 2, or 3 (e.g., "2025-01-T1")
 * - YYYY-MM (e.g., "2025-01")
 * - YYYY (e.g., "2025")
 */

/**
 * Extract title portion from filename (removes date prefix and extension)
 *
 * Handles all supported date formats:
 * - YYYY-MM-DD (e.g., "2025-01-15")
 * - YYYY-MM-T# (e.g., "2025-01-T1")
 * - YYYY-MM (e.g., "2025-01")
 * - YYYY (e.g., "2025")
 *
 * @param filename - Full filename including date prefix and extension
 * @returns Title portion without date or extension
 *
 * @example
 * extractTitleFromFilename("2025-01-15 My Video.mp4") // returns "My Video"
 * extractTitleFromFilename("2025-01-T1 Another Video.mov") // returns "Another Video"
 * extractTitleFromFilename("My Video.mp4") // returns "My Video"
 */
export function extractTitleFromFilename(filename: string): string {
  if (!filename) return '';

  // Remove extension
  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.substring(0, lastDot) : filename;

  // Check for date patterns at the start and remove them
  // Matches: YYYY-MM-DD, YYYY-MM-T#, YYYY-MM, YYYY followed by space
  // This pattern matches all date formats used by FilenameDateUtil in backend
  const datePattern = /^(\d{4}-\d{2}-(?:\d{2}|T[123])|\d{4}-\d{2}|\d{4})\s+/;
  const withoutDate = nameWithoutExt.replace(datePattern, '');

  return withoutDate.trim();
}

/**
 * Get file extension including the dot
 *
 * @param filename - Filename to extract extension from
 * @returns Extension including the dot (e.g., ".mp4"), or empty string if no extension
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.substring(lastDot) : '';
}

/**
 * Check if filename has a date prefix
 *
 * @param filename - Filename to check
 * @returns True if filename starts with a valid date prefix
 */
export function hasDatePrefix(filename: string): boolean {
  const datePattern = /^(\d{4}-\d{2}-(?:\d{2}|T[123])|\d{4}-\d{2}|\d{4})\s+/;
  return datePattern.test(filename);
}

/**
 * Extract the date prefix from a filename
 *
 * @param filename - Filename to extract date from
 * @returns Date string (e.g., "2025-01-15") or null if no date
 */
export function extractDateFromFilename(filename: string): string | null {
  if (!filename) return null;

  // Remove extension for checking
  const lastDot = filename.lastIndexOf('.');
  const nameWithoutExt = lastDot > 0 ? filename.substring(0, lastDot) : filename;

  // Match date patterns at the start
  const datePattern = /^(\d{4}-\d{2}-(?:\d{2}|T[123])|\d{4}-\d{2}|\d{4})\s+/;
  const match = nameWithoutExt.match(datePattern);

  return match ? match[1] : null;
}

/**
 * Format a date string for display (keeps YYYY-MM-DD format)
 *
 * @param dateStr - Date string from filename
 * @returns Formatted date for display
 */
export function formatDateForDisplay(dateStr: string): string {
  if (!dateStr) return '';
  // Return as-is (already in YYYY-MM-DD or similar format)
  return dateStr;
}
