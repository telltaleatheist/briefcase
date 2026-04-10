import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DatabaseService } from '../database/database.service';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';

@Injectable()
export class WebArchiveService {
  private readonly logger = new Logger(WebArchiveService.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Listen for webpage file import events from the file scanner
   */
  @OnEvent('webpage.imported')
  async handleWebpageImported(data: { videoId: string; filePath: string; filename: string }) {
    this.logger.log(`Webpage imported event received: ${data.filename}`);
    await this.backfillSingleArchive(data.videoId, data.filePath, data.filename);
  }

  /**
   * Import an MHTML file into the web archives system
   * Creates a web_archives record and extracts text content
   */
  async importWebArchive(params: {
    videoId: string;
    filePath: string;
    filename: string;
    originalUrl?: string;
    pageTitle?: string;
    captureMethod?: string;
  }) {
    const { videoId, filePath, filename, originalUrl, pageTitle, captureMethod } = params;

    // Try to extract metadata from the MHTML file
    let extractedUrl = originalUrl;
    let extractedTitle = pageTitle;
    try {
      const metadata = this.extractMhtmlMetadata(filePath);
      if (!extractedUrl && metadata.url) extractedUrl = metadata.url;
      if (!extractedTitle && metadata.title) extractedTitle = metadata.title;
    } catch (error: any) {
      this.logger.warn(`Could not extract MHTML metadata from ${filename}: ${error.message}`);
    }

    const domain = extractedUrl ? this.extractDomain(extractedUrl) : null;

    // Parse date from filename (YYYY-MM-DD prefix pattern)
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    const captureDate = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

    // Create web_archives record
    this.databaseService.insertWebArchive({
      videoId,
      originalUrl: extractedUrl || undefined,
      domain: domain || undefined,
      pageTitle: extractedTitle || undefined,
      captureDate,
      captureMethod: captureMethod || 'import',
      captureStatus: 'completed',
      textExtracted: false,
    });

    // Extract and store text content
    try {
      const text = this.extractTextFromMhtml(filePath);
      if (text && text.trim().length > 0) {
        this.databaseService.insertTextContent({
          mediaId: videoId,
          extractedText: text,
          extractionMethod: 'mhtml-parse',
        });
        this.databaseService.insertWebArchive({
          videoId,
          originalUrl: extractedUrl || undefined,
          domain: domain || undefined,
          pageTitle: extractedTitle || undefined,
          captureDate,
          captureMethod: captureMethod || 'import',
          captureStatus: 'completed',
          textExtracted: true,
        });
      }
    } catch (error: any) {
      this.logger.warn(`Could not extract text from ${filename}: ${error.message}`);
    }

    this.logger.log(`Imported web archive: ${filename} (domain: ${domain})`);
    return { videoId, domain, url: extractedUrl, title: extractedTitle };
  }

  /**
   * Extract text content from an MHTML file
   * Parses the MIME structure, finds the text/html part, and strips tags
   */
  extractTextFromMhtml(filePath: string): string {
    // Read a limited amount for text extraction (first 2MB should be enough)
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(2 * 1024 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const content = buffer.toString('utf-8', 0, bytesRead);

    // Find HTML content in the MIME parts
    let htmlContent = '';

    // Look for Content-Type: text/html boundary
    const htmlTypeIndex = content.indexOf('Content-Type: text/html');
    if (htmlTypeIndex !== -1) {
      // Find the start of the actual content (after the double newline)
      const contentStart = content.indexOf('\r\n\r\n', htmlTypeIndex);
      if (contentStart !== -1) {
        // Find the next MIME boundary
        const boundaryMatch = content.match(/^--(.+)$/m);
        const boundary = boundaryMatch ? boundaryMatch[1] : null;

        if (boundary) {
          const nextBoundary = content.indexOf(`--${boundary}`, contentStart + 4);
          htmlContent = nextBoundary !== -1
            ? content.substring(contentStart + 4, nextBoundary)
            : content.substring(contentStart + 4, Math.min(contentStart + 500000, content.length));
        } else {
          htmlContent = content.substring(contentStart + 4, Math.min(contentStart + 500000, content.length));
        }
      }
    }

    // If no MIME parts found, try the whole content as HTML
    if (!htmlContent) {
      htmlContent = content;
    }

    // Check if content is quoted-printable encoded
    if (content.includes('Content-Transfer-Encoding: quoted-printable')) {
      htmlContent = this.decodeQuotedPrintable(htmlContent);
    }

    // Strip HTML tags and normalize whitespace
    return this.stripHtml(htmlContent);
  }

  /**
   * Extract metadata from an MHTML file header
   * Reads first 4KB for Content-Location (original URL) and <title>
   */
  extractMhtmlMetadata(filePath: string): { url: string | null; title: string | null } {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    const header = buffer.toString('utf-8', 0, bytesRead);

    let url: string | null = null;
    let title: string | null = null;

    // Extract Content-Location (original URL)
    const locationMatch = header.match(/Content-Location:\s*(.+?)[\r\n]/);
    if (locationMatch) {
      url = locationMatch[1].trim();
    }

    // Also try Snapshot-Content-Location (used by some browsers)
    if (!url) {
      const snapMatch = header.match(/Snapshot-Content-Location:\s*(.+?)[\r\n]/);
      if (snapMatch) {
        url = snapMatch[1].trim();
      }
    }

    // Extract title from HTML
    const titleMatch = header.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      title = this.decodeHtmlEntities(titleMatch[1].trim());
    }

    return { url, title };
  }

  /**
   * Extract domain from a URL
   */
  extractDomain(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  /**
   * Get archives grouped by domain
   */
  getArchivesByDomain() {
    const archives = this.databaseService.getAllWebArchives();
    const grouped = new Map<string, typeof archives>();

    for (const archive of archives) {
      const domain = archive.domain || 'unknown';
      if (!grouped.has(domain)) {
        grouped.set(domain, []);
      }
      grouped.get(domain)!.push(archive);
    }

    return Object.fromEntries(grouped);
  }

  /**
   * Get domain list with counts
   */
  getDomains() {
    return this.databaseService.getWebArchiveDomains();
  }

  /**
   * Backfill web archive metadata for an already-imported MHTML file
   * Called by file scanner when it imports webpage files
   */
  async backfillSingleArchive(videoId: string, filePath: string, filename: string) {
    // Check if web_archives record already exists
    const existing = this.databaseService.getWebArchive(videoId);
    if (existing) {
      return; // Already backfilled
    }

    try {
      await this.importWebArchive({
        videoId,
        filePath,
        filename,
        captureMethod: 'scan',
      });
    } catch (error: any) {
      this.logger.error(`Failed to backfill web archive for ${filename}: ${error.message}`);
    }
  }

  /**
   * Decode quoted-printable encoding
   */
  private decodeQuotedPrintable(str: string): string {
    return str
      .replace(/=\r?\n/g, '') // Remove soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Strip HTML tags and normalize whitespace
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles
      .replace(/<[^>]+>/g, ' ') // Remove tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
  }

  /**
   * Decode common HTML entities
   */
  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
}
