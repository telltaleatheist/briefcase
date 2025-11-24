# AI Analysis Storage and Retrieval System - Complete Overview

## 1. DATABASE SCHEMA & MODELS

### Core Tables (SQLite via sql.js)

All tables are stored in `~/Library/Application Support/clipchimp/clipchimp.db`

#### `videos` table
- **Purpose**: Core metadata for each video file
- **Primary Key**: `id` (TEXT)
- **Columns**:
  - `id`: Unique identifier (UUID)
  - `filename`: Original filename
  - `file_hash`: SHA-256 hash of first 1MB (used for duplicate detection)
  - `current_path`: Current file path
  - `date_folder`: Date-based folder organization
  - `duration_seconds`: Video duration
  - `file_size_bytes`: File size in bytes
  - `created_at`: Creation timestamp
  - `last_verified`: Last verification timestamp
  - `added_at`: When added to library
  - `is_linked`: Boolean (0/1) - whether file still exists

#### `transcripts` table
- **Purpose**: Stores both plain text and SRT format transcripts
- **Foreign Key**: `video_id` (References `videos.id` with ON DELETE CASCADE)
- **Columns**:
  - `video_id`: PRIMARY KEY, FK to videos
  - `plain_text`: Full transcript as plain text
  - `srt_format`: SRT format with timestamps
  - `whisper_model`: Which Whisper model was used ('base', 'small', etc.)
  - `language`: Language code (e.g., 'en')
  - `transcribed_at`: Timestamp when transcription was created

**Key Property**: One transcript per video (unique constraint on video_id)

#### `analyses` table
- **Purpose**: AI-generated analysis reports
- **Foreign Key**: `video_id` (References `videos.id` with ON DELETE CASCADE)
- **Columns**:
  - `video_id`: PRIMARY KEY, FK to videos
  - `ai_analysis`: Full analysis report text
  - `summary`: Optional summary field
  - `sections_count`: Number of interesting sections identified
  - `ai_model`: Which AI model generated analysis ('qwen2.5:7b', etc.)
  - `ai_provider`: Provider name ('ollama', 'claude', 'openai')
  - `analyzed_at`: Timestamp when analysis was created

**Key Property**: One analysis per video (unique constraint on video_id), can be replaced/updated

#### `analysis_sections` table
- **Purpose**: Interesting moments/sections identified by AI analysis
- **Foreign Key**: `video_id` (References `videos.id` with ON DELETE CASCADE)
- **Columns**:
  - `id`: Unique section ID (UUID)
  - `video_id`: FK to videos
  - `start_seconds`: Start timestamp in seconds
  - `end_seconds`: End timestamp in seconds
  - `timestamp_text`: Human-readable timestamp (e.g., "12:34")
  - `title`: Section title
  - `description`: Detailed description
  - `category`: Section category/type

**Relationship**: Multiple sections per video, ordered by start_seconds

#### `tags` table
- **Purpose**: AI-generated and manual tags/metadata
- **Foreign Key**: `video_id` (References `videos.id` with ON DELETE CASCADE)
- **Columns**:
  - `id`: Unique tag ID (UUID)
  - `video_id`: FK to videos
  - `tag_name`: The tag value (e.g., "Trump", "vaccine")
  - `tag_type`: Type of tag ('person', 'topic', etc.)
  - `confidence`: Confidence score (0-1)
  - `source`: Where tag came from ('ai', 'manual', etc.)
  - `created_at`: Timestamp

**Relationship**: Multiple tags per video, queryable by tag_name

#### Supporting FTS Tables (Full-Text Search)
- `transcripts_fts`: Index for searching transcript content
- `analyses_fts`: Index for searching analysis content

---

## 2. SERVICE & CONTROLLER CODE ARCHITECTURE

### Backend Layers (NestJS)

#### **AnalysisService** (`backend/src/analysis/analysis.service.ts`)
**Responsibility**: Handles single analysis job lifecycle (download, transcribe, analyze)

**Key Methods**:
- `startAnalysis(request)`: Initiates new analysis job
  - Returns job ID immediately
  - Processes asynchronously
  - Supports modes: 'full', 'transcribe-only', 'analysis-only'
  
- `getJob(jobId)`: Get job status and progress
  
- `getAllJobs()`: Get all active jobs
  
- `deleteJob(jobId)`: Clean up job and temporary files

