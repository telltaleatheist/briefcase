import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DatabaseStats } from '../../../services/database-library.service';

export interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

/**
 * LibraryHeaderComponent
 *
 * Header component for the library page with:
 * - Title and icon
 * - Library selector dropdown
 * - Library management button
 * - Action buttons (context-aware based on page mode)
 */
@Component({
  selector: 'app-library-header',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatSelectModule,
    MatFormFieldModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './library-header.component.html',
  styleUrls: ['./library-header.component.scss']
})
export class LibraryHeaderComponent {
  // Inputs
  @Input() libraries: ClipLibrary[] = [];
  @Input() selectedLibraryId: string = '';
  @Input() isLoadingLibraries: boolean = true;
  @Input() pageMode: 'library' | 'management' = 'library';
  @Input() stats: DatabaseStats | null = null;

  // Outputs
  @Output() libraryChange = new EventEmitter<string>();
  @Output() manageLibraries = new EventEmitter<void>();
  @Output() importVideos = new EventEmitter<void>();
  @Output() downloadFromUrl = new EventEmitter<void>();
  @Output() analytics = new EventEmitter<void>();
  @Output() backToLibrary = new EventEmitter<void>();

  /**
   * Handle library selection change
   */
  onLibraryChange(): void {
    this.libraryChange.emit(this.selectedLibraryId);
  }

  /**
   * Open manage libraries dialog
   */
  openManageLibraries(): void {
    this.manageLibraries.emit();
  }

  /**
   * Open import manager
   */
  openImportManager(): void {
    this.importVideos.emit();
  }

  /**
   * Open download from URL dialog
   */
  openDownloadFromUrl(): void {
    this.downloadFromUrl.emit();
  }

  /**
   * Open analytics dialog
   */
  openAnalytics(): void {
    this.analytics.emit();
  }

  /**
   * Navigate back to library view
   */
  navigateBackToLibrary(): void {
    this.backToLibrary.emit();
  }
}
