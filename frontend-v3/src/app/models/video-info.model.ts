// Video Info Models

export interface VideoInfo {
  id: string;
  title: string;
  description: string;
  tags: VideoTag[];
  metadata: VideoMetadata;
  aiAnalyses: AIAnalysis[];
  transcription: TranscriptionSegment[];
  thumbnail?: string;
  videoUrl: string;
  createdAt: Date;
  updatedAt: Date;
  processingStatus: ProcessingStatus;
}

export interface VideoTag {
  id: string;
  name: string;
  color?: string;
  category?: 'genre' | 'topic' | 'mood' | 'technical' | 'custom';
}

export interface VideoMetadata {
  duration: number; // in seconds
  fileSize: number; // in bytes
  resolution: string; // e.g., "1920x1080"
  frameRate: number; // fps
  bitrate: number; // kbps
  codec: string;
  format: string;
  aspectRatio: string;
  audioChannels: number;
  audioBitrate: number; // kbps
  audioCodec: string;
  audioSampleRate: number; // Hz
  capturedDate?: Date;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
  };
  device?: string;
  software?: string;
}

export interface AIAnalysis {
  id: string;
  type: 'summary' | 'highlights' | 'sentiment' | 'topics' | 'entities' | 'scenes' | 'custom';
  model: string;
  timestamp: Date;
  title: string;
  content: string | any; // Could be text or structured data
  confidence?: number;
  highlights?: AnalysisHighlight[];
  tags?: string[];
  customInstructions?: string;
}

export interface AnalysisHighlight {
  text: string;
  timestamp: number; // seconds into video
  duration: number; // seconds
  importance: 'low' | 'medium' | 'high';
  category?: string;
}

export interface TranscriptionSegment {
  id: string;
  startTime: number; // seconds
  endTime: number; // seconds
  text: string;
  speaker?: string;
  confidence?: number;
  words?: WordTiming[];
}

export interface WordTiming {
  word: string;
  startTime: number;
  endTime: number;
  confidence?: number;
}

export interface ProcessingStatus {
  transcription: TaskStatus;
  aiAnalysis: TaskStatus;
  metadata: TaskStatus;
  overall: 'pending' | 'processing' | 'completed' | 'partial' | 'failed';
}

export interface TaskStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  progress?: number;
  error?: string;
  completedAt?: Date;
}

export interface TranscriptionSearchResult {
  segment: TranscriptionSegment;
  matchedText: string;
  context: {
    before: string;
    after: string;
  };
}

export interface VideoInfoFilter {
  tags?: string[];
  searchQuery?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  hasTranscription?: boolean;
  hasAIAnalysis?: boolean;
}