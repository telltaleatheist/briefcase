// clippy/backend/src/library/parsers/analysis-parser.ts
import * as fs from 'fs/promises';
import {
  ParsedAnalysisMetadata,
  AnalysisSection,
  AnalysisQuote,
} from '../interfaces/library.interface';

/**
 * Parse timestamp in MM:SS format to seconds
 */
export function parseTimestampToSeconds(timestamp: string): number {
  const parts = timestamp.trim().split(':');

  if (parts.length === 2) {
    // MM:SS format
    const minutes = parseInt(parts[0], 10);
    const seconds = parseInt(parts[1], 10);
    return minutes * 60 + seconds;
  } else if (parts.length === 3) {
    // HH:MM:SS format
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseInt(parts[2], 10);
    return hours * 3600 + minutes * 60 + seconds;
  }

  return 0;
}

/**
 * Parse an analysis report text file into structured metadata
 *
 * Expected format:
 * **MM:SS - MM:SS - Description [category]**
 * or
 * **MM:SS - Description [category]**
 *
 * MM:SS - "Quote text"
 *    → Significance text
 */
export async function parseAnalysisReport(
  filePath: string,
  analysisId: string,
  title: string,
  createdAt: string
): Promise<ParsedAnalysisMetadata> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');

  const sections: AnalysisSection[] = [];
  let currentSection: AnalysisSection | null = null;
  let currentQuote: Partial<AnalysisQuote> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and dividers
    if (line.length === 0 || line.match(/^[=\-]+$/)) {
      continue;
    }

    // Skip header
    if (line === 'VIDEO ANALYSIS RESULTS') {
      continue;
    }

    // Check for section header (lines between ** **)
    const sectionMatch = line.match(/^\*\*(.+?)\*\*$/);
    if (sectionMatch) {
      // Save previous section if exists
      if (currentSection) {
        // Add last quote if exists
        if (currentQuote && currentQuote.timestamp && currentQuote.text) {
          currentSection.quotes.push(currentQuote as AnalysisQuote);
        }
        sections.push(currentSection);
      }

      // Parse new section
      const sectionText = sectionMatch[1];

      // Try to parse: "MM:SS - MM:SS - Description [category]"
      const fullMatch = sectionText.match(/^(\d+:\d+)\s*-\s*(\d+:\d+)\s*-\s*(.+?)\s*\[(.+?)\]$/);
      if (fullMatch) {
        const [, startTime, endTime, description, category] = fullMatch;
        currentSection = {
          timeRange: `${startTime} - ${endTime}`,
          startSeconds: parseTimestampToSeconds(startTime),
          endSeconds: parseTimestampToSeconds(endTime),
          category: category.trim(),
          description: description.trim(),
          quotes: [],
        };
        continue;
      }

      // Try to parse: "MM:SS - Description [category]"
      const simpleMatch = sectionText.match(/^(\d+:\d+)\s*-\s*(.+?)\s*\[(.+?)\]$/);
      if (simpleMatch) {
        const [, startTime, description, category] = simpleMatch;
        currentSection = {
          timeRange: startTime,
          startSeconds: parseTimestampToSeconds(startTime),
          category: category.trim(),
          description: description.trim(),
          quotes: [],
        };
        continue;
      }

      // If no match, skip this section
      currentSection = null;
      continue;
    }

    // Check for quote (MM:SS - "Quote text")
    const quoteMatch = line.match(/^(\d+:\d+)\s*-\s*"(.+?)"$/);
    if (quoteMatch && currentSection) {
      // Save previous quote if exists
      if (currentQuote && currentQuote.timestamp && currentQuote.text) {
        currentSection.quotes.push(currentQuote as AnalysisQuote);
      }

      const [, timestamp, text] = quoteMatch;
      currentQuote = {
        timestamp: timestamp.trim(),
        timestampSeconds: parseTimestampToSeconds(timestamp),
        text: text.trim(),
        significance: '',
      };
      continue;
    }

    // Check for significance line (→ text)
    const significanceMatch = line.match(/^→\s*(.+)$/);
    if (significanceMatch && currentQuote) {
      currentQuote.significance = significanceMatch[1].trim();
      continue;
    }
  }

  // Add last section and quote
  if (currentSection) {
    if (currentQuote && currentQuote.timestamp && currentQuote.text) {
      currentSection.quotes.push(currentQuote as AnalysisQuote);
    }
    sections.push(currentSection);
  }

  // Calculate max duration from sections
  let maxDuration = 0;
  for (const section of sections) {
    if (section.endSeconds && section.endSeconds > maxDuration) {
      maxDuration = section.endSeconds;
    }
    if (section.startSeconds > maxDuration) {
      maxDuration = section.startSeconds;
    }
    for (const quote of section.quotes) {
      if (quote.timestampSeconds > maxDuration) {
        maxDuration = quote.timestampSeconds;
      }
    }
  }

  return {
    id: analysisId,
    title,
    createdAt,
    durationSeconds: maxDuration > 0 ? maxDuration : undefined,
    sections,
  };
}

/**
 * Extract unique categories from parsed analysis
 */
export function extractCategories(metadata: ParsedAnalysisMetadata): string[] {
  const categories = new Set<string>();

  for (const section of metadata.sections) {
    if (section.category && section.category !== 'routine') {
      categories.add(section.category);
    }
  }

  return Array.from(categories);
}

/**
 * Save parsed metadata to JSON file
 */
export async function saveAnalysisMetadata(
  filePath: string,
  metadata: ParsedAnalysisMetadata
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), 'utf-8');
}
