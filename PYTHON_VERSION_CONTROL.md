# Python Version Control & Security

## Critical Requirement

**The application MUST use the bundled Python in production, never system Python.**

This is critical because:
1. ✅ **Version control** - Ensures Python 3.11.9 with exact library versions
2. ✅ **Library compatibility** - PyTorch 2.1.2 + numpy 1.26.4 + Whisper are version-locked
3. ✅ **Security** - Prevents using potentially compromised system Python
4. ✅ **Reliability** - Guarantees app works regardless of user's Python setup
5. ✅ **Isolation** - Prevents conflicts with user's Python environment

## How It's Enforced

### 1. Python Configuration (python-config.ts)

**Priority Order:**
```typescript
1. Packaged Python (resources/python/python.exe) - PRODUCTION ONLY
2. Conda environment (macOS development)
3. System Python (development fallback)
```

**Key Safety Features:**

#### A. Absolute Path Requirement (Production)
```typescript
// In production, ALWAYS return absolute path to bundled Python
if (isPackaged) {
  const packagedPythonPath = path.join(resourcesPath, 'python', 'python.exe');

  if (fs.existsSync(packagedPythonPath)) {
    return { command: packagedPythonPath, fullPath: packagedPythonPath };
  }

  // If we reach here, something is VERY wrong
  throw new Error('CRITICAL: Packaged app missing bundled Python!');
}
```

#### B. Fail-Fast on Missing Bundle
```typescript
// If packaged but Python not found, throw immediately
// NEVER fall back to system Python in production
if (isPackaged) {
  throw new Error(
    'CRITICAL: Packaged app missing bundled Python! ' +
    'Expected to find python.exe in resources/python/.'
  );
}
```

### 2. Process Spawning (python-bridge.service.ts)

**Key Safety Features:**

#### A. Absolute Path Verification
```typescript
// REFUSE to spawn Python with relative path in production
if (isPackaged && !path.isAbsolute(pythonPath)) {
  throw new Error(
    'SECURITY: Refusing to use non-absolute Python path in production'
  );
}
```

#### B. No Shell, No PATH Lookup
```typescript
const pythonProcess = spawn(pythonPath, [script], {
  shell: false,  // CRITICAL: Never use shell (prevents PATH lookup)
  env: {
    ...process.env,
    PYTHONHOME: undefined,   // Clear Python environment vars
    PYTHONPATH: undefined,   // Prevent conflicts
  }
});
```

