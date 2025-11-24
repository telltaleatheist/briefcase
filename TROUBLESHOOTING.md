# Troubleshooting Guide

## Common Issues and Solutions

### Issue: "Cannot find module '../dist-electron/shared/binary-paths'"

**Symptom:**
```
Error: Cannot find module '../dist-electron/shared/binary-paths'
Require stack:
- /Applications/ClipChimp.app/Contents/Resources/app.asar/dist-electron/electron/utilities/executables.js
```

**Cause:**
This is a **path resolution issue** after TypeScript compilation. The problem occurs because:

1. Source file location: `electron/utilities/executables.ts`
2. Import path in source: `'../../dist-electron/shared/binary-paths'`
3. Compiled file location: `dist-electron/electron/utilities/executables.js`
4. Import path after compilation: Still `'../../dist-electron/shared/binary-paths'`

The path that works in development (`electron/utilities/` → `../../dist-electron/shared/`) doesn't work after compilation (`dist-electron/electron/utilities/` → `../../dist-electron/shared/` = `dist-electron/dist-electron/shared/`).

**Solution:**
Change the import path to be relative to the **compiled location**, not the source location.

**Before:**
```typescript
// In electron/utilities/executables.ts
import { getBinariesConfig } from '../../dist-electron/shared/binary-paths';
```

**After:**
```typescript
// In electron/utilities/executables.ts
// Path is relative to compiled location: dist-electron/electron/utilities/executables.js
import { getBinariesConfig } from '../../shared/binary-paths';
```

After compilation, this resolves correctly:
- From: `dist-electron/electron/utilities/executables.js`
- Path: `../../shared/binary-paths`
- Resolves to: `dist-electron/shared/binary-paths` ✓

**Why backend paths are different:**
Backend files use `require('../../../dist-electron/shared/binary-paths')` because:
- Backend files are in `backend/src/` (NOT compiled to dist-electron)
- They need to go up 3 levels to reach project root
- Then access `dist-electron/shared/binary-paths`
- This works because backend is in `extraResources`, not in ASAR

---

### Issue: Binaries Not Found After Packaging

**Symptom:**
```
Error: yt-dlp path is not defined
Error: ffmpeg executable not found
```

**Cause:**
Binaries are not in the expected locations after packaging.

**Solution:**
1. Verify `extraResources` configuration in `package.json`
2. Use centralized binary path resolver: `shared/binary-paths.ts`
3. Check that binaries are actually copied to `Resources/` folder

**Debug:**
```bash
# Check packaged app structure
ls -la "ClipChimp.app/Contents/Resources/utilities/bin/"
ls -la "ClipChimp.app/Contents/Resources/node_modules/@ffmpeg-installer/"

# Check logs for path resolution
tail -f ~/Library/Logs/ClipChimp/main.log
```

---

### Issue: Whisper Models Not Downloading

**Symptom:**
```
Error: Permission denied writing to cache
Error: EACCES: permission denied, mkdir 'Resources/python/cache'
```

**Cause:**
Whisper cache was set to a read-only location inside the bundled resources.

**Solution:**
Cache directory has been fixed to use writable user data location:

```typescript
// ✅ CORRECT (now fixed)
const userDataPath = getUserDataPath(); // ~/Library/Application Support/clipchimp
const cacheDir = path.join(userDataPath, 'cache');
process.env.XDG_CACHE_HOME = cacheDir;
```

Whisper models will now download to:
```
~/Library/Application Support/clipchimp/cache/
```

---

### Issue: Database Write Errors

**Symptom:**
```
Error: SQLITE_READONLY: attempt to write a readonly database
Error: unable to open database file
```

**Cause:**
Database file is in a read-only location or incorrect permissions.

**Solution:**
Verify database is in user data directory:

```typescript
const dbPath = path.join(
  app.getPath('userData'),
  'libraries',
  libraryId,
  'library.db'
);
```

**Not in:**
- `process.resourcesPath` ❌
- Inside app bundle ❌
- ASAR archive ❌

**Should be in:**
- `~/Library/Application Support/clipchimp/` ✓

---

### Issue: Native Module Loading Errors

**Symptom:**
```
Error: Cannot load native module better_sqlite3.node
Error: Module did not self-register
```

