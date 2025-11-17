# Legacy Code to Remove After Frontend Migration

## Backend Files to DELETE

### 1. **batch-downloader.service.ts**
- **Path**: `backend/src/downloader/batch-downloader.service.ts`
- **Reason**: Completely replaced by QueueManagerService
- **Used by**: DownloaderController batch endpoints (which are also being removed)

### 2. **library-download.service.ts**
- **Path**: `backend/src/downloader/library-download.service.ts`
- **Reason**: Monolithic pipeline replaced by MediaOperationsService + QueueManagerService
- **Used by**: DownloaderController `/downloader` POST endpoint

### 3. **AnalysisService - Monolithic Parts** (DO NOT DELETE ENTIRE FILE)
- **Path**: `backend/src/analysis/analysis.service.ts`
- **Keep**: The service itself (used by batch-analysis.service.ts for library analysis)
- **Remove these methods**:
  - `processJobPhase()` - line 320-438
  - `processDownloadPhase()` - line 443-529
  - `processTranscribePhase()` - line 531-637
  - `processAnalyzePhase()` - line 639-756
  - `processProcessPhase()` - line 761-810
  - `processNormalizeAudioPhase()` - line 812-868
  - `processFinalizePhase()` - line 870-981
  - All the queue management logic (pendingQueue, processNextInQueue, etc.)
- **Reason**: Replaced by atomic operations in MediaOperationsService

## Backend Endpoints to REMOVE from DownloaderController

### File: `backend/src/downloader/downloader.controller.ts`

Remove these endpoints:
1. **POST /downloader** (line 70-81) - Main download endpoint, replaced by queue system
2. **POST /downloader/batch** (line 83-87) - Batch add, replaced by `/queue/add`
3. **POST /downloader/batch/bulk** (line 89-95) - Bulk add, replaced by `/queue/add-bulk`
4. **POST /downloader/download-only** (line 24-44) - Replaced by `/media/download`
5. **POST /downloader/download-and-import** (line 50-64) - Replaced by queue with [download, import] tasks

### Keep these endpoints (still useful):
- ✅ GET /downloader/info - Used by frontend, works standalone
- ✅ GET /downloader/batch/status - Can keep or migrate to `/queue/status`
- ✅ All history endpoints (GET /downloader/history, etc.)
- ✅ File serving endpoints (GET /downloader/file/:id, etc.)

## Frontend Files to UPDATE (not delete)

### 1. **batch-api.service.ts**
- **Path**: `frontend/src/app/services/batch-api.service.ts`
- **Action**: Update methods to call new `/queue/*` endpoints
- **Methods to update**:
  - `addToBatchQueue()` → call `/queue/add` with queueType: 'batch'
  - `addMultipleToBatchQueue()` → call `/queue/add-bulk`
  - `getBatchStatus()` → call `/queue/status?type=batch`
  - `deleteJob()` → call `/queue/job/:id` DELETE
  - `cancelJob()` → call `/queue/job/:id/cancel` POST

### 2. **Components using batch API**
- **batch-download.component.ts** - Update to use new task-based system
- **download-queue.component.ts** - Update to use new queue status format
- **video-analysis-dialog.component.ts** - Update to use new queue API for analysis

### 3. **api.service.ts** (if it calls old endpoints)
- Update any direct calls to `/downloader` endpoints

## Remove Backward Compatibility: Old Event System

### 1. **Remove `processing-progress` Event System**
The old `processing-progress` events have been replaced by `task-progress` events in the new queue system. Remove all backward compatibility code:

#### Backend - FfmpegService (`backend/src/ffmpeg/ffmpeg.service.ts`)
Remove dual emission, keep ONLY `emitTaskProgress`:
- **Line 270-273**: Remove `emitProcessingProgress`, keep only `emitTaskProgress`
- **Line 510-513**: Remove `emitProcessingProgress`, keep only `emitTaskProgress`
- **Line 521-525**: Remove `emitProcessingProgress`, keep only `emitTaskProgress`
- **Line 560-563**: Remove all `emitProcessingProgress` calls, keep only `emitTaskProgress`
- **Line 570-573**: Remove all `emitProcessingProgress` calls, keep only `emitTaskProgress`
- **Line 580-582**: Remove all `emitProcessingProgress` calls, keep only `emitTaskProgress`

#### Backend - MediaEventService (`backend/src/media/media-event.service.ts`)
- **Keep**: `emitTaskProgress()` method
- **Remove**: `emitProcessingProgress()` method entirely (after confirming nothing else uses it)
- **Remove**: `emitProcessingStarted()` method
- **Remove**: `emitProcessingCompleted()` method
- **Remove**: `emitProcessingFailed()` method (if only used by old system)

#### Frontend - SocketService (`frontend/src/app/services/socket.service.ts`)
- **Line 121-136**: Remove `onProcessingProgress()` method
- **Line 255-259**: Remove `onProcessingFailed()` method (if not used elsewhere)

#### Frontend - Components
Remove any components still listening to:
- `onProcessingProgress()`
- `onProcessingStarted()`
- `onProcessingCompleted()`

Replace with:
- `onTaskProgress()`
- `onQueueStatusUpdated()`

### 2. **Remove Old `batch-queue-updated` Event**
The new queue system uses `queue-status-updated` instead:

#### Frontend - SocketService (`frontend/src/app/services/socket.service.ts`)
- **Line 225-227**: Remove `onBatchQueueUpdated()` method
- **Keep**: `onQueueStatusUpdated()` method (line 232-234)

#### Frontend - Components
Update any components listening to `onBatchQueueUpdated()` to use `onQueueStatusUpdated()` instead

## Module Updates

### DownloaderModule (`backend/src/downloader/downloader.module.ts`)
Remove from providers:
- `BatchDownloaderService`
- `LibraryDownloadService`

## Testing Checklist

Before removing legacy code, verify:
- [ ] Batch queue works with new `/queue/*` endpoints
- [ ] Analysis queue works with new `/queue/*` endpoints
- [ ] Individual operations work via `/media/*` endpoints
- [ ] **NEW**: Progress bars update correctly for fix-aspect-ratio tasks
- [ ] **NEW**: Progress bars update correctly for normalize-audio tasks
- [ ] **NEW**: `process-video` task works with both options (single re-encode)
- [ ] WebSocket `task-progress` events work correctly
- [ ] Frontend displays queue status correctly
- [ ] All task types execute successfully (download, import, fix-aspect-ratio, normalize-audio, process-video, transcribe, analyze)
- [ ] Error handling works properly

### After Testing Passes:
- [ ] Remove all `processing-progress` event code
- [ ] Remove all `batch-queue-updated` event code
- [ ] Remove dual emission code from FfmpegService
- [ ] Remove old event listeners from SocketService

## Notes

- **Don't delete batch-analysis.service.ts** - It's used for batch processing existing library videos
- **Keep the AnalysisService file** - Just remove the monolithic job processing methods
- **Keep GET /downloader/info** - It's a useful standalone endpoint for fetching video metadata
- The old code can coexist with new code temporarily during migration
