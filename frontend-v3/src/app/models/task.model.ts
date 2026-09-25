export type TaskType = 'download-import' | 'fix-aspect-ratio' | 'normalize-audio' | 'transcribe' | 'ai-analyze' | 'analyze-webpage' | 'export-clip';

export interface Task {
  type: TaskType;
  label: string;
  description: string;
  icon: string;
  requiresUrl: boolean;  // Only available for URL inputs
  requiresFile: boolean;  // Only available for file inputs
}

export interface TaskSelection {
  task: Task;
  selected: boolean;
  config?: TaskConfig;
}

export interface TaskConfig {
  [key: string]: any;
}

// Task-specific configuration options
export interface DownloadImportConfig {
  quality?: '2160' | '1440' | '1080' | '720' | '480' | 'best';
  format?: 'mp4' | 'webm' | 'mkv';
}

/**
 * Transcribe has no per-task options (P7): it is Crucible's asr job, the model
 * comes from Settings › Transcription, and speech is transcribed in its own
 * language.
 */
export type TranscribeConfig = Record<string, never>;

/**
 * AI Analyze's options. The analysis is Crucible's pipeline: chapters from the
 * scorer's outline and decisions, flags ranked by the scorer and checked by
 * `aiModel`, which also writes chapter titles, the description, tags and a
 * title. There is no sensitivity, quality or engine option: the analysis always
 * captures everything (sensitivity is a display filter in the editor).
 */
export interface AIAnalyzeConfig {
  /** A stored `provider:model` choice (`local:<id>`, `claude:<id>`, …): one of the connected Crucible's options. */
  aiModel?: string;
  customInstructions?: string;
}

export interface FixAspectRatioConfig {
  targetRatio?: '16:9' | '4:3' | '1:1' | '9:16' | 'auto';
  cropMode?: 'center' | 'smart' | 'letterbox';
  stripBlackBars?: boolean;
}

export interface NormalizeAudioConfig {
  targetLevel?: number; // LUFS, -24 (quiet) to -9 (loud), default -14
  peakLevel?: number;
}

export interface JobRequest {
  inputType: 'url' | 'files';
  url?: string;
  fileIds?: string[];
  tasks: TaskType[];
}

export const AVAILABLE_TASKS: Task[] = [
  {
    type: 'download-import',
    label: 'Download and Import',
    description: 'Download video from URL and add to library',
    icon: '⬇️',
    requiresUrl: true,
    requiresFile: false
  },
  {
    type: 'fix-aspect-ratio',
    label: 'Fix Aspect Ratio',
    description: 'Correct video aspect ratio issues',
    icon: '📐',
    requiresUrl: false,
    requiresFile: true
  },
  {
    type: 'normalize-audio',
    label: 'Normalize Audio',
    description: 'Normalize audio levels to standard volume',
    icon: '🔊',
    requiresUrl: false,
    requiresFile: true
  },
  {
    type: 'transcribe',
    label: 'Transcribe',
    description: 'Generate a transcript on Crucible',
    icon: '📝',
    requiresUrl: false,
    requiresFile: true
  },
  {
    type: 'ai-analyze',
    label: 'AI Analyze',
    description: 'Analyze content with AI on Crucible',
    icon: '🤖',
    requiresUrl: false,
    requiresFile: true
  }
];
