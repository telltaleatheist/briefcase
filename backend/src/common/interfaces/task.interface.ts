// Task types and interfaces for the queue system

export type TaskType =
  | 'get-info'
  | 'download'
  | 'import'
  | 'fix-aspect-ratio'
  | 'strip-black-bars'
  | 'normalize-audio'
  | 'process-video'  // Combined: aspect ratio + audio normalization in single pass
  | 'transcribe'
  | 'analyze'
  | 'analyze-webpage'
  | 'export-clip';

export interface BaseTask {
  type: TaskType;
  options?: any;
}

export interface GetInfoTask extends BaseTask {
  type: 'get-info';
  options?: {
    // No special options needed - just fetches metadata
  };
}

export interface DownloadTask extends BaseTask {
  type: 'download';
  options?: {
    quality?: string;
    convertToMp4?: boolean;
    useCookies?: boolean;
    browser?: string;
  };
}

export interface ImportTask extends BaseTask {
  type: 'import';
  options?: {
    duplicateHandling?: 'skip' | 'replace' | 'keep-both';
  };
}

export interface FixAspectRatioTask extends BaseTask {
  type: 'fix-aspect-ratio';
  options?: {
    // Options for aspect ratio processing
  };
}

export interface StripBlackBarsTask extends BaseTask {
  type: 'strip-black-bars';
  options?: {};
}

export interface NormalizeAudioTask extends BaseTask {
  type: 'normalize-audio';
  options?: {
    level?: number; // Target level in dB (e.g., -16)
    method?: 'rms' | 'ebu-r128';
  };
}

export interface ProcessVideoTask extends BaseTask {
  type: 'process-video';
  options?: {
    fixAspectRatio?: boolean;
    normalizeAudio?: boolean;
    level?: number; // Audio normalization level in dB (e.g., -16)
    method?: 'rms' | 'ebu-r128';
  };
}

/**
 * Transcription on Crucible's asr job. The server and model come from
 * Settings › Transcription; there are no per-task options (P7 removed the
 * whisper-cli model choice and `translate`, which Briefcase does not need).
 */
export interface TranscribeTask extends BaseTask {
  type: 'transcribe';
  options?: Record<string, never>;
}

export interface AnalyzeTask extends BaseTask {
  type: 'analyze';
  options?: {
    aiModel: string;
    /** `local` = a model in the Crucible server's own catalog; the rest are its upstreams. */
    aiProvider?: 'local' | 'ollama' | 'claude' | 'openai';
    customInstructions?: string;
  };
}

export interface AnalyzeWebpageTask extends BaseTask {
  type: 'analyze-webpage';
  options?: {
    aiModel: string;
    aiProvider?: 'local' | 'ollama' | 'claude' | 'openai';
  };
}

export interface ExportClipTask extends BaseTask {
  type: 'export-clip';
  options: {
    videoPath: string;
    startTime: number | null;
    endTime: number | null;
    trimEndSeconds?: number; // seconds to remove from the end, resolved against the file's real duration (download trim-opener)
    title?: string;
    description?: string;
    category?: string;
    customDirectory?: string;
    reEncode?: boolean;
    quality?: 'high' | 'medium' | 'low';
    scale?: number;
    muteSections?: Array<{ startSeconds: number; endSeconds: number }>;
    outputSuffix?: string;
    isOverwrite?: boolean;
    videoId?: string; // needed for overwrite mode
  };
}

export type Task =
  | GetInfoTask
  | DownloadTask
  | ImportTask
  | FixAspectRatioTask
  | StripBlackBarsTask
  | NormalizeAudioTask
  | ProcessVideoTask
  | TranscribeTask
  | AnalyzeTask
  | AnalyzeWebpageTask
  | ExportClipTask;

export interface TaskResult {
  success: boolean;
  error?: string;
  data?: any; // Task-specific result data
  /** Non-fatal degradations to surface on the job (task still succeeded). */
  warnings?: string[];
}

export interface GetInfoResult extends TaskResult {
  data?: {
    title: string;
    uploader: string;
    duration: number;
    uploadDate: string;
    thumbnail: string;
    isLive?: boolean;
  };
}

export interface DownloadResult extends TaskResult {
  data?: {
    videoPath: string;
    title: string;
  };
}

export interface ImportResult extends TaskResult {
  data?: {
    videoId: string;
    wasAlreadyImported: boolean;
  };
}

export interface FixAspectRatioResult extends TaskResult {
  data?: {
    outputPath: string;
    wasProcessed: boolean; // false if video didn't need processing
  };
}

export interface NormalizeAudioResult extends TaskResult {
  data?: {
    outputPath: string;
  };
}

export interface ProcessVideoResult extends TaskResult {
  data?: {
    outputPath: string;
    aspectRatioFixed: boolean;
    audioNormalized: boolean;
    /** True when the file already met every requested target and was left alone. */
    skipped?: boolean;
  };
}

export interface TranscribeResult extends TaskResult {
  data?: {
    transcriptPath?: string; // Temp file path (will be deleted after saving to DB)
  };
}

export interface AnalyzeResult extends TaskResult {
  data?: {
    analysisPath?: string; // Temp file path (will be deleted after saving to DB)
    sectionsCount: number;
  };
}

// Queue job interface
export interface QueueJob {
  id: string;
  url?: string; // For download tasks
  videoPath?: string; // For local file tasks
  videoId?: string; // For library video tasks
  displayName?: string;
  libraryId?: string; // Target library for import (uses active library if not specified)
  tasks: Task[];
  currentTaskIndex: number;
  status: 'pending' | 'paused' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number; // 0-100
  currentPhase: string;
  error?: string;
  /**
   * Non-fatal degradations that occurred while processing (job still
   * succeeded, but something the user should know about happened —
   * e.g. upload date unavailable, connection edge not created).
   * Additive; serialized to the frontend with the job.
   */
  warnings?: string[];

  // Shared context between tasks
  videoInfo?: {
    title: string;
    uploader: string;
    duration: number;
    uploadDate: string;
    thumbnail: string;
    isLive?: boolean;
  };
  transcriptPath?: string; // Set by transcribe task
  analysisPath?: string; // Set by analyze task

  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  // ── Crucible lanes (P4): where every AI task runs. ──
  /** The lane the current AI task was placed on: `gpu:<server>` or `cloud`. */
  lane?: string;
  /** The Crucible server it runs (or ran) on. */
  venue?: string;
  /**
   * Why the current AI task is waiting instead of running: the busy holder's
   * sentence, an unreachable server, no server with that upstream. Set while
   * parked, cleared when admitted. Shown grey on the row, never as an error.
   */
  parkedReason?: string;
  /** Epoch ms before which a parked task is not asked again. */
  parkedUntil?: number;
  /** The server it parked on, so that server's lane freeing re-asks it at once. */
  parkedServer?: string;
  /** Parks since the last task that completed: the backoff exponent. */
  parkCount?: number;
  /** When the current AI task became runnable (the same-model preference's starvation guard). */
  aiWaitingSince?: number;
  aiWaitingIndex?: number;
}

// Queue status
export interface QueueStatus {
  queueType: 'batch' | 'analysis';
  pendingJobs: QueueJob[];
  processingJobs: QueueJob[];
  completedJobs: QueueJob[];
  failedJobs: QueueJob[];
  activeJobCount: number;
  maxConcurrency: number;
}

// Progress event
export interface TaskProgressEvent {
  jobId: string;
  taskType: TaskType;
  progress: number; // 0-100
  message: string;
}
