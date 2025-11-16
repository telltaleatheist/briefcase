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
import { MatDialog } from '@angular/material/dialog';

import { SocketService } from './services/socket.service';
import { SettingsService } from './services/settings.service';
import { BatchStateService } from './services/batch-state.service';
import { NotificationService } from './services/notification.service';
import { DatabaseLibraryService } from './services/database-library.service';
import { AiSetupHelperService } from './services/ai-setup-helper.service';
import { ConsoleLoggerService } from './services/console-logger.service';
import { VideoProcessingQueueService } from './services/video-processing-queue.service';
import { ThemeToggleComponent } from './components/theme-toggle/theme-toggle.component';
import { NotificationToastComponent } from './components/notification-toast/notification-toast.component';
import { NotificationBellComponent } from './components/notification-bell/notification-bell.component';
import { NotificationModalComponent } from './components/notification-modal/notification-modal.component';
import { DownloadQueueComponent } from './components/download-queue/download-queue.component';
import { DownloadProgressService } from './services/download-progress.service';
import { AiSetupWizardComponent } from './components/ai-setup-wizard/ai-setup-wizard.component';

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
    NotificationModalComponent,
    DownloadQueueComponent
  ]
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'Clippy - Video Downloader';
  isDownloading = false;
  currentYear = new Date().getFullYear();

  @ViewChild('sidenav') sidenav!: MatSidenav;

  private socketService = inject(SocketService);
  private settingsService = inject(SettingsService);
  private batchStateService = inject(BatchStateService);
  private themeService = inject(ThemeService);  // Inject the ThemeService
  private notificationService = inject(NotificationService);  // Inject the NotificationService
  private databaseLibraryService = inject(DatabaseLibraryService);  // Inject the DatabaseLibraryService
  private downloadProgressService = inject(DownloadProgressService);  // CRITICAL: Inject to instantiate on app start
  private videoProcessingQueueService = inject(VideoProcessingQueueService);  // CRITICAL: Inject to instantiate on app start and setup WebSocket listeners
  private aiSetupHelper = inject(AiSetupHelperService);  // Inject AI setup helper
  private consoleLogger = inject(ConsoleLoggerService);  // Inject console logger
  private dialog = inject(MatDialog);  // Inject dialog service
  public router = inject(Router);
  private renderer = inject(Renderer2);

  private hasShownAISetup = false;  // Track if we've shown AI setup this session

  ngOnInit(): void {
    // Let theme service handle default (which is dark mode)
    // Don't override the saved preference or default

    // Preload library data in background so it's ready when user navigates to library
    this.databaseLibraryService.preloadLibraryData().catch(err => {
      console.log('[AppComponent] Library preload failed (this is expected if library is empty):', err);
    });

    // Check if AI setup is needed on first run (after a short delay to let app initialize)
    setTimeout(() => {
      this.checkAndShowAISetup();
    }, 3000);  // Wait 3 seconds after app loads

    // Log router events for debugging
    this.router.events.subscribe(event => {
    });

    // Dialog tracking removed - was causing freezing issues
    // Users can press ESC to close dialogs or use the close button in the dialog header

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
  }

  private handleBeforeUnload(): void {
    // Clear the pending jobs queue when the app is closing
    this.batchStateService.clearPendingJobs();

    // Clear the video processing queue cache
    this.videoProcessingQueueService.clearCache();
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

  /**
   * Check if AI is configured and show setup wizard if needed
   * Only shows once per session on first run
   */
  private async checkAndShowAISetup(): Promise<void> {
    // Only show once per session
    if (this.hasShownAISetup) {
      return;
    }

    // Check if we've offered AI setup before
    const aiSetupOffered = localStorage.getItem('aiSetupOffered');

    if (aiSetupOffered === 'true') {
      console.log('[AppComponent] AI setup already offered in a previous session');
      return;
    }

    try {
      // Check if AI is already configured
      const availability = await this.aiSetupHelper.checkAIAvailability();

      const hasOllama = availability.hasOllama && availability.ollamaModels.length > 0;
      const hasAPIKey = availability.hasClaudeKey || availability.hasOpenAIKey;

      if (hasOllama || hasAPIKey) {
        console.log('[AppComponent] AI is already configured, skipping setup wizard');
        // Mark as offered since it's already set up
        localStorage.setItem('aiSetupOffered', 'true');
        return;
      }

      // AI is not configured - show the setup wizard
      console.log('[AppComponent] AI not configured, showing setup wizard');
      this.hasShownAISetup = true;

      const dialogRef = this.dialog.open(AiSetupWizardComponent, {
        width: '800px',
        maxWidth: '90vw',
        maxHeight: '80vh',
        disableClose: false,
        data: { forceSetup: false }
      });

      dialogRef.afterClosed().subscribe(result => {
        // Mark that we've offered the setup
        localStorage.setItem('aiSetupOffered', 'true');

        if (result?.completed) {
          this.notificationService.success('AI Setup Complete', 'Your AI providers are now configured!');
        } else if (result?.skipped) {
          console.log('[AppComponent] User skipped AI setup');
        }
      });
    } catch (error) {
      console.error('[AppComponent] Error checking AI availability:', error);
    }
  }

  /**
   * Save console logs to file for debugging
   */
  async saveConsoleLogs(): Promise<void> {
    await this.consoleLogger.saveLogs();
    this.notificationService.toastOnly('success', 'Logs Saved', 'Console logs saved to logs directory');
  }
}