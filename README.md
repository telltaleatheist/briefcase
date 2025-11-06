# Clippy Development Guide

This guide provides comprehensive documentation for developers working on the Clippy video downloader application. It covers the architecture, component structure, and implementation details necessary for development and troubleshooting.

## Architecture Overview

Clippy is built using a modern web application architecture with Electron as the container:

### Backend (NestJS)

- **App Module**: Central coordinator connecting all modules
- **Downloader Module**: Handles video downloading using yt-dlp
- **FFmpeg Module**: Processes videos (aspect ratio adjustment, thumbnail creation)
- **Path Module**: Handles file path resolution and directory operations
- **Socket Communication**: Provides real-time progress updates via WebSockets

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

The DownloaderService is responsible for processing video download requests:

```typescript
// Key method for downloading videos
async downloadVideo(options: DownloadOptions, jobId?: string): Promise<DownloadResult> {
  // Initialize download process
  // Track and emit progress events with jobId
  // Return result with output file path and success status
}
```

### Key Events:

- **download-started**: Emitted when download begins
- **download-progress**: Emitted during download (includes progress %)
- **download-completed**: Emitted when download finishes
- **download-failed**: Emitted on error

### YtDlpManager

The `YtDlpManager` is a utility class that wraps the yt-dlp command-line tool:

```typescript
// Execute the yt-dlp command with retries
async runWithRetry(maxRetries = 3, delayMs = 1000): Promise<string> {
  // Execute command with exponential backoff on failure
  // Emit progress events during download
  // Handle cancellation and error cases
}
```

**Key Events:**
- `progress`: Emitted as download progresses with percentage and speed info
- `retry`: Emitted when a download is being retried after failure

### FFmpeg Service

The `FFmpegService` handles video processing:

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

### Batch Downloader Service

The `BatchDownloaderService` manages jobs using a state-based architecture:

```typescript
// Single collection of all jobs
private jobs: Map<string, Job> = new Map();

// Add a new job to the system
addToBatchQueue(options: DownloadOptions): string {
  // Generate unique job ID
  // Create job with 'queued' status
  // Add to jobs collection
  // Start queue processing
  // Return job ID
}

// Process the queue
private async processQueue(): Promise<void> {
  // Process queued jobs up to concurrency limit
  // When all downloads complete, process downloaded jobs
  // Update job states and emit updates
}
```

**Job States:**
- `queued`: Initial state, waiting to start downloading
- `downloading`: Currently being downloaded with yt-dlp
- `downloaded`: Download complete, waiting for processing
- `processing`: Currently being processed with FFmpeg
- `completed`: All processing finished
- `failed`: Error occurred during download or processing

**Key Events:**
- `batch-queue-updated`: Emitted when job states change
- `batch-completed`: Emitted when all jobs are processed

### Media Processing Service

The `MediaProcessingService` handles post-download processing operations:

```typescript
// Process a media file with options
async processMedia(
  inputFile: string, 
  options: ProcessingOptions,
  jobId?: string
): Promise<ProcessingResult> {
  // Fix aspect ratio if requested
  // Create thumbnail if requested
  // Extract audio if requested
  // Return paths to processed files
}
```

### Video Player and Clip Creation System

Clippy includes a comprehensive video player and clip creation system that allows users to:
- Play any video file (analyzed or custom)
- Create clips from specific time ranges
- View AI analysis sections and transcripts
- Use professional keyboard shortcuts for video editing

#### Video Player Architecture

The video player system uses **native HTML5 video** (as of the latest update) for maximum compatibility with various video formats, especially MOV and MP4 files in Electron/Chromium.

**Key Components:**
- `VideoPlayerComponent`: Main video player with native HTML5 `<video>` element
- `VideoTimelineComponent`: Timeline scrubber with range selection for clip creation
- `ClipCreatorComponent`: Interface for selecting videos from the library or custom files
- `CreateClipDialogComponent`: Dialog for configuring clip export settings
- `TranscriptSearchComponent`: Search and navigate through video transcripts

