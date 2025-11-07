# Key Files Quick Reference

## Database Schema & Models

### Database Service (Core Data Layer)
- **Path**: `/Volumes/Callisto/Projects/clippy/backend/src/database/database.service.ts`
- **Key Methods**:
  - `initializeSchema()` - Creates all database tables (lines 118-217)
  - `insertAnalysis(data)` - Store analysis (lines 524-556)
  - `getAnalysis(videoId)` - Retrieve analysis (lines 561-570)
  - `deleteAnalysis(videoId)` - Delete analysis with cascade (lines 575-579)
  - `insertAnalysisSection(section)` - Store sections (lines 593-622)
  - `getAnalysisSections(videoId)` - Get all sections (lines 627-641)
  - `insertTag(tag)` - Store tags (lines 646-671)
  - `getTags(videoId)` - Get video tags (lines 676-688)

**Database Location**: `~/Library/Application Support/clippy/clippy.db` (SQLite via sql.js)

---

## Backend Services

### Analysis Service (Single Video Analysis)
- **Path**: `/Volumes/Callisto/Projects/clippy/backend/src/analysis/analysis.service.ts`
- **Key Methods**:
  - `startAnalysis(request)` - Start job (lines 78-102)
  - `processAnalysis(jobId, request)` - Main pipeline (lines 139-413)
  - `extractAudio(videoPath, jobId)` - Extract WAV file (lines 449-479)
  - `storeAnalysisResults()` - NOT used for single analysis (saves to filesystem only)

**Output Location**: `~/Downloads/clippy/analysis/`

### Batch Analysis Service (Multiple Videos + Database)
- **Path**: `/Volumes/Callisto/Projects/clippy/backend/src/database/batch-analysis.service.ts`
- **Key Methods**:
  - `startBatchAnalysis(options)` - Queue job (lines 89-183)
  - `processBatch(videos, config)` - Main batch loop (lines 188-289)
  - `processVideo(video, config)` - Process single video (lines 294-365)
  - `storeAnalysisResults(videoId, job)` - **DUPLICATE CHECK HERE** (lines 395-495)
    - Lines 437-444: Check existing analysis, delete if found
  - `parseAnalysisForSections(analysisText)` - Extract sections from text (lines 500-562)
  - `extractTagsFromAnalysis(analysisText)` - Extract tags (lines 567-604)

**Duplicate Check**: Lines 437-444 in `storeAnalysisResults()`

---

## API Controllers

### Analysis Controller (Single Analysis Endpoints)
- **Path**: `/Volumes/Callisto/Projects/clippy/backend/src/analysis/analysis.controller.ts`
- **Key Endpoints**:
  - `POST /api/analysis/start` (lines 55-90)
  - **`POST /api/analysis/check-existing-report`** (lines 203-256) - DUPLICATE CHECK
  - `GET /api/analysis/job/:jobId` (lines 95-107)
  - `GET /api/analysis/reports` (lines 261-306)

**Duplicate Check Logic**: Lines 203-256
- Determines output directory
- Generates expected filename from input
- Checks if file exists
- Returns exists flag + stats

### Database Controller (Batch Analysis Endpoints)
- **Path**: `/Volumes/Callisto/Projects/clippy/backend/src/database/database.controller.ts`
- **Key Endpoints**:
  - `GET /api/database/videos/:id/analysis` (lines 185-195)
  - `GET /api/database/videos/:id/has-analysis` (lines 161-167)
  - `POST /api/database/batch/start` (lines 350-369) - STARTS BATCH
  - `GET /api/database/batch/progress` (lines 375-388)

---

## Frontend Services

### Database Library Service (API Client for Batch)
- **Path**: `/Volumes/Callisto/Projects/clippy/frontend/src/app/services/database-library.service.ts`
- **Key Methods**:
  - `startBatchAnalysis(options)` - Call batch start endpoint (lines 291-307)
  - `getBatchProgress()` - Poll progress (lines 312-317)
  - `getAnalysis(videoId)` - Retrieve analysis from DB (lines 536-546)
  - `getAnalysisSections(videoId)` - Get sections (lines 566-577)

---

## Frontend Components

### Video Analysis Component (Single Video UI)
- **Path**: `/Volumes/Callisto/Projects/clippy/frontend/src/app/components/video-analysis/video-analysis.component.ts`
- **Key Methods**:
  - `onSubmit()` - Start analysis (lines 161+)
    - Lines 170-190: Call check-existing-report
    - Lines 188-200: Handle existing report dialog
  - `showExistingReportDialog()` - Show user options
  - `onModelChange()` - Load appropriate API key (lines 130-159)

**Duplicate Detection**: Lines 170-190
- Calls `/api/analysis/check-existing-report`
- Shows dialog if exists
- Options: Cancel, Overwrite, New with timestamp

