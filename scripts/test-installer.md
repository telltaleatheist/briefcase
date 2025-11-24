# Test Windows Installer Without Rebuilding

## The Issue

"Windows is looking for clipchimp.exe" error when running the installer suggests the NSIS installer script can't find the app files.

## Quick Diagnosis (On Windows)

When you get the error dialog on Windows:

### 1. Check if installer extracted files

Open Command Prompt and run:
```cmd
dir "%TEMP%\nsis*" /s
```

This shows what the installer extracted. Look for `ClipChimp.exe`.

### 2. Check installation directory

If installation started:
```cmd
dir "%LOCALAPPDATA%\Programs\ClipChimp"
```

Or:
```cmd
dir "%ProgramFiles%\ClipChimp"
```

### 3. Check Windows Event Viewer

1. Windows Key + X → Event Viewer
2. Windows Logs → Application
3. Look for errors from "ClipChimp" or "NSIS"

### 4. Run installer with logging

```cmd
"ClipChimp Setup 1.0.0.exe" /S /D=C:\Test\ClipChimp
```

Then check:
```cmd
dir C:\Test\ClipChimp
type C:\Test\ClipChimp\install.log
```

## Common Causes

### Cause 1: Installer is corrupt

**Test:**
- Check file size: Should be ~150-200 MB
- If it's < 10 MB, download failed or build is incomplete

**Solution:**
- Re-download the installer
- Transfer via different method (USB instead of network)

### Cause 2: Antivirus blocking extraction

**Symptoms:**
- Installer starts but hangs
- Files briefly appear then disappear
- Windows Defender notification

**Solution:**
1. Open Windows Security
2. Virus & threat protection
3. Protection history
4. Look for recent quarantines
5. Restore if found
6. Add exclusion for ClipChimp Setup exe

### Cause 3: Insufficient permissions

**Symptoms:**
- "Access denied" in temp directory
- Can't write to installation folder

**Solution:**
- Run installer as Administrator
- Right-click → "Run as administrator"

### Cause 4: Path too long

**Symptoms:**
- Error mentions file paths
- Installation directory has very long name

**Solution:**
- Install to shorter path: `C:\ClipChimp` instead of `C:\Program Files\My Company\Applications\ClipChimp`

### Cause 5: NSIS can't find app.asar

**Symptoms:**
- Installer runs but says "can't find clipchimp.exe"
- This is the most likely cause for your issue

**Root Cause:**
The `main` entry in package.json doesn't match what electron-builder expects for Windows packaging.

**What's probably happening:**
1. electron-builder packages files into `app.asar`
2. NSIS tries to extract `app.asar`
3. The extracted structure doesn't have `ClipChimp.exe` in expected location
4. Installer fails

## The Real Fix (Without Rebuilding Yet)

Let me check your package.json main entry and build config...

Actually, I think I found the issue. Let me check one more thing about your tsconfig files.
