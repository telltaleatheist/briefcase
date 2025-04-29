# Clippy Development Guide

This guide provides comprehensive documentation for developers working on the Clippy video downloader application. It covers the architecture, component structure, and implementation details necessary for development and troubleshooting.

## Architecture Overview

Clippy is built using a modern web application architecture with Electron as the container:

### Backend (NestJS)

- **App Module**: Central coordinator connecting all modules
- **Downloader Module**: Handles video downloading using yt-dlp
- **FFmpeg Module**: Processes videos (aspect ratio adjustment, thumbnail creation)
- **Path Module**: Handles file path resolution and directory operations
- **Socket Communication**: Provides real-time progress updates

### Frontend (Angular)

- **Standalone Components**: Modular UI elements using Angular's standalone component API
- **Services**: Handle business logic and API communication
- **WebSocket Integration**: Real-time updates using Socket.io

### Electron Wrapper

- **Main Process**: Manages application lifecycle and system integration
- **Renderer Process**: Loads the Angular frontend
- **IPC Communication**: Handles communication between processes

## Key Components

### Backend Components

#### Downloader Service

The `DownloaderService` is responsible for processing video download requests:

```typescript
// Key method for downloading videos
async downloadVideo(options: DownloadOptions, jobId?: string): Promise<string> {
  // Initialize download process
  // Track and emit progress events with jobId
  // Return path to downloaded file
}
```

**Key Events:**
- `download-started`: Emitted when download begins
- `download-progress`: Emitted during download (includes progress %)
- `download-completed`: Emitted when download finishes
- `download-failed`: Emitted on error

#### FFmpeg Service

The `FfmpegService` handles video processing:

```typescript
// Key method for fixing aspect ratio
async reencodeVideo(videoFile: string, jobId?: string): Promise<string | null> {
  // Process video to 16:9 aspect ratio with blurred background
  // Track and emit progress events with jobId
  // Return path to processed file
}
```

**Key Events:**
- `processing-progress`: Emitted during FFmpeg processing
- `processing-failed`: Emitted on error

#### Batch Downloader Service

The `BatchDownloaderService` manages queues for multiple downloads:

```typescript
// Process the queue
async processQueue(): Promise<void> {
  // Process items in queue with concurrency limits
  // Update queue status
}
```

**Key Events:**
- `batch-queue-updated`: Emitted when queue status changes
- `batch-completed`: Emitted when all items are processed

### Frontend Components

#### Download Form Component

The `DownloadFormComponent` handles user input for video URLs and options:

```typescript
// Submit form
onSubmit(): void {
  // Validate input
  // Send to API
  // Handle response
}
```

#### Download Progress Component

The `DownloadProgressComponent` displays download and processing progress:

```typescript
// Initialize component
ngOnInit(): void {
  // Subscribe to download-progress events
  // Subscribe to processing-progress events
  // Update UI accordingly
}
```

#### Batch Download Component

The `BatchDownloadComponent` manages batch queue operations:

```typescript
// Update job progress
updateJobProgress(jobId: string, progress: number, task: string | undefined): void {
  // Find job in appropriate queue
  // Update job progress value
  // Update job task description
}
```

## Data Flow

Understanding data flow is crucial for debugging and development:

### Download Flow

User submits URL → Frontend service calls API → Backend controller receives request → Downloader service processes request → Progress events emitted via WebSockets → Frontend updates UI

### Batch Processing Flow

Jobs added to queue → Batch service processes queue → Jobs move through download/processing stages → Events emitted for each stage → Frontend updates UI

### Event Communication Flow

- Backend emits events with `this.server.emit('event-name', data)`
- Frontend subscribes using `this.socketService.onEventName().subscribe()`
- **Critical**: All progress events must include `jobId` for proper tracking

## Critical Components for Progress Tracking

The progress tracking system relies on consistent event structure:

```typescript
{
  progress: number,    // 0-100 percentage value
  task: string,        // Description of current task
  jobId: string        // Unique identifier for the job
}
```

**Key Event Handlers:**
- `stderr` handler in FFmpeg service (parses output text)
- `progress` handler in FFmpeg service (receives direct progress)
- Progress calculation in downloader service

**Progress Calculation Logic:**
- FFmpeg duration-based: `progress = (currentTime / totalDuration) * 100`
- Download size-based: `progress = (downloadedBytes / totalBytes) * 100`

## Common Issues and Solutions

### Progress Bar Not Updating

