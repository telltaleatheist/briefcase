/**
 * Queue admission lanes (Crucible migration §7.6).
 *
 * Mirrors the backend's GET /queue/lanes and the `queue.lanes` socket event.
 * In `mode: 'direct'` the lane list is empty and the queue UI draws nothing new.
 */

/** A task currently occupying a lane. */
export interface LaneTaskView {
  jobId: string;
  title: string;
  model: string;
  lane: string;
}

export type LaneState = 'ready' | 'busy' | 'unreachable' | 'paused' | 'unavailable';

/** One admission lane: a Crucible GPU server, or the cloud upstream lane. */
export interface LaneView {
  id: string;                 // 'gpu:<server>' or 'cloud'
  kind: 'gpu' | 'cloud';
  label: string;              // 'GPU · <server>' or 'Cloud'
  server: string | null;      // null for cloud
  state: LaneState;
  detail: string | null;      // holder sentence while busy, or why unreachable/unavailable
  residentModel: string | null;
  width: number;              // 1 for gpu, 2 for cloud
  running: LaneTaskView[];
  waiting: number;            // tasks waiting/parked for this lane
}

export type LanesMode = 'crucible' | 'direct';

/** The lanes snapshot the queue tab draws from. */
export interface LanesStatus {
  mode: LanesMode;
  lanes: LaneView[];
  timestamp: string;
}
