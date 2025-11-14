import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { HttpClient } from '@angular/common/http';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';

interface SelectedFile {
  name: string;
  path: string;
}

@Component({
  selector: 'app-import-manager-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatListModule,
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>file_download</mat-icon>
      Import Videos
    </h2>

    <mat-dialog-content>
      <div class="instruction">
        <p>Select video files from your computer to import into the library.</p>
      </div>

      <div class="file-selector">
        <button mat-raised-button color="primary" (click)="selectFiles()" [disabled]="importing">
          <mat-icon>folder_open</mat-icon>
          Choose Video Files
        </button>
      </div>

      <div *ngIf="selectedFiles.length > 0" class="selected-files">
        <h3>Selected Files ({{ selectedFiles.length }})</h3>
        <mat-list>
          <mat-list-item *ngFor="let file of selectedFiles">
            <mat-icon matListItemIcon>movie</mat-icon>
            <div matListItemTitle>{{ file.name }}</div>
            <div matListItemLine class="file-path">{{ file.path }}</div>
            <button mat-icon-button matListItemMeta (click)="removeFile(file)" [disabled]="importing">
              <mat-icon>close</mat-icon>
            </button>
          </mat-list-item>
        </mat-list>
      </div>

      <div *ngIf="importing" class="import-progress">
        <mat-spinner diameter="30"></mat-spinner>
        <p>Importing {{ selectedFiles.length }} videos...</p>
      </div>

      <div *ngIf="importResult" class="import-result">
        <div class="success" *ngIf="importResult.importedCount > 0">
          <mat-icon>check_circle</mat-icon>
          <span>Successfully imported {{ importResult.importedCount }} videos</span>
        </div>
        <div class="errors" *ngIf="importResult.errorCount > 0">
          <mat-icon>error</mat-icon>
          <span>{{ importResult.errorCount }} errors</span>
          <div class="error-list">
            <div *ngFor="let error of importResult.errors" class="error-item">
              {{ error }}
            </div>
          </div>
        </div>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">
        {{ importResult ? 'Close' : 'Cancel' }}
      </button>
      <button
        mat-raised-button
        color="primary"
        (click)="importFiles()"
        [disabled]="selectedFiles.length === 0 || importing || !!importResult">
        <mat-icon>download</mat-icon>
        Import {{ selectedFiles.length }} Video{{ selectedFiles.length !== 1 ? 's' : '' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 600px;
      max-width: 800px;
      min-height: 300px;
      max-height: 70vh;
      overflow-y: auto;
    }

    .instruction {
      padding: 16px;
      background: var(--mdc-theme-surface, #fafafa);
      border-radius: 4px;
      margin-bottom: 16px;

      p {
        margin: 0;
        color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
      }
    }

    .file-selector {
      display: flex;
      justify-content: center;
      padding: 24px 0;
    }

    .selected-files {
      margin-top: 16px;

      h3 {
        margin: 0 0 8px 0;
        font-size: 14px;
        font-weight: 500;
        color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
      }

      mat-list {
        max-height: 300px;
        overflow-y: auto;
      }

      .file-path {
        font-size: 12px;
        color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .import-progress {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px;
      background: var(--mdc-theme-surface, #fafafa);
      border-radius: 4px;
      margin-top: 16px;
    }

    .import-result {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 16px;

      .success, .errors {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px;
        border-radius: 4px;
      }

      .success {
        background: #e8f5e9;
        color: #2e7d32;

        mat-icon {
          color: #4caf50;
        }
      }

      .errors {
        background: #ffebee;
        color: #c62828;
        flex-direction: column;
        align-items: flex-start;

        mat-icon {
          color: #f44336;
        }

        .error-list {
          margin-top: 8px;
          width: 100%;

          .error-item {
            font-size: 12px;
            padding: 4px 0;
            border-top: 1px solid rgba(198, 40, 40, 0.2);
          }
        }
      }
    }

    mat-dialog-actions {
      button {
        margin-left: 8px;
      }
    }

    h2 {
      display: flex;
      align-items: center;
      gap: 12px;
    }
  `],
})
export class ImportManagerDialogComponent {
  selectedFiles: SelectedFile[] = [];
  importing = false;
  importResult: any = null;

  constructor(
    private dialogRef: MatDialogRef<ImportManagerDialogComponent>,
    private http: HttpClient,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService
  ) {}

  async selectFiles() {
    // Use Electron's dialog API through IPC
    const electron = (window as any).electron;
    if (!electron || !electron.ipcRenderer) {
      this.notificationService.error('Not Available', 'File picker only works in Electron app');
      return;
    }

    try {
      const result = await electron.ipcRenderer.invoke('dialog:openFiles', {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Videos', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv'] }
        ]
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        this.selectedFiles = result.filePaths.map((path: string) => ({
          name: path.split('/').pop() || path,
          path: path
        }));
      }
    } catch (error) {
      console.error('Error selecting files:', error);
      this.notificationService.error('Selection Failed', 'Could not open file picker');
    }
  }

  removeFile(file: SelectedFile) {
    this.selectedFiles = this.selectedFiles.filter(f => f.path !== file.path);
  }

  async importFiles() {
    if (this.selectedFiles.length === 0) return;

    this.importing = true;
    this.importResult = null;

    try {
      const videoPaths = this.selectedFiles.map(f => f.path);
      const url = await this.backendUrlService.getApiUrl('/database/import');
      const response = await this.http
        .post<any>(url, { videoPaths })
        .toPromise();

      if (response.success) {
        this.importResult = response;
        this.notificationService.success(
          'Import Complete',
          `Successfully imported ${response.importedCount} videos`,
        );

        // Close dialog after short delay to show success message
        setTimeout(() => {
          if (this.dialogRef) {
            this.dialogRef.close(true); // true = refresh library
          }
        }, 1500);
      } else {
        this.notificationService.error('Import Failed', response.error || 'Unknown error');
        this.importResult = { success: false, errorCount: 1, errors: [response.error || 'Unknown error'] };
      }
    } catch (error: any) {
      console.error('Error importing videos:', error);
      this.notificationService.error('Import Failed', error?.message || 'Could not import videos');
      this.importResult = { success: false, errorCount: 1, errors: [error?.message || 'Could not import videos'] };
    } finally {
      this.importing = false;
    }
  }

  close() {
    this.dialogRef.close(this.importResult ? true : false);
  }
}
