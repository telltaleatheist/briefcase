# Notification System - Quick Start Guide

## 5-Minute Integration Guide

### Step 1: Import the Service (5 seconds)

```typescript
import { NotificationService } from './services/notification.service';
```

### Step 2: Inject in Constructor (5 seconds)

```typescript
constructor(private notificationService: NotificationService) {}
```

### Step 3: Use It! (1 minute)

```typescript
// Success notification
this.notificationService.success(
  'Task Complete',
  'Your operation was successful'
);

// Error notification (auto-parsed for user-friendly messages)
this.notificationService.error(
  'Task Failed',
  error.message || error
);

// Info notification
this.notificationService.info(
  'Processing',
  'Please wait while we process your request'
);

// Warning notification
this.notificationService.warning(
  'Attention',
  'This action may take longer than usual'
);
```

## Real-World Examples

### Example 1: Video Download

```typescript
async downloadVideo(url: string) {
  try {
    this.notificationService.info('Starting Download', 'Preparing to download video...');

    const result = await this.apiService.download(url);

    this.notificationService.success(
      'Download Complete',
      `Successfully downloaded: ${result.filename}`
    );
  } catch (error) {
    this.notificationService.error('Download Failed', error);
  }
}
```

### Example 2: Form Submission

```typescript
onSubmit() {
  if (this.form.invalid) {
    this.notificationService.warning(
      'Invalid Form',
      'Please fill in all required fields'
    );
    return;
  }

  this.apiService.save(this.form.value).subscribe({
    next: () => {
      this.notificationService.success(
        'Settings Saved',
        'Your preferences have been updated'
      );
    },
    error: (err) => {
      this.notificationService.error('Save Failed', err);
    }
  });
}
```

### Example 3: Socket Events

```typescript
ngOnInit() {
  this.socketService.onConnect().subscribe(() => {
    this.notificationService.info('Connected', 'Successfully connected to server');
  });

  this.socketService.onDisconnect().subscribe(() => {
    this.notificationService.warning(
      'Disconnected',
      'Connection to server lost. Attempting to reconnect...'
    );
  });

  this.socketService.onError().subscribe((error) => {
    this.notificationService.error('Connection Error', error.message);
  });
}
```

### Example 4: Background Task

```typescript
startProcessing() {
  this.notificationService.info(
    'Processing Started',
    'Your files are being processed in the background',
    false  // Don't show toast, only add to history
  );

  this.processInBackground().then(() => {
    this.notificationService.success(
      'Processing Complete',
      'All files have been processed successfully'
    );
  });
}
```

## UI Components Already Integrated

The notification system is **already integrated** into your app:

- ✅ Bell icon in toolbar (top-right)
- ✅ Toast notifications (auto-appear)
- ✅ Modal dialog (auto-appears when clicking notifications)

**No additional setup needed!** Just start using the service.

## What You Get Automatically

### Toast Notifications
- Appear in top-right corner
- Auto-dismiss after 5 seconds
- Click to view full details
- Stack vertically if multiple
- Themed with your app colors

### Bell Menu
- Badge showing unread count
- Animated "ring" when unread > 0
- Dropdown panel with history
- Click to view full notification
- "Clear All" button

### Modal Dialog
- Shows full notification details
- Scrollable for long messages
- Click outside or "Okay" to close
- Beautiful colored headers by type

### Smart Error Parsing
The system automatically converts errors like:

```
Error: ENOENT - File not found at /path/to/file
```

Into user-friendly messages like:

```
Title: File Not Found
Message: The specified file or directory could not be found.

Technical details:
ENOENT - File not found at /path/to/file
```

## Notification Types & When to Use

| Type | When to Use | Example |
|------|-------------|---------|
| **Success** | Operation completed successfully | "Video downloaded", "Settings saved" |
| **Error** | Operation failed, exception occurred | "Download failed", "Network error" |
| **Warning** | Potential issue, caution needed | "Low disk space", "Slow connection" |
| **Info** | Status update, information | "Processing...", "Connected to server" |

## Tips & Best Practices

### ✅ DO

```typescript
// Clear, specific titles
this.notificationService.success('Download Complete', '...');

// Actionable messages
this.notificationService.error(
  'Connection Failed',
  'Check your internet connection and try again'
);

// Include relevant details
this.notificationService.info(
  'Processing Video',
  `Processing: ${filename} (${filesize}MB)`
);
```

### ❌ DON'T

