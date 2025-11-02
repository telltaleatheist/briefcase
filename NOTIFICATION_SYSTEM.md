# Notification System Documentation

## Overview

The Clippy application now includes a modern, non-intrusive notification system with three channels:
1. **Toast notifications** - Brief, auto-dismissing notifications in the top-right corner
2. **Bell menu** - Persistent notification history accessible from the toolbar
3. **Modal dialogs** - Detailed view when clicking notifications

## Architecture

### Components

- **NotificationService** ([notification.service.ts](frontend/src/app/services/notification.service.ts)) - Central service managing all notifications
- **ErrorParser** ([error-parser.ts](frontend/src/app/services/error-parser.ts)) - Utility for parsing errors into user-friendly messages
- **NotificationToastComponent** - Toast notifications that slide in from the right
- **NotificationBellComponent** - Bell icon with badge showing unread count
- **NotificationModalComponent** - Modal for viewing full notification details

### Data Model

Each notification has:
- `id`: Unique identifier (timestamp + random)
- `type`: `'success' | 'error' | 'warning' | 'info'`
- `title`: Short, descriptive title
- `message`: Detailed explanation
- `timestamp`: Creation date
- `read`: Boolean indicating read status

### Storage

- Last 100 notifications are persisted in `localStorage` under the key `clippy_notifications`
- Notifications survive page refreshes and app restarts
- Automatically limited to 100 most recent notifications

## Usage Examples

### Basic Usage

```typescript
import { NotificationService } from './services/notification.service';

export class MyComponent {
  constructor(private notificationService: NotificationService) {}

  // Success notification
  onSuccess() {
    this.notificationService.success(
      'Download Complete',
      'Video has been successfully downloaded to your folder.'
    );
  }

  // Error notification (automatically parses error messages)
  onError() {
    this.notificationService.error(
      'Download Failed',
      'Error: ENOENT - File not found at /path/to/video.mp4'
    );
  }

  // Info notification
  onInfo() {
    this.notificationService.info(
      'Processing Started',
      'Your video is being processed. This may take a few minutes.'
    );
  }

  // Warning notification
  onWarning() {
    this.notificationService.warning(
      'Low Disk Space',
      'You have less than 1GB of free disk space remaining.'
    );
  }
}
```

### Suppressing Toast Notifications

If you want to add a notification to history without showing a toast:

```typescript
this.notificationService.success(
  'Background Task Complete',
  'The background sync has finished.',
  false  // Don't show toast
);
```

### Error Handling with Automatic Parsing

The error parser automatically converts technical errors into user-friendly messages:

```typescript
try {
  await this.downloadVideo(url);
} catch (error) {
  // ErrorParser will automatically detect common patterns:
  // - 404 errors → "Resource Not Found"
  // - 401 errors → "Authentication Error"
  // - ENOENT → "File Not Found"
  // - Rate limits → "Rate Limited"
  this.notificationService.error('Download Failed', error);
}
```

### Integration with Existing Services

**In BatchApiService or SocketService:**

```typescript
import { NotificationService } from './notification.service';

export class BatchApiService {
  constructor(
    private http: HttpClient,
    private notificationService: NotificationService
  ) {}

  downloadVideo(url: string): Observable<any> {
    return this.http.post('/api/download', { url }).pipe(
      tap(() => {
        this.notificationService.success(
          'Download Started',
          `Downloading: ${url}`
        );
      }),
      catchError(error => {
        this.notificationService.error(
          'Download Failed',
          error.message || error
        );
        return throwError(() => error);
      })
    );
  }
}
```

**In Socket Event Handlers:**

```typescript
// In app.component.ts or socket-handling component
ngOnInit() {
  this.socketService.onDownloadCompleted().subscribe((data) => {
    this.notificationService.success(
      'Download Complete',
      `Successfully downloaded: ${data.filename}`
    );
  });

  this.socketService.onDownloadFailed().subscribe((error) => {
    this.notificationService.error(
      'Download Failed',
      error.message
    );
  });
}
```

## User Flow

