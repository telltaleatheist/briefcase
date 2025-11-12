import { Component, OnInit, OnDestroy, HostListener, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { NotificationService, Notification } from '../../services/notification.service';
import { A11yModule, FocusTrap, FocusTrapFactory } from '@angular/cdk/a11y';

@Component({
  selector: 'app-notification-bell',
  standalone: true,
  imports: [CommonModule, A11yModule],
  templateUrl: './notification-bell.component.html',
  styleUrls: ['./notification-bell.component.scss']
})
export class NotificationBellComponent implements OnInit, OnDestroy, AfterViewInit {
  @ViewChild('notificationPanel') notificationPanel?: ElementRef;

  notifications: Notification[] = [];
  unreadCount: number = 0;
  isOpen: boolean = false;
  private subscription?: Subscription;
  private focusTrap?: FocusTrap;

  constructor(
    private notificationService: NotificationService,
    private focusTrapFactory: FocusTrapFactory
  ) {}

  ngOnInit(): void {
    this.subscription = this.notificationService.notifications$.subscribe(
      notifications => {
        console.log('NotificationBell - Received notifications update:', notifications.length, 'notifications');
        this.notifications = notifications;
        this.unreadCount = this.notificationService.getUnreadCountSync();
        console.log('NotificationBell - Unread count:', this.unreadCount);
      }
    );
  }

  ngAfterViewInit(): void {
    // Create focus trap when panel element is available
    if (this.notificationPanel) {
      this.focusTrap = this.focusTrapFactory.create(this.notificationPanel.nativeElement);
    }
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    // Clean up focus trap
    if (this.focusTrap) {
      this.focusTrap.destroy();
    }
  }

  togglePanel(): void {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      // Mark all as read when opening the panel
      setTimeout(() => {
        this.notificationService.markAllAsRead();
      }, 500);

      // Activate focus trap when panel opens
      setTimeout(() => {
        this.focusTrap?.focusInitialElementWhenReady();
      }, 0);
    } else {
      // Deactivate focus trap when panel closes
      // Focus trap will automatically return focus to the trigger element
    }
  }

  closePanel(): void {
    this.isOpen = false;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.notification-bell-container')) {
      this.closePanel();
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.isOpen) {
      this.closePanel();
    }
  }

  getTimeAgo(timestamp: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(timestamp).getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }

  getNotificationIcon(type: string): string {
    switch (type) {
      case 'success': return '✓';
      case 'error': return '✕';
      case 'warning': return '⚠';
      case 'info': return 'ℹ';
      default: return '•';
    }
  }

  viewNotification(notification: Notification): void {
    this.notificationService.showModal(notification);
    this.closePanel();
  }

  clearAll(): void {
    this.notificationService.clearAll();
    this.closePanel();
  }

  deleteNotification(event: MouseEvent, notificationId: string): void {
    event.stopPropagation(); // Prevent triggering viewNotification
    this.notificationService.deleteNotification(notificationId);
  }
}
