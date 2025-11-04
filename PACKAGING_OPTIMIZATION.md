# Packaging Optimization Strategy

This document explains what's bundled vs. downloaded on-demand to optimize installer size while maintaining reliability.

## Size Analysis

### Current Full Bundle (~500MB)
```
Python 3.11.9:           ~20 MB
PyTorch (CPU):          ~200 MB
Whisper + deps:          ~50 MB
numpy/torchaudio:        ~30 MB
ffmpeg/ffprobe:         ~100 MB
yt-dlp:                  ~18 MB
Node modules:            ~50 MB
App code:                ~10 MB
----------------------------------
Total:                  ~478 MB
```

### Optimized Bundle (~370MB)
```
Python 3.11.9:           ~20 MB  [BUNDLED]
PyTorch (CPU):          ~200 MB  [BUNDLED]
Whisper library:         ~50 MB  [BUNDLED]
numpy/torchaudio:        ~30 MB  [BUNDLED]
ffmpeg/ffprobe:         ~100 MB  [BUNDLED]
yt-dlp:                  ~18 MB  [BUNDLED, optional auto-update]
Node modules:            ~50 MB  [BUNDLED]
App code:                ~10 MB  [BUNDLED]
----------------------------------
Whisper models:           ~0 MB  [DOWNLOAD ON FIRST USE]
```

