// ============================================================================
// RIPPLECUT - Models & Interfaces
// ============================================================================
// Export these interfaces so consuming projects can properly type their data

export interface EditorTab {
  id: string;
  title: string;
  duration: number;
  isActive: boolean;
}

export interface TimelineSection {
  id: string;
  startTime: number;
  endTime: number;
  category: string;
  description: string;
  color: string;
}

export interface TimelineChapter {
  id: string;
  startTime: number;
  endTime: number;
  title: string;
}

export interface CustomMarker {
  id: string;
  time: number;
  endTime?: number; // For range markers
  message: string;
  type: 'standard' | 'todo' | 'completed' | 'chapter' | 'analysis';
  clipId?: string; // Which clip this marker belongs to
  category?: string; // For AI analysis markers
  severity?: 'low' | 'medium' | 'high'; // For AI analysis
}

export interface TimelineClip {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  lane: number; // 0 = master, 1+ = video overlays, -1 and below = audio
  color?: string;
  sourceIn?: number;
  sourceOut?: number;
  // Optional: media source reference for backend integration
  mediaUrl?: string;
  thumbnailUrl?: string;
  // Audio linking - video clips can have linked audio
  linkedAudioId?: string; // ID of the linked audio clip (for video clips)
  linkedVideoId?: string; // ID of the linked video clip (for audio clips)
  // Clip type for lane restrictions
  type?: 'video' | 'audio' | 'title'; // Defaults to 'video' for lane >= 0, 'audio' for lane < 0
}

export interface TranscriptSegment {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  speaker?: string; // Optional speaker identification
}

export interface Selection {
  start: number;
  end: number;
}

// ============================================================================
// Configuration Interface
// ============================================================================

export interface RipplecutConfig {
  // Frame rate for timecode display and snapping
  frameRate?: number;
  // Whether to show the browser panel by default
  showBrowser?: boolean;
  // Whether to show the inspector panel by default
  showInspector?: boolean;
  // Default inspector tab
  defaultInspectorTab?: 'analysis' | 'chapters' | 'transcript';
  // Enable/disable features
  enableAnalysis?: boolean;
  enableChapters?: boolean;
  enableTranscript?: boolean;
  // Custom playback rates
  playbackRates?: number[];
}

// ============================================================================
// Event Payloads (for Output events)
// ============================================================================

export interface PlayheadChangeEvent {
  time: number;
  formattedTime: string;
}

export interface SelectionChangeEvent {
  selection: Selection | null;
  clips?: TimelineClip[];
}

export interface ClipChangeEvent {
  type: 'move' | 'trim' | 'add' | 'delete';
  clip: TimelineClip;
  previousState?: TimelineClip;
}

export interface MarkerChangeEvent {
  type: 'add' | 'update' | 'delete';
  marker: CustomMarker;
}

export interface ExportRequestEvent {
  format: string;
  resolution: string;
  range: 'entire' | 'selection';
  selection?: Selection;
}
