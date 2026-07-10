import { Injectable, computed, inject, signal } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { NavigationService } from '../../services/navigation.service';

/** Primary shell destinations. Saved/Archives are temporary (phase-5 deletions). */
export type ShellSection =
  | 'library'
  | 'queue'
  | 'collections'
  | 'settings'
  | 'saved'
  | 'archives'
  | 'other';

/** Single place that knows the URL ↔ section mapping. */
const SECTION_URLS: Record<string, ShellSection> = {
  library: 'library',
  queue: 'queue',
  collections: 'collections',
  settings: 'settings',
  saved: 'saved',
  archives: 'archives',
};

const SIDEBAR_COLLAPSED_KEY = 'briefcase-sidebar-collapsed';
const INSPECTOR_OPEN_KEY = 'briefcase-inspector-open';

/**
 * Signal store for shell navigation state.
 *
 * The router is the source of truth for the active section — this store only
 * derives from it (and offers navigate helpers), so deep links, back/forward,
 * and programmatic navigation all keep the sidebar in sync for free.
 */
@Injectable({ providedIn: 'root' })
export class NavigationStore {
  private router = inject(Router);
  private navigationService = inject(NavigationService);

  private currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(e => e.urlAfterRedirects),
      startWith(this.router.url)
    ),
    { initialValue: this.router.url }
  );

  /** Which sidebar destination the current URL belongs to. */
  activeSection = computed<ShellSection>(() => {
    const url = this.currentUrl().split('?')[0].split('#')[0];
    const first = url.split('/').filter(Boolean)[0] ?? 'library';
    return SECTION_URLS[first] ?? 'other';
  });

  /** Active collection id when on /collections/:id (sidebar highlight only in Phase 1). */
  activeCollectionId = computed<string | null>(() => {
    const url = this.currentUrl().split('?')[0];
    const parts = url.split('/').filter(Boolean);
    return parts[0] === 'collections' && parts[1] ? decodeURIComponent(parts[1]) : null;
  });

  /** Desktop sidebar collapse (persisted). */
  sidebarCollapsed = signal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');

  /** Mobile off-canvas drawer. */
  drawerOpen = signal(false);

  /** Right inspector panel (persisted; manual toggle only — never auto-opens). */
  inspectorOpen = signal(localStorage.getItem(INSPECTOR_OPEN_KEY) === 'true');

  /**
   * Editor full-bleed: VideoPlayerComponent hides the chrome via
   * NavigationService.hideNav()/showNav(). The shell must honor it.
   */
  chromeVisible = computed(() => this.navigationService.navVisible());

  toggleSidebar(): void {
    this.sidebarCollapsed.update(v => !v);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(this.sidebarCollapsed()));
  }

  toggleDrawer(): void {
    this.drawerOpen.update(v => !v);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }

  toggleInspector(): void {
    this.inspectorOpen.update(v => !v);
    localStorage.setItem(INSPECTOR_OPEN_KEY, String(this.inspectorOpen()));
  }

  /** Navigate to a primary section; closes the mobile drawer. */
  goTo(section: Exclude<ShellSection, 'other'>): void {
    this.drawerOpen.set(false);
    this.router.navigate([`/${section}`]);
  }

  /** Navigate to a specific collection (Phase 1: highlight only; view shows all). */
  goToCollection(id: string): void {
    this.drawerOpen.set(false);
    this.router.navigate(['/collections', id]);
  }
}
