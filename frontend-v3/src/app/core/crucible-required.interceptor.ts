import { EnvironmentInjector, inject } from '@angular/core';
import { HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { CrucibleReadinessService } from '../services/crucible-readiness.service';

/**
 * Every AI request the backend refuses because Crucible is not ready answers
 * 409 `crucible_required` (P7). This hands each one to CrucibleReadinessService
 * (the view updates and the global prompt offers the door) and rethrows, so the
 * caller can show the refusal's own sentence instead of a generic error.
 *
 * The service is looked up only on the error path: it makes HTTP requests of
 * its own while being constructed, and injecting it up front would recurse.
 */
export const crucibleRequiredInterceptor: HttpInterceptorFn = (req, next) => {
  const injector = inject(EnvironmentInjector);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (CrucibleReadinessService.refusalOf(error)) {
        injector.get(CrucibleReadinessService).handleRefusal(error);
      }
      return throwError(() => error);
    })
  );
};
