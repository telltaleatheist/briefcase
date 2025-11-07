// clippy/frontend/src/app/models/settings.model.ts
import { BrowserType, QualityOption } from './download.model';

export interface Settings {
  outputDir: string;
  clipsFolder: string; // NEW: Folder where video clips are stored for library
  quality: QualityOption;
  convertToMp4: boolean;
  useCookies: boolean;
  fixAspectRatio: boolean;
  browser: BrowserType;
  theme: 'light' | 'dark';
  batchProcessingEnabled: boolean;
  maxConcurrentDownloads: number;
}

export interface ValidationResult {
  path: string;
  isValid: boolean;
  success: boolean;
}