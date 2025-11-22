# Notification System

## Overview
Replaced intrusive toast notifications with a clean notification bell/center UI.

## Features

### Notification Bell
- **Bell icon** with unread count badge in the header
- **Animated ring** when there are unread notifications
- **Click to toggle** dropdown panel

### Notification Panel
- **Dropdown panel** that appears below the bell
- **Scrollable list** of all notifications
- **Unread indicator** - unread items have orange left border and highlighted background
- **Relative timestamps** - "Just now", "5m ago", "2h ago", etc.
- **Action support** - Clickable notifications with actions (open folder, navigate, etc.)
- **Mark as read/unread**
- **Delete individual** notifications
- **Mark all as read** button
- **Clear all** notifications button
- **Empty state** when no notifications

### Notification Types
- **Success** ✓ - Green
- **Error** ✗ - Red
- **Warning** ⚠️ - Orange
- **Info** ℹ️ - Blue

### Actions
Notifications can have clickable actions:
- `open-folder` - Opens file location
- `open-file` - Opens file
- `navigate-library` - Navigate to video in library
- `custom` - Custom handler function

## Usage

### Basic Notifications
```typescript
// All notifications go to the bell by default (no toasts)
notificationService.success('Success', 'Operation completed');
notificationService.error('Error', 'Something went wrong');
notificationService.info('Info', 'Here is some information');
notificationService.warning('Warning', 'Please be careful');
```

### With Toast Override (for critical errors)
```typescript
// Explicitly show toast for critical issues
notificationService.error('Critical Error', 'Server is down', true);
```

### With Actions
```typescript
notificationService.success(
  'Clip Created',
  'Your clip has been exported successfully'
);

// Or use toastOnly with action
notificationService.toastOnly(
  'success',
  'Clip Created',
  'Click to view in library',
  {
    type: 'navigate-library',
    videoId: 'video-123'
  }
);
```

### Trackable Notifications (for progress updates)
```typescript
// Create trackable notification that can be updated
const notifId = notificationService.trackable(
  'import-job-123',
  'info',
  'Importing',
  'Starting import...'
);

// Update it later
notificationService.updateTracked(
  'import-job-123',
  'success',
  'Import Complete',
  'Successfully imported 5 files'
);
```

## Benefits Over Toasts

1. **Less Intrusive** - No popups blocking your workflow
2. **User-Controlled** - Check notifications when you want
3. **History** - All notifications preserved and accessible
4. **Badge Count** - Shows unread count without being distracting
5. **Perfect for Background Tasks** - Great for long-running operations
6. **Persistent** - Notifications saved to localStorage
7. **Actionable** - Can click to perform actions

## Files Created

- `frontend-v3/src/app/components/notification-bell/notification-bell.component.ts`
- `frontend-v3/src/app/components/notification-bell/notification-bell.component.html`
- `frontend-v3/src/app/components/notification-bell/notification-bell.component.scss`

## Files Modified

- `frontend-v3/src/app/core/navigation/navigation.component.ts` - Added notification bell import
- `frontend-v3/src/app/core/navigation/navigation.component.html` - Added `<app-notification-bell />` to header
- `frontend-v3/src/app/services/notification.service.ts` - Changed default `showToast` parameter from `true` to `false`

## Customization

### Change Toast Defaults
If you want certain types to always show toasts, modify the service:

```typescript
// In notification.service.ts
error(title: string, message: string, showToast: boolean = true): void {
  // Errors always show toasts by default
}
```

### Styling
All styles are in `notification-bell.component.scss` using CSS variables:
- `--primary-orange` - Accent color
- `--status-error` - Error color
- `--status-complete` - Success color
- `--bg-primary`, `--bg-secondary` - Backgrounds
- `--text-primary`, `--text-secondary`, `--text-tertiary` - Text colors
- `--border-color` - Borders
