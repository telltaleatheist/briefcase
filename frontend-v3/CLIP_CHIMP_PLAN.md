# CLIP CHIMP - Complete Development Plan 🐵

## Overview
Clip Chimp is a complete rewrite of the ClipChimp frontend using modern Angular patterns and the Creamsicle design system. This is a clean-slate approach with no legacy code dependencies.

## Core Philosophy
- **Clean Architecture**: No Material Angular, no legacy dependencies
- **Modern Patterns**: Angular 19, signals, standalone components
- **Creamsicle Design**: Orange-themed, clean, modern UI
- **Simplified UX**: Remove unnecessary complexity from old frontend
- **Backend Agnostic**: Works with existing NestJS API

---

## System Architecture

### Frontend Structure
```
frontend-v2/ (Clip Chimp)
├── src/
│   ├── app/
│   │   ├── core/              # Services, guards, interceptors
│   │   ├── shared/            # Reusable UI components
│   │   ├── features/          # Page modules
│   │   └── layouts/           # App shells
│   ├── styles/                # Creamsicle design system
│   ├── assets/                # Images, icons
│   └── environments/          # Config
```

### Backend Connection
- **API Base**: `http://localhost:3001/api`
- **Authentication**: JWT tokens
- **WebSockets**: For real-time updates
- **File Serving**: Direct from backend

---

## Feature Mapping (Old → New)

### 1. Video Library
**Old Frontend (frontend/src/app/components/library/)**
- 4,642 lines in main component
- 19 dialog components
- Complex cascade list
- Week grouping
- Virtual scrolling
- Type-ahead search

**New Clip Chimp**
- ~700 lines total
- 3 dialogs max (confirm, preview, settings)
- Simple list view
- Optional date grouping
- Native scrolling (add virtual if needed)
- Simple search bar

**Core Functions to Preserve:**
- View list of videos
- Search/filter videos
- Select multiple videos
- Batch operations (analyze, delete)
- Open video in player
- See transcript/analysis status

### 2. Batch Downloads
**Old Frontend (frontend/src/app/components/batch-download/)**
- Separate queue/history/progress components
- Complex state management

**New Clip Chimp**
- Single unified component
- Status filters (active, completed, failed)
- Same list-item pattern as library

**Core Functions:**
- Add videos to download queue
- See download progress
- Pause/resume/cancel downloads
- View download history

### 3. Video Tabs
**Old Frontend (frontend/src/app/components/tabs/)**
- Complex tab management
- Multiple tab types

**New Clip Chimp**
- Simple tab bar
- Videos in tabs use same list-item component
- Drag to reorder tabs

**Core Functions:**
- Create/delete tabs
- Add videos to tabs
- Switch between tabs
- Rename tabs

### 4. Settings
**Old Frontend (frontend/src/app/components/settings/)**
- Monolithic settings page
- Mixed concerns

**New Clip Chimp**
- Tabbed interface
- Focused sections
- Clear organization

**Core Functions:**
- Configure AI settings
- Set download preferences
- Theme selection
- Library management

---

## Design System Components

### Base Components (from Creamsicle)
```typescript
// Color Palette
--primary-orange: #ff6b35
--light-orange: #ff8c5a
--dark-orange: #e55529

// Components to Build
ChimpButton      - Buttons with variants
ChimpCard        - Content cards
ChimpListItem    - List row pattern
ChimpToolbar     - Header bars
ChimpSearchBar   - Unified search
ChimpDialog      - Modal wrapper
ChimpBadge       - Status indicators
ChimpEmptyState  - No content message
```

### Layout Patterns
- **List Layout**: 8px indicator | 48px icon | flex content | auto actions
- **Sticky Headers**: For date groups
- **Selection**: Orange glow indicator
- **Hover States**: Background tint
- **Dark Mode**: Full theme support

---

## API Endpoints (Backend Integration)

### Library
```typescript
GET    /api/library/videos              - List all videos
GET    /api/library/videos/:id          - Get single video
DELETE /api/library/videos/:id          - Delete video
POST   /api/library/import              - Import videos
GET    /api/library/stats               - Library statistics
```

### Analysis
```typescript
POST   /api/analysis/batch              - Analyze multiple videos
GET    /api/analysis/:videoId           - Get analysis results
POST   /api/analysis/transcribe/:id     - Transcribe video
```

### Downloads
```typescript
GET    /api/download/queue              - Get download queue
POST   /api/download/add                - Add to queue
DELETE /api/download/:id                - Cancel download
GET    /api/download/progress/:id       - Get progress
```

### Settings
```typescript
GET    /api/settings                    - Get all settings
PATCH  /api/settings                    - Update settings
GET    /api/settings/ai                 - AI configuration
PATCH  /api/settings/ai                 - Update AI config
```

### Tabs
```typescript
GET    /api/tabs                        - List tabs
POST   /api/tabs                        - Create tab
PATCH  /api/tabs/:id                    - Update tab
DELETE /api/tabs/:id                    - Delete tab
POST   /api/tabs/:id/videos             - Add video to tab
```