**Cause:**
Native modules (`.node` files) cannot be loaded from inside ASAR.

**Solution:**
1. Verify `backend/node_modules` is in `extraResources`
2. Check `package.json`:

```json
{
  "build": {
    "extraResources": [
      {
        "from": "backend/node_modules",
        "to": "backend/node_modules"
      }
    ]
  }
}
```

3. Native modules must be in `Resources/backend/node_modules/`, not in ASAR

---

### Issue: Frontend Not Loading

**Symptom:**
Blank window or "Failed to load resource" errors

**Cause:**
Frontend path resolution incorrect.

**Solution:**
Check `environment.util.ts` getFrontEndPath():

```typescript
const possiblePaths = [
  // Packaged paths (inside app bundle)
  path.join(process.resourcesPath, 'frontend', 'dist', 'clipchimp-frontend', 'browser'),
  path.join(process.resourcesPath, 'app.asar', 'frontend', 'dist', 'clipchimp-frontend', 'browser'),

  // Development paths
  path.join(process.cwd(), 'frontend', 'dist', 'clipchimp-frontend', 'browser'),
];
```

---

### Issue: Environment Variables Not Set

**Symptom:**
```
process.env.FFMPEG_PATH is undefined
process.env.YT_DLP_PATH is undefined
```

**Cause:**
Environment variables are not persisted or binary paths not detected.

**Solution:**
1. The app now uses centralized binary path resolver (doesn't rely on env vars)
2. If needed, set manually in config:

```bash
# Check config file
cat ~/Library/Application\ Support/clipchimp/app-config.json

# Should contain:
{
  "ffmpegPath": "/path/to/ffmpeg",
  "ffprobePath": "/path/to/ffprobe",
  "ytDlpPath": "/path/to/yt-dlp"
}
```

---

## Testing Checklist

### Development Testing
```bash
# Clean build
npm run clean:all

# Full build
npm run build:all

# Test in dev mode
npm run electron:dev

# Test in production mode (without packaging)
npm run electron:test-packaged
```

### Packaging Testing
```bash
# Clean previous builds
npm run clean:mac

# Package for your platform
npm run package:mac-arm64

# Run packaged app
open "dist-electron/mac-arm64/ClipChimp.app"

# Check logs
tail -f ~/Library/Logs/ClipChimp/main.log
```

### Verification Steps

1. **Binaries Detected:**
   - Check logs for: "Using centralized binary path resolver"
   - Should show: FFmpeg, FFprobe, yt-dlp paths and sources

2. **Database Works:**
   - Create a new library
   - Import a video
   - Verify database file created in `~/Library/Application Support/clipchimp/libraries/`

3. **Downloads Work:**
   - Paste a video URL
   - Download should start
   - File should appear in clips folder

4. **Transcription Works:**
   - Run transcription on a video
   - Whisper models download to `~/Library/Application Support/clipchimp/cache/`
   - Transcript appears in database

5. **Config Persists:**
   - Close and reopen app
   - Settings should be remembered
   - Libraries should still be available

---

## Debug Mode

Enable debug logging by setting environment variable:

```bash
# macOS/Linux
export ELECTRON_ENABLE_LOGGING=1
npm run electron:dev

# Or in packaged app
ELECTRON_ENABLE_LOGGING=1 /Applications/ClipChimp.app/Contents/MacOS/ClipChimp
```

Check logs:
```bash
# macOS
tail -f ~/Library/Logs/ClipChimp/main.log

# Windows
type %USERPROFILE%\AppData\Roaming\ClipChimp\logs\main.log

# Linux
tail -f ~/.config/ClipChimp/logs/main.log
```

---

## Getting Help

If you encounter issues:

1. **Check logs** first (locations above)
2. **Verify file locations** match this guide
3. **Try clean rebuild**: `npm run clean:all && npm run build:all`
4. **Check GitHub issues** for similar problems
5. **Create new issue** with:
   - Error message and stack trace
   - Log file excerpts
   - OS and version
   - Steps to reproduce

---

## Related Documentation

- `BINARY_PACKAGING_GUIDE.md` - Binary packaging details
- `ASAR_PACKAGING_GUIDE.md` - ASAR vs extraResources
- `README.md` - General setup and usage
