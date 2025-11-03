# Quick Start: Building for Windows

## TL;DR - Build & Release

```bash
# 1. Build Windows installer (from Mac)
npm run package:win

# 2. Files created in dist-electron/
# - Clippy Setup X.X.X.exe
# - Clippy Setup X.X.X.exe.blockmap
# - latest.yml

# 3. Create GitHub Release
# Upload all 3 files above

# 4. Done! Users download the .exe
```

## What Happens When User Installs

```
User downloads → Installs → Launches Clippy
                    ↓
         First run checks dependencies
                    ↓
         Missing deps? → Setup wizard appears
                    ↓
         Downloads portable versions to:
         %APPDATA%/Clippy/dependencies/
                    ↓
         [Optional] AI features wizard
                    ↓
         App launches with everything ready
```

## Files & Sizes

### What You Build (on Mac)
- **Installer**: ~50-100 MB
- **Blockmap**: ~100 KB
- **Metadata**: ~1 KB

### What Gets Downloaded on User's PC (First Run)
- **FFmpeg**: ~70 MB
- **Python**: ~15 MB
- **yt-dlp**: ~10 MB
- **[Optional] Ollama**: ~500 MB
- **[Optional] AI Model**: ~2-5 GB

### Where Dependencies Install
```
%APPDATA%/Clippy/
├── dependencies/
│   ├── bin/
│   │   ├── ffmpeg.exe    (70 MB)
│   │   ├── ffprobe.exe   (included with ffmpeg)
│   │   └── yt-dlp.exe    (10 MB)
│   └── python/           (15 MB)
│       ├── python.exe
│       └── Lib/
├── logs/
│   └── main.log
└── config.json
```

System-wide (if AI enabled):
```
C:/Program Files/Ollama/
└── ollama.exe

%USERPROFILE%/.ollama/
└── models/
    └── qwen2.5-7b/      (4.7 GB)
```

## Build Commands Reference

```bash
# Windows
npm run package:win

# macOS
npm run package:mac

# Linux
npm run package:linux

# All platforms (if on Mac with proper setup)
npm run package

# Clean before building
npm run clean
npm run package:win
```

## Version Management

```bash
# Bump version
npm version patch   # 1.0.0 → 1.0.1
npm version minor   # 1.0.1 → 1.1.0
npm version major   # 1.1.0 → 2.0.0

# Build with new version
npm run package:win

# Create git tag
git push origin v1.0.1
```

## GitHub Release Checklist

When creating a release:

- [ ] Version bumped in package.json
- [ ] Code committed and pushed
- [ ] Git tag created (`v1.0.1`)
- [ ] Built for Windows: `npm run package:win`
- [ ] Created GitHub Release
- [ ] Uploaded `Clippy Setup X.X.X.exe`
- [ ] Uploaded `Clippy Setup X.X.X.exe.blockmap`
- [ ] Uploaded `latest.yml`
- [ ] Release published (not draft)
- [ ] Tested download link works

## Testing Checklist

### Before Release

- [ ] Build succeeds without errors
- [ ] Installer runs on clean Windows VM
- [ ] Dependencies auto-install correctly
- [ ] FFmpeg works (download & process video)
- [ ] yt-dlp works (download from YouTube)
- [ ] App launches after setup
- [ ] Logs appear in correct location
- [ ] App can be uninstalled cleanly

### Optional (AI Features)

- [ ] Ollama installs correctly
- [ ] AI wizard shows up
- [ ] Model downloads successfully
- [ ] AI analysis works
- [ ] Can skip AI setup

### Updates

- [ ] Update notification appears
- [ ] Update downloads (delta, not full)
- [ ] App restarts and update applies
- [ ] Version number updated in about dialog

## Common Issues

### Build fails on Mac

**Error:** "Cannot find module 'wine'"

**Solution:** Windows builds from Mac work without Wine (electron-builder handles it)

---

### Installer won't run on Windows

**Error:** "Windows protected your PC"

**Solution:** Click "More info" → "Run anyway" (or code sign your app)

---

### Dependencies won't download

**Error:** "Download failed"

**Solutions:**
- Check internet connection
- Check firewall settings
- Try "Manual Installation" option in setup wizard

---

### Ollama installation fails

**Error:** Package manager not found

**Solutions:**
- Install Chocolatey first:
  ```powershell
  Set-ExecutionPolicy Bypass -Scope Process -Force
  iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  ```
- Or download Ollama manually from ollama.ai

---

### App says "Setup incomplete"

**Check:**
1. Look in `%APPDATA%/Clippy/logs/main.log`
2. Check `%APPDATA%/Clippy/dependencies/bin/`
3. Verify files exist:
   - ffmpeg.exe
   - ffprobe.exe
   - yt-dlp.exe

**Fix:** Delete dependencies folder and restart app to retry setup

## File Sizes Comparison

### Traditional Approach (Bundle Everything)
```
Installer: ~500 MB
├─ App code: 100 MB
├─ FFmpeg: 70 MB
├─ Python: 50 MB
├─ Node: 100 MB
├─ yt-dlp: 10 MB
└─ Dependencies: 170 MB
```

### Your New Approach (Smart Setup)
```
Installer: ~80 MB
├─ App code: 80 MB
└─ (Dependencies download on first run)

First Run Download: ~95 MB
├─ FFmpeg: 70 MB
├─ Python: 15 MB (embedded)
└─ yt-dlp: 10 MB

Total: 175 MB (vs 500 MB traditional)
```

**Benefits:**
- 65% smaller installer
- Faster initial download
- Always get latest tools
- Can update tools independently

## Development vs Production

### Development (Mac/Linux)
```bash
# Uses system dependencies
npm run electron:dev

# Expects these in PATH:
# - ffmpeg
# - ffprobe
# - yt-dlp
# - python
```

### Production (Windows)
```bash
# Build creates installer
npm run package:win

# First run downloads:
# - Portable FFmpeg
# - Portable Python
# - Portable yt-dlp
```

## Environment Variables Set

After setup completes, these are available to your app:

```typescript
process.env.FFMPEG_PATH    // C:/Users/.../Clippy/dependencies/bin/ffmpeg.exe
process.env.FFPROBE_PATH   // C:/Users/.../Clippy/dependencies/bin/ffprobe.exe
process.env.YT_DLP_PATH    // C:/Users/.../Clippy/dependencies/bin/yt-dlp.exe
process.env.PYTHON_PATH    // C:/Users/.../Clippy/dependencies/python/python.exe
process.env.PATH           // Updated with bin directory
```

Your backend automatically uses these via the existing code.

## Next Steps

1. **Test locally** - Build and transfer to Windows VM
2. **Create GitHub release** - Upload all generated files
3. **Get feedback** - Have beta users test installation
4. **Monitor logs** - Check for common issues
5. **Iterate** - Improve setup flow based on feedback

## Support Resources

- **User Logs**: `%APPDATA%/Clippy/logs/main.log`
- **Setup Guide**: [WINDOWS_SETUP_GUIDE.md](WINDOWS_SETUP_GUIDE.md)
- **Integration**: [SETUP_SYSTEM_INTEGRATION.md](SETUP_SYSTEM_INTEGRATION.md)
- **Updates**: [AUTO_UPDATES_GUIDE.md](AUTO_UPDATES_GUIDE.md)

## Summary

✅ Build from Mac: `npm run package:win`
✅ Upload 3 files to GitHub Release
✅ Users download and install
✅ Setup wizard handles dependencies
✅ App works with portable installations
✅ Updates use delta downloads (blockmap)

**That's it!** The system handles everything else automatically.
