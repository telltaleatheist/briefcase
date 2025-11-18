import { TaskType, TaskConfig } from './task.model';
import { VideoItem } from './video.model';

export type QueueItemSource = 'library' | 'url';

export interface QueueItemTask {
  type: TaskType;
  config?: TaskConfig;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number; // 0-100
  startTime?: Date;
  endTime?: Date;
  error?: string;
}

export interface QueueItem {
  id: string;
  source: QueueItemSource;

  // For library items
  video?: VideoItem;

  // For URL items
  url?: string;
  urlTitle?: string;

  // Tasks with configurations
  tasks: QueueItemTask[];

  // Overall progress
  overallProgress?: number; // 0-100
  status?: 'pending' | 'running' | 'completed' | 'failed';

  // UI state
  expanded?: boolean;
}

export interface QueueState {
  items: QueueItem[];
  expanded: boolean;
  processing: boolean;
}
