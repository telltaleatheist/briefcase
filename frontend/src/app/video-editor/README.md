# Video Editor Module

A clean, modular architecture for video editing features including timeline management, multi-track support, and waveform visualization.

## 🏗️ Structure

```
video-editor/
├── models/              # TypeScript interfaces and types
│   ├── timeline.model.ts
│   ├── track.model.ts
│   ├── playback-state.model.ts
│   └── index.ts
│
├── services/            # Business logic services
│   ├── timeline-state.service.ts
│   ├── waveform-generator.service.ts
│   ├── playback-control.service.ts
│   └── index.ts
│
├── components/          # UI components (to be created)
│   ├── timeline/
│   ├── playback-controls/
│   └── video-viewer/
│
├── directives/          # Custom directives (to be created)
│
├── index.ts             # Public API
├── README.md            # This file
└── REFACTORING_ROADMAP.md  # Detailed refactoring plan
```

---

## 📦 What's Included

### Models (`/models`)

#### `timeline.model.ts`
Core timeline interfaces:
- `TimelineSection` - Sections/markers on timeline
- `TimelineSelection` - In/Out point selection
- `TimelineTool` - Tool modes (cursor, highlight)
- `CategoryFilter` - Category filtering
- `TimeMarker` - Time markers (0:00, 0:05, etc.)
- `ZoomState` - Zoom level and offset
- `TimelineState` - Complete timeline state

#### `track.model.ts`
Multi-track support:
- `Track` - Base track interface
- `VideoTrack` - Video track
- `AudioTrack` - Audio track with waveform
- `TrackType` - 'video' | 'audio'

#### `playback-state.model.ts`
Playback management:
- `PlaybackState` - Current playback state
- `PlaybackSpeed` - Speed values (-8 to 8)
- `PlaybackCommand` - Playback commands

---

### Services (`/services`)

#### `TimelineStateService`
Centralized timeline state management using RxJS.

**Usage:**
```typescript
import { TimelineStateService } from '@app/video-editor';

constructor(private timelineState: TimelineStateService) {}

// Subscribe to state changes
this.timelineState.state.subscribe(state => {
  console.log('Timeline state:', state);
});

// Update state
this.timelineState.setCurrentTime(10.5);
this.timelineState.setSelection({ startTime: 5, endTime: 15 });
this.timelineState.setZoom(2, 10); // 2x zoom, offset 10s
```

**API:**
- `state: Observable<TimelineState>` - State stream
- `currentState: TimelineState` - Current state value
- `setDuration(duration)` - Set video duration
- `setCurrentTime(time)` - Set current playback time
- `setSelection(selection)` - Set in/out points
- `setSections(sections)` - Set timeline sections
- `toggleCategoryFilter(category)` - Toggle category visibility
- `setZoom(level, offset)` - Set zoom level and offset
- `setSelectedTool(tool)` - Set active tool
- `toggleAutoFollowPlayhead()` - Toggle playhead following

#### `WaveformGeneratorService`
Generate and render audio waveforms.

**Usage:**
```typescript
import { WaveformGeneratorService } from '@app/video-editor';

constructor(private waveform: WaveformGeneratorService) {}

// Generate waveform from media element
const waveformData = await this.waveform.generateWaveform(videoElement);

// Render to canvas
this.waveform.renderWaveform(canvas, waveformData, {
  duration: 60,
  zoomLevel: 1,
  zoomOffset: 0,
  color: 'rgba(255, 143, 71, 0.8)'
});

// Get slice for specific time range
const slice = this.waveform.getWaveformSlice(
  waveformData,
  duration,
  startTime,
  endTime
);
```

**API:**
- `generateWaveform(mediaElement)` - Generate waveform data
- `renderWaveform(canvas, data, options)` - Render to canvas
- `getWaveformSlice(data, duration, start, end)` - Get time slice

#### `PlaybackControlService`
Handle playback, J/K/L controls, and speed management.

