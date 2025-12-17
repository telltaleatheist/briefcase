# ClipChimp - Project Overview for Claude

ClipChimp is a professional media library manager desktop application with AI-powered video analysis capabilities. It's built as an Electron app with Angular frontend and NestJS backend.

## Tech Stack

- **Frontend**: Angular 17 (in `frontend-v3/`)
- **Backend**: NestJS with TypeScript (in `backend/`)
- **Desktop**: Electron with TypeScript (in `electron/`)
- **Database**: SQLite via better-sqlite3
- **AI Integration**: Ollama (local), Claude API, OpenAI API

## Project Structure

```
ClipChimp/
├── backend/             # NestJS API server
│   └── src/
│       ├── database/    # SQLite database service
│       ├── ffmpeg/      # Video processing with FFmpeg
│       ├── queue/       # Task queue management
│       ├── transcription/ # Whisper transcription
│       ├── ai-analysis/ # AI video analysis
│       └── saved-links/ # Save-for-later feature
├── electron/            # Electron main process
│   ├── main.ts          # App entry point
│   ├── preload.ts       # Context bridge for renderer
│   ├── services/        # Window, Backend, Update services
│   └── ipc/             # IPC handlers
├── frontend-v3/         # Angular frontend
│   └── src/app/
│       ├── pages/       # Route pages (library, settings)
│       ├── components/  # UI components
│       ├── services/    # Angular services
│       └── models/      # TypeScript interfaces
├── utilities/           # Bundled binaries (yt-dlp, whisper, ffmpeg)
├── scripts/             # Build and packaging scripts
└── shared/              # Shared TypeScript types
```

## Key Architecture

### Electron IPC Flow
1. **Preload script** (`electron/preload.ts`) exposes APIs to renderer via contextBridge
2. **IPC handlers** (`electron/ipc/ipc-handlers.ts`) handle main process operations
3. **ElectronService** (`frontend-v3/.../electron.service.ts`) wraps IPC calls in Angular

### Frontend Services (frontend-v3/src/app/services/)
- `library.service.ts` - Video library CRUD operations
- `video-processing.service.ts` - Queue video processing tasks
- `websocket.service.ts` - Real-time updates from backend
- `electron.service.ts` - Electron IPC wrapper
- `navigation.service.ts` - App navigation state

### Backend Services (backend/src/)
- `database/` - SQLite operations, video metadata, libraries
- `ffmpeg/ffmpeg.service.ts` - Video encoding, thumbnails, waveforms
- `queue/` - Task queue with progress tracking
- `transcription/` - Whisper-based audio transcription
- `ai-analysis/` - LLM-based video content analysis

### Key Components (frontend-v3/src/app/components/)
- `cascade/` - Grid/list view for video library
- `video-editor/` - Full video editor with timeline
- `queue-tab/` - Processing queue management
- `save-for-later-tab/` - Bookmarked links
- `library-manager-modal/` - Library settings
- `ai-setup-wizard/` - AI provider configuration

## Development Commands

```bash
# Install all dependencies
npm run install:all

# Development mode
npm run dev              # Build and start Electron
npm run dev:backend      # Just backend with hot reload
npm run dev:frontend     # Just frontend with watch

# Building
npm run build:all        # Full production build
npm run build:fast       # Quick dev build

# Packaging
npm run package:mac-arm64  # macOS ARM64 DMG
npm run package:mac-x64    # macOS Intel DMG
npm run package:win-x64    # Windows installer
```

## Database Schema

Videos are stored per-library in SQLite databases at:
`~/Library/Application Support/clippy/libraries/{library_id}/library.db`

Key tables:
- `videos` - Video metadata (filePath, duration, title, etc.)
- `analysis` - AI analysis results (JSON in `content` column)
- `chips` - Tags/categories for videos
- `tabs` - Custom video collections

## Common Tasks

### Adding a new IPC handler
1. Add handler in `electron/ipc/ipc-handlers.ts`
2. Expose in `electron/preload.ts` interface and contextBridge
3. Add method to `frontend-v3/.../electron.service.ts`

### Adding a new backend endpoint
1. Create/update controller in `backend/src/{module}/`
2. Add service method if needed
3. Call from frontend via HttpClient

### Adding a new component
1. Generate with `npx ng generate component components/{name}`
2. Components are standalone by default
3. Import into parent component's imports array

## Video Editor

The video editor (`components/video-editor/`) supports:
- Timeline with waveform visualization
- Section markers from AI analysis
- Custom markers with categories
- Export clips/selections
- Fullscreen mode
- Opens in a separate window (popout mode)

## AI Analysis Flow

1. Video added to queue with `ai-analyze` task
2. Backend extracts audio, runs transcription
3. Transcript sent to LLM (Ollama/Claude/OpenAI)
4. Analysis stored in `analysis` table as JSON
5. Frontend displays sections on video timeline

## Code Conventions

### Time Formatting
All timestamps in the UI must use the `HH:MM:SS` format (always showing hours with leading zeros). Example: `00:05:32` for 5 minutes and 32 seconds.

For components that require millisecond precision (like the video editor timeline), use `HH:MM:SS.mm` format. Example: `00:05:32.45`.

The standard `formatTime` function signature:
```typescript
formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
```

## Notes

- The app runs backend on a dynamic port (finds available port)
- Frontend served from backend in packaged app
- Binaries (ffmpeg, yt-dlp, whisper) bundled in `utilities/`
- Settings stored via electron-store (not in SQLite)
