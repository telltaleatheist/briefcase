# Phase 6: Content Discovery & Visualization - PLAN

**Status**: Ready to Start
**Goal**: Make finding and browsing 5,353+ videos effortless
**Estimated Duration**: 1-2 weeks

---

## Overview

Phase 6 focuses on making it easy to discover and navigate through thousands of videos. With 5,353+ videos in the library, text-based lists aren't enough - we need visual tools, powerful search, and smart organization.

---

## Sprint Breakdown

### Sprint 1: Advanced Search (3-4 days)
**Goal**: Find any video in seconds

**Features:**
1. **Multi-Field Search**
   - Search across: filename, transcript text, analysis content, tags
   - Single search box with field selectors
   - Real-time results as you type
   - Highlight matched terms in results

2. **Boolean Operators**
   - AND: `crypto AND conspiracy`
   - OR: `biden OR trump`
   - NOT: `politics NOT election`
   - Parentheses for grouping: `(biden OR trump) AND debate`

3. **Date Range Filters**
   - "Last 7 days", "Last month", "Last year"
   - Custom date picker
   - "Between X and Y" selector

4. **Duration Filters**
   - Quick chips: `< 10 min`, `10-30 min`, `> 30 min`
   - Custom duration range slider
   - Combine with other filters

5. **Saved Searches**
   - Save search criteria with a name
   - Quick access dropdown
   - Edit/delete saved searches
   - Share search URLs (query parameters)

**Technical:**
- Use existing FTS5 tables for fast full-text search
- Add search history to localStorage
- Query builder component
- Search results component with virtual scrolling

---

### Sprint 2: Video Thumbnails (2-3 days)
**Goal**: See what's in each video at a glance

