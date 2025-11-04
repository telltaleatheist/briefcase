# Quick Guide: Building Windows Installer

This guide provides step-by-step instructions for building a Windows installer for Clippy that includes all dependencies.

## Prerequisites

- **Node.js** (v18 or higher)
- **npm** (comes with Node.js)
- **Internet connection** (for downloading Python and dependencies)
- **~2 GB free disk space**

## Building the Installer

### Option 1: One Command (Recommended)

```bash
npm run package:win
```

This will:
1. Clean previous Windows builds
2. Build all application code
3. Download and package Python with all dependencies
4. Create the Windows installer

### Option 2: Step-by-Step

If you want more control or need to debug:

```bash
# 1. Install dependencies
npm install
npm run install:all

# 2. Build application
npm run build:all

# 3. Package Python (Windows only)
npm run package:python

# 4. Create installer
electron-builder build --win --publish never
```

## Output

The installer will be created in:
```
dist-electron/Clippy Setup <version>.exe
```

## What Gets Packaged

The installer includes:
- ✅ **Python 3.11.9** (portable, no system installation needed)
- ✅ **Python Libraries**: numpy, PyTorch, Whisper, requests
- ✅ **Whisper base model** (~150MB, bundled for immediate use)
- ✅ **ffmpeg & ffprobe** (video processing)
- ✅ **yt-dlp** (video downloading)
- ✅ **All Node.js dependencies**
- ✅ **Application code** (frontend + backend)

## Expected Build Time

- First build: **20-35 minutes** (downloads Python, packages, and Whisper model)
- Subsequent builds: **5-10 minutes** (uses cached Python and model)

## Package Sizes

- Python download: ~20 MB
- Python + packages: ~270 MB
- Whisper base model: ~150 MB
- Total installer: ~550-600 MB

## Troubleshooting

### Python Download Fails

**Error:** `Failed to download Python embeddable package`

**Solution:**
1. Check internet connection
2. Try downloading manually from: https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip
3. Place in `dist-python/` directory
4. Run `npm run package:python` again

### Package Installation Fails

**Error:** `Failed to install Python packages`

**Solution:**
1. Delete `dist-python/` directory
2. Run `npm run package:python` again
3. Check `backend/python/requirements.txt` for syntax errors

### Out of Disk Space

**Error:** `ENOSPC: no space left on device`

**Solution:**
- Free up at least 2 GB of disk space
- The Python packaging requires temporary storage

### electron-builder Fails

**Error:** `Cannot find module 'dist-python/python'`

**Solution:**
- Make sure you ran `npm run package:python` first
- Check that `dist-python/python/` directory exists
- Verify it contains `python.exe` and `Lib/site-packages/`

### Installer Too Large

This is expected. The installer is ~550-600 MB due to:
- PyTorch: ~200 MB
- Whisper base model: ~150 MB
- Whisper library: ~50 MB
- ffmpeg: ~100 MB

This is necessary for offline functionality and immediate transcription without downloads.

## Development vs Production

### Development (npm run electron:dev)
- Uses system Python
- Reads from local files
- Hot reload enabled

### Production (packaged installer)
- Uses bundled Python from `resources/python/`
- All dependencies included
- No external requirements

## Testing the Installer

After building:

1. Locate the installer: `dist-electron/Clippy Setup <version>.exe`
2. Copy to a Windows test machine
3. Run the installer
4. Launch Clippy
5. Test video download and transcription features

## Updating Dependencies

### Update Python Packages

Edit `backend/python/requirements.txt`:
```txt
numpy==1.26.4
torch==2.1.2
openai-whisper==20231117
requests==2.31.0
```

Then rebuild:
```bash
npm run package:win
```

### Update Python Version

Edit `scripts/package-python-windows.js`:
```javascript
const PYTHON_VERSION = '3.11.9';  // Change this
```

Then rebuild:
```bash
npm run package:win
```

## Continuous Integration

For CI/CD pipelines (GitHub Actions, etc.):

```yaml
name: Build Windows Installer

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install && npm run install:all

      - name: Build Windows Installer
        run: npm run package:win

      - name: Upload installer
        uses: actions/upload-artifact@v3
        with:
          name: windows-installer
          path: dist-electron/*.exe
```

## Distribution

### Code Signing (Optional but Recommended)

To prevent Windows SmartScreen warnings:

1. Get a code signing certificate
2. Configure in `package.json`:

```json
"win": {
  "certificateFile": "path/to/cert.pfx",
  "certificatePassword": "your-password",
  "publisherName": "Your Name",
  "target": ["nsis"]
}
```

### Hosting the Installer

Options for distribution:
- GitHub Releases (recommended)
- Direct download from your website
- Microsoft Store (requires additional setup)

## Advanced Configuration

For more advanced packaging options, see:
- [WINDOWS_PACKAGING_GUIDE.md](WINDOWS_PACKAGING_GUIDE.md) - Detailed technical documentation
- [electron-builder docs](https://www.electron.build/configuration/win)

## Getting Help

If you encounter issues:

1. Check the [WINDOWS_PACKAGING_GUIDE.md](WINDOWS_PACKAGING_GUIDE.md)
2. Review build logs in `npm-debug.log`
3. Check `dist-python/python/PACKAGED_VERSION.txt` exists
4. File an issue with full error logs

## Next Steps

After building successfully:
- ✅ Test on clean Windows installation
- ✅ Verify all features work (download, transcribe, analyze)
- ✅ Consider code signing for distribution
- ✅ Set up automated builds with CI/CD

---

**Build Time:** First build ~20-35 minutes, subsequent builds ~5-10 minutes
**Output Size:** ~550-600 MB
**Python Version:** 3.11.9 (embedded)
**Whisper Model:** base (bundled)
**Target:** Windows x64
