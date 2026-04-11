# ASAR Packaging Guide

## Understanding ASAR in Electron

ASAR (Atom Shell Archive Resource) is a read-only archive format used by Electron to package application code. Understanding what goes in vs out of the ASAR is critical for proper packaging.

### Key Principle
**ASAR = READ-ONLY** ❌ No writes, no modifications
**extraResources = READ/WRITE/EXECUTE** ✅ Full filesystem access

## What Goes Where in Briefcase

### ✅ INSIDE ASAR (Read-Only Code)

The following are packaged **inside** `app.asar` (read-only):

```
app.asar/
├── frontend/dist/briefcase-frontend/     # Angular frontend
├── dist-electron/electron/             # Electron main process
├── dist-electron/config/               # Config utilities
├── dist-electron/utilities/            # Utility functions
├── dist-electron/shared/               # Shared binary path resolver
└── node_modules/                       # Electron main process dependencies
```

**Why in ASAR:**
- Frontend code (HTML, JS, CSS) - only needs to be read
- Electron main process code - only needs to be read
- Shared utilities - only needs to be read
- Root node_modules - for Electron main process only

### ✅ OUTSIDE ASAR (extraResources)

The following are in **extraResources** (writable/executable):

```
YourApp.app/Contents/Resources/
├── backend/
│   ├── dist/                           # NestJS backend code
│   └── node_modules/                   # Backend dependencies (incl. native modules)
├── backend/python/                     # Python analysis scripts
├── node_modules/@ffmpeg-installer/     # FFmpeg binaries
├── node_modules/@ffprobe-installer/    # FFprobe binaries
├── utilities/bin/                      # yt-dlp binaries
└── python/                             # Bundled Python runtime
```

**Why in extraResources:**
- **Backend node_modules**: Contains native modules (`.node` files) like `better-sqlite3`
- **Binaries**: Need execute permissions (ffmpeg, ffprobe, yt-dlp, python)
- **Python scripts**: May be modified or need to be accessible by Python runtime

### ✅ OUTSIDE APP (User Data)

The following are in **user data directories** (fully writable):

```
~/Library/Application Support/briefcase/
├── app-config.json                     # User binary paths config
├── libraries-config.json               # Library configuration
├── libraries/                          # Clip libraries
│   ├── {library-id}/
│   │   ├── library.db                  # SQLite database
│   │   └── clips/                      # Downloaded videos
├── cache/                              # Whisper models & cache
└── logs/                               # Application logs
```

**Why in user data:**
- **Configuration files**: Users can modify settings
- **Databases**: Need write access for CRUD operations
- **Downloaded content**: User's videos and clips
- **Cache**: Whisper models (can be 100+ MB), need write access
- **Logs**: Runtime logging

## Critical Configuration

### package.json Configuration

```json
{
  "build": {
    "asar": true,                       // Enable ASAR packaging
    "extraResources": [
      {
        "from": "backend/node_modules",
        "to": "backend/node_modules"    // Native modules must be outside ASAR
      },
      {
        "from": "backend/dist",
        "to": "backend/dist"            // Backend code (for flexibility)
      },
      {
        "from": "utilities",
        "to": "utilities"               // Binaries (yt-dlp)
      },
      {
        "from": "node_modules/@ffmpeg-installer",
        "to": "node_modules/@ffmpeg-installer"  // FFmpeg binary
      },
      {
        "from": "node_modules/@ffprobe-installer",
        "to": "node_modules/@ffprobe-installer" // FFprobe binary
      }
    ],
    "asarUnpack": [
      "utilities/**"                    // Also unpack utilities from ASAR as fallback
    ],
    "mac": {
      "extraResources": [
        {
          "from": "dist-python/python-arm64",
          "to": "python"                // Bundled Python runtime
        }
      ]
    }
  }
}
```

### Why These Locations?

#### Native Modules (`backend/node_modules`)
```javascript
// better-sqlite3 has native bindings
backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```
- **Problem**: `.node` files cannot be loaded from inside ASAR
- **Solution**: Put entire `backend/node_modules` in extraResources

#### Binaries (ffmpeg, ffprobe, yt-dlp, python)
```bash
# These need execute permissions
chmod +x Resources/utilities/bin/yt-dlp_macos
chmod +x Resources/node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg
```
- **Problem**: Cannot execute files inside ASAR
- **Solution**: Put binaries in extraResources

#### Whisper Cache (CRITICAL FIX)
```typescript
// ❌ WRONG: Cache inside bundled Python (read-only)
const cacheDir = path.join(resourcesPath, 'python', 'cache');

// ✅ CORRECT: Cache in user data (writable)
const userDataPath = app.getPath('userData');
const cacheDir = path.join(userDataPath, 'cache');
process.env.XDG_CACHE_HOME = cacheDir;
```
- **Problem**: Whisper needs to download models (can be 100+ MB)
- **Solution**: Use user data directory for cache (now fixed)

## Path Resolution in Code

### Using app.getPath()

Always use Electron's `app.getPath()` for writable directories:

```typescript
import { app } from 'electron';

// ✅ CORRECT: User data (writable)
const configPath = path.join(app.getPath('userData'), 'app-config.json');
const cacheDir = path.join(app.getPath('userData'), 'cache');
const logsDir = path.join(app.getPath('logs'));

// ✅ CORRECT: Resources (binaries, read-only/executable)
const resourcesPath = process.resourcesPath;
const ffmpegPath = path.join(resourcesPath, 'node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg');
const ytdlpPath = path.join(resourcesPath, 'utilities/bin/yt-dlp_macos');
```

### Using Centralized Binary Resolver

The `shared/binary-paths.ts` module handles all binary path resolution:

