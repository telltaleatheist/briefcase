# Windows Packaging Guide

This guide explains how Clippy packages Python, Python libraries, and required binaries (ffmpeg, ffprobe, yt-dlp) with the Windows installer.

## Overview

Clippy uses a portable Python environment and bundles all necessary dependencies to ensure the application works out-of-the-box on Windows without requiring users to install Python or other dependencies.

## What Gets Packaged

### 1. Python Runtime
- **Python 3.11.9 Embeddable Package** (Windows x64)
- Includes the core Python interpreter and standard library
- Configured to support pip and site-packages

### 2. Python Libraries
All packages from [backend/python/requirements.txt](backend/python/requirements.txt):
- `numpy==1.26.4` - Numerical computing
- `torch==2.1.2` - PyTorch (CPU-only)
- `torchaudio==2.1.2` - Audio processing
- `openai-whisper==20231117` - Audio transcription library
- `requests==2.31.0` - HTTP requests

### 3. Whisper Model
- **Base model** (~150MB) - Bundled for immediate use
- Good balance of speed and accuracy
- No download needed on first transcription

### 4. Binaries
- **ffmpeg** - Video encoding/decoding
- **ffprobe** - Video metadata extraction
- **yt-dlp** - Video downloading (already in `utilities/bin/`)

## Build Process

### Step 1: Package Python (Windows Only)

The packaging script downloads and configures a portable Python environment:

```bash
npm run package:python
```

This script (`scripts/package-python-windows.js`):
1. Downloads Python 3.11.9 embeddable package
2. Extracts it to `dist-python/python/`
3. Configures Python to support pip
4. Installs all dependencies from requirements.txt
5. Downloads Whisper base model (~150MB)
6. Creates a marker file indicating successful packaging

**Output:** `dist-python/python/` directory with complete Python environment

### Step 2: Build Application

```bash
npm run build:all
```

Builds frontend, backend, and electron code.

### Step 3: Package with electron-builder

```bash
npm run package:win
```

This command:
1. Cleans previous Windows builds
2. Runs `build:all`
3. Runs `package:python` (downloads & configures Python)
4. Runs electron-builder with Windows target

## How Resources Are Bundled

The electron-builder configuration in [package.json](package.json) specifies what to include:

```json
"extraResources": [
  {
    "from": "backend/node_modules",
    "to": "backend/node_modules"
  },
  {
    "from": "utilities",
    "to": "utilities"
  },
  {
    "from": "dist-python/python",
    "to": "python",
    "filter": ["**/*"]
  },
  {
    "from": "node_modules/@ffmpeg-installer",
    "to": "binaries/ffmpeg",
    "filter": ["**/*"]
  },
  {
    "from": "node_modules/@ffprobe-installer",
    "to": "binaries/ffprobe",
    "filter": ["**/*"]
  }
]
```

### Installed Directory Structure

After installation, resources are located in:
```
C:\Users\<username>\AppData\Local\Programs\Clippy\resources\
├── python\                    # Portable Python environment
│   ├── python.exe
│   ├── python311.dll
│   ├── Lib\
│   │   └── site-packages\    # All Python libraries
│   │       ├── whisper\
│   │       ├── torch\
│   │       ├── numpy\
│   │       └── ...
│   ├── cache\
│   │   └── whisper\          # Bundled Whisper base model
│   │       └── base.pt
│   └── PACKAGED_VERSION.txt
├── binaries\
│   ├── ffmpeg\
│   │   └── ffmpeg\
│   │       └── ffmpeg.exe
│   └── ffprobe\
│       └── ffprobe\
│           └── ffprobe.exe
├── utilities\
│   └── bin\
│       ├── yt-dlp.exe
│       ├── yt-dlp_linux
│       └── yt-dlp_macos
└── backend\
    └── node_modules\
        └── ...
```

## How the Application Uses Packaged Resources

### Python Configuration

The application automatically detects whether it's running in production and uses the appropriate Python:

**File:** [electron/shared/python-config.ts](electron/shared/python-config.ts)

```typescript
export function getPythonConfig(): PythonConfig {
  // Check if we're running in a packaged app
  const isPackaged = process.env.NODE_ENV === 'production' ||
                     (process as any).resourcesPath !== undefined ||
                     process.defaultApp === false;

  if (isPackaged) {
    const resourcesPath = (process as any).resourcesPath;
    const packagedPythonPath = path.join(resourcesPath, 'python', 'python.exe');

    if (fs.existsSync(packagedPythonPath)) {
      return { command: packagedPythonPath, isConda: false };
    }
  }

  // Fall back to system Python in development
  return { command: 'python', isConda: false };
}
```

**Files that use this:**
- [backend/src/analysis/python-bridge.service.ts](backend/src/analysis/python-bridge.service.ts) - Spawns Python processes
- [backend/src/shared/python-config.ts](backend/src/shared/python-config.ts) - Backend copy

### FFmpeg/FFprobe Configuration

**File:** [backend/src/ffmpeg/ffmpeg.service.ts](backend/src/ffmpeg/ffmpeg.service.ts)

The FFmpeg service checks for packaged binaries in production:

```typescript
if (isPackaged && (!ffmpegExecutablePath || !ffprobeExecutablePath)) {
  const resourcesPath = (process as any).resourcesPath;

  const packagedFfmpegPath = path.join(resourcesPath, 'binaries', 'ffmpeg', 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(packagedFfmpegPath)) {
    ffmpegExecutablePath = packagedFfmpegPath;
  }

  // Similar for ffprobe...
}
```

### yt-dlp Configuration

**File:** [backend/src/downloader/yt-dlp-manager.ts](backend/src/downloader/yt-dlp-manager.ts)

yt-dlp path is resolved through the shared config service, which looks in `resources/utilities/bin/`.

## Development vs Production

### Development Mode
- Uses system Python (or conda environment on macOS)
- Uses ffmpeg/ffprobe from npm packages (`@ffmpeg-installer/*`)
- Uses yt-dlp from `utilities/bin/`

### Production Mode (Packaged)
- Uses bundled Python from `resources/python/`
- Uses bundled ffmpeg/ffprobe from `resources/binaries/`
- Uses bundled yt-dlp from `resources/utilities/bin/`

## Troubleshooting

### Python Packaging Issues

1. **Script fails to download Python:**
   - Check internet connection
   - Verify Python download URL is still valid
   - Manually download and place in `dist-python/`

2. **Pip installation fails:**
   - Ensure `get-pip.py` downloaded successfully
   - Check Python is properly extracted
   - Verify `python311._pth` was modified correctly

3. **Package installation fails:**
   - Check `backend/python/requirements.txt` is valid
   - Try installing packages manually in `dist-python/python/`
   - Check for PyPI connectivity issues

### Runtime Issues

1. **Python not found in packaged app:**
   - Verify `resources/python/python.exe` exists in installation
   - Check `PACKAGED_VERSION.txt` file exists
   - Review electron-builder logs for packaging errors

2. **FFmpeg not found:**
   - Check `resources/binaries/ffmpeg/` exists
   - Verify paths in ffmpeg.service.ts
   - Check file permissions

3. **Missing Python packages:**
   - Verify all packages in requirements.txt were installed
   - Check `resources/python/Lib/site-packages/`
   - Re-run `npm run package:python`

## Size Considerations

The packaged application is large due to PyTorch and Whisper:

- Python embeddable: ~20 MB
- PyTorch (CPU): ~200 MB
- Whisper library: ~50 MB
- Whisper base model: ~150 MB
- ffmpeg: ~100 MB
- Total additional size: ~520 MB

This is necessary for the application to work offline without external dependencies.

## Updating Dependencies

### Update Python Version

Edit [scripts/package-python-windows.js](scripts/package-python-windows.js):

```javascript
const PYTHON_VERSION = '3.11.9';  // Change this
```

### Update Python Packages

Edit [backend/python/requirements.txt](backend/python/requirements.txt) and rebuild.

### Update Binaries

Update npm package versions in [package.json](package.json):

```json
"@ffmpeg-installer/ffmpeg": "^1.1.0",
"@ffprobe-installer/ffprobe": "^2.1.2"
```

## CI/CD Integration

For automated builds, ensure:

1. Windows build server has internet access
2. Node.js and npm are installed
3. Build script has write permissions for `dist-python/`
4. Sufficient disk space (~2 GB free)

Example GitHub Actions workflow:

```yaml
- name: Package Windows
  run: |
    npm install
    npm run install:all
    npm run package:win

- name: Upload artifacts
  uses: actions/upload-artifact@v3
  with:
    name: windows-installer
    path: dist-electron/*.exe
```

## Security Considerations

1. **Python packages** are installed from PyPI - ensure requirements.txt only lists trusted packages
2. **Binaries** (ffmpeg, ffprobe) come from npm packages maintained by the community
3. **yt-dlp** should be updated regularly for security fixes
4. Consider code signing the Windows installer for user trust

## Additional Resources

- [Python Embeddable Package Documentation](https://docs.python.org/3/using/windows.html#the-embeddable-package)
- [electron-builder Documentation](https://www.electron.build/)
- [PyTorch Installation Guide](https://pytorch.org/get-started/locally/)

## Questions?

For issues or questions about packaging, please file an issue with:
- Build logs
- Operating system and version
- Node.js version
- Output of `npm run package:python`
