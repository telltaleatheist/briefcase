import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * TextExtractionService - Extracts text from documents (PDF, EPUB, TXT, etc.)
 *
 * This service handles extracting readable text from document files for:
 * - Searchability within the application
 * - Display in the info dialog
 * - Future AI analysis capabilities
 *
 * Supported formats:
 * - PDF: Uses pdfplumber (Python)
 * - EPUB: Uses ebooklib (Python)
 * - TXT/MD: Direct file read
 * - HTML/MHTML: Basic HTML text extraction
 */
@Injectable()
export class TextExtractionService {
  private readonly logger = new Logger(TextExtractionService.name);
  private readonly pythonScriptPath: string;

  constructor(private readonly databaseService: DatabaseService) {
    // Path to Python text extraction script
    this.pythonScriptPath = path.join(
      __dirname,
      '..',
      '..',
      'python',
      'text_extraction_service.py',
    );
  }

  /**
   * Extract text from a document file
   * @param mediaId - Media item ID
   * @param filePath - Path to the document file
   * @returns Extracted text content
   */
  async extractText(mediaId: string, filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();

    this.logger.log(`Extracting text from ${ext} file: ${filePath}`);

    try {
      let extractedText: string;

      if (ext === '.txt' || ext === '.md') {
        // Simple text files - just read directly
        extractedText = await this.extractPlainText(filePath);
      } else if (ext === '.pdf' || ext === '.epub' || ext === '.mobi') {
        // Use Python script for complex formats
        extractedText = await this.extractUsingPython(filePath, ext);
      } else if (ext === '.html' || ext === '.htm' || ext === '.mhtml') {
        // Basic HTML text extraction
        extractedText = await this.extractHtmlText(filePath);
      } else {
        throw new Error(`Unsupported file format: ${ext}`);
      }

      // Store extracted text in database
      this.databaseService.insertTextContent({
        mediaId,
        extractedText,
        extractionMethod: ext.replace('.', ''),
      });

      this.logger.log(
        `Text extraction complete: ${extractedText.length} characters`,
      );

      return extractedText;
    } catch (error: any) {
      this.logger.error(`Text extraction failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract text from plain text files (TXT, MD)
   */
  private async extractPlainText(filePath: string): Promise<string> {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  /**
   * Extract text from HTML files
   * Strips HTML tags and returns plain text
   */
  private async extractHtmlText(filePath: string): Promise<string> {
    const htmlContent = await fs.promises.readFile(filePath, 'utf-8');

    // Basic HTML tag stripping (not perfect, but good enough for now)
    let text = htmlContent
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // Remove styles
      .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
      .replace(/&nbsp;/g, ' ') // Replace nbsp entities
      .replace(/&amp;/g, '&') // Replace amp entities
      .replace(/&lt;/g, '<') // Replace lt entities
      .replace(/&gt;/g, '>') // Replace gt entities
      .replace(/&quot;/g, '"') // Replace quot entities
      .replace(/&#039;/g, "'") // Replace apos entities
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    return text;
  }

  /**
   * Extract text using Python script (for PDF, EPUB, MOBI)
   * NOTE: Requires additional Python packages to be installed:
   * - pip install pdfplumber ebooklib beautifulsoup4
   */
  private async extractUsingPython(
    filePath: string,
    fileType: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Check if Python script exists
      if (!fs.existsSync(this.pythonScriptPath)) {
        reject(
          new Error(
            `Python text extraction script not found at: ${this.pythonScriptPath}`,
          ),
        );
        return;
      }

      const pythonProcess = spawn('python3', [
        this.pythonScriptPath,
        filePath,
        fileType,
      ]);

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          this.logger.error(`Python extraction failed: ${stderr}`);
          reject(
            new Error(
              `Text extraction failed with code ${code}: ${stderr}`,
            ),
          );
          return;
        }

        try {
          // Python script returns JSON: { "text": "extracted content..." }
          const result = JSON.parse(stdout);
          resolve(result.text || '');
        } catch (error: any) {
          reject(
            new Error(`Failed to parse Python output: ${error.message}`),
          );
        }
      });

      pythonProcess.on('error', (error) => {
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });
    });
  }

  /**
   * Get extracted text for a media item
   */
  async getExtractedText(mediaId: string): Promise<string | null> {
    const textContent = this.databaseService.getTextContent(mediaId);
    return textContent ? (textContent.extracted_text as string) : null;
  }

  /**
   * Check if text has been extracted for a media item
   */
  hasExtractedText(mediaId: string): boolean {
    const textContent = this.databaseService.getTextContent(mediaId);
    return textContent !== null;
  }

  /**
   * Re-extract text for a media item (useful if extraction failed previously)
   */
  async reExtractText(mediaId: string, filePath: string): Promise<string> {
    // Delete existing text content
    this.databaseService.deleteTextContent(mediaId);

    // Extract again
    return this.extractText(mediaId, filePath);
  }
}
