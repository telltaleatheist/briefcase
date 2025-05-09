// clippy/frontend/src/app/models/download.model.ts

// Add these missing type definitions
export type BrowserType = 'auto' | 'chrome' | 'firefox' | 'edge' | 'safari' | 'brave' | 'opera';
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

export interface QualityOption {
  value: string;
  label: string;
}

// Keep all other existing interfaces
export interface DownloadOptions {
  url: string;
  quality: string;
  convertToMp4: boolean;
  fixAspectRatio: boolean;
  useCookies: boolean;
  browser: string;
  outputDir: string;
  displayName?: string;
  normalizeAudio?: boolean;
  useRmsNormalization?: boolean;
  rmsNormalizationLevel?: number;
  useCompression?: boolean;
  compressionLevel?: number;
  transcribeVideo?: boolean;
}

export interface BatchDownloadOptions {
  urls: string[];
  quality: string;
  convertToMp4: boolean;
  fixAspectRatio: boolean;
  useCookies: boolean;
  browser: string;
  outputDir: string;
  normalizeAudio?: boolean;
  useRmsNormalization?: boolean;
  rmsNormalizationLevel?: number;
  useCompression?: boolean;
  compressionLevel?: number;
}

export interface DownloadResult {
  success: boolean;
  outputFile?: string;
  error?: string;
  isImage?: boolean;
}

export interface DownloadProgress {
  progress: number;
  task?: string;
  jobId?: string; // Added jobId to track individual downloads
}

export interface HistoryItem {
  id: string;
  filename: string;
  filePath: string;
  sourceUrl: string;
  fileSize: number;
  date: string;
}

export interface VideoInfo {
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
  uploadDate: string;
}

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;
  codecName?: string;
  bitrate?: number;
  fps?: number;
  aspectRatio?: string;
}

export interface BatchConfig {
  maxConcurrentDownloads: number;
  enabled: boolean;

  useRmsNormalization?: boolean;
  rmsNormalizationLevel?: number;
  useCompression?: boolean;
  compressionLevel?: number;
  transcribeVideo?: boolean;
}

// Updated interfaces to include job progress information with string dates
export interface BatchJob {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed' | 'paused';
  progress: number;
  currentTask?: string;
  error?: string;
  priority?: 'low' | 'normal' | 'high';
  retryCount?: number;
  createdAt?: string;
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  outputFile?: string;
  queueType?: string;
  displayName?: string;
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
