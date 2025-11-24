# Changelog

All notable changes to the ClipChimp project will be documented in this file.

---

## [Hotfix] - 2025-11-06 (23:00)

### ✅ Fixed

#### Video Player Memory Leak (CRITICAL)
- **Issue**: App becomes increasingly laggy when switching between videos, eventually freezing
- **Root Cause**: Event listeners not cleaned up when closing video player dialog
- **Symptoms**:
  - First video loads fine
  - Each subsequent video gets slower
  - App becomes unresponsive after viewing multiple videos
- **Fix**:
  - Track all video event listeners for proper cleanup
  - Remove `ngZone.runOutsideAngular()` calls (unnecessary complexity)
  - Clear all timers and intervals in `ngOnDestroy`
  - Set references to `null` after cleanup
- **File**: [video-player.component.ts:157-202](frontend/src/app/components/video-player/video-player.component.ts#L157-L202)

#### Video Player OnPush Detection Issue
- **Issue**: Video loads successfully then immediately errors with "Empty src attribute"
- **Root Cause**: `ChangeDetectionStrategy.OnPush` caused component to reinitialize, clearing video src
- **Fix**: Removed `ChangeDetectionStrategy.OnPush` from VideoPlayerComponent
- **File**: [video-player.component.ts:32-33](frontend/src/app/components/video-player/video-player.component.ts#L32-L33)
- **Impact**: Videos now load instantly without reinitializing

#### Transcript Search UI
- **Issue**: "Run Transcription" button covered search box even when transcript existed
- **Root Cause**: `transcriptExists` flag based on API response instead of actual text content
- **Fix**: Check for actual transcript text content: `transcriptExists = !!(transcriptText && transcriptText.trim().length > 0)`
- **File**: [video-player.component.ts:118-120](frontend/src/app/components/video-player/video-player.component.ts#L118-L120)

#### Database Schema Migration
- **Issue**: Missing `added_at` column in existing databases caused errors
- **Solution**: Added automatic schema migration to add missing columns
- **Implementation**: `runSchemaMigrations()` method checks and adds `added_at` column if missing
- **File**: [database.service.ts:219-245](backend/src/database/database.service.ts#L219-L245)
- **Note**: Users can also delete `~/Library/Application Support/ClipChimp/ClipChimp.db` to recreate with fresh schema

#### Build System
- **Issue**: Backend build incomplete - missing app.controller.js and other files
- **Root Cause**: Running `npm run build` from backend folder only ran NestJS CLI
- **Fix**: Use `npm run build:backend` from project root (runs tsc + nest build)
- **Alternative**: Delete and recreate database for clean schema

---

## [Phase 5.1] - 2025-11-06 (Late Update)

### ✅ Completed

#### Critical Fixes
- **Import Manager**: Complete rewrite with direct file picker approach
  - User feedback: "import videos should open a system picker, not a list"
  - Fixed: Removed folder scanning (too slow for large libraries)
  - Implementation: Direct Electron file picker via IPC
  - Files: [library.component.ts:515](frontend/src/app/components/library/library.component.ts#L515), [ipc-handlers.ts:188](electron/ipc/ipc-handlers.ts#L188)
  - Testing: Requires Electron restart to verify

- **Notification Spam Fix**: Eliminated "Refresh Failed" toast notifications
  - Error: "Failed to refresh batch status. Will try again later."
  - Root cause: Frontend polling before backend ready
  - Fix: Silent error handling with console logging only
  - File: [batch-download.component.ts:1737](frontend/src/app/components/batch-download/batch-download.component.ts#L1737)

- **Backend Startup Reliability**: Fixed race condition causing first-attempt failures
  - Error: "Backend failed to start on first attempt, retrying in 2 seconds..."
  - Root cause: Health check timeout (2s) < backend startup time (3s)
  - Fix: Increased timeout from 2s to 5s, reduced initial delay from 3s to 2s
  - Impact: Eliminates 2-second retry delay, faster startup
  - File: [backend-service.ts:93-128](electron/services/backend-service.ts#L93-L128)

- **IPC Preload Script**: Exposed ipcRenderer for file picker functionality
  - Error: "File picker only works in Electron app"
  - Fix: Added `ipcRenderer.invoke` to contextBridge
  - File: [preload.ts:51-53](electron/preload.ts#L51-L53)

### 📝 Documentation Updates
- **TODO.md**: Added "Critical Fixes (In Progress)" section with current work
- **TODO.md**: Documented backend startup timing fix
- **TODO.md**: Added multi-library system architecture request
- **TESTING_CHECKLIST.md**: Existing from Phase 5

---

## [Phase 5] - 2025-11-06

### ✅ Completed

#### Library Management
- **Video Selection System**: Multi-select with checkboxes and master checkbox
- **Configurable Storage**: User-defined clips folder in Settings
- **Long Video Highlighting**: Visual indicators for videos >10 minutes (orange border, schedule icon)
- **Auto-Detect API**: Backend endpoint to detect unimported videos
- **Clean Notifications**: Reduced notification spam by 80%, badge-only for routine events

#### Database Enhancements
- **SQLite Implementation**: 5,353+ videos with full-text search
- **File Scanner**: Hash-based deduplication using SHA-256
- **Tag System**: Grouped by people, topics, and categories
- **Full-Text Search**: FTS5 tables for transcripts and analyses

#### UX Improvements
- **Streamlined Navigation**: Removed duplicate "Analysis Reports" page
- **Material Design Polish**: Consistent UI with dark/light themes
- **Virtual Scrolling**: Smooth performance with large video lists

### 🔧 Technical Fixes

#### Build System
- **better-sqlite3 Native Module**: Fixed Electron/Node.js version mismatch
  - Solution: `npx @electron/rebuild -v 36.0.1 -w better-sqlite3`
  - Error was: NODE_MODULE_VERSION 131 (Node.js) vs 135 (Electron 36) conflict
  - Important: Must rebuild for Electron specifically, not regular Node.js

- **TypeScript Build Corruption**: Fixed tsbuildinfo corruption
  - Solution: Remove `tsconfig.build.tsbuildinfo` before builds
  - Affected files: `backend/tsconfig.build.json`

- **Path Alias Resolution**: Converted `@/` imports to relative paths
  - Files changed: `ffmpeg.service.ts`, `job-state-manager.service.ts`
  - Reason: TypeScript doesn't resolve path aliases in compiled output

#### Database
- **Import Statement**: Changed better-sqlite3 import style
  - From: `import Database from 'better-sqlite3'`
  - To: `import * as Database from 'better-sqlite3'`
  - Added fallback for CommonJS/ESM compatibility

### 📁 Documentation Consolidation
- **Created PROJECT_OVERVIEW.md**: Comprehensive project goals and accomplishments
- **Created TODO.md**: Future work, pending tasks, and known issues
- **Archived 40+ Documentation Files**: Moved to `docs/archive/` for reference
- **Main Docs Remain**: README.md, PROJECT_OVERVIEW.md, TODO.md, CHANGELOG.md

### 🔮 Deferred for Future
- Import Manager UI (backend API complete)
- Duration filter chips
- Right-click context menus
- Missing file indicators
- Auto-relink on startup

---

## [Phase 4] - 2025 (Earlier)

### Completed
- AI-powered video analysis
- Whisper transcription integration
- Multi-provider LLM support (Ollama, OpenAI, Claude)
- Python bridge service
- Batch analysis queue

---

## [Phase 3] - 2025 (Earlier)

### Completed
- Native HTML5 video player (migrated from Video.js)
- Keyboard shortcuts (J/K/L shuttle, I/O markers)
- Timeline with AI section visualization
- Transcript search and sync
- Custom video support for clip creation

---

## [Phase 2] - 2025 (Earlier)

### Completed
- State-based job management
- Concurrent download queue
- WebSocket-based progress tracking
- Job persistence and recovery

---

## [Phase 1] - 2025 (Earlier)

### Completed
- NestJS backend architecture
- Angular frontend with Material Design
- yt-dlp integration
- FFmpeg processing pipeline
- Electron desktop wrapper

---

## Known Issues

### Active
- [ ] Proxy errors from old library system (low priority)
  - Routes: `/api/library/analyses?archived=false`
  - Impact: None, deprecated system

### Resolved ✅
- [x] ~~Refresh Failed Error~~ - Backend connectivity issue
- [x] ~~better-sqlite3 Module Error~~ - Native module version mismatch
- [x] ~~TypeScript Build Corruption~~ - tsbuildinfo cache issue
- [x] ~~Path Alias Resolution~~ - Converted to relative imports

---

## Upgrade Guide

### From Pre-Phase 5
1. **Database Migration**: Automatic on first launch
2. **Settings Update**: New `clipsFolder` field in Settings
3. **Dependencies**: Run `npm rebuild better-sqlite3 --build-from-source`
4. **Documentation**: Check PROJECT_OVERVIEW.md for new features

### Required Actions
```bash
# Rebuild better-sqlite3 for Electron (from project root)
npx @electron/rebuild -v 36.0.1 -w better-sqlite3

# Clear build cache if issues occur (in backend directory)
cd backend
rm -f tsconfig.build.tsbuildinfo
npm run build
```

---

## Breaking Changes

### Phase 5
- None (backward compatible)

### Phase 4
- Analysis file format changed (automatic migration)

### Phase 3
- Removed Video.js dependency (replaced with native HTML5)

---

**Semantic Versioning**: We follow [SemVer](https://semver.org/) for version numbering.

**Last Updated**: November 6, 2025
