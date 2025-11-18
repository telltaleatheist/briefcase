import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';

@Component({
  selector: 'app-results-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatMenuModule
  ],
  template: `
    <div class="results-header" *ngIf="totalResults > 0 || showWhenEmpty">
      <div class="results-count">
        <div class="selection-buttons">
          <!-- Selection buttons -->
          <button mat-stroked-button
                  *ngIf="totalResults > 0"
                  (click)="selectAllClick.emit()"
                  [color]="isAllSelected ? 'primary' : undefined"
                  matTooltip="Select all visible videos (Cmd/Ctrl+A)">
            <mat-icon>select_all</mat-icon>
            All
          </button>
          <button mat-stroked-button
                  *ngIf="totalResults > 0"
                  (click)="selectMissingTranscriptClick.emit()"
                  [color]="isMissingTranscriptSelected ? 'primary' : undefined"
                  matTooltip="Select all videos missing transcription">
            <mat-icon>subtitles_off</mat-icon>
            No Transcript
          </button>
          <button mat-stroked-button
                  *ngIf="totalResults > 0"
                  (click)="selectMissingAnalysisClick.emit()"
                  [color]="isMissingAnalysisSelected ? 'primary' : undefined"
                  matTooltip="Select all videos missing AI analysis">
            <mat-icon>psychology</mat-icon>
            No Analysis
          </button>

          <!-- Section collapse/expand buttons -->
          <button mat-stroked-button
                  *ngIf="totalResults > 0 && !isSearching"
                  (click)="collapseAllClick.emit()"
                  matTooltip="Collapse all week sections">
            <mat-icon>unfold_less</mat-icon>
            Collapse All
          </button>
          <button mat-stroked-button
                  *ngIf="totalResults > 0 && !isSearching"
                  (click)="expandAllClick.emit()"
                  matTooltip="Expand all week sections">
            <mat-icon>unfold_more</mat-icon>
            Expand All
          </button>

          <!-- File type filter button -->
          <button mat-stroked-button
                  [matMenuTriggerFor]="fileTypeMenu"
                  matTooltip="Filter by file type">
            <mat-icon>filter_list</mat-icon>
            File Type
          </button>
        </div>
        <span class="count-text">
          Showing {{ totalResults }} of {{ totalVideos }} videos
          <span *ngIf="selectedCount > 0" class="selected-count">
            ({{ selectedCount }} selected)
          </span>
        </span>
      </div>
      <div class="selection-actions">
        <button mat-raised-button
                color="primary"
                [disabled]="selectedCount === 0"
                (click)="analyzeClick.emit()"
                matTooltip="Analyze or transcribe selected videos">
          <mat-icon>psychology</mat-icon>
          Analyze ({{ selectedCount }})
        </button>
        <button mat-raised-button
                color="accent"
                [disabled]="selectedCount !== 1"
                (click)="openEditorClick.emit()"
                matTooltip="Open video editor (requires exactly one video selected)">
          <mat-icon>video_settings</mat-icon>
          Video Editor
        </button>
        <button mat-stroked-button
                [disabled]="selectedCount !== 1"
                (click)="viewDetailsClick.emit()"
                matTooltip="View details for selected video">
          <mat-icon>info</mat-icon>
          View Details
        </button>
      </div>
    </div>

    <!-- File type menu -->
    <mat-menu #fileTypeMenu="matMenu">
      <ng-content select="[fileTypeMenuItems]"></ng-content>
    </mat-menu>
  `,
  styleUrl: './results-toolbar.component.scss'
})
export class ResultsToolbarComponent {
  @Input() totalResults = 0;
  @Input() totalVideos = 0;
  @Input() selectedCount = 0;
  @Input() isAllSelected = false;
  @Input() isMissingTranscriptSelected = false;
  @Input() isMissingAnalysisSelected = false;
  @Input() isSearching = false;
  @Input() showWhenEmpty = false;

  @Output() selectAllClick = new EventEmitter<void>();
  @Output() selectMissingTranscriptClick = new EventEmitter<void>();
  @Output() selectMissingAnalysisClick = new EventEmitter<void>();
  @Output() collapseAllClick = new EventEmitter<void>();
  @Output() expandAllClick = new EventEmitter<void>();
  @Output() analyzeClick = new EventEmitter<void>();
  @Output() openEditorClick = new EventEmitter<void>();
  @Output() viewDetailsClick = new EventEmitter<void>();
}
