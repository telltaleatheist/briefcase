import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatListModule } from '@angular/material/list';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatMenuModule } from '@angular/material/menu';
import { LibraryService, LibraryAnalysis } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-clip-creator',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatDialogModule,
    MatTabsModule,
    MatListModule,
    MatInputModule,
    MatFormFieldModule,
    MatMenuModule
  ],
  templateUrl: './clip-creator.component.html',
  styleUrls: ['./clip-creator.component.scss']
})
export class ClipCreatorComponent implements OnInit {
  isLoading = false;
  activeAnalyses: LibraryAnalysis[] = [];
  archivedAnalyses: LibraryAnalysis[] = [];
  selectedAnalysis: LibraryAnalysis | null = null;
  selectedTabIndex: number = 0; // 0 = active, 1 = archived
  editingItemId: string | null = null;
  editingTitle: string = '';
  isElectron = false;

  constructor(
    private libraryService: LibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    console.log('ClipCreatorComponent initialized!');
    this.isElectron = !!(window as any).electron;
    await this.loadAnalyses();
  }

  async loadAnalyses() {
    try {
      this.isLoading = true;

      // Load active and archived analyses
      const [active, archived] = await Promise.all([
        this.libraryService.getAnalyses(false),
        this.libraryService.getAnalyses(true)
      ]);

      // Filter for analyses with linked videos and sort by date
      this.activeAnalyses = active
        .filter((a: LibraryAnalysis) => a.video.isLinked)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      this.archivedAnalyses = archived
        .filter((a: LibraryAnalysis) => a.video.isLinked)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    } catch (error) {
      console.error('Failed to load analyses:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to load video library');
    } finally {
      this.isLoading = false;
    }
  }

  get currentAnalyses(): LibraryAnalysis[] {
    return this.selectedTabIndex === 0 ? this.activeAnalyses : this.archivedAnalyses;
  }

  async selectVideo(analysis: LibraryAnalysis) {
    this.selectedAnalysis = analysis;
    await this.openVideoPlayer(analysis);
  }

  async openVideoPlayer(analysis: LibraryAnalysis) {
    const { VideoPlayerComponent } = await import('../video-player/video-player.component');

    this.dialog.open(VideoPlayerComponent, {
      data: { analysis },
      width: '100vw',
      height: '100vh',
      maxWidth: '100vw',
      maxHeight: '100vh',
      panelClass: 'video-player-dialog-container',
      hasBackdrop: true,
      backdropClass: 'dialog-backdrop',
      disableClose: false
    });
  }

  async selectCustomVideo() {
    if (!this.isElectron) {
      this.notificationService.toastOnly('info', 'Electron Required', 'File selection is only available in Electron');
      return;
    }

    try {
      const result = await (window as any).electron.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg'] }
        ],
        title: 'Select Video File'
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return;
      }

      const videoPath = result.filePaths[0];

      // Create a temporary analysis-like object for custom videos
      const customVideoData = {
        id: `custom-${Date.now()}`,
        title: videoPath.split('/').pop() || 'Custom Video',
        videoPath: videoPath,
        isCustom: true
      };

