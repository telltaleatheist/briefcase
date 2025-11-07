# Clippy - TODO & Future Enhancements

**Last Updated:** November 6, 2025
**Current Status:** Phase 5 Complete ✅

---

## High Priority

### Critical Fixes (In Progress)
- [ ] **Import Manager - Direct File Picker** - CURRENT WORK
  - Status: Code complete, needs testing after Electron restart
  - Implementation: Direct system file picker (no modal)
  - Backend: POST /api/database/import with videoPaths array
  - Location: [library.component.ts:515](frontend/src/app/components/library/library.component.ts#L515)
  - Testing Required: Verify file picker opens and imports work

- [ ] **Backend Startup Reliability** - Fix timing race condition
  - Issue: Backend fails on first attempt due to timeout race condition
  - Error: "Backend failed to start on first attempt, retrying in 2 seconds..."
  - Root Cause IDENTIFIED:
    - Backend takes ~3 seconds to start (backend-service.ts:93)
    - Health check timeout is only 2 seconds (backend-service.ts:128)
    - Creates race condition where check runs before backend is ready
  - Fix: Increase health check timeout from 2s to 5s
  - Files to modify:
    - [backend-service.ts:128](electron/services/backend-service.ts#L128) - Increase timeout
    - Optionally reduce initial delay from 3s to 2s if backend starts faster
  - Impact: Eliminates 2-second retry delay on startup

- [ ] **Multi-Library System Architecture** - Support multiple clip libraries
  - Design: Each library has separate database
  - User can switch between libraries
  - No assumption of existing library on startup
  - Philosophy: "Build the clip collection" vs "assume existing collection"
  - Next: Design database management architecture

### Library Management
- [x] ~~**Import Manager UI**~~ - COMPLETED
  - Direct file picker implemented
  - Removed folder scanning approach (too slow for large libraries)
  - IPC handler: `dialog:openFiles` in [ipc-handlers.ts:188](electron/ipc/ipc-handlers.ts#L188)

- [ ] **Duration Filter Chips** - Quick filters for video length
  - `< 10 min`, `10-30 min`, `> 30 min` chips
  - Filter state management
  - URL parameter support for bookmarking

- [ ] **Missing File Indicators** - Visual feedback for unlinked videos
  - ⚠️ icon on video cards where `is_linked = 0`
  - "Relink" button to search for moved files
  - Batch relink operation

- [ ] **Auto-Relink on Startup** - Automatically fix broken links
  - Scan for missing files on app launch
  - Hash-based relinking for moved files
  - Background job with progress notification

### Analysis System
- [ ] **Analyze Selected Enhancement** - Support specific video ID selection
  - Backend API update to accept `videoIds: string[]`
  - Remove limit workaround in frontend
  - Transcribe-only mode flag

- [ ] **Analysis Resume** - Continue interrupted batch analysis
  - Check for incomplete analysis on startup
  - "Resume analysis?" prompt
  - State persistence across restarts

### User Experience
- [ ] **Right-Click Context Menu** - Advanced video operations
  - Skip analysis option
  - Open in Finder/Explorer
  - Copy file path
  - Delete from library (with confirmation)

- [ ] **Keyboard Shortcuts** - Library navigation
  - Arrow keys for video selection
  - Enter to open video player
  - Cmd/Ctrl+A to select all
  - Escape to clear selection

---

## Medium Priority

### Library Features
- [ ] **Timeline Visualization** - Visual video history
  - Calendar view of videos by date
  - Heat map of activity
  - Filter by date range

- [ ] **Video Thumbnail Generation** - Visual preview in cards
  - FFmpeg-based thumbnail creation
  - Cache thumbnails in database or file system
  - Lazy loading for performance

- [ ] **Card Grid View** - Alternative to list view
  - Toggle between list and grid layouts
  - Adjustable card size
  - Responsive layout

- [ ] **Manual Tag Editing** - User-defined tags
  - Add/remove tags via UI
  - Tag autocomplete from existing tags
  - Tag color coding

- [ ] **Split View Mode** - Library + Player side-by-side
  - Drag divider to resize panels
  - Quick clip creation workflow
  - Keep library visible during playback

### Search & Filtering
- [ ] **Advanced Search** - Multi-field search
  - Search by filename, tags, transcript, analysis
  - Boolean operators (AND, OR, NOT)
  - Date range filters
  - Duration range filters

- [ ] **Saved Searches** - Bookmark common queries
  - Save search criteria with name
  - Quick access from sidebar
  - Export/import search collections

- [ ] **Tag-Based Filtering** - Combine multiple tags
  - AND/OR logic for tag combinations
  - Tag exclusion (NOT logic)
  - Visual tag selection UI

### Analysis Enhancements
- [ ] **Custom Analysis Prompts** - User-defined analysis instructions
  - Template system for common use cases
  - Save and reuse prompts
  - Share prompt collections

- [ ] **Multi-Language Support** - Transcribe non-English videos
  - Whisper language detection
  - Manual language override
  - Translation support (optional)

- [ ] **Speaker Diarization** - Identify different speakers
  - Whisper timestamps integration
  - Speaker labels in transcript
  - Filter by speaker

---

## Low Priority / Nice-to-Have

### Performance Optimization
- [ ] **Database Indexing** - Optimize common queries
  - Review slow queries
  - Add composite indexes
  - Query profiling

- [ ] **Thumbnail Lazy Loading** - Improve scroll performance
  - Only load visible thumbnails
  - Placeholder images
  - Progressive image loading

- [ ] **Analysis Caching** - Speed up repeat analyses
  - Cache transcript results
  - Reuse transcripts for different analyses
  - Invalidation strategy

### UI/UX Polish
- [ ] **Onboarding Flow** - First-time user experience
  - Welcome screen
  - Quick start wizard
  - Sample video for testing

- [ ] **Tooltips & Help** - Inline documentation
  - Contextual help icons
  - Keyboard shortcut cheat sheet
  - Tutorial videos

- [ ] **Dark Mode Refinement** - Improve dark theme
  - Video player controls styling
  - Better contrast ratios
  - Custom accent colors

### Export & Sharing
- [ ] **Export Library Metadata** - Backup database
  - JSON export of all metadata
  - CSV export for spreadsheet analysis
  - Import from JSON

- [ ] **Clip Collections** - Group related clips
  - Create named collections
  - Add clips to multiple collections
  - Export collection as playlist

- [ ] **Sharing Features** - Collaborate with others
  - Export analysis as PDF/HTML
  - Share clip links (if hosted)
  - Export transcript with timestamps

### Advanced Features
- [ ] **Video Comparison** - Side-by-side playback
  - Sync playback position
  - Compare transcripts
  - Diff analysis reports

- [ ] **Auto-Categorization** - Smart folders
  - Rules-based organization
  - Tag-based auto-folders
  - Content-based grouping

- [ ] **Plugins System** - Extensibility
  - Custom analysis providers
  - Custom tag extractors
  - Custom export formats

---

## Technical Debt

### Code Quality
- [ ] **Remove Old Library System** - Clean up deprecated code
  - Delete old library routes (causing proxy errors)
  - Remove unused components
  - Update documentation

- [ ] **Path Alias Consistency** - Standardize imports
  - Convert remaining `@/` imports to relative paths
  - Or configure proper path resolution with tsconfig-paths
  - Document import style guide

- [ ] **Error Handling** - Improve error messages
  - User-friendly error notifications
  - Better logging for debugging
  - Error recovery strategies

### Testing
- [ ] **Unit Tests** - Core functionality coverage
  - Database service tests
  - File scanner tests
  - Analysis service tests

- [ ] **Integration Tests** - End-to-end workflows
  - Download → Analysis → Clip creation
  - Library scan → Import → Search
  - Tag system tests

- [ ] **E2E Tests** - User interface testing
  - Electron app testing
  - Critical user flows
  - Regression testing

### Documentation
- [ ] **API Documentation** - Backend endpoint docs
  - OpenAPI/Swagger spec
  - Request/response examples
  - Error code reference

- [ ] **Component Documentation** - Frontend component guide
  - Component props and events
  - Usage examples
  - Storybook integration

---

## Known Issues

### Active Bugs
- [x] ~~**Refresh Failed Notification Spam** - Batch status polling errors~~
  - Status: FIXED - Removed error notification toast in [batch-download.component.ts:1737](frontend/src/app/components/batch-download/batch-download.component.ts#L1737)
  - Fix: Silent handling with console.error instead of user-facing toast
  - Context: Backend not ready during frontend initialization

- [x] ~~**better-sqlite3 Module Error** - Native module version mismatch~~
  - Status: FIXED - `npx @electron/rebuild -v 36.0.1 -w better-sqlite3`
  - Note: Must rebuild for Electron (NODE_MODULE_VERSION 135), not regular Node.js

- [x] ~~**Import Manager Wrong UX** - Tried to scan huge clips folder~~
  - Status: FIXED - Changed to direct file picker approach
  - Old approach: Scan folder, show list with checkboxes (too slow)
  - New approach: Direct system file picker for video selection
  - Fix: [library.component.ts:515](frontend/src/app/components/library/library.component.ts#L515)

- [ ] **Backend Startup Failures** - First attempt fails, requires retry
  - Error: "Backend failed to start on first attempt, retrying in 2 seconds..."
  - Impact: Delays app startup by 2+ seconds
  - Status: INVESTIGATING - need to check backend logs

- [ ] **Proxy Errors** - Old library system endpoints failing
  - Routes: `/api/library/analyses?archived=false`, `/api/api/analysis/models`
  - Impact: Low (deprecated system)
  - Fix: Remove old library routes

### Deferred from Phase 5
- [ ] Skip analysis option (right-click menu)
- [ ] Duration filter chips
- [ ] Import Manager UI
- [ ] Fix proxy errors from old library system

---

## Phase 6: Content Discovery & Visualization (NEXT)

**Goal**: Make finding and browsing 5,353+ videos effortless

### Advanced Search
- [ ] Multi-field search (filename + transcript + analysis + tags)
- [ ] Boolean operators (AND, OR, NOT)
- [ ] Date range filters
- [ ] Duration filters
- [ ] Saved searches with names

### Timeline Visualization
- [ ] Calendar view of all videos by date
- [ ] Heat map showing recording activity
- [ ] Scrub through time to find clips
- [ ] Visual date range filtering

### Video Thumbnails
- [ ] FFmpeg-based thumbnail generation
- [ ] Visual preview in video cards
- [ ] Hover preview on timeline
- [ ] Grid view with thumbnails

### Smart Collections
- [ ] Auto-categorization based on tags
- [ ] Rule-based smart folders
- [ ] Tag-based auto-filing

### Manual Tag Editing
- [ ] Add/remove tags via UI
- [ ] Tag autocomplete from existing tags
- [ ] Tag color coding
- [ ] Bulk tag operations

### Split View Mode
- [ ] Library list on left, player on right
- [ ] Quick clip creation without switching views
- [ ] Drag divider to resize panels
- [ ] Keyboard-driven workflow

### File Management & Polish
- [ ] Missing file indicators (⚠️ icon)
- [ ] Auto-relink system on startup
- [ ] "Clean Library" tool to remove missing videos
- [ ] Manual "Sync Library" trigger

**Estimated Time**: 1-2 weeks

---

## Phase 7: Future Ideas (TBD)

Ideas for future enhancements after Phase 6 is complete. Priority and scope to be determined based on actual needs.

---

## Maintenance Tasks

### Regular Updates
- [ ] Update yt-dlp binary (monthly)
- [ ] Update FFmpeg binary (quarterly)
- [ ] Update Whisper models (as needed)
- [ ] Update npm dependencies (monthly)
- [ ] Test on latest Electron version

### Monitoring
- [ ] Database size monitoring
- [ ] Disk space alerts
- [ ] Error rate tracking
- [ ] Performance metrics

---

## Feature Requests

Add new feature requests here with:
- **Description:** What the feature does
- **Priority:** High/Medium/Low
- **Complexity:** Simple/Medium/Complex
- **Dependencies:** Any prerequisites

Example:
- [ ] **Feature Name** - Brief description
  - Priority: Medium
  - Complexity: Medium
  - Dependencies: None
  - Notes: Additional context

---

**Contributing:** To work on any of these items, create a branch following the naming convention:
- Features: `feature/description`
- Fixes: `fix/issue-description`
- Refactoring: `refactor/component-name`

**Questions:** Check [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for project context or [README.md](README.md) for technical details.