---

## Development Phases

### Phase 1: Foundation (Days 1-2) ✅
- [x] Create new Angular app
- [x] Create plan document
- [ ] Set up Creamsicle design system
- [ ] Create base app structure
- [ ] Configure routing

### Phase 2: Core Components (Days 3-4)
- [ ] ChimpButton component
- [ ] ChimpListItem component
- [ ] ChimpToolbar component
- [ ] ChimpSearchBar component
- [ ] ChimpEmptyState component

### Phase 3: Layout & Navigation (Day 5)
- [ ] Main layout shell
- [ ] Side navigation
- [ ] Theme toggle
- [ ] Routing setup

### Phase 4: Video Library (Days 6-8)
- [ ] Library service (API calls)
- [ ] Video list component
- [ ] Search/filter functionality
- [ ] Selection management
- [ ] Batch operations

### Phase 5: Other Features (Days 9-11)
- [ ] Downloads feature
- [ ] Tabs feature
- [ ] Settings feature

### Phase 6: Integration (Days 12-14)
- [ ] Connect to real backend
- [ ] Test with real data
- [ ] Fix CORS issues
- [ ] Performance optimization

---

## State Management

### Service-Based State (Signals)
```typescript
// Example: LibraryService
export class LibraryService {
  // State
  videos = signal<Video[]>([]);
  selectedIds = signal<Set<string>>(new Set());
  searchQuery = signal<string>('');

  // Computed
  filteredVideos = computed(() =>
    this.filterVideos(this.videos(), this.searchQuery())
  );

  selectedCount = computed(() =>
    this.selectedIds().size
  );
}
```

### No NgRx/Akita needed - Keep it simple!

---

## File Structure Examples

### Video Library Feature
```
features/library/
├── library.component.ts         # Main container
├── library.component.html       # Template
├── library.component.scss       # Styles
├── library.service.ts           # State & API
├── components/
│   ├── video-item/              # List row
│   └── search-filters/          # Search bar
└── models/
    └── library.types.ts         # Interfaces
```

### Shared UI Component
```
shared/ui/list-item/
├── list-item.component.ts       # Component
├── list-item.component.html     # Template
├── list-item.component.scss     # Styles
└── list-item.types.ts           # Props interface
```

---

## Styling Guidelines

### Use Design Tokens
```scss
// Good
color: var(--text-primary);
background: var(--bg-card);
border-radius: $radius-md;

// Bad
color: #333;
background: white;
border-radius: 8px;
```

### Use Mixins
```scss
// Good
@include flex-between;
@include custom-scrollbar;

// Bad
display: flex;
justify-content: space-between;
align-items: center;
```

### Component Scoping
```scss
// Always use :host for component styles
:host {
  display: block;
  height: 100%;
}
```

---

## What We're NOT Building
- ❌ Complex cascade list
- ❌ 19 different dialogs
- ❌ Virtual scrolling (unless performance requires)
- ❌ Complex keyboard navigation
- ❌ Type-ahead search
- ❌ Material Angular components
- ❌ Video editor (separate project)

## What We ARE Building
- ✅ Clean, simple UI
- ✅ Fast, responsive experience
- ✅ Dark mode support
- ✅ Mobile responsive
- ✅ Accessible
- ✅ Maintainable code
- ✅ Modern Angular patterns

---

## Success Metrics

### Code Quality
- Components < 300 lines
- Services < 500 lines
- Clear separation of concerns
- No circular dependencies

### Performance
- Initial load < 2 seconds
- Search/filter < 100ms
- Smooth 60fps scrolling
- Bundle size < 1MB

### User Experience
- Intuitive navigation
- Clear visual feedback
- Consistent patterns
- Fast interactions

---

## Running the App

### Development
```bash
# Backend (Terminal 1)
cd backend && npm run start:dev

# Old Frontend - Port 4200 (Terminal 2)
cd frontend && npm start

# NEW Clip Chimp - Port 4300 (Terminal 3)
cd frontend-v2 && npm start
```

### Production Build
```bash
cd frontend-v2
npm run build
# Output in dist/
```

### Electron
```typescript
// Point to new frontend
const url = 'http://localhost:4300';
```

---

## Questions to Answer

1. **Authentication**: How does current auth work?
2. **File Paths**: How are video files served?
3. **WebSockets**: What real-time features exist?
4. **Electron**: What desktop-specific features?
5. **Settings**: What settings are critical?

---

## Next Steps

1. ✅ Create Angular app
2. ✅ Write this plan
3. ⏳ Set up design system
4. ⏳ Build core components
5. ⏳ Create library feature
6. ⏳ Connect to backend
7. ⏳ Test everything

---

## Notes

- Keep components simple and focused
- Use signals for reactive state
- Follow creamsicle design patterns
- Test with real data early
- Get feedback often

---

Last Updated: November 18, 2024
