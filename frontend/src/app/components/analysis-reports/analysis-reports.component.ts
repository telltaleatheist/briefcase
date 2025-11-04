import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LibraryService, LibraryAnalysis, ParsedAnalysisMetadata } from '../../services/library.service';

@Component({
  selector: 'app-analysis-reports',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatTabsModule,
    MatTooltipModule,
  ],
  templateUrl: './analysis-reports.component.html',
  styleUrls: ['./analysis-reports.component.scss']
})
export class AnalysisReportsComponent implements OnInit {
  activeAnalyses: LibraryAnalysis[] = [];
  archivedAnalyses: LibraryAnalysis[] = [];
  selectedAnalysis: LibraryAnalysis | null = null;
  parsedMetadata: ParsedAnalysisMetadata | null = null;
  isLoading = false;
  currentTab: 'active' | 'archived' = 'active';

  constructor(
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    private libraryService: LibraryService
  ) {}

  async ngOnInit() {
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

      this.activeAnalyses = active.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      this.archivedAnalyses = archived.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

    } catch (error: any) {
      console.error('Error loading analyses:', error);
      this.snackBar.open('Failed to load analyses', 'Dismiss', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  get currentAnalyses(): LibraryAnalysis[] {
    return this.currentTab === 'active' ? this.activeAnalyses : this.archivedAnalyses;
  }

  async selectAnalysis(analysis: LibraryAnalysis) {
    try {
      this.isLoading = true;
      this.selectedAnalysis = analysis;

      // Load parsed metadata
      this.parsedMetadata = await this.libraryService.getAnalysisMetadata(analysis.id);

    } catch (error: any) {
      console.error('Error loading analysis metadata:', error);
      this.snackBar.open('Failed to load analysis details', 'Dismiss', { duration: 3000 });
    } finally {
      this.isLoading = false;
    }
  }

  async archiveAnalysis(analysis: LibraryAnalysis) {
    try {
      await this.libraryService.archiveAnalysis(analysis.id);

      // Move from active to archived
      this.activeAnalyses = this.activeAnalyses.filter(a => a.id !== analysis.id);
      this.archivedAnalyses.unshift({ ...analysis, archived: true });

      // Clear selection if archived analysis was selected
      if (this.selectedAnalysis?.id === analysis.id) {
        this.selectedAnalysis = null;
        this.parsedMetadata = null;
      }

      this.snackBar.open('Analysis archived', 'Dismiss', { duration: 2000 });
    } catch (error: any) {
      console.error('Error archiving analysis:', error);
      this.snackBar.open('Failed to archive analysis', 'Dismiss', { duration: 3000 });
    }
  }

  async unarchiveAnalysis(analysis: LibraryAnalysis) {
    try {
      await this.libraryService.unarchiveAnalysis(analysis.id);

      // Move from archived to active
      this.archivedAnalyses = this.archivedAnalyses.filter(a => a.id !== analysis.id);
      this.activeAnalyses.unshift({ ...analysis, archived: false });

      this.snackBar.open('Analysis unarchived', 'Dismiss', { duration: 2000 });
    } catch (error: any) {
      console.error('Error unarchiving analysis:', error);
      this.snackBar.open('Failed to unarchive analysis', 'Dismiss', { duration: 3000 });
    }
  }

  async deleteAnalysis(analysis: LibraryAnalysis) {
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

      // Clear selection if deleted analysis was selected
      if (this.selectedAnalysis?.id === analysis.id) {
        this.selectedAnalysis = null;
        this.parsedMetadata = null;
      }

      this.snackBar.open('Analysis deleted successfully', 'Dismiss', { duration: 3000 });

    } catch (error: any) {
      console.error('Error deleting analysis:', error);
      this.snackBar.open('Failed to delete analysis', 'Dismiss', { duration: 3000 });
    }
  }

  async manageClips(analysis: LibraryAnalysis) {
    const { VideoPlayerComponent } = await import('../video-player/video-player.component');

    this.dialog.open(VideoPlayerComponent, {
      width: '100vw',
      height: '100vh',
      maxWidth: '100vw',
      maxHeight: '100vh',
      panelClass: 'fullscreen-dialog',
      data: { analysis }
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
      // Update the analysis in the local list
      const updatedAnalysis = await this.libraryService.getAnalysis(analysis.id);

      if (analysis.archived) {
        const index = this.archivedAnalyses.findIndex(a => a.id === analysis.id);
        if (index !== -1) {
          this.archivedAnalyses[index] = updatedAnalysis;
        }
      } else {
        const index = this.activeAnalyses.findIndex(a => a.id === analysis.id);
        if (index !== -1) {
          this.activeAnalyses[index] = updatedAnalysis;
        }
      }

      // Update selected analysis if it's the one we relinked
      if (this.selectedAnalysis?.id === analysis.id) {
        this.selectedAnalysis = updatedAnalysis;
      }

      this.snackBar.open('Video relinked successfully!', 'Dismiss', { duration: 3000 });
    }
  }

  async showInFolder(analysis: LibraryAnalysis) {
    try {
      await (window as any).electron?.showInFolder(analysis.video.currentPath);
    } catch (error) {
      this.snackBar.open('Failed to show file', 'Dismiss', { duration: 3000 });
    }
  }

  getCategoryIcon(category: string): string {
    const icons: {[key: string]: string} = {
      'violence': 'dangerous',
      'extremism': 'warning',
      'hate': 'block',
      'conspiracy': 'psychology',
      'shocking': 'report',
      'routine': 'schedule',
      // Legacy categories (for old reports)
      'controversy': 'warning',
      'claim': 'fact_check',
      'argument': 'forum',
      'emotional': 'sentiment_satisfied',
      'insight': 'lightbulb',
      'technical': 'engineering',
      'other': 'more_horiz'
    };
    return icons[category] || 'description';
  }

  getCategoryColor(category: string): string {
    // Use consistent color hash for dynamic categories
    if (!category) return '#757575';

    const colors = [
      '#ef4444', // red
      '#f97316', // orange
      '#eab308', // yellow
      '#22c55e', // green
      '#3b82f6', // blue
      '#a855f7', // purple
      '#ec4899', // pink
    ];

    // Simple hash to pick consistent color
    const hash = category.split('').reduce((acc, char) => {
      return char.charCodeAt(0) + ((acc << 5) - acc);
    }, 0);

    return colors[Math.abs(hash) % colors.length];
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  formatDuration(seconds?: number): string {
    if (!seconds) return 'Unknown';

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    if (mins < 60) {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return `${hours}:${remainingMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  onTabChange(index: number) {
    this.currentTab = index === 0 ? 'active' : 'archived';
    // Clear selection when switching tabs
    this.selectedAnalysis = null;
    this.parsedMetadata = null;
  }
}
