# Binary Packaging Guide for Clippy

This guide explains how Clippy packages and manages binary dependencies (ffmpeg, ffprobe, yt-dlp, and Python) for distribution.

## Overview

Clippy requires several binary dependencies to function:
- **FFmpeg**: Video/audio processing
- **FFprobe**: Media file analysis
- **yt-dlp**: Video downloading from various platforms
- **Python**: AI/ML processing (Whisper transcription, etc.)

All these binaries are automatically bundled with the packaged application in the `extraResources` folder.

## Centralized Binary Path Resolution

### Location
All binary path resolution logic is centralized in:
```
shared/binary-paths.ts
```

This file is compiled to:
```
dist-electron/shared/binary-paths.js
```

### Usage

The centralized resolver provides these functions:

```typescript
// Get all binary configurations
const binariesConfig = getBinariesConfig();
console.log(binariesConfig.ffmpeg.path);
console.log(binariesConfig.ffprobe.path);
console.log(binariesConfig.ytdlp.path);

// Validate all binaries are available
const validation = validateBinaries();
if (!validation.valid) {
  console.error('Missing binaries:', validation.missing);
}

// Get individual binary paths
const ffmpegPath = getFfmpegPath();
const ffprobePath = getFfprobePath();
const ytdlpPath = getYtDlpPath();
```

### Path Resolution Priority

The resolver follows this priority order:

1. **Environment Variables**: `FFMPEG_PATH`, `FFPROBE_PATH`, `YT_DLP_PATH`
2. **Bundled Binaries** (Production): Located in `process.resourcesPath/`
3. **NPM Packages** (Development): From `@ffmpeg-installer` and `@ffprobe-installer`
4. **Project Files** (Development): `utilities/bin/` for yt-dlp

### Development vs Production

**Development Mode** (`NODE_ENV=development`):
- Uses npm package binaries for ffmpeg/ffprobe
- Uses local `utilities/bin/` for yt-dlp
- More flexible for testing

**Production Mode** (`NODE_ENV=production` or packaged app):
- Uses bundled binaries from `extraResources`
- Self-contained, no external dependencies needed

## Electron Builder Configuration

### extraResources Configuration

In `package.json`, the `build.extraResources` section defines which files to copy to the packaged app:

```json
{
  "build": {
    "extraResources": [
      {
        "from": "utilities",
        "to": "utilities",
        "filter": ["**/*"]
      },
      {
        "from": "node_modules/@ffmpeg-installer",
        "to": "node_modules/@ffmpeg-installer",
        "filter": ["**/*"]
      },
      {
        "from": "node_modules/@ffprobe-installer",
        "to": "node_modules/@ffprobe-installer",
        "filter": ["**/*"]
      }
    ]
  }
}
```

### Platform-Specific Python Packaging

Python is packaged differently per platform:

**macOS ARM64**:
```json
{
  "mac": {
    "extraResources": [
      {
        "from": "dist-python/python-arm64",
        "to": "python"
      }
    ]
  }
}
```

**Windows x64**:
```json
{
  "win": {
    "extraResources": [
      {
        "from": "dist-python/python-x64",
        "to": "python"
      }
    ]
  }
}
```

## Binary Locations in Packaged App

After packaging, binaries are located in:

### macOS
```
YourApp.app/Contents/Resources/
├── node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg
├── node_modules/@ffprobe-installer/darwin-arm64/ffprobe
├── utilities/bin/yt-dlp_macos
└── python/bin/python3
```

### Windows
```
YourApp/resources/
├── node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe
├── node_modules/@ffprobe-installer/win32-x64/ffprobe.exe
├── utilities/bin/yt-dlp.exe
└── python/python.exe
```

### Linux
```
YourApp/resources/
├── node_modules/@ffmpeg-installer/linux-x64/ffmpeg
├── node_modules/@ffprobe-installer/linux-x64/ffprobe
├── utilities/bin/yt-dlp_linux
└── python/bin/python3
```

## Build Process

### Building for Distribution

The build process includes these steps:

1. **Build shared module** (`npm run build:shared`):
   - Compiles `shared/binary-paths.ts` to `dist-electron/shared/binary-paths.js`

2. **Download yt-dlp** (`npm run download:ytdlp`):
   - Downloads latest yt-dlp binaries to `utilities/bin/`

3. **Package Python** (`npm run package:python:mac-arm64`):
   - Creates standalone Python environment in `dist-python/python-arm64/`

4. **Build all code** (`npm run build:all`):
   - Builds shared, backend, frontend, electron, and preload modules

5. **Run electron-builder**:
   - Packages everything into distributable format

### Full Build Commands

```bash
# macOS ARM64
npm run package:mac-arm64

# macOS x64
npm run package:mac-x64

# Windows x64
npm run package:win-x64

# Windows ARM64
npm run package:win-arm64

# Linux
npm run package:linux
```

## Code Integration

### Services Using Centralized Resolver

The following services now use the centralized binary path resolver:

1. **SharedConfigService** (`backend/src/config/shared-config.service.ts`):
   - Uses centralized resolver as fallback when no user config is set

2. **ExecutablesUtil** (`electron/utilities/executables.ts`):
   - Uses centralized resolver for auto-detection

3. **YtDlpManager** (`backend/src/downloader/yt-dlp-manager.ts`):
   - Uses centralized resolver as fallback

4. **FfmpegService** (`backend/src/ffmpeg/ffmpeg.service.ts`):
   - Uses SharedConfigService (which uses centralized resolver)

### Import Pattern

Since the backend TypeScript compiler has a different `rootDir`, we use `require()` instead of `import`:

```typescript
// In backend services
const { getBinariesConfig } = require('../../../dist-electron/shared/binary-paths');

// In electron services
import { getBinariesConfig } from '../../dist-electron/shared/binary-paths';
```

## Troubleshooting

### Binary Not Found Errors

If you encounter "binary not found" errors:

1. **Development**: Ensure npm packages are installed:
   ```bash
   npm install
   ```

2. **Production**: Verify `extraResources` are being copied:
   - Check `dist-electron/mac/YourApp.app/Contents/Resources/` (macOS)
   - Check `dist-electron/win-unpacked/resources/` (Windows)

3. **Check the logs**: The centralized resolver logs which binaries it finds and where:
   ```
   [Binary Resolver] FFmpeg: /path/to/ffmpeg (bundled)
   [Binary Resolver] FFprobe: /path/to/ffprobe (npm-package)
   [Binary Resolver] yt-dlp: /path/to/yt-dlp (bundled)
   ```

### Debugging Path Resolution

To debug path resolution, check the logs for:
- `Using centralized binary path resolver`
- Binary paths and their sources (`bundled`, `npm-package`, `environment`, etc.)

## Best Practices

1. **Always use the centralized resolver**: Don't hardcode binary paths
2. **Test in production mode**: Run `npm run electron:test-packaged` before packaging
3. **Keep binaries updated**: Run `npm run download:ytdlp` regularly
4. **Test on all target platforms**: Build and test on macOS, Windows, and Linux

## Related Files

- `shared/binary-paths.ts` - Centralized binary path resolver
- `shared/python-config.ts` - Python-specific configuration
- `package.json` - Build configuration
- `scripts/download-ytdlp.js` - yt-dlp download script
- `scripts/package-python-mac.js` - Python packaging for macOS
- `scripts/package-python-windows.js` - Python packaging for Windows
