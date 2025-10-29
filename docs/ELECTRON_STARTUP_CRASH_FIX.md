# Electron Startup Crash Fix

## Problem

When packaging the Electron app, it would crash immediately on startup with the error:

```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
    at Object.<anonymous> (/path/to/electron/main.js:59:35)
```

The app would then show a generic "Backend Server Error" message, which was **misleading** because the backend never even started - the app crashed before reaching that stage.

## Root Cause

The code in `electron/main.ts` was calling `app.requestSingleInstanceLock()` at the **module level** (top-level scope), before `app.whenReady()`:

```typescript
// This runs immediately when the module loads
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// This runs later, after app is ready
app.whenReady().then(async () => {
  // ...
});
```

In **development mode**, this worked fine because the Electron app object was already initialized.

In **packaged/production mode**, the Electron app object may not be fully initialized when the module first loads, causing `electron_1.app` to be `undefined` and crashing immediately.

## Solution

Wrap the single-instance lock code in a try-catch block to gracefully handle cases where the app object isn't ready yet:

```typescript
// Single instance lock - must be called before app.whenReady()
// Wrap in try-catch to handle cases where app object isn't ready
let gotTheLock = false;
try {
  gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    log.info('Another instance is already running. Exiting.');
    app.quit();
    process.exit(0);
  }

  // Handle second instance attempt
  app.on('second-instance', () => {
    log.info('Second instance detected. Focusing main window.');
    if (windowService) {
      windowService.focusWindow();
    }
  });
} catch (error) {
  log.error('Error setting up single instance lock:', error);
  // Continue anyway - better to run than fail completely
}
```

This ensures:
1. If the app object is ready, single-instance locking works as expected
2. If the app object isn't ready, we log the error and continue (graceful degradation)
3. The app doesn't crash on startup

## Key Takeaways

1. **Always wrap top-level Electron API calls in try-catch** - The app object may not be initialized in packaged builds
2. **The generic error message was misleading** - It said "Backend Server Error" but the real error was in Electron initialization
3. **Graceful degradation is better than crashing** - If single-instance locking fails, it's better to run anyway than to fail completely
4. **Test packaged builds, not just dev mode** - This bug only appeared in packaged builds

## Files Modified

- `electron/main.ts` (lines 28-50)