**Usage:**
```typescript
import { PlaybackControlService } from '@app/video-editor';

constructor(private playback: PlaybackControlService) {}

// Set video.js player
this.playback.setPlayer(player);

// Subscribe to playback state
this.playback.state.subscribe(state => {
  console.log('Playback state:', state);
});

// Control playback
this.playback.play();
this.playback.pause();
this.playback.togglePlayPause();
this.playback.seek(30); // Seek to 30 seconds
this.playback.seekRelative(5); // Seek forward 5 seconds

// J/K/L controls (Final Cut Pro style)
this.playback.handleJKLKey('j'); // Rewind
this.playback.handleJKLKey('k'); // Pause
this.playback.handleJKLKey('l'); // Fast forward

// Set speed directly
this.playback.setPlaybackSpeed(2); // 2x forward
this.playback.setPlaybackSpeed(-1); // 1x rewind
```

**API:**
- `state: Observable<PlaybackState>` - Playback state stream
- `currentState: PlaybackState` - Current state value
- `setPlayer(player)` - Set video.js player instance
- `play()`, `pause()`, `togglePlayPause()` - Playback control
- `seek(time)`, `seekRelative(delta)` - Seeking
- `setPlaybackSpeed(speed)` - Set playback speed
- `handleJKLKey(key)` - Handle J/K/L keyboard shortcuts
- `updateStateFromPlayer()` - Sync state from player

---

## 🎯 Usage Example

Here's how to use the services together:

```typescript
import { Component, OnInit, OnDestroy } from '@angular/core';
import {
  TimelineStateService,
  PlaybackControlService,
  WaveformGeneratorService
} from '@app/video-editor';
import { takeUntil } from 'rxjs/operators';
import { Subject } from 'rxjs';
import videojs from 'video.js';

@Component({
  selector: 'app-my-video-editor',
  template: `
    <video #videoElement class="video-js"></video>
    <canvas #waveformCanvas></canvas>
    <div>Current Time: {{ currentTime }}</div>
    <div>Selection: {{ selectionStart }} - {{ selectionEnd }}</div>
  `
})
export class MyVideoEditorComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  private player: any;

  currentTime = 0;
  selectionStart = 0;
  selectionEnd = 0;

  constructor(
    private timelineState: TimelineStateService,
    private playback: PlaybackControlService,
    private waveform: WaveformGeneratorService
  ) {}

  ngOnInit() {
    // Initialize video.js player
    this.player = videojs(this.videoElement.nativeElement, {
      sources: [{ src: 'video.mp4', type: 'video/mp4' }]
    });

    // Connect player to playback service
    this.playback.setPlayer(this.player);

    // Subscribe to timeline state
    this.timelineState.state
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.currentTime = state.currentTime;
        this.selectionStart = state.selection.startTime;
        this.selectionEnd = state.selection.endTime;
      });

    // Subscribe to playback state
    this.playback.state
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.timelineState.setCurrentTime(state.currentTime);
        this.timelineState.setDuration(state.duration);
      });

    // Generate waveform
    this.player.on('loadedmetadata', async () => {
      const waveformData = await this.waveform.generateWaveform(
        this.player.el().querySelector('video')
      );

      this.waveform.renderWaveform(
        this.waveformCanvas.nativeElement,
        waveformData,
        {
          duration: this.player.duration(),
          zoomLevel: 1,
          zoomOffset: 0
        }
      );
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();

    if (this.player) {
      this.player.dispose();
    }
  }
}
```

---

## 🚀 Next Steps

See [REFACTORING_ROADMAP.md](./REFACTORING_ROADMAP.md) for the complete refactoring plan.

**Immediate next steps:**
1. Extract `timeline-waveform` component from existing timeline
2. Extract `timeline-playhead` component
3. Extract `timeline-ruler` component
4. Create `timeline-container` to orchestrate everything
5. Add multi-track support

---

## 🎨 Design Principles

This module follows these principles:

1. **Single Responsibility** - Each service/component has one clear purpose
2. **Reactive State Management** - RxJS Observables for all state
3. **Dependency Injection** - All services are injectable
4. **Testability** - Services are easy to unit test
5. **Modularity** - Can use pieces independently
6. **Extensibility** - Easy to add new features (multi-track, etc.)

---

## 📚 Further Reading

- [Angular Services](https://angular.io/guide/architecture-services)
- [RxJS Observables](https://rxjs.dev/guide/observable)
- [video.js Documentation](https://videojs.com/guides/)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
