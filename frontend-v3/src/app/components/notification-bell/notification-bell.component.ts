import { Component, inject, signal, computed, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NotificationService, Notification } from '../../services/notification.service';
import { Router } from '@angular/router';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-notification-bell',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notification-bell.component.html',
  styleUrls: ['./notification-bell.component.scss']
})
export class NotificationBellComponent {
  private notificationService = inject(NotificationService);
  private router = inject(Router);
  private electronService = inject(ElectronService);

  // UI State
  panelOpen = signal(false);

  // Notifications data
  notifications = signal<Notification[]>([]);
  unreadCount = computed(() => this.notifications().filter(n => !n.read).length);

  constructor() {
    // Subscribe to notifications
    this.notificationService.notifications$.subscribe(notifications => {
      this.notifications.set(notifications);
    });
  }

  /**
   * Toggle notification panel
   */
  togglePanel() {
    this.panelOpen.update(open => !open);
  }

  /**
   * Close panel when clicking outside
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const bellContainer = target.closest('.notification-bell-container');

    if (!bellContainer && this.panelOpen()) {
      this.panelOpen.set(false);
    }
  }

  /**
   * Mark notification as read
   */
  markAsRead(notification: Notification, event?: Event) {
    if (event) {
      event.stopPropagation();
    }
    this.notificationService.markAsRead(notification.id);
  }

  /**
   * Mark all as read
   */
  markAllAsRead() {
    this.notificationService.markAllAsRead();
  }

  /**
   * Clear all notifications
   */
  clearAll() {
    if (confirm('Clear all notifications?')) {
      this.notificationService.clearAll();
    }
  }

  /**
   * Delete a single notification
   */
  deleteNotification(notification: Notification, event: Event) {
    event.stopPropagation();
    this.notificationService.deleteNotification(notification.id);
  }

  /**
   * Handle notification click
   */
  onNotificationClick(notification: Notification) {
    // Mark as read
    this.markAsRead(notification);

    // Handle action if present
    if (notification.action) {
      this.handleNotificationAction(notification);
    }
  }

  /**
   * Handle notification action
   */
  private handleNotificationAction(notification: Notification) {
    if (!notification.action) return;

    const action = notification.action;

    switch (action.type) {
      case 'open-folder':
        if (action.path) {
          this.electronService.showInFolder(action.path);
        }
        this.panelOpen.set(false);
        break;

      case 'open-file':
        if (action.path) {
          this.electronService.openFile(action.path);
        }
        this.panelOpen.set(false);
        break;

      case 'navigate-library':
        if (action.videoId) {
          this.router.navigate(['/video', action.videoId]);
        } else {
          this.router.navigate(['/']);
        }
        this.panelOpen.set(false);
        break;

      case 'custom':
        if (action.customHandler) {
          action.customHandler();
        }
        this.panelOpen.set(false);
        break;
    }
  }

  /**
   * Get notification icon based on type
   */
  getNotificationIcon(type: string): string {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✗';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      default: return '•';
    }
  }

  /**
   * Format timestamp to relative time
   */
  formatTimestamp(date: Date): string {
    const now = new Date();
    const timestamp = new Date(date);
    const diffMs = now.getTime() - timestamp.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return timestamp.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    });
  }

  /**
   * Check if notification has action
   */
  hasAction(notification: Notification): boolean {
    return !!notification.action;
  }

  /**
   * Get action button text
   */
  getActionText(notification: Notification): string {
    if (!notification.action) return '';

    switch (notification.action.type) {
      case 'open-folder': return 'Open Folder';
      case 'open-file': return 'Open File';
      case 'navigate-library': return 'View in Library';
      default: return 'View';
    }
  }
}