**Data Flow**:
1. Receives `AnalysisRequest` (input URL/file, AI model, settings)
2. Downloads video (if URL) or uses local file
3. Extracts audio to temporary WAV file
4. Transcribes using Whisper (Python bridge)
5. Analyzes transcript using AI (Ollama/Claude/OpenAI)
6. Saves results to filesystem (not database directly)
7. Emits progress events via WebSocket

**Output Files Created**:
```
~/Downloads/clipchimp/
├── videos/
│   └── [downloaded_video]
└── analysis/
    ├── transcripts/
    │   ├── [title].srt
    │   └── [title].txt
    └── reports/
        └── [title].txt (AI analysis report)
```

#### **BatchAnalysisService** (`backend/src/database/batch-analysis.service.ts`)
**Responsibility**: Manages batch processing of multiple videos and database storage

**Key Methods**:
- `startBatchAnalysis(options)`: Start batch job
  - Processes all videos needing analysis
  - Supports transcribe-only mode
  - Supports analysis-only mode (if transcript exists)
  - Returns job ID
  
- `processVideo(video, config)`: Process single video
  - Calls AnalysisService.startAnalysis()
  - Stores results in database
  - Handles transcript deduplication
  
- `storeAnalysisResults(videoId, job)`: Database insertion
  - Reads transcript files and stores in DB
  - Parses analysis report into sections
  - Extracts and stores tags
  - Checks for existing analysis (deletes before inserting new)
  
- `pauseBatch()`, `resumeBatch()`, `stopBatch()`: Job control

**Duplicate Analysis Check**:
```typescript
// In batch-analysis.service.ts, storeAnalysisResults():
const existingAnalysis = this.databaseService.getAnalysis(videoId);
if (existingAnalysis) {
  // Delete existing analysis (this will cascade to sections via FK constraint)
  this.logger.log(`Deleting existing analysis for video ${videoId} before inserting new one`);
  this.databaseService.deleteAnalysis(videoId);
}
// Insert new analysis
this.databaseService.insertAnalysis({...});
```

#### **DatabaseService** (`backend/src/database/database.service.ts`)
**Responsibility**: Low-level database operations with sql.js

**Key Methods for Analysis**:
- `insertAnalysis(data)`: Store analysis record
- `getAnalysis(videoId)`: Retrieve analysis for video
- `deleteAnalysis(videoId)`: Delete analysis (cascades to sections)
- `insertAnalysisSection(data)`: Store section
- `getAnalysisSections(videoId)`: Retrieve all sections
- `insertTranscript(data)`: Store transcript
- `getTranscript(videoId)`: Retrieve transcript
- `insertTag(data)`: Store tag
- `getTags(videoId)`: Retrieve all tags for video

**Database Integrity**:
- Foreign key constraints enforce referential integrity
- ON DELETE CASCADE ensures clean removal when video deleted
- Unique constraints on video_id in transcripts and analyses tables

### API Endpoints

#### **AnalysisController** (`backend/src/analysis/analysis.controller.ts`)
- `POST /api/analysis/start` - Start new analysis job
- `GET /api/analysis/job/:jobId` - Get job status
- `GET /api/analysis/jobs` - Get all jobs
- `DELETE /api/analysis/job/:jobId` - Delete job
- `GET /api/analysis/models` - Get available Ollama models
- `POST /api/analysis/check-model` - Check if model available
- **`POST /api/analysis/check-existing-report`** - Check for duplicate analysis
- `GET /api/analysis/reports` - List analysis reports
- `GET /api/analysis/report/:filePath` - Read report file
- `DELETE /api/analysis/report/:filePath` - Delete report

#### **DatabaseController** (`backend/src/database/database.controller.ts`)
- `GET /api/database/stats` - Database statistics
- `POST /api/database/scan` - Trigger library scan
- `GET /api/database/videos` - Get all videos
- `GET /api/database/videos/:id/analysis` - Get analysis for video
- `GET /api/database/videos/:id/transcript` - Get transcript for video
- `GET /api/database/videos/:id/sections` - Get analysis sections
- `GET /api/database/videos/:id/has-analysis` - Check if analyzed
- **`POST /api/database/batch/start`** - Start batch analysis
- `GET /api/database/batch/progress` - Get batch progress
- `POST /api/database/batch/pause` - Pause batch
- `POST /api/database/batch/resume` - Resume batch
- `POST /api/database/batch/stop` - Stop batch

---

## 3. FRONTEND COMPONENTS & TRIGGER POINTS

### Single Video Analysis

#### **VideoAnalysisComponent** (`frontend/src/app/components/video-analysis/video-analysis.component.ts`)
**Purpose**: UI for analyzing single URL or local file

