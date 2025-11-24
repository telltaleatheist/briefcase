# Build Scripts

This directory contains scripts for packaging and building ClipChimp.

## yt-dlp Binary Management

### Problem

The compiled yt-dlp binaries (built with PyInstaller) have significant startup overhead (~8-9 seconds per execution) due to:
- Extracting the embedded Python runtime
- Initializing the Python interpreter
- Loading bundled modules

This causes metadata fetching to be 10x slower than necessary.

### Solution

We use the Python script versions of yt-dlp instead:
- **macOS/Linux**: Python scripts that use the system Python interpreter (~1 second startup)
- **Windows**: Must use `.exe` as Python isn't guaranteed to be installed

### Usage

**Download fast yt-dlp binaries:**
```bash
npm run download:ytdlp
```

This script:
1. Backs up existing binaries with timestamps
2. Downloads the latest Python script versions for macOS/Linux
3. Downloads the latest .exe for Windows
4. Verifies the downloads are correct

**The download script is automatically run before each packaging command:**
```bash
npm run package:mac-arm64   # Downloads yt-dlp, then packages
npm run package:mac-x64     # Downloads yt-dlp, then packages
npm run package:win-x64     # Downloads yt-dlp, then packages
npm run package:linux       # Downloads yt-dlp, then packages
```

### Performance Impact

- **Before (compiled binary)**: 9 seconds per metadata fetch
- **After (Python script)**: 1 second per metadata fetch
- **Improvement**: 9x faster metadata loading!

### Files

- `download-ytdlp.js` - Downloads fast yt-dlp binaries for all platforms
- `package-python-mac.js` - Packages Python environment for macOS
- `package-python-windows.js` - Packages Python environment for Windows

### Important Notes

1. **Do not manually replace yt-dlp binaries with compiled versions** - they will be slow
2. **macOS/Linux require Python 3** - The yt-dlp scripts use `#!/usr/bin/env python3`
3. **Windows uses .exe** - No Python dependency on Windows
4. **Backups are timestamped** - Old binaries are preserved with `.backup.{timestamp}` suffix