**Installer Size Reduction:** Minimal (models aren't bundled anyway)
**User Experience:** Better (faster first install, downloads only needed models)

## What to Bundle vs. Download

### ✅ BUNDLE (Critical for Reliability)

#### 1. Python Runtime & Core Libraries
**Why:** Version-critical, installation can fail
- Python 3.11.9 embeddable
- PyTorch 2.1.2 (CPU)
- numpy 1.26.4 (Whisper requires <2.0)
- torchaudio 2.1.2
- openai-whisper library
- requests

**Size:** ~300 MB
**Risk if not bundled:** HIGH - Version conflicts, installation failures

#### 2. FFmpeg & FFprobe
**Why:** Core functionality, stable binaries
- ffmpeg (video processing)
- ffprobe (metadata extraction)

**Size:** ~100 MB
**Risk if not bundled:** MEDIUM - App won't work without these

#### 3. yt-dlp
**Why:** Reasonable size, works offline
- yt-dlp binary

**Size:** ~18 MB
**Risk if not bundled:** LOW - Could download latest, but bundling ensures offline work

### 📥 DOWNLOAD ON DEMAND (Optimize User Experience)

#### 1. Whisper Models (RECOMMENDED)
**Current behavior:** Whisper downloads models on first transcription
**Why download:**
- Users may not use transcription
- Multiple model sizes (base: 150MB, small: 500MB, medium: 1.5GB)
- Only download what user needs
- Models are cached after first download

**Implementation:** Already works this way! Whisper handles it automatically.

**Location:** `~/.cache/whisper/` or `C:\Users\<user>\.cache\whisper\`

#### 2. yt-dlp Updates (OPTIONAL)
**Current behavior:** Uses bundled version
**Enhancement:** Optionally check for updates

**Why download:**
- Frequent updates (new site support)
- User benefits from latest version
- Non-critical if update fails (fallback to bundled)

**Implementation:** See below

## Recommended Configuration

### Current (Good as-is)
```javascript
// Python + libraries: BUNDLED
// FFmpeg/ffprobe: BUNDLED
// yt-dlp: BUNDLED
// Whisper models: DOWNLOADED ON DEMAND (already!)
```

This is already optimal! The only potential improvement is yt-dlp auto-updates.

## Optional Enhancement: yt-dlp Auto-Update

If you want users to get the latest yt-dlp:

### Implementation Strategy

```typescript
// electron/utilities/yt-dlp-updater.ts
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { app } from 'electron';

export class YtDlpUpdater {
  private readonly bundledPath: string;
  private readonly updatePath: string;

  constructor() {
    // Bundled version (fallback)
    this.bundledPath = path.join(
      process.resourcesPath,
      'utilities',
      'bin',
      process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    );

    // User-specific updated version
    this.updatePath = path.join(
      app.getPath('userData'),
      'bin',
      process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    );
  }

  /**
   * Get the yt-dlp path to use (updated version if available, else bundled)
   */
  getYtDlpPath(): string {
    if (fs.existsSync(this.updatePath)) {
      return this.updatePath;
    }
    return this.bundledPath;
  }

  /**
   * Check for and download yt-dlp update (non-blocking)
   */
  async checkForUpdate(): Promise<boolean> {
    try {
      // Download latest version
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${
        process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
      }`;

      // Ensure directory exists
      const binDir = path.dirname(this.updatePath);
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      // Download to temp location first
      const tempPath = `${this.updatePath}.tmp`;
      await this.downloadFile(url, tempPath);

      // Move to final location
      fs.renameSync(tempPath, this.updatePath);

      // Make executable on Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(this.updatePath, 0o755);
      }

      return true;
    } catch (error) {
      console.warn('yt-dlp update failed, using bundled version:', error);
      return false;
    }
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          return this.downloadFile(response.headers.location!, destPath)
            .then(resolve)
            .catch(reject);
        }

        const file = fs.createWriteStream(destPath);
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          fs.unlinkSync(destPath);
          reject(err);
        });
      }).on('error', reject);
    });
  }
}
```

### Usage

```typescript
// In electron main.ts
import { YtDlpUpdater } from './utilities/yt-dlp-updater';

const ytDlpUpdater = new YtDlpUpdater();

app.on('ready', async () => {
  // Use current version immediately
  const ytDlpPath = ytDlpUpdater.getYtDlpPath();

  // Check for updates in background (non-blocking)
  ytDlpUpdater.checkForUpdate().then(updated => {
    if (updated) {
      console.log('yt-dlp updated to latest version');
    }
  });
});
```

### Benefits
- ✅ Uses bundled version immediately (no waiting)
- ✅ Updates in background (non-blocking)
- ✅ Falls back to bundled version if update fails
- ✅ Users get latest site support
- ✅ ~18MB installer size unchanged

### Risks
- ⚠️ Update could fail (mitigated by fallback)
- ⚠️ Slight complexity (but well-contained)

## What NOT to Download

### ❌ Python Runtime
**Why NOT:**
- Installation complexity on Windows
- Version compatibility critical
- User environment pollution
- Bundle size worth it (~20MB)

### ❌ PyTorch/numpy/Whisper
**Why NOT:**
- Compilation may be required
- Version compatibility critical
- Installation can fail on Windows
- Offline capability important
- Bundle size justified for reliability

### ❌ FFmpeg/FFprobe
**Why NOT:**
- Core functionality (app useless without it)
- Download URLs can change
- Bundle size reasonable (~100MB)
- Better offline experience

## Recommendations

### Minimal Changes (Current is Good!)
✅ Keep current configuration - it's already optimal
✅ Whisper models already download on demand
✅ No changes needed

### Optional Enhancement
🔄 Add yt-dlp auto-updater (see code above)
- Non-breaking change
- Improves user experience
- Adds latest site support
- Falls back gracefully

### DON'T Change
❌ Don't try to download Python at runtime
❌ Don't try to download PyTorch/Whisper libraries
❌ Don't try to download FFmpeg

## Size Comparison with Other Apps

For context, your ~500MB installer is reasonable:

- **VS Code:** ~90MB (no ML dependencies)
- **OBS Studio:** ~300MB (includes ffmpeg)
- **Adobe Premiere:** ~2GB (pro video editor)
- **DaVinci Resolve:** ~3GB (pro video editor)
- **Whisper Desktop:** ~400MB (similar to yours)

Your app includes:
- Full Python runtime
- PyTorch (ML framework)
- Whisper (state-of-art transcription)
- Video processing (ffmpeg)

**Conclusion:** Your bundle size is justified and competitive.

## Final Recommendation

**Keep your current implementation as-is.** It's already optimal:

1. ✅ Bundles version-critical dependencies (Python, PyTorch, Whisper)
2. ✅ Whisper models download on demand (already!)
3. ✅ Provides offline capability
4. ✅ Guarantees reliability
5. ✅ Reasonable size (~500MB for full ML stack)

**Optional:** Add yt-dlp auto-updater if you want users to get latest site support automatically.

The finnicky parts (Python + PyTorch + Whisper + numpy compatibility) are exactly what you should bundle, and you're already doing that correctly!
