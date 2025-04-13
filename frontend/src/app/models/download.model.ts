// clippy/frontend/src/app/models/download.model.ts
export type QualityOption = '360' | '480' | '720' | '1080' | '1440' | '2160';
export type BrowserType = 'auto' | 'chrome' | 'firefox' | 'edge' | 'safari' | 'brave' | 'opera';

export interface DownloadOptions {
  url: string;
  outputDir?: string;
  quality?: QualityOption;
  convertToMp4?: boolean;
  fps?: number;
  useCookies?: boolean;
  browser?: BrowserType;
  fixAspectRatio?: boolean;
}

export interface VideoInfo {
  title: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  uploadDate?: string; // Added upload date field
}

export interface DownloadProgress {
  progress: number;
  task?: string;
  outputFile?: string;
  jobId?: string;
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

export interface VideoInfo {
  title: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
}

export interface BatchJobInfo {
  id: string;
  url: string;
  status: 'queued' | 'downloading' | 'processing' | 'completed' | 'failed';
  error?: string;
}

export interface BatchQueueStatus {
  downloadQueue: BatchJobInfo[];
  processingQueue: BatchJobInfo[];
  activeDownloads: string[];
  maxConcurrentDownloads: number;
  isProcessing: boolean;
}

export interface BatchDownloadOptions {
  downloads: DownloadOptions[];
}

export interface BatchConfig {
  maxConcurrentDownloads: number;
  enabled: boolean;
}

export interface DownloadResult {
  success: boolean;
  outputFile?: string;
  error?: string;
  jobId?: string;
}