**Video Streaming Endpoints:**

The backend provides two video streaming endpoints with HTTP range request support:

```typescript
// 1. Stream analyzed videos by analysis ID
@Get('videos/:id')
async streamVideo(@Param('id') id: string, @Req() req, @Res() res) {
  // Looks up video path from analysis record
  // Streams video with range request support for seeking
}

// 2. Stream custom videos by file path (NEW)
@Get('videos/custom')
async streamCustomVideo(@Query('path') encodedPath: string, @Req() req, @Res() res) {
  // Accepts base64-encoded file path
  // Streams any video file directly without requiring analysis
  // IMPORTANT: Must be defined BEFORE videos/:id to avoid route conflicts
}
```

**Route Ordering:** The `/videos/custom` route **must** be defined before `/videos/:id` in the controller because NestJS matches routes in order. If the generic `:id` route comes first, it will match "custom" as an ID parameter, causing 404 errors.

**Video Format Support:**

The native HTML5 video player in Electron/Chromium supports:
- `.mp4` (H.264/AAC, HEVC)
- `.mov` (H.264/AAC in QuickTime container)
- `.webm` (VP8/VP9/AV1)
- `.ogg` (Theora)
- `.avi` (limited codec support)
- `.mkv` (limited support, depends on codecs)

**Proper MIME types** are set based on file extension:
- `.mov` → `video/quicktime`
- `.mp4` → `video/mp4`
- `.webm` → `video/webm`

#### Video Player Features

**Keyboard Shortcuts:**
- `Space`: Play/Pause (resets speed to 1x)
- `Arrow Left/Right`: Seek backward/forward 5 seconds
- `J/K/L`: Shuttle controls (backward/pause/forward with speed ramping)
- `I`: Set In point (clip start)
- `O`: Set Out point (clip end)
- `F`: Toggle fullscreen

**Timeline Features:**
- Visual timeline with colored sections for AI analysis categories
- Draggable in/out handles for precise clip selection
- Hover scrubbing to preview different timestamps
- Click to seek to specific time
- Synchronized with video playback

**AI Analysis Integration:**
- Sidebar displays AI-detected sections with timestamps
- Click section to jump to that timestamp
- Auto-scrolls to active section during playback
- Color-coded by category (extremism, conspiracy, routine, etc.)
- Displays key quotes from each section

**Transcript Search:**
- Full-text search through video transcript
- Click search results to jump to that timestamp
- Highlights matched terms
- Synchronized scrolling with video playback

#### Clip Extraction System

**Backend Clip Extraction:**

The system provides two clip extraction endpoints:

```typescript
// 1. Extract clip from analyzed video
@Post('analyses/:id/extract-clip')
async extractClip(@Param('id') id: string, @Body() body: ClipOptions) {
  // Looks up video from analysis record
  // Uses FFmpeg to extract clip
  // Returns output path
}

// 2. Extract clip from custom video (NEW)
@Post('videos/custom/extract-clip')
async extractClipFromCustomVideo(@Body() body: CustomClipOptions) {
  // Accepts video path directly
  // No analysis required
  // Uses FFmpeg to extract clip with optional re-encoding
}
```

**Clip Creation Flow:**

1. User selects time range on timeline using I/O keys or dragging
2. Click "Create Clip" button opens `CreateClipDialogComponent`
3. User configures:
   - Output filename
   - Save location (custom or default)
   - Category label (optional)
   - Title/description metadata
4. Backend uses FFmpeg to extract the exact time range
5. Clip filename includes timestamp range: `[START-END] Title.mp4`
6. Notification allows user to open clip location

**FFmpeg Clip Extraction:**

```typescript
// Example FFmpeg command for clip extraction
ffmpeg -i input.mp4 -ss START_TIME -to END_TIME \
  -c:v libx264 -c:a aac \
  -movflags +faststart \
  output.mp4
```

#### Custom Video Support

