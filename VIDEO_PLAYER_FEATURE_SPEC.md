# Video Player & Clip Management Feature Specification

**Project**: Clippy
**Date**: 2025-11-03 (Updated: 2025-11-03)
**Purpose**: Comprehensive specification for adding in-app video playback, timeline editing, and clip management features

---

## 🎯 Implementation Status

### ✅ COMPLETED (Phases 1-3)

**Phase 1: File-Based Library Foundation** ✅
- Created LibraryService with atomic writes & file locking
- Implemented library.json master index system
- Built analysis metadata parser (txt → json)
- Auto-integration with AnalysisService
- Storage: `~/Library/Application Support/clippy/`

**Phase 2: Analysis Reports UI with Archive** ✅
- Frontend LibraryService with full REST API integration
- Active/Archived tabs with Material UI
- Archive/unarchive functionality
- Category badges with dynamic colors
- Video link status indicators
- "Manage Clips" button (placeholder)

**Phase 3: Video Relinking System** ✅
- Backend RelinkService with fuzzy matching
- Levenshtein distance + token overlap algorithm
- Auto-search clips collection by week folder
- Confidence scoring (high/medium/low)
- ReLink Dialog component with beautiful UI
- Candidate list with color-coded confidence bars
- Manual file picker fallback

### 🚧 IN PROGRESS

**Phase 4: Video Player Component** ⏳ NEXT
- Need to implement Video.js integration
- Basic playback controls
- Load videos from library
- Spacebar play/pause

### 📋 TODO (Phases 5-8)

**Phase 5**: Timeline with range selection (FCPX-style)
**Phase 6**: AI markers on timeline
**Phase 7**: Clip creation backend (FFmpeg)
**Phase 8**: Clip creation UI

---

## 📁 Key Files Created

### Backend (`/backend/src/library/`)
- `library.service.ts` - Core library management
- `relink.service.ts` - Video relinking with fuzzy matching
- `library.controller.ts` - REST API endpoints
- `library.module.ts` - NestJS module
- `interfaces/library.interface.ts` - TypeScript types
- `parsers/analysis-parser.ts` - Report parsing

### Frontend (`/frontend/src/app/`)
- `services/library.service.ts` - API client
- `components/analysis-reports/` - Main UI (updated)
- `components/relink-dialog/` - Relinking dialog

### Modified Files
- `backend/src/analysis/analysis.service.ts` - Auto-add to library
- `backend/src/analysis/analysis.module.ts` - Import LibraryModule
- `backend/src/app.module.ts` - Register LibraryModule
- `frontend/src/app/app.config.ts` - Add HttpClient

---

## 🔗 API Endpoints Implemented

```typescript
// Library Management
GET    /api/library/analyses?archived=true|false
GET    /api/library/analyses/:id
GET    /api/library/analyses/:id/metadata
POST   /api/library/analyses
PATCH  /api/library/analyses/:id
DELETE /api/library/analyses/:id

// Clips
GET    /api/library/analyses/:id/clips
GET    /api/library/clips/:id
POST   /api/library/clips
DELETE /api/library/clips/:id

// Relinking
POST   /api/library/analyses/:id/auto-relink
POST   /api/library/analyses/:id/manual-relink
POST   /api/library/verify-all
GET    /api/library/search-clips?filename=

// Utilities
GET    /api/library/stats
GET    /api/library/paths
```

---

## Table of Contents

