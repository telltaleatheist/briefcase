import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { LibraryService, LibraryAnalysis } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-clip-creator',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatDialogModule
  ],
  templateUrl: './clip-creator.component.html',
  styleUrls: ['./clip-creator.component.scss']
})
export class ClipCreatorComponent implements OnInit {
  isLoading = false;
  analyses: LibraryAnalysis[] = [];
  selectedAnalysis: LibraryAnalysis | null = null;

  constructor(
    private libraryService: LibraryService,
    private dialog: MatDialog,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    console.log('ClipCreatorComponent initialized!');
    await this.loadAnalyses();
  }

  async loadAnalyses() {
    try {
      this.isLoading = true;
      const allAnalyses = await this.libraryService.getAnalyses(false);
      // Filter for analyses with linked videos
      this.analyses = allAnalyses.filter((a: LibraryAnalysis) => a.video.isLinked && !a.archived);
    } catch (error) {
      console.error('Failed to load analyses:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to load video library');
    } finally {
      this.isLoading = false;
    }
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
      hasBackdrop: false,
      disableClose: false
    });
  }

  async selectCustomVideo() {
    // TODO: Implement custom video file picker
    this.notificationService.toastOnly('info', 'Coming Soon', 'Custom video selection will be available soon');
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
}
