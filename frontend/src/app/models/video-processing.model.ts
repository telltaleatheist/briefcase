/**
 * Video Processing Queue Models
 *
 * Defines the hierarchical job structure for video processing operations.
 * Each video has a parent job containing multiple child processes.
 */

/**
 * Types of processing operations that can be performed on a video
 */
export type ProcessType = 'download' | 'import' | 'process' | 'normalize' | 'process-video' | 'transcribe' | 'analyze';

/**
 * Status of a job or process
 */
export type ProcessStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Represents a single processing operation (child process)
 * Each child process corresponds to one backend job
 */
export interface ChildProcess {
  /** Unique identifier for this child process */
  id: string;

  /** Backend job ID once submitted (used to track progress via WebSocket) */
  backendJobId?: string;

  /** Type of processing operation */
  type: ProcessType;

  /** Current status of this process */
  status: ProcessStatus;

  /** Progress percentage (0-100) */
  progress: number;

  /** Error message if status is 'failed' */
  error?: string;

  /** Display name for UI (e.g., "Fix Aspect Ratio", "Normalize Audio") */
  displayName: string;

  // ===== Download Configuration (only for 'download' type) =====
  /** URL to download from */
  downloadUrl?: string;

  /** Post title for renaming downloaded file */
  postTitle?: string;

  /** Output directory for download */
  outputDir?: string;

  /** Video quality (e.g., '1080', '720') */
  quality?: string;

  /** Convert to MP4 format */
  convertToMp4?: boolean;

  // ===== AI Analysis Configuration (only for 'analyze' type) =====
  /** AI model to use for analysis */
  aiModel?: string;

  /** API key for Claude/OpenAI */
  apiKey?: string;

  /** Ollama endpoint URL */
  ollamaEndpoint?: string;

  /** Custom instructions for AI analysis */
  customInstructions?: string;

  // ===== Transcription Configuration (only for 'transcribe' type) =====
  /** Whisper model to use for transcription */
  whisperModel?: string;

  /** Language code for transcription (e.g., 'en') */
  language?: string;
}

/**
 * Represents a video processing job with multiple child processes
 * This is the parent job that groups all operations for one video
 */
export interface VideoProcessingJob {
  /** Unique identifier for this parent job */
  id: string;

  /** Backend queue job ID (from new queue system) */
  backendJobId?: string;

  /** Database video ID (if processing an existing library video) */
  videoId?: string;

  /** File path or URL of the video */
  videoPath: string;

  /** Display name for the video (filename or title) */
  displayName: string;

  /** Child processes to be executed for this video */
  childProcesses: ChildProcess[];

  // ===== Calculated Fields =====
  /** Overall progress (average of all child processes) */
  overallProgress: number;

  /** Overall status (derived from child process statuses) */
  overallStatus: ProcessStatus;

  // ===== UI State =====
  /** Whether the job is expanded in the UI to show child processes */
  expanded?: boolean;

  /** When this job was created */
  createdAt: Date;

  /** When this job was completed (if status is 'completed' or 'failed') */
  completedAt?: Date;
}

/**
 * Configuration for adding a new video processing job
 */
export interface AddVideoJobParams {
  /** Database video ID (optional) */
  videoId?: string;

  /** File path or URL of the video */
  videoPath: string;

  /** Display name for the video */
  displayName: string;

  /** List of processes to run on this video */
  processes: ProcessConfig[];
}

/**
 * Configuration for a single process
 */
export interface ProcessConfig {
  /** Type of process */
  type: ProcessType;

  /** Configuration specific to this process type */
  config?: ProcessTypeConfig;
}

/**
 * Type-specific configuration for processes
 */
export type ProcessTypeConfig = DownloadConfig | AIAnalysisConfig | TranscriptionConfig | Record<string, never>;

/**
 * Configuration for download/import
 */
export interface DownloadConfig {
  downloadUrl: string;
  postTitle?: string;
  outputDir?: string;
  quality?: string;
  convertToMp4?: boolean;
}

/**
 * Configuration for AI analysis
 */
export interface AIAnalysisConfig {
  aiModel: string;
  apiKey?: string;
  ollamaEndpoint?: string;
  customInstructions?: string;
}

/**
 * Configuration for transcription
 */
export interface TranscriptionConfig {
  whisperModel?: string;
  language?: string;
}

/**
 * Helper function to get display name for a process type
 */
export function getProcessDisplayName(type: ProcessType): string {
  const names: Record<ProcessType, string> = {
    'download': 'Download',
    'import': 'Import to Library',
    'process': 'Fix Aspect Ratio',
    'normalize': 'Normalize Audio',
    'process-video': 'Process Video',
    'transcribe': 'Transcribe',
    'analyze': 'AI Analysis'
  };
  return names[type];
}

/**
 * Helper function to get icon name for a process type
 */
export function getProcessIcon(type: ProcessType): string {
  const icons: Record<ProcessType, string> = {
    'download': 'download',
    'import': 'library_add',
    'process': 'aspect_ratio',
    'normalize': 'equalizer',
    'process-video': 'video_settings',
    'transcribe': 'subtitles',
    'analyze': 'psychology'
  };
  return icons[type];
}
