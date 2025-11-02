import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
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

  constructor(private notificationService: NotificationService) {}

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
    // Show modal with full details
    this.notificationService.showModal(notification);
    // Remove toast
    this.removeToast(notification.id);
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
