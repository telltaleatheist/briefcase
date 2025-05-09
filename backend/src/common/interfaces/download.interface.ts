// clippy/backend/src/common/interfaces/download.interface.ts

export type JobStatus = 'queued' | 'downloading' | 'downloaded' | 'processing' | 'transcribing' | 'completed' | 'failed';

export interface Job {
  id: string;
  url: string;
  displayName: string;
  status: JobStatus;
  progress: number;
  currentTask: string;
  error?: string;
  createdAt: string;
  options: DownloadOptions;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  outputFile?: string;
  thumbnail?: string;
  transcriptFile?: string;
}

export interface JobResponse {
  id: string;
  url: string;
  displayName: string;
  status: JobStatus;
  progress: number;
  currentTask: string;
  error?: string;
  createdAt: string;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  outputFile?: string;
  thumbnail?: string;
  transcriptFile?: string;
}

export interface BatchQueueStatus {
  queuedJobs: JobResponse[];
  downloadingJobs: JobResponse[];
  downloadedJobs: JobResponse[];
  processingJobs: JobResponse[];
  completedJobs: JobResponse[];
  failedJobs: JobResponse[];
  activeDownloadCount: number;
  maxConcurrentDownloads: number;
  isProcessing: boolean;
}

export interface DownloadOptions {
  url: string;
  outputDir?: string;
  quality?: string;
  convertToMp4?: boolean;
  fps?: number;
  useCookies?: boolean;
  browser?: string;
  fixAspectRatio?: boolean;
  displayName?: string;
  useRmsNormalization?: boolean;
  rmsNormalizationLevel?: number;
  useCompression?: boolean;
  compressionLevel?: number;
  transcribeVideo?: boolean;
}

export interface DownloadResult {
  success: boolean;
  outputFile?: string;
  error?: string;
  jobId?: string;
  isImage?: boolean; // Add this new property
}

export interface DownloadProgress {
  progress: number;
  task?: string;
  outputFile?: string;
  jobId?: string;
}

export interface BatchJobInfo {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed';
  error?: string;
}

export interface HistoryItem {
  id: string;
  filename: string;
  filePath: string;
  sourceUrl: string;
  fileSize?: number;
  duration?: number;
  date: string;
}

export interface VideoMetadata {
  width?: number;
  height?: number;
  duration?: number;
  codecName?: string;
  bitrate?: number;
  fps?: number;
  aspectRatio?: string;
}

export type BrowserType = 'auto' | 'chrome' | 'firefox' | 'edge' | 'safari' | 'brave' | 'opera';