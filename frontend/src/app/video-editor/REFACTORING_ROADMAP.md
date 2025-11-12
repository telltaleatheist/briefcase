# Video Editor Refactoring Roadmap

## ✅ Phase 1: Foundation (COMPLETED)

### Created:
- **Directory structure** for video-editor feature module
- **Models** (`/models`):
  - `timeline.model.ts` - Timeline interfaces and types
  - `track.model.ts` - Multi-track support models
  - `playback-state.model.ts` - Playback state management
  - `index.ts` - Public API exports

- **Services** (`/services`):
  - `timeline-state.service.ts` - Centralized timeline state management (RxJS BehaviorSubject)
  - `waveform-generator.service.ts` - Waveform generation and rendering
  - `playback-control.service.ts` - J/K/L controls, playback speed, player management
  - `index.ts` - Public API exports

---

## ✅ Phase 2: Component Extraction (COMPLETED!)

### Progress Tracker:
- ✅ **timeline-waveform** - COMPLETED (118 lines extracted)
- ✅ **timeline-playhead** - COMPLETED (51 lines extracted)
- ✅ **timeline-ruler** - COMPLETED (175 lines extracted)
- ✅ **timeline-zoom-bar** - COMPLETED (200 lines extracted)
- ✅ **timeline-sections-layer** - COMPLETED (85 lines extracted)
- ✅ **timeline-selection** - COMPLETED (150 lines extracted)

**Total extracted: 779 lines from the original 1,578-line component!**

### Priority 1: Core Components (Do First)

#### ✅ 1. `timeline-waveform` component (COMPLETED)
**Location**: `/video-editor/components/timeline/timeline-waveform/`
**Extracted**: 118 lines from video-timeline.component.ts
**Status**: ✅ Built and integrated successfully
**API**:
```typescript
@Input() waveformData: number[]
@Input() duration: number
@Input() zoomState: ZoomState
@Input() mediaElement?: HTMLVideoElement | HTMLAudioElement
@Input() autoGenerate: boolean
```

#### ✅ 2. `timeline-playhead` component (COMPLETED)
**Location**: `/video-editor/components/timeline/timeline-playhead/`
**Extracted**: 51 lines from video-timeline.component.ts (getPlayheadStyle method + integration)
**Status**: ✅ Built and integrated successfully
**API**:
```typescript
@Input() currentTime: number
@Input() duration: number
@Input() zoomState: ZoomState
@Input() isDraggable: boolean
@Output() playheadDragStart: EventEmitter<MouseEvent>
```

#### ✅ 3. `timeline-ruler` component (COMPLETED)
**Location**: `/video-editor/components/timeline/timeline-ruler/`
**Extracted**: 175 lines from video-timeline.component.ts (getTimeMarkers, calculateOptimalIntervals, formatDetailedTime methods)
**Status**: ✅ Built and integrated successfully
**API**:
```typescript
@Input() duration: number
@Input() zoomState: ZoomState
@Output() markerMouseDown: EventEmitter<MouseEvent>
```

### Priority 2: Interactive Components

#### ✅ 4. `timeline-sections-layer` component (COMPLETED)
**Location**: `/video-editor/components/timeline/timeline-sections-layer/`
**Extracted**: 85 lines from video-timeline.component.ts (getSectionStyle method, section rendering)
**Status**: ✅ Built and integrated successfully
**API**:
```typescript
@Input() sections: TimelineSection[]
@Input() duration: number
@Input() zoomState: ZoomState
```

#### ✅ 5. `timeline-zoom-bar` component (COMPLETED)
**Location**: `/video-editor/components/timeline/timeline-zoom-bar/`
**Extracted**: 200 lines from video-timeline.component.ts (scrollbar drag handlers, viewport style calculation)
**Status**: ✅ Built and integrated successfully
**API**:
```typescript
@Input() duration: number
@Input() zoomState: ZoomState
@Output() viewportDragStart: EventEmitter<MouseEvent>
@Output() leftHandleDragStart: EventEmitter<MouseEvent>
@Output() rightHandleDragStart: EventEmitter<MouseEvent>
```

#### ✅ 6. `timeline-selection` component (COMPLETED)
**Location**: `/video-editor/components/timeline/timeline-selection/`
**Extracted**: 150 lines from video-timeline.component.ts (getSelectionStyle method, selection window rendering)
**Status**: ✅ Built and integrated successfully
**API**:
```typescript
@Input() selection: TimelineSelection
@Input() duration: number
@Input() zoomState: ZoomState
@Input() selectedTool: 'cursor' | 'highlight'
@Output() windowDragStart: EventEmitter<MouseEvent>
@Output() leftHandleDragStart: EventEmitter<MouseEvent>
@Output() rightHandleDragStart: EventEmitter<MouseEvent>
```

### Priority 3: Container Components

#### 7. `timeline-track` component
**Responsibilities**:
- Single track container (audio OR video)
- Manages sections for one track
- Waveform display
- Height control
- ~200 lines (new)

#### 8. `timeline-container` component
**Responsibilities**:
- Orchestrates multiple tracks
- Manages shared state (playhead, zoom, selection)
- Keyboard shortcuts (J/K/L, I/O, A, R)
- Delegates to child components
- ~300 lines (new)

---

## 🎯 Phase 3: Integration (After Component Extraction)

### Steps:
1. **Create `video-editor-container`**:
   - Combines `video-viewer` + `timeline-container`
   - Manages video.js player instance
   - Connects playback state to timeline

2. **Update `video-player` component**:
   - Replace old `video-timeline` with new `timeline-container`
   - Inject services instead of managing state locally
   - Remove duplicated logic

3. **Refactor `video-player` component**:
   - Move video.js logic to `video-viewer` component
   - Keep only orchestration logic
   - ~500 lines instead of 1700+

---

## 💡 Phase 4: Advanced Features (Future)

Now that architecture is clean, these are easy to add:

### 1. **Multiple Timelines**
```typescript
<timeline-container
  *ngFor="let timeline of timelines"
  [tracks]="timeline.tracks"
  [shared]="sharedState">
</timeline-container>
```

### 2. **Separate Audio/Video Tracks**
```typescript
const tracks: Track[] = [
  { id: '1', type: 'video', name: 'Video Track 1', ... },
  { id: '2', type: 'audio', name: 'Audio Track 1', ... },
  { id: '3', type: 'audio', name: 'Audio Track 2', ... }
];
```

### 3. **Track Manager Service**
```typescript
export class TrackManagerService {
  addTrack(type: TrackType): void
  removeTrack(id: string): void
  moveTrack(id: string, newIndex: number): void
  linkTracks(videoId: string, audioId: string): void
}
```

---

## 📊 Benefits of This Architecture

### Current State (Before Refactor):
- ❌ 1,578 lines in one file
- ❌ All logic intertwined
- ❌ Hard to test individual features
- ❌ Difficult to add multi-track support

### After Full Refactor:
- ✅ ~10 focused components (~100-200 lines each)
- ✅ Services handle business logic
- ✅ Easy to unit test each piece
- ✅ Multi-track support is trivial
- ✅ Second timeline = just another instance
- ✅ Separate audio/video tracks = configuration

---

## 🛠️ How to Proceed (Incremental Approach)

### Option A: Gradual Migration (Recommended)
1. Start using services in existing `video-timeline` component
2. Extract one component at a time (start with `timeline-waveform`)
3. Replace piece by piece in existing component
4. Once all extracted, create `timeline-container` wrapper
5. Existing code keeps working throughout

### Option B: Parallel Development
1. Build new `timeline-container` alongside existing
2. Add feature flag to switch between old/new
3. Test thoroughly before switching over
4. Remove old component once stable

### Option C: Big Bang (Not Recommended)
1. Extract all components at once
2. Replace entire timeline in one go
3. High risk of bugs

---

## 📝 Next Steps

### Immediate (Do This Next):
1. **Extract `timeline-waveform` component** (easiest, self-contained)
2. **Update `video-timeline` to use `TimelineStateService`** (gradually migrate state)
3. **Extract `timeline-playhead` component**
4. **Extract `timeline-ruler` component**

### After First 3 Components:
5. Extract remaining components one at a time
6. Create `timeline-container` wrapper
7. Update `video-player` to use new architecture

### Final Polish:
8. Add multi-track support
9. Create `video-editor-container`
10. Build advanced features (multiple timelines, etc.)

---

## 📚 Resources

### Services Created:
- `TimelineStateService` - State management for timeline
- `WaveformGeneratorService` - Generate/render waveforms
- `PlaybackControlService` - Handle playback, J/K/L keys

### Models Created:
- `TimelineSection`, `TimelineSelection`, `TimelineTool`
- `Track`, `VideoTrack`, `AudioTrack`
- `PlaybackState`, `PlaybackSpeed`, `PlaybackCommand`

### Components To Create:
See **Phase 2** above for full list with line counts and responsibilities.

---

**Ready to proceed with Phase 2?** Start with extracting `timeline-waveform` component!