1. [Overview](#overview)
2. [Current State](#current-state)
3. [Feature Requirements](#feature-requirements)
4. [File-Based Architecture](#file-based-architecture)
5. [Video Player & Timeline UI](#video-player--timeline-ui)
6. [Analysis Reports Management](#analysis-reports-management)
7. [Clip Creation Workflow](#clip-creation-workflow)
8. [Video Relinking System](#video-relinking-system)
9. [Clips Collection Integration](#clips-collection-integration)
10. [Implementation Phases](#implementation-phases)
11. [Technical Decisions](#technical-decisions)

---

## Overview

Add a professional video editing interface to Clippy that allows:
- Playing back analyzed videos in-app
- Visual timeline with AI-identified markers
- FCPX-style range selection for creating clips
- Organizing and archiving analysis reports
- Linking analyses to existing clips collection
- Long-term storage and searchability of transcripts and analyses

---

## Current State

### Video Analysis Flow
1. User downloads video via yt-dlp (360p MP4) to `~/Downloads/clippy/videos/`
2. Whisper transcribes video → SRT + TXT files in `~/Downloads/clippy/analysis/transcripts/`
3. AI analyzes transcript → categorized sections with timestamps → `~/Downloads/clippy/analysis/reports/`
4. UI displays analysis report with sections, timestamps (MM:SS format), quotes

### Data Structures

**Analysis Report Format** (text file):
```
TIME RANGE: 00:09 - 00:12
CATEGORY: violence
DESCRIPTION: Description text...

KEY QUOTES:
- [00:09] "Quote text" - Significance explanation
```

**Backend AnalysisJob:**
```typescript
{
  id: string;
  status: 'pending' | 'downloading' | 'extracting' | 'transcribing' | 'analyzing' | 'completed' | 'failed';
  videoPath?: string;
  transcriptPath?: string;
  analysisPath?: string;
}
```

### Existing Clips Collection

Located at: `/Volumes/Callisto/clips/`

**Structure:**
```
/Volumes/Callisto/clips/
├── 2021-08-08/
│   ├── 2021-08-T1 video title one.mov
│   ├── 2021-08-T1 video title two.mov
│   └── 2020 older video.mp4
├── 2021-08-15/
│   └── ...
└── 2021-08-22/
    └── ...
```

- Organized by week (Sunday-based, YYYY-MM-DD format)
- Contains years of existing clips (since 2021)
- Mix of .mov and .mp4 files
- User moves finished clips from Clippy's download folder to appropriate week folder

---

## Feature Requirements

### 1. Video Player with Range Selection Timeline

**Core Interaction Model** (Final Cut Pro X-style):

- **Timeline**: Scrollable timeline spanning entire video duration
- **Selection Window**: Draggable range with left and right handles
  - Dragging left handle: Video seeks to that position and pauses
  - Dragging right handle: Video seeks to that position and pauses
  - Clicking within window: Seek to that position
- **Playback Controls**:
  - Spacebar: Play/Pause toggle
  - Standard video controls (play, pause, seek)
- **AI Markers**: Color-coded markers on timeline showing analyzed sections
  - Colors represent categories but no explicit labels on timeline
  - Hover shows tooltip with section info
- **Clip Button**: Appears when range is selected
  - Generates clip using FFmpeg from selected range

### 2. Analysis Reports Management

**Active Reports View** (default working area):
- List of current/active analysis reports
- Each report card shows:
  - Video thumbnail (optional)
  - Title and date
  - Brief analysis summary
  - **"Manage Clips"** button → Opens video player + timeline interface
  - **"Archive"** button → Moves report to archive
  - **"Relink Video"** button → Manual relinking if video path is broken

**Archived Reports View** (separate tab/section):
- All archived analyses for long-term storage
- Search and filter capabilities:
  - Text search (searches titles, transcripts, analysis content)
  - Date range filter
  - Category filter (dynamic based on what's in analyses)
  - Week folder filter
- Same management options as active reports
- Can unarchive back to active view

### 3. Clip Creation

**Workflow:**
1. User opens "Manage Clips" for an analysis
2. Video player loads with timeline and markers
3. User drags selection window to desired range
4. User previews by playing from different points
5. User clicks "Create Clip" button
6. Dialog prompts for:
   - Clip name (pre-filled with intelligent default)
   - Save location:
     - Temp folder: `~/Downloads/clippy/clips/`
     - Or directly to clips collection week folder
7. FFmpeg extracts clip (copy codec for speed: `-c copy`)
8. Clip metadata saved to library.json
9. Success notification with option to open in Finder

### 4. Future-Proofing for Search

**Requirements:**
- Store analyses and transcripts separately from video files
- Maintain references/links between analyses and videos
- Enable future full-text search across all transcripts
- Allow rebuilding entire clips collection database from scratch if needed
- Support for massive scale (years of clips, thousands of analyses)

---

## File-Based Architecture

**Decision**: No database - pure file-based system for portability, simplicity, and backup-friendliness

### Storage Structure

```
~/Library/Application Support/clippy/
├── library.json                    # Master index (the "glue")
├── analyses/
│   ├── <analysis-id>.txt          # Analysis reports (existing format)
│   └── <analysis-id>.json         # Parsed structured metadata
├── transcripts/
│   ├── <analysis-id>.srt          # Whisper transcripts with timestamps
│   └── <analysis-id>.txt          # Plain text transcripts
└── clips/
    └── <clip-id>.json             # Clip metadata (references actual video)
```

### library.json Schema

**Purpose**: Master index linking all analyses, videos, transcripts, and clips

```json
{
  "version": "1.0",
  "lastUpdated": "2025-11-03T10:30:00Z",
  "analyses": [
    {
      "id": "uuid-v4",
      "title": "2024-01-15 [Video Title]",
      "createdAt": "2024-01-15T14:30:00Z",
      "archived": false,

      "video": {
        "originalPath": "/Users/telltale/Downloads/clippy/videos/2024-01-15 [Title].mp4",
        "currentPath": "/Volumes/Callisto/clips/2024-01-14/2024-01-T1 video title.mov",
        "clipsWeekFolder": "2024-01-14",
        "filename": "2024-01-T1 video title.mov",
        "durationSeconds": 1234.5,
        "isLinked": true,
        "lastVerified": "2025-11-03T10:00:00Z"
      },

      "files": {
        "analysis": "analyses/<analysis-id>.txt",
        "analysisMetadata": "analyses/<analysis-id>.json",
        "transcriptSrt": "transcripts/<analysis-id>.srt",
        "transcriptTxt": "transcripts/<analysis-id>.txt"
      },

      "metadata": {
        "analysisModel": "claude-3-5-sonnet-20241022",
        "transcriptionModel": "whisper-large",
        "categories": ["violence", "conspiracy"]
      },

      "clips": ["clip-id-1", "clip-id-2"]
    }
  ],

  "clips": {
    "clip-id-1": {
      "id": "uuid-v4",
      "analysisId": "parent-analysis-uuid",
      "name": "Custom clip name",
      "startSeconds": 45.0,
      "endSeconds": 120.5,
      "outputPath": "/Volumes/Callisto/clips/2024-01-14/2024-01-T1 clip name.mov",
      "createdAt": "2025-11-03T10:15:00Z",
      "notes": ""
    }
  }
}
```

### Per-Analysis Metadata JSON

**File**: `analyses/<analysis-id>.json`
**Purpose**: Structured, parseable version of analysis report for fast loading

```json
{
  "id": "uuid-v4",
  "title": "2024-01-15 [Video Title]",
  "createdAt": "2024-01-15T14:30:00Z",
  "durationSeconds": 1234.5,

  "sections": [
    {
      "timeRange": "00:09 - 00:12",
      "startSeconds": 9.0,
      "endSeconds": 12.0,
      "category": "violence",
      "description": "Description of what happens in this section...",
      "quotes": [
        {
          "timestamp": "00:09",
          "timestampSeconds": 9.0,
          "text": "The actual quote text from the transcript",
          "significance": "Why this quote matters / context"
        }
      ]
    }
  ]
}
```

### File Operations

**Creating New Analysis:**
1. Generate UUID for analysis
2. Save analysis report: `analyses/<id>.txt`
3. Save transcripts: `transcripts/<id>.srt` and `.txt`
4. Parse report → generate `analyses/<id>.json`
5. Add entry to `library.json`
6. Atomic write of `library.json`

**Archiving Analysis:**
1. Load `library.json`
2. Find analysis by ID
3. Set `archived: true`
4. Atomic write of `library.json`

**Relinking Video:**
1. Load `library.json`
2. Update `video.currentPath` and `video.isLinked`
3. Update `video.lastVerified`
4. Atomic write of `library.json`

**Creating Clip:**
1. Generate UUID for clip
2. Run FFmpeg to extract video segment
3. Add clip entry to `library.json` → `clips` object
4. Add clip ID to parent analysis's `clips` array
5. Atomic write of `library.json`

### Atomic Write Pattern

**Critical**: Multiple processes may access library.json simultaneously

```typescript
async updateLibrary(updateFn: (library: Library) => Library): Promise<void> {
  const release = await lock(this.libraryPath);

  try {
    // 1. Create backup
    await fs.copyFile(this.libraryPath, `${this.libraryPath}.backup`);

    // 2. Read latest version
    const library = await this.loadLibrary();

    // 3. Apply modification
    const updated = updateFn(library);

    // 4. Atomic write (write to temp, then rename)
    const tempPath = `${this.libraryPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(updated, null, 2));
    await fs.rename(tempPath, this.libraryPath);

    // 5. Update in-memory cache
    this.library = updated;
  } finally {
    await release();
  }
}
```

**Libraries needed:**
- `proper-lockfile` for file locking
- Built-in `fs/promises` for file operations

---

## Video Player & Timeline UI

### Component Architecture

**New Components:**
```
frontend/src/app/components/
├── video-player/
│   ├── video-player.component.ts
│   ├── video-player.component.html
│   ├── video-player.component.scss
│   ├── video-player.service.ts
│   └── timeline/
│       ├── timeline.component.ts
│       ├── timeline.component.html
│       └── timeline.component.scss
```

### Video Player Technology Stack

**Primary Option: Video.js**
- Industry-standard HTML5 video player
- Plugin ecosystem for markers
- TypeScript support
- Electron-compatible
- Customizable controls

**Installation:**
```bash
npm install video.js @types/video.js
npm install videojs-markers  # For timeline markers plugin
```

**Alternative**: Custom HTML5 `<video>` element if more control needed

### Timeline Requirements

**Visual Elements:**
- Horizontal scrollable timeline spanning video duration
- Zoom controls (adjust time scale)
- Current playback position indicator (vertical line)
- Selection window (draggable box with left/right handles)
- AI analysis markers (colored dots/bars)
- Optional: thumbnail strip for visual reference

**Interaction Behaviors:**

| Action | Result |
|--------|--------|
| Drag left handle | Video seeks to new start position, pauses |
| Drag right handle | Video seeks to new end position, pauses |
| Click within selection | Video seeks to clicked position |
| Spacebar | Toggle play/pause |
| Click marker | Seek to marker position |
| Scroll timeline | Pan through video timeline |
| Zoom in/out | Adjust time scale (seconds per pixel) |

**Marker Display:**
- Each analysis section = one marker on timeline
- Color-coded by category (but no labels)
- Positioned at section start time
- Hover tooltip shows:
  - Time range
  - Category name
  - Brief description
- Click to seek video to that position

### Timeline Implementation Options

**Option A: Custom D3.js Timeline**
- Full control over appearance
- Smooth interactions
- Steep learning curve
- Best for pixel-perfect custom design

**Option B: Wavesurfer.js with Regions Plugin**
- Audio waveform visualization (bonus!)
- Built-in regions plugin for range selection
- Easy to implement markers
- Good community support

**Option C: Video.js + Custom Overlay**
- Use video.js for player
- Build custom timeline overlay with vanilla JS/Canvas
- Moderate complexity

**Recommended**: Start with **Wavesurfer.js** for speed, fall back to custom if needed

### Keyboard Shortcuts (FCPX-inspired)

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| J/K/L | Rewind/Pause/Forward |
| I | Set in point (selection start) |
| O | Set out point (selection end) |
| Left/Right Arrow | Frame step (or 1-second step) |
| Shift + Arrow | Jump to next/previous marker |

---

## Analysis Reports Management

### UI Layout Changes

**Current Layout:**
- Single list view showing all reports

**New Layout:**

```
┌─────────────────────────────────────────────┐
│  Analysis Reports                           │
│  [Active] [Archived]              [Search]  │
├─────────────────────────────────────────────┤
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │ 2024-01-15 [Video Title]            │  │
│  │ Created: Jan 15, 2024               │  │
│  │ Duration: 20:34                     │  │
│  │ Categories: violence, conspiracy    │  │
│  │                                      │  │
│  │ [Manage Clips] [Archive] [Relink]  │  │
│  └──────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │ 2024-01-10 [Another Video]          │  │
│  │ ...                                  │  │
│  └──────────────────────────────────────┘  │
│                                              │
└─────────────────────────────────────────────┘
```

### Button Actions

**"Manage Clips" Button:**
- Opens new view/modal with:
  - Video player (top)
  - Timeline with selection (middle)
  - Analysis sections sidebar (right)
  - Clip creation controls (bottom)

**"Archive" Button:**
- Sets `archived: true` in library.json
- Removes from active view
- Moves to archived view
- Shows toast notification: "Analysis archived"

**"Relink Video" Button:**
- Only visible if `video.isLinked === false`
- Opens file picker dialog
- User selects new video location
- Updates `video.currentPath` in library.json
- Verifies video duration matches
- Shows success/error notification

### Archived View

**Additional Features:**
- Search bar (searches title, transcript text, analysis content)
- Filters:
  - Date range picker
  - Category multi-select
  - Week folder dropdown
- Sort options:
  - Date (newest/oldest)
  - Title (A-Z)
  - Duration
- "Unarchive" button on each report

### Search Implementation

**Search Algorithm** (in-memory, no database):
```typescript
searchAnalyses(query: string, filters: SearchFilters): Analysis[] {
  return this.library.analyses
    .filter(a => filters.archived === null || a.archived === filters.archived)
    .filter(a => {
      // Text search
      if (query) {
        const titleMatch = a.title.toLowerCase().includes(query.toLowerCase());
        const transcriptContent = fs.readFileSync(a.files.transcriptTxt, 'utf-8');
        const transcriptMatch = transcriptContent.toLowerCase().includes(query.toLowerCase());
        const analysisContent = fs.readFileSync(a.files.analysis, 'utf-8');
        const analysisMatch = analysisContent.toLowerCase().includes(query.toLowerCase());

        if (!titleMatch && !transcriptMatch && !analysisMatch) {
          return false;
        }
      }

      // Date range filter
      if (filters.dateFrom && new Date(a.createdAt) < filters.dateFrom) {
        return false;
      }
      if (filters.dateTo && new Date(a.createdAt) > filters.dateTo) {
        return false;
      }

      // Category filter
      if (filters.categories?.length > 0) {
        const hasCategory = filters.categories.some(cat =>
          a.metadata.categories.includes(cat)
        );
        if (!hasCategory) return false;
      }

      return true;
    });
}
```

**Performance Note**: For large collections (thousands of analyses), consider:
- Caching transcript content in memory on startup
- Debouncing search input
- Lazy loading search results (paginate)

---

## Clip Creation Workflow

### User Flow

1. **User clicks "Manage Clips"** → Opens video player view
2. **Video loads** with timeline showing full duration
3. **AI markers appear** on timeline (colored, positioned)
4. **User drags selection window** to desired range
   - Left handle: set start point
   - Right handle: set end point
   - Video seeks to handle positions during drag
5. **User previews** by clicking play within selection
6. **User clicks "Create Clip" button**
7. **Dialog appears:**
   ```
   ┌─────────────────────────────────────────┐
   │ Create Clip                             │
   ├─────────────────────────────────────────┤
   │ Clip Name:                              │
   │ [2024-01-15 Video Title 00:09-00:45]    │
   │                                          │
   │ Save Location:                           │
   │ ○ Temp folder (~/Downloads/clippy/clips)│
   │ ● Clips collection (auto-week)          │
   │   /Volumes/Callisto/clips/2024-01-14/   │
   │                                          │
   │ Duration: 36 seconds                     │
   │                                          │
   │        [Cancel]  [Create Clip]          │
   └─────────────────────────────────────────┘
   ```
8. **FFmpeg runs** to extract clip
9. **Progress notification** shows extraction progress
10. **Success notification** with "Open in Finder" button
11. **Clip added** to library.json → clips collection
12. **Clip appears** in clips list for this analysis

### FFmpeg Clip Extraction

**Command:**
```bash
ffmpeg -i input.mp4 \
  -ss 00:00:09.0 \
  -to 00:00:45.5 \
  -c copy \
  output.mp4
```

**Parameters:**
- `-ss`: Start time (seconds or HH:MM:SS.ms)
- `-to`: End time (not duration!)
- `-c copy`: Copy codec (fast, no re-encoding)
- Use `-c:v libx264 -c:a aac` if copy fails

**Backend Implementation:**
```typescript
async createClip(request: CreateClipRequest): Promise<Clip> {
  const { analysisId, startSeconds, endSeconds, name, savePath } = request;

  const analysis = await this.getAnalysis(analysisId);
  const clipId = uuidv4();

  const outputPath = path.join(
    savePath,
    `${name}.${path.extname(analysis.video.currentPath)}`
  );

  // Run FFmpeg
  await this.ffmpegService.extractClip({
    inputPath: analysis.video.currentPath,
    outputPath: outputPath,
    startSeconds: startSeconds,
    endSeconds: endSeconds
  });

  // Add to library
  const clip: Clip = {
    id: clipId,
    analysisId: analysisId,
    name: name,
    startSeconds: startSeconds,
    endSeconds: endSeconds,
    outputPath: outputPath,
    createdAt: new Date().toISOString(),
    notes: ''
  };

  await this.libraryService.addClip(clip);

  return clip;
}
```

### Clip Naming Convention

**Default Format:**
```
[Date] [Video Title] [Start]-[End]

Example:
2024-01-15 Pastor preaches conspiracy 00:09-00:45
```

**User can customize** before creating clip

### Clips List in Analysis View

When viewing analysis details, show list of clips:

```
Clips Created (2)
┌────────────────────────────────────────┐
│ 00:09 - 00:45 (36s)                   │
│ Pastor preaches conspiracy             │
│ /Volumes/Callisto/clips/2024-01-14/   │
│ [Open in Finder] [Play] [Delete]      │
└────────────────────────────────────────┘
```

---

## Video Relinking System

### The Problem

Videos move from:
- **Original**: `~/Downloads/clippy/videos/2024-01-15 [Title].mp4`
- **Final**: `/Volumes/Callisto/clips/2024-01-14/2024-01-T1 Title.mov`

Need to maintain link between analysis and video after moving.

### Auto-Relinking Algorithm

**Triggered**: When user opens analysis and `video.isLinked === false`

**Steps:**
1. Calculate expected week folder from analysis date
2. Search in `/Volumes/Callisto/clips/[week-folder]/` for matching files
3. Match criteria:
   - Filename similarity (fuzzy match on title)
   - File size within 10% of original
   - Duration matches within 1 second (requires FFprobe check)
4. If single match found → prompt user to confirm
5. If multiple matches → show list for user to select
6. If no matches → prompt manual selection

**Implementation:**
```typescript
async autoRelinkVideo(analysisId: string): Promise<RelinkResult> {
  const analysis = await this.getAnalysis(analysisId);

  // Calculate expected week folder
  const weekFolder = this.calculateWeekFolder(new Date(analysis.createdAt));
  const weekPath = `/Volumes/Callisto/clips/${weekFolder}`;

  if (!fs.existsSync(weekPath)) {
    return { success: false, reason: 'Week folder not found' };
  }

  // Get all video files in week folder
  const files = fs.readdirSync(weekPath)
    .filter(f => /\.(mp4|mov)$/i.test(f));

  // Score each file by similarity
  const candidates = files.map(filename => {
    const titleSimilarity = this.fuzzyMatch(
      analysis.title,
      filename
    );

    const fullPath = path.join(weekPath, filename);
    const stats = fs.statSync(fullPath);

    return {
      filename,
      fullPath,
      score: titleSimilarity,
      size: stats.size
    };
  }).sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { success: false, reason: 'No video files in week folder' };
  }

  // If top match is very confident, suggest it
  if (candidates[0].score > 0.8) {
    return {
      success: true,
      suggestedPath: candidates[0].fullPath,
      confidence: 'high'
    };
  }

  // Otherwise, return list of candidates for user to choose
  return {
    success: true,
    candidates: candidates.slice(0, 5),
    confidence: 'low'
  };
}
```

### Manual Relinking

**UI Flow:**
1. User clicks "Relink Video" button
2. File picker opens (native Electron dialog)
3. User selects video file
4. App verifies:
   - File exists
   - Is a video file
   - Duration matches (optional, via FFprobe)
5. Updates library.json:
   - `video.currentPath` = new path
   - `video.isLinked` = true
   - `video.lastVerified` = current timestamp
6. Success notification

### Week Folder Calculation

**Algorithm**: Sunday-based weeks (as observed in clips collection)

```typescript
function calculateWeekFolder(date: Date): string {
  // Clone date to avoid mutation
  const d = new Date(date);

  // Get the Sunday of this week
  const dayOfWeek = d.getDay(); // 0 = Sunday
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - dayOfWeek);

  // Format as YYYY-MM-DD
  return sunday.toISOString().split('T')[0];
}

// Examples:
// 2024-01-15 (Monday) → 2024-01-14 (Sunday)
// 2024-01-14 (Sunday) → 2024-01-14 (Sunday)
// 2024-01-20 (Saturday) → 2024-01-14 (Sunday)
```

### Periodic Verification

**Optional Background Task:**
- Run nightly or on app startup
- Check all `isLinked === true` analyses
- Verify video files still exist at `currentPath`
- If not found, set `isLinked = false` and trigger auto-relink
- Update `lastVerified` timestamps

---

## Clips Collection Integration

### Existing Collection Structure

```
/Volumes/Callisto/clips/
├── 2021-08-08/         # Sunday of each week
│   ├── 2021-08-T1 video one.mov
│   ├── 2021-08-T1 video two.mov
│   └── 2020 older video.mp4
├── 2021-08-15/
├── 2021-08-22/
└── ...
```

### Integration Points

**1. Save Clips Directly to Collection:**
- When creating clip, offer option to save directly to week folder
- Auto-calculate correct week based on analysis date
- No need to manually move files

**2. Reference Existing Clips:**
- User can browse existing clips collection
- Select videos to import into Clippy for analysis
- Creates analysis record pointing to existing video location

**3. Export Analysis Metadata:**
- Optional: Export `analyses/<id>.json` alongside video in clips folder
- Useful for future features: search entire collection by content

### Proposed File Naming Convention

**For newly created clips:**
```
YYYY-MM-DD [Title] [HH:MM-HH:MM].mov

Example:
2024-01-15 Pastor preaches conspiracy 00:09-00:45.mov
```

Matches existing convention observed in collection.

### Future: Collection-Wide Search

**Vision**: Search across all videos in clips collection using stored analyses

**Architecture** (for future implementation):
1. When video is moved to clips collection, keep analysis metadata
2. Option to "Generate Analysis Index" that scans entire collection
3. Reads all `analyses/<id>.json` files
4. Builds searchable index of all transcripts
5. Search returns:
   - Video filename
   - Week folder
   - Matching timestamp
   - Quote/context

**Not included in this implementation**, but architecture supports it.

---

## Implementation Phases

### Phase 1: File-Based Library Foundation
**Goal**: Set up file structure and library.json management

**Tasks:**
- [ ] Create LibraryService (load/save library.json)
- [ ] Implement atomic write pattern with file locking
- [ ] Define TypeScript interfaces for library schema
- [ ] Create analysis metadata parser (txt → json)
- [ ] Set up file paths (`~/Library/Application Support/clippy/`)
- [ ] Build migration script to import existing analyses
- [ ] Add archive/unarchive functionality
- [ ] Update AnalysisService to save to new structure

**Files to create/modify:**
- `backend/src/library/library.service.ts`
- `backend/src/library/library.module.ts`
- `backend/src/library/interfaces/library.interface.ts`
- `backend/src/library/parsers/analysis-parser.ts`
- `backend/src/library/migration/migrate-existing.ts`

**Estimated time**: 2-3 days

---

### Phase 2: Analysis Reports UI Updates
**Goal**: Add archive functionality and improve reports UI

**Tasks:**
- [ ] Update analysis-reports component with active/archived tabs
- [ ] Add "Archive" button to each report card
- [ ] Add "Manage Clips" button (placeholder for now)
- [ ] Add "Relink Video" button (shows only if unlinked)
- [ ] Implement archive/unarchive actions
- [ ] Add search bar with filters
- [ ] Build archived reports view with search
- [ ] Update backend to serve archived vs active analyses

**Files to create/modify:**
- `frontend/src/app/components/analysis-reports/analysis-reports.component.ts`
- `frontend/src/app/components/analysis-reports/analysis-reports.component.html`
- `frontend/src/app/components/analysis-reports/analysis-reports.component.scss`
- `frontend/src/app/services/library.service.ts`
- `backend/src/library/library.controller.ts`

**Estimated time**: 2-3 days

---

### Phase 3: Video Relinking System
**Goal**: Detect broken video paths and allow relinking

**Tasks:**
- [ ] Implement week folder calculation utility
- [ ] Build auto-relink algorithm (fuzzy filename matching)
- [ ] Add FFprobe duration check for verification
- [ ] Create relink dialog component
- [ ] Implement manual file picker relinking
- [ ] Add verification status indicator to reports
- [ ] Build background verification task (optional)

**Files to create/modify:**
- `backend/src/library/relink.service.ts`
- `backend/src/library/utils/week-calculator.ts`
- `frontend/src/app/components/relink-dialog/relink-dialog.component.ts`
- `backend/src/library/library.controller.ts` (add relink endpoint)

**Estimated time**: 2-3 days

---

### Phase 4: Video Player Component
**Goal**: Basic video playback with controls

**Tasks:**
- [ ] Install Video.js and TypeScript types
- [ ] Create video-player component
- [ ] Implement file:// protocol video loading for Electron
- [ ] Add basic playback controls (play, pause, seek)
- [ ] Implement spacebar play/pause shortcut
- [ ] Add video loading/error states
- [ ] Create video player service for state management
- [ ] Wire up "Manage Clips" button to open player

**Files to create:**
- `frontend/src/app/components/video-player/video-player.component.ts`
- `frontend/src/app/components/video-player/video-player.component.html`
- `frontend/src/app/components/video-player/video-player.component.scss`
- `frontend/src/app/services/video-player.service.ts`

**Estimated time**: 2-3 days

---

### Phase 5: Timeline with Range Selection
**Goal**: FCPX-style timeline with draggable selection window

**Tasks:**
- [ ] Choose timeline library (Wavesurfer.js or custom)
- [ ] Create timeline component
- [ ] Implement scrollable timeline spanning video duration
- [ ] Add selection window with left/right drag handles
- [ ] Implement drag behaviors:
  - Drag left handle → seek and pause
  - Drag right handle → seek and pause
  - Click within window → seek
- [ ] Add zoom controls (adjust time scale)
- [ ] Display current playback position indicator
- [ ] Sync timeline with video playback
- [ ] Add keyboard shortcuts (spacebar, I/O for in/out points)

**Files to create:**
- `frontend/src/app/components/video-player/timeline/timeline.component.ts`
- `frontend/src/app/components/video-player/timeline/timeline.component.html`
- `frontend/src/app/components/video-player/timeline/timeline.component.scss`

**Estimated time**: 3-4 days

---

### Phase 6: AI Analysis Markers on Timeline
**Goal**: Display analysis sections as colored markers on timeline

**Tasks:**
- [ ] Load analysis metadata JSON for current video
- [ ] Parse sections and convert MM:SS timestamps to seconds
- [ ] Render markers on timeline at correct positions
- [ ] Color-code markers by category (use consistent color palette)
- [ ] Add hover tooltips showing section info
- [ ] Implement click-to-seek on markers
- [ ] Add marker to analysis section sync (highlight current section)

**Files to modify:**
- `frontend/src/app/components/video-player/timeline/timeline.component.ts`
- `frontend/src/app/services/video-player.service.ts`

**Estimated time**: 2 days

---

### Phase 7: Clip Creation Backend
**Goal**: FFmpeg clip extraction service

**Tasks:**
- [ ] Create ClipsService in backend
- [ ] Implement FFmpeg clip extraction method
- [ ] Add progress reporting via WebSocket
- [ ] Create REST endpoint for clip creation
- [ ] Implement clip metadata storage in library.json
- [ ] Add error handling (FFmpeg failures, disk space, etc.)
- [ ] Create ClipsController

**Files to create:**
- `backend/src/clips/clips.service.ts`
- `backend/src/clips/clips.controller.ts`
- `backend/src/clips/clips.module.ts`
- `backend/src/clips/interfaces/clip.interface.ts`

**Estimated time**: 2 days

---

### Phase 8: Clip Creation UI
**Goal**: User interface for creating clips from selection

**Tasks:**
- [ ] Add "Create Clip" button (shows when selection active)
- [ ] Build clip creation dialog with:
  - Clip name input (smart default)
  - Save location selector (temp vs clips collection)
  - Duration display
- [ ] Implement clip creation request to backend
- [ ] Show progress notification during FFmpeg extraction
- [ ] Show success notification with "Open in Finder" action
- [ ] Display clips list in analysis view
- [ ] Add clip actions (play, open in Finder, delete)

**Files to create/modify:**
- `frontend/src/app/components/clip-dialog/clip-dialog.component.ts`
- `frontend/src/app/components/video-player/video-player.component.ts`
- `frontend/src/app/services/clips.service.ts`

**Estimated time**: 2-3 days

---

### Phase 9: Polish & Testing
**Goal**: Bug fixes, UX improvements, comprehensive testing

**Tasks:**
- [ ] Test with various video formats (MP4, MOV, etc.)
- [ ] Test with broken video paths (ensure graceful handling)
- [ ] Test archive/unarchive flow
- [ ] Test search with large number of analyses
- [ ] Test clip creation with various durations
- [ ] Test auto-relink algorithm with real clips collection
- [ ] Add loading states and error messages throughout
- [ ] Optimize timeline performance (especially with many markers)
- [ ] Add keyboard shortcut documentation
- [ ] Write user documentation for new features

**Estimated time**: 3-4 days

---

### Phase 10: Future Enhancements (Post-MVP)
**Not part of initial implementation, but architected for:**

- [ ] Thumbnail strip on timeline (generate with FFmpeg)
- [ ] Waveform visualization (Wavesurfer.js)
- [ ] Batch clip creation (select multiple ranges)
- [ ] Clip presets (common durations/formats)
- [ ] Export analysis metadata alongside clips
- [ ] Collection-wide search across all transcripts
- [ ] Video comparison view (side-by-side)
- [ ] Clip editing (trim after creation)
- [ ] Custom categories/tags for analyses

---

## Technical Decisions

### 1. File-Based vs Database
**Decision**: File-based (library.json + text files)

**Rationale**:
- Portability (copy folder = copy everything)
- Human-readable (JSON + text files)
- Easy backup with Syncthing
- No database dependencies
- Version control friendly
- Easy to repair/rebuild if corrupted
- Sufficient performance for expected scale

**Trade-offs**:
- Slower full-text search (but acceptable)
- Need to implement concurrency control (file locking)
- JSON parsing on every read

---

### 2. Video Player Library
**Decision**: Video.js

**Rationale**:
- Industry standard
- Electron-compatible
- Plugin ecosystem (markers, quality levels)
- TypeScript support
- Customizable controls
- Active maintenance

**Alternatives considered**:
- **Plyr**: Simpler but less extensible
- **Custom HTML5**: Too much work for basic features
- **Video Angular**: Less mature, smaller community

---

### 3. Timeline Implementation
**Decision**: Custom or Wavesurfer.js (decide during Phase 5)

**Rationale for Custom**:
- Full control over appearance
- No unnecessary dependencies
- Exact FCPX-style behavior

**Rationale for Wavesurfer.js**:
- Faster implementation
- Built-in regions plugin (perfect for range selection)
- Waveform visualization (nice bonus)
- Well-documented

**Decision point**: Try Wavesurfer.js first, build custom if it doesn't fit

---

### 4. Timestamp Format
**Decision**: Store both MM:SS strings and numeric seconds

**Rationale**:
- Analysis reports use MM:SS (human-readable)
- Video player uses seconds (programmatic)
- Keep both in metadata JSON for convenience
- Parse MM:SS → seconds when loading timeline

**Utility function**:
```typescript
function parseTimestamp(mmss: string): number {
  const [minutes, seconds] = mmss.split(':').map(Number);
  return minutes * 60 + seconds;
}

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
```

---

### 5. Clip Codec Strategy
**Decision**: Try `-c copy` first, fall back to re-encode

**Rationale**:
- `-c copy` is instant (no re-encoding)
- Works if selection is on keyframe boundaries
- Falls back to `-c:v libx264 -c:a aac` if copy fails
- User doesn't need to know the difference

**Implementation**:
```typescript
async extractClip(params: ExtractClipParams): Promise<void> {
  try {
    // Try fast copy first
    await this.runFFmpeg([
      '-i', params.inputPath,
      '-ss', params.startSeconds.toString(),
      '-to', params.endSeconds.toString(),
      '-c', 'copy',
      params.outputPath
    ]);
  } catch (error) {
    // Fall back to re-encode
    await this.runFFmpeg([
      '-i', params.inputPath,
      '-ss', params.startSeconds.toString(),
      '-to', params.endSeconds.toString(),
      '-c:v', 'libx264',
      '-c:a', 'aac',
      params.outputPath
    ]);
  }
}
```

---

### 6. Week Folder Calculation
**Decision**: Sunday-based weeks using ISO date format (YYYY-MM-DD)

**Rationale**:
- Matches existing clips collection structure
- Simple to calculate
- Human-readable folder names
- Sorts chronologically

**Edge case**: Videos created near midnight might be in "wrong" week, but doesn't matter since relinking handles it

---

### 7. Category Color Coding
**Decision**: Use consistent color palette, but don't hardcode category names

**Rationale**:
- Categories may change over time
- Color assignment should be dynamic
- Use hash of category name to pick color consistently
- Fallback to neutral colors

**Implementation**:
```typescript
function getCategoryColor(category: string): string {
  const colors = [
    '#ef4444', // red
    '#f97316', // orange
    '#eab308', // yellow
    '#22c55e', // green
    '#3b82f6', // blue
    '#a855f7', // purple
    '#ec4899', // pink
  ];

  // Simple hash to pick consistent color
  const hash = category.split('').reduce((acc, char) => {
    return char.charCodeAt(0) + ((acc << 5) - acc);
  }, 0);

  return colors[Math.abs(hash) % colors.length];
}
```

---

### 8. File Locking Strategy
**Decision**: Use `proper-lockfile` NPM package

**Rationale**:
- Cross-platform (Windows, Mac, Linux)
- Handles stale locks
- Non-blocking option available
- Battle-tested in production

**Usage**:
```typescript
import lockfile from 'proper-lockfile';

const release = await lockfile.lock('library.json', {
  retries: 3,
  realpath: false
});

try {
  // ... modify file ...
} finally {
  await release();
}
```

---

### 9. Video Loading in Electron
**Decision**: Use `file://` protocol or local HTTP server

**Rationale**:
- **Option A**: `file://` protocol
  - Simple, no server needed
  - May have CORS issues on some platforms
  - Use `webSecurity: false` in BrowserWindow (not ideal)

- **Option B**: Local HTTP server in backend
  - Serves video files on `http://localhost:3000/videos/:id`
  - No CORS issues
  - More "proper" architecture
  - Small overhead

**Decision**: Start with local HTTP server (cleaner, more reliable)

**Implementation**:
```typescript
// backend: Serve video files
@Get('videos/:analysisId')
async serveVideo(@Param('analysisId') id: string, @Res() res: Response) {
  const analysis = await this.libraryService.getAnalysis(id);
  const videoPath = analysis.video.currentPath;

  if (!fs.existsSync(videoPath)) {
    throw new NotFoundException('Video file not found');
  }

  const stat = fs.statSync(videoPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(videoPath);
  stream.pipe(res);
}
```

---

### 10. Migration Strategy
**Decision**: One-time migration script on first launch after update

**Rationale**:
- Import all existing analyses into new structure
- Non-destructive (keeps original files)
- Can be re-run if needed
- Progress bar for user feedback

**Flow**:
1. Check if `library.json` exists
2. If not, prompt: "Import existing analyses?"
3. Scan `~/Downloads/clippy/analysis/reports/`
4. For each report:
   - Generate UUID
   - Copy to new structure
   - Parse to create metadata JSON
   - Add to library.json
5. Show summary: "Imported 47 analyses"

---

## API Endpoints

### Library Management

```
GET    /api/library/analyses          # Get all analyses (active/archived)
GET    /api/library/analyses/:id      # Get single analysis
POST   /api/library/analyses          # Create new analysis
PATCH  /api/library/analyses/:id      # Update analysis (archive, relink, etc.)
DELETE /api/library/analyses/:id      # Delete analysis

GET    /api/library/search            # Search analyses
  ?q=query&archived=true&category=violence&dateFrom=2024-01-01
```

### Video Management

```
GET    /api/videos/:analysisId        # Stream video file (for player)
POST   /api/videos/relink             # Relink video to new path
POST   /api/videos/auto-relink        # Auto-find video in clips collection
GET    /api/videos/verify/:analysisId # Verify video still exists
```

### Clip Creation

```
POST   /api/clips                     # Create new clip
  Body: { analysisId, startSeconds, endSeconds, name, savePath }
GET    /api/clips/:clipId             # Get clip metadata
DELETE /api/clips/:clipId             # Delete clip
GET    /api/clips/for-analysis/:id    # Get all clips for analysis

WebSocket: /api/clips/progress        # Real-time clip creation progress
```

---

## Data Migration Plan

### Before Update
```
~/Downloads/clippy/
├── videos/
│   └── 2024-01-15 [Title].mp4
└── analysis/
    ├── reports/
    │   └── 2024-01-15 [Title].txt
    └── transcripts/
        ├── 2024-01-15 [Title].srt
        └── 2024-01-15 [Title].txt
```

### After Update
```
~/Library/Application Support/clippy/
├── library.json
├── analyses/
│   ├── uuid-1.txt
│   └── uuid-1.json
├── transcripts/
│   ├── uuid-1.srt
│   └── uuid-1.txt
└── clips/
    └── uuid-2.json

~/Downloads/clippy/
├── videos/                        # Still used for new downloads
└── analysis/                      # Kept for backwards compatibility
```

### Migration Script

**Location**: `backend/src/library/migration/migrate-v1.ts`

**Functionality**:
1. Detect if migration needed (no library.json)
2. Show UI prompt asking user to proceed
3. Scan for existing analyses in old structure
4. Generate UUIDs for each
5. Copy files to new structure
6. Parse text reports into JSON metadata
7. Build library.json with all entries
8. Mark migration complete
9. Keep old files (don't delete)

**Run**: Automatically on first startup after update, or manually via UI

---

## Testing Plan

### Unit Tests
- [ ] Library service (load, save, update)
- [ ] File locking mechanism
- [ ] Analysis parser (txt → json)
- [ ] Week folder calculation
- [ ] Timestamp parsing utilities
- [ ] Auto-relink fuzzy matching

### Integration Tests
- [ ] Archive/unarchive flow
- [ ] Video relinking (auto and manual)
- [ ] Clip creation end-to-end
- [ ] Search across analyses
- [ ] Migration script with sample data

### Manual Testing Checklist
- [ ] Load video in player (various formats)
- [ ] Drag timeline selection handles smoothly
- [ ] Markers appear at correct positions
- [ ] Spacebar play/pause works
- [ ] Create clip saves to correct location
- [ ] Relink video after moving file
- [ ] Archive and search in archived view
- [ ] Import existing analyses (migration)
- [ ] Handle broken video paths gracefully
- [ ] Test with real clips collection structure

---

## Performance Considerations

### Large Collections (1000+ Analyses)

**library.json Size**:
- ~500 bytes per analysis entry
- 1000 analyses = ~500KB (tiny, no issue)
- 10,000 analyses = ~5MB (still fine)

**Search Performance**:
- In-memory search is fast for text queries
- Reading transcript files is I/O bound
- Cache transcript content on startup if > 1000 analyses
- Consider indexing for very large collections (future)

**Timeline Rendering**:
- Limit visible markers (only render in viewport)
- Use canvas for timeline if > 100 markers
- Lazy load video thumbnails

### File System Operations

**Optimization**:
- Use async file operations (`fs/promises`)
- Cache library.json in memory
- Only write when changed (dirty flag)
- Debounce rapid updates (e.g., while dragging timeline)

---

## Security Considerations

### Electron Security

**Video Loading**:
- Use local HTTP server (safer than `file://` with disabled security)
- Validate video paths to prevent directory traversal
- Sanitize filenames in clip creation

**File Operations**:
- Validate all file paths before read/write
- Use path.join() to prevent traversal attacks
- Check file extensions match expected types

**FFmpeg**:
- Sanitize input paths (no shell injection)
- Use spawn with argument array (not shell string)
- Set timeout to prevent hanging

### Data Integrity

**Backup Strategy**:
- Keep `library.json.backup` on every write
- User can restore from backup if corruption occurs
- Implement JSON validation on load (schema check)

---

## Future Features (Not In Scope)

These are explicitly NOT part of this implementation but supported by architecture:

1. **Collection-wide search**: Search all transcripts across entire clips collection
2. **Video comparison**: Side-by-side video player for comparing clips
3. **Batch operations**: Process multiple analyses at once
4. **Custom tags**: User-defined tags in addition to AI categories
5. **Thumbnail generation**: FFmpeg-generated thumbnails for timeline
6. **Waveform visualization**: Audio waveform on timeline
7. **Cloud sync**: Sync library.json across devices
8. **Export formats**: Export clips in different formats/resolutions
9. **Clip playlists**: Group related clips into playlists
10. **Analysis templates**: Custom AI prompts for different analysis types

---

## Success Criteria

This feature is complete when:

✅ User can open analysis and play video in-app
✅ Timeline shows full video duration with zoom/scroll
✅ Draggable selection window with left/right handles
✅ Video seeks to handle positions during drag
✅ Spacebar toggles play/pause
✅ AI analysis markers appear on timeline (color-coded)
✅ "Create Clip" generates clip from selection via FFmpeg
✅ Clips save to temp folder or directly to clips collection
✅ Analysis reports have Archive button
✅ Archived analyses searchable in separate view
✅ Video relinking works (auto and manual)
✅ library.json tracks all analyses, videos, and clips
✅ Migration imports existing analyses into new structure
✅ All files stored in `~/Library/Application Support/clippy/`

---

## Questions & Decisions Log

### Resolved

**Q**: Use database or file-based storage?
**A**: File-based (library.json + text files) for simplicity and portability

**Q**: Which video player library?
**A**: Video.js for reliability and plugin ecosystem

**Q**: How to serve videos in Electron?
**A**: Local HTTP server endpoint (cleaner than file:// protocol)

**Q**: How to handle moved videos?
**A**: Auto-relink algorithm + manual relink option

**Q**: Where to store clips created?
**A**: User choice: temp folder or directly to clips collection week folder

**Q**: How to handle changing categories?
**A**: Dynamic color assignment via hash, no hardcoded category names

### Outstanding

**Q**: Wavesurfer.js vs custom timeline?
**A**: Decide in Phase 5 after prototyping

**Q**: Should we generate thumbnail strips for timeline?
**A**: Not in MVP, evaluate in Phase 10

**Q**: How granular should timeline zoom be?
**A**: Test with real videos, aim for 1-second precision at max zoom

---

## Glossary

**Analysis**: Complete record of video analysis including transcript and AI-identified sections
**Section**: Time range in video identified by AI as interesting (with category and description)
**Marker**: Visual indicator on timeline showing position of analysis section
**Clip**: Extracted segment of video created by user via timeline selection
**Library**: Master index (library.json) linking all analyses, videos, and clips
**Archive**: Storage area for analyses not actively being worked on
**Relink**: Process of updating video path after file has been moved
**Week Folder**: Sunday-based folder in clips collection (YYYY-MM-DD format)
**Selection Window**: Draggable range on timeline defining clip start/end points

---

## File Paths Reference

**Application Data:**
```
~/Library/Application Support/clippy/
├── library.json
├── analyses/
├── transcripts/
└── clips/
```

**Download Area** (temporary):
```
~/Downloads/clippy/
├── videos/
├── clips/              # Temp clips before moving to collection
└── analysis/           # Legacy, kept for compatibility
```

**Clips Collection** (permanent):
```
/Volumes/Callisto/clips/
├── 2021-08-08/
├── 2021-08-15/
└── ...
```

---

## End of Specification

This document should serve as the complete reference for implementing the video player and clip management feature. It will be updated as decisions are made during implementation.

**Last Updated**: 2025-11-03
**Version**: 1.0
**Status**: Planning Complete - Ready for Implementation
