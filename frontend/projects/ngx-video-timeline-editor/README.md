# ngx-video-timeline-editor

A professional Angular library for video timeline editing with waveform visualization, playback controls, and timeline manipulation.

## Features

- **Waveform Visualization**: Auto-generate and render audio waveforms from media elements
- **Timeline Components**: Professional-grade timeline UI components
  - Playhead with drag support
  - Timeline ruler with smart time markers (HH:MM:SS:FF format)
  - Zoom bar for navigation
  - Sections layer for categorized timeline markers
  - Selection tool for highlighting time ranges
- **Playback Controls**: Full integration with video.js player
  - J/K/L keyboard shortcuts (Final Cut Pro style)
  - Variable playback speeds (0.125x to 8x)
  - Precise seeking and navigation
- **State Management**: RxJS-based reactive state management
- **Zoom & Pan**: Smooth zoom and pan controls for precise editing
- **Standalone Components**: All components are standalone (Angular 19+)
- **TypeScript**: Fully typed for excellent IDE support

## Installation

```bash
npm install ngx-video-timeline-editor
```

### Peer Dependencies

This library requires the following peer dependencies:

```bash
npm install @angular/common@^19.0.0 @angular/core@^19.0.0 @angular/material@^19.0.0 rxjs@^7.8.0 video.js@^8.0.0
```

## Quick Start

### 1. Import Components

Since all components are standalone, you can import them directly:

```typescript
import { Component } from '@angular/core';
import {
  TimelineWaveformComponent,
  TimelinePlayheadComponent,
  TimelineRulerComponent,
  TimelineZoomBarComponent,
  TimelineSectionsLayerComponent,
  TimelineSelectionComponent,
  TimelineStateService,
  PlaybackControlService,
  ZoomState
} from 'ngx-video-timeline-editor';

@Component({
  selector: 'app-video-editor',
  standalone: true,
  imports: [
    TimelineWaveformComponent,
    TimelinePlayheadComponent,
    TimelineRulerComponent,
    TimelineZoomBarComponent,
    TimelineSectionsLayerComponent,
    TimelineSelectionComponent
  ],
  template: `
    <div class="video-timeline">
      <ngx-vte-timeline-ruler
        [duration]="duration"
        [zoomState]="zoomState"
        (markerMouseDown)="onRulerClick($event)">
      </ngx-vte-timeline-ruler>

      <ngx-vte-timeline-waveform
        [duration]="duration"
        [zoomState]="zoomState"
        [mediaElement]="videoElement">
      </ngx-vte-timeline-waveform>

      <ngx-vte-timeline-playhead
        [currentTime]="currentTime"
        [duration]="duration"
        [zoomState]="zoomState"
        [isDraggable]="true">
      </ngx-vte-timeline-playhead>

      <ngx-vte-timeline-zoom-bar
        [duration]="duration"
        [zoomState]="zoomState"
        (viewportDragStart)="onZoomDrag($event)">
      </ngx-vte-timeline-zoom-bar>
    </div>
  `
})
export class VideoEditorComponent {
  duration = 100;
  currentTime = 0;
  zoomState: ZoomState = { level: 1, offset: 0 };
  videoElement?: HTMLVideoElement;
}
```

### 2. Use Services for State Management

```typescript
import { Component, OnInit } from '@angular/core';
import { TimelineStateService } from 'ngx-video-timeline-editor';

@Component({
  selector: 'app-video-editor',
  standalone: true,
  providers: [TimelineStateService]
})
export class VideoEditorComponent implements OnInit {
  constructor(private timelineState: TimelineStateService) {}

  ngOnInit() {
    // Subscribe to state changes
    this.timelineState.duration$.subscribe(duration => {
      console.log('Duration:', duration);
    });

    this.timelineState.currentTime$.subscribe(currentTime => {
      console.log('Current time:', currentTime);
    });

    // Update state
    this.timelineState.setDuration(120);
    this.timelineState.setCurrentTime(30);
  }
}
```

## API Reference

### Components

#### TimelineWaveformComponent

Renders an audio waveform visualization.

**Selector**: `ngx-vte-timeline-waveform`

**Inputs**:
- `waveformData: number[]` - Pre-generated waveform data
- `duration: number` - Total duration in seconds
- `zoomState: ZoomState` - Current zoom state
- `color: string` - Waveform color (default: 'rgba(255, 143, 71, 0.8)')
- `mediaElement?: HTMLVideoElement | HTMLAudioElement` - Media element to generate waveform from
- `autoGenerate: boolean` - Auto-generate waveform from media element (default: true)

#### TimelinePlayheadComponent

Displays and controls the playhead position.

**Selector**: `ngx-vte-timeline-playhead`

**Inputs**:
- `currentTime: number` - Current playback time
- `duration: number` - Total duration
- `zoomState: ZoomState` - Current zoom state
- `isDraggable: boolean` - Enable drag to seek

**Outputs**:
- `playheadDragStart: EventEmitter<MouseEvent>` - Emitted when playhead drag starts

