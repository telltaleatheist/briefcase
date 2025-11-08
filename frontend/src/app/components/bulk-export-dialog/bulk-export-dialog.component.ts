import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { DatabaseAnalysisSection } from '../../services/database-library.service';

interface CategoryGroup {
  category: string;
  label: string;
  color: string;
  sections: DatabaseAnalysisSection[];
  selected: boolean;
}

@Component({
  selector: 'app-bulk-export-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatCheckboxModule,
    MatProgressBarModule
  ],
  template: `
    <div class="bulk-export-dialog">
      <h2 mat-dialog-title>
        <mat-icon>video_library</mat-icon>
        Export Clips by Category
      </h2>

      <mat-dialog-content>
        <p class="dialog-description">
          Select which categories you want to export as video clips.
          Each section will be saved as a separate clip file.
        </p>

        <div class="output-location" *ngIf="!isExporting && !exportComplete">
          <label class="location-label">
            <mat-icon>folder</mat-icon>
            Output Location:
          </label>
          <div class="location-value">
            {{ outputDirectory || 'Default (Library Folder/clips)' }}
          </div>
          <button mat-stroked-button (click)="chooseOutputDirectory()">
            <mat-icon>folder_open</mat-icon>
            Choose Folder
          </button>
        </div>

        <div class="category-groups" *ngIf="!isExporting">
          <div *ngFor="let group of categoryGroups" class="category-group">
            <label class="category-checkbox">
              <input
                type="checkbox"
                [(ngModel)]="group.selected">
              <span class="category-indicator" [style.background-color]="group.color"></span>
              <span class="category-label">{{ group.label }}</span>
              <span class="section-count">({{ group.sections.length }} sections)</span>
            </label>
          </div>
        </div>

        <div *ngIf="isExporting" class="export-progress">
          <p class="progress-text">Exporting clip {{ currentClip }} of {{ totalClips }}...</p>
          <mat-progress-bar mode="determinate" [value]="exportProgress"></mat-progress-bar>
          <p class="progress-detail" *ngIf="currentClipName">{{ currentClipName }}</p>
        </div>

        <div *ngIf="exportComplete" class="export-complete">
          <mat-icon class="success-icon">check_circle</mat-icon>
          <h3>Export Complete!</h3>
          <p>Successfully exported {{ successCount }} clips</p>
          <p *ngIf="failedCount > 0" class="error-text">Failed to export {{ failedCount }} clips</p>
        </div>
      </mat-dialog-content>

      <mat-dialog-actions align="end">
        <button mat-button (click)="onCancel()" [disabled]="isExporting">
          <mat-icon>close</mat-icon>
          {{ exportComplete ? 'Close' : 'Cancel' }}
        </button>
        <button mat-raised-button
                color="primary"
                (click)="onExport()"
                [disabled]="!hasSelection() || isExporting || exportComplete">
          <mat-icon>{{ isExporting ? 'hourglass_empty' : 'download' }}</mat-icon>
          {{ isExporting ? 'Exporting...' : 'Export Clips' }}
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .bulk-export-dialog {
      min-width: 500px;

      h2 {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--primary-orange);
        margin: 0;

        mat-icon {
          color: var(--primary-orange);
        }
      }
    }

    mat-dialog-content {
      padding: 1.5rem 0;
      min-height: 200px;
      max-height: 600px;
    }

    .output-location {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem;
      background-color: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      margin-bottom: 1.5rem;

      .location-label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.9rem;
        font-weight: 500;
        color: var(--text-secondary);
        white-space: nowrap;

        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
        }
      }

      .location-value {
        flex: 1;
        font-size: 0.85rem;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      button {
        flex-shrink: 0;
      }
    }

    .dialog-description {
      font-size: 0.95rem;
      color: var(--text-secondary);
      margin: 0 0 1.5rem 0;
    }

    .category-groups {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .category-group {
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 0.75rem;
      transition: background-color 0.2s;

      &:hover {
        background-color: var(--bg-secondary);
      }
    }

    .category-checkbox {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      cursor: pointer;
      user-select: none;

      input[type="checkbox"] {
        margin: 0;
        cursor: pointer;
        width: 18px;
        height: 18px;
        accent-color: var(--primary-orange);
      }

      .category-indicator {
        width: 14px;
        height: 14px;
        border-radius: 3px;
        flex-shrink: 0;
      }

      .category-label {
        font-size: 1rem;
        font-weight: 500;
        color: var(--text-primary);
        flex: 1;
      }

      .section-count {
        font-size: 0.85rem;
        color: var(--text-secondary);
      }
    }

    .export-progress {
      padding: 2rem;
      text-align: center;

      .progress-text {
        font-size: 1rem;
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 1rem;
      }

      mat-progress-bar {
        margin: 1rem 0;
      }

      .progress-detail {
        font-size: 0.85rem;
        color: var(--text-secondary);
        margin-top: 0.5rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .export-complete {
      padding: 2rem;
      text-align: center;

      .success-icon {
        font-size: 64px;
        width: 64px;
        height: 64px;
        color: #22c55e;
        margin-bottom: 1rem;
      }

      h3 {
        color: var(--text-primary);
        margin: 0 0 0.5rem 0;
      }

      p {
        color: var(--text-secondary);
        margin: 0.25rem 0;
      }

      .error-text {
        color: #ef4444;
        font-weight: 500;
      }
    }

    mat-dialog-actions {
      padding: 1rem 0 0 0;
      margin: 0;

      button {
        mat-icon {
          margin-right: 0.25rem;
        }
      }
    }
  `]
})
export class BulkExportDialogComponent implements OnInit {
  categoryGroups: CategoryGroup[] = [];
  isExporting = false;
  exportComplete = false;
  currentClip = 0;
  totalClips = 0;
  exportProgress = 0;
  currentClipName = '';
  successCount = 0;
  failedCount = 0;
  outputDirectory: string | null = null;

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: {
      videoId: string;
      videoPath: string;
      sections: DatabaseAnalysisSection[];
    },
    private dialogRef: MatDialogRef<BulkExportDialogComponent>,
    private http: HttpClient,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService
  ) {}

  ngOnInit() {
    this.groupSectionsByCategory();
  }

  groupSectionsByCategory() {
    const categoryMap = new Map<string, DatabaseAnalysisSection[]>();

    // Group sections by category
    this.data.sections.forEach(section => {
      const category = section.category?.toLowerCase() || 'other';
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(section);
    });

    // Define category info
    const categoryInfo: { [key: string]: { label: string; color: string } } = {
      'routine': { label: 'Routine', color: '#a855f7' },
      'extremism': { label: 'Extremism', color: '#ef4444' },
      'hate': { label: 'Hate', color: '#f97316' },
      'violence': { label: 'Violence', color: '#dc2626' },
      'conspiracy': { label: 'Conspiracy', color: '#eab308' },
      'misinformation': { label: 'Misinformation', color: '#f59e0b' },
      'interesting': { label: 'Interesting', color: '#3b82f6' },
      'notable': { label: 'Notable', color: '#06b6d4' },
      'important': { label: 'Important', color: '#10b981' },
      'controversial': { label: 'Controversial', color: '#ec4899' },
      'custom': { label: 'Custom Markers', color: '#22c55e' },
    };

    // Create category groups
    this.categoryGroups = Array.from(categoryMap.entries()).map(([category, sections]) => {
      const info = categoryInfo[category] || {
        label: category.charAt(0).toUpperCase() + category.slice(1),
        color: '#757575'
      };

      return {
        category,
        label: info.label,
        color: info.color,
        sections,
        selected: false
      };
    });

    // Sort by section count (descending)
    this.categoryGroups.sort((a, b) => b.sections.length - a.sections.length);
  }

  hasSelection(): boolean {
    return this.categoryGroups.some(g => g.selected);
  }

  async chooseOutputDirectory() {
    // Use Electron dialog if available
    const electron = (window as any).electron;
    if (electron && electron.dialog) {
      try {
        const result = await electron.dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose Output Folder for Clips'
        });

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          this.outputDirectory = result.filePaths[0];
        }
      } catch (error) {
        console.error('Failed to open directory picker:', error);
        this.notificationService.error('Error', 'Failed to open directory picker');
      }
    } else {
      this.notificationService.warning(
        'Not Available',
        'Directory picker is only available in the desktop app'
      );
    }
  }

  async onExport() {
    const selectedSections = this.categoryGroups
      .filter(g => g.selected)
      .flatMap(g => g.sections);

    if (selectedSections.length === 0) {
      return;
    }

    this.isExporting = true;
    this.totalClips = selectedSections.length;
    this.currentClip = 0;
    this.successCount = 0;
    this.failedCount = 0;

    for (const section of selectedSections) {
      this.currentClip++;
      this.currentClipName = section.title || section.description || 'Unnamed section';
      this.exportProgress = (this.currentClip / this.totalClips) * 100;

      try {
        await this.exportSection(section);
        this.successCount++;
      } catch (error) {
        console.error('Failed to export section:', error);
        this.failedCount++;
      }
    }

    this.isExporting = false;
    this.exportComplete = true;
  }

  private async exportSection(section: DatabaseAnalysisSection): Promise<void> {
    const url = await this.backendUrlService.getApiUrl('/library/extract-clip');

    await firstValueFrom(
      this.http.post(url, {
        videoPath: this.data.videoPath,
        startTime: section.start_seconds,
        endTime: section.end_seconds,
        category: section.category,
        title: section.title || section.description,
        customDirectory: this.outputDirectory || undefined,
      })
    );
  }

  onCancel(): void {
    this.dialogRef.close({ exported: this.exportComplete });
  }
}