```typescript
// Vague titles
this.notificationService.error('Error', 'Something went wrong');

// Non-actionable messages
this.notificationService.error('Failed', 'An error occurred');

// Too many details in toast (use full message in modal instead)
this.notificationService.error('Error', fullStackTrace);
```

## Testing Your Integration

### Manual Test

Add a test button to your component:

```typescript
// In your component
testNotifications() {
  this.notificationService.success('Test Success', 'This is a success notification');

  setTimeout(() => {
    this.notificationService.error('Test Error', 'This is an error notification');
  }, 1000);

  setTimeout(() => {
    this.notificationService.warning('Test Warning', 'This is a warning notification');
  }, 2000);

  setTimeout(() => {
    this.notificationService.info('Test Info', 'This is an info notification');
  }, 3000);
}
```

```html
<!-- In your template -->
<button (click)="testNotifications()">Test Notifications</button>
```

### Console Test

Open browser DevTools console:

```javascript
// Get the service
const ns = ng.probe(document.querySelector('app-root')).injector.get('NotificationService');

// Test it
ns.success('Console Test', 'Testing from console!');
```

## Migration from MatSnackBar

If you're using `MatSnackBar`, replace it gradually:

### Before
```typescript
constructor(private snackBar: MatSnackBar) {}

showMessage() {
  this.snackBar.open('Download completed!', 'Dismiss', {
    duration: 5000
  });
}
```

### After
```typescript
constructor(private notificationService: NotificationService) {}

showMessage() {
  this.notificationService.success(
    'Download Complete',
    'Your video has been successfully downloaded'
  );
}
```

### Benefits of Migration
- ✅ Persistent history (users can review later)
- ✅ Better error parsing (automatic user-friendly messages)
- ✅ Themed design (matches your app)
- ✅ Non-blocking (no "Dismiss" button needed)
- ✅ Click to view full details
- ✅ Works in all app states (even when busy)

## Advanced Usage

### Silent Notifications (History Only)

Add to history without showing toast:

```typescript
this.notificationService.success(
  'Background Sync Complete',
  'Data has been synchronized',
  false  // Don't show toast
);
```

### Programmatic Modal Display

Show modal for any notification:

```typescript
const notification = {
  id: '123',
  type: 'info',
  title: 'Custom Notification',
  message: 'This is a custom notification',
  timestamp: new Date(),
  read: false
};

this.notificationService.showModal(notification);
```

### Manual Control

```typescript
// Mark specific notification as read
this.notificationService.markAsRead(notificationId);

// Mark all as read
this.notificationService.markAllAsRead();

// Clear all notifications
this.notificationService.clearAll();

// Delete specific notification
this.notificationService.deleteNotification(notificationId);

// Get unread count
const count = this.notificationService.getUnreadCountSync();
```

## Common Patterns

### Loading States

```typescript
async loadData() {
  this.notificationService.info('Loading', 'Fetching data...');

  try {
    const data = await this.api.getData();
    this.notificationService.success('Loaded', 'Data loaded successfully');
    return data;
  } catch (error) {
    this.notificationService.error('Load Failed', error);
  }
}
```

### Validation

```typescript
validateForm() {
  const errors = [];

  if (!this.form.valid) {
    errors.push('Please fill in all required fields');
  }

  if (errors.length > 0) {
    this.notificationService.warning(
      'Validation Failed',
      errors.join('\n')
    );
    return false;
  }

  return true;
}
```

### Confirmation Actions

```typescript
async deleteItem(id: string) {
  if (!confirm('Are you sure you want to delete this item?')) {
    return;
  }

  try {
    await this.api.delete(id);
    this.notificationService.success(
      'Deleted',
      'Item has been deleted successfully'
    );
  } catch (error) {
    this.notificationService.error('Delete Failed', error);
  }
}
```

## Need More Info?

- 📖 **Full Documentation**: [NOTIFICATION_SYSTEM.md](NOTIFICATION_SYSTEM.md)
- 📋 **Implementation Details**: [NOTIFICATION_IMPLEMENTATION_SUMMARY.md](NOTIFICATION_IMPLEMENTATION_SUMMARY.md)
- 💬 **Questions?**: Check the Troubleshooting section in the full docs

## That's It!

You're ready to use the notification system. Just:

1. Import `NotificationService`
2. Inject it in your constructor
3. Call `.success()`, `.error()`, `.warning()`, or `.info()`

Happy coding! 🎉
