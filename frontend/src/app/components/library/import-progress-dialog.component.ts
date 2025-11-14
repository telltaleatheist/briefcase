import { Component, Inject, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';
import { SocketService } from '../../services/socket.service';
import { Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';

interface ImportDialogData {
  filePaths: string[];
  suppressAutoClose?: boolean;
}

interface ImportResult {
  success: boolean;
  imported: string[];
  importedCount: number;
  skipped?: string[];
  skippedCount?: number;
  errors: string[];
  errorCount: number;
  error?: string;
}

type ImportState = 'importing' | 'success' | 'error';

@Component({
  selector: 'app-import-progress-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatButtonModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>cloud_upload</mat-icon>
      {{ getTitle() }}
    </h2>

    <mat-dialog-content>
      <div class="import-status">
        <!-- Importing -->
        <div *ngIf="state === 'importing'" class="status-container">
          <mat-spinner diameter="50"></mat-spinner>
          <p class="status-text">{{ getProgressText() }}</p>
          <p class="help-text">Creating database entries and copying files</p>
          <mat-progress-bar
            [mode]="progressPercent > 0 ? 'determinate' : 'indeterminate'"
            [value]="progressPercent"></mat-progress-bar>
          <p *ngIf="progressPercent > 0" class="progress-details">
            {{ progressImported }} imported, {{ progressSkipped }} skipped, {{ progressErrors }} errors
          </p>
        </div>

        <!-- Success -->
        <div *ngIf="state === 'success'" class="status-container">
          <mat-icon class="success-icon">check_circle</mat-icon>
          <p class="status-text">Import Complete!</p>
          <p class="help-text">{{ result?.importedCount || 0 }} file{{ (result?.importedCount || 0) !== 1 ? 's' : '' }} imported</p>

          <div *ngIf="result && result.skippedCount && result.skippedCount > 0" class="info-box">
            <mat-icon>info</mat-icon>
            <span>{{ result.skippedCount }} duplicate{{ result.skippedCount !== 1 ? 's' : '' }} skipped</span>
          </div>

          <div *ngIf="result && result.errorCount && result.errorCount > 0" class="warning-box">
            <mat-icon>warning</mat-icon>
            <span>{{ result.errorCount }} error{{ result.errorCount !== 1 ? 's' : '' }}</span>
          </div>
        </div>

        <!-- Error -->
        <div *ngIf="state === 'error'" class="status-container">
          <mat-icon class="error-icon">error</mat-icon>
          <p class="status-text">Import Failed</p>
          <p class="error-message">{{ errorMessage }}</p>
        </div>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button
        mat-raised-button
        color="primary"
        [disabled]="state === 'importing'"
        (click)="close()">
        {{ state === 'importing' ? 'Importing...' : 'Close' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 400px;
      min-height: 200px;
      padding: 24px;
    }

    .import-status {
      width: 100%;
    }

    .status-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 24px 0;
    }

    .status-text {
      font-size: 18px;
      font-weight: 500;
      margin: 0;
    }

    .help-text {
      font-size: 14px;
      margin: 0;
      opacity: 0.7;
    }

    .progress-details {
      font-size: 13px;
      margin: 8px 0 0 0;
      opacity: 0.8;
    }

    .error-message {
      font-size: 14px;
      color: #f44336;
      margin: 0;
      text-align: center;
    }

    mat-progress-bar {
      width: 100%;
    }

    .success-icon {
      font-size: 64px;
      width: 64px;
      height: 64px;
      color: #4caf50;
    }

    .error-icon {
      font-size: 64px;
      width: 64px;
      height: 64px;
      color: #f44336;
    }

    .info-box,
    .warning-box {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 14px;
      width: 100%;
      box-sizing: border-box;
    }

    .info-box {
      background: rgba(33, 150, 243, 0.1);
      color: #2196f3;
      border: 1px solid rgba(33, 150, 243, 0.3);
    }

    .warning-box {
      background: rgba(255, 152, 0, 0.1);
      color: #ff9800;
      border: 1px solid rgba(255, 152, 0, 0.3);
    }

    .info-box mat-icon,
    .warning-box mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }

    h2 {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    mat-dialog-actions {
      padding: 16px 24px;
    }
  `]
})
export class ImportProgressDialogComponent implements OnInit, OnDestroy {
  state: ImportState = 'importing';
  result: ImportResult | null = null;
  errorMessage = '';
  private autoCloseTimer: any = null;
  private importCompleteSubscription?: Subscription;
  private importProgressSubscription?: Subscription;

  // Progress tracking
  progressCurrent = 0;
  progressTotal = 0;
  progressImported = 0;
  progressSkipped = 0;
  progressErrors = 0;
  progressPercent = 0;

  constructor(
    private dialogRef: MatDialogRef<ImportProgressDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: ImportDialogData,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private socketService: SocketService,
    private cdr: ChangeDetectorRef
  ) {
    // Prevent dialog from closing by clicking backdrop or ESC during import
    dialogRef.disableClose = true;
  }

  ngOnInit() {
    // Listen for import progress WebSocket events (for large batches)
    this.importProgressSubscription = this.socketService.onImportProgress().subscribe(event => {
      console.log('[ImportDialog] Import progress event:', event);

      this.progressCurrent = event.current;
      this.progressTotal = event.total;
      this.progressImported = event.imported;
      this.progressSkipped = event.skipped;
      this.progressErrors = event.errors;
      this.progressPercent = event.total > 0 ? (event.current / event.total) * 100 : 0;

      this.cdr.detectChanges();
    });

    // Listen for import complete WebSocket event
    this.importCompleteSubscription = this.socketService.onImportComplete().subscribe(event => {
      console.log('[ImportDialog] Import complete event received:', event);

      this.result = {
        success: true,
        imported: [], // Not needed for display
        importedCount: event.importedCount,
        skipped: [],
        skippedCount: event.skippedCount,
        errors: [],
        errorCount: event.errorCount
      };

      this.state = 'success';
      this.cdr.detectChanges();

      // Auto-close after 1 second if not suppressed
      if (!this.data.suppressAutoClose) {
        this.autoCloseTimer = setTimeout(() => {
          this.close();
        }, 1000);
      }
    });

    // Trigger the import (fire and forget - we'll get WebSocket events when done)
    this.startImport();
  }

  ngOnDestroy() {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
    }
    if (this.importCompleteSubscription) {
      this.importCompleteSubscription.unsubscribe();
    }
    if (this.importProgressSubscription) {
      this.importProgressSubscription.unsubscribe();
    }
  }

  private async startImport() {
    try {
      const url = await this.backendUrlService.getApiUrl('/database/import');

      // Fire and forget - we'll get WebSocket event when done
      this.http.post(url, {
        videoPaths: this.data.filePaths
      }).subscribe({
        error: (error) => {
          console.error('[ImportDialog] Import request failed:', error);
          this.state = 'error';
          this.errorMessage = 'Failed to start import';
          this.cdr.detectChanges();
        }
      });
    } catch (error: any) {
      console.error('[ImportDialog] Failed to start import:', error);
      this.state = 'error';
      this.errorMessage = error.message || 'Failed to start import';
      this.cdr.detectChanges();
    }
  }

  getTitle(): string {
    switch (this.state) {
      case 'importing': return 'Importing Files';
      case 'success': return 'Import Complete';
      case 'error': return 'Import Failed';
    }
  }

  getProgressText(): string {
    if (this.progressTotal > 0 && this.progressCurrent > 0) {
      return `Importing ${this.progressCurrent} of ${this.progressTotal} files...`;
    }
    return `Importing ${this.data.filePaths.length} file${this.data.filePaths.length !== 1 ? 's' : ''}...`;
  }

  close() {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
    }
    this.dialogRef.close(this.result);
  }
}
