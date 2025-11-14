import { Component, Inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';
import { DuplicateHandlingDialogComponent, DuplicateHandlingResult } from './duplicate-handling-dialog.component';
import { timeout } from 'rxjs/operators';

interface ImportDialogData {
  filePaths: string[];
  suppressAutoClose?: boolean; // Don't auto-close on success (for mixed imports)
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
      Importing Videos
    </h2>

    <mat-dialog-content>
      <div class="import-status">
        <!-- Checking duplicates state -->
        <div *ngIf="checkingDuplicates" class="importing-state">
          <mat-spinner diameter="50"></mat-spinner>
          <p class="status-text">Checking for duplicates...</p>
          <p class="help-text">Scanning {{ data.filePaths.length }} file{{ data.filePaths.length !== 1 ? 's' : '' }}</p>
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        </div>

        <!-- Importing state -->
        <div *ngIf="!checkingDuplicates && importing" class="importing-state">
          <mat-spinner diameter="50"></mat-spinner>
          <p class="status-text">Importing {{ data.filePaths.length }} file{{ data.filePaths.length !== 1 ? 's' : '' }}...</p>
          <p class="help-text">This may take a moment while we process the files.</p>
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        </div>

        <!-- Success state -->
        <div *ngIf="!checkingDuplicates && !importing && importResult?.success" class="success-state">
          <mat-icon class="success-icon">check_circle</mat-icon>
          <p class="status-text">Successfully imported {{ importResult?.importedCount }} file{{ importResult?.importedCount !== 1 ? 's' : '' }}</p>

          <!-- Show skipped files if any -->
          <div *ngIf="importResult && importResult.skippedCount && importResult.skippedCount > 0" class="info-summary">
            <mat-icon class="info-icon">info</mat-icon>
            <p>{{ importResult.skippedCount }} file{{ importResult.skippedCount !== 1 ? 's' : '' }} skipped (duplicates)</p>
          </div>

          <!-- Show errors if any -->
          <div *ngIf="importResult && importResult.errorCount > 0" class="error-summary">
            <mat-icon class="warning-icon">warning</mat-icon>
            <p>{{ importResult.errorCount }} file{{ importResult.errorCount !== 1 ? 's' : '' }} could not be imported</p>
            <div class="error-list">
              <div *ngFor="let error of importResult.errors" class="error-item">
                {{ error }}
              </div>
            </div>
          </div>
        </div>

        <!-- Error state -->
        <div *ngIf="!importing && importResult && !importResult.success" class="error-state">
          <mat-icon class="error-icon">error</mat-icon>
          <p class="status-text">Import Failed</p>
          <p class="error-message">{{ importResult.error || 'An unknown error occurred' }}</p>
        </div>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button
        mat-raised-button
        color="primary"
        [mat-dialog-close]="importResult"
        [disabled]="importing && !forceEnableClose">
        {{ importing ? 'Importing...' : 'Close' }}
      </button>
      <button
        *ngIf="importing && forceEnableClose"
        mat-button
        [mat-dialog-close]="{ success: true, timeout: true }"
        style="margin-left: 8px;">
        Force Close
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 400px;
      min-height: 200px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .import-status {
      width: 100%;
      text-align: center;
    }

    .importing-state,
    .success-state,
    .error-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 24px;
    }

    .status-text {
      font-size: 16px;
      font-weight: 500;
      margin: 0;
      color: inherit;
    }

    .help-text {
      font-size: 14px;
      margin: 0;
      color: rgba(var(--text-color-rgb, 255, 255, 255), 0.7);
    }

    mat-progress-bar {
      width: 100%;
      margin-top: 8px;
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

    .warning-icon {
      font-size: 24px;
      width: 24px;
      height: 24px;
      color: #ff9800;
    }

    .info-icon {
      font-size: 24px;
      width: 24px;
      height: 24px;
      color: #2196f3;
    }

    .info-summary {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      padding: 16px;
      background: rgba(33, 150, 243, 0.15);
      border: 1px solid rgba(33, 150, 243, 0.3);
      border-radius: 4px;
      width: 100%;
    }

    .info-summary p {
      color: inherit;
      margin: 0;
    }

    .error-summary {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      padding: 16px;
      background: rgba(255, 152, 0, 0.15);
      border: 1px solid rgba(255, 152, 0, 0.3);
      border-radius: 4px;
      width: 100%;
    }

    .error-summary p {
      color: inherit;
      margin: 0;
    }

    .error-list {
      width: 100%;
      max-height: 150px;
      overflow-y: auto;
      margin-top: 8px;
    }

    .error-item {
      font-size: 12px;
      padding: 4px 0;
      border-top: 1px solid rgba(255, 152, 0, 0.2);
      color: inherit;
    }

    .error-message {
      font-size: 14px;
      color: #f44336;
      margin: 0;
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
export class ImportProgressDialogComponent implements OnInit {
  importing = true;
  importResult: ImportResult | null = null;
  checkingDuplicates = true;
  forceEnableClose = false;

  constructor(
    private dialogRef: MatDialogRef<ImportProgressDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: ImportDialogData,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private dialog: MatDialog,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    // Enable force close after 30 seconds in case of timeout
    setTimeout(() => {
      this.forceEnableClose = true;
    }, 30000);

    await this.checkDuplicatesAndImport();
  }

  private async checkDuplicatesAndImport() {
    try {
      // First, check for duplicates
      const checkUrl = await this.backendUrlService.getApiUrl('/database/check-duplicates');
      const checkResponse = await this.http
        .post<{
          success: boolean;
          duplicates: Array<{ path: string; filename: string; existingVideo: any }>;
          unique: string[];
          duplicateCount: number;
          uniqueCount: number;
        }>(checkUrl, {
          videoPaths: this.data.filePaths
        })
        .toPromise();

      this.checkingDuplicates = false;
      this.cdr.detectChanges();

      if (!checkResponse?.success) {
        throw new Error('Failed to check for duplicates');
      }

      let duplicateHandling: { [key: string]: 'skip' | 'replace' | 'keep-both' } = {};

      // If duplicates found, show duplicate handling dialog
      if (checkResponse.duplicateCount > 0) {
        // Close this dialog temporarily
        const dialogResult = await this.dialog.open(DuplicateHandlingDialogComponent, {
          width: '600px',
          maxHeight: '80vh',
          disableClose: true,
          data: {
            duplicates: checkResponse.duplicates,
            uniqueCount: checkResponse.uniqueCount
          }
        }).afterClosed().toPromise() as DuplicateHandlingResult;

        if (!dialogResult || dialogResult.action === 'cancel') {
          // User cancelled - close the import dialog
          this.dialogRef.close({ success: false, cancelled: true });
          return;
        }

        duplicateHandling = dialogResult.handling;
      }

      // Now proceed with import
      await this.startImport(duplicateHandling);
    } catch (error: any) {
      console.error('Duplicate check error:', error);
      this.importResult = {
        success: false,
        imported: [],
        importedCount: 0,
        errors: [],
        errorCount: 0,
        error: error.error?.message || error.message || 'Failed to check for duplicates'
      };
      this.importing = false;
      this.checkingDuplicates = false;
      this.cdr.detectChanges();
    }
  }

  private async startImport(duplicateHandling?: { [key: string]: 'skip' | 'replace' | 'keep-both' }) {
    try {
      const url = await this.backendUrlService.getApiUrl('/database/import');

      // Use a longer timeout for large imports (10 minutes)
      const timeoutMs = 600000; // 10 minutes

      console.log(`[ImportProgressDialog] Starting import of ${this.data.filePaths.length} files...`);

      const response = await this.http
        .post<ImportResult>(url, {
          videoPaths: this.data.filePaths,
          duplicateHandling
        })
        .pipe(
          timeout(timeoutMs)
        )
        .toPromise();

      console.log('[ImportProgressDialog] Import response received:', response);

      // Ensure we have a valid result object
      this.importResult = response || {
        success: false,
        imported: [],
        importedCount: 0,
        errors: ['No response from server'],
        errorCount: 1
      };
      this.importing = false;
      this.checkingDuplicates = false;

      // Force Angular to detect changes and update the UI
      this.cdr.detectChanges();

      console.log('[ImportProgressDialog] Final state - importing:', this.importing, 'result:', this.importResult);

      // Auto-close after 1 second if successful
      if (this.importResult.success && !this.data.suppressAutoClose) {
        console.log('[ImportProgressDialog] Import successful, auto-closing in 1 second...');
        setTimeout(() => {
          console.log('[ImportProgressDialog] Closing dialog now');
          this.dialogRef.close(this.importResult);
        }, 1000);
      } else if (this.data.suppressAutoClose) {
        // For mixed imports, close immediately on success so the next dialog can show
        console.log('[ImportProgressDialog] Closing dialog immediately (suppressAutoClose)');
        this.dialogRef.close(this.importResult);
      } else {
        console.log('[ImportProgressDialog] Import completed but not auto-closing (success:', this.importResult.success, ')');
      }
    } catch (error: any) {
      console.error('[ImportProgressDialog] Import error:', error);
      this.importResult = {
        success: false,
        imported: [],
        importedCount: 0,
        errors: [],
        errorCount: 0,
        error: error.error?.message || error.message || 'Failed to import videos'
      };
      this.importing = false;
      this.checkingDuplicates = false;
      this.cdr.detectChanges();
    }
  }
}