**Possible Causes:**
- Missing `jobId` in emitted events
- Socket connection issues
- Progress events not properly parsed

**Debugging Steps:**
- Check backend logs for emitted events
- Verify `jobId` is included in all events
- Ensure frontend components are subscribing correctly
- Verify change detection is triggered after updates

**Solution Examples:**

```typescript
// In FFmpeg service:
this.safeEmit('processing-progress', { 
  progress: progressPercent,
  task: `Adjusting aspect ratio ${speedInfo}`,
  jobId // Must include jobId
});

// In download-progress.component.ts:
this.processingSubscription = this.socketService.onProcessingProgress().subscribe(
  (data: DownloadProgress) => {
    console.log('Received processing progress:', data);
    this.progress = data.progress;
    this.task = data.task || 'Processing video...';
    this.cdr.detectChanges(); // Force change detection
  }
);
```

### Download Failures

**Common Causes:**
- Missing yt-dlp, ffmpeg, and ffprobe binaries (can't find, not in PATH, etc)
- Network issues
- Site restrictions or changes

**Debugging:**
- Check yt-dlp output in logs
- Verify network connectivity
- Test URL directly with yt-dlp CLI

### FFmpeg Processing Issues

**Common Causes:**
- Incorrect FFmpeg path
- Invalid video format
- Insufficient permissions

**Debugging:**
- Check FFmpeg command in logs
- Verify FFmpeg binary location
- Test with a known good video file

## Development Environment Setup

### Prerequisites

- Node.js (version 18+)
- npm or yarn
- FFmpeg (binary in path or included in project)
- yt-dlp (binary in path or included in project)

### Installation Steps

```bash
# Clone Repository
git clone https://github.com/your-username/clippy.git
cd clippy

# Install Dependencies
npm install
cd frontend && npm install
cd ../backend && npm install
```

### Start Development Servers

```bash
# Terminal 1 - Backend
cd backend
npm run start:dev

# Terminal 2 - Frontend
cd frontend
npm run start

# Terminal 3 - Electron
npm run electron:dev
```

## Debugging Techniques

### Backend Debugging

**Enable Verbose Logging:**
- Set log level in `main.ts`
- Add debug logs in critical paths

**Event Tracing:**

```typescript
// Add to safeEmit or similar method
private safeEmit(event: string, data: any): void {
  this.logger.log(`Emitting event: ${event}`);
  this.logger.log(data);
  // Rest of emission code
}
```

**Socket Connection Verification:**

```typescript
// In main.ts after WebSocketAdapter setup
app.useWebSocketAdapter(new ExtendedIoAdapter(app));
console.log('WebSocket adapter configured');
```

### Frontend Debugging

**Event Subscription Logging:**

```typescript
this.socketService.onProcessingProgress().subscribe((data) => {
  console.log('Processing progress received:', data);
  // Rest of handler code
});
```

**Component State Inspection:**
- Use Angular DevTools Chrome extension
- Add console.log statements in key lifecycle methods

**Change Detection Verification:**

```typescript
// Add in progress event handlers
this.progress = data.progress;
console.log('Updated progress to:', this.progress);
this.cdr.detectChanges();
```

## Code Contribution Guidelines

**Branch Naming:**
- Features: `feature/description`
- Fixes: `fix/issue-description`
- Refactoring: `refactor/component-name`

**Commit Message Format:**
- Follow conventional commits: `type(scope): description`
- Example: `fix(ffmpeg): include jobId in processing-progress events`

**Testing:**
Testing libraries largely ignored in the project

## Deployment

### Building for Production

```bash
# Build everything
npm run build:all

# Create package
npm run package:mac
npm run package:mac-intel
npm run package:win
npm run package:linux
```

## Project Roadmap

**Planned Features:**
- Enhanced Queue Management:
  - Advanced priority settings
  - Resume interrupted downloads
- Media Processing:
  - Audio extraction
  - Trimming and clipping
- Platform Support:
  - Linux distribution
  - ARM support for Apple Silicon

## Need Help?

This documentation should provide a comprehensive understanding of the project architecture and implementation details. For specific issues:

**Check logs first:**
- Backend logs for API and process issues
- Frontend console for UI and event issues
- Log location for Mac: ~/Library/Logs/clippy/main.log

**Key log patterns:**
- "Emitting event" logs for WebSocket communication
- FFmpeg command logs for processing issues
- "Progress" logs for tracking calculation issues

**Ask for help with context:**
- Share relevant logs
- Describe steps to reproduce
- Include platform information
