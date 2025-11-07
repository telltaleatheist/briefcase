# Missing Metadata Handling - Specific Code Fixes

## Critical Fix #1: Array Bounds in updateActiveSection()

**File:** `frontend/src/app/components/video-player/video-player.component.ts`

**Current Code (UNSAFE - Lines 587-609):**
```typescript
updateActiveSection() {
  if (!this.metadata?.sections) return;

  const currentSection = this.metadata.sections.findIndex((section, index) => {
    const startTime = section.startSeconds;
    const endTime = section.endSeconds ||
      (this.metadata!.sections[index + 1]?.startSeconds || this.duration);
    // ↑ PROBLEM: No bounds check on index + 1
    return this.currentTime >= startTime && this.currentTime < endTime;
  });

  if (currentSection !== -1 && currentSection !== this.previousActiveSectionIndex) {
    this.activeSectionIndex = currentSection;
    this.previousActiveSectionIndex = currentSection;

    if (this.isPlaying && this.tabGroup && this.tabGroup.selectedIndex === 0) {
      this.scrollToActiveSection();
    }
  } else if (currentSection === -1) {
    this.previousActiveSectionIndex = null;
  }
}
```

**Fixed Code:**
```typescript
updateActiveSection() {
  // CHANGE 1: Add length check
  if (!this.metadata?.sections || this.metadata.sections.length === 0) return;

  const currentSection = this.metadata.sections.findIndex((section, index) => {
    const startTime = section.startSeconds;
    
    // CHANGE 2: Add bounds checking before accessing next section
    let endTime: number;
    if (section.endSeconds !== undefined && section.endSeconds !== null) {
      endTime = section.endSeconds;
    } else if (index + 1 < this.metadata!.sections.length) {
      // Only access next section if it exists
      const nextSection = this.metadata.sections[index + 1];
      endTime = nextSection?.startSeconds || this.duration;
    } else {
      // Last section - use total duration
      endTime = this.duration;
    }
    
    return this.currentTime >= startTime && this.currentTime < endTime;
  });

  if (currentSection !== -1 && currentSection !== this.previousActiveSectionIndex) {
    this.activeSectionIndex = currentSection;
    this.previousActiveSectionIndex = currentSection;

    if (this.isPlaying && this.tabGroup && this.tabGroup.selectedIndex === 0) {
      this.scrollToActiveSection();
    }
  } else if (currentSection === -1) {
    this.previousActiveSectionIndex = null;
  }
}
```

---

## Critical Fix #2: Array Bounds in seekToTime()

**File:** `frontend/src/app/components/video-player/video-player.component.ts`

**Current Code (UNSAFE - Lines 562-582):**
```typescript
seekToTime(seconds: number, sectionIndex?: number) {
  if (this.videoEl) {
    this.videoEl.currentTime = seconds;
    this.videoEl.play();
  }
  
  if (sectionIndex !== undefined) {
    this.activeSectionIndex = sectionIndex;

    const section = this.metadata?.sections[sectionIndex];
    if (section) {
      const endTime = section.endSeconds ||
        (this.metadata!.sections[sectionIndex + 1]?.startSeconds || this.duration);
      // ↑ PROBLEM: No bounds check on sectionIndex + 1
      this.currentSelection = {
        startTime: section.startSeconds,
        endTime: endTime
      };
    }
  }
}
```

**Fixed Code:**
```typescript
seekToTime(seconds: number, sectionIndex?: number) {
  if (this.videoEl) {
    this.videoEl.currentTime = seconds;
    this.videoEl.play();
  }
  
  if (sectionIndex !== undefined) {
    // CHANGE 1: Add bounds checking
    if (!this.metadata?.sections || sectionIndex < 0 || sectionIndex >= this.metadata.sections.length) {
      console.warn(`[seekToTime] Invalid section index: ${sectionIndex}`);
      return;
    }

    this.activeSectionIndex = sectionIndex;

    const section = this.metadata.sections[sectionIndex];
    if (section) {
      // CHANGE 2: Safe access to next section with bounds check
      let endTime: number;
      if (section.endSeconds !== undefined && section.endSeconds !== null) {
        endTime = section.endSeconds;
      } else if (sectionIndex + 1 < this.metadata.sections.length) {
        const nextSection = this.metadata.sections[sectionIndex + 1];
        endTime = nextSection?.startSeconds || this.duration;
      } else {
        endTime = this.duration;
      }

      this.currentSelection = {
        startTime: section.startSeconds,
        endTime: endTime
      };
    }
  }
}
```

---

## Critical Fix #3: Transcript SRT Format Null Check

**File:** `frontend/src/app/components/video-player/video-player.component.ts`

