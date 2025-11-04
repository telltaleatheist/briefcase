# Python Bundling - Quick Checklist

## Pre-Build Verification

- [ ] `scripts/package-python-windows.js` exists
- [ ] `PYTHON_VERSION = '3.11.9'` in packaging script
- [ ] `backend/python/requirements.txt` has exact versions:
  - `numpy==1.26.4`
  - `torch==2.1.2`
  - `torchaudio==2.1.2`
  - `openai-whisper==20231117`
  - `requests==2.31.0`

## Build Process

```bash
# 1. Clean previous builds
npm run clean:win

# 2. Install dependencies
npm install
npm run install:all

# 3. Package Python (downloads Python + libs + Whisper model)
npm run package:python

# 4. Verify packaging succeeded
ls dist-python/python/python.exe  # Should exist
ls dist-python/python/cache/whisper/base.pt  # Should exist (~150MB)

# 5. Build Windows installer
npm run package:win

# Output: dist-electron/Clippy Setup <version>.exe
```

## Post-Build Verification

- [ ] `dist-python/python/python.exe` exists (~20MB)
- [ ] `dist-python/python/Lib/site-packages/torch/` exists (~200MB)
- [ ] `dist-python/python/Lib/site-packages/whisper/` exists
- [ ] `dist-python/python/cache/whisper/base.pt` exists (~150MB)
- [ ] `dist-python/python/PACKAGED_VERSION.txt` says "Python 3.11.9"
- [ ] Installer created: `dist-electron/Clippy Setup *.exe` (~550-600MB)

## Installation Testing

### Test 1: Clean Windows Machine (Critical!)
```
1. Use Windows machine with NO Python installed
2. Install Clippy Setup.exe
3. Launch app
4. Try transcription feature immediately
```

**Expected Results:**
- ✅ App launches without errors
- ✅ Transcription works immediately (no download)
- ✅ Logs show: `Using Python: C:\...\resources\python\python.exe`
- ✅ Logs show: `Using bundled Whisper models from...`

### Test 2: Python Conflict Test
```
1. Install Python 3.10 on system PATH (wrong version)
2. Install Clippy Setup.exe
3. Launch app
4. Check logs for Python path
```

**Expected Results:**
- ✅ Logs show absolute path to bundled Python (not system Python)
- ✅ App ignores system Python 3.10
- ✅ Transcription works with bundled Python 3.11.9

## Troubleshooting

### Build Fails: Python Download Error
```bash
# Manual fix:
# 1. Download manually from:
https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip

# 2. Place in dist-python/
# 3. Re-run packaging
npm run package:python
```

### Build Fails: Package Installation Error
```bash
# Clean and retry:
rm -rf dist-python/
npm run package:python
```

### Runtime Error: Python Not Found
**Symptom:** `CRITICAL: Packaged app missing bundled Python!`

**Check:**
```bash
# Verify Python was included in installer
cd "C:\Users\<user>\AppData\Local\Programs\Clippy\resources"
dir python\python.exe  # Should exist
```

**Fix:**
- Re-run `npm run package:python` before packaging
- Verify `extraResources` in package.json includes Python
- Check electron-builder logs for errors

### Runtime Error: Wrong Python Version
**Symptom:** Import errors, version conflicts

**Check:**
```bash
# In installed app, run:
"C:\...\resources\python\python.exe" --version
# Should show: Python 3.11.9
```

**Fix:**
- Verify `PYTHON_VERSION = '3.11.9'` in packaging script
- Delete dist-python/ and rebuild

### Runtime: Using System Python (Bad!)
**Symptom:** Logs show `python` or `python3` (not absolute path)

**This should never happen!** The app will now throw an error:
```
SECURITY: Refusing to use non-absolute Python path in production
```

**Fix:**
- Check that bundled Python exists in resources/
- Verify python-config.ts is detecting packaged mode
- Report as bug (this indicates packaging failure)

## Quick Verification Script

Run this in PowerShell after installation:

```powershell
# Check installation
$clippy = "$env:LOCALAPPDATA\Programs\Clippy"
Test-Path "$clippy\resources\python\python.exe"  # Should be True
Test-Path "$clippy\resources\python\cache\whisper\base.pt"  # Should be True

# Check sizes (approximate)
(Get-Item "$clippy\resources\python\python.exe").Length / 1MB  # ~20 MB
(Get-Item "$clippy\resources\python\cache\whisper\base.pt").Length / 1MB  # ~150 MB
```

## Version Lock Reference

| Component | Version | Why This Version |
|-----------|---------|------------------|
| Python | 3.11.9 | Stable, fast, Windows-compatible |
| PyTorch | 2.1.2 | Whisper-compatible, CPU-only |
| numpy | 1.26.4 | Latest <2.0 (Whisper requirement) |
| torchaudio | 2.1.2 | Matches PyTorch version |
| openai-whisper | 20231117 | Stable release |
| Whisper Model | base | Good quality, reasonable size |

**DO NOT change these versions without thorough testing!**

## Build Time Reference

| Task | First Build | Subsequent |
|------|-------------|------------|
| Python download | ~2 min | Cached |
| Package install | ~10-15 min | Cached |
| Whisper model | ~5-10 min | Cached |
| App build | ~3-5 min | ~3-5 min |
| **Total** | **20-35 min** | **5-10 min** |

## Size Reference

| Component | Size |
|-----------|------|
| Python runtime | ~20 MB |
| PyTorch | ~200 MB |
| Whisper library | ~50 MB |
| Whisper base model | ~150 MB |
| numpy + other | ~30 MB |
| ffmpeg/ffprobe | ~100 MB |
| App code + Node | ~50 MB |
| **Installer Total** | **~600 MB** |

## Critical Safeguards

✅ **Production always uses bundled Python** - Never system PATH
✅ **Absolute paths enforced** - Relative paths rejected in production
✅ **Version locked** - Exact versions guaranteed
✅ **Fail-fast** - Crashes if Python missing (better than wrong version)
✅ **No shell spawning** - Prevents PATH injection attacks

## Emergency Contacts

If packaging fails:
1. Check [WINDOWS_PACKAGING_GUIDE.md](WINDOWS_PACKAGING_GUIDE.md)
2. Check [PYTHON_VERSION_CONTROL.md](PYTHON_VERSION_CONTROL.md)
3. Review build logs in `npm-debug.log`
4. Verify Python download URL still valid
5. Check PyPI for package availability

## Success Criteria

### Build Success
- ✅ `npm run package:python` completes without errors
- ✅ `dist-python/python/` contains all required files
- ✅ `npm run package:win` creates installer (~600MB)

### Installation Success
- ✅ Installer runs on clean Windows machine
- ✅ App launches without Python errors
- ✅ `resources/python/` directory present with all files

### Runtime Success
- ✅ Logs show absolute path to bundled Python
- ✅ Transcription works immediately (no download wait)
- ✅ Whisper uses bundled base model
- ✅ No conflicts with system Python

---

**Ready to build?** Run `npm run package:win`

**Questions?** See [PYTHON_VERSION_CONTROL.md](PYTHON_VERSION_CONTROL.md) for details.