### 1. When an Event Occurs
- Service adds notification to history
- Toast appears (passive, auto-dismisses after 5 seconds)
- Bell badge increments with unread count
- Bell icon "rings" (rotation animation)

### 2. User Clicks Toast (Optional)
- Toast immediately dismisses
- Modal opens showing full notification details
- User can read the complete message
- Click "Okay" or outside to close

### 3. User Clicks Bell (Optional)
- Dropdown panel opens below bell icon
- Shows all notifications (up to 100)
- Notifications are automatically marked as read after 500ms
- Click any notification to view full details in modal
- "Clear All" button to remove all notifications

### 4. User Ignores Everything
- Toasts auto-dismiss after 5 seconds
- Notifications remain in bell menu for later review
- Can check notification history at any time

## Styling and Theming

The notification system fully integrates with the Creamsicle theme and supports both light and dark modes:

### Notification Colors

- **Success** (`#4CAF50` green): Successful operations
- **Error** (`#f44336` red): Failed operations, exceptions
- **Warning** (`#ff9800` orange): Caution, potential issues
- **Info** (`#2196F3` blue): Informational messages

### CSS Variables Used

All components use CSS variables from [styles-creamsicle.scss](frontend/src/styles-creamsicle.scss):

- `--bg-card`: Card background
- `--text-primary`: Primary text color
- `--text-secondary`: Secondary text color
- `--border-color`: Border colors
- `--shadow-lg`, `--shadow-xl`: Shadow effects
- `--primary-orange`: Theme accent color
- `--border-radius`: Consistent border radius

## Animations

### Toast Animations
- **Slide In**: Slides from right with fade-in (0.3s)
- **Hover**: Pulls slightly left with shadow increase
- **Stack**: Multiple toasts stack vertically with 12px gap

### Bell Animations
- **Ring**: Bell rotates back and forth when unread > 0
- **Badge Pulse**: Badge gently pulses to draw attention
- **Panel Slide Down**: Dropdown panel slides down with fade-in (0.2s)

### Modal Animations
- **Backdrop Fade In**: Dark overlay fades in (0.2s)
- **Slide Up**: Modal content slides up with fade-in (0.3s)
- **Button Hover**: Orange button lifts up with enhanced shadow

## Keyboard & Accessibility

- Click outside modal or notification panel to close
- Escape key support can be added in future updates
- ARIA labels for screen readers (can be enhanced)
- Focus management for keyboard navigation

## Error Parser Patterns

The `ErrorParser` automatically detects and formats common error patterns:

| Pattern | Detected As | User Message |
|---------|------------|--------------|
| `404`, `not_found_error` | Resource Not Found | Friendly message about missing resources |
| `401`, `Unauthorized` | Authentication Error | "Check your API key in settings" |
| `429`, `rate limit` | Rate Limited | "Wait and try again" |
| `500`, `Internal Server Error` | Server Error | "Service is experiencing issues" |
| `ENOENT`, `does not exist` | File Not Found | "File or directory could not be found" |
| `EACCES`, `permission denied` | Permission Denied | "You don't have permission to access this" |
| `yt-dlp`, `youtube-dl` | Download Error | "Check if URL is valid or yt-dlp is installed" |
| `FFmpeg`, `ffmpeg` | FFmpeg Error | "Issue processing media file" |

## Testing

### Manual Testing

You can test the notification system from the browser console:

```javascript
// Get the notification service (in development)
const service = ng.probe(document.querySelector('app-root')).injector.get('NotificationService');

// Test different notification types
service.success('Test Success', 'This is a success message');
service.error('Test Error', 'This is an error message with technical details');
service.warning('Test Warning', 'This is a warning message');
service.info('Test Info', 'This is an informational message');
```

### Component Testing

To add test notifications to any component for demonstration:

