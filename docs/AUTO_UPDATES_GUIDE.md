# Auto-Updates & Blockmap Guide

## Overview

Clippy uses **electron-updater** with **delta updates** via blockmap files. This allows users to download only the changed parts of your app instead of the entire new version.

## How Blockmap Works

### What is a Blockmap?

A blockmap file (`.blockmap`) contains a map of your application divided into chunks (blocks). When checking for updates, electron-updater:

1. Downloads the new blockmap file (~100 KB)
2. Compares it with the current installation's blockmap
3. Identifies which blocks changed
4. Downloads only the changed blocks
5. Reconstructs the new version locally

### Example Savings

```
Scenario 1: Minor Update (bug fixes)
├─ Full download: 150 MB
├─ Delta download: 2-5 MB
└─ Savings: 97%

Scenario 2: Feature Update (new features)
├─ Full download: 150 MB
├─ Delta download: 20-30 MB
└─ Savings: 80%

Scenario 3: Major Update (complete rewrite)
├─ Full download: 150 MB
├─ Delta download: 140 MB
└─ Savings: 7% (falls back to mostly full download)
```

## Your Current Setup

### Already Configured ✅

Your app already has auto-updates configured:

**1. Package.json** ([package.json:160-163](package.json#L160-L163))
```json
"publish": {
  "provider": "github",
  "releaseType": "release"
}
```

**2. UpdateService** ([update-service.ts](electron/services/update-service.ts))
- Listens for update events
- Notifies frontend when updates are available
- Handles installation

**3. Main Process** ([main.ts](electron/main.ts))
```typescript
updateService = new UpdateService(windowService);
```

### What Gets Generated

When you build, electron-builder creates:

**Windows:**
```
dist-electron/
├── Clippy Setup 1.0.0.exe          # NSIS installer (~150 MB)
├── Clippy Setup 1.0.0.exe.blockmap # Binary diff map (~100 KB)
└── latest.yml                       # Update metadata (~1 KB)
```

**macOS:**
```
dist-electron/
├── Clippy-1.0.0.dmg          # DMG installer
├── Clippy-1.0.0.dmg.blockmap # Blockmap
└── latest-mac.yml            # Update metadata
```

**Linux:**
```
dist-electron/
├── Clippy-1.0.0.AppImage          # AppImage
├── Clippy-1.0.0.AppImage.blockmap # Blockmap
└── latest-linux.yml               # Update metadata
```

## Blockmap File Format

A blockmap file looks like this (simplified):

```json
{
  "version": "2",
  "files": [
    {
      "name": "app.asar",
      "offset": 0,
      "checksums": [
        "sha512-base64-hash-block1",
        "sha512-base64-hash-block2",
        "sha512-base64-hash-block3"
      ]
    }
  ],
  "blockSize": 524288  // 512 KB per block
}
```

Each block is 512 KB. If block 2's hash changes, only that 512 KB is re-downloaded.

## Setting Up GitHub Releases

### Step 1: Create GitHub Release

```bash
# 1. Tag your version
git tag v1.0.1
git push origin v1.0.1

# 2. Build for platforms
npm run package:win
npm run package:mac
npm run package:linux

# 3. Go to GitHub → Releases → Create Release
# 4. Upload the files (see below)
```

### Step 2: Upload Files to GitHub Release

For **each platform**, upload:

**Windows:**
- ✅ `Clippy Setup 1.0.1.exe`
- ✅ `Clippy Setup 1.0.1.exe.blockmap`
- ✅ `latest.yml`

**macOS:**
- ✅ `Clippy-1.0.1.dmg`
- ✅ `Clippy-1.0.1.dmg.blockmap`
- ✅ `latest-mac.yml`

**Linux:**
- ✅ `Clippy-1.0.1.AppImage`
- ✅ `Clippy-1.0.1.AppImage.blockmap`
- ✅ `latest-linux.yml`

### Step 3: GitHub Release Configuration

Your release should look like this:

```
Release: v1.0.1
Tag: v1.0.1
Title: Clippy v1.0.1

Description:
### What's New
- Feature 1
- Feature 2
- Bug fix 3

### Download
Choose your platform below.

Assets:
📦 Clippy Setup 1.0.1.exe (150 MB)
📄 Clippy Setup 1.0.1.exe.blockmap (100 KB)
📄 latest.yml (1 KB)
📦 Clippy-1.0.1.dmg (145 MB)
📄 Clippy-1.0.1.dmg.blockmap (95 KB)
📄 latest-mac.yml (1 KB)
...
```

## How Users Get Updates

### First Install
```
1. User downloads Clippy Setup 1.0.0.exe from GitHub
2. Installs app
3. App stores blockmap locally
```

### Update Check
```
1. App starts
2. Checks GitHub for latest.yml
3. Finds v1.0.1 available
4. Downloads latest.blockmap (100 KB)
5. Compares with local blockmap
6. Downloads only changed blocks (~5-30 MB)
7. Reconstructs installer
8. Notifies user "Update ready"
```

### User Experience
```
┌─────────────────────────────────────┐
│  Update Available                   │
├─────────────────────────────────────┤
│  Clippy v1.0.1 is available         │
│                                     │
│  What's new:                        │
│  • Feature improvements             │
│  • Bug fixes                        │
│                                     │
│  Download size: 8 MB                │
│                                     │
│  [Download]  [Later]  [Ignore]     │
└─────────────────────────────────────┘
```

## Configuring Update Behavior

### Update Main.ts to Check for Updates

Add to [main.ts](electron/main.ts) after window creation:

```typescript
// After windowService.createMainWindow()

// Check for updates (only in production)
if (!isDevelopment && process.platform !== 'darwin') {
  // Check for updates 10 seconds after launch
  setTimeout(() => {
    log.info('Checking for updates...');
    updateService.checkForUpdates();
  }, 10000);
}

// Check daily while app is running
setInterval(() => {
  if (!isDevelopment) {
    updateService.checkForUpdates();
  }
}, 24 * 60 * 60 * 1000); // 24 hours
```

### Update UpdateService to Add Check Method

Add to [update-service.ts](electron/services/update-service.ts):

```typescript
/**
 * Check for updates manually
 */
async checkForUpdates(): Promise<void> {
  if (process.env.NODE_ENV === 'development') {
    log.info('Skipping update check in development');
    return;
  }

  try {
    log.info('Checking for updates...');
    const result = await autoUpdater.checkForUpdates();

    if (result) {
      log.info('Update check result:', {
        currentVersion: result.currentVersion,
        updateInfo: result.updateInfo
      });
    }
  } catch (error) {
    log.error('Failed to check for updates:', error);
  }
}
```

## Advanced Configuration

### Custom Update Server (Optional)

If you don't want to use GitHub:

```typescript
// In main.ts before autoUpdater is used
autoUpdater.setFeedURL({
  provider: 'generic',
  url: 'https://your-server.com/updates'
});
```

Your server should serve:
- `latest.yml` (or `latest-mac.yml`, `latest-linux.yml`)
- Installer files
- Blockmap files

### Staged Rollouts

Release to percentage of users:

```typescript
// 10% of users get the update
autoUpdater.on('checking-for-update', () => {
  if (Math.random() > 0.1) {
    autoUpdater.autoDownload = false;
  }
});
```

### Beta Channel

Separate beta releases:

```json
// package.json
{
  "build": {
    "publish": {
      "provider": "github",
      "releaseType": "release",  // or "prerelease" for beta
      "channel": "latest"        // or "beta"
    }
  }
}
```

Users can switch channels:

```typescript
autoUpdater.channel = 'beta'; // or 'latest'
autoUpdater.checkForUpdates();
```

## Frontend Integration

### Show Update Notification

In your Angular app:

```typescript
// app.component.ts
export class AppComponent implements OnInit {
  ngOnInit() {
    // Listen for update available
    window.addEventListener('electron-update-available', () => {
      this.showUpdateNotification();
    });

    // Listen for update downloaded
    window.addEventListener('electron-update-downloaded', () => {
      this.showUpdateReadyNotification();
    });
  }

  showUpdateNotification() {
    // Show notification: "Update available, downloading..."
  }

  showUpdateReadyNotification() {
    // Show notification: "Update ready, restart to install"
    const shouldRestart = confirm('Update downloaded. Restart now?');
    if (shouldRestart) {
      window.electron.installUpdate();
    }
  }
}
```

## Testing Updates

### Test Locally

1. **Build v1.0.0:**
   ```bash
   npm version 1.0.0
   npm run package:win
   ```

2. **Install it**

3. **Build v1.0.1:**
   ```bash
   npm version 1.0.1
   npm run package:win
   ```

4. **Create local server:**
   ```bash
   # In dist-electron directory
   npx http-server -p 8080 --cors
   ```

5. **Point app to local server:**
   ```typescript
   // In main.ts (temporary, for testing)
   autoUpdater.setFeedURL({
     provider: 'generic',
     url: 'http://localhost:8080'
   });
   ```

6. **Test update flow**

### Test with GitHub

1. Create a private test repository
2. Create release with v1.0.0
3. Install app
4. Create release with v1.0.1
5. App should detect and download update

## Troubleshooting

### Updates Not Working

**Problem:** App doesn't detect updates

**Check:**
```typescript
// Enable debug logging
import log from 'electron-log';
log.transports.file.level = 'debug';
autoUpdater.logger = log;
```

**Common Causes:**
- Forgot to upload blockmap files
- Forgot to upload `latest.yml`
- GitHub release is draft (not published)
- App name in `package.json` doesn't match GitHub repo

### Blockmap Download Fails

**Problem:** Falls back to full download

**Causes:**
- Blockmap file missing from release
- Blockmap file corrupted
- Network issues
- First install (no previous blockmap to compare)

**Solution:**
- Verify all files uploaded to GitHub
- Check file permissions (must be public)
- electron-updater will fallback to full download automatically

### Signature Verification Fails (macOS)

**Problem:** "App is damaged" message

**Solution:** Code sign your app:
```bash
# Requires Apple Developer account
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=certificate-password
npm run package:mac
```

## Security

### Code Signing

**Windows:** Sign with Microsoft Authenticode
```bash
export WIN_CSC_LINK=/path/to/certificate.pfx
export WIN_CSC_KEY_PASSWORD=password
npm run package:win
```

**macOS:** Sign with Apple Developer Certificate
```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=password
npm run package:mac
```

### Blockmap Integrity

Blockmap uses SHA-512 hashes to verify each block:
- Prevents corrupted downloads
- Detects man-in-the-middle attacks
- Ensures update authenticity

### HTTPS Required

electron-updater **requires HTTPS** for updates (GitHub provides this automatically).

## Performance Tips

### 1. Optimize Build Size

Smaller app = fewer blocks = faster updates:

```json
// package.json
{
  "build": {
    "compression": "maximum",
    "files": [
      "!**/*.map",  // Exclude source maps
      "!**/test/**" // Exclude tests
    ]
  }
}
```

### 2. Stable Chunks

Put frequently changing code in separate files:
- Core logic rarely changes → few blocks to update
- UI code changes often → isolated to specific blocks

### 3. ASAR Archive

Use ASAR (already enabled in your config):
```json
{
  "asar": true
}
```

This creates a single `app.asar` file that's more efficient for blockmap updates.

## Monitoring

### Track Update Adoption

```typescript
autoUpdater.on('update-downloaded', () => {
  // Send analytics event
  analytics.track('update_downloaded', {
    from: app.getVersion(),
    to: updateInfo.version
  });
});
```

### Monitor Download Sizes

```typescript
autoUpdater.on('download-progress', (progressObj) => {
  log.info('Download progress:', {
    bytesPerSecond: progressObj.bytesPerSecond,
    percent: progressObj.percent,
    transferred: progressObj.transferred,
    total: progressObj.total
  });
});
```

## Summary

### What You Have Now ✅
- electron-updater configured
- GitHub releases set up
- Blockmap generation automatic
- UpdateService handling events

### What You Need To Do
1. Create GitHub release with your builds
2. Upload `.exe`, `.blockmap`, and `latest.yml` files
3. Test update flow
4. (Optional) Add update check to main.ts
5. (Optional) Add UI notifications for updates

### Benefits
- 🚀 **Fast updates** - Only download changes
- 💾 **Bandwidth friendly** - 90%+ savings on minor updates
- 🔒 **Secure** - SHA-512 verification
- 📦 **Automatic** - electron-builder handles everything
- 🎯 **User friendly** - Silent background downloads

---

The blockmap system is already working - you just need to publish releases with all the generated files!
