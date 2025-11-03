# Multi-Platform Build Guide

## Building for Multiple Platforms

You can now build for all platforms without builds overwriting each other!

## Quick Commands

```bash
# Build Windows installer (doesn't delete Mac/Linux builds)
npm run package:win

# Build macOS installer (doesn't delete Windows/Linux builds)
npm run package:mac

# Build Linux installer (doesn't delete Windows/Mac builds)
npm run package:linux

# Build all platforms at once
npm run package:win && npm run package:mac && npm run package:linux
```

## Platform-Specific Cleaning

Each platform now has its own clean script:

### Windows Clean
```bash
npm run clean:win
```
**Removes:**
- `dist-electron/win-unpacked/`
- `dist-electron/*Setup*.exe`
- `dist-electron/*Setup*.exe.blockmap`
- `dist-electron/latest.yml`

**Keeps:**
- Mac builds (`.dmg`, `latest-mac.yml`)
- Linux builds (`.AppImage`, `latest-linux.yml`)

### macOS Clean
```bash
npm run clean:mac
```
**Removes:**
- `dist-electron/mac/`
- `dist-electron/mac-arm64/`
- `dist-electron/*.dmg`
- `dist-electron/*.dmg.blockmap`
- `dist-electron/latest-mac.yml`
- Root-level `mac-arm64*/` and `*.dmg*` files

**Keeps:**
- Windows builds (`.exe`, `latest.yml`)
- Linux builds (`.AppImage`, `latest-linux.yml`)

### Linux Clean
```bash
npm run clean:linux
```
**Removes:**
- `dist-electron/linux-unpacked/`
- `dist-electron/*.AppImage`
- `dist-electron/*.AppImage.blockmap`
- `dist-electron/*.deb`
- `dist-electron/latest-linux.yml`

**Keeps:**
- Windows builds (`.exe`, `latest.yml`)
- Mac builds (`.dmg`, `latest-mac.yml`)

### Clean All Platforms
```bash
npm run clean:all
```
**Removes:**
- All platform builds
- Frontend builds (`frontend/dist`)
- Backend builds (`backend/dist`)

Use this when you want a completely fresh start.

## Typical Workflow

### Building Release for All Platforms

```bash
# Step 1: Bump version
npm version patch  # or minor, or major

# Step 2: Build Windows
npm run package:win
# ✓ Creates: Clippy Setup 1.0.1.exe + blockmap

# Step 3: Build macOS (ARM)
npm run package:mac
# ✓ Creates: Clippy-1.0.1-arm64.dmg + blockmap
# ✓ Windows files still there!

# Step 4: Build macOS (Intel)
npm run package:mac-intel
# ✓ Creates: Clippy-1.0.1.dmg + blockmap
# ✓ Windows and ARM files still there!

# Step 5: Build Linux
npm run package:linux
# ✓ Creates: Clippy-1.0.1.AppImage + blockmap
# ✓ All other platform files still there!

# Step 6: Check what you have
ls -lh dist-electron/
```

### Expected Output

After building all platforms, your `dist-electron/` should contain:

```
dist-electron/
├── win-unpacked/                    # Windows build files
├── Clippy Setup 1.0.1.exe           # Windows installer (150 MB)
├── Clippy Setup 1.0.1.exe.blockmap  # Windows blockmap (100 KB)
├── latest.yml                       # Windows update metadata
├── mac/                             # macOS Intel build files
├── mac-arm64/                       # macOS ARM build files
├── Clippy-1.0.1.dmg                 # macOS Intel installer (145 MB)
├── Clippy-1.0.1.dmg.blockmap        # macOS Intel blockmap
├── Clippy-1.0.1-arm64.dmg           # macOS ARM installer (140 MB)
├── Clippy-1.0.1-arm64.dmg.blockmap  # macOS ARM blockmap
├── latest-mac.yml                   # macOS update metadata
├── linux-unpacked/                  # Linux build files
├── Clippy-1.0.1.AppImage            # Linux AppImage (155 MB)
├── Clippy-1.0.1.AppImage.blockmap   # Linux blockmap
├── Clippy-1.0.1.deb                 # Debian package (optional)
└── latest-linux.yml                 # Linux update metadata
```

**Total size:** ~700-800 MB for all platforms combined

## Rebuilding a Single Platform

If you need to rebuild just one platform (e.g., fixing a Windows-specific bug):

