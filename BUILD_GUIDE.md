# Clippy Professional Build Guide

This guide explains how to build Clippy with bundled Python, FFmpeg, FFprobe, and yt-dlp for professional distribution.

## Overview

Clippy bundles everything users need to run the app:
- **Python 3.12** runtime with all dependencies (numpy, torch, whisper, etc.)
- **FFmpeg & FFprobe** for video processing
- **yt-dlp** for downloading videos
- **Whisper base model** pre-downloaded to avoid first-run delays

This ensures a "just works" experience - users install once and everything is ready.

## Prerequisites

### macOS Builds
- **Python 3.12 or 3.11** installed via Homebrew:
  ```bash
  brew install python@3.12
  ```
  or
  ```bash
  brew install python@3.11
  ```
- **Node.js** and npm
- **Xcode Command Line Tools**

### Windows Builds
- **Node.js** and npm
- **Internet connection** (to download Python embeddable package)
- Run builds on Windows or use a Windows VM

### Code Signing (Optional but Recommended)
- **macOS**: Apple Developer account and signing certificate
- **Windows**: Code signing certificate from a trusted CA

## Build Commands

### macOS Apple Silicon (M1/M2/M3)
```bash
npm run package:mac-arm64
```
This will:
1. Build all TypeScript code
2. Create Python arm64 environment with dependencies
3. Download Whisper model
4. Bundle everything into a DMG installer

Output: `dist-electron/Clippy-{version}-arm64.dmg`

### macOS Intel (x64)
```bash
npm run package:mac-x64
```
Output: `dist-electron/Clippy-{version}-x64.dmg`

### Windows x64
```bash
npm run package:win-x64
```
This will:
1. Build all TypeScript code
2. Download Python embeddable package
3. Install dependencies via pip
4. Download Whisper model
5. Bundle everything into an NSIS installer

Output: `dist-electron/Clippy Setup {version}.exe`

### Windows ARM64
```bash
npm run package:win-arm64
```
Output: `dist-electron/Clippy Setup {version}.exe` (ARM64)

## Manual Python Packaging (Advanced)

If you need to create Python packages separately:

### macOS
```bash
# Apple Silicon
node scripts/package-python-mac.js arm64

# Intel
node scripts/package-python-mac.js x64
```

### Windows
```bash
# x64
node scripts/package-python-windows.js x64

# ARM64
node scripts/package-python-windows.js arm64
```

Python packages are created in `dist-python/python-{arch}/`

## Architecture-Specific Details

### macOS Package Structure
```
Clippy.app/
├── Contents/
│   ├── MacOS/
│   │   └── Clippy (Electron binary)
│   ├── Resources/
│   │   ├── python/              # Bundled Python venv
│   │   │   ├── bin/
│   │   │   │   ├── python3
│   │   │   │   └── pip
│   │   │   ├── lib/
│   │   │   │   └── python3.12/
│   │   │   │       └── site-packages/  # numpy, torch, whisper, etc.
│   │   │   └── cache/
│   │   │       └── whisper/            # Pre-downloaded model
│   │   ├── utilities/bin/
│   │   │   └── yt-dlp_macos
│   │   └── node_modules/
│   │       ├── @ffmpeg-installer/
│   │       └── @ffprobe-installer/
│   └── Info.plist
```

### Windows Package Structure
```
Clippy/
├── Clippy.exe (Electron binary)
├── resources/
│   ├── python/                  # Bundled Python embeddable
│   │   ├── python.exe
│   │   ├── python312.dll
│   │   ├── Lib/
│   │   │   └── site-packages/  # numpy, torch, whisper, etc.
│   │   └── cache/
│   │       └── whisper/        # Pre-downloaded model
│   ├── utilities/bin/
│   │   └── yt-dlp.exe
│   └── node_modules/
│       ├── @ffmpeg-installer/
│       └── @ffprobe-installer/
```

## Package Sizes

Approximate sizes after bundling:

| Platform | Architecture | Size |
|----------|--------------|------|
| macOS    | Apple Silicon | ~1.5 GB |
| macOS    | Intel (x64)   | ~1.5 GB |
| Windows  | x64           | ~1.2 GB |
| Windows  | ARM64         | ~1.2 GB |

The large size is primarily due to PyTorch and the Whisper model, which are necessary for AI transcription features.

## Code Signing

### macOS Code Signing

1. **Get your signing identity**:
   ```bash
   security find-identity -v -p codesigning
   ```

2. **Update package.json** with your identity:
   ```json
   "mac": {
     "identity": "Developer ID Application: Your Name (TEAMID)"
   }
   ```

3. **Build and sign**:
   ```bash
   npm run package:mac-arm64
   ```

4. **Notarize with Apple** (required for distribution):
   ```bash
   xcrun notarytool submit dist-electron/Clippy-{version}-arm64.dmg \
     --apple-id your@email.com \
     --team-id TEAMID \
     --password app-specific-password
   ```

### Windows Code Signing

1. **Install your certificate** in the Windows Certificate Store

2. **Update package.json**:
   ```json
   "win": {
     "certificateFile": "path/to/cert.pfx",
     "certificatePassword": "password"
   }
   ```

3. **Build and sign**:
   ```bash
   npm run package:win-x64
   ```

## Troubleshooting

### Python packaging fails on macOS
- Ensure Python 3.12 or 3.11 is installed: `brew install python@3.12`
- Check Python version: `python3.12 --version`
- Try cleaning: `rm -rf dist-python` and rebuild

### Python packaging fails on Windows
- Ensure internet connection is active
- Check disk space (need ~2 GB free)
- Try cleaning: `rmdir /s dist-python` and rebuild

### "Python not found" error in packaged app
- Verify `dist-python/python-{arch}` exists before building
- Check that `extraResources` in package.json points to correct Python directory
- Ensure Python was packaged for the correct architecture

### Whisper model not bundled
- This is non-critical - model will download on first use
- Check internet connection during Python packaging
- Model is cached in `python/cache/whisper/`

### FFmpeg/FFprobe not found
- These are bundled via npm packages: `@ffmpeg-installer` and `@ffprobe-installer`
- Run `npm install` to ensure they're present
- Check `node_modules/@ffmpeg-installer` and `node_modules/@ffprobe-installer`

## Distribution Checklist

Before distributing to users:

- [ ] Test on fresh machine (without Python/FFmpeg installed)
- [ ] Verify video download works
- [ ] Verify transcription works (with Whisper)
- [ ] Verify AI analysis works (with Ollama or API key)
- [ ] Test on both architectures (if distributing for both)
- [ ] Code sign the app
- [ ] (macOS only) Notarize with Apple
- [ ] Test installer on clean system
- [ ] Document system requirements in README

## CI/CD Integration

For automated builds, create separate CI jobs for each platform/architecture:

```yaml
# Example GitHub Actions
jobs:
  build-mac-arm64:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - run: brew install python@3.12
      - run: npm install
      - run: npm run package:mac-arm64

  build-mac-x64:
    runs-on: macos-13  # Intel runner
    steps:
      - uses: actions/checkout@v3
      - run: brew install python@3.12
      - run: npm install
      - run: npm run package:mac-x64

  build-win-x64:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm install
      - run: npm run package:win-x64
```

## Support

For build issues, check:
1. This guide
2. GitHub Issues: https://github.com/yourusername/clippy/issues
3. Electron Builder docs: https://www.electron.build/

## License

This build system and documentation is part of Clippy.
See LICENSE file for details.
