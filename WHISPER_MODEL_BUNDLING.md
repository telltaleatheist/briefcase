# Whisper Model Bundling Strategy

## Overview

The application now bundles the **Whisper base model** (~150MB) with the Windows installer, eliminating the need for first-run downloads and providing immediate transcription capability.

## Why Bundle the Base Model?

### Benefits
- ✅ **No first-run wait** - Users can transcribe immediately
- ✅ **Offline capable** - Works without internet connection
- ✅ **Better UX** - No surprise downloads or waiting
- ✅ **Sufficient quality** - Base model provides good balance of speed/accuracy

### Model Comparison

| Model | Size | Speed | Accuracy | Use Case |
|-------|------|-------|----------|----------|
| tiny | ~75 MB | Fastest | Basic | Quick captions |
| **base** | **~150 MB** | **Fast** | **Good** | **General use (bundled)** |
| small | ~500 MB | Medium | Better | High-quality transcripts |
| medium | ~1.5 GB | Slow | Best | Professional use |
| large | ~3 GB | Very Slow | Excellent | Research/archival |

**Chosen:** Base model provides the best balance for general users.

## Implementation

### 1. Packaging Script Enhancement

The script (`scripts/package-python-windows.js`) now:
1. Downloads Python 3.11.9 embeddable
2. Installs all Python dependencies
3. **Downloads Whisper base model to bundled cache**
4. Packages everything for distribution

```javascript
// Download Whisper base model
execSync(`"${pythonExe}" -c "import whisper; whisper.load_model('base')"`, {
  env: {
    XDG_CACHE_HOME: path.join(PYTHON_DIR, 'cache')
  }
});
```

### 2. Python Script Enhancement

The video analysis service ([backend/python/video_analysis_service.py](backend/python/video_analysis_service.py)) now:
1. Checks for bundled model in `python/cache/whisper/`
2. Uses bundled model if available
3. Falls back to downloading if not found

```python
# Check for bundled model
python_dir = os.path.dirname(sys.executable)
bundled_cache = os.path.join(python_dir, 'cache', 'whisper')

if os.path.exists(bundled_cache):
    # Use bundled model
    os.environ['XDG_CACHE_HOME'] = os.path.join(python_dir, 'cache')
    whisper_model = whisper.load_model(model, download_root=bundled_cache)
else:
    # Download to user cache
    whisper_model = whisper.load_model(model)
```

### 3. Bundled Directory Structure

```
resources/
└── python/
    ├── python.exe
    ├── Lib/
    │   └── site-packages/
    │       └── whisper/          # Whisper library
    └── cache/
        └── whisper/              # Bundled models
            └── base.pt           # ~150MB base model
```

## Size Impact

### Before (On-Demand Download)
```
Installer: ~450 MB
First run: Downloads ~150 MB (base model)
Total impact: ~450 MB installer + 150 MB first-run download
```

### After (Bundled Model)
```
Installer: ~600 MB (includes base model)
First run: No download needed
Total impact: ~600 MB installer, immediate use
```

**Net effect:** ~150 MB larger installer, but better user experience.

## User Options

While the base model is bundled, users can still use other models:

### Via Frontend (Future Enhancement)
```typescript
// In transcription settings
const modelOptions = [
  { value: 'base', label: 'Base (bundled, fast)', size: 'bundled' },
  { value: 'small', label: 'Small (download ~500MB)', size: '500 MB' },
  { value: 'medium', label: 'Medium (download ~1.5GB)', size: '1.5 GB' }
];
```

### Via API Call
```typescript
// Backend already supports model selection
await pythonBridge.transcribe(
  audioPath,
  'small',  // Use small model instead of base
  'en'
);
```

If a user selects a different model, it will be downloaded to their user cache on first use.

## Development vs Production

### Development Mode
- Uses system Whisper installation
- Downloads models to `~/.cache/whisper/`
- Standard Whisper behavior

### Production Mode (Packaged App)
- Uses bundled Python from `resources/python/`
- Checks `resources/python/cache/whisper/` first
- Falls back to user cache if model not found

## Upgrading to Different Models

Users who want higher quality can still use larger models:

### Option 1: Environment Variable
```python
# User can set WHISPER_MODEL environment variable
model = os.environ.get('WHISPER_MODEL', 'base')
```

### Option 2: Settings UI (Recommended Future Enhancement)
```typescript
// Add to app settings
interface TranscriptionSettings {
  model: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  language: string;
}
```

## Bundling Different Models (If Needed)

To bundle a different model, edit `scripts/package-python-windows.js`:

```javascript
// Change this line:
execSync(`"${pythonExe}" -c "import whisper; whisper.load_model('base')"`, {

// To bundle tiny (smaller installer):
execSync(`"${pythonExe}" -c "import whisper; whisper.load_model('tiny')"`, {

// Or to bundle small (larger installer, better quality):
execSync(`"${pythonExe}" -c "import whisper; whisper.load_model('small')"`, {
```

## Testing

### Verify Bundled Model
```bash
# After packaging
cd dist-python/python/cache/whisper
ls -lh base.pt  # Should show ~150MB file
```

### Test in Packaged App
1. Build installer: `npm run package:win`
2. Install on Windows test machine
3. Try transcription immediately (should not download)
4. Check logs for: `Using bundled Whisper models from...`

## Troubleshooting

### Model Not Found in Packaged App

**Symptom:** App downloads model on first transcription despite bundling

**Check:**
1. Verify `resources/python/cache/whisper/base.pt` exists in installation
2. Check Python logs for cache path detection
3. Ensure packaging script completed successfully

**Fix:**
```bash
# Re-run packaging
npm run package:python
# Verify model downloaded
ls dist-python/python/cache/whisper/
```

### Wrong Model Downloaded During Packaging

**Symptom:** Packaging script downloads wrong model

**Check:**
- `scripts/package-python-windows.js` line with `whisper.load_model()`
- Should be `'base'` not `'tiny'` or `'small'`

### Packaging Takes Too Long

**Expected:** 20-35 minutes first time (includes ~150MB download)

**If longer:**
- Check internet speed (downloading PyTorch + Whisper model)
- Whisper model download from HuggingFace can be slow
- Consider running during off-peak hours

## Recommended Configuration

**For most users:** Bundle **base** model (current implementation)
- Good quality for general transcription
- Fast enough for real-time use
- Reasonable installer size (~600 MB)

**For quick captions only:** Bundle **tiny** model
- Smaller installer (~525 MB)
- Much faster transcription
- Lower accuracy

**For professional use:** Let users download **medium** or **large**
- Don't bundle (too large: 1.5-3 GB)
- Provide settings UI for model selection
- Download on demand

## Summary

✅ **Base model bundled** - Immediate transcription capability
✅ **No first-run download** - Better user experience
✅ **Offline capable** - Works without internet
✅ **Still flexible** - Users can download larger models if needed

**Installer size:** ~600 MB (reasonable for ML-powered app)
**Build time:** ~20-35 minutes first build
**User experience:** Transcription works immediately after install