**Current Code (Lines 155-172):**
```typescript
async ngOnInit() {
  try {
    // ... other init code ...

    // Load transcript from database if available
    if (videoId && hasTranscript) {
      try {
        const dbTranscript = await this.databaseLibraryService.getTranscript(videoId);
        if (dbTranscript) {
          // Use SRT format from database (includes timestamps for seeking)
          this.transcriptText = dbTranscript.srt_format;  // ⚠️ Could be null!
          this.transcriptExists = !!(this.transcriptText && this.transcriptText.trim().length > 0);
        } else {
          this.transcriptExists = false;
          this.transcriptText = null;
        }
      } catch (error) {
        console.error('Failed to load transcript:', error);
        this.transcriptExists = false;
        this.transcriptText = null;
      }
    }
  } catch (error) {
    console.error('Failed to initialize video player:', error);
  }
}
```

**Fixed Code:**
```typescript
async ngOnInit() {
  try {
    // ... other init code ...

    // Load transcript from database if available
    if (videoId && hasTranscript) {
      try {
        const dbTranscript = await this.databaseLibraryService.getTranscript(videoId);
        // CHANGE 1: Check both that dbTranscript exists AND that srt_format is not null
        if (dbTranscript && dbTranscript.srt_format) {
          // Use SRT format from database (includes timestamps for seeking)
          // At this point we know srt_format is definitely a string
          this.transcriptText = dbTranscript.srt_format;
          this.transcriptExists = this.transcriptText.trim().length > 0;
        } else {
          // CHANGE 2: Clear state if transcript or srt_format is missing
          this.transcriptExists = false;
          this.transcriptText = null;
          console.warn('[VideoPlayer] Transcript record exists but srt_format is null or empty');
        }
      } catch (error) {
        console.error('Failed to load transcript:', error);
        this.transcriptExists = false;
        this.transcriptText = null;
      }
    }
  } catch (error) {
    console.error('Failed to initialize video player:', error);
  }
}
```

---

## High Priority Fix #4: File Existence Check Before Opening

**File:** `frontend/src/app/components/library/library.component.ts`

**Current Code (Lines 617-660):**
```typescript
async openVideoPlayer(video: DatabaseVideo) {
  // Close any existing video player dialog first
  if (this.openVideoPlayerDialog) {
    console.log('[openVideoPlayer] Closing existing dialog');
    this.openVideoPlayerDialog.close();
    this.openVideoPlayerDialog = null;
  }

  // Import VideoPlayerComponent dynamically
  const { VideoPlayerComponent } = await import('../video-player/video-player.component');

  // Open dialog immediately - don't wait for analysis/transcript checks
  this.openVideoPlayerDialog = this.dialog.open(VideoPlayerComponent, {
    width: '100vw',
    height: '100vh',
    maxWidth: '100vw',
    maxHeight: '100vh',
    data: {
      videoId: video.id,
      videoPath: video.current_path,  // ⚠️ No check if file exists
      videoTitle: video.filename
    },
    // ... rest of dialog config
  });
  
  // ... rest of method
}
```

**Fixed Code:**
```typescript
async openVideoPlayer(video: DatabaseVideo) {
  // CHANGE 1: Add file existence check BEFORE opening dialog
  // Check if video is linked and file exists
  if (video.is_linked === 0) {
    this.notificationService.toastOnly(
      'warning',
      'Video Not Linked',
      'This video file was not found. Click to relink it.',
      {
        type: 'open-dialog',
        action: 'relink',
        videoId: video.id
      }
    );
    return;
  }

  // CHANGE 2: Verify file still exists before opening
  // This is a proactive check to catch moved/deleted files
  try {
    // Send a HEAD request to the backend to check if file is accessible
    const checkUrl = await this.backendUrlService.getApiUrl(
      `/library/videos/${video.id}/check-exists`
    );
    const response = await this.http.head(checkUrl).toPromise();
    
    if (!response) {
      // File doesn't exist - mark as unlinked and notify user
      await this.databaseLibraryService.deleteVideo(video.id);
      this.loadVideos();
      
      this.notificationService.toastOnly(
        'error',
        'Video File Missing',
        'The video file is no longer accessible. It has been removed from the library.'
      );
      return;
    }
  } catch (error) {
    console.error('Error checking video file existence:', error);
    // If we can't check, still try to open - the player will show proper error
  }

  // Close any existing video player dialog first
  if (this.openVideoPlayerDialog) {
    console.log('[openVideoPlayer] Closing existing dialog');
    this.openVideoPlayerDialog.close();
    this.openVideoPlayerDialog = null;
  }

  // Import VideoPlayerComponent dynamically
  const { VideoPlayerComponent } = await import('../video-player/video-player.component');

  // Open dialog with video data
  this.openVideoPlayerDialog = this.dialog.open(VideoPlayerComponent, {
    width: '100vw',
    height: '100vh',
    maxWidth: '100vw',
    maxHeight: '100vh',
    data: {
      videoId: video.id,
      videoPath: video.current_path,
      videoTitle: video.filename
    },
    panelClass: 'video-player-dialog-container',
    hasBackdrop: true,
    backdropClass: 'dialog-backdrop',
    disableClose: false
  });

  // Clean up reference when dialog closes
  this.openVideoPlayerDialog.afterClosed().subscribe(() => {
    console.log('[openVideoPlayer] Dialog closed, cleaning up reference');
    this.openVideoPlayerDialog = null;
  });

  // Check analysis/transcript status in background
  this.databaseLibraryService.hasAnalysis(video.id).catch(err =>
    console.error('Background analysis check failed:', err)
  );
  this.databaseLibraryService.hasTranscript(video.id).catch(err =>
    console.error('Background transcript check failed:', err)
  );
}
```

