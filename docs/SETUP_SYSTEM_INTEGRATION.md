# Setup System Integration Guide

## Quick Start

To integrate the new setup system into your main application, follow these steps:

## 1. Update main.ts

Replace the current executable check with the new setup service:

```typescript
// electron/main.ts
import { SetupService } from './services/setup-service';
import { PortableDependencyManager } from './utilities/portable-dependency-manager';

// After app.whenReady()
app.whenReady().then(async () => {
  try {
    // Initialize AppConfig first
    AppConfig.initialize();

    // Run setup service (replaces old ExecutablesUtil)
    const setupService = new SetupService();
    const setupComplete = await setupService.runSetup();

    if (!setupComplete) {
      log.error('Setup incomplete, cannot start application');
      dialog.showErrorBox(
        'Setup Required',
        'Clippy requires certain dependencies to function. Please complete the setup process.'
      );
      app.quit();
      return;
    }

    // Setup environment variables for portable dependencies
    const portableManager = new PortableDependencyManager();
    portableManager.setupEnvironmentVariables();

    // Continue with normal startup...
    backendService = new BackendService();
    windowService = new WindowService();
    // ... rest of initialization

  } catch (error) {
    log.error('Error during application initialization:', error);
    app.quit();
  }
});
```

## 2. Files Created

### New Files
- `electron/utilities/dependency-checker.ts` - Check for installed dependencies
- `electron/utilities/dependency-installer.ts` - Install system-wide dependencies
- `electron/utilities/portable-dependency-manager.ts` - Manage portable dependencies
- `electron/utilities/ai-setup-wizard.ts` - Guide AI feature setup
- `electron/services/setup-service.ts` - Coordinate setup process
- `assets/setup.html` - Setup progress UI

### Modified Files
- `electron/preload.ts` - Added setup progress listener
- `package.json` - Updated clean script to use rimraf

## 3. Testing the Setup

### On Mac (Development)

You can test the dependency checking logic:

```bash
npm run electron:dev
```

The checker will run but won't find Windows dependencies (expected on Mac).

### On Windows (Production)

1. Build the installer:
   ```bash
   npm run package:win
   ```

2. Transfer the installer to a Windows machine

3. Install and run - the setup wizard will automatically start

## 4. Configuration Options

### Skipping Setup (for development)

If you want to skip setup during development:

```typescript
// In main.ts
const isDevelopment = process.env.NODE_ENV === 'development';

if (isDevelopment) {
  // Skip setup, use system dependencies
  const executablesUtil = new ExecutablesUtil();
  await executablesUtil.checkAndConfigureExecutables();
} else {
  // Production - use new setup system
  const setupService = new SetupService();
  await setupService.runSetup();
}
```

### Forcing Setup Re-run

To force the setup to run again (useful for testing):

```typescript
// Delete the dependencies folder
const portableManager = new PortableDependencyManager();
await portableManager.cleanupAll();
```

## 5. User Experience Flow

### First Run
```
1. User installs Clippy
2. User launches Clippy
3. Dependency check runs
4. Setup dialog appears (if dependencies missing)
5. User clicks "Install"
6. Progress window shows installation status
7. Optional: AI features wizard appears
8. Setup completes
9. Main app launches
```

### Subsequent Runs
```
1. User launches Clippy
2. Quick dependency check (all present)
3. Environment variables set
4. Main app launches immediately
```

## 6. Environment Variables Set

After successful setup, these are available:

```typescript
process.env.FFMPEG_PATH    // Path to ffmpeg.exe
process.env.FFPROBE_PATH   // Path to ffprobe.exe
process.env.YT_DLP_PATH    // Path to yt-dlp.exe
process.env.PYTHON_PATH    // Path to python.exe
process.env.PATH           // Updated with bin directory
```

## 7. Backend Integration

The backend services should automatically pick up these environment variables:

```typescript
// backend/src/ffmpeg/ffmpeg.service.ts
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';

// backend/src/downloader/yt-dlp-manager.ts
const ytDlpPath = process.env.YT_DLP_PATH || 'yt-dlp';
```

No changes needed to backend if it already uses environment variables.

## 8. Handling Setup Failures

