// clippy/backend/src/library/interfaces/library.interface.ts

/**
 * Video metadata and location tracking
 */
export interface VideoInfo {
  originalPath: string;         // Where it was downloaded
  currentPath: string;           // Where it is now (after moving)
  clipsWeekFolder?: string;      // e.g., "2024-01-14" (Sunday of week)
  filename: string;              // Video filename
  durationSeconds?: number;      // Video duration
  isLinked: boolean;             // Whether video file exists at currentPath
  lastVerified: string;          // ISO timestamp of last verification
}

/**
 * File paths for analysis-related files
 */
export interface AnalysisFiles {
  analysis: string;              // Path to analysis report .txt file
  analysisMetadata: string;      // Path to parsed metadata .json file
  transcriptSrt: string;         // Path to .srt transcript
  transcriptTxt: string;         // Path to .txt transcript
}

/**
 * Analysis metadata
 */
export interface AnalysisMetadata {
  analysisModel: string;         // e.g., "claude-3-5-sonnet-20241022"
  transcriptionModel: string;    // e.g., "whisper-large"
  categories: string[];          // Extracted categories from analysis
}

/**
 * Single quote within a section
 */
export interface AnalysisQuote {
  timestamp: string;             // MM:SS format
  timestampSeconds: number;      // Seconds from start
  text: string;                  // Quote text
  significance: string;          // Why this quote matters
}

/**
 * Analyzed section of video
 */
export interface AnalysisSection {
  timeRange: string;             // e.g., "00:09 - 00:12" or "00:09"
  startSeconds: number;          // Start time in seconds
  endSeconds?: number;           // End time in seconds (optional)
  category: string;              // Dynamic category (violence, conspiracy, etc.)
  description: string;           // What happens in this section
  quotes: AnalysisQuote[];       // Key quotes from this section
}

/**
 * Parsed analysis metadata (stored in analyses/<id>.json)
 */
export interface ParsedAnalysisMetadata {
  id: string;
  title: string;
  createdAt: string;             // ISO timestamp
  durationSeconds?: number;
  sections: AnalysisSection[];
}

/**
 * Complete analysis record in library
 */
export interface LibraryAnalysis {
  id: string;
  title: string;
  createdAt: string;             // ISO timestamp
  archived: boolean;

  video: VideoInfo;
  files: AnalysisFiles;
  metadata: AnalysisMetadata;

  clips: string[];               // Array of clip IDs
}

/**
 * Clip metadata
 */
export interface LibraryClip {
  id: string;
  analysisId: string;            // Parent analysis ID
  name: string;                  // User-defined clip name
  startSeconds: number;
  endSeconds: number;
  outputPath: string;            // Where the clip video file is saved
  createdAt: string;             // ISO timestamp
  notes?: string;                // Optional user notes
}

/**
 * Main library structure (library.json)
 */
export interface Library {
  version: string;
  lastUpdated: string;           // ISO timestamp
  analyses: LibraryAnalysis[];
  clips: Record<string, LibraryClip>;  // Keyed by clip ID
}

/**
 * Request to create a new analysis in library
 */
export interface CreateLibraryAnalysisRequest {
  title: string;
  videoPath: string;
  transcriptSrtPath: string;
  transcriptTxtPath: string;
  analysisReportPath: string;
  durationSeconds?: number;
  analysisModel: string;
  transcriptionModel: string;
}

/**
 * Request to update an analysis
 */
export interface UpdateLibraryAnalysisRequest {
  archived?: boolean;
  videoCurrentPath?: string;
  videoIsLinked?: boolean;
  clipsWeekFolder?: string;
}

/**
 * Request to create a clip
 */
export interface CreateClipRequest {
  analysisId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  outputPath: string;
  notes?: string;
}

/**
 * Result of video relinking attempt
 */
export interface RelinkResult {
  success: boolean;
  suggestedPath?: string;
  confidence?: 'high' | 'low';
  candidates?: Array<{
    filename: string;
    fullPath: string;
    score: number;
  }>;
  reason?: string;
}
