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
