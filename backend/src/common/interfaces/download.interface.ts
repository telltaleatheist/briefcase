// clippy/backend/src/common/interfaces/download.interface.ts
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

export interface BatchQueueStatus {
  downloadQueue: BatchJobInfo[];
  processingQueue: BatchJobInfo[];
  activeDownloads: string[];
  maxConcurrentDownloads: number;
  isProcessing: boolean;
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