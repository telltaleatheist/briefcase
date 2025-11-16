# Adding New Video Processing Types

This guide explains how to add new process types to the video processing queue system.

## Quick Start - Adding a New Process Type

Let's add a "compress" process as an example.

### 1. Update Process Registry

**File: `frontend/src/app/models/process-registry.ts`**

Add your new process to the `PROCESS_DEFINITIONS` object:

```typescript
export const PROCESS_DEFINITIONS: Record<ProcessType, ProcessDefinition> = {
  // ... existing processes ...

  'compress': {
    type: 'compress',
    displayName: 'Compress Video',
    icon: 'compress',  // Material icon name
    apiPath: '/ffmpeg/compress',
    requiresVideoId: false,  // true if you need the video in the database first
    defaultConfig: {
      quality: 23,  // CRF value for ffmpeg
      preset: 'medium'
    }
  },
};
```

### 2. Update ProcessType Union

**File: `frontend/src/app/models/video-processing.model.ts`**

```typescript
export type ProcessType =
  | 'process'
  | 'normalize'
  | 'transcribe'
  | 'analyze'
  | 'compress';  // ← Add this
```

### 3. Add Configuration Type (if needed)

**File: `frontend/src/app/models/video-processing.model.ts`**

```typescript
export interface CompressionConfig {
  quality?: number;
  preset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
}

export type ProcessTypeConfig =
  | AIAnalysisConfig
  | TranscriptionConfig
  | CompressionConfig  // ← Add this
  | Record<string, never>;
```

### 4. Add to applyProcessConfig (if custom config needed)

**File: `frontend/src/app/services/video-processing-queue.service.ts`**

```typescript
private applyProcessConfig(child: ChildProcess, type: ProcessType, config: ProcessTypeConfig): void {
  switch (type) {
    case 'analyze':
      // ... existing code ...
      break;

    case 'transcribe':
      // ... existing code ...
      break;

    case 'compress':
      const compressConfig = config as CompressionConfig;
      (child as any).quality = compressConfig.quality || 23;
      (child as any).preset = compressConfig.preset || 'medium';
      break;

    // 'process' and 'normalize' don't need additional config
  }
}
```

### 5. Add Submission Handler

**File: `frontend/src/app/services/video-processing-queue.service.ts`**

```typescript
private async submitChildProcess(parentJobId: string, child: ChildProcess): Promise<void> {
  // ... existing code ...

  switch (child.type) {
    case 'process':
      backendJobId = await this.submitProcessing(job);
      break;

    // ... other cases ...

    case 'compress':
      backendJobId = await this.submitCompress(job, child);
      break;
  }
}

private async submitCompress(job: VideoProcessingJob, child: ChildProcess): Promise<string> {
  const url = await this.backendUrlService.getApiUrl('/ffmpeg/compress');

  const response = await this.http.post<any>(url, {
    inputPath: job.videoPath,
    videoId: job.videoId,
    quality: (child as any).quality || 23,
    preset: (child as any).preset || 'medium'
  }).toPromise();

  if (!response.success) {
    throw new Error(response.error || 'Failed to start compression');
  }

  return response.jobId;
}
```

### 6. Add Backend Endpoint

**File: `backend/src/ffmpeg/ffmpeg.controller.ts`**

```typescript
@Post('compress')
async compressVideo(@Body() body: {
  inputPath: string;
  videoId?: string;
  quality?: number;
  preset?: string;
}): Promise<any> {
  const jobId = uuidv4();

  // Start compression in background
  this.ffmpegService.compressVideo(
    body.inputPath,
    body.quality || 23,
    body.preset || 'medium',
    jobId
  );

  return { success: true, jobId };
}
```

**File: `backend/src/ffmpeg/ffmpeg.service.ts`**

```typescript
async compressVideo(
  inputPath: string,
  quality: number,
  preset: string,
  jobId: string
): Promise<string> {
  const outputPath = inputPath.replace(/\.(mp4|mov|avi)$/, '_compressed.$1');

  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath)
      .outputOptions([
        `-c:v libx264`,
        `-crf ${quality}`,
        `-preset ${preset}`,
        `-c:a copy`
      ])
      .on('progress', (progress) => {
        // Emit progress via WebSocket
        this.eventEmitter.emit('processing-progress', {
          jobId,
          progress: Math.round(progress.percent || 0),
          task: 'Compressing video...'
        });
      })
      .on('end', () => {
        this.eventEmitter.emit('processing-progress', {
          jobId,
          progress: 100,
          task: 'Compression complete'
        });
        resolve(outputPath);
      })
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}
```

### 7. Add UI Checkbox (Optional)

**File: `frontend/src/app/components/video-analysis-dialog/video-analysis-dialog.component.ts`**

Add to the form:
```typescript
this.fb.group({
  // ... existing fields ...
  compressVideo: [false],
  compressionQuality: [23],
  compressionPreset: ['medium']
})
```

Add to getProcessConfigs():
```typescript
if (formValue.compressVideo) {
  processes.push({
    type: 'compress' as ProcessType,
    config: {
      quality: formValue.compressionQuality,
      preset: formValue.compressionPreset
    }
  });
}
```

## That's It!

The new process will now:
- ✅ Show up in the queue with the correct icon and label
- ✅ Display its own progress bar as a child process
- ✅ Run sequentially with other processes
- ✅ Update progress via WebSocket
- ✅ Handle errors gracefully

## Architecture Overview

```
User selects video(s) + processes
         ↓
VideoAnalysisDialogComponent
         ↓
VideoProcessingQueueService.addVideoJob()
    → Creates parent job with child processes
         ↓
VideoProcessingQueueService.submitJob()
    → Submits each child process sequentially
         ↓
Backend processes video
    → Emits progress via WebSocket
         ↓
DownloadQueueComponent displays
    → Parent job with child progress bars
```

## Progress Bar Display

Each child process automatically gets:
- Individual progress bar (0-100%)
- Status indicator (pending/active/completed/failed)
- Icon from process registry
- Display name from process registry

The parent job shows:
- Overall progress (average of all children)
- Expandable to show all child processes
- Overall status (pending/processing/completed/failed)

## Tips

1. **Keep processes atomic** - Each process should do one thing well
2. **Emit progress frequently** - WebSocket updates every 1-2% for smooth progress bars
3. **Handle errors gracefully** - Set child.status = 'failed' and child.error = message
4. **Use meaningful icons** - Check [Material Icons](https://fonts.google.com/icons) for options
5. **Make configs optional** - Provide sensible defaults so users don't have to configure everything