```typescript
const setupService = new SetupService();
const setupComplete = await setupService.runSetup();

if (!setupComplete) {
  // User cancelled or setup failed
  const response = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Retry', 'Quit'],
    title: 'Setup Incomplete',
    message: 'Clippy needs dependencies to function',
    detail: 'Would you like to try the setup again?'
  });

  if (response.response === 0) {
    // Retry
    return await setupService.runSetup();
  } else {
    // Quit
    app.quit();
    return false;
  }
}
```

## 9. Adding Setup to Electron Builder Config

The `package.json` already has the correct electron-builder configuration. Just ensure the `assets` directory is included:

```json
{
  "build": {
    "files": [
      "assets/**/*",
      // ... other files
    ]
  }
}
```

## 10. Next Steps

### Required Integration Steps
1. [ ] Update `electron/main.ts` to use `SetupService`
2. [ ] Test dependency checking on Windows
3. [ ] Test portable installation
4. [ ] Test AI wizard flow
5. [ ] Update existing `ExecutablesUtil` references (or remove)

### Optional Enhancements
- [ ] Add progress bar to setup window
- [ ] Add "Cancel" button to long-running downloads
- [ ] Add setup logs viewer
- [ ] Add dependency update checker
- [ ] Add settings page for managing dependencies

## 11. Rollback Plan

If the new system has issues, you can easily rollback:

1. Remove the `setupService` code from `main.ts`
2. Restore the original `ExecutablesUtil` check:
   ```typescript
   const executablesUtil = new ExecutablesUtil();
   await executablesUtil.checkAndConfigureExecutables();
   ```
3. The new files won't affect anything if not imported

## 12. Deployment Checklist

Before deploying to users:

- [ ] Test complete setup flow on clean Windows VM
- [ ] Test with Chocolatey installed
- [ ] Test with Scoop installed
- [ ] Test with Winget only
- [ ] Test with no package manager
- [ ] Test AI wizard acceptance
- [ ] Test AI wizard rejection
- [ ] Test cancelling setup mid-way
- [ ] Test retry after failure
- [ ] Verify portable installations work
- [ ] Verify environment variables are set correctly
- [ ] Test that backend picks up dependencies
- [ ] Test video download with portable yt-dlp
- [ ] Test video processing with portable FFmpeg
- [ ] Test AI features with installed model

## 13. Common Issues During Integration

### Issue: Setup window doesn't show
**Solution**: Check that `assets/setup.html` is included in the build:
```bash
ls dist-electron/assets/setup.html
```

### Issue: Environment variables not set
**Solution**: Ensure `setupEnvironmentVariables()` is called after setup completes:
```typescript
portableManager.setupEnvironmentVariables();
```

### Issue: Backend can't find dependencies
**Solution**: Check that backend services check `process.env.*_PATH` first before falling back to system PATH.

### Issue: Portable Python not working
**Solution**: Ensure Python's directory is added to PATH, not just the executable:
```typescript
const pythonDir = path.dirname(pythonPath);
process.env.PATH = `${pythonDir};${process.env.PATH}`;
```

## 14. Support & Debugging

### Enable Verbose Logging

```typescript
// In main.ts
log.transports.file.level = 'debug';
log.transports.console.level = 'debug';
```

### Check Setup Status

```typescript
const checker = new DependencyChecker();
const result = await checker.checkAll();
console.log('Dependencies:', result);

const portableManager = new PortableDependencyManager();
const info = portableManager.getInstallationInfo();
console.log('Installation info:', info);
```

### View Logs

Logs are stored at:
- Windows: `%APPDATA%/Clippy/logs/main.log`
- Mac: `~/Library/Logs/Clippy/main.log`

## 15. Documentation for Users

Create a user-facing document explaining:
- What dependencies are needed and why
- How the automated setup works
- What data is stored where
- How to manually install dependencies if needed
- How to enable/disable AI features
- Disk space requirements

Sample content is in `WINDOWS_SETUP_GUIDE.md`.

---

## Summary

The new setup system provides:
- ✅ Automated dependency detection
- ✅ User-friendly installation dialogs
- ✅ Portable dependency management
- ✅ AI features wizard
- ✅ Progress tracking
- ✅ Graceful fallbacks
- ✅ Isolated installations
- ✅ No system PATH pollution

Integration is straightforward and can be rolled back if needed.
