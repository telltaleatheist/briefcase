# Binary Files Directory

This directory contains platform-specific binary executables that are bundled with the application.

## Binaries

### yt-dlp
- **macOS**: `yt-dlp_macos`
- **Linux**: `yt-dlp_linux`
- **Windows**: `yt-dlp.exe`

Downloaded automatically via `npm run download:ytdlp`

### Whisper
- **All Platforms**: `whisper` (Python script from openai-whisper package)

Automatically detected and cached via `npm run download:whisper`

## Automatic Download

All binaries are downloaded/cached automatically during the build process. The build scripts check a cache directory first (`.build-cache/`) before downloading to avoid re-downloading on every build.

### Download Scripts

```bash
# Download yt-dlp binaries
npm run download:ytdlp

# Setup whisper binary (finds system installation)
npm run download:whisper

# Download/setup all binaries
npm run download:binaries
```

## Setup Instructions

### Whisper
Whisper is installed via pip and automatically detected by the build script:

```bash
# Install whisper (one-time setup)
pip install openai-whisper

# The download script will automatically find and cache it
npm run download:whisper
```

The script:
1. Searches for whisper on your system (`which whisper`)
2. Copies it to `.build-cache/whisper/` (one-time)
3. Reuses the cached copy for all future builds

**That's it!** Once whisper is installed via pip, the build script handles everything automatically.

### yt-dlp
Downloaded automatically from GitHub releases. No manual setup needed.

## Cache Directory

Binaries are cached in `.build-cache/` to avoid re-downloading:
- `.build-cache/whisper/` - Whisper binary
- `.build-cache/yt-dlp/` - yt-dlp binaries (future)

The cache persists across builds and is not deleted by `npm run clean` commands.

## Notes

- All binaries in this directory are ignored by git (see `.gitignore`)
- Backup copies with `.backup.*` suffix are created during updates
- The download scripts automatically verify file integrity after download
- ffmpeg/ffprobe are handled via npm packages (`@ffmpeg-installer`, `@ffprobe-installer`)
