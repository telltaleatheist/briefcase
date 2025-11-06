# Changelog

All notable changes to the Clippy project will be documented in this file.

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