**Features:**
1. **Thumbnail Generation**
   - FFmpeg extract frame at 10% into video
   - Cache thumbnails in `~/Library/Application Support/clippy/thumbnails/`
   - Background job queue (don't block UI)
   - Lazy generation on first view

2. **Video Card Thumbnails**
   - Display thumbnail in list view cards
   - Fallback to film icon if no thumbnail
   - Lazy load images with intersection observer
   - Placeholder while loading

3. **Grid View**
   - Toggle between list and grid layouts
   - Grid shows larger thumbnails
   - Adjustable grid size (small/medium/large)
   - Responsive layout (2-6 columns)

4. **Hover Preview** (optional)
   - Show larger preview on thumbnail hover
   - Display video metadata in tooltip
   - Quick actions menu

**Technical:**
- Backend endpoint: `POST /api/database/thumbnails/generate`
- FFmpeg command: `ffmpeg -i input.mp4 -ss 00:00:10 -vframes 1 -vf scale=320:-1 thumb.jpg`
- Database: Add `thumbnail_path` column to videos table
- Frontend: Grid layout component with Material Grid List

---

### Sprint 3: Timeline Visualization (2-3 days)
**Goal**: See video history over time

**Features:**
1. **Calendar View**
   - Month/year view of all videos
   - Date cells show video count
   - Click date to filter videos
   - Color intensity based on video count (heat map)

2. **Timeline Scrubber**
   - Horizontal timeline of all videos by date
   - Zoom in/out (day/week/month/year)
   - Scrub to navigate through time
   - Visual markers for high-activity periods

3. **Date Range Selection**
   - Click-drag to select date range
   - Apply as filter to library
   - Clear date filter button
   - URL state for bookmarking

**Technical:**
- Use Material Datepicker for calendar
- D3.js or Chart.js for timeline visualization
- Group videos by date for performance
- Indexed date_folder column already exists

---

### Sprint 4: Smart Collections & Tags (2-3 days)
**Goal**: Auto-organize videos by content

**Features:**
1. **Manual Tag Editing**
   - Tag editor dialog for each video
   - Add tags with autocomplete from existing tags
   - Remove tags with confirmation
   - Bulk tag operations (select multiple videos)
   - Tag color coding by type (people/topic/other)

2. **Smart Collections**
   - Create collection with rules
   - Examples:
     - "All videos with 'Trump' tag"
     - "All videos > 30 min with 'conspiracy' tag"
     - "All videos from last month"
   - Collections auto-update as videos change
   - Pin collections to sidebar

3. **Tag-Based Folders**
   - Virtual folders for each tag
   - Click tag to filter library
   - Combine tags (AND/OR logic)
   - Tag hierarchy (nested tags)

**Technical:**
- Tag management service
- Collection rules engine (JSON-based rules)
- Sidebar navigation component
- Tag autocomplete component

---

### Sprint 5: Split View & File Management (2 days)
**Goal**: Streamlined workflow and file maintenance

**Features:**
1. **Split View Mode**
   - Toggle button to enable split view
   - Left: Library list (scrollable)
   - Right: Video player
   - Draggable divider to resize
   - Keyboard navigation (arrows, Enter, Escape)
   - Quick clip creation without leaving view

2. **Missing File Indicators**
   - ⚠️ warning icon on unlinked videos (is_linked = 0)
   - "Missing" badge on video card
   - Filter to show only missing videos
   - Bulk operations for missing videos

3. **Auto-Relink System**
   - "Scan for missing files" button
   - Background job to hash and relink
   - Progress notification
   - Success/failure report

4. **Clean Library Tool**
   - "Remove missing videos" option
   - Confirmation dialog with count
   - Preview list of videos to remove
   - Optional: Archive instead of delete

**Technical:**
- Angular Material Sidenav for split view
- Resizable directive for divider
- Database query for is_linked = 0
- Hash-based file relinking (already implemented in scanner)

---

## Database Changes

### New Columns
```sql
ALTER TABLE videos ADD COLUMN thumbnail_path TEXT;
```

### New Tables
```sql
-- Smart collections
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Search history
CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  filters_json TEXT,
  searched_at TEXT NOT NULL
);
```

---

## API Endpoints

### Search
- `POST /api/database/search` - Advanced search with filters

### Thumbnails
- `POST /api/database/thumbnails/generate/:videoId` - Generate single thumbnail
- `POST /api/database/thumbnails/batch` - Generate for multiple videos
- `GET /api/database/thumbnails/:videoId` - Serve thumbnail image

### Collections
- `GET /api/database/collections` - List all collections
- `POST /api/database/collections` - Create new collection
- `GET /api/database/collections/:id` - Get videos matching collection rules
- `PUT /api/database/collections/:id` - Update collection
- `DELETE /api/database/collections/:id` - Delete collection

### File Management
- `POST /api/database/relink` - Scan and relink missing files
- `POST /api/database/clean` - Remove unlinked videos
- `GET /api/database/missing` - List missing videos

---

## UI Components

### New Components
1. `AdvancedSearchComponent` - Search bar with filters
2. `SearchResultsComponent` - Results with highlighting
3. `VideoGridComponent` - Grid layout for videos
4. `TimelineComponent` - Visual timeline of videos
5. `CalendarViewComponent` - Month/year calendar
6. `TagEditorComponent` - Edit tags for video
7. `SmartCollectionDialogComponent` - Create/edit collections
8. `SplitViewComponent` - Library + player layout
9. `ThumbnailGeneratorComponent` - Batch thumbnail generation UI

### Enhanced Components
- `LibraryComponent` - Add grid toggle, split view mode
- `VideoCardComponent` - Add thumbnail display, missing indicator
- Navigation sidebar - Add collections section

---

## Testing Checklist

### Sprint 1: Search
- [ ] Search finds videos by filename
- [ ] Search finds videos by transcript text
- [ ] Search finds videos by analysis content
- [ ] Search finds videos by tags
- [ ] Boolean AND works correctly
- [ ] Boolean OR works correctly
- [ ] Boolean NOT works correctly
- [ ] Date range filter works
- [ ] Duration filter works
- [ ] Saved searches persist across sessions
- [ ] Search results highlight matched terms

### Sprint 2: Thumbnails
- [ ] Thumbnails generate correctly
- [ ] Thumbnails display in list view
- [ ] Grid view shows larger thumbnails
- [ ] Lazy loading works (only visible thumbnails load)
- [ ] Placeholder shows while generating
- [ ] Grid toggle works
- [ ] Grid is responsive

### Sprint 3: Timeline
- [ ] Calendar shows correct video counts
- [ ] Heat map colors are visible
- [ ] Clicking date filters library
- [ ] Timeline scrubber works
- [ ] Zoom in/out works
- [ ] Date range selection works

### Sprint 4: Collections & Tags
- [ ] Can add tags to video
- [ ] Can remove tags from video
- [ ] Autocomplete shows existing tags
- [ ] Bulk tag operations work
- [ ] Smart collection rules work
- [ ] Collections auto-update
- [ ] Can pin/unpin collections

### Sprint 5: Split View & Files
- [ ] Split view toggle works
- [ ] Divider is draggable
- [ ] Player loads in split view
- [ ] Missing icons show on unlinked videos
- [ ] Relink finds moved files
- [ ] Clean library removes unlinked videos
- [ ] Keyboard navigation works

---

## Performance Considerations

### Search Performance
- FTS5 tables already indexed
- Limit results to 100 by default
- Virtual scrolling for results
- Debounce search input (300ms)

### Thumbnail Performance
- Generate in background job queue
- Cache thumbnails to disk
- Lazy load only visible thumbnails
- Optional: Generate on first view vs batch generate

### Timeline Performance
- Group videos by date in SQL query
- Limit to visible date range
- Pagination for large date ranges

### Grid View Performance
- Virtual scrolling for grid
- Lazy load thumbnails with Intersection Observer
- Limit grid to 50-100 items per page

---

## Success Metrics

**Search:**
- Can find any video in < 2 seconds
- Search results are accurate and relevant
- Saved searches used frequently

**Thumbnails:**
- Users prefer grid view for browsing
- Thumbnails help identify videos faster
- Generation doesn't block UI

**Timeline:**
- Users discover old forgotten videos
- Date filtering is intuitive
- Heat map shows activity patterns

**Collections:**
- Users create 5+ collections on average
- Collections reduce search time
- Tag organization improves

**Split View:**
- Clip creation workflow is faster
- Users stay in split view mode
- Less context switching

---

## Risk Mitigation

**Risk**: Thumbnail generation too slow
- **Mitigation**: Background job queue, start with subset, optional feature

**Risk**: Search too slow with 5,353 videos
- **Mitigation**: FTS5 indexing, result limiting, pagination

**Risk**: Timeline doesn't scale
- **Mitigation**: Aggregate by date, limit visible range, lazy load

**Risk**: Collections too complex
- **Mitigation**: Start with simple rules, add complexity later, templates

---

## Next Steps After Phase 6

Phase 7: Production Workflow Enhancement
- Batch clip creation
- Clip collections
- Advanced clip tools
- Keyboard shortcuts

---

**Ready to Start**: Phase 6 Sprint 1 - Advanced Search
**Estimated Start Date**: When Phase 5 testing complete
**Target Completion**: 1-2 weeks from start

---

**Last Updated**: November 6, 2025