      // Open video player with custom video
      await this.openVideoPlayerForCustomVideo(customVideoData);

    } catch (error) {
      console.error('Error selecting custom video:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to select video file');
    }
  }

  async openVideoPlayerForCustomVideo(customVideoData: any) {
    const { VideoPlayerComponent } = await import('../video-player/video-player.component');

    this.dialog.open(VideoPlayerComponent, {
      data: { customVideo: customVideoData },
      width: '100vw',
      height: '100vh',
      maxWidth: '100vw',
      maxHeight: '100vh',
      panelClass: 'video-player-dialog-container',
      hasBackdrop: true,
      backdropClass: 'dialog-backdrop',
      disableClose: false
    });
  }

  async relinkVideo(analysis: LibraryAnalysis) {
    const { RelinkDialogComponent } = await import('../relink-dialog/relink-dialog.component');

    const dialogRef = this.dialog.open(RelinkDialogComponent, {
      width: '700px',
      data: { analysis }
    });

    const result = await dialogRef.afterClosed().toPromise();

    if (result?.relinked) {
      // Reload analyses to update the list
      await this.loadAnalyses();
      this.notificationService.toastOnly('success', 'Video Relinked', 'Video relinked successfully');
    }
  }

  formatDate(date: string): string {
    return new Date(date).toLocaleDateString();
  }

  formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  async archiveAnalysis(analysis: LibraryAnalysis, event: Event) {
    event.stopPropagation();
    try {
      await this.libraryService.archiveAnalysis(analysis.id);

      // Move from active to archived
      this.activeAnalyses = this.activeAnalyses.filter(a => a.id !== analysis.id);
      this.archivedAnalyses.unshift({ ...analysis, archived: true });

      // Badge only - obvious result
      this.notificationService.success('Video Archived', 'Video archived successfully', false);
    } catch (error: any) {
      console.error('Error archiving analysis:', error);
      this.notificationService.toastOnly('error', 'Archive Failed', 'Failed to archive video');
    }
  }

  async unarchiveAnalysis(analysis: LibraryAnalysis, event: Event) {
    event.stopPropagation();
    try {
      await this.libraryService.unarchiveAnalysis(analysis.id);

      // Move from archived to active
      this.archivedAnalyses = this.archivedAnalyses.filter(a => a.id !== analysis.id);
      this.activeAnalyses.unshift({ ...analysis, archived: false });

      // Badge only - obvious result
      this.notificationService.success('Video Unarchived', 'Video unarchived successfully', false);
    } catch (error: any) {
      console.error('Error unarchiving analysis:', error);
      this.notificationService.toastOnly('error', 'Unarchive Failed', 'Failed to unarchive video');
    }
  }

  async deleteAnalysis(analysis: LibraryAnalysis, event: Event) {
    event.stopPropagation();

    const confirmed = confirm(
      `Are you sure you want to delete "${analysis.title}"?\n\nThis will permanently delete the analysis and all associated files. This action cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    try {
      await this.libraryService.deleteAnalysis(analysis.id);

      // Remove from appropriate list
      if (analysis.archived) {
        this.archivedAnalyses = this.archivedAnalyses.filter(a => a.id !== analysis.id);
      } else {
        this.activeAnalyses = this.activeAnalyses.filter(a => a.id !== analysis.id);
      }

      // Toast notification for destructive action
      this.notificationService.toastOnly('success', 'Video Deleted', 'Video deleted successfully');
    } catch (error: any) {
      console.error('Error deleting analysis:', error);
      this.notificationService.toastOnly('error', 'Delete Failed', 'Failed to delete video');
    }
  }

  startRename(analysis: LibraryAnalysis, event: Event) {
    event.stopPropagation();
    this.editingItemId = analysis.id;
    this.editingTitle = analysis.title;
  }

  async saveRename(analysis: LibraryAnalysis) {
    if (!this.editingTitle.trim()) {
      this.editingItemId = null;
      return;
    }

    try {
      // Update analysis title
      await this.libraryService.updateAnalysis(analysis.id, { title: this.editingTitle.trim() });

      // Update in local list
      const updateInList = (list: LibraryAnalysis[]) => {
        const index = list.findIndex(a => a.id === analysis.id);
        if (index !== -1) {
          list[index] = { ...list[index], title: this.editingTitle.trim() };
        }
      };

      if (analysis.archived) {
        updateInList(this.archivedAnalyses);
      } else {
        updateInList(this.activeAnalyses);
      }

      this.editingItemId = null;
      // Badge only - obvious result
      this.notificationService.success('Renamed', 'Video renamed successfully', false);
    } catch (error: any) {
      console.error('Error renaming analysis:', error);
      this.notificationService.toastOnly('error', 'Rename Failed', 'Failed to rename video');
      this.editingItemId = null;
    }
  }

  cancelRename() {
    this.editingItemId = null;
    this.editingTitle = '';
  }

  isEditing(analysis: LibraryAnalysis): boolean {
    return this.editingItemId === analysis.id;
  }
}