This ensures:
- ✅ Python is spawned by **exact absolute path**
- ✅ No shell interpolation (can't resolve `python` from PATH)
- ✅ No PYTHONHOME/PYTHONPATH interference

## Verification Checklist

### Before Packaging
- [ ] `scripts/package-python-windows.js` downloads Python 3.11.9
- [ ] Script installs exact versions from `requirements.txt`
- [ ] Script downloads Whisper base model
- [ ] Output directory `dist-python/python/` contains:
  - `python.exe`
  - `Lib/site-packages/` with all packages
  - `cache/whisper/base.pt`

### After Packaging
- [ ] Installer includes `resources/python/python.exe`
- [ ] Installer includes `resources/python/Lib/site-packages/`
- [ ] Installer includes `resources/python/cache/whisper/`
- [ ] `PACKAGED_VERSION.txt` shows Python 3.11.9

### After Installation
- [ ] Check installation directory:
  ```
  C:\Users\<user>\AppData\Local\Programs\Clippy\resources\python\python.exe
  ```
- [ ] Python.exe should be ~20MB
- [ ] Lib/site-packages should contain:
  - `torch/` (~200MB)
  - `whisper/` (~50MB)
  - `numpy/` (~25MB)

### Runtime Verification
- [ ] Application logs show absolute Python path:
  ```
  Using Python: C:\...\AppData\Local\Programs\Clippy\resources\python\python.exe
  ```
- [ ] NOT showing: `python` or `python3` (relative)
- [ ] Transcription works without downloading model
- [ ] Check stderr for: `Using bundled Whisper models from...`

## Testing Strategy

### Test 1: Clean Windows Machine
**Purpose:** Verify works without ANY Python installed

1. Test on Windows machine with NO Python installed
2. Install Clippy
3. Try transcription immediately
4. Should work without errors

**Expected:**
- ✅ Uses bundled Python
- ✅ Uses bundled Whisper model
- ✅ No downloads
- ✅ No PATH errors

### Test 2: Conflicting Python Version
**Purpose:** Verify bundled Python is used, not system

1. Install Python 3.10 on PATH (wrong version)
2. Install Clippy
3. Try transcription
4. Should use bundled Python 3.11.9

**Expected:**
- ✅ Ignores system Python 3.10
- ✅ Uses bundled Python 3.11.9
- ✅ No version conflicts

### Test 3: Corrupted System Python
**Purpose:** Verify isolation from system

1. Install broken/corrupted Python on PATH
2. Install Clippy
3. Try transcription
4. Should work perfectly (ignores system Python)

**Expected:**
- ✅ Ignores broken system Python
- ✅ Uses bundled Python
- ✅ No errors

### Test 4: PATH Pollution
**Purpose:** Verify bundled Python takes precedence

1. Add multiple Python versions to PATH
2. Install Clippy
3. Check logs for Python path
4. Should be absolute path to bundled Python

**Expected:**
- ✅ Absolute path in logs
- ✅ Not resolving from PATH
- ✅ Uses bundled Python

## Debugging Production Issues

### Problem: App tries to use system Python

**Symptoms:**
- Logs show `python` or `python3` (not absolute path)
- Import errors for PyTorch/Whisper
- Version mismatch errors

**Diagnosis:**
```bash
# Check logs for Python path
# Should see: C:\...\AppData\Local\Programs\Clippy\resources\python\python.exe
# NOT: python or python3
```

**Causes:**
1. `python-config.ts` not detecting packaged mode
2. `resources/python/python.exe` missing from installation
3. `isPackaged` detection failing

**Fix:**
1. Verify `resourcesPath` is set correctly
2. Check `process.env.NODE_ENV === 'production'`
3. Verify electron-builder included `resources/python/`

### Problem: Python not found in packaged app

**Symptoms:**
- Error: `CRITICAL: Packaged app missing bundled Python!`
- App won't start

**Diagnosis:**
```bash
# Check installation directory
dir "C:\Users\<user>\AppData\Local\Programs\Clippy\resources\python"
# Should contain python.exe
```

**Causes:**
1. `npm run package:python` not run before packaging
2. electron-builder config missing `extraResources`
3. Packaging script failed silently

**Fix:**
1. Run `npm run package:python` manually
2. Verify `dist-python/python/` exists
3. Check electron-builder logs
4. Verify `extraResources` in package.json

### Problem: Wrong Python version being used

**Symptoms:**
- Whisper fails to load
- PyTorch compatibility errors
- numpy version errors

**Diagnosis:**
```python
# In bundled Python, run:
python.exe -c "import sys; print(sys.version)"
# Should show: Python 3.11.9

python.exe -c "import torch; print(torch.__version__)"
# Should show: 2.1.2+cpu

python.exe -c "import numpy; print(numpy.__version__)"
# Should show: 1.26.4
```

**Causes:**
1. Packaging script used wrong Python version
2. `requirements.txt` versions changed
3. pip installed newer versions

**Fix:**
1. Delete `dist-python/`
2. Re-run `npm run package:python`
3. Verify `PYTHON_VERSION = '3.11.9'` in packaging script
4. Verify exact versions in `requirements.txt`

## Security Considerations

### Why Absolute Paths Matter

**Problem with relative paths:**
```typescript
// BAD - Could resolve from PATH (security risk)
spawn('python', [script]);

// GOOD - Exact binary (secure)
spawn('C:\\...\\python.exe', [script]);
```

**Attack vector:**
1. Attacker places malicious `python.exe` in PATH
2. App uses relative path `python`
3. Spawns attacker's Python instead of bundled
4. Malicious code execution

**Our protection:**
- ✅ Always use absolute path in production
- ✅ Verify path is absolute before spawning
- ✅ Never use shell (prevents PATH lookup)
- ✅ Clear PYTHONHOME/PYTHONPATH

### Why Shell=false Matters

**Problem with shell=true:**
```typescript
// BAD - Shell resolves from PATH
spawn('python', [script], { shell: true });

// Equivalent to: cmd.exe /c python script.py
// Attacker can inject malicious python.exe in PATH
```

**Our protection:**
```typescript
// GOOD - Direct execution, no shell, no PATH
spawn('C:\\exact\\path\\python.exe', [script], { shell: false });
```

## Version Lock Justification

### Why Python 3.11.9?

- ✅ **Stability** - Well-tested, mature release
- ✅ **Performance** - Significant speed improvements over 3.10
- ✅ **Compatibility** - Works with PyTorch 2.1.2
- ✅ **Windows support** - Excellent Windows compatibility

### Why PyTorch 2.1.2?

- ✅ **Whisper compatibility** - Tested with openai-whisper
- ✅ **CPU-only** - Smaller size (~200MB vs 2GB with CUDA)
- ✅ **Stability** - Mature release, fewer bugs

### Why numpy 1.26.4?

- ✅ **Whisper requirement** - Whisper requires numpy <2.0
- ✅ **Latest compatible** - Latest version before 2.0
- ✅ **Performance** - Good performance on CPU

## Updating Python/Libraries

### To Update Python Version

**IMPORTANT:** Test thoroughly before changing!

1. Edit `scripts/package-python-windows.js`:
   ```javascript
   const PYTHON_VERSION = '3.11.9';  // Change here
   ```

2. Verify compatibility:
   - Check PyTorch supports new Python version
   - Check Whisper supports new Python version
   - Test on Windows

3. Re-package and test:
   ```bash
   npm run package:python
   npm run package:win
   # Test on clean Windows machine
   ```

### To Update Libraries

**IMPORTANT:** Version compatibility is critical!

1. Edit `backend/python/requirements.txt`:
   ```txt
   numpy==1.26.4      # Check Whisper compatibility
   torch==2.1.2       # Check Whisper compatibility
   openai-whisper==... # Test thoroughly
   ```

2. Test locally first:
   ```bash
   cd dist-python/python
   python.exe -m pip install -r requirements.txt
   # Test transcription
   ```

3. If works, re-package:
   ```bash
   rm -rf dist-python/
   npm run package:python
   npm run package:win
   ```

## Summary

### Production Guarantees

✅ **Bundled Python is ALWAYS used** - Never system Python
✅ **Version locked** - Python 3.11.9 + exact library versions
✅ **Absolute paths** - No PATH resolution in production
✅ **Fail-fast** - Crashes if bundled Python missing (better than wrong Python)
✅ **Isolated** - No interference from system Python environment

### Security Features

✅ **No shell execution** - Prevents PATH injection
✅ **Absolute path verification** - Refuses relative paths in production
✅ **Environment isolation** - Clears PYTHONHOME/PYTHONPATH
✅ **Fail-safe defaults** - Throws error rather than using wrong Python

### Version Control

✅ **Python 3.11.9** - Embedded, portable, tested
✅ **PyTorch 2.1.2** - CPU-only, Whisper-compatible
✅ **numpy 1.26.4** - Latest <2.0 (Whisper requirement)
✅ **Whisper base model** - Bundled, ~150MB

The system is designed to **fail safely** - if bundled Python is missing, the app crashes with a clear error message rather than silently using the wrong Python version.
