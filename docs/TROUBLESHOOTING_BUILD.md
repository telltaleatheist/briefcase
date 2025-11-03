# Build Troubleshooting Guide

## Common Build Issues

### "Cannot find Clippy.exe" Error

#### Scenario 1: Building on Mac for Windows

**Problem:** You build with `npm run package:win` on Mac, but there's no `.exe` file created.

**Diagnosis:**
```bash
# Check if Windows build was created
ls -la dist-electron/*.exe

# Check build logs
cat dist-electron/builder-debug.yml
```

**Common Causes:**

1. **electron-builder not installed for Windows**
   ```bash
   # Fix: Reinstall electron-builder
   npm install electron-builder --save-dev
   ```

2. **Wine not available (not actually needed, but error is confusing)**
   - electron-builder can build Windows on Mac without Wine
   - Error message is misleading - usually means build config issue

3. **dist-electron not built before packaging**
   ```bash
   # Fix: Ensure build happens
   npm run build:all
   npm run package:win
   ```

4. **Missing package.json in app**
   - The installer needs `package.json` at the root
   - Verify it exists: `ls -la package.json`

**Solution:**
```bash
# Complete rebuild
npm run clean:all
npm install
npm run build:all
npm run package:win

# Check output
ls -la dist-electron/*.exe
```

#### Scenario 2: Running .exe on Mac

**Problem:** Double-clicking `.exe` file on Mac shows error.

**Why:**
- `.exe` files are Windows executables
- They won't run on Mac even if opened
- Mac may try to extract or inspect them, showing confusing errors

**Solution:**
- Transfer `.exe` to Windows PC
- Or use a Windows VM to test
- Or use Wine (not recommended for testing installers)

#### Scenario 3: Installer runs but app won't start

**Problem:** Windows installer completes, but app shows "Cannot find Clippy.exe" when launching.

**Common Causes:**

1. **Antivirus blocking the exe**
   - Windows Defender may quarantine unsigned apps
   - Check: Windows Security → Virus & threat protection → Protection history

2. **Installation path has special characters**
   - Some paths cause issues: `C:\Program Files\Clippy` (space in path)
   - Try installing to: `C:\Clippy` instead

3. **Missing runtime dependencies**
   - Windows needs Visual C++ Redistributable
   - electron-builder usually bundles this, but check:
   - Download from: https://aka.ms/vs/17/release/vc_redist.x64.exe

**Solution:**
```bash
# On Windows, check if exe exists after install
dir "C:\Program Files\Clippy\Clippy.exe"
# Or
dir "%LOCALAPPDATA%\Programs\Clippy\Clippy.exe"

# Check Windows Event Viewer for errors
# Windows Key + X → Event Viewer → Application logs
```

#### Scenario 4: Build succeeds but installer is corrupt

**Problem:** Build creates `.exe` but it won't run on Windows.

**Diagnosis:**
```bash
# Check file size (should be 50-150 MB)
ls -lh dist-electron/*.exe

# If it's tiny (< 1 MB), build failed
```

**Common Causes:**

1. **Ran out of disk space during build**
   ```bash
   df -h  # Check free space (need 10+ GB)
   ```

2. **Build interrupted**
   - Don't stop builds mid-way
   - Let electron-builder finish completely

3. **ASAR packaging failed**
   ```bash
   # Check if asar file was created
   ls -la dist-electron/mac*/Clippy.app/Contents/Resources/app.asar
   ```

**Solution:**
```bash
# Clean and rebuild
npm run clean:all
npm run package:win
```

### Build Process Verification

#### Step 1: Verify Source Build

```bash
# Build TypeScript sources
npm run build:all

# Verify outputs exist
ls -la dist-electron/main/electron/main.js     # Should exist
ls -la dist-electron/preload/preload.js        # Should exist
ls -la backend/dist/main.js                    # Should exist
ls -la frontend/dist/clippy-frontend/index.html # Should exist
```

If any of these don't exist, fix that build first.

#### Step 2: Verify Package.json

```bash
# Check main entry point
cat package.json | grep "main"
# Should show: "main": "./dist-electron/main/electron/main.js"

# Check build config exists
cat package.json | grep -A 5 '"build"'
```

#### Step 3: Run Build with Verbose Logging

```bash
# Enable debug output
DEBUG=electron-builder npm run package:win

# This will show detailed logs about what's being packaged
```

#### Step 4: Verify Build Output

After successful build:

```bash
# Windows
ls -lh dist-electron/*Setup*.exe              # Installer
ls -lh dist-electron/*Setup*.exe.blockmap     # Blockmap
ls -lh dist-electron/latest.yml               # Metadata

# macOS
ls -lh dist-electron/*.dmg                    # Installer
ls -lh dist-electron/*.dmg.blockmap           # Blockmap
ls -lh dist-electron/latest-mac.yml           # Metadata
```

### Platform-Specific Issues

#### Windows-Specific

**Code Signing (optional but recommended):**
```bash
# If you have a code signing certificate
export WIN_CSC_LINK=/path/to/cert.pfx
export WIN_CSC_KEY_PASSWORD=password
npm run package:win
```

**Without signing:**
- Windows will show "Unknown Publisher" warning
- Users need to click "More info" → "Run anyway"
- This is normal for unsigned apps