**Form Fields**:
- Input type: 'url' or 'file'
- Input: URL or file path
- AI Model: dropdown (format: "provider:model")
- Ollama Endpoint: http://localhost:11434
- Whisper Model: base/small/medium/large
- Language: en/etc.
- Custom Instructions: optional instructions for AI
- Output Path: optional custom output directory

**Duplicate Detection**:
```typescript
// onSubmit() method:
const checkUrl = await this.backendUrlService.getApiUrl('/analysis/check-existing-report');
const existingCheck = await fetch(checkUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: formValue.input,
    inputType: formValue.inputType,
    outputPath: formValue.outputPath
  }),
});

const existingData = await existingCheck.json();
if (existingData.exists) {
  // Show dialog asking user to:
  // 1. Cancel
  // 2. Generate new with timestamp
  // 3. Overwrite
}
```

**Flow**:
1. User fills form and submits
2. Check if report already exists
3. If yes, show dialog with options
4. Call `POST /api/analysis/start` with AnalysisRequest
5. Poll job status with WebSocket updates
6. Display progress in real-time

### Batch Video Analysis

#### **LibraryComponent** (`frontend/src/app/components/library/library.component.ts`)
**Purpose**: Main library UI showing all imported videos

**Batch Analysis Trigger**:
```typescript
async analyzeSelected() {
  // 1. Show dialog to select mode
  const { AnalyzeSelectedDialogComponent } = await import('./analyze-selected-dialog.component');
  const dialogRef = this.dialog.open(AnalyzeSelectedDialogComponent, {
    data: { selectedCount: this.selectedVideos.size }
  });
  
  // 2. Get selected mode from user
  const mode = await dialogRef.afterClosed().toPromise();
  // mode: 'transcribe-only' | 'transcribe-analyze' | 'skip'
  
  // 3. Start batch analysis
  const videoIds = Array.from(this.selectedVideos);
  await this.databaseLibraryService.startBatchAnalysis({
    videoIds: videoIds.length > 0 ? videoIds : undefined,
    transcribeOnly: mode === 'transcribe-only'
  });
}
```

#### **AnalyzeSelectedDialogComponent** (`frontend/src/app/components/library/analyze-selected-dialog.component.ts`)
**Purpose**: Dialog to choose batch analysis mode

**Options**:
1. **Transcribe Only**: Whisper transcription, no AI analysis
2. **Transcribe + AI Analysis**: Full pipeline (default)
3. **Skip Analysis**: Import without processing

### Analysis Display

#### **AnalysisReportsComponent** (`frontend/src/app/components/analysis-reports/analysis-reports.component.ts`)
**Purpose**: View and manage analysis reports

**Methods**:
- `loadAnalyses()`: Fetch all analyses from database
- `selectAnalysis(analysis)`: Load analysis details
- `deleteAnalysis(analysis)`: Delete from database
- `archiveAnalysis(analysis)`: Archive for later

---

## 4. DUPLICATE ANALYSIS DETECTION & PREVENTION

### Mechanism 1: Filesystem-Based (Single Analysis)

**Endpoint**: `POST /api/analysis/check-existing-report`

**Logic** (`analysis.controller.ts`):
```typescript
async checkExistingReport(@Body() body: { input: string; inputType: string; outputPath?: string }) {
  // Determine output directory
  const baseOutputPath = body.outputPath || this.getBaseOutputDir();
  const reportsPath = path.join(baseOutputPath, 'analysis', 'reports');
  
  // Generate expected filename
  let videoTitle: string;
  if (body.inputType === 'url') {
    videoTitle = urlParts[urlParts.length - 1] || 'video';
  } else {
    videoTitle = path.basename(body.input, path.extname(body.input));
  }
  
  const sanitizedTitle = videoTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
  const expectedReportPath = path.join(reportsPath, `${sanitizedTitle}.txt`);
  
  // Check if file exists
  const exists = fs.existsSync(expectedReportPath);
  
  return {
    exists: true/false,
    reportPath: existingReportPath,
    stats: { mtime, size }
  };
}
```

**Frontend Behavior**:
- If report exists, show dialog with options:
  - Cancel
  - Overwrite
  - Generate with timestamp suffix

### Mechanism 2: Database-Based (Batch Analysis)

**Location**: `batch-analysis.service.ts`, `storeAnalysisResults()` method

