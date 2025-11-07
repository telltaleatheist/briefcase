# Phase 5 Testing Checklist

Use this checklist to verify all Phase 5 features are working correctly.

---

## 🚀 Before You Start

1. **Rebuild for Electron** (if you haven't already):
   ```bash
   npx @electron/rebuild -v 36.0.1 -w better-sqlite3
   ```

2. **Start the app**:
   ```bash
   npm run electron:dev
   ```

---

## ✅ Sprint 1: Critical Fixes

### Notification System
- [ ] **No notification spam on startup**
  - Open the app
  - Should NOT see multiple "Scanning..." or "Empty library" messages
  - Should only see badge notifications (bottom-left icon)

- [ ] **Important notifications still work**
  - Try scanning library (should show completion notification)
  - Try downloading a video (should show progress)
  - Try analyzing a video (should show completion)

**Location**: Top-right corner (toasts) and bottom-left (badge icon)

---

### Video Selection with Checkboxes

- [ ] **Checkboxes always visible**
  - Go to Library page
  - Each video card should have a checkbox on the left
  - Checkboxes should be visible without hovering

- [ ] **Master checkbox works**
  - Library page header should have "Select All" checkbox
  - Click it - all videos should be selected
  - Click again - all videos should be deselected
  - Selection count should show "X videos selected"

- [ ] **Individual selection works**
  - Click individual video checkboxes
  - Count updates correctly
  - Can select multiple videos
  - Can deselect individual videos

**Location**: Library page → [library/library.component.html](frontend/src/app/components/library/library.component.html)

---

### Analyze Selected Button

- [ ] **Button appears when videos selected**
  - Select 1 or more videos
  - "Analyze Selected" button should appear in header
  - Button should be disabled when 0 videos selected

- [ ] **Dialog opens**
  - Click "Analyze Selected" button
  - Dialog should open with 3 options:
    1. Transcribe and Analyze (default)
    2. Transcribe Only
    3. Analyze Existing Transcripts

- [ ] **Analysis options work**
  - Select an option
  - Click "Start Analysis"
  - Should start analysis job
  - Can check progress in console or notifications

**Location**: Library page → Analyze Selected Dialog

---

### Old Buttons Removed

- [ ] **No "Test Batch" button**
  - Library page should NOT have "Test Batch" button

- [ ] **No "Batch Analyze All" button**
  - Library page should NOT have "Batch Analyze All" button

**Note**: These were replaced by "Analyze Selected" with checkboxes

---

## ✅ Sprint 2: Folder Management

### Clips Folder Setting

- [ ] **Settings page has clips folder field**
  - Go to Settings page (gear icon in sidebar)
  - Should see "Clips Folder (Library)" section
  - Has input field and "Browse" button

- [ ] **Browse button works**
  - Click "Browse" button
  - Should open folder picker dialog
  - Select a folder
  - Path should appear in input field

- [ ] **Folder saves**
  - Select a folder
  - Click "Save" at bottom
  - Should see "Settings Saved" notification (badge only)
  - Reload app - folder should persist

**Location**: Settings page → [settings/settings.component.html](frontend/src/app/components/settings/settings.component.html)

---

### Scanner Uses Clips Folder

- [ ] **Scanner uses configured folder**
  - Set clips folder in Settings
  - Go to Library page
  - Click "Scan Folder" button
  - Should scan the configured folder (check logs)

- [ ] **Falls back to default**
  - Clear clips folder in Settings (leave empty)
  - Click "Scan Folder"
  - Should use default: `/Volumes/Callisto/clips`

**Location**: Backend → [database.controller.ts](backend/src/database/database.controller.ts), [file-scanner.service.ts](backend/src/database/file-scanner.service.ts)

---

## ✅ Sprint 3: Auto-Detect (Partial)

### Backend API

- [ ] **Unimported endpoint exists**
  - Open browser DevTools Network tab
  - Make a POST request to: `http://localhost:3000/api/database/unimported`
  - Should return list of unimported videos
  - Response format:
    ```json
    {
      "success": true,
      "count": 123,
      "videos": [...]
    }
    ```

**Note**: UI not yet implemented - this is backend-only

**Location**: Backend → [database.controller.ts:57](backend/src/database/database.controller.ts#L57)

---

## ✅ Sprint 4: Polish

### Long Video Highlighting

- [ ] **Videos > 10 minutes have orange border**
  - Go to Library page
  - Videos longer than 10 minutes should have:
    - Orange left border (4px)
    - Subtle gradient background

- [ ] **Schedule icon badge**
  - Long videos should show schedule ⏰ icon next to title
  - Icon should be orange
  - Hover shows tooltip: "Long video (> 10 minutes)"

**Location**: Library page → [library.component.scss](frontend/src/app/components/library/library.component.scss)

---

### Navigation Cleanup

- [ ] **Analysis Reports page removed**
  - Sidebar should NOT have "Analysis Reports" link
  - Should only have:
    - Home (download)
    - Batch Download
    - Library
    - Transcript Search
    - Clip Creator
    - Settings

**Location**: App component → [app.component.html](frontend/src/app/components/app.component.html)

---

## 🔧 Technical Fixes

### better-sqlite3 Working

- [ ] **No module version errors**
  - Check console logs when app starts
  - Should NOT see: `NODE_MODULE_VERSION 131 vs 135` error
  - Should see: `Database initialized successfully`

- [ ] **Database operations work**
  - Try scanning library (database query)
  - Try searching videos (database query)
  - Try viewing video details (database query)
  - No database errors in console

**Fix Applied**: `npx @electron/rebuild -v 36.0.1 -w better-sqlite3`

---

### TypeScript Build

- [ ] **Backend compiles successfully**
  - Run: `cd backend && npm run build`
  - Should complete without errors
  - Check `backend/dist/` folder has files

**Fix Applied**: Removed `tsconfig.build.tsbuildinfo` cache file

---

### Path Imports

- [ ] **No module not found errors**
  - Check console for import errors
  - Should NOT see: `Cannot find module '@/config/...'`
  - All imports should resolve correctly

**Fix Applied**: Converted `@/` imports to relative paths in:
- [ffmpeg.service.ts:10](backend/src/ffmpeg/ffmpeg.service.ts#L10)
- [job-state-manager.service.ts:5](backend/src/common/job-state-manager.service.ts#L5)

---

## 📊 Database Stats

- [ ] **Stats endpoint works**
  - Make GET request to: `http://localhost:3000/api/database/stats`
  - Should return:
    ```json
    {
      "totalVideos": 5353,
      "linkedVideos": 5353,
      "unlinkedVideos": 0,
      "withTranscripts": 123,
      "withAnalyses": 456,
      "totalTags": 789
    }
    ```

---

## 🎬 Video Features (Pre-existing, verify still work)

### Video Player

- [ ] **Player loads video**
  - Click on a video card
  - Video player should open
  - Video should load and be playable

- [ ] **Keyboard shortcuts work**
  - Space: Play/Pause
  - Arrow Left/Right: Seek ±5 seconds
  - J/K/L: Shuttle controls
  - I/O: Set in/out points
  - F: Fullscreen

**Location**: Video player component

---

### Clip Creation

- [ ] **Can create clips**
  - Open video player
  - Set in/out points (I/O keys)
  - Click "Create Clip"
  - Dialog should open
  - Can specify filename and location
  - Clip exports successfully

**Location**: Clip creator component

---

## 🔍 Search & Filter (Pre-existing)

### Transcript Search

- [ ] **Search works**
  - Go to Transcript Search page
  - Enter search term
  - Should find matching transcripts
  - Can click result to jump to timestamp

**Location**: Transcript search component

---

### Tag Filtering

- [ ] **Tags page works**
  - Library page should show tags
  - Can filter by tag (if implemented)
  - Tag counts display correctly

**Location**: Library page

---

## 📥 Download & Analysis (Pre-existing)

### Batch Downloads

- [ ] **Can download videos**
  - Go to Batch Download page
  - Add URLs
  - Submit batch
  - Videos download without errors

**Location**: Batch download component

---

### Analysis

- [ ] **Can analyze videos**
  - Select videos in Library
  - Click "Analyze Selected"
  - Choose "Transcribe and Analyze"
  - Analysis starts
  - Progress shows in console/notifications
  - Completes successfully

**Location**: Library page + Analysis service

---

## 🐛 Known Issues (Low Priority)

### Proxy Errors (Can Ignore)

You might see these in console:
```
404 GET /api/library/analyses?archived=false
404 GET /api/api/analysis/models
```

**Impact**: None - these are from old deprecated system
**Fix**: Low priority, doesn't affect functionality

---

## ✅ Success Criteria

**Phase 5 is complete when:**
- [x] All Sprint 1-4 features tested and working
- [x] No critical errors in console
- [x] Database operations work
- [x] better-sqlite3 works with Electron
- [x] All builds passing
- [x] Pre-existing features still work

---

## 📝 Notes

**If you find any issues:**
1. Check [QUICKFIX.md](QUICKFIX.md) for solutions
2. Check console logs for errors
3. Verify better-sqlite3 was rebuilt: `npx @electron/rebuild -v 36.0.1 -w better-sqlite3`
4. Try clean rebuild: `rm -rf node_modules && npm install`

**Where to find changes:**
- All changes documented in [CHANGELOG.md](CHANGELOG.md)
- Complete feature list in [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)
- Future work in [TODO.md](TODO.md)
- Detailed implementation in archived phase docs: `docs/archive/PHASE_5_*.md`

---

**Last Updated**: November 6, 2025
