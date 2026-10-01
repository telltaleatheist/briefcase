/**
 * How a chat through Crucible fails, each by name. The analysis pipeline tells
 * three kinds apart: a cancellation (the user's), a busy card (wait, never
 * fail), and everything else (a real failure with the server's own sentence).
 */

/** The server refused or failed a chat, with its `{error: {code, message}}`. */
export class CrucibleChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly server: string | null = null,
    /** From `Retry-After`, when the server sent one (429, 503). */
    readonly retryAfterMs: number | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'CrucibleChatError';
  }
}

/**
 * The card is held by someone else (a `409 server_busy` / `leased` on a load or
 * a lease). P3's minimal admission waits this out; P4 parks the task on it.
 */
/**
 * The refusal (or failure) codes that mean "the card is briefly someone
 * else's", never "no": a job on the lane, a lease, `engine_in_use` (the
 * engine is claimed: a streaming session, or Crucible's own settlement after a
 * lapsed lease), and `accelerator_busy` (another process holds the card's
 * memory; Crucible never evicts it, so it frees when that process ends: seen
 * 2026-10-01 under WSL, 19.5 of 24 GiB taken by a process the driver would
 * not name). Parked in a queue run, waited out (bounded) otherwise. None may
 * fail a task.
 */
export const BUSY_REFUSAL_CODES: ReadonlySet<string> = new Set(['server_busy', 'leased', 'engine_in_use', 'accelerator_busy']);

export class CrucibleBusyError extends Error {
  readonly code = 'crucible_busy';
  constructor(readonly server: string, readonly busyLine: string) {
    super(`Crucible "${server}" is busy (${busyLine}).`);
    this.name = 'CrucibleBusyError';
  }
}

/** No enabled Crucible server could take the call. */
export class CrucibleNoVenueError extends Error {
  readonly code = 'no_venue';
  constructor(message: string) {
    super(message);
    this.name = 'CrucibleNoVenueError';
  }
}

/** The caller's own cancel. Never a failure to retry or record. */
export class CrucibleChatCancelled extends Error {
  readonly code = 'cancelled';
  constructor(message = 'The AI request was cancelled.') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Seconds (or an HTTP date) to milliseconds; null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: () => number = Date.now): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now());
  return null;
}

/**
 * P4: the task cannot run on Crucible RIGHT NOW (a card held by someone else,
 * a server that stopped answering, no server that can take it) and is to be
 * PARKED by the queue: not failed, not retried in a loop, asked again later.
 *
 * It carries the structural `cancelled` marker on purpose. The analysis
 * pipeline is full of catch blocks that record a failure and carry on, or
 * degrade to a weaker path; every one of them already re-throws a
 * cancellation (`isCancellation`), so a park unwinds the whole run exactly as a
 * cancel does, with nothing persisted and the previous analysis intact (the
 * `0378d02` rule). `parked` is what tells the queue it was not the user.
 */
export class CrucibleParkedError extends Error {
  readonly code = 'crucible_parked';
  readonly cancelled = true;
  readonly parked = true;
  constructor(readonly server: string | null, readonly reason: string) {
    super(reason);
    this.name = 'CrucibleParkedError';
  }
}

export function isParked(error: unknown): error is CrucibleParkedError {
  return typeof error === 'object' && error !== null && (error as { parked?: unknown }).parked === true;
}
