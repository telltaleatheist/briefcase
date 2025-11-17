/**
 * Process Registry - Centralized configuration for all process types
 *
 * To add a new process type:
 * 1. Add entry to PROCESS_DEFINITIONS below
 * 2. Add backend endpoint that matches the apiPath
 * 3. That's it!
 */

import { ProcessType } from './video-processing.model';

export interface ProcessDefinition {
  type: ProcessType;
  displayName: string;
  icon: string;
  apiPath: string;
  requiresVideoId?: boolean;
  defaultConfig?: Record<string, any>;
}

/**
 * Registry of all available process types
 * Add new processes here!
 */
export const PROCESS_DEFINITIONS: Record<ProcessType, ProcessDefinition> = {
  'download': {
    type: 'download',
    displayName: 'Download',
    icon: 'download',
    apiPath: '/downloader/download-only',
    requiresVideoId: false,
  },

  'import': {
    type: 'import',
    displayName: 'Import to Library',
    icon: 'library_add',
    apiPath: '/library/import-file',
    requiresVideoId: false,
  },

  'process': {
    type: 'process',
    displayName: 'Fix Aspect Ratio',
    icon: 'aspect_ratio',
    apiPath: '/ffmpeg/process-aspect-ratio',
    requiresVideoId: false,
  },

  'normalize': {
    type: 'normalize',
    displayName: 'Normalize Audio',
    icon: 'equalizer',
    apiPath: '/ffmpeg/normalize-audio',
    requiresVideoId: false,
  },

  'process-video': {
    type: 'process-video',
    displayName: 'Process Video',
    icon: 'video_settings',
    apiPath: '/media/process-video',
    requiresVideoId: false,
    defaultConfig: {
      fixAspectRatio: true,
      normalizeAudio: true,
      level: -16,
      method: 'rms'
    }
  },

  'transcribe': {
    type: 'transcribe',
    displayName: 'Transcribe',
    icon: 'subtitles',
    apiPath: '/analysis/transcribe',
    requiresVideoId: true,
    defaultConfig: {
      whisperModel: 'base',
      language: 'en'
    }
  },

  'analyze': {
    type: 'analyze',
    displayName: 'AI Analysis',
    icon: 'psychology',
    apiPath: '/analysis/analyze',
    requiresVideoId: true,
  },

  // Future processes can be added here:
  // 'compress': {
  //   type: 'compress',
  //   displayName: 'Compress Video',
  //   icon: 'compress',
  //   apiPath: '/ffmpeg/compress',
  //   requiresVideoId: false,
  //   defaultConfig: { quality: 23 }
  // },
};

/**
 * Get process definition by type
 */
export function getProcessDefinition(type: ProcessType): ProcessDefinition {
  return PROCESS_DEFINITIONS[type];
}

/**
 * Get display name for a process type
 */
export function getProcessDisplayName(type: ProcessType): string {
  return PROCESS_DEFINITIONS[type]?.displayName || type;
}

/**
 * Get icon for a process type
 */
export function getProcessIcon(type: ProcessType): string {
  return PROCESS_DEFINITIONS[type]?.icon || 'settings';
}

/**
 * Get API path for a process type
 */
export function getProcessApiPath(type: ProcessType): string {
  return PROCESS_DEFINITIONS[type]?.apiPath || '';
}
