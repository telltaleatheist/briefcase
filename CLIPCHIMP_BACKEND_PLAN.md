# ClipChimp Backend Architecture - Pragmatic Implementation Plan

## Table of Contents
1. [Executive Summary](#executive-summary)
2. [Core Architecture](#core-architecture)
3. [Database Design](#database-design)
4. [Queue System](#queue-system)
5. [API Specification](#api-specification)
6. [WebSocket Events](#websocket-events)
7. [Task Processing](#task-processing)
8. [Browser Extension Integration](#browser-extension-integration)
9. [Implementation Plan](#implementation-plan)

---

## Executive Summary

### Project Overview
ClipChimp is a refactored version of Clippy with a new Angular frontend and streamlined NestJS backend. The system uses an **outcome-based architecture** where the database tracks "what has been done to videos" rather than "what work is in progress."

### Key Design Principles
- **Outcome-Based Storage**: Database tracks video states (has_transcript, has_analysis, etc.), not processing tasks
- **Ephemeral Queue**: In-memory work-in-progress that doesn't need to survive crashes
- **5+1 Concurrent Model**: 5 general tasks + 1 AI task run simultaneously
- **Task-Based Scheduling**: Individual tasks from different jobs execute in parallel
- **Unified Events**: Simple WebSocket events for real-time updates

### Technology Stack
- **Backend**: NestJS v11.x (existing)
- **Database**: SQLite with Better-SQLite3 (existing)
- **Real-time**: Socket.IO WebSockets (existing)
- **Frontend**: Angular (new, port 4300)
- **Desktop**: Electron wrapper
- **Video Processing**: FFmpeg, yt-dlp, Whisper, GPT-4/Claude

---

## Core Architecture

### The 5+1 Pool Model

```
┌─────────────────────────────────────────────────┐
│              MAIN TASK POOL (5 Max)              │
├─────────────────────────────────────────────────┤
│ Slot 1: Download    - Job #1 [====45%====]      │
│ Slot 2: Transcribe  - Job #3 [=====78%===]      │
│ Slot 3: Download    - Job #2 [==23%======]      │
│ Slot 4: Normalize   - Job #5 [========90%]      │
│ Slot 5: Import      - Job #1 [=12%=======]      │
└─────────────────────────────────────────────────┘
                          +
┌─────────────────────────────────────────────────┐
│               AI POOL (1 Max)                    │
├─────────────────────────────────────────────────┤
│ Slot 1: AI Analysis - Job #4 [===34%=====]      │
└─────────────────────────────────────────────────┘

Queue: 487 pending jobs
```

### Data Flow: Outcome-Based

```
User Action → Queue Job → Execute Tasks → Update Video Flags → Done

Example:
1. User queues "video.mp4" with tasks: [download, import, transcribe, analyze]
2. Queue holds job in memory
3. Tasks execute in pools (5+1 concurrent)
4. As each task completes, update video record:
   - Import complete → video exists in database
   - Transcribe complete → has_transcript = 1
   - Analyze complete → has_analysis = 1
5. Job removed from memory when all tasks done
6. Database now reflects: "This video has transcript and analysis"
```

### Crash Recovery Philosophy

```
On Backend Restart:
- Queue is empty (ephemeral)
- Database shows video states (persistent)
- Frontend displays videos with missing features
- User can re-queue videos that need processing

This is SIMPLER than complex job persistence!
```

---

## Database Design

### Minimal Changes Required

```sql
-- Add two new flags to existing videos table
ALTER TABLE videos ADD COLUMN aspect_ratio_fixed INTEGER DEFAULT 0;
ALTER TABLE videos ADD COLUMN audio_normalized INTEGER DEFAULT 0;

-- That's it! No jobs/tasks tables needed.
```

### Existing Schema (Keep As-Is)

```sql
-- Videos table - Source of truth for outcomes
CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  current_path TEXT NOT NULL,

  -- Existing flags
  has_transcript INTEGER DEFAULT 0,  -- Whisper transcription done
  has_analysis INTEGER DEFAULT 0,    -- AI analysis done

  -- New flags
  aspect_ratio_fixed INTEGER DEFAULT 0,  -- FFmpeg aspect ratio fixed
  audio_normalized INTEGER DEFAULT 0,    -- FFmpeg audio normalized

  -- Metadata
  duration_seconds REAL,
  file_size_bytes INTEGER,
  source_url TEXT,
  added_at TEXT NOT NULL,
  -- ... other fields
);

-- Transcripts table - Stores transcript data
CREATE TABLE transcripts (
  video_id TEXT NOT NULL,
  plain_text TEXT,
  srt_format TEXT,
  whisper_model TEXT,
  language TEXT,
  transcribed_at TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Analyses table - Stores AI analysis data
CREATE TABLE analyses (
  video_id TEXT NOT NULL,
  ai_analysis TEXT,
  summary TEXT,
  sections_count INTEGER,
  ai_model TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Saved Links table - Persistent download wishlist
CREATE TABLE saved_links (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  status TEXT DEFAULT 'pending',
  date_added TEXT NOT NULL,
  date_completed TEXT
);
```

### No Additional Tables Needed

The planning originally specified `jobs`, `tasks`, and `active_tasks` tables. **We don't need these.**

**Why?**
- Queue is ephemeral (in-memory Map)
- Active tasks are tracked in memory
- Database only needs to know outcomes, not process state

---

## Queue System

### Current Structure (Keep, Modify)

```typescript
// QueueManagerService - Existing service with modifications

class QueueManagerService {
  // BEFORE: Separate queues by purpose
  // private batchJobs = new Map<string, QueueJob>();
  // private analysisJobs = new Map<string, QueueJob>();

  // AFTER: Unified queue with pool-based execution
  private jobQueue = new Map<string, QueueJob>();
  private mainPool = new Map<string, ActiveTask>();  // 5 max
  private aiPool: ActiveTask | null = null;          // 1 max

  // BEFORE: 15 batch, 1 analysis
  // AFTER: 5 main, 1 AI
  private readonly MAX_MAIN_CONCURRENT = 5;
  private readonly MAX_AI_CONCURRENT = 1;
}
```

### Queue Job Interface (Existing)

```typescript
interface QueueJob {
  id: string;
  url?: string;                    // For download tasks
  videoId?: string;                // For library video tasks
  videoPath?: string;              // Shared between tasks
  displayName?: string;            // Display name
  tasks: Task[];                   // Array of tasks to execute
  currentTaskIndex: number;        // Which task we're on
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;                // 0-100
  currentPhase: string;            // "Downloading (2/5)"
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

interface ActiveTask {
  taskId: string;
  jobId: string;
  type: TaskType;
  pool: 'main' | 'ai';
  progress: number;
  message: string;
  startedAt: Date;
}
```

### Task Types (Existing, Minor Update)

```typescript
type TaskType =
  | 'download'            // Main pool - Download video
  | 'import'              // Main pool - Import to library
  | 'fix-aspect-ratio'    // Main pool - FFmpeg aspect ratio
  | 'normalize-audio'     // Main pool - FFmpeg audio normalize
  | 'process-video'       // Main pool - Combined FFmpeg
  | 'transcribe'          // Main pool - Whisper transcription
  | 'ai-analyze';         // AI pool - GPT/Claude analysis (RENAMED from 'analyze')
```

### Scheduling Algorithm (New Logic)

```typescript
class QueueManagerService {

  // Main processing loop
  private async processQueue(): Promise<void> {
    while (true) {
      // Fill main pool (up to 5 tasks)
      while (this.mainPool.size < this.MAX_MAIN_CONCURRENT) {
        const nextTask = this.getNextMainTask();
        if (!nextTask) break;

        this.executeTask(nextTask, 'main');
      }

      // Fill AI pool (up to 1 task)
      if (!this.aiPool) {
        const nextAITask = this.getNextAITask();
        if (nextAITask) {
          this.executeTask(nextAITask, 'ai');
        }
      }

      // Check again in 100ms
      await this.sleep(100);
    }
  }

  // Get next non-AI task from any job
  private getNextMainTask(): Task | null {
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      if (!currentTask) continue;

      // Skip if this task is already running
      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

      // Only return non-AI tasks
      if (currentTask.type !== 'ai-analyze') {
        return { ...currentTask, jobId: job.id };
      }
    }
    return null;
  }

  // Get next AI task from any job
  private getNextAITask(): Task | null {
    for (const job of this.jobQueue.values()) {
      if (job.status !== 'pending' && job.status !== 'processing') continue;

      const currentTask = job.tasks[job.currentTaskIndex];
      if (!currentTask) continue;

      if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

      // Only return AI tasks
      if (currentTask.type === 'ai-analyze') {
        return { ...currentTask, jobId: job.id };
      }
    }
    return null;
  }
}
```

---

## API Specification

### Base Configuration
```typescript
const API_BASE = 'http://localhost:3001/api';
```

### Queue Management Endpoints

#### Create Job(s)
```typescript
POST /api/queue/jobs
Content-Type: application/json

// Single job
{
  "inputSource": "https://youtube.com/watch?v=abc123",
  "displayName": "Video Title",
  "tasks": [
    { "type": "download", "options": { "quality": "1080" } },
    { "type": "import", "options": {} },
    { "type": "transcribe", "options": { "model": "large" } },
    { "type": "ai-analyze", "options": { "aiModel": "gpt-4" } }
  ]
}

// Batch jobs (array)
[
  { "inputSource": "url1", "tasks": [...] },
  { "inputSource": "url2", "tasks": [...] },
  // ... up to thousands
]

Response:
{
  "success": true,
  "jobIds": ["job-uuid-1", "job-uuid-2"]
}
```

#### List Jobs
```typescript
GET /api/queue/jobs?status=pending&limit=50

Response:
{
  "success": true,
  "jobs": [
    {
      "id": "job-uuid",
      "status": "processing",
      "progress": 45,
      "currentPhase": "Transcribing (3/4)",
      "tasks": [...]
    }
  ]
}
```

#### Get Job Status
```typescript
GET /api/queue/jobs/:id

Response:
{
  "success": true,
  "job": {
    "id": "job-uuid",
    "status": "processing",
    "currentTaskIndex": 2,
    "tasks": [
      { "type": "download", "status": "completed" },
      { "type": "import", "status": "completed" },
      { "type": "transcribe", "status": "processing" },
      { "type": "ai-analyze", "status": "pending" }
    ]
  }
}
```

#### Cancel Job
```typescript
POST /api/queue/jobs/:id/cancel

Response:
{
  "success": true,
  "message": "Job cancelled"
}
```

#### Delete Job
```typescript
DELETE /api/queue/jobs/:id

Response:
{
  "success": true,
  "message": "Job deleted"
}
```

#### Get Queue Status
```typescript
GET /api/queue/status

Response:
{
  "success": true,
  "mainPool": {
    "active": 4,
    "maxConcurrent": 5,
    "tasks": [
      { "taskId": "task-1", "type": "download", "progress": 45 },
      { "taskId": "task-2", "type": "transcribe", "progress": 78 }
    ]
  },
  "aiPool": {
    "active": 1,
    "maxConcurrent": 1,
    "task": { "taskId": "task-99", "type": "ai-analyze", "progress": 34 }
  },
  "queue": {
    "pending": 487,
    "processing": 6,
    "completed": 50,
    "failed": 2
  }
}
```

#### Browser Extension Quick-Add
```typescript
POST /api/queue/quick-add
{
  "url": "https://youtube.com/watch?v=abc",
  "pageTitle": "Video Title from Page"
}

Response:
{
  "success": true,
  "jobId": "job-uuid",
  "message": "Added to queue with default tasks"
}
```

---

## WebSocket Events

### Connection
```javascript
const socket = io('http://localhost:3001');

socket.on('connect', () => {
  console.log('Connected to backend');
});
```

### Task Events (Real-time, Not Stored in DB)

#### task.started
```typescript
{
  "taskId": "task-uuid-123",
  "jobId": "job-uuid-456",
  "videoId": "video-uuid-789",  // Optional
  "type": "download",
  "pool": "main",  // or "ai"
  "timestamp": "2024-01-15T12:00:00Z"
}
```

#### task.progress (Emitted many times per second)
```typescript
{
  "taskId": "task-uuid-123",
  "jobId": "job-uuid-456",
  "type": "download",
  "progress": 45,  // 0-100
  "message": "Downloading: 450MB / 1GB",
  "metadata": {
    // Type-specific metadata

    // For downloads:
    "bytesDownloaded": 471859200,
    "totalBytes": 1048576000,
    "speed": "10.5 MB/s",
    "eta": "52s",

    // For transcription:
    "currentTime": 145.5,
    "totalDuration": 600.0,
    "wordsTranscribed": 1234,

    // For AI analysis:
    "tokensProcessed": 1500,
    "model": "gpt-4",
    "stage": "summarizing"
  }
}
```

#### task.completed
```typescript
{
  "taskId": "task-uuid-123",
  "jobId": "job-uuid-456",
  "videoId": "video-uuid-789",
  "type": "import",
  "result": {
    // Task-specific results
    "videoId": "video-uuid-new",
    "filename": "video.mp4",
    "path": "/library/videos/video.mp4"
  },
  "duration": 45.3,  // Seconds to complete
  "timestamp": "2024-01-15T12:00:45Z"
}
```

#### task.failed
```typescript
{
  "taskId": "task-uuid-123",
  "jobId": "job-uuid-456",
  "type": "download",
  "error": {
    "code": "DOWNLOAD_FAILED",
    "message": "Video is private or deleted"
  },
  "canRetry": false,
  "timestamp": "2024-01-15T12:00:45Z"
}
```

### System Status Event (Every 1 Second)

```typescript
'system.status' {
  "mainPool": {
    "active": 4,
    "maxConcurrent": 5,
    "tasks": [
      { "taskId": "task-1", "type": "download", "progress": 45 },
      { "taskId": "task-2", "type": "transcribe", "progress": 78 }
    ]
  },
  "aiPool": {
    "active": 1,
    "task": { "taskId": "task-99", "type": "ai-analyze", "progress": 34 }
  },
  "queue": {
    "pending": 487,
    "processing": 6
  },
  "timestamp": "2024-01-15T12:00:00Z"
}
```

### Library Events (Keep Existing)

```typescript
'video.added'    { videoId, filename, path }
'video.updated'  { videoId, changes }
'video.deleted'  { videoId }
```

---

## Task Processing

### Task Execution Flow

```typescript
class QueueManagerService {

  async executeTask(task: Task, jobId: string, pool: 'main' | 'ai'): Promise<void> {
    const activeTask: ActiveTask = {
      taskId: uuidv4(),
      jobId,
      type: task.type,
      pool,
      progress: 0,
      message: 'Starting...',
      startedAt: new Date()
    };

    // Add to appropriate pool
    if (pool === 'main') {
      this.mainPool.set(activeTask.taskId, activeTask);
    } else {
      this.aiPool = activeTask;
    }

    // Emit started event
    this.websocket.emit('task.started', {
      taskId: activeTask.taskId,
      jobId,
      type: task.type,
      pool
    });

    try {
      // Execute the task
      let result;
      switch (task.type) {
        case 'download':
          result = await this.mediaOps.downloadVideo(url, options, activeTask.taskId);
          break;
        case 'import':
          result = await this.mediaOps.importToLibrary(videoPath, options, activeTask.taskId);
          // UPDATE DATABASE: Video now exists (by definition)
          break;
        case 'transcribe':
          result = await this.mediaOps.transcribeVideo(videoId, options, activeTask.taskId);
          // UPDATE DATABASE: has_transcript = 1
          await this.db.run('UPDATE videos SET has_transcript = 1 WHERE id = ?', [videoId]);
          break;
        case 'ai-analyze':
          result = await this.mediaOps.analyzeVideo(videoId, options, activeTask.taskId);
          // UPDATE DATABASE: has_analysis = 1
          await this.db.run('UPDATE videos SET has_analysis = 1 WHERE id = ?', [videoId]);
          break;
        case 'fix-aspect-ratio':
          result = await this.mediaOps.fixAspectRatio(videoId, options, activeTask.taskId);
          // UPDATE DATABASE: aspect_ratio_fixed = 1
          await this.db.run('UPDATE videos SET aspect_ratio_fixed = 1 WHERE id = ?', [videoId]);
          break;
        case 'normalize-audio':
          result = await this.mediaOps.normalizeAudio(videoId, options, activeTask.taskId);
          // UPDATE DATABASE: audio_normalized = 1
          await this.db.run('UPDATE videos SET audio_normalized = 1 WHERE id = ?', [videoId]);
          break;
      }

      // Emit completed event
      this.websocket.emit('task.completed', {
        taskId: activeTask.taskId,
        jobId,
        type: task.type,
        result,
        duration: (Date.now() - activeTask.startedAt.getTime()) / 1000
      });

    } catch (error) {
      // Emit failed event
      this.websocket.emit('task.failed', {
        taskId: activeTask.taskId,
        jobId,
        type: task.type,
        error: {
          code: 'TASK_FAILED',
          message: error.message
        }
      });

    } finally {
      // Remove from pool
      if (pool === 'main') {
        this.mainPool.delete(activeTask.taskId);
      } else {
        this.aiPool = null;
      }
    }
  }
}
```

### Progress Reporting (Workers)

```typescript
// Example: DownloadWorker emits progress
class DownloadWorker {
  async execute(taskId: string) {
    // Progress is emitted via WebSocket only - NOT stored in DB
    this.eventService.emitDownloadProgress(
      45,                           // percent
      'Downloading: 450MB / 1GB',  // message
      taskId,
      {
        speed: '10.5 MB/s',
        eta: '52s',
        bytesDownloaded: 471859200,
        totalBytes: 1048576000
      }
    );
  }
}
```

---

## Browser Extension Integration

### Extension Manifest

```json
{
  "manifest_version": 3,
  "name": "ClipChimp Downloader",
  "version": "1.0.0",
  "permissions": ["activeTab", "storage"],
  "host_permissions": ["http://localhost:3001/*"],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

### Background Script

```javascript
// background.js
class ClipChimpExtension {
  constructor() {
    this.backendUrl = 'http://localhost:3001';
    this.setupContextMenu();
  }

  setupContextMenu() {
    chrome.contextMenus.create({
      id: 'save-to-clipchimp',
      title: 'Save to ClipChimp',
      contexts: ['video', 'link', 'page']
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      await this.saveVideo(info.srcUrl || info.linkUrl || info.pageUrl, tab.title);
    });
  }

  async saveVideo(url, pageTitle) {
    try {
      const response = await fetch(`${this.backendUrl}/api/queue/quick-add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, pageTitle })
      });

      const data = await response.json();

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Added to ClipChimp',
        message: `"${pageTitle}" added to queue`
      });

    } catch (error) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Failed to add',
        message: error.message
      });
    }
  }
}

new ClipChimpExtension();
```

---

## Implementation Status

### ✅ COMPLETED

#### Phase 1: Database Changes
- ✅ Added `aspect_ratio_fixed` column to videos table (schema + migration)
- ✅ Added `audio_normalized` column to videos table (schema + migration)
- ✅ Updated `VideoRecord` TypeScript interface
- ✅ Added CHECK constraints for new boolean columns

#### Phase 2: QueueManagerService Refactoring (Partial)
- ✅ Updated class properties:
  - ✅ Removed `batchJobs` and `analysisJobs` Maps
  - ✅ Added unified `jobQueue` Map
  - ✅ Added `mainPool` Map (5 max concurrent)
  - ✅ Added `aiPool` (1 max concurrent)
  - ✅ Updated concurrency constants to 5+1 model
  - ✅ Created `ActiveTask` interface
- ✅ Updated `QueueJob` interface (removed `queueType` field)
- ✅ Refactored helper methods:
  - ✅ `addJob()` - unified queue logic
  - ✅ `getJob()` - single queue lookup
  - ✅ `getAllJobs()` - returns all jobs
  - ✅ `getMainPool()` - new accessor method
  - ✅ `getAIPool()` - new accessor method
  - ✅ `deleteJob()` - unified logic
  - ✅ `cancelJob()` - removed queueType reference
  - ✅ `clearCompletedJobs()` - unified logic
  - ✅ `onModuleDestroy()` - updated for new structure

**Files Modified:**
- `/Volumes/Callisto/Projects/clippy/backend/src/database/database.service.ts` (lines 9-31, 373-396, 980-1016)
- `/Volumes/Callisto/Projects/clippy/backend/src/queue/queue-manager.service.ts` (lines 14-165)
- `/Volumes/Callisto/Projects/clippy/backend/src/common/interfaces/task.interface.ts` (lines 160-188)

### 🔄 IN PROGRESS

**Current location:** `/Volumes/Callisto/Projects/clippy/backend/src/queue/queue-manager.service.ts` line ~170

Need to replace/rewrite these methods starting at line 167:

### ⏳ REMAINING WORK

#### Phase 2: QueueManagerService Refactoring (Remainder)

**NEXT STEPS (in order):**

1. **Replace `getQueueStatus()` method** (currently at line 167-190)
   - Remove `queueType` parameter
   - Return unified status with mainPool and aiPool breakdown
   - Include pending/processing counts for entire queue

2. **Delete old queue processing methods:**
   - Remove `processBatchQueue()` method (line 195+)
   - Remove `processAnalysisQueue()` method
   - Remove `emitQueueStatus()` method

3. **Implement new unified processing system:**
   ```typescript
   private async processQueue(): Promise<void>
   private getNextMainTask(): { task: Task, job: QueueJob } | null
   private getNextAITask(): { task: Task, job: QueueJob } | null
   private isTaskRunning(jobId: string, taskIndex: number): boolean
   private async executeTask({ task, job }, pool: 'main' | 'ai'): Promise<void>
   private async executeTaskLogic(job: QueueJob, task: Task, taskId: string): Promise<TaskResult>
   ```

4. **Update task completion handlers** to set database flags:
   - In `executeTaskLogic()` switch statement:
     - `transcribe` → no flag needed (has_transcript added by migration)
     - `ai-analyze` → no flag needed (has_analysis added by migration)
     - `fix-aspect-ratio` → set `aspect_ratio_fixed = 1`
     - `normalize-audio` → set `audio_normalized = 1`

#### Phase 3: API & WebSocket Updates

5. **Update `queue.controller.ts`:**
   - Change `POST /add` → `POST /jobs`
   - Remove `queueType` parameter from all endpoints
   - Update `GET /status` to return unified status
   - Add `POST /quick-add` endpoint
   - Update all method signatures

6. **Update WebSocket events** in `common/websocket.service.ts`:
   - Add `emitTaskStarted(data)`
   - Add `emitTaskProgress(data)`
   - Add `emitTaskCompleted(data)`
   - Add `emitTaskFailed(data)`
   - Add `emitSystemStatus(data)`

#### Phase 4: Testing

7. **Test the refactored system:**
   - Create a test library
   - Add multiple jobs with different task types
   - Verify 5+1 concurrency
   - Test database flags are set correctly
   - Test WebSocket events

---

## Implementation Plan (Original)

### Phase 1: Database Changes (30 minutes) - ✅ COMPLETE

```sql
-- Add new flags to videos table
ALTER TABLE videos ADD COLUMN aspect_ratio_fixed INTEGER DEFAULT 0;
ALTER TABLE videos ADD COLUMN audio_normalized INTEGER DEFAULT 0;

-- Verify
SELECT aspect_ratio_fixed, audio_normalized FROM videos LIMIT 1;
```

### Phase 2: Queue Service Refactoring (Day 1-2)

**File: `backend/src/queue/queue-manager.service.ts`**

**Step 1: Update class properties**
```typescript
class QueueManagerService {
  // REMOVE:
  // private batchJobs = new Map<string, QueueJob>();
  // private analysisJobs = new Map<string, QueueJob>();
  // private batchProcessing = false;
  // private analysisProcessing = false;
  // private readonly BATCH_MAX_CONCURRENCY = 15;
  // private readonly ANALYSIS_MAX_CONCURRENCY = 1;

  // ADD:
  private jobQueue = new Map<string, QueueJob>();
  private mainPool = new Map<string, ActiveTask>();
  private aiPool: ActiveTask | null = null;
  private processing = false;
  private readonly MAX_MAIN_CONCURRENT = 5;
  private readonly MAX_AI_CONCURRENT = 1;
}
```

**Step 2: Update addJob method**
```typescript
addJob(job: Omit<QueueJob, 'id' | 'createdAt' | 'status' | ...>): string {
  const jobId = uuidv4();
  const fullJob: QueueJob = {
    ...job,
    id: jobId,
    status: 'pending',
    progress: 0,
    currentTaskIndex: 0,
    createdAt: new Date()
  };

  // Add to unified queue (no more queueType)
  this.jobQueue.set(jobId, fullJob);

  // Start processing if not already running
  setImmediate(() => this.processQueue());

  return jobId;
}
```

**Step 3: Rewrite processing logic**
```typescript
private async processQueue(): Promise<void> {
  if (this.processing) return;
  this.processing = true;

  try {
    while (true) {
      // Fill main pool (up to 5 concurrent tasks)
      while (this.mainPool.size < this.MAX_MAIN_CONCURRENT) {
        const nextTask = this.getNextMainTask();
        if (!nextTask) break;

        this.executeTask(nextTask, 'main').catch(err => {
          this.logger.error(`Task failed: ${err.message}`);
        });
      }

      // Fill AI pool (up to 1 concurrent task)
      if (!this.aiPool) {
        const nextTask = this.getNextAITask();
        if (nextTask) {
          this.executeTask(nextTask, 'ai').catch(err => {
            this.logger.error(`AI task failed: ${err.message}`);
          });
        }
      }

      // Check if queue is empty and all pools are empty
      if (this.jobQueue.size === 0 &&
          this.mainPool.size === 0 &&
          !this.aiPool) {
        break; // Nothing left to do
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    this.processing = false;
  }
}

private getNextMainTask(): { task: Task, job: QueueJob } | null {
  // Find first job with a pending non-AI task
  for (const job of this.jobQueue.values()) {
    if (job.status !== 'pending' && job.status !== 'processing') continue;

    const task = job.tasks[job.currentTaskIndex];
    if (!task) continue;

    // Skip if already running
    if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

    // Return non-AI tasks only
    if (task.type !== 'ai-analyze') {
      return { task, job };
    }
  }
  return null;
}

private getNextAITask(): { task: Task, job: QueueJob } | null {
  // Find first job with a pending AI task
  for (const job of this.jobQueue.values()) {
    if (job.status !== 'pending' && job.status !== 'processing') continue;

    const task = job.tasks[job.currentTaskIndex];
    if (!task) continue;

    if (this.isTaskRunning(job.id, job.currentTaskIndex)) continue;

    // Return AI tasks only
    if (task.type === 'ai-analyze') {
      return { task, job };
    }
  }
  return null;
}

private isTaskRunning(jobId: string, taskIndex: number): boolean {
  // Check if this specific task is already in a pool
  for (const activeTask of this.mainPool.values()) {
    if (activeTask.jobId === jobId && activeTask.taskIndex === taskIndex) {
      return true;
    }
  }
  if (this.aiPool?.jobId === jobId && this.aiPool.taskIndex === taskIndex) {
    return true;
  }
  return false;
}
```

**Step 4: Update task execution**
```typescript
private async executeTask(
  { task, job }: { task: Task, job: QueueJob },
  pool: 'main' | 'ai'
): Promise<void> {
  const taskId = uuidv4();
  const activeTask: ActiveTask = {
    taskId,
    jobId: job.id,
    taskIndex: job.currentTaskIndex,
    type: task.type,
    pool,
    progress: 0,
    message: 'Starting...',
    startedAt: new Date()
  };

  // Add to pool
  if (pool === 'main') {
    this.mainPool.set(taskId, activeTask);
  } else {
    this.aiPool = activeTask;
  }

  // Update job status
  job.status = 'processing';

  // Emit started event
  this.eventService.emit('task.started', {
    taskId,
    jobId: job.id,
    type: task.type,
    pool
  });

  try {
    // Execute the task (use existing executeTask logic)
    const result = await this.executeTaskLogic(job, task, taskId);

    if (!result.success) {
      throw new Error(result.error || 'Task failed');
    }

    // Task completed successfully
    this.eventService.emit('task.completed', {
      taskId,
      jobId: job.id,
      type: task.type,
      result: result.data
    });

    // Move to next task in job
    job.currentTaskIndex++;

    // Check if job is complete
    if (job.currentTaskIndex >= job.tasks.length) {
      job.status = 'completed';
      job.completedAt = new Date();
      // Remove from queue after a delay
      setTimeout(() => this.jobQueue.delete(job.id), 5000);
    }

  } catch (error) {
    // Task failed
    job.status = 'failed';
    job.error = error.message;
    job.completedAt = new Date();

    this.eventService.emit('task.failed', {
      taskId,
      jobId: job.id,
      type: task.type,
      error: { code: 'TASK_FAILED', message: error.message }
    });

  } finally {
    // Remove from pool
    if (pool === 'main') {
      this.mainPool.delete(taskId);
    } else {
      this.aiPool = null;
    }

    // Continue processing
    setImmediate(() => this.processQueue());
  }
}
```

**Step 5: Update task completion handlers**
```typescript
private async executeTaskLogic(job: QueueJob, task: Task, taskId: string): Promise<TaskResult> {
  switch (task.type) {
    case 'transcribe':
      const result = await this.mediaOps.transcribeVideo(job.videoId, task.options, taskId);
      if (result.success && job.videoId) {
        // UPDATE DATABASE FLAG
        await this.db.run(
          'UPDATE videos SET has_transcript = 1 WHERE id = ?',
          [job.videoId]
        );
      }
      return result;

    case 'ai-analyze':
      const result = await this.mediaOps.analyzeVideo(job.videoId, task.options, taskId);
      if (result.success && job.videoId) {
        // UPDATE DATABASE FLAG
        await this.db.run(
          'UPDATE videos SET has_analysis = 1 WHERE id = ?',
          [job.videoId]
        );
      }
      return result;

    case 'fix-aspect-ratio':
      const result = await this.mediaOps.fixAspectRatio(job.videoId, task.options, taskId);
      if (result.success && job.videoId) {
        // UPDATE DATABASE FLAG
        await this.db.run(
          'UPDATE videos SET aspect_ratio_fixed = 1 WHERE id = ?',
          [job.videoId]
        );
      }
      return result;

    case 'normalize-audio':
      const result = await this.mediaOps.normalizeAudio(job.videoId, task.options, taskId);
      if (result.success && job.videoId) {
        // UPDATE DATABASE FLAG
        await this.db.run(
          'UPDATE videos SET audio_normalized = 1 WHERE id = ?',
          [job.videoId]
        );
      }
      return result;

    // ... other task types (download, import, etc.)
  }
}
```

### Phase 3: API & Events (Day 3)

**File: `backend/src/queue/queue.controller.ts`**

**Update endpoints:**
```typescript
@Post('jobs')  // Changed from /add
async addJobs(@Body() body: any) {
  // Accept single object or array
  const jobs = Array.isArray(body) ? body : [body];

  const jobIds = [];
  for (const jobData of jobs) {
    // No more queueType parameter
    const jobId = this.queueManager.addJob({
      url: jobData.inputSource || jobData.url,
      videoId: jobData.videoId,
      displayName: jobData.displayName,
      tasks: jobData.tasks
    });
    jobIds.push(jobId);
  }

  return { success: true, jobIds };
}

@Get('status')
async getStatus() {
  const jobs = Array.from(this.queueManager.getAllJobs());
  const mainPool = this.queueManager.getMainPool();
  const aiPool = this.queueManager.getAIPool();

  return {
    success: true,
    mainPool: {
      active: mainPool.size,
      maxConcurrent: 5,
      tasks: Array.from(mainPool.values())
    },
    aiPool: {
      active: aiPool ? 1 : 0,
      maxConcurrent: 1,
      task: aiPool
    },
    queue: {
      pending: jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length
    }
  };
}

@Post('quick-add')
async quickAdd(@Body() body: { url: string, pageTitle?: string }) {
  // Default tasks for browser extension
  const jobId = this.queueManager.addJob({
    url: body.url,
    displayName: body.pageTitle,
    tasks: [
      { type: 'download', options: {} },
      { type: 'import', options: {} },
      { type: 'transcribe', options: { model: 'large' } },
      { type: 'ai-analyze', options: { aiModel: 'gpt-4' } }
    ]
  });

  return { success: true, jobId };
}
```

**File: `backend/src/common/websocket.service.ts`**

**Add unified task event methods:**
```typescript
emitTaskStarted(data: any) {
  this.server?.emit('task.started', data);
}

emitTaskProgress(data: any) {
  this.server?.emit('task.progress', data);
}

emitTaskCompleted(data: any) {
  this.server?.emit('task.completed', data);
}

emitTaskFailed(data: any) {
  this.server?.emit('task.failed', data);
}

emitSystemStatus(data: any) {
  this.server?.emit('system.status', data);
}
```

### Phase 4: Testing (Day 3)

**Test cases:**
1. Add single job with multiple tasks
2. Add 100 jobs simultaneously
3. Verify 5+1 concurrency (5 main + 1 AI)
4. Test crash recovery (restart backend, verify queue is empty)
5. Test video flags are set correctly
6. Test WebSocket events are emitted
7. Test browser extension quick-add

---

## Summary

### What Changed
- ✅ Database: Added 2 columns (`aspect_ratio_fixed`, `audio_normalized`)
- ✅ Queue: Unified queue with 5+1 pool model
- ✅ Concurrency: Changed from 15/1 to 5/1
- ✅ Scheduling: Task-based instead of job-based
- ✅ API: Removed `queueType`, unified endpoints
- ✅ Events: Consolidated to task.* events

### What Stayed the Same
- ✅ In-memory queue (ephemeral)
- ✅ Existing worker services
- ✅ Database schema (except 2 new columns)
- ✅ Task execution logic
- ✅ Video/transcript/analysis tables

### Implementation Time
**Total: 3 days**
- Day 1-2: Queue refactoring
- Day 3: API/events + testing

---

**Remember:** The database tracks **outcomes** (what has been done), the queue tracks **work in progress** (what is being done right now). This separation keeps the architecture simple and maintainable.
