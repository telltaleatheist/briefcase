// clippy/frontend/src/app/models/download.model.ts

// Add these missing type definitions
export type BrowserType = 'auto' | 'chrome' | 'firefox' | 'edge' | 'safari' | 'brave' | 'opera';

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
}

export interface BatchDownloadOptions {
  urls: string[];
  quality: string;
  convertToMp4: boolean;
  fixAspectRatio: boolean;
  useCookies: boolean;
  browser: string;
  outputDir: string;
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
}

// Updated interfaces to include job progress information with string dates
export interface BatchJob {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed';
  progress: number;
  currentTask: string;
  error?: string;
  downloadStartTime?: string; // Use string for ISO date format
  downloadEndTime?: string;   // Use string for ISO date format
  processingStartTime?: string; // Use string for ISO date format
  processingEndTime?: string;  // Use string for ISO date format
}

export interface BatchQueueStatus {
  downloadQueue: BatchJob[];
  processingQueue: BatchJob[];
  completedJobs: BatchJob[];  // New
  failedJobs: BatchJob[];     // New
  activeDownloads: string[];
  maxConcurrentDownloads: number;
  isProcessing: boolean;
}