# Clippy Video Player Feature - Continuation Prompt

**Status**: Phase 3 Complete (3 of 8 phases done)
**Next**: Phase 4 - Video Player Component
**Context File**: See `VIDEO_PLAYER_FEATURE_SPEC.md` for full specification

---

## Current State Summary

We're building a comprehensive video player and clip management system for Clippy (an Electron + Angular + NestJS app). The goal is to add in-app video playback with a Final Cut Pro-style timeline for creating clips from analyzed videos.

### ✅ What's Done (Phases 1-3)

1. **File-Based Library System**: Complete backend library management with:
   - `library.json` master index at `~/Library/Application Support/clippy/`
   - Atomic writes with file locking (proper-lockfile)
   - Auto-integration with video analysis pipeline
   - Full REST API for CRUD operations

2. **Analysis Reports UI**: Complete frontend overhaul with:
   - Active/Archived tabs
   - Archive management
   - Video link status tracking
   - Material Design UI

3. **Video Relinking**: Complete smart relinking system with:
   - Fuzzy string matching (Levenshtein + token overlap)
   - Auto-search clips collection by week folder
   - Beautiful dialog with confidence scoring
   - Manual file picker fallback

### 🚧 What's Next (Phase 4)

**Video Player Component** - We need to:

1. Install Video.js and types: `npm install video.js @types/video.js`
2. Create video player component at `frontend/src/app/components/video-player/`
3. Implement basic features:
   - Load video from file path (via backend endpoint)
   - Play/pause controls
   - Spacebar shortcut
   - Seek functionality
   - Display current time / duration
4. Add backend endpoint to serve video files: `GET /api/library/videos/:analysisId`
5. Wire up "Manage Clips" button to open player

### 📁 Key Architecture

**Backend Structure:**
```
backend/src/
├── library/
│   ├── library.service.ts       ✅ Core library management
│   ├── relink.service.ts        ✅ Video relinking
│   ├── library.controller.ts    ✅ REST endpoints
│   ├── library.module.ts        ✅ NestJS module
│   ├── interfaces/library.interface.ts  ✅ Types
│   └── parsers/analysis-parser.ts       ✅ Report parsing
└── analysis/
    └── analysis.service.ts      ✅ Modified to auto-add to library
```

**Frontend Structure:**
```
frontend/src/app/
├── services/
│   └── library.service.ts           ✅ API client
├── components/
│   ├── analysis-reports/            ✅ Main UI (updated)
│   ├── relink-dialog/               ✅ Relinking dialog
│   └── video-player/                ⏳ TO CREATE (Phase 4)
│       ├── video-player.component.ts
│       ├── video-player.component.html
│       ├── video-player.component.scss
│       └── timeline/                ⏳ Phase 5
```

**Data Flow:**
```
User clicks "Manage Clips"
  → Opens video player component
  → Loads analysis metadata (sections, timestamps)
  → Backend serves video via HTTP endpoint
  → Video.js player displays video
  → Timeline shows AI markers (Phase 6)
  → User selects range and creates clip (Phase 7-8)
```

### 🎯 Implementation Notes

**Video Serving Strategy:**
- Use local HTTP server (not `file://`) to avoid CORS issues
- Endpoint: `GET /api/library/videos/:analysisId` streams video file
- Use `res.sendFile()` or streaming for large files
- Support range requests for seeking

**Video.js Setup:**
```typescript
// In component
this.player = videojs(this.videoElement.nativeElement, {
  controls: true,
  fluid: true,
  sources: [{
    src: `/api/library/videos/${this.analysisId}`,
    type: 'video/mp4'
  }]
});
```

**Keyboard Shortcuts (FCPX-inspired):**
- Space: Play/Pause
- J/K/L: Rewind/Pause/Forward (Phase 5)
- I/O: Set in/out points (Phase 5)
- Left/Right: Frame step (Phase 5)

### 📋 Remaining Phases

- **Phase 5**: Timeline with FCPX-style range selection (draggable handles)
- **Phase 6**: Display AI analysis markers on timeline (color-coded)
- **Phase 7**: Clip creation backend (FFmpeg extraction)
- **Phase 8**: Clip creation UI (dialog, save options)

### 🔗 Key API Endpoints Available

```typescript
// Get analysis with metadata
GET /api/library/analyses/:id
GET /api/library/analyses/:id/metadata  // Parsed sections/timestamps

// To implement in Phase 4:
GET /api/library/videos/:analysisId  // Stream video file

// Already available for future phases:
POST /api/library/clips  // Create clip (Phase 7)
GET /api/library/analyses/:id/clips  // List clips
```

### 💡 Technical Decisions Made

1. **No database** - Pure file-based (library.json + text files)
2. **Video.js** for player (industry standard, plugin ecosystem)
3. **Local HTTP streaming** for videos (not file://)
4. **Dynamic category colors** via hashing (future-proof)
5. **Sunday-based week folders** for clips collection
6. **Atomic writes with proper-lockfile** for concurrency safety

### 🚀 How to Continue

1. Read `VIDEO_PLAYER_FEATURE_SPEC.md` for full context
2. Start Phase 4: Video Player Component
3. Follow the phase-by-phase approach in the spec
4. Test thoroughly before moving to next phase
5. Update `VIDEO_PLAYER_FEATURE_SPEC.md` with progress

---

## Quick Start Commands

```bash
# Backend
cd /Volumes/Callisto/Projects/clippy/backend
npm install
npm run build

# Frontend
cd /Volumes/Callisto/Projects/clippy/frontend
npm install video.js @types/video.js  # For Phase 4
npm run build

# Check compilation
cd backend && npx tsc --noEmit
cd frontend && npx ng build
```

---

## Context Preservation

If starting a new Claude session, provide:
1. This file (`CONTINUATION_PROMPT.md`)
2. The spec file (`VIDEO_PLAYER_FEATURE_SPEC.md`)
3. Brief description: "Continue implementing video player feature for Clippy. Phases 1-3 done (library, UI, relinking). Starting Phase 4 (video player component)."

All code is in `/Volumes/Callisto/Projects/clippy/`
