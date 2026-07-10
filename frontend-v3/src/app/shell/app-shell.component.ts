import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SetupWizardComponent } from '../components/setup-wizard/setup-wizard.component';
import { NavigationStore, ShellSection } from '../core/stores/navigation.store';
import { LibraryService } from '../services/library.service';
import { QueueService } from '../services/queue.service';
import { TabsService } from '../services/tabs.service';
import { ThemeService } from '../services/theme.service';
import { TourService } from '../services/tour.service';
import { LoggerService } from '../services/logger.service';
import { SidebarComponent } from './sidebar/sidebar.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { InspectorPanelComponent } from './inspector/inspector-panel.component';

const SECTION_TITLES: Record<ShellSection, string> = {
  library: 'Library',
  queue: 'Queue',
  collections: 'Collections',
  settings: 'Settings',
  manager: 'Library Manager',
  saved: 'Saved for Later',
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
  imports: [RouterOutlet, SidebarComponent, ToolbarComponent, InspectorPanelComponent, SetupWizardComponent],
  templateUrl: './app-shell.component.html',
  styleUrls: ['./app-shell.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppShellComponent {
  nav = inject(NavigationStore);
  private router = inject(Router);
  private libraryService = inject(LibraryService);
  private queueService = inject(QueueService);
  private tabsService = inject(TabsService);
  private themeService = inject(ThemeService);
  private tourService = inject(TourService);
  private loggerService = inject(LoggerService);

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

  /** Manage-components wizard (Models & Tools) — relocated from the old nav rail. */
  componentManagerOpen = signal(false);

  onOpenLibrarySwitcher(): void {
    // The Library Manager modal lives inside the workspace (library-page),
    // which watches libraryManagerRequested. Make sure the workspace is
    // routed in before requesting.
    const section = this.nav.activeSection();
    const workspaceLoaded = ['library', 'queue', 'collections', 'manager', 'saved', 'archives'].includes(section);
    if (workspaceLoaded) {
      this.libraryService.requestLibraryManager();
    } else {
      this.router.navigate(['/library']).then(() => this.libraryService.requestLibraryManager());
    }
  }

  onToggleTheme(): void {
    this.themeService.toggleTheme();
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
