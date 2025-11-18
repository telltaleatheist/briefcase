# Frontend-v3 Implementation Notes

## Overview
This document outlines the new video library page implementation for ClipChimp frontend-v3.

## What Was Built

### 1. Task Models (`src/app/models/task.model.ts`)
- **TaskType**: Enum for all available task types
  - `download-import`: Download from URL and import to library
  - `fix-aspect-ratio`: Fix video aspect ratio issues
  - `normalize-audio`: Normalize audio levels
  - `transcribe`: Generate transcript with Whisper
  - `ai-analyze`: AI content analysis (GPT-4/Claude)

- **Task Interface**: Defines available tasks with metadata
- **JobRequest Interface**: Structure for creating jobs with tasks
- **AVAILABLE_TASKS**: Constant array of all task definitions

### 2. Search/Filter Component (`src/app/components/library-search-filters/`)
**Features:**
- Always-visible search bar with icon
- Collapsible accordion for advanced filters
- Filters include:
  - Date range (all time, today, week, month, year)
  - Has transcript (any/yes/no)
  - Has analysis (any/yes/no)
  - Sort by (date, name, size, duration)
  - Sort order (ascending/descending)
- Clear all filters button
- Emits filter changes to parent component
- Responsive design (mobile-friendly)

**Files:**
- `library-search-filters.component.ts`
- `library-search-filters.component.html`
- `library-search-filters.component.scss`

### 3. Task Selection Modal (`src/app/components/task-selection-modal/`)
**Features:**
- Two modes: URL input or file selection
- Dynamic task list based on input type:
  - URL mode: Shows download-import + processing tasks
  - File mode: Only shows processing tasks (no download)
- URL input field with placeholder and hint
- Selected files count display
- Task checkboxes with icons and descriptions
- Submit button shows task count
- Modal backdrop with click-to-close
- Validation (can't submit without URL/files and tasks selected)

**Files:**
- `task-selection-modal.component.ts`
- `task-selection-modal.component.html`
- `task-selection-modal.component.scss`

### 4. Library Page Component (`src/app/pages/library/`)
**Features:**
- Main entry point for the application
- Page header with title and action buttons:
  - "Process Selected" button (shows count badge)
  - "Add from URL" button (primary action)
- Search/filter section at top
- Video library list at bottom (using existing video-library component)
- Empty state with helpful message
- Handles modal opening for both URL and file processing
- Integrates with LibraryService (stub)
- Responsive layout

**Files:**
- `library-page.component.ts`
- `library-page.component.html`
- `library-page.component.scss`

### 5. Library Service (`src/app/services/library.service.ts`)
**API Methods (currently stubs, ready for backend integration):**
- `loadVideos()`: Get all videos
- `getVideosByWeek()`: Get videos organized by week
- `searchVideos(query)`: Search video library
- `getVideo(id)`: Get single video with details
- `deleteVideo(id)`: Delete video from library
- `createJob(request)`: Create new job with tasks
- `quickAddUrl(url, title)`: Quick add using default preset
- `getQueueStatus()`: Get queue processing status
- `updateVideoFilename(id, filename)`: Update video filename

**State Management:**
- `videos` signal
- `selectedIds` signal
- `loading` signal
- `error` signal

**Helper Methods:**
- `selectVideo(id)`
- `deselectVideo(id)`
- `toggleVideoSelection(id)`
- `clearSelection()`
- `isVideoSelected(id)`

### 6. Routing Updates (`src/app/app.routes.ts`)
**Changes:**
- Removed routes: `/dashboard`, `/components`, `/gallery`, `/files`, `/home`
- Kept routes: `/editor` (video editor - to be fixed later)
- New routes:
  - `/` → Library page (default)
  - `/library` → Library page (explicit)

### 7. Navigation Updates (`src/app/core/navigation/navigation.component.ts`)
**Changes:**
- Simplified nav links to only show:
  - Video Library (📹)
  - Video Editor (🎬)

## User Flow

### Adding Videos from URL
1. User lands on Library page
2. Clicks "Add from URL" button
3. Modal opens in URL mode
4. User enters video URL
5. User selects tasks to perform:
   - Download and Import (required, pre-selected)
   - Transcribe
   - AI Analyze
6. Clicks "Start Processing"
7. Job is created and sent to backend queue

### Processing Existing Files
1. User selects one or more videos from the library list
2. Clicks "Process Selected" button (shows count)
3. Modal opens in files mode
4. User selects tasks to perform:
   - Fix Aspect Ratio
   - Normalize Audio
   - Transcribe
   - AI Analyze
5. Clicks "Start Processing"
6. Job is created for each selected file

### Filtering and Search
1. User types in search bar (live filter)
2. User clicks "Filters" to expand accordion
3. User adjusts date range, transcript status, analysis status, sort order
4. Results update automatically
5. User can clear all filters with one click

## Backend Integration TODO

The `LibraryService` has all methods stubbed with the correct interfaces. To integrate with the NestJS backend:

1. **Uncomment HTTP calls** in `library.service.ts`
2. **Update API base URL** if different from `http://localhost:3001/api`
3. **Add HttpClientModule** to app config if not already present
4. **Handle errors** with proper error handling and user feedback
5. **Add WebSocket** integration for real-time task progress updates
6. **Remove mock data** from components once API is connected

### Backend Endpoints Expected

Based on the backend plan document:

```
GET    /api/library/videos              - List all videos
GET    /api/library/videos/:id          - Get single video
GET    /api/library/search?q=...        - Search videos
DELETE /api/library/videos/:id          - Delete video
PATCH  /api/library/videos/:id          - Update video
POST   /api/queue/jobs                  - Create job with tasks
POST   /api/queue/quick-add             - Quick add from URL
GET    /api/queue/status                - Get queue status
```

## Component Architecture

```
LibraryPage
├── LibrarySearchFilters
│   ├── Search input (always visible)
│   └── Advanced filters (accordion)
├── VideoLibrary (existing component)
│   ├── Week grouping
│   ├── Video items
│   ├── Context menus
│   └── Selection management
└── TaskSelectionModal
    ├── URL input (conditional)
    ├── File count display (conditional)
    └── Task selection list
```

## Styling

All components use:
- CSS custom properties for theming (`--primary-orange`, `--bg-card`, etc.)
- Responsive design with mobile breakpoints
- Smooth transitions and animations
- Consistent spacing and typography
- Dark mode support via theme service

## Next Steps

1. **Test the frontend**: Run `npm start` in frontend-v3
2. **Integrate backend**: When backend is ready, update LibraryService
3. **Add WebSocket**: For real-time task progress
4. **Fix video editor**: As mentioned, needs work later
5. **Add more features**:
   - Batch selection controls (select all, deselect all)
   - Advanced video player
   - Video details/preview modal
   - Download progress indicators
   - Queue management UI

## Build Status

✅ Build successful (with minor CSS budget warnings)
- Task selection modal: 4.19 kB (199 bytes over)
- Video library: 4.78 kB (798 bytes over)
- Navigation: 4.10 kB (103 bytes over)

These warnings are acceptable and can be addressed later if needed.
