import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

/**
 * Keeps the persistent "workspace" host (LibraryPageComponent) alive across
 * /library ↔ /queue ↔ /collections navigations.
 *
 * Without this, every sidebar click would destroy/recreate the component —
 * re-running ngOnInit (WebSocket reconnect + full library reload) and breaking
 * in-flight popout-editor callbacks. Routes opt in via data.reuseKey =
 * 'workspace'; everything else keeps default router behavior.
 */
export class WorkspaceReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    if (future.data?.['reuseKey'] === 'workspace' && curr.data?.['reuseKey'] === 'workspace') {
      return true;
    }
    return super.shouldReuseRoute(future, curr);
  }
}
