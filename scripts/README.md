# Build Scripts

This directory contains scripts for packaging and building ClipChimp.

## Binary Management

ClipChimp bundles native binaries - no Python required!

### Bundled Binaries

| Binary | Purpose | Source |
|--------|---------|--------|
| **whisper.cpp** | Audio transcription | Native C++ (Metal GPU on Mac) |
| **yt-dlp** | Video downloading | Standalone executable |
| **ffmpeg** | Media processing | @ffmpeg-installer package |
| **ffprobe** | Media analysis | @ffprobe-installer package |

### Download Scripts

**Download all binaries:**
```bash
npm run download:binaries
```

This runs `download-all-binaries.js` which downloads:
1. yt-dlp for all platforms
2. whisper.cpp with models

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
- `download-whisper-cpp.js` - Downloads whisper.cpp and models
- `package-backend-prod.js` - Packages backend for production
- `dev-test-bundled.js` - Development testing with bundled binaries

### Architecture

ClipChimp uses native binaries exclusively:
- **Transcription**: whisper.cpp (C++ with Metal GPU acceleration on Mac)
- **AI Analysis**: HTTP calls to Ollama/OpenAI/Claude (no local ML)
- **Video Processing**: ffmpeg/ffprobe
- **Downloading**: yt-dlp standalone binary

No Python, PyTorch, or other heavy dependencies are required.
