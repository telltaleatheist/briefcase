// clippy/frontend/src/app/components/saved-links/saved-links.component.ts
import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../services/api.service';
import { SocketService } from '../../services/socket.service';
import { NotificationService } from '../../services/notification.service';
import { SavedLink } from '../../models/saved-link.model';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-saved-links',
  templateUrl: './saved-links.component.html',
  styleUrls: ['./saved-links.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatChipsModule,
    MatProgressSpinnerModule,
    MatTooltipModule
  ]
})
export class SavedLinksComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private socketService = inject(SocketService);
  private notificationService = inject(NotificationService);

  savedLinks: SavedLink[] = [];
  isLoading = true;
  filterStatus: string | undefined = undefined;

  private subscriptions: Subscription[] = [];

  ngOnInit(): void {
    this.loadSavedLinks();
    this.setupWebSocketListeners();
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  /**
   * Load saved links from API
   */
  loadSavedLinks(): void {
    this.isLoading = true;
    this.apiService.getSavedLinks(this.filterStatus).subscribe({
      next: (links) => {
        this.savedLinks = links;
        this.isLoading = false;
      },
      error: (error) => {
        console.error('Error loading saved links:', error);
        this.notificationService.toastOnly('error', 'Load Failed', 'Failed to load saved links');
        this.isLoading = false;
      }
    });
  }

  /**
   * Set up WebSocket listeners for real-time updates
   */
  private setupWebSocketListeners(): void {
    // Listen for new links added
    this.subscriptions.push(
      this.socketService.onSavedLinkAdded().subscribe((link: SavedLink) => {
        this.savedLinks.unshift(link);
      })
    );

    // Listen for link updates
    this.subscriptions.push(
      this.socketService.onSavedLinkUpdated().subscribe((updatedLink: SavedLink) => {
        const index = this.savedLinks.findIndex(link => link.id === updatedLink.id);
        if (index !== -1) {
          this.savedLinks[index] = updatedLink;
        }
      })
    );

    // Listen for link deletions
    this.subscriptions.push(
      this.socketService.onSavedLinkDeleted().subscribe((data: { id: string }) => {
        this.savedLinks = this.savedLinks.filter(link => link.id !== data.id);
      })
    );
  }

  /**
   * Delete a saved link
   */
  deleteLink(link: SavedLink, event: Event): void {
    event.stopPropagation();

    if (!confirm(`Delete "${link.title || link.url}"?`)) {
      return;
    }

    this.apiService.deleteSavedLink(link.id).subscribe({
      next: () => {
        this.savedLinks = this.savedLinks.filter(l => l.id !== link.id);
        this.notificationService.toastOnly('success', 'Deleted', 'Saved link deleted');
      },
      error: (error) => {
        console.error('Error deleting saved link:', error);
        this.notificationService.toastOnly('error', 'Delete Failed', 'Failed to delete saved link');
      }
    });
  }

  /**
   * Retry a failed download
   */
  retryLink(link: SavedLink, event: Event): void {
    event.stopPropagation();

    this.apiService.retrySavedLink(link.id).subscribe({
      next: () => {
        this.notificationService.toastOnly('success', 'Retrying', 'Download restarted');
        this.loadSavedLinks();
      },
      error: (error) => {
        console.error('Error retrying saved link:', error);
        this.notificationService.toastOnly('error', 'Retry Failed', 'Failed to retry download');
      }
    });
  }

  /**
   * Open URL in browser
   */
  openUrl(link: SavedLink, event: Event): void {
    event.stopPropagation();
    window.open(link.url, '_blank');
  }

  /**
   * Filter links by status
   */
  filterByStatus(status: string | undefined): void {
    this.filterStatus = status;
    this.loadSavedLinks();
  }

  /**
   * Get status badge color
   */
  getStatusColor(status: string): string {
    switch (status) {
      case 'pending': return 'warn';
      case 'downloading': return 'primary';
      case 'completed': return 'accent';
      case 'failed': return 'error';
      default: return 'basic';
    }
  }

  /**
   * Get status icon
   */
  getStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return 'schedule';
      case 'downloading': return 'download';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'help';
    }
  }

  /**
   * Format date
   */
  formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  /**
   * Truncate URL for display
   */
  truncateUrl(url: string): string {
    const maxLength = 60;
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + '...';
  }

  /**
   * Get counts by status
   */
  get pendingCount(): number {
    return this.savedLinks.filter(l => l.status === 'pending').length;
  }

  get downloadingCount(): number {
    return this.savedLinks.filter(l => l.status === 'downloading').length;
  }

  get completedCount(): number {
    return this.savedLinks.filter(l => l.status === 'completed').length;
  }

  get failedCount(): number {
    return this.savedLinks.filter(l => l.status === 'failed').length;
  }
}
