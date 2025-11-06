# Toast Notification Audit

## Current Notification Triggers

### High Priority - Keep with Toast + Badge
1. **Clip Created** - User needs immediate feedback
2. **Analysis Complete/Failed** - Long-running task completion
3. **Video Relinked** - Important status change
4. **Download Complete/Failed** - Long-running task completion
5. **Configuration Errors** - Critical issues requiring attention
6. **Settings Saved** - Immediate user action feedback

### Medium Priority - Badge Only (No Toast)
7. **Server Disconnected** - Background status (currently toast-only)
8. **Settings Reset** - User explicitly triggered
9. **Path Validation Success** - Intermediate feedback
10. **Queue Started** - User explicitly triggered
11. **URLs Added to Queue** - User explicitly triggered

### Low Priority - Remove or Badge Only
12. **"Coming Soon" messages** - Not actionable, unnecessary noise
13. **Validation warnings during form input** - Should use inline form validation
14. **History cleared** - User explicitly triggered, obvious result
15. **Items removed from history** - Obvious result of user action
16. **Connection reconnected** - Background noise
17. **Directory selection not available in web** - Should be hidden in web version

### Analysis Progress - Special Case
- Currently shows multiple progress notifications
- **Recommendation**: Use a single trackable notification that updates rather than multiple toasts

## Recommendations

### Keep Toast Notifications (8 total):
1. Clip created successfully
2. Analysis completed
3. Analysis failed (errors)
4. Download completed
5. Download failed (errors)
6. Video relink success
7. Critical configuration errors
8. FFmpeg/yt-dlp missing errors

### Convert to Badge-Only (No Toast) (7 total):
1. Server disconnected/reconnected
2. Settings saved/reset
3. Queue started
4. URLs added to queue
5. Path validation success
6. Items removed from history
7. History cleared

### Remove Entirely (5 total):
1. "Coming Soon" toasts - hide features instead
2. "Not available in web version" - hide features in web version
3. "No jobs to start" - disable button instead
4. "No valid URLs" - use inline validation
5. "No URLs entered" - use inline validation

## Implementation Changes Needed

### 1. Use inline validation instead of toasts:
- Batch download URL validation
- Form field validation
- Button state management (disable when invalid)

### 2. Convert to badge-only notifications:
```typescript
// Change from:
this.notificationService.success('title', 'message');

// To:
this.notificationService.success('title', 'message', false); // showToast = false
```

### 3. Hide unavailable features:
```typescript
// Instead of showing "not available" toast, hide the button in web version
*ngIf="isElectron"
```

### 4. Use single trackable notification for analysis progress:
```typescript
// Instead of multiple toasts for each phase:
const trackingKey = 'analysis-' + analysisId;
this.notificationService.trackable(trackingKey, 'info', 'Analyzing', 'Downloading...', false);
// Update the same notification
this.notificationService.updateTracked(trackingKey, 'info', 'Analyzing', 'Transcribing...', false);
```

## Summary
- **Current**: ~40+ notification types
- **Recommended Toast**: 8 notifications
- **Recommended Badge-Only**: 7 notifications
- **Recommended Remove**: 5 notifications
- **Total Reduction**: ~60% fewer toast notifications

This will significantly reduce notification fatigue while keeping users informed of important events.
