# ClipChimp - Video Analysis & Clip Management System

**Project Status:** ✅ Production Ready
**Latest Version:** Phase 5 Complete (Nov 2025)
**Architecture:** Electron + Angular + NestJS + SQLite

---

## Project Vision

ClipChimp is a comprehensive desktop application for downloading, analyzing, and managing video content. It combines video downloading (via yt-dlp), AI-powered transcription and analysis (via Whisper + LLM), and a sophisticated library system for organizing and creating clips from 5,000+ videos.

---

## Core Features

### 1. Video Downloading
- **Batch Downloads**: Queue multiple videos with concurrent processing
- **Flexible Quality Options**: 144p to 4K video quality selection
- **Browser Cookie Support**: Access authenticated content
- **Format Conversion**: Automatic MP4 conversion with optional aspect ratio fixing
- **Progress Tracking**: Real-time download and processing progress via WebSockets

### 2. AI-Powered Analysis
- **Transcription**: Whisper-based audio-to-text conversion with SRT output
- **Content Analysis**: LLM-powered analysis of video content (Ollama, OpenAI, Claude)
- **Metadata Extraction**: Automatic categorization, tagging, and section detection
- **Batch Processing**: Analyze hundreds of videos with queue management

### 3. Library Management (Phase 5 ✅)
- **SQLite Database**: 5,353+ video library with full-text search
- **Smart Organization**: Date-based folder structure, file hashing for duplicate detection
- **Video Selection**: Multi-select interface with master checkbox
- **Configurable Storage**: User-defined clips folder location
- **Visual Indicators**: Long video highlighting (>10 min) with color coding
- **Auto-Detection**: Scan folders for unimported videos
- **Tag System**: AI-generated tags grouped by people, topics, and categories

### 4. Video Player & Clip Creation
- **Native HTML5 Player**: Full codec support (MP4, MOV, WebM, etc.)
- **Professional Shortcuts**: J/K/L shuttle, I/O markers, space to play/pause
- **Timeline Scrubbing**: Visual timeline with AI section markers
- **Custom Video Support**: Load and clip any video file, not just analyzed ones
- **FFmpeg Extraction**: Precise clip cutting with re-encoding options
- **Transcript Search**: Full-text search with jump-to-timestamp

---

## Architecture

### Technology Stack

**Frontend:**
- Angular 19 with standalone components
- Material Design UI (Angular Material)
- Socket.IO client for real-time updates
- CDK Virtual Scrolling for large lists

**Backend:**
- NestJS (Node.js framework)
- better-sqlite3 for database
- Socket.IO for WebSocket communication
- yt-dlp for video downloading
- FFmpeg for media processing
- Python 3.11+ for AI analysis

**Desktop:**
- Electron wrapper
- IPC communication
- Native file system access

### Database Schema (SQLite)

**Core Tables:**
- `videos`: Video metadata (filename, path, hash, duration, file size)
- `transcripts`: Plain text and SRT format transcripts with FTS
- `analyses`: AI-generated analysis reports with FTS
- `analysis_sections`: Timestamped interesting moments
- `tags`: AI and manual tags (people, topics, categories)

**Key Features:**
- FTS5 full-text search for transcripts and analyses
- Foreign key cascades for data integrity
- File hashing (SHA-256 of first 1MB) for duplicate detection
- Link tracking (is_linked flag) for missing file handling

---

## Development Phases Completed

### Phase 1: Core Foundation ✅
- NestJS backend architecture
- Angular frontend with Material Design
- yt-dlp integration
- FFmpeg processing pipeline
- WebSocket real-time communication

### Phase 2: Batch Processing ✅
- State-based job management
- Concurrent download queue
- Progress tracking system
- Job persistence and recovery

### Phase 3: Video Player ✅
- Native HTML5 video playback
- Keyboard shortcuts (J/K/L shuttle, I/O markers)
- Timeline with AI section visualization
- Transcript search and sync
- Custom video support

### Phase 4: AI Analysis ✅
- Whisper transcription integration
- Multi-provider LLM support (Ollama, OpenAI, Claude)
- Python bridge service
- Batch analysis queue
- Metadata extraction and tagging

### Phase 5: Library Management ✅
- SQLite database implementation
- File scanner with hash-based deduplication
- Full-text search (transcripts + analyses)
- Video selection UI with checkboxes
- Configurable clips folder
- Long video highlighting
- Auto-detect unimported videos API
- Clean notification system

---

## Key Accomplishments

### Performance
- **5,353+ videos** managed in SQLite database
- Virtual scrolling for smooth UI with large libraries
- FTS5 full-text search across all transcripts and analyses
- WAL mode for concurrent read/write operations

### User Experience
- Material Design with dark/light theme support
- Real-time progress updates via WebSockets
- Smart notifications (badge + toast) for important events only
- Professional video editing shortcuts
- Drag-and-drop timeline markers

### Data Management
- File hash-based duplicate detection
- Automatic relinking for moved files
- Date-based folder organization (YYYY-MM-DD)
- Missing file tracking (is_linked flag)
- Tag grouping by type (people, topic, other)

### Code Quality
- TypeScript strict mode throughout
- Standalone Angular components
- State-based job management
- Modular service architecture
- Path alias resolution (converted to relative imports)

---

## Technical Highlights

### Real-Time Communication
All progress updates flow through WebSocket events:
- `download-progress`: yt-dlp download updates
- `processing-progress`: FFmpeg processing updates
- `batch-queue-updated`: Batch job state changes
- `transcription-progress`: Whisper transcription updates
- `analysis-progress`: LLM analysis updates

### Video Streaming
HTTP range request support for seeking:
```
GET /api/library/videos/:id          # Stream analyzed video
GET /api/library/videos/custom?path=  # Stream custom video
```

### Clip Extraction
FFmpeg-based precise clip cutting:
```
POST /api/library/analyses/:id/extract-clip        # From analyzed video
POST /api/library/videos/custom/extract-clip       # From custom video
```

### Python Integration
Python bridge service manages AI operations:
- Python path detection (system vs bundled)
- Conda/virtualenv support
- Whisper model management
- LLM provider abstraction (Ollama, OpenAI, Claude)

---

## Build & Deployment

### Development
```bash
# Backend
cd backend && npm run start:dev

# Frontend
cd frontend && npm start

# Electron
npm run electron:dev
```

### Production Packaging
```bash
# Package Python dependencies
npm run package:python:mac-arm64  # or appropriate platform

# Build and package app
npm run build:all
npm run package:mac-arm64         # or other platform
```

### Supported Platforms
- macOS (Apple Silicon)
- macOS (Intel)
- Windows (x64)
- Linux (x64)

---

## Critical Fixes Applied

### better-sqlite3 Native Module
**Issue:** Module compiled against Node v131 but Electron requires v135
**Solution:** `npm rebuild better-sqlite3 --build-from-source`

### TypeScript Build Corruption
**Issue:** `tsconfig.build.tsbuildinfo` corruption preventing compilation
**Solution:** Remove cached tsbuildinfo file before builds

### Path Alias Resolution
**Issue:** `@/` path aliases not resolved in compiled JavaScript
**Solution:** Converted to relative imports (2 files affected)

### Video.js to Native HTML5
**Issue:** Poor MOV file support, large bundle size
**Solution:** Migrated to native `<video>` element for better codec support

---

## Project Statistics

- **Total Videos Managed:** 5,353+
- **Code Files:** 150+ TypeScript/Angular files
- **Database Tables:** 5 core tables + 2 FTS tables
- **API Endpoints:** 60+ REST endpoints
- **WebSocket Events:** 10+ real-time event types
- **Development Phases:** 5 major phases completed
- **Documentation:** 20+ MD files consolidated

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Container                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Angular Frontend (Port 4200)              │ │
│  │  • Material Design UI                                  │ │
│  │  • Video Player Component                              │ │
│  │  • Library Management                                  │ │
│  │  • Batch Download Queue                                │ │
│  │  • Socket.IO Client                                    │ │
│  └───────────────────┬────────────────────────────────────┘ │
│                      │ HTTP/WebSocket                       │
│  ┌───────────────────▼────────────────────────────────────┐ │
│  │              NestJS Backend (Port 3000)                │ │
│  │  • REST API Controllers                                │ │
│  │  • WebSocket Gateway                                   │ │
│  │  • Job Queue Management                                │ │
│  │  • Database Service (SQLite)                           │ │
│  │  • Python Bridge Service                               │ │
│  └──┬──────┬──────┬──────┬──────┬─────────────────────────┘ │
│     │      │      │      │      │                            │
│  ┌──▼───┐ │      │      │   ┌──▼─────────────┐              │
│  │yt-dlp│ │      │      │   │  Python 3.11+  │              │
│  │Binary│ │      │      │   │  • Whisper     │              │
│  └──────┘ │      │      │   │  • LLM Client  │              │
│         ┌──▼───┐ │      │   └────────────────┘              │
│         │FFmpeg│ │      │                                    │
│         │Binary│ │      │                                    │
│         └──────┘ │   ┌──▼──────────────┐                    │
│               ┌──▼───▼───────────────┐ │                    │
│               │   SQLite Database    │ │                    │
│               │  • Videos (5,353+)   │ │                    │
│               │  • Transcripts       │ │                    │
│               │  • Analyses          │ │                    │
│               │  • Tags              │ │                    │
│               └──────────────────────┘ │                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Next Steps

See [TODO.md](TODO.md) for planned features and improvements.

---

**Last Updated:** November 6, 2025
**Contributors:** Development team
**License:** Proprietary
