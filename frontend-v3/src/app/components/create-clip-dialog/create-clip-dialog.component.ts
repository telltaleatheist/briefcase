import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LibraryService, LibraryAnalysis } from '../../services/library.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { ProcessingQueueService } from '../../services/processing-queue.service';
import { NotificationService } from '../../services/notification.service';

export interface CreateClipDialogData {
  analysis?: LibraryAnalysis;
  customVideo?: any;
  startTime: number;
  endTime: number;
}

@Component({
  selector: 'app-create-clip-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatCheckboxModule,
    MatTooltipModule,
  ],
  templateUrl: './create-clip-dialog.component.html',
  styleUrls: ['./create-clip-dialog.component.scss']
})
export class CreateClipDialogComponent {
  title = '';
  reEncode = true;  // Default to true to avoid black frames at the start of clips
  isCreating = false;
  error: string | null = null;
  savePath = '';
  saveDirectory = '';
  isLoadingSavePath = true;
  customDirectory: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: CreateClipDialogData,
    private dialogRef: MatDialogRef<CreateClipDialogComponent>,
    private libraryService: LibraryService,
    private backendUrlService: BackendUrlService,
    private processingQueue: ProcessingQueueService,
    private notificationService: NotificationService
  ) {
    // Set default title based on whether it's an analyzed video or custom video
    if (this.data.analysis) {
      this.title = `Clip from ${this.data.analysis.title}`;
    } else if (this.data.customVideo) {
      this.title = `Clip from ${this.data.customVideo.title}`;
    } else {
      this.title = 'New Clip';
    }

    // Load the default save path (only for analyzed videos)
    if (this.data.analysis) {
      this.loadSavePath();
    } else {
      // For custom videos, we'll need a different approach
      this.loadCustomVideoSavePath();
    }
  }

  get duration(): number {
    return this.data.endTime - this.data.startTime;
  }

  formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  async loadSavePath() {
    if (!this.data.analysis) return;

    try {
      this.isLoadingSavePath = true;
      const savePathUrl = await this.backendUrlService.getApiUrl(`/library/analyses/${this.data.analysis.id}/clip-save-path`);
      const response = await fetch(savePathUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startTime: this.data.startTime,
          endTime: this.data.endTime,
          customDirectory: this.customDirectory || undefined,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        this.savePath = data.outputPath;
        this.saveDirectory = data.outputDir;
      } else {
        console.error('Failed to load save path');
      }
    } catch (error) {
      console.error('Error loading save path:', error);
    } finally {
      this.isLoadingSavePath = false;
    }
  }

  async loadCustomVideoSavePath() {
    try {
      this.isLoadingSavePath = true;
      // For custom videos, generate a simple save path
      const filename = this.data.customVideo?.title || 'custom_video';
      const safeFilename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const timestamp = `${Math.floor(this.data.startTime)}-${Math.floor(this.data.endTime)}`;
      const clipFilename = `${safeFilename}_${timestamp}.mp4`;

      // Fetch library paths from backend to use the clips directory
      const pathsUrl = await this.backendUrlService.getApiUrl('/library/paths');
      const response = await fetch(pathsUrl);

      if (response.ok) {
        const libraryPaths = await response.json();
        this.saveDirectory = libraryPaths.clipsDir;
        this.savePath = `${this.saveDirectory}/${clipFilename}`;
      } else {
        // Fallback to Downloads if API fails
        const homedir = await (window as any).electron?.getPath('downloads') || 'Downloads';
        this.saveDirectory = `${homedir}/clipchimp/clips`;
        this.savePath = `${this.saveDirectory}/${clipFilename}`;
        console.warn('Failed to fetch library paths, using fallback directory');
      }
    } catch (error) {
      console.error('Error generating custom video save path:', error);
      this.savePath = 'clip.mp4';
      this.saveDirectory = 'Downloads';
    } finally {
      this.isLoadingSavePath = false;
    }
  }

  async browseDirectory() {
    try {
      const result = await (window as any).electron?.openDirectoryPicker();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        this.customDirectory = result.filePaths[0];
        await this.loadSavePath(); // Reload the path with new custom directory
      }
    } catch (error) {
      console.error('Error browsing directory:', error);
    }
  }

  async createClip() {
    if (!this.title.trim()) {
      this.error = 'Please enter a title';
      return;
    }

    try {
      this.isCreating = true;
      this.error = null;

      let result: any;

      // If re-encoding is enabled, add to processing queue instead of blocking
      if (this.reEncode) {
        const videoPath = this.data.analysis
          ? this.data.analysis.video.currentPath
          : (this.data.customVideo?.realFilePath || this.data.customVideo?.videoPath);

        // Add to processing queue
        const jobId = this.processingQueue.addJob({
          type: 'clip-extraction',
          title: this.title,
          metadata: {
            videoPath,
            clipStartTime: this.data.startTime,
            clipEndTime: this.data.endTime,
            outputPath: this.savePath,
            reEncode: true
          }
        });

        // Process the clip in the background
        this.processClipInBackground(jobId);

        // Close dialog immediately
        this.dialogRef.close({ created: true, queued: true });
        return;
      }

      // Fast mode (no re-encoding) - process synchronously
      if (this.data.analysis) {
        // Extract clip from analyzed video
        result = await this.libraryService.extractClip(
          this.data.analysis.id,
          {
            startTime: this.data.startTime,
            endTime: this.data.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
            reEncode: false,
          }
        );
      } else if (this.data.customVideo) {
        // Extract clip from custom video
        // Use realFilePath if available (for dragged/dropped files), otherwise use videoPath
        const videoPath = this.data.customVideo.realFilePath || this.data.customVideo.videoPath;

        if (!videoPath || videoPath.startsWith('blob:')) {
          throw new Error('Cannot extract clip: No valid file path available. Please ensure the video file is accessible.');
        }

        const extractUrl = await this.backendUrlService.getApiUrl('/library/videos/custom/extract-clip');
        const response = await fetch(extractUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: videoPath,
            startTime: this.data.startTime,
            endTime: this.data.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
            reEncode: false,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to extract clip from custom video');
        }

        result = await response.json();
      } else {
        this.error = 'No video source available';
        this.isCreating = false;
        return;
      }

      if (result.success) {
        this.dialogRef.close({ created: true, clip: result.clip, extraction: result.extraction });
      } else {
        this.error = result.error || 'Failed to create clip';
        this.isCreating = false;
      }

    } catch (error) {
      console.error('Error creating clip:', error);
      this.error = 'An error occurred while creating the clip';
      this.isCreating = false;
    }
  }

  private async processClipInBackground(jobId: string) {
    try {
      this.processingQueue.updateJob(jobId, { status: 'processing', startTime: new Date() });

      let result: any;

      if (this.data.analysis) {
        result = await this.libraryService.extractClip(
          this.data.analysis.id,
          {
            startTime: this.data.startTime,
            endTime: this.data.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
            reEncode: true,
          }
        );
      } else if (this.data.customVideo) {
        const videoPath = this.data.customVideo.realFilePath || this.data.customVideo.videoPath;
        const extractUrl = await this.backendUrlService.getApiUrl('/library/videos/custom/extract-clip');
        const response = await fetch(extractUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: videoPath,
            startTime: this.data.startTime,
            endTime: this.data.endTime,
            title: this.title,
            description: '',
            category: undefined,
            customDirectory: this.customDirectory || undefined,
            reEncode: true,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to extract clip from custom video');
        }

        result = await response.json();
      }

      if (result.success) {
        this.processingQueue.updateJob(jobId, {
          status: 'completed',
          progress: 100,
          endTime: new Date()
        });

        // Show notification with navigation to library if videoId is available
        const videoId = result.videoId;
        if (videoId) {
          this.notificationService.toastOnly(
            'success',
            'Clip Created',
            'Click to view in library',
            {
              type: 'navigate-library',
              videoId: videoId
            }
          );
        } else {
          // Fallback to folder notification
          this.notificationService.toastOnly(
            'success',
            'Clip Created',
            `Clip saved to: ${result.extraction?.outputPath || 'clips folder'}`,
            {
              type: 'open-folder',
              path: result.extraction?.outputPath
            }
          );
        }
      } else {
        this.processingQueue.updateJob(jobId, {
          status: 'failed',
          error: result.error || 'Failed to create clip',
          endTime: new Date()
        });
      }
    } catch (error) {
      console.error('Background clip extraction error:', error);
      this.processingQueue.updateJob(jobId, {
        status: 'failed',
        error: 'An error occurred while creating the clip',
        endTime: new Date()
      });
    }
  }

  cancel() {
    this.dialogRef.close({ created: false });
  }
}