Users can now load **any video file** for clip creation, not just AI-analyzed videos:

**Frontend Flow:**
```typescript
// In ClipCreatorComponent
async selectCustomVideo() {
  // Open Electron file picker
  const result = await electron.showOpenDialog({
    filters: [{ name: 'Video Files', extensions: ['mp4', 'mov', ...] }]
  });

  // Create temporary video object
  const customVideoData = {
    id: `custom-${Date.now()}`,
    title: filename,
    videoPath: absolutePath,
    isCustom: true
  };

  // Open video player
  openVideoPlayerForCustomVideo(customVideoData);
}
```

**Backend Streaming:**
```typescript
// Decode base64-encoded path
const videoPath = Buffer.from(encodedPath, 'base64').toString('utf-8');

// Stream with range request support
if (range) {
  const stream = createReadStream(videoPath, { start, end });
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Content-Type': contentType
  });
  stream.pipe(res);
}
```

#### Migration from Video.js to Native HTML5

**Previous Implementation (Video.js):**
- Used Video.js library for video playback
- Had limited codec support, especially for MOV files
- Required complex setup and styling overrides
- Heavier bundle size

**Current Implementation (Native HTML5):**
- Uses native `<video>` element
- Better codec support through Electron/Chromium
- Simpler implementation and maintenance
- Lighter bundle size
- Direct access to video element properties

**Key Changes:**
```typescript
// OLD (Video.js):
player: Player | null = null;
this.player = videojs('video-element');
this.player.play();

// NEW (Native HTML5):
videoEl: HTMLVideoElement | null = null;
this.videoEl = this.videoElement.nativeElement;
this.videoEl.play();
```

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
  // Update UI based on job progress
}
```

#### Batch Download Component

The `BatchDownloadComponent` manages batch job operations:

```typescript
// Update job progress
updateJobProgress(jobId: string, progress: number, task: string | undefined): void {
  // Find job in the appropriate state array
  // Update job progress value
  // Update job task description
}

// Get all jobs for display
getAllJobsForDisplay(): JobResponse[] {
  // Combine jobs from all state arrays
  // Sort by original order
  // Display in UI
}
```

### Data Flow

Understanding data flow is crucial for debugging and development:

#### Download Flow

1. User submits URL(s) → Frontend validates and generates `displayName`
2. Frontend sends `DownloadOptions` to backend API (includes `displayName`)
3. Backend creates `Job` object with `'queued'` status
4. Backend processes queue and updates job to `'downloading'`
5. `yt-dlp` downloads the video and emits progress events
6. Job updates to `'downloaded'` when complete
7. `FFmpeg` processes the video when no downloads are active
8. Job updates to `'processing'` and then `'completed'`
9. WebSockets broadcast updates to frontend
10. Frontend displays job progress and status

### State-Based Job Management

The system uses a state-based approach to job management:

- **Single Source of Truth:** All jobs are stored in a single `Map<string, Job>` indexed by ID
- **State Transitions:**
  - `queued` → `downloading` → `downloaded` → `processing` → `completed`
  - `queued` → `failed`

#### Job Status Functions:

```typescript
// Get jobs by status
private getJobsByStatus(status: JobStatus): Job[] {
  return Array.from(this.jobs.values())
    .filter(job => job.status === status);
}

// Update job progress
updateJobProgress(jobId: string, progress: number, task: string): void {
  const job = this.jobs.get(jobId);
  if (job) {
    job.progress = progress;
    job.currentTask = task;
    this.emitQueueUpdate();
  }
}
```

#### Batch Status Reporting:

```typescript
// Get current queue status
getBatchStatus(): BatchQueueStatus {
  // Create arrays for each job state
  const queuedJobs = this.getJobsByStatus('queued')
    .map(job => this.formatJobForResponse(job));
  
  // Return comprehensive status object
  return {
    queuedJobs,
    downloadingJobs,
    downloadedJobs,
    processingJobs,
    completedJobs,
    failedJobs,
    activeDownloadCount: downloadingJobs.length,
    maxConcurrentDownloads: this.maxConcurrentDownloads,
    isProcessing: this.isProcessing
  };
}
```

### Benefits of State-Based Approach

- No data loss during state transitions
- Clear visualization of job status
- Simplified error handling and recovery
- Better control over concurrent operations
- Single source of truth for job data

### Core Data Types

#### Backend Types

```typescript
// Job status type for state-based processing
export type JobStatus = 'queued' | 'downloading' | 'downloaded' | 'processing' | 'completed' | 'failed';