```typescript
import { getBinariesConfig } from '../dist-electron/shared/binary-paths';

const binaries = getBinariesConfig();
console.log(binaries.ffmpeg.path);    // Auto-detects correct path
console.log(binaries.ffprobe.path);   // Works in dev & production
console.log(binaries.ytdlp.path);     // Handles ASAR correctly
```

## Platform-Specific Paths

### macOS
```
YourApp.app/
├── Contents/
│   ├── MacOS/
│   │   └── YourApp                     # Electron executable
│   ├── Resources/
│   │   ├── app.asar                    # READ-ONLY
│   │   ├── backend/                    # extraResources (R/W/X)
│   │   ├── python/                     # extraResources (R/X)
│   │   ├── utilities/                  # extraResources (R/X)
│   │   └── node_modules/               # extraResources (R/X)
│   └── Info.plist

~/Library/Application Support/briefcase/   # User data (R/W)
├── app-config.json
├── libraries-config.json
├── cache/
└── logs/
```

### Windows
```
YourApp/
├── YourApp.exe                         # Electron executable
└── resources/
    ├── app.asar                        # READ-ONLY
    ├── backend/                        # extraResources (R/W/X)
    ├── python/                         # extraResources (R/X)
    ├── utilities/                      # extraResources (R/X)
    └── node_modules/                   # extraResources (R/X)

%APPDATA%/briefcase/                       # User data (R/W)
├── app-config.json
├── libraries-config.json
├── cache/
└── logs/
```

### Linux
```
YourApp/
├── yourapp                             # Electron executable
└── resources/
    ├── app.asar                        # READ-ONLY
    ├── backend/                        # extraResources (R/W/X)
    ├── python/                         # extraResources (R/X)
    ├── utilities/                      # extraResources (R/X)
    └── node_modules/                   # extraResources (R/X)

~/.config/briefcase/                       # User data (R/W)
├── app-config.json
├── libraries-config.json
├── cache/
└── logs/
```

## Common Pitfalls & Solutions

### ❌ Pitfall 1: Writing to ASAR
```typescript
// ❌ WRONG: Trying to write to app directory
const configPath = path.join(__dirname, 'config.json');
fs.writeFileSync(configPath, data);  // FAILS in production!
```

**Solution:**
```typescript
// ✅ CORRECT: Use userData
const { app } = require('electron');
const configPath = path.join(app.getPath('userData'), 'config.json');
fs.writeFileSync(configPath, data);  // Works!
```

### ❌ Pitfall 2: Native Modules in ASAR
```json
// ❌ WRONG: Native modules inside ASAR
{
  "files": [
    "backend/node_modules/**/*"  // Will be packed into ASAR
  ]
}
```

**Solution:**
```json
// ✅ CORRECT: Native modules in extraResources
{
  "files": [
    "!backend/**"  // Exclude backend from ASAR
  ],
  "extraResources": [
    {
      "from": "backend/node_modules",
      "to": "backend/node_modules"  // Outside ASAR
    }
  ]
}
```

### ❌ Pitfall 3: Hardcoded Paths
```typescript
// ❌ WRONG: Hardcoded development path
const dbPath = '/Users/you/projects/Briefcase/data/library.db';
```

**Solution:**
```typescript
// ✅ CORRECT: Dynamic user data path
const { app } = require('electron');
const dbPath = path.join(
  app.getPath('userData'),
  'libraries',
  libraryId,
  'library.db'
);
```

### ❌ Pitfall 4: Cache in Bundled Directory
```typescript
// ❌ WRONG: Cache inside bundled resources (read-only!)
const cacheDir = path.join(process.resourcesPath, 'python', 'cache');
process.env.XDG_CACHE_HOME = cacheDir;  // Cannot write!
```

**Solution (NOW FIXED):**
```typescript
// ✅ CORRECT: Cache in user data directory
const { app } = require('electron');
const cacheDir = path.join(app.getPath('userData'), 'cache');
process.env.XDG_CACHE_HOME = cacheDir;  // Writable!
```

## Testing ASAR Configuration

### Development Testing
```bash
# Test with production-like environment
npm run electron:test-packaged
```

### Production Testing
```bash
# Build and test the packaged app
npm run package:mac-arm64

# Run the packaged app
open "dist-electron/mac-arm64/Briefcase.app"
```

### Verification Checklist

1. **Binaries are executable**:
   ```bash
   # Check inside packaged app
   ls -la "Briefcase.app/Contents/Resources/utilities/bin/yt-dlp_macos"
   # Should show: -rwxr-xr-x (executable)
   ```

2. **User data is writable**:
   ```bash
   # Check user data directory after running app
   ls -la ~/Library/Application\ Support/Briefcase/
   # Should see: config files, databases, cache
   ```

3. **Native modules load**:
   ```bash
   # Check logs for any "Cannot load native module" errors
   tail -f ~/Library/Logs/Briefcase/main.log
   ```

4. **Whisper cache works**:
   ```bash
   # After running transcription, verify models downloaded
   ls -la ~/Library/Application\ Support/Briefcase/cache/
   # Should see Whisper model files
   ```

## Summary

### ✅ Checklist for ASAR Packaging

- [x] **Binaries in extraResources** (ffmpeg, ffprobe, yt-dlp, python)
- [x] **Native modules in extraResources** (better-sqlite3, etc.)
- [x] **Backend code in extraResources** (for flexibility)
- [x] **User data in app.getPath('userData')** (config, databases, downloads)
- [x] **Cache in writable location** (Whisper models, temp files)
- [x] **Centralized path resolution** (shared/binary-paths.ts)
- [x] **Platform-specific handling** (macOS, Windows, Linux)

### 🎯 Key Takeaway

**If it needs write access OR execute permissions, it MUST be outside the ASAR.**

The only exception is frontend code and utilities that are purely read-only.
