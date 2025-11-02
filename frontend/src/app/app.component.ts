// clippy/frontend/src/app/app.component.ts
import { Component, OnInit, OnDestroy, inject, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, RouterOutlet } from '@angular/router';

import { ThemeService } from './services/theme.service';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
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

  private socketService = inject(SocketService);
  private settingsService = inject(SettingsService);
  private batchStateService = inject(BatchStateService);
  private snackBar = inject(MatSnackBar);
  private themeService = inject(ThemeService);  // Inject the ThemeService
  private notificationService = inject(NotificationService);  // Inject the NotificationService
  public router = inject(Router);

  ngOnInit(): void {
    // Let theme service handle default (which is dark mode)
    // Don't override the saved preference or default

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
}