// Job interface represents a download/processing task
export interface Job {
  id: string;              // Unique identifier
  url: string;             // Source URL
  displayName: string;     // Sanitized filename (created in frontend)
  status: JobStatus;       // Current state
  progress: number;        // 0-100 percentage
  currentTask: string;     // Description of current action
  error?: string;          // Error message if failed
  createdAt: string;       // Creation timestamp
  options: DownloadOptions; // Original download options
  downloadStartTime?: string;
  downloadEndTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
  outputFile?: string;     // Path to downloaded/processed file
  thumbnail?: string;      // Path to generated thumbnail
}
```

#### Frontend Types

```typescript
// Response type for batch status
export interface BatchQueueStatus {
  queuedJobs: JobResponse[];
  downloadingJobs: JobResponse[];
  downloadedJobs: JobResponse[];
  processingJobs: JobResponse[];
  completedJobs: JobResponse[];
  failedJobs: JobResponse[];
  activeDownloadCount: number;
  maxConcurrentDownloads: number;
  isProcessing: boolean;
}

// Progress event structure
export interface DownloadProgress {
  progress: number;
  task?: string;
  jobId?: string;
}
```

### Critical Components for Progress Tracking

The progress tracking system relies on a consistent event structure:

```typescript
{
  progress: number,    // 0-100 percentage value
  task: string,        // Description of current task
  jobId: string        // Unique identifier for the job
}
```

### Key Event Handlers

#### YtDlpManager Progress Parsing

The `YtDlpManager` parses download progress from yt-dlp output:

```typescript
private parseDownloadProgress(line: string): boolean {
  // Matches: [download] 32.5% of ~50.33MiB at 2.43MiB/s ETA 00:20
  const downloadProgressRegex = /\[download\]\s+(\d+\.\d+)%\s+of\s+~?(\d+\.\d+)(\w+)\s+at\s+(\d+\.\d+)(\w+\/s)\s+ETA\s+(\d+:\d+)/;
  const match = line.match(downloadProgressRegex);
  
  if (match) {
    // Extract and calculate progress data
    this.emit('progress', { percent, totalSize, downloadedBytes, downloadSpeed, eta });
    return true;
  }
  return false;
}
```

#### FFmpeg Progress Calculation

FFmpeg progress calculation in the FFmpeg service:

```typescript
command.on('stderr', (stderrLine) => {
  // Extract time from FFmpeg output
  const timeMatch = stderrLine.match(/time=(\d+:\d+:\d+\.\d+)/);
  if (timeMatch) {
    // Calculate progress based on current time / total duration
    const currentTimeInSeconds = /* convert time string to seconds */;
    let progressPercent = (currentTimeInSeconds / totalDuration) * 100;
    // Emit progress
    this.eventService.emitProcessingProgress(progressPercent, task, jobId);
  }
});
```

### Common Issues and Solutions

#### Progress Bar Not Updating

**Possible Causes:**

- Missing jobId in emitted events
- Socket connection issues
- Progress events not properly parsed
- Job not found in the correct state array

**Debugging Steps:**

- Check backend logs for emitted events
- Verify `jobId` is included in all events
- Ensure frontend components are subscribing correctly
- Verify change detection is triggered after updates

### Frontend Progress Handling

```typescript
// In batch-download.component.ts
updateJobProgress(jobId: string, progress: number, task: string | undefined): void {
  if (!this.batchQueueStatus) return;
  
  // Function to find and update job in a specific state array
  const updateJobInArray = (array: JobResponse[]): boolean => {
    const jobIndex = array.findIndex(j => j.id === jobId);
    if (jobIndex >= 0) {
      array[jobIndex].progress = progress;
      if (task !== undefined) {
        array[jobIndex].currentTask = task;
      }
      return true;
    }
    return false;
  };
  
  // Try to find the job in all state arrays
  const stateArrays = [
    this.batchQueueStatus.queuedJobs || [],
    this.batchQueueStatus.downloadingJobs || [],
    this.batchQueueStatus.downloadedJobs || [],
    this.batchQueueStatus.processingJobs || [],
    this.batchQueueStatus.completedJobs || [],
    this.batchQueueStatus.failedJobs || []
  ];
  
  let found = false;
  for (const array of stateArrays) {
    if (updateJobInArray(array)) {
      found = true;
      break;
    }
  }
  
  // Force change detection when job is updated
  if (found) {
    this.cdr.detectChanges();
  }
}
```

### Download Failures

**Common Causes:**

- Missing `yt-dlp` executable or incorrect path
- Network issues
- Site restrictions or changes

### Debugging

**Debugging Steps:**

- Check `yt-dlp` error output in logs
- Verify the path to the `yt-dlp` executable:

```typescript
private getYtDlpPath(): string {
  // Check environment variable first
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    return process.env.YT_DLP_PATH;
  }
  
  // Fall back to shared config
  const ytDlpPath = this.sharedConfigService.getYtDlpPath();
  if (!ytDlpPath || !fs.existsSync(ytDlpPath)) {
    throw new Error('yt-dlp executable not found');
  }
  
  return ytDlpPath;
}
```

### FFmpeg Processing Issues

**Common Causes:**

- Incorrect FFmpeg path
- Invalid video format
- Insufficient permissions

#### Error Handling:

```typescript
try {
  // Process video if needed
  if (job.options.fixAspectRatio) {
    job.currentTask = 'Processing video...';
    
    const result = await this.mediaProcessingService.processMedia(
      job.outputFile,
      { fixAspectRatio: job.options.fixAspectRatio },
      job.id
    );
    
    if (result.success && result.outputFile) {
      job.outputFile = result.outputFile;
    }
  }
} catch (error) {
  // Handle processing error
  const errorMsg = error instanceof Error ? error.message : String(error);
  job.status = 'failed';
  job.error = errorMsg;
  job.currentTask = `Failed: ${errorMsg}`;
  job.progress = 0;
  
  this.logger.error(`Processing failed for job ${job.id}`, { error: errorMsg });
}
```

### Development Environment Setup

#### Prerequisites:

- Node.js (version 18+)
- npm or yarn
- FFmpeg (binary in path or included in project)
- yt-dlp (binary in path or included in project)
- **Python 3.11+** (for video analysis features)
  - Required packages: `whisper`, `requests`, `openai` (optional), `anthropic` (optional)
  - Install via: `pip install -r backend/python/requirements.txt`

#### Python Configuration

Clippy supports multiple Python configuration modes:

**1. Development Mode (Recommended for Development):**
```bash
npm run electron:dev
```
- Uses your **system Python** (e.g., conda environment, system python3)
- Allows you to use your local Python with dependencies already installed
- **Setup:** Install dependencies manually:
  ```bash
  pip install -r backend/python/requirements.txt
  # OR if using conda:
  conda create -n metadata-generator python=3.11
  conda activate metadata-generator
  pip install -r backend/python/requirements.txt
  ```

**2. Development with Bundled Python (For Testing Packaging):**
```bash
npm run electron:dev:bundled
```
- Uses **bundled Python** from `dist-python/python-{arch}/`
- Useful for testing the packaged Python environment without building the full app
- **Setup:** Run the Python packaging script first:
  ```bash
  npm run package:python:mac-arm64  # or appropriate platform
  ```

**3. Production Mode (Packaged App):**
```bash
npm run package:mac-arm64  # or other platform
```
- Uses **bundled Python** from `resources/python/`
- Python and all dependencies are packaged with the app
- Self-contained, no system dependencies required

**Environment Variables:**
- `NODE_ENV`: Set to `development` or `production`
- `USE_BUNDLED_PYTHON`: Set to `true` to use bundled Python in dev mode
- `USE_SYSTEM_PYTHON`: Set to `true` to force system Python even in production (for debugging)

**Python Configuration File:** See [backend/src/shared/python-config.ts](backend/src/shared/python-config.ts) for implementation details.

#### Installation Steps:

```bash
# Clone Repository
git clone https://github.com/your-username/clippy.git
cd clippy
```

### Install Dependencies

```bash
npm install
cd frontend && npm install
cd ../backend && npm install
```

### Start Development Servers

#### Terminal 1 - Backend

```bash
cd backend
npm run start:dev
```

#### Terminal 2 - Frontend

```bash
cd frontend
npm run start
```

#### Terminal 3 - Electron

```bash
npm run electron:dev
```

### Debugging Techniques

#### Backend Debugging

**Enable Verbose Logging:**
- Set log level in `main.ts`
- Add debug logs in critical paths

#### Event Tracing:

```typescript
// Add to emitEvent or similar method
private emitQueueUpdate(): void {
  const status = this.getBatchStatus();
  this.logger.debug(`Emitting batch-queue-updated event with status:`, {
    queuedCount: status.queuedJobs.length,
    downloadingCount: status.downloadingJobs.length,
    downloadedCount: status.downloadedJobs.length,
    processingCount: status.processingJobs.length,
    completedCount: status.completedJobs.length,
    failedCount: status.failedJobs.length
  });
  this.eventService.emitBatchQueueUpdated(status);
}
```

#### Socket Connection Verification:

```typescript
// In main.ts after WebSocketAdapter setup
app.useWebSocketAdapter(new ExtendedIoAdapter(app));
console.log('WebSocket adapter configured');
```

### Frontend Debugging

#### Event Subscription Logging:

```typescript
this.socketService.onProcessingProgress().subscribe((data) => {
  console.log('Processing progress received:', data);
});
```

#### Component State Inspection:
- Use Angular DevTools Chrome extension
- Add `console.log` statements in key lifecycle methods

#### Change Detection Verification:

```typescript
// Add in progress event handlers
this.progress = data.progress;
console.log('Updated progress to:', this.progress);
this.cdr.detectChanges();
```

### Code Contribution Guidelines

**Branch Naming:**
- Features: `feature/description`
- Fixes: `fix/issue-description`
- Refactoring: `refactor/component-name`

**Commit Message Format:**
- Follow conventional commits: `type(scope): description`
- Example: `fix(ffmpeg): include jobId in processing-progress events`

**Testing:**
- Testing libraries largely ignored in the project

### Deployment

#### Building for Production:

```bash
# Build everything
npm run build:all

# Create package
npm run package:mac
npm run package:mac-intel
npm run package:win
npm run package:linux
```

### Project Roadmap

#### Planned Features:

- **Enhanced Job Management:**
  - Advanced priority settings
  - Resume interrupted downloads

- **Media Processing:**
  - Audio extraction
  - Trimming and clipping

- **Platform Support:**
  - Linux distribution
  - ARM support for Apple Silicon

### Need Help?

This documentation should provide a comprehensive understanding of the project architecture and implementation details. For specific issues:

- Check logs first:
  - Backend logs for API and process issues
  - Frontend console for UI and event issues
  - Log location for Mac: `~/Library/Logs/clippy/main.log`

**Key log patterns:**
- "Emitting event" logs for WebSocket communication
- `FFmpeg` command logs for processing issues
- "Progress" logs for tracking calculation issues

**Ask for help with context:**
- Share relevant logs
- Describe steps to reproduce
- Include platform information
