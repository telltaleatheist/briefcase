/**
 * Unified Queue Job Model
 *
 * Single source of truth for all queue state. Jobs have a `state` property
 * that determines which section they appear in (pending, processing, completed).
 */

import { TaskType } from './task.model';

// Job states
export type JobState = 'pending' | 'processing' | 'completed' | 'failed';

// Task states within a job
export type TaskState = 'pending' | 'running' | 'completed' | 'failed';

/**
 * A task within a queue job
 */
export interface QueueTask {
  type: TaskType;
  options: Record<string, any>;
  state: TaskState;
  progress: number; // 0-100
  errorMessage?: string;
  eta?: number;           // Estimated seconds remaining
  taskLabel?: string;     // Human-readable task name (e.g., "Transcribing...")
}

/**
 * A job in the processing queue
 */
export interface QueueJob {
  id: string;
  state: JobState;

  // Source info (one of these should be set)
  url?: string;           // For URL downloads
  videoId?: string;       // For library video processing
  videoPath?: string;     // For local file imports

  // Display info
  title: string;
  duration?: string;      // HH:MM:SS format
  thumbnail?: string;
  titleResolved?: boolean; // False while fetching metadata

  // Backend tracking
  backendJobId?: string;  // ID returned by backend when job is submitted

  // Tasks
  tasks: QueueTask[];

  // Timestamps (using numbers for easy localStorage serialization)
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  // Error info (for failed jobs)
  errorMessage?: string;
}

/**
 * Statistics about queue state
 */
export interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

/**
 * Helper to create a new job with defaults
 */
export function createQueueJob(partial: Partial<QueueJob> & { title: string }): QueueJob {
  return {
    id: partial.id || generateJobId(),
    state: partial.state || 'pending',
    title: partial.title,
    url: partial.url,
    videoId: partial.videoId,
    videoPath: partial.videoPath,
    duration: partial.duration,
    thumbnail: partial.thumbnail,
    titleResolved: partial.titleResolved ?? true,
    backendJobId: partial.backendJobId,
    tasks: partial.tasks || [],
    createdAt: partial.createdAt || Date.now(),
    startedAt: partial.startedAt,
    completedAt: partial.completedAt,
    errorMessage: partial.errorMessage,
  };
}

/**
 * Helper to create a new task with defaults
 */
export function createQueueTask(type: TaskType, options: Record<string, any> = {}): QueueTask {
  return {
    type,
    options,
    state: 'pending',
    progress: 0,
  };
}

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Check if a job is done (completed or failed)
 */
export function isJobDone(job: QueueJob): boolean {
  return job.state === 'completed' || job.state === 'failed';
}

/**
 * Check if all tasks in a job are done
 */
export function areAllTasksDone(job: QueueJob): boolean {
  if (job.tasks.length === 0) return false;
  return job.tasks.every(t => t.state === 'completed' || t.state === 'failed');
}

/**
 * Check if any task in a job has failed
 */
export function hasFailedTask(job: QueueJob): boolean {
  return job.tasks.some(t => t.state === 'failed');
}

/**
 * Calculate overall job progress from task progress
 */
export function calculateJobProgress(job: QueueJob): number {
  if (job.tasks.length === 0) return 0;
  const total = job.tasks.reduce((sum, t) => sum + t.progress, 0);
  return Math.round(total / job.tasks.length);
}
