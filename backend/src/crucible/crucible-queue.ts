/**
 * CRUCIBLE'S QUEUE (crucible docs/QUEUE.md, 1.0.71+): a job submitted with
 * `queue` waits in the server's line while the card is busy, instead of being
 * refused `server_busy`. Briefcase's asr jobs go in line, and (1.0.76) an
 * analysis run's queue session waits in the same line before it opens
 * (crucible-chat.service.ts); the loads and calls inside it then go ahead.
 *
 * A job in line is followed on its event stream, which keeps it there (the
 * server drops a waiting job nobody follows after 300 s). The stream is quiet
 * between moves, so Briefcase says the task is alive every QUEUE_HEARTBEAT_MS,
 * and a job taken out of the line (`removed`: expired, the operator, a
 * restart) parks the task: not run, not failed.
 */
import type { Activity } from '@crucible/client';
import { compareVersions } from './probe';

/** The first Crucible that holds a job in its queue while it is busy. */
export const QUEUE_MIN_VERSION = '1.0.71';

/** How often a task waiting in Crucible's line tells the stall watchdog it is alive. */
export const QUEUE_HEARTBEAT_MS = 60_000;

/** Does this server queue work (a load, an asr job) instead of refusing it busy? */
export function queuesWork(activity: Pick<Activity, 'server'>): boolean {
  return compareVersions(activity.server.version, QUEUE_MIN_VERSION) >= 0;
}
