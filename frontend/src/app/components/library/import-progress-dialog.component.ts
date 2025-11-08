import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogRef, MatDialogModule } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';

interface ImportDialogData {
  filePaths: string[];
}

interface ImportResult {
  success: boolean;
  imported: string[];
  importedCount: number;
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
        <!-- Importing state -->
        <div *ngIf="importing" class="importing-state">
          <mat-spinner diameter="50"></mat-spinner>
          <p class="status-text">Importing {{ data.filePaths.length }} video{{ data.filePaths.length !== 1 ? 's' : '' }}...</p>
          <p class="help-text">This may take a moment while we process the files.</p>
          <mat-progress-bar mode="indeterminate"></mat-progress-bar>
        </div>

        <!-- Success state -->
        <div *ngIf="!importing && importResult?.success" class="success-state">
          <mat-icon class="success-icon">check_circle</mat-icon>
          <p class="status-text">Successfully imported {{ importResult?.importedCount }} video{{ importResult?.importedCount !== 1 ? 's' : '' }}</p>

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
        [disabled]="importing">
        {{ importing ? 'Importing...' : 'Close' }}
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

  constructor(
    private dialogRef: MatDialogRef<ImportProgressDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: ImportDialogData,
    private http: HttpClient,
    private backendUrlService: BackendUrlService
  ) {}

  async ngOnInit() {
    await this.startImport();
  }

  private async startImport() {
    try {
      const url = await this.backendUrlService.getApiUrl('/database/import');
      const response = await this.http
        .post<ImportResult>(url, {
          videoPaths: this.data.filePaths
        })
        .toPromise();

      this.importResult = response || null;
      this.importing = false;

      // Auto-close after 3 seconds if successful and no errors
      if (response?.success && response.errorCount === 0) {
        setTimeout(() => {
          this.dialogRef.close(this.importResult);
        }, 2000);
      }
    } catch (error: any) {
      console.error('Import error:', error);
      this.importResult = {
        success: false,
        imported: [],
        importedCount: 0,
        errors: [],
        errorCount: 0,
        error: error.error?.message || error.message || 'Failed to import videos'
      };
      this.importing = false;
    }
  }
}
