import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { ErrorParser } from './error-parser';

export type NotificationType = 'success' | 'error' | 'info' | 'warning';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
  trackingKey?: string; // Optional key to track and update notifications
  action?: NotificationAction; // Optional action data for clickable notifications
}

export interface NotificationAction {
  type: 'open-folder' | 'open-file' | 'custom' | 'navigate-library';
  path?: string; // File or folder path for open-folder/open-file actions
  videoId?: string; // Video ID for navigate-library action
  customHandler?: () => void; // Custom handler function
}

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private readonly MAX_NOTIFICATIONS = 100;
  private notifications: Notification[] = [];
  private notificationsSubject = new BehaviorSubject<Notification[]>([]);
  private currentModalSubject = new BehaviorSubject<Notification | null>(null);
  private toastSubject = new Subject<Notification>();

  notifications$ = this.notificationsSubject.asObservable();
  currentModal$ = this.currentModalSubject.asObservable();
  toastNotifications$ = this.toastSubject.asObservable();

  constructor() {
    // Load notifications from localStorage
    this.loadNotifications();
  }

  private loadNotifications(): void {
    const stored = localStorage.getItem('clipchimp_notifications');
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        this.notifications = parsed.map((n: any) => ({
          ...n,
          timestamp: new Date(n.timestamp)
        }));
        this.notificationsSubject.next(this.notifications);
      } catch (e) {
        console.error('Failed to load notifications:', e);
      }
    }
  }

  private saveNotifications(): void {
    try {
      localStorage.setItem('clipchimp_notifications', JSON.stringify(this.notifications));
    } catch (e) {
      console.error('Failed to save notifications:', e);
    }
  }

  private addNotification(type: NotificationType, title: string, message: string, trackingKey?: string, action?: NotificationAction): Notification {
    const notification: Notification = {
      id: `${Date.now()}-${Math.random()}`,
      type,
      title,
      message,
      timestamp: new Date(),
      read: false,
      trackingKey,
      action
    };

    console.log('addNotification() - Adding to array:', notification);

    // Add to beginning of array
    this.notifications.unshift(notification);
    console.log('addNotification() - Notifications array length:', this.notifications.length);

    // Keep only last 100 notifications
    if (this.notifications.length > this.MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(0, this.MAX_NOTIFICATIONS);
    }

    this.saveNotifications();
    this.notificationsSubject.next(this.notifications);
    console.log('addNotification() - Emitted to subject');

    return notification;
  }

  // Update an existing notification by tracking key
  private updateNotificationByKey(trackingKey: string, type: NotificationType, title: string, message: string, action?: NotificationAction): Notification | null {
    const existingIndex = this.notifications.findIndex(n => n.trackingKey === trackingKey);
    console.log('updateNotificationByKey() - Looking for:', trackingKey, 'Found at index:', existingIndex);

    if (existingIndex !== -1) {
      // Update existing notification
      console.log('updateNotificationByKey() - Updating existing notification at index:', existingIndex);
      this.notifications[existingIndex] = {
        ...this.notifications[existingIndex],
        type,
        title,
        message,
        timestamp: new Date(), // Update timestamp
        read: false, // Mark as unread again
        action // Update action if provided
      };

      this.saveNotifications();
      this.notificationsSubject.next(this.notifications);
      console.log('updateNotificationByKey() - Updated notification:', this.notifications[existingIndex]);
      return this.notifications[existingIndex];
    }

    console.log('updateNotificationByKey() - No existing notification found');
    return null;
  }

  success(title: string, message: string, showToast: boolean = false): void {
    const notification = this.addNotification('success', title, message);
    if (showToast) {
      this.toastSubject.next(notification);
    }
  }

  error(title: string, message: string, showToast: boolean = false): void {
    // Parse error to make it more human-readable
    const parsed = ErrorParser.formatWithTechnical(message);
    const notification = this.addNotification('error', parsed.title, parsed.message);
    if (showToast) {
      this.toastSubject.next(notification);
    }
  }

  info(title: string, message: string, showToast: boolean = false): void {
    const notification = this.addNotification('info', title, message);
    if (showToast) {
      this.toastSubject.next(notification);
    }
  }

  warning(title: string, message: string, showToast: boolean = false): void {
    const notification = this.addNotification('warning', title, message);
    if (showToast) {
      this.toastSubject.next(notification);
    }
  }

  // Show modal with notification details (called when clicking toast or from bell menu)
  showModal(notification: Notification): void {
    this.currentModalSubject.next(notification);
  }

  closeModal(): void {
    this.currentModalSubject.next(null);
  }

  markAsRead(notificationId: string): void {
    const notification = this.notifications.find(n => n.id === notificationId);
    if (notification) {
      notification.read = true;
      this.saveNotifications();
      this.notificationsSubject.next(this.notifications);
    }
  }

  markAllAsRead(): void {
    this.notifications.forEach(n => n.read = true);
    this.saveNotifications();
    this.notificationsSubject.next(this.notifications);
  }

  getUnreadCount(): Observable<number> {
    return new BehaviorSubject(this.notifications.filter(n => !n.read).length).asObservable();
  }

  getUnreadCountSync(): number {
    return this.notifications.filter(n => !n.read).length;
  }

  clearAll(): void {
    this.notifications = [];
    this.saveNotifications();
    this.notificationsSubject.next(this.notifications);
  }

  deleteNotification(notificationId: string): void {
    const index = this.notifications.findIndex(n => n.id === notificationId);
    if (index !== -1) {
      this.notifications.splice(index, 1);
      this.saveNotifications();
      this.notificationsSubject.next(this.notifications);
    }
  }

  // Toast-only notification (doesn't add to history)
  toastOnly(type: NotificationType, title: string, message: string, action?: NotificationAction): void {
    const notification: Notification = {
      id: `${Date.now()}-${Math.random()}`,
      type,
      title,
      message,
      timestamp: new Date(),
      read: true, // Mark as read so it doesn't affect unread count
      action
    };
    this.toastSubject.next(notification);
  }

  // Trackable notification that can be updated later
  trackable(trackingKey: string, type: NotificationType, title: string, message: string, showToast: boolean = false, action?: NotificationAction): string {
    console.log('trackable() called:', {trackingKey, type, title, message, showToast, action});

    // Check if notification with this tracking key already exists
    const updated = this.updateNotificationByKey(trackingKey, type, title, message, action);

    if (updated) {
      // Existing notification was updated
      console.log('Updated existing notification:', updated);
      if (showToast) {
        this.toastSubject.next(updated);
      }
      return updated.id;
    } else {
      // Create new notification with tracking key
      const notification = this.addNotification(type, title, message, trackingKey, action);
      console.log('Created new notification:', notification);
      if (showToast) {
        this.toastSubject.next(notification);
      }
      return notification.id;
    }
  }

  // Update a tracked notification (convenience method)
  updateTracked(trackingKey: string, type: NotificationType, title: string, message: string, showToast: boolean = false): void {
    this.trackable(trackingKey, type, title, message, showToast);
  }
}
