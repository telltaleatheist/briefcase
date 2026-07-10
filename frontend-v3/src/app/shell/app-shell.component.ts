import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationStore, ShellSection } from '../core/stores/navigation.store';
import { SelectionStore } from '../core/stores/selection.store';
import { WorkspaceActionsService, WorkspaceAction, AddDownloadsPayload } from '../core/stores/workspace-actions.service';
import { AiSetupService } from '../services/ai-setup.service';
import { LibraryService } from '../services/library.service';
import { QueueService } from '../services/queue.service';
import { TabsService } from '../services/tabs.service';
import { ThemeService } from '../services/theme.service';
import { TourService } from '../services/tour.service';
import { LoggerService } from '../services/logger.service';
import { SidebarComponent } from './sidebar/sidebar.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { ToolbarActionsComponent } from './toolbar/toolbar-actions.component';
import { InspectorPanelComponent } from './inspector/inspector-panel.component';

const SECTION_TITLES: Record<ShellSection, string> = {
  library: 'Library',
  queue: 'Queue',
  collections: 'Collections',
  settings: 'Settings',
  archives: 'Web Archives',
  other: '',
};

/**
 * App shell — owns the four layout regions (sidebar / toolbar / content /
 * inspector) and nothing else. All state lives in stores/services; the
 * sidebar and toolbar are dumb components wired here.
 *
 * Chrome (sidebar/toolbar/inspector) hides entirely when
 * NavigationService.navVisible() is false — the editor's full-bleed mode.
 */
@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, ToolbarComponent, ToolbarActionsComponent, InspectorPanelComponent],
  templateUrl: './app-shell.component.html',
  styleUrls: ['./app-shell.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppShellComponent {
  nav = inject(NavigationStore);
  selection = inject(SelectionStore);
  private router = inject(Router);
  private libraryService = inject(LibraryService);
  private queueService = inject(QueueService);
  private tabsService = inject(TabsService);
  private themeService = inject(ThemeService);
  private tourService = inject(TourService);
  private loggerService = inject(LoggerService);
  private aiSetupService = inject(AiSetupService);
  private workspaceActions = inject(WorkspaceActionsService);

  /** Sections hosted by the persistent workspace (LibraryPageComponent). */
  private static readonly WORKSPACE_SECTIONS: ShellSection[] = [
    'library', 'queue', 'collections', 'archives'
  ];

  constructor() {
    // The sidebar shows collections; the shell owns loading them.
    // (loadTabs also refreshes tabbedVideoIds, which the workspace consumes.)
    this.tabsService.loadTabs().pipe(takeUntilDestroyed()).subscribe();
  }

  // ── Read-only projections of the real service state (never library-page copies)
  currentLibraryName = computed(() => this.libraryService.currentLibrary()?.name ?? '');
  queueCount = computed(
    () => this.queueService.pendingJobs().length + this.queueService.processingJobs().length
  );
  collections = computed(() => this.tabsService.tabs());
  isDarkTheme = computed(() => this.themeService.isDarkMode());
  sectionTitle = computed(() => SECTION_TITLES[this.nav.activeSection()]);
  hasTour = computed(() => this.tourService.hasTourForRoute(this.router.url));
  /** Reactive: getSetupStatus() reads the availability signal internally. */
  aiReady = computed(() => this.aiSetupService.getSetupStatus().isReady);
  onWorkspace = computed(() => AppShellComponent.WORKSPACE_SECTIONS.includes(this.nav.activeSection()));

  onSelectSection(section: Exclude<ShellSection, 'other'>): void {
    this.nav.goTo(section);
  }

  onSelectCollection(id: string): void {
    this.nav.goToCollection(id);
  }

  onNewCollection(): void {
    // Phase 1: the collections view owns creation; just take the user there.
    this.nav.goTo('collections');
  }

  onOpenLibrarySwitcher(): void {
    // Libraries now live in Settings → Libraries (the modal remains only for
    // the first-run "no libraries" flow inside the workspace).
    this.nav.closeDrawer();
    this.router.navigate(['/settings/libraries']);
  }

  onToggleTheme(): void {
    this.themeService.toggleTheme();
  }

  // ── Toolbar actions → workspace dispatch ──────────────────────────────
  // Selection actions can only fire while the workspace is routed in (the
  // selection lives there); Add/import actions ensure it first.

  dispatchToWorkspace(action: WorkspaceAction): void {
    if (this.onWorkspace()) {
      this.workspaceActions.dispatch(action);
    } else {
      this.router.navigate(['/library']).then(() => this.workspaceActions.dispatch(action));
    }
  }

  onSubmitAdd(payload: AddDownloadsPayload): void {
    this.dispatchToWorkspace({ type: 'submitDownloads', payload });
  }

  onStartTour(): void {
    const tour = this.tourService.getTourForRoute(this.router.url);
    if (tour) {
      this.tourService.startTour(tour.id);
    }
  }

  onDownloadLogs(): void {
    this.loggerService.downloadLogs();
  }
}