```typescript
testNotifications() {
  // Success
  this.notificationService.success(
    'Video Downloaded',
    'Successfully downloaded video.mp4 to /Downloads/'
  );

  // Error with parsing
  setTimeout(() => {
    this.notificationService.error(
      'Download Failed',
      'Error: ENOENT - The file /path/to/video does not exist'
    );
  }, 1000);

  // Warning
  setTimeout(() => {
    this.notificationService.warning(
      'Low Quality',
      'The video quality is lower than requested (480p instead of 1080p)'
    );
  }, 2000);

  // Info
  setTimeout(() => {
    this.notificationService.info(
      'Processing',
      'Video is being processed. This may take several minutes...'
    );
  }, 3000);
}
```

## Best Practices

### When to Use Each Type

- **Success**: Completed operations (downloads, saves, updates)
- **Error**: Failed operations, exceptions, critical issues
- **Warning**: Potential issues, degraded functionality, user should be aware
- **Info**: Status updates, progress information, general messages

### Message Writing Guidelines

**Title:**
- Short (2-4 words)
- Action-oriented ("Download Complete", "Settings Saved")
- Descriptive ("Video Analysis Failed", "Connection Lost")

**Message:**
- Clear and specific
- Actionable when possible ("Check your API key in Settings")
- Include relevant details (filenames, URLs, error codes)
- For errors: what happened and how to fix it

**Examples:**

✅ Good:
```typescript
this.notificationService.error(
  'Model Not Found',
  'The AI model "gpt-4-turbo" is not available. Please update your model selection in Settings.'
);
```

❌ Bad:
```typescript
this.notificationService.error(
  'Error',
  'Something went wrong'
);
```

### Performance Considerations

- Notifications are lightweight and don't impact performance
- Toast DOM elements are added/removed dynamically
- localStorage updates are debounced
- Maximum 100 notifications prevents unbounded growth
- CSS animations use GPU acceleration (transform, opacity)

## Migration from MatSnackBar

If you're currently using `MatSnackBar`, you can gradually migrate to the notification system:

**Before:**
```typescript
this.snackBar.open('Download completed!', 'Dismiss', { duration: 5000 });
```

**After:**
```typescript
this.notificationService.success('Download Complete', 'Video has been saved successfully');
```

**Benefits:**
- Persistent history in bell menu
- Better error parsing
- Themed to match app design
- Non-blocking (no "Dismiss" button required)
- Click to view full details

## Future Enhancements

Potential improvements for the notification system:

1. **Grouped Notifications**: Combine similar notifications (e.g., "5 downloads completed")
2. **Action Buttons**: Add custom actions to notifications ("Retry", "Open Folder", "View Details")
3. **Sound Effects**: Optional sound alerts for important notifications
4. **Desktop Notifications**: Browser notification API for background alerts
5. **Filtering**: Filter notifications by type in the bell panel
6. **Search**: Search through notification history
7. **Keyboard Shortcuts**: Ctrl+N to open notification panel
8. **Export**: Export notification history to file
9. **Notification Preferences**: User settings for notification behavior

## Troubleshooting

### Notifications Not Appearing

1. Check that components are imported in `app.component.ts`
2. Verify `<app-notification-toast>` and `<app-notification-modal>` are in the template
3. Ensure `NotificationService` is injected correctly
4. Check browser console for errors

### Bell Icon Not Visible

- Verify `<app-notification-bell>` is in the toolbar
- Check z-index conflicts with other elements
- Ensure CSS variables are defined in theme

### Notifications Not Persisting

- Check browser localStorage is enabled
- Verify no localStorage size limits are hit
- Look for errors in browser console related to storage

### Styling Issues

- Ensure `styles-creamsicle.scss` is imported
- Check for CSS specificity conflicts
- Verify theme classes are applied to `body` element

## Summary

The notification system provides a comprehensive, non-intrusive way to communicate with users:

✅ **Non-blocking**: Users never forced to interact
✅ **Progressive disclosure**: Brief toast → full details if needed
✅ **Persistent**: History survives page refreshes
✅ **Themed**: Full light/dark mode support
✅ **Smart**: Automatic error parsing
✅ **Accessible**: Keyboard navigation, proper semantics
✅ **Performant**: Efficient animations and updates

Start using it today by injecting `NotificationService` into your components!