**NSIS Installer Options:**
Add to `package.json`:
```json
{
  "build": {
    "win": {
      "target": ["nsis"],
      "icon": "assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

#### macOS-Specific

**Code Signing (required for distribution):**
```bash
export CSC_LINK=/path/to/cert.p12
export CSC_KEY_PASSWORD=password
npm run package:mac
```

**Notarization (required for macOS 10.15+):**
```bash
export APPLE_ID=your@email.com
export APPLE_ID_PASSWORD=app-specific-password
export APPLE_TEAM_ID=TEAM_ID
npm run package:mac
```

**Without signing:**
- Mac will block app: "App is damaged"
- Users need to right-click → Open (once)
- Or disable Gatekeeper (not recommended)

#### Linux-Specific

**AppImage (recommended):**
- Works on most distros
- No installation needed
- Portable

**DEB Package:**
- For Debian/Ubuntu
- Integrates with system package manager
- Requires `dpkg` to install

### Testing Builds

#### Test on Clean Virtual Machine

**Windows:**
1. Get Windows 10/11 VM from Microsoft (free for testing)
2. Don't install anything extra
3. Test your installer from scratch

**macOS:**
1. Use macOS in a VM (if legally allowed)
2. Or test on friend's Mac
3. Don't use your development Mac

**Linux:**
1. Use VirtualBox with Ubuntu
2. Fresh install, no dev tools
3. Test AppImage and DEB

#### Automated Testing

Create a test script:

```bash
#!/bin/bash
# test-build.sh

echo "Building all platforms..."
npm run package:win &
PID_WIN=$!

npm run package:mac &
PID_MAC=$!

npm run package:linux &
PID_LINUX=$!

# Wait for all builds
wait $PID_WIN
wait $PID_MAC
wait $PID_LINUX

echo "Verifying builds..."

# Check Windows
if [ -f "dist-electron/*Setup*.exe" ]; then
  echo "✓ Windows build OK"
  ls -lh dist-electron/*Setup*.exe
else
  echo "✗ Windows build FAILED"
fi

# Check macOS
if [ -f "dist-electron/*.dmg" ]; then
  echo "✓ macOS build OK"
  ls -lh dist-electron/*.dmg
else
  echo "✗ macOS build FAILED"
fi

# Check Linux
if [ -f "dist-electron/*.AppImage" ]; then
  echo "✓ Linux build OK"
  ls -lh dist-electron/*.AppImage
else
  echo "✗ Linux build FAILED"
fi
```

### Common Error Messages

#### "Application entry file 'main.js' does not exist"

**Fix:**
```bash
# Rebuild electron main process
npm run build:electron
npm run build:preload

# Verify files exist
ls -la dist-electron/main/electron/main.js
```

#### "ENOENT: no such file or directory, stat 'dist-electron'"

**Fix:**
```bash
# dist-electron doesn't exist
npm run build:all  # Creates dist-electron
```

#### "Cannot find module '@nestjs/core'"

**Fix:**
```bash
# Backend dependencies missing
cd backend
npm install
cd ..
npm run build:backend
```

#### "Cannot find module '@angular/core'"

**Fix:**
```bash
# Frontend dependencies missing
cd frontend
npm install
cd ..
npm run build:frontend
```

### Build Output Structure

After successful build, you should see:

```
project-root/
├── dist-electron/
│   ├── main/                    # Compiled electron main process
│   │   └── electron/
│   │       ├── main.js          # Entry point (must exist!)
│   │       ├── services/
│   │       └── utilities/
│   ├── preload/                 # Compiled preload script
│   │   └── preload.js
│   ├── win-unpacked/            # Unpacked Windows build (temp)
│   ├── *Setup*.exe              # Windows installer
│   ├── *Setup*.exe.blockmap
│   ├── latest.yml
│   ├── mac/                     # macOS build (temp)
│   ├── *.dmg                    # macOS installer
│   ├── *.dmg.blockmap
│   └── latest-mac.yml
├── backend/
│   └── dist/                    # Compiled NestJS backend
│       └── main.js
└── frontend/
    └── dist/
        └── clippy-frontend/     # Compiled Angular frontend
            └── index.html
```

### Emergency "Nuclear" Fix

If nothing else works:

```bash
# 1. Clean EVERYTHING
npm run clean:all
rm -rf node_modules
rm -rf frontend/node_modules
rm -rf backend/node_modules
rm package-lock.json

# 2. Fresh install
npm install
cd frontend && npm install && cd ..
cd backend && npm install && cd ..

# 3. Build from scratch
npm run build:all

# 4. Package
npm run package:win

# 5. Test
ls -lh dist-electron/*.exe
```

### Getting Help

If you're still stuck:

1. **Check logs:**
   ```bash
   cat dist-electron/builder-debug.yml
   DEBUG=electron-builder npm run package:win 2>&1 | tee build.log
   ```

2. **Check file sizes:**
   ```bash
   du -sh dist-electron/main
   du -sh backend/dist
   du -sh frontend/dist
   ```

3. **Verify all dependencies:**
   ```bash
   npm list electron-builder
   npm list electron
   ```

4. **Check Node version:**
   ```bash
   node --version  # Should be 18+
   npm --version
   ```

5. **Create minimal reproduction:**
   - Create a new Electron app
   - Build it successfully
   - Compare configs

### Useful Commands

```bash
# Quick health check
npm run build:all && ls -la dist-electron/main/electron/main.js

# Build with timing
time npm run package:win

# Build size analysis
du -sh dist-electron/*

# Check what's in the ASAR
npx asar list dist-electron/mac/Clippy.app/Contents/Resources/app.asar | head -50
```

---

## Still Getting "Cannot find Clippy.exe"?

Please provide:
1. Exact error message (screenshot or copy/paste)
2. Where error occurs (during build? during install? when launching app?)
3. Operating system (Mac building? Windows running?)
4. Output of:
   ```bash
   ls -la dist-electron/*.exe
   npm run build:all 2>&1 | tail -20
   ```

This will help diagnose the specific issue!
