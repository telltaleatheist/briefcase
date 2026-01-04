# Ripplecut - Video Editor Component

A self-contained, Final Cut Pro-style video editor component for Angular. Designed to be portable and easily integrated with any backend.

## Features

- **Timeline Editor** - Multi-lane timeline with video, audio, and title tracks
- **Clip Management** - Drag and drop clips with frame-accurate snapping
- **Markers** - Support for standard, todo, chapter, and AI analysis markers
- **Chapters** - Chapter navigation and management
- **Transcript** - Transcript panel with search (Soundex and phrase search)
- **Keyboard Shortcuts** - Full FCPX-style keyboard shortcut support
- **Creamsicle Theme** - Beautiful sunset-inspired color scheme

## Installation

Copy the entire `ripplecut` folder into your Angular project:

```
src/app/pages/ripplecut/
├── index.ts                    # Public exports
├── ripplecut.models.ts         # TypeScript interfaces
├── ripplecut.component.ts      # Main component
├── ripplecut.component.html    # Template
├── ripplecut.component.scss    # Styles
└── README.md                   # This file
```

## Usage

### Basic Usage (Demo Mode)

```typescript
import { RipplecutComponent } from './ripplecut';

@Component({
  imports: [RipplecutComponent],
  template: `<app-ripplecut />`
})
export class MyComponent {}
```

### With Backend Data

```typescript
import {
  RipplecutComponent,
  TimelineClip,
  CustomMarker,
  TimelineChapter,
  TranscriptSegment,
  RipplecutConfig
} from './ripplecut';

@Component({
  imports: [RipplecutComponent],
  template: `
    <app-ripplecut
      [config]="config"
      [initialClips]="clips"
      [initialMarkers]="markers"
      [initialChapters]="chapters"
      [initialTranscript]="transcript"
      (playheadChange)="onPlayheadChange($event)"
      (clipChange)="onClipChange($event)"
      (exportRequest)="onExportRequest($event)"
    />
  `
})
export class MyComponent {
  config: RipplecutConfig = {
    frameRate: 30,
    showBrowser: true,
    showInspector: true,
    defaultInspectorTab: 'analysis'
  };

  clips: TimelineClip[] = [
    {
      id: 'clip-1',
      name: 'Main Video',
      startTime: 0,
      endTime: 120,
      lane: 0,
      color: '#d45a2a',
      mediaUrl: '/api/media/clip-1'
    }
  ];

  // ... load data from your backend
}
```

## Inputs

| Input | Type | Description |
|-------|------|-------------|
| `config` | `RipplecutConfig` | Configuration options |
| `initialClips` | `TimelineClip[]` | Initial clip data |
| `initialMarkers` | `CustomMarker[]` | Initial marker data |
| `initialChapters` | `TimelineChapter[]` | Initial chapter data |
| `initialTranscript` | `TranscriptSegment[]` | Initial transcript data |
| `initialTabs` | `EditorTab[]` | Initial tabs/projects |
| `externalTime` | `number` | External playhead control |

## Outputs

| Output | Type | Description |
|--------|------|-------------|
| `playheadChange` | `PlayheadChangeEvent` | Emits when playhead moves |
| `selectionChange` | `SelectionChangeEvent` | Emits when selection changes |
| `clipChange` | `ClipChangeEvent` | Emits when clip is modified |
| `markerChange` | `MarkerChangeEvent` | Emits when marker is modified |
| `exportRequest` | `ExportRequestEvent` | Emits when export is requested |
| `playStateChange` | `boolean` | Emits when play/pause state changes |

## Data Models

### TimelineClip

```typescript
interface TimelineClip {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  lane: number;        // 0 = master, 1+ = video overlays, -1+ = audio
  color?: string;
  sourceIn?: number;
  sourceOut?: number;
  mediaUrl?: string;   // For backend integration
  thumbnailUrl?: string;
}
```

### CustomMarker

```typescript
interface CustomMarker {
  id: string;
  time: number;
  endTime?: number;    // For range markers
  message: string;
  type: 'standard' | 'todo' | 'completed' | 'chapter' | 'analysis';
  clipId?: string;
  category?: string;   // For AI analysis
  severity?: 'low' | 'medium' | 'high';
}
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `J/K/L` | Rewind/Stop/Forward |
| `←/→` | Previous/Next Frame |
| `I/O` | Set In/Out Point |
| `H` | Toggle Highlight Mode |
| `M` | Add Marker |
| `A/T/B/R` | Select/Trim/Blade/Range Tool |
| `Cmd/Ctrl + +/-` | Zoom In/Out |
| `Cmd/Ctrl + 0` | Fit to Window |
| `?` | Show Shortcuts |

## Lane System

- **Lane 0**: Master track (primary video)
- **Lane 1, 2, 3...**: Video overlay tracks (titles, effects)
- **Lane -1, -2, -3...**: Audio tracks

## Styling

The component uses SCSS with CSS custom properties. Override the color variables to customize:

```scss
// In your global styles or component
.ripplecut {
  --accent: #ff6b35;        // Primary accent color
  --accent-bright: #ff8f5a;
  --bg-app: #1a1612;        // Background colors
  --bg-panel: #241e18;
  // ... etc
}
```

## Backend Integration Tips

1. **Load data on init**: Fetch clips, markers, chapters from your API and pass via inputs
2. **Save on change**: Listen to `clipChange` and `markerChange` events to sync with backend
3. **Media URLs**: Set `mediaUrl` and `thumbnailUrl` on clips for video playback
4. **Real-time sync**: Use Angular's change detection with WebSocket updates

## Dependencies

- Angular 17+
- CommonModule
- FormsModule

No external dependencies required.
