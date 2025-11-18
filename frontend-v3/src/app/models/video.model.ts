export interface VideoItem {
  id: string;
  name: string;
  suggestedFilename: string;
  duration: string; // hh:mm:ss format
  size?: number;
  downloadDate?: Date;
  thumbnailUrl?: string;
  selected?: boolean;
  // Additional fields for context menu actions
  filePath?: string;
  suggestedTitle?: string;
  hasTranscript?: boolean;
  hasAnalysis?: boolean;
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