**Logic**:
```typescript
// Check if analysis already exists
const existingAnalysis = this.databaseService.getAnalysis(videoId);

if (existingAnalysis) {
  // Delete existing analysis (cascades to sections via FK)
  this.databaseService.deleteAnalysis(videoId);
}

// Always insert new analysis
this.databaseService.insertAnalysis({
  videoId,
  aiAnalysis: analysisContent,
  sectionsCount: sections.length,
  aiModel: 'qwen2.5:7b',
  aiProvider: 'ollama',
});
```

**Key Points**:
- When re-analyzing same video, old analysis is deleted first
- Foreign key constraints automatically cascade to delete sections
- Tags are also cleared before re-insertion
- This ensures fresh analysis results overwrite old ones

### Mechanism 3: Transcript Deduplication

**Location**: `batch-analysis.service.ts`, `processVideo()` method

**Logic**:
```typescript
// Check if transcript already exists
const existingTranscript = this.databaseService.getTranscript(video.id);
const hasTranscript = !!existingTranscript;

// Determine mode
if (config.transcribeOnly) {
  if (hasTranscript) {
    this.logger.log(`Transcript already exists, skipping`);
    return; // Skip video entirely
  }
  mode = 'transcribe-only';
} else {
  if (hasTranscript) {
    mode = 'analysis-only'; // Run AI on existing transcript
  } else {
    mode = 'full'; // Create new transcript and analyze
  }
}
```

**Behavior**:
- If transcript exists and transcribe-only mode requested: SKIP
- If transcript exists and full analysis requested: use 'analysis-only' mode
- If transcript doesn't exist: create it (full or transcribe-only)

---

## 5. ANALYSIS LIFECYCLE FLOW

### Single Video (UI)
```
User Input (URL/File)
    ↓
Check Existing Report (filesystem)
    ↓
[If exists] Show dialog → User chooses action
    ↓
POST /api/analysis/start
    ↓
AnalysisService.startAnalysis()
    ├─ Download video (if URL)
    ├─ Extract audio
    ├─ Transcribe audio
    ├─ Analyze transcript with AI
    └─ Save files to ~/Downloads/clipchimp/
    ↓
[Result files created, NOT in database]
```

### Batch Videos (Database)
```
User selects videos in Library
    ↓
Choose analysis mode (transcribe-only/full/skip)
    ↓
POST /api/database/batch/start
    ↓
BatchAnalysisService.startBatchAnalysis()
    ↓
For each video:
  ├─ Check transcript exists
  ├─ Determine mode (full/analysis-only/skip)
  ├─ Call AnalysisService.startAnalysis()
  ├─ Wait for completion
  └─ storeAnalysisResults()
      ├─ Read analysis files
      ├─ Check for existing analysis
      ├─ Delete if exists (cascade to sections)
      ├─ Insert new analysis
      ├─ Parse & insert sections
      ├─ Extract & insert tags
      └─ Save to database
    ↓
Batch complete
```

### Storage Locations

**File System** (for single analysis UI):
```
~/Downloads/clipchimp/
├── videos/[video_file]
└── analysis/
    ├── transcripts/
    │   ├── [name].srt
    │   └── [name].txt
    └── reports/
        └── [name].txt
```

**Database** (for batch library):
```
~/Library/Application Support/clipchimp/clipchimp.db
├── videos
├── transcripts
├── analyses
├── analysis_sections
└── tags
```

---

## 6. SUMMARY TABLE

| Component | Purpose | Storage | Duplicate Check |
|-----------|---------|---------|-----------------|
| AnalysisService | Single analysis job | Files only | checkExistingReport endpoint |
| BatchAnalysisService | Batch processing | Database | getAnalysis() then deleteAnalysis() |
| DatabaseService | Low-level DB ops | SQLite | Direct queries |
| AnalysisController | Single analysis API | Files | Filesystem check |
| DatabaseController | Batch analysis API | Database | In processVideo() |
| VideoAnalysisComponent | Single UI | Files | Frontend dialog |
| LibraryComponent | Batch UI | Database | Backend validation |

---

## 7. KEY ASSOCIATIONS

**Video → Transcript**:
- 1:1 relationship (unique constraint on video_id in transcripts)
- ON DELETE CASCADE

**Video → Analysis**:
- 1:1 relationship (unique constraint on video_id in analyses)
- ON DELETE CASCADE
- Can be replaced/updated (delete old, insert new)

**Video → Analysis Sections**:
- 1:N relationship
- ON DELETE CASCADE
- Parsed from analysis text using regex

**Video → Tags**:
- 1:N relationship
- ON DELETE CASCADE
- Extracted from analysis by AI or manually
- Can be indexed and filtered