---

## High Priority Fix #5: Add Backend Endpoint for File Existence

**File:** `backend/src/library/library.controller.ts`

**Add new endpoint:**
```typescript
@Head('videos/:videoId/check-exists')
@HttpCode(200)
async checkVideoFileExists(@Param('videoId') videoId: string): Promise<void> {
  try {
    const video = this.databaseService.getVideoById(videoId);
    
    if (!video) {
      throw new NotFoundException('Video not found');
    }

    // Check if file still exists at the current path
    const exists = await this.libraryService.fileExists(video.current_path);
    
    if (!exists) {
      // Mark as unlinked in database
      this.databaseService.markVideoUnlinked(videoId);
      throw new NotFoundException('Video file not found at current path');
    }

    // File exists - return 200 OK
    return;
  } catch (error) {
    throw error;
  }
}
```

---

## Database Fix #6: Add NOT NULL Constraints for Required Fields

**File:** `backend/src/database/database.service.ts`

**Current schema (Lines 121-160) allows too many nulls:**
```sql
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,           -- ✓ Required
  file_hash TEXT UNIQUE,            -- ✗ Should be NOT NULL
  current_path TEXT NOT NULL,       -- ✓ Required
  date_folder TEXT,                 -- Optional (OK)
  duration_seconds REAL,            -- Optional (OK)
  file_size_bytes INTEGER,          -- Optional (OK)
  ai_description TEXT,              -- Optional (OK)
  created_at TEXT NOT NULL,         -- ✓ Required
  last_verified TEXT NOT NULL,      -- ✓ Required
  added_at TEXT NOT NULL,           -- ✓ Required
  is_linked INTEGER DEFAULT 1,      -- ✓ Has default
  CHECK (is_linked IN (0, 1))
);
```

**Recommended improvements:**
```sql
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,                    -- ✓ Required
  file_hash TEXT NOT NULL UNIQUE,            -- CHANGE: Make NOT NULL
  current_path TEXT NOT NULL,                -- ✓ Required
  date_folder TEXT,                         -- Optional
  duration_seconds REAL,                    -- Optional
  file_size_bytes INTEGER,                  -- Optional
  ai_description TEXT,                      -- Optional
  created_at TEXT NOT NULL,                 -- ✓ Required
  last_verified TEXT NOT NULL,              -- ✓ Required
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- CHANGE: Add default
  is_linked INTEGER NOT NULL DEFAULT 1,     -- CHANGE: Add NOT NULL
  CHECK (is_linked IN (0, 1))
);

-- Recommend making these NOT NULL with defaults:
CREATE TABLE IF NOT EXISTS transcripts (
  video_id TEXT PRIMARY KEY,
  plain_text TEXT NOT NULL,         -- ✓ Required
  srt_format TEXT NOT NULL,         -- CHANGE: Requires SRT even if empty
  whisper_model TEXT DEFAULT 'base',
  language TEXT DEFAULT 'en',
  transcribed_at TEXT NOT NULL,     -- ✓ Required
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS analyses (
  video_id TEXT PRIMARY KEY,
  ai_analysis TEXT NOT NULL,        -- ✓ Required
  summary TEXT,                     -- Optional (OK)
  sections_count INTEGER DEFAULT 0, -- CHANGE: Add default
  ai_model TEXT NOT NULL,           -- ✓ Required
  ai_provider TEXT,                 -- Optional (OK)
  analyzed_at TEXT NOT NULL,        -- ✓ Required
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);
```

**Migration to implement:**
```typescript
private runSchemaMigrations() {
  const db = this.ensureInitialized();

  // Migration: Ensure file_hash is NOT NULL for new records
  // (Don't enforce on existing records to avoid breaking old data)
  this.logger.log('Schema validation: file_hash should be NOT NULL for new videos');
  // Add validation at insert time instead
}
```

---

## Summary of Changes

### Critical Fixes Required
1. Array bounds checking in `updateActiveSection()` - BLOCKER
2. Array bounds checking in `seekToTime()` - BLOCKER  
3. Explicit null check for `transcriptSrt` - IMPORTANT
4. File existence check before opening video - IMPORTANT

### High Priority Improvements
5. Add backend endpoint to check file existence - RECOMMENDED
6. Add NOT NULL constraints to key database fields - RECOMMENDED
7. Add error boundaries to video player component - NICE TO HAVE

### Testing Recommendations
- Test video player with empty analysis sections
- Test video player with null transcript fields
- Test opening deleted/moved video files
- Test batch analysis with missing metadata
- Test database with partially deleted analysis records

