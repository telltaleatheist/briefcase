import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { RelinkingService, RelinkStatus, RelinkResult } from '../../services/relinking.service';

@Component({
  selector: 'app-relinking-tool',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatSnackBarModule,
    MatCheckboxModule,
  ],
  templateUrl: './relinking-tool.component.html',
  styleUrls: ['./relinking-tool.component.scss']
})
export class RelinkingToolComponent implements OnInit {
  status: RelinkStatus | null = null;
  targetPath: string = '';
  updateLibraryPath: boolean = true;
  copyMissingFiles: boolean = true; // Copy files that don't exist in target

  isLoading = false;
  isRelinking = false;

  previewResult: any = null;
  relinkResult: any = null;

  constructor(
    private relinkingService: RelinkingService,
    private snackBar: MatSnackBar
  ) {}

  ngOnInit(): void {
    this.loadStatus();
  }

  /**
   * Load current status
   */
  loadStatus(): void {
    this.relinkingService.getStatus().subscribe({
      next: (status) => {
        this.status = status;

        // Pre-fill target path with current clips folder (if available)
        if (status.activeLibrary) {
          this.targetPath = status.activeLibrary.clipsFolderPath;
        }
      },
      error: (err) => {
        this.showError('Failed to load status: ' + err.message);
      }
    });
  }

  /**
   * Run preview
   */
  runPreview(): void {
    if (!this.targetPath) {
      this.showError('Please enter a target path');
      return;
    }

    this.isLoading = true;
    this.previewResult = null;

    this.relinkingService.preview(this.targetPath, this.copyMissingFiles).subscribe({
      next: (result) => {
        this.isLoading = false;
        this.previewResult = result;
        this.showSuccess('Preview completed!');
      },
      error: (err) => {
        this.isLoading = false;
        this.showError('Preview failed: ' + (err.error?.message || err.message));
      }
    });
  }

  /**
   * Run actual relinking
   */
  runRelink(): void {
    if (!this.targetPath) {
      this.showError('Please enter a target path');
      return;
    }

    const confirmed = confirm(
      'This will update all file paths in the database.\n\n' +
      'A backup will be created automatically.\n\n' +
      'Continue?'
    );

    if (!confirmed) {
      return;
    }

    this.isRelinking = true;
    this.relinkResult = null;

    this.relinkingService.relink(this.targetPath, this.updateLibraryPath, this.copyMissingFiles).subscribe({
      next: (result) => {
        this.isRelinking = false;
        this.relinkResult = result;

        if (result.success) {
          this.showSuccess('Relinking completed successfully!');
        } else {
          this.showError('Relinking completed with errors.');
        }
      },
      error: (err) => {
        this.isRelinking = false;
        this.showError('Relinking failed: ' + (err.error?.message || err.message));
      }
    });
  }

  /**
   * Show success message
   */
  showSuccess(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 5000,
      panelClass: ['success-snackbar']
    });
  }

  /**
   * Show error message
   */
  showError(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 10000,
      panelClass: ['error-snackbar']
    });
  }

  /**
   * Format count for display
   */
  formatCount(count: number): string {
    return count.toLocaleString();
  }
}