#### TimelineRulerComponent

Displays time markers on the timeline.

**Selector**: `ngx-vte-timeline-ruler`

**Inputs**:
- `duration: number` - Total duration
- `zoomState: ZoomState` - Current zoom state

**Outputs**:
- `markerMouseDown: EventEmitter<MouseEvent>` - Emitted when ruler is clicked

#### TimelineZoomBarComponent

Provides zoom and pan controls.

**Selector**: `ngx-vte-timeline-zoom-bar`

**Inputs**:
- `duration: number` - Total duration
- `zoomState: ZoomState` - Current zoom state

**Outputs**:
- `viewportDragStart: EventEmitter<MouseEvent>` - Viewport drag event
- `leftHandleDragStart: EventEmitter<MouseEvent>` - Left handle drag event
- `rightHandleDragStart: EventEmitter<MouseEvent>` - Right handle drag event

#### TimelineSectionsLayerComponent

Displays categorized sections/markers on timeline.

**Selector**: `ngx-vte-timeline-sections-layer`

**Inputs**:
- `sections: TimelineSection[]` - Array of timeline sections
- `duration: number` - Total duration
- `zoomState: ZoomState` - Current zoom state

#### TimelineSelectionComponent

Displays and controls time range selection.

**Selector**: `ngx-vte-timeline-selection`

**Inputs**:
- `selection: TimelineSelection` - Selected time range
- `duration: number` - Total duration
- `zoomState: ZoomState` - Current zoom state
- `selectedTool: 'cursor' | 'highlight'` - Current tool mode

**Outputs**:
- `windowDragStart: EventEmitter<MouseEvent>` - Selection window drag event
- `leftHandleDragStart: EventEmitter<MouseEvent>` - Left handle drag event
- `rightHandleDragStart: EventEmitter<MouseEvent>` - Right handle drag event

### Services

#### TimelineStateService

Central state management for timeline.

**Methods**:
- `setDuration(duration: number)` - Set total duration
- `setCurrentTime(time: number)` - Set current playback time
- `setIsPlaying(isPlaying: boolean)` - Set playback state
- `setSelection(selection: TimelineSelection)` - Set time selection
- `setSections(sections: TimelineSection[])` - Set timeline sections
- `setZoom(level: number, offset: number)` - Set zoom level and offset
- `setSelectedTool(tool: TimelineTool)` - Set selected tool
- `toggleCategoryFilter(category: string)` - Toggle category filter
- `toggleAutoFollowPlayhead()` - Toggle auto-follow playhead

**Observables**:
- `duration$: Observable<number>`
- `currentTime$: Observable<number>`
- `isPlaying$: Observable<boolean>`
- `selection$: Observable<TimelineSelection>`
- `sections$: Observable<TimelineSection[]>`
- `zoomState$: Observable<ZoomState>`
- `selectedTool$: Observable<TimelineTool>`
- `autoFollowPlayhead$: Observable<boolean>`

#### WaveformGeneratorService

Generates and renders audio waveforms.

**Methods**:
- `generateWaveform(mediaElement: HTMLVideoElement | HTMLAudioElement): Promise<number[]>` - Generate waveform data
- `renderWaveform(canvas: HTMLCanvasElement, waveformData: number[], options: WaveformRenderOptions)` - Render waveform to canvas
- `getWaveformSlice(waveformData: number[], duration: number, startTime: number, endTime: number): number[]` - Get time-range slice

#### PlaybackControlService

Manages video.js player integration and keyboard shortcuts.

**Methods**:
- `setPlayer(player: Player)` - Connect video.js player
- `play()` - Start playback
- `pause()` - Pause playback
- `togglePlayPause()` - Toggle playback
- `seek(time: number)` - Seek to time
- `seekRelative(delta: number)` - Seek relative to current time
- `setPlaybackSpeed(speed: PlaybackSpeed)` - Set playback rate
- `handleJKLKey(key: string)` - Handle J/K/L keyboard shortcuts

**Observables**:
- `playbackState$: Observable<PlaybackState>`

### Models

#### ZoomState
```typescript
interface ZoomState {
  level: number;  // Zoom level (1 = 100%, 2 = 200%, etc.)
  offset: number; // Pan offset in seconds
}
```

#### TimelineSection
```typescript
interface TimelineSection {
  startTime: number;
  endTime: number;
  category: string;
  description: string;
  color: string;
}
```

#### TimelineSelection
```typescript
interface TimelineSelection {
  startTime: number;
  endTime: number;
}
```

#### PlaybackState
```typescript
interface PlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
}
```

## Building the Library

To build the library for distribution:

```bash
cd frontend
ng build ngx-video-timeline-editor
```

The build artifacts will be stored in `dist/ngx-video-timeline-editor`.

## Publishing

After building the library:

```bash
cd dist/ngx-video-timeline-editor
npm publish
```

## Development

This library was generated with [Angular CLI](https://github.com/angular/angular-cli) version 19.2.0.

### Running Tests

```bash
ng test ngx-video-timeline-editor
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