```bash
# Rebuild only Windows
npm run package:win

# This will:
# 1. Clean only Windows files (clean:win)
# 2. Rebuild backend/frontend/electron
# 3. Package for Windows
# 4. Keep Mac and Linux builds intact
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build Multi-Platform

on:
  push:
    tags:
      - 'v*'

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run package:win
      - uses: actions/upload-artifact@v3
        with:
          name: windows-build
          path: dist-electron/*.exe*

  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run package:mac
      - uses: actions/upload-artifact@v3
        with:
          name: macos-build
          path: dist-electron/*.dmg*

  build-linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci
      - run: npm run package:linux
      - uses: actions/upload-artifact@v3
        with:
          name: linux-build
          path: dist-electron/*.AppImage*

  create-release:
    needs: [build-windows, build-macos, build-linux]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v3
      - uses: softprops/action-gh-release@v1
        with:
          files: |
            windows-build/*
            macos-build/*
            linux-build/*
```

## Common File Patterns

### Windows Files
```
*Setup*.exe              # NSIS installer
*Setup*.exe.blockmap     # Update blockmap
latest.yml               # Update metadata
win-unpacked/            # Unpacked build directory
```

### macOS Files
```
*.dmg                    # DMG installer
*-arm64.dmg              # ARM-specific DMG
*.dmg.blockmap           # Update blockmap
latest-mac.yml           # Update metadata
mac/                     # Intel build directory
mac-arm64/               # ARM build directory
```

### Linux Files
```
*.AppImage               # AppImage installer
*.AppImage.blockmap      # Update blockmap
*.deb                    # Debian package (optional)
latest-linux.yml         # Update metadata
linux-unpacked/          # Unpacked build directory
```

## Troubleshooting

### Problem: Old files remain after rebuild

**Symptom:** You rebuilt Windows but see two `.exe` files with different versions

**Solution:**
```bash
# Clean just that platform
npm run clean:win

# Or clean everything
npm run clean:all

# Then rebuild
npm run package:win
```

### Problem: electron-builder overwrites previous builds

**Symptom:** Building Mac after Windows causes Windows files to disappear

**Cause:** Using old scripts that don't have platform-specific cleaning

**Solution:** Make sure you're using the updated package.json with `clean:win`, `clean:mac`, `clean:linux`

### Problem: Disk space running low

**Check size:**
```bash
du -sh dist-electron
```

**Clean old builds:**
```bash
# Remove all builds (keeps source code)
npm run clean

# Or remove everything including compiled source
npm run clean:all
```

## Advanced: Parallel Builds

If you have a powerful machine, you can build multiple platforms in parallel:

```bash
# Using npm-run-all (install first: npm i -g npm-run-all)
npm-run-all --parallel package:win package:mac package:linux

# Or with regular bash
npm run package:win & npm run package:mac & npm run package:linux & wait
```

**Warning:** This uses a lot of CPU and memory! Make sure you have:
- 16+ GB RAM
- 8+ CPU cores
- 50+ GB free disk space

## File Organization Tips

### Option 1: Keep all builds together (default)
```
dist-electron/
├── [Windows files]
├── [macOS files]
└── [Linux files]
```

**Pros:** Simple, all in one place
**Cons:** Large directory size

### Option 2: Separate by platform (manual organization)
```bash
# After building, organize into subdirectories
mkdir -p dist-electron/platforms/{windows,macos,linux}

# Move files
mv dist-electron/*Setup*.exe* dist-electron/platforms/windows/
mv dist-electron/*.dmg* dist-electron/platforms/macos/
mv dist-electron/*.AppImage* dist-electron/platforms/linux/
```

**Pros:** Clean organization
**Cons:** Manual work, breaks electron-builder expectations

## Summary

### Key Changes Made
- ✅ `package:win` now uses `clean:win` (only removes Windows files)
- ✅ `package:mac` now uses `clean:mac` (only removes macOS files)
- ✅ `package:linux` now uses `clean:linux` (only removes Linux files)
- ✅ `clean` still removes everything if needed
- ✅ `clean:all` removes builds + source builds

### What This Means
- ✅ Build Windows, then Mac, then Linux - all files coexist
- ✅ Rebuild one platform without affecting others
- ✅ Upload all platforms to single GitHub release
- ✅ Delta updates work correctly for each platform
- ✅ No more accidental deletions!

### Quick Reference
```bash
# Build all platforms (one at a time)
npm run package:win
npm run package:mac
npm run package:linux

# Clean specific platform
npm run clean:win      # Only Windows
npm run clean:mac      # Only macOS
npm run clean:linux    # Only Linux

# Clean everything
npm run clean:all      # Nuclear option
```

---

**Now you can build for all platforms without losing previous builds!** 🎉
