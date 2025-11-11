import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { NotificationService, Notification } from '../../services/notification.service';

@Component({
  selector: 'app-notification-toast',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './notification-toast.component.html',
  styleUrls: ['./notification-toast.component.scss']
})
export class NotificationToastComponent implements OnInit, OnDestroy {
  notifications: Notification[] = [];
  private subscription?: Subscription;
  private toastTimers: Map<string, any> = new Map();

  constructor(
    private notificationService: NotificationService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.subscription = this.notificationService.toastNotifications$.subscribe(
      notification => {
        if (notification) {
          this.showToast(notification);
        }
      }
    );
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.toastTimers.forEach(timer => clearTimeout(timer));
  }

  private showToast(notification: Notification): void {
    // Add to notifications list
    this.notifications.push(notification);

    // Auto-remove after 5 seconds
    const timer = setTimeout(() => {
      this.removeToast(notification.id);
    }, 5000);

    this.toastTimers.set(notification.id, timer);
  }

  removeToast(id: string): void {
    const index = this.notifications.findIndex(n => n.id === id);
    if (index !== -1) {
      this.notifications.splice(index, 1);
    }

    // Clear timer
    const timer = this.toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
  }

  clickToast(notification: Notification): void {
    console.log('[NotificationToast] Clicked notification:', notification);
    console.log('[NotificationToast] Action:', notification.action);

    // Handle action if present
    if (notification.action) {
      this.handleAction(notification.action);
      // Remove toast after action
      this.removeToast(notification.id);
    } else {
      // Show modal with full details
      this.notificationService.showModal(notification);
      // Remove toast
      this.removeToast(notification.id);
    }
  }

  private handleAction(action: any): void {
    console.log('[NotificationToast] Handling action type:', action.type);
    console.log('[NotificationToast] Full action object:', action);

    switch (action.type) {
      case 'open-folder':
        if (action.path && (window as any).electron?.showInFolder) {
          (window as any).electron.showInFolder(action.path);
        }
        break;
      case 'open-file':
        if (action.path && (window as any).electron?.openFile) {
          (window as any).electron.openFile(action.path);
        }
        break;
      case 'navigate-library':
        console.log('[NotificationToast] Navigating to library with videoId:', action.videoId);
        if (action.videoId) {
          // Navigate to library and pass videoId to highlight
          this.router.navigate(['/library'], {
            queryParams: { highlightVideo: action.videoId }
          }).then(result => {
            console.log('[NotificationToast] Navigation result:', result);
          }).catch(error => {
            console.error('[NotificationToast] Navigation error:', error);
          });
        } else {
          console.warn('[NotificationToast] No videoId provided for navigate-library action');
        }
        break;
      case 'custom':
        if (action.customHandler) {
          action.customHandler();
        }
        break;
      default:
        console.warn('[NotificationToast] Unknown action type:', action.type);
    }
  }

  getIcon(type: string): string {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'warning': return '⚠';
      case 'info': return 'ℹ';
      default: return '•';
    }
  }
}