### Library Component (Batch Analysis UI)
- **Path**: `/Volumes/Callisto/Projects/clippy/frontend/src/app/components/library/library.component.ts`
- **Key Methods**:
  - `analyzeSelected()` - Trigger batch analysis (lines 676+)
    - Shows mode selection dialog
    - Calls `startBatchAnalysis()`
  - `startBatchAnalysis()` - Call backend batch start (lines 766+)
  - `startProgressPolling()` - Monitor batch progress (lines ~760)

### Analyze Selected Dialog Component
- **Path**: `/Volumes/Callisto/Projects/clippy/frontend/src/app/components/library/analyze-selected-dialog.component.ts`
- **Options**:
  - 'transcribe-only' - Whisper only
  - 'transcribe-analyze' - Full pipeline
  - 'skip' - No processing

---

## Data Flow Diagram Locations

### Single Video Flow (check-existing-report)
```
VideoAnalysisComponent.onSubmit()
  → /api/analysis/check-existing-report
  → AnalysisController.checkExistingReport()
  → fs.existsSync(expectedReportPath)
  → Show dialog if exists
  → /api/analysis/start (if confirmed)
  → AnalysisService.startAnalysis()
  → Save to ~/Downloads/clippy/
```

### Batch Video Flow (duplicate check)
```
LibraryComponent.analyzeSelected()
  → AnalyzeSelectedDialogComponent (mode selection)
  → /api/database/batch/start
  → DatabaseController.startBatchAnalysis()
  → BatchAnalysisService.startBatchAnalysis()
  → For each video:
    → processVideo()
    → AnalysisService.startAnalysis()
    → storeAnalysisResults()
    → getAnalysis(videoId) [duplicate check]
    → deleteAnalysis(videoId) [if exists]
    → insertAnalysis() [new]
    → Database tables updated
```

---

## Critical Code Sections for Duplicate Analysis

### Batch: Delete Existing Analysis
**File**: `/Volumes/Callisto/Projects/clippy/backend/src/database/batch-analysis.service.ts`
**Lines**: 437-444

```typescript
// Check if analysis already exists
const existingAnalysis = this.databaseService.getAnalysis(videoId);

if (existingAnalysis) {
  // Delete existing analysis (this will cascade to sections via FK constraint)
  this.logger.log(`Deleting existing analysis for video ${videoId} before inserting new one`);
  this.databaseService.deleteAnalysis(videoId);
}
```

### Single: Check Report Exists
**File**: `/Volumes/Callisto/Projects/clippy/backend/src/analysis/analysis.controller.ts`
**Lines**: 224-228

```typescript
const sanitizedTitle = videoTitle.replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
const expectedReportPath = path.join(reportsPath, `${sanitizedTitle}.txt`);

// Check if file exists
const exists = fs.existsSync(expectedReportPath);
```

### Transcript Deduplication
**File**: `/Volumes/Callisto/Projects/clippy/backend/src/database/batch-analysis.service.ts`
**Lines**: 304-329

```typescript
// Check if transcript already exists
const existingTranscript = this.databaseService.getTranscript(video.id);
const hasTranscript = !!existingTranscript;

// Determine mode based on existing transcript and config
let mode: 'full' | 'transcribe-only' | 'analysis-only';

if (config.transcribeOnly) {
  // User explicitly requested transcribe-only
  if (hasTranscript) {
    this.logger.log(`Transcript already exists for ${video.filename}, skipping transcription`);
    return; // Skip this video entirely
  }
  mode = 'transcribe-only';
} else {
  // User requested full analysis
  if (hasTranscript) {
    // Transcript exists, only run AI analysis
    mode = 'analysis-only';
    this.logger.log(`Transcript exists for ${video.filename}, running analysis-only mode`);
  } else {
    // No transcript, run full pipeline
    mode = 'full';
    this.logger.log(`No transcript for ${video.filename}, running full analysis mode`);
  }
}
```

---

## Database Queries

### Check if Video Has Analysis
```sql
SELECT * FROM analyses WHERE video_id = ?
```

### Get Analysis Report for Video
```sql
SELECT * FROM analyses WHERE video_id = ?
```

### Get Analysis Sections
```sql
SELECT * FROM analysis_sections WHERE video_id = ? ORDER BY start_seconds
```

### Get All Tags for Video
```sql
SELECT * FROM tags WHERE video_id = ?
```

### Delete Analysis (Cascades to Sections)
```sql
DELETE FROM analyses WHERE video_id = ?
```

---

## Environment & Configuration

### Database Location
`~/Library/Application Support/clippy/clippy.db`

### File System Output (Single Analysis)
`~/Downloads/clippy/analysis/`

### Config Keys
- `aiModel`: e.g., 'qwen2.5:7b'
- `aiProvider`: 'ollama', 'claude', 'openai'
- `ollamaEndpoint`: e.g., 'http://localhost:11434'
- `whisperModel`: 'base', 'small', 'medium', 'large'

