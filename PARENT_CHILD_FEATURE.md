# Parent-Child File Relationships Feature

## Overview
A comprehensive parent-child relationship system that allows videos to be linked hierarchically. Children can have multiple parents, and parents can have multiple children (many-to-many relationship).

## Features

### 1. Video Info Page - Children Management
- **Location**: Video Info Page → Children Section
- **Functionality**:
  - View all children of the current video
  - Add new children via searchable video selector modal
  - Remove individual children
  - Remove all children at once
  - Click any child to navigate to its video info page

### 2. Hierarchical Library Display
- **Same Week**: Children appear indented under their parent
- **Cross-Week**: Ghost items show relationships across different weeks
  - Parent's week shows faded ghost children
  - Child's week shows faded ghost parent
  - Ghost items are half-height, semi-transparent, and unselectable
  - Double-click ghost items to jump to their actual location

### 3. Auto-Linking from Video Editor
- Clips extracted from videos are automatically linked as children
- Maintains relationship hierarchy when extracting from children

## Database Schema

### video_relationships Table
```sql
CREATE TABLE video_relationships (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (child_id) REFERENCES videos(id) ON DELETE CASCADE,
  UNIQUE (parent_id, child_id)
);
```

### Migration
- **Migration 18**: Automatically creates the junction table
- Migrates existing `parent_id` data to the new table
- Maintains backward compatibility

## API Endpoints

### Parent-Child Management
- `POST /api/database/videos/:parentId/add-children` - Add multiple children
  - Body: `{ childIds: string[] }`

- `GET /api/database/videos/:parentId/children` - Get all children
  - Returns: `{ success: boolean, children: VideoRecord[] }`

- `GET /api/database/videos/:videoId/parents` - Get all parents
  - Returns: `{ success: boolean, parents: VideoRecord[] }`

- `POST /api/database/videos/:parentId/remove-child/:childId` - Remove specific child

- `POST /api/database/videos/:parentId/remove-all-children` - Remove all children

- `POST /api/database/videos/:childId/set-parent` - Link to single parent
  - Body: `{ parentId: string | null }`

- `POST /api/database/videos/:childId/remove-parent` - Remove all parents

### Video Retrieval
- `GET /api/database/videos?includeRelationships=true` - Get videos with relationship data
  - Enriches each video with `parent_ids`, `child_ids`, `children`, and `parents`

## Frontend Components

### Modified Files

#### Models
- `frontend-v3/src/app/models/video.model.ts`
  - Added: `parentIds`, `childIds`, `children`, `parents`, `isGhost`

#### Services
- `frontend-v3/src/app/services/library.service.ts`
  - Added: `groupVideosByWeekWithHierarchy()` - Builds hierarchical structure with ghost items
  - Modified: `getVideosByWeek()` - Fetches relationship data

#### Components
- `frontend-v3/src/app/components/video-info-page/`
  - Added children section with video selector modal
  - Methods: `loadChildren()`, `addSelectedChildren()`, `removeChild()`, `removeAllChildren()`

- `frontend-v3/src/app/components/cascade/`
  - Added ghost item support
  - Methods: `hasVideoChildren()`, `isVideoChild()`, `handleVideoDoubleClick()`, `scrollToVideo()`
  - CSS: Ghost item styling (half-height, faded), child indentation

### Backend Files

#### Database Service
- `backend/src/database/database.service.ts`
  - Migration 18: Creates `video_relationships` table
  - Methods: `setVideoParent()`, `getChildVideos()`, `getParentVideos()`,
    `removeParentChildRelationship()`, `removeAllChildren()`

#### Database Controller
- `backend/src/database/database.controller.ts`
  - Added parent-child management endpoints
  - Modified `getVideos()` to support `includeRelationships` parameter

## Visual Design

### Normal Items
- Standard height (60px)
- Full opacity
- Selectable
- Context menu enabled

### Ghost Items
- Half height (30px)
- 50% opacity
- Italic text
- Unselectable
- Double-click to navigate
- Hover increases opacity to 60%

### Child Items
- Indented 32px from left
- Different background color
- Same height as normal items

## Usage Examples

### Add Children to a Video
1. Open video info page
2. Expand "Children" section
3. Click "Add Children"
4. Search and select videos
5. Click "Add X Video(s)"

### Navigate Library Hierarchy
- Children appear indented under parents in same week
- Ghost items show cross-week relationships
- Double-click ghost items to jump to actual location

### Remove Relationships
- Click X next to child to remove one
- Click "Remove All Children" to remove all

## Testing

### Build Commands
```bash
# Frontend
cd frontend-v3
npm run build

# Backend
cd backend
npm run build
```

### Development Servers
```bash
# Backend
cd backend
npm run start:dev

# Frontend
cd frontend-v3
npm start
```

## Notes
- Ghost items are read-only visual indicators
- Double-clicking ghost items provides smooth navigation
- Relationships are maintained during video deletion (CASCADE)
- Backward compatible with existing `parent_id` column
- Video editor clip extraction automatically creates relationships
