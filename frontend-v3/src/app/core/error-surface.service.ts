import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NotificationService } from '../services/notification.service';

/**
 * The one-line right answer for every catch block: surface the failure to the
 * user (notification + toast) and log the full error for diagnostics.
 *
 * Deliberately has NO silent variant — a fallback that hides its failure is a
 * bug incubator (fallback-audit directive). If a call site truly must stay
 * quiet (e.g. best-effort temp cleanup), it should not be calling this at all,
 * and it must justify its silence with a comment at the site.
 */
@Injectable({ providedIn: 'root' })
export class ErrorSurface {
  private notifications = inject(NotificationService);

  /**
   * @param context Short, user-facing description of what failed
   *                (e.g. "Search failed", "Couldn't save marker").
   * @param error   The caught error — logged in full, summarized for the user.
   */
  surfaceError(context: string, error: unknown): void {
    // Full detail to the console/log for diagnosis…
    console.error(`[${context}]`, error);
    // …and an honest, human-readable notification for the user.
    this.notifications.error(context, describeError(error), true);
  }
}

/** Best human-readable one-liner for an unknown error value. */
export function describeError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return 'Cannot reach the backend server.';
    }
    const serverMessage =
      typeof error.error === 'object' && error.error !== null
        ? (error.error as { error?: string; message?: string }).error ??
          (error.error as { error?: string; message?: string }).message
        : undefined;
    return serverMessage ?? `${error.status} ${error.statusText}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim() !== '') {
    return error;
  }
  return 'Unexpected error — see the log for details.';
}
