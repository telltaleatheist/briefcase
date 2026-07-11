import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withViewTransitions, withInMemoryScrolling, withNavigationErrorHandler, NavigationError, RouteReuseStrategy } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient } from '@angular/common/http';
import { routes } from './app.routes';
import { WorkspaceReuseStrategy } from './core/workspace-reuse.strategy';

/**
 * A lazy route chunk failed to fetch — the running bundle is stale (the app
 * was rebuilt or auto-updated underneath this window), so the hashed chunk
 * filenames it knows no longer exist on the server. Without this handler the
 * navigation silently no-ops ("the button does nothing"); instead, force a
 * full reload onto the new build at the intended URL.
 */
function handleStaleChunkNavigation(error: NavigationError): void {
  const message = String(
    (error.error as Error | undefined)?.message ?? error.error ?? ''
  );
  const isChunkFailure =
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('ChunkLoadError');
  if (isChunkFailure) {
    window.location.assign(error.url);
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    { provide: RouteReuseStrategy, useClass: WorkspaceReuseStrategy },
    provideRouter(
      routes,
      withViewTransitions({
        skipInitialTransition: true,
      }),
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      }),
      withNavigationErrorHandler(handleStaleChunkNavigation)
    ),
    provideAnimations(),
    provideHttpClient()
  ]
};
