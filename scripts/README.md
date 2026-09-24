# Build Scripts

This directory contains scripts for packaging and building Briefcase.

## Binary Management

Briefcase bundles native binaries - no Python required!

### Bundled Binaries

| Binary | Purpose | Source |
|--------|---------|--------|
| **yt-dlp** | Video downloading | Standalone executable |
| **ffmpeg** | Media processing | @ffmpeg-installer package |
| **ffprobe** | Media analysis | @ffprobe-installer package |

### Download Scripts

**Download all binaries:**
```bash
npm run download:binaries
```

This runs `download-all-binaries.js` which downloads yt-dlp for all platforms.
AI (transcription, analysis) is not bundled: it runs on Crucible, which
installs its own engines and models.

**The download is automatically run before each packaging command:**
```bash
npm run package:mac-arm64   # Downloads binaries, then packages
npm run package:mac-x64     # Downloads binaries, then packages
npm run package:win-x64     # Downloads binaries, then packages
npm run package:linux       # Downloads binaries, then packages
```

### Files

- `download-all-binaries.js` - Master script that downloads all binaries
- `download-ytdlp.js` - Downloads yt-dlp for all platforms
- `package-backend-prod.js` - Packages backend for production
- `dev-test-bundled.js` - Development testing with bundled binaries

### Architecture

Briefcase uses native binaries exclusively:
- **Transcription and AI Analysis**: Crucible (a separate local or LAN server), over its HTTP API
- **Video Processing**: ffmpeg/ffprobe
- **Downloading**: yt-dlp standalone binary

No Python, PyTorch, or other heavy dependencies are required.
