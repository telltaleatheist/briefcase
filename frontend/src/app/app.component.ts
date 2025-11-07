// clippy/frontend/src/app/app.component.ts
import { Component, OnInit, OnDestroy, inject, ViewEncapsulation, ViewChild, Renderer2 } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, RouterOutlet } from '@angular/router';
import { MatSidenav } from '@angular/material/sidenav';

import { ThemeService } from './services/theme.service';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';

import { SocketService } from './services/socket.service';
import { SettingsService } from './services/settings.service';
import { BatchStateService } from './services/batch-state.service';
import { NotificationService } from './services/notification.service';
import { DatabaseLibraryService } from './services/database-library.service';
import { ThemeToggleComponent } from './components/theme-toggle/theme-toggle.component';
import { NotificationToastComponent } from './components/notification-toast/notification-toast.component';
import { NotificationBellComponent } from './components/notification-bell/notification-bell.component';
import { NotificationModalComponent } from './components/notification-modal/notification-modal.component';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  encapsulation: ViewEncapsulation.None, // Add this to ensure styles apply globally
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    RouterOutlet,  // Add this for router-outlet
    MatSnackBarModule,
    MatToolbarModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatSidenavModule,
    MatListModule,
    ThemeToggleComponent,  // Import the ThemeToggleComponent
    NotificationToastComponent,
    NotificationBellComponent,
    NotificationModalComponent
  ]
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'Clippy - Video Downloader';
  isDownloading = false;
  currentYear = new Date().getFullYear();

  @ViewChild('sidenav') sidenav!: MatSidenav;
  private mutationObserver?: MutationObserver;

  private socketService = inject(SocketService);
  private settingsService = inject(SettingsService);
  private batchStateService = inject(BatchStateService);
  private themeService = inject(ThemeService);  // Inject the ThemeService
  private notificationService = inject(NotificationService);  // Inject the NotificationService
  private databaseLibraryService = inject(DatabaseLibraryService);  // Inject the DatabaseLibraryService
  public router = inject(Router);
  private renderer = inject(Renderer2);

  ngOnInit(): void {
    // Let theme service handle default (which is dark mode)
    // Don't override the saved preference or default

    // Preload library data in background so it's ready when user navigates to library
    this.databaseLibraryService.preloadLibraryData().catch(err => {
      console.log('[AppComponent] Library preload failed (this is expected if library is empty):', err);
    });

    // Log router events for debugging
    this.router.events.subscribe(event => {
      console.log('Router event:', event);
    });

    // Dialog tracking removed - was causing freezing issues
    // Users can press ESC to close dialogs or use the close button in the dialog header

    // Subscribe to sidenav open/close events and add class to document body
    setTimeout(() => {
      if (this.sidenav) {
        // Set initial state
        this.updateSidenavClass(this.sidenav.opened);

        // Subscribe to changes
        this.sidenav.openedChange.subscribe((opened: boolean) => {
          this.updateSidenavClass(opened);
        });
      }
    });

    // Watch for progress cards being added to the DOM and apply positioning
    this.mutationObserver = new MutationObserver(() => {
      // Get actual sidenav width dynamically
      const sidenavEl = document.querySelector('.mat-drawer.mat-drawer-side') as HTMLElement;
      const sidenavWidth = sidenavEl ? sidenavEl.offsetWidth : 0;
      const leftPosition = (this.sidenav?.opened && sidenavWidth > 0) ? `${sidenavWidth}px` : '0px';
      const rightPosition = '0px';
      const selectors = ['.batch-progress-card', 'mat-card.batch-progress-card', '.mat-mdc-card.batch-progress-card'];

      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach((el: Element) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.left = leftPosition;
          htmlEl.style.right = rightPosition;
          htmlEl.style.width = 'auto';
        });
      });
    });

    // Start observing
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.socketService.onConnect().subscribe(() => {
      // No notification needed - connection is expected
    });

    this.socketService.onDisconnect().subscribe(() => {
      // Toast-only for disconnection - doesn't clutter history
      this.notificationService.toastOnly('warning', 'Disconnected', 'Connection to server lost');
    });

    this.socketService.onDownloadStarted().subscribe(() => {
      this.isDownloading = true;
      // No notification - batch component handles per-video notifications
    });

    this.socketService.onDownloadCompleted().subscribe(() => {
      this.isDownloading = false;
      // No notification - batch component handles per-video notifications
    });

    this.socketService.onDownloadFailed().subscribe((error) => {
      this.isDownloading = false;
      // No notification - batch component handles per-video notifications
    });

    // Listen for beforeunload event to clear queue when app closes
    window.addEventListener('beforeunload', this.handleBeforeUnload.bind(this));
  }

  ngOnDestroy(): void {
    // Clean up event listener
    window.removeEventListener('beforeunload', this.handleBeforeUnload.bind(this));

    // Clean up mutation observer
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
    }
  }

  private handleBeforeUnload(): void {
    // Clear the pending jobs queue when the app is closing
    this.batchStateService.clearPendingJobs();
  }

  navigateToBatch(): void {
    this.router.navigate(['/batch']);
  }

  navigateToAnalysis(): void {
    console.log('Navigating to analysis...');
    this.router.navigate(['/analysis']).then(success => {
      console.log('Navigation success:', success);
    }).catch(error => {
      console.error('Navigation error:', error);
    });
  }

  onLibraryClick(): void {
    console.log('[AppComponent] Library link clicked at', new Date().toISOString(), performance.now());
  }

  private updateSidenavClass(opened: boolean): void {
    // Get actual sidenav width dynamically
    const sidenavEl = document.querySelector('.mat-drawer.mat-drawer-side') as HTMLElement;
    const sidenavWidth = sidenavEl ? sidenavEl.offsetWidth : 0;
    const leftPosition = (opened && sidenavWidth > 0) ? `${sidenavWidth}px` : '0px';
    const rightPosition = '0px';

    // Directly update any existing progress cards
    const selectors = ['.batch-progress-card', 'mat-card.batch-progress-card', '.mat-mdc-card.batch-progress-card'];

    selectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el: Element) => {
        const htmlEl = el as HTMLElement;
        htmlEl.style.left = leftPosition;
        htmlEl.style.right = rightPosition;
        htmlEl.style.width = 'auto';
      });
    });
  }
}