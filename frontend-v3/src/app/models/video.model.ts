export interface VideoItem {
  id: string;
  name: string;
  suggestedFilename?: string;
  duration?: string; // hh:mm:ss format
  size?: number;
  uploadDate?: Date; // When content was filmed/created
  downloadDate?: Date; // When you downloaded the file
  lastProcessedDate?: Date; // When any task was last run on this video
  thumbnailUrl?: string;
  selected?: boolean;
  // Additional fields for context menu actions
  filePath?: string;
  suggestedTitle?: string;
  hasTranscript?: boolean;
  hasAnalysis?: boolean;
  // Searchable fields
  aiDescription?: string;
  sourceUrl?: string;
  tags?: string[];
  // Media type info
  mediaType?: string;
  fileExtension?: string;
  // Parent-child relationships
  parentIds?: string[]; // Array of parent video IDs (many-to-many)
  childIds?: string[]; // Array of child video IDs (many-to-many)
  children?: VideoItem[]; // Populated child video objects
  parents?: VideoItem[]; // Populated parent video objects
  isGhost?: boolean; // True if this is a ghost item (shown in different week)
  ghostType?: 'parent' | 'child'; // Type of ghost relationship
  ghostRelatedName?: string; // Name of the related video (parent or child)
}

export interface VideoWeek {
  weekLabel: string; // e.g., "Week of Nov 11-17, 2024"
  weekNumber?: number;
  videos: VideoItem[];
}

export interface VideoContextMenuAction {
  label: string;
  icon: string;
  action: string;
  divider?: boolean;
  disabled?: boolean;
}

/**
 * Delete mode options for cascade items
 */
export type DeleteMode = 'database-only' | 'file-only' | 'everything';

/**
 * Item progress for visual progress bar indicator
 */
export interface ItemProgress {
  value: number; // Progress value 0-100
  color?: string; // Optional custom color (defaults to accent color)
  label?: string; // Optional label for accessibility
  indeterminate?: boolean; // Show spinner/indeterminate progress instead of bar
}

/**
 * Status of a child task/item
 */
export type ChildStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';

/**
 * Child item that belongs to a parent video
 * Represents a sub-task, step, or related item
 */
export interface VideoChild {
  id: string;
  parentId: string;
  label: string;
  icon?: string;
  progress?: ItemProgress;
  status?: ChildStatus;
  metadata?: string;
  data?: any;
}

/**
 * Configuration for children/sub-items
 */
export interface ChildrenConfig {
  enabled: boolean;
  expandable: boolean;
  defaultExpanded: boolean;
  generator?: (video: VideoItem) => VideoChild[];
  showMasterProgress: boolean;
  masterProgressCalculator?: (video: VideoItem) => number;
  clickable?: boolean;
  showStatus?: boolean;
}
