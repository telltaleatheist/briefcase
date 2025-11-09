import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';
import { NotificationService } from '../../services/notification.service';

interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

interface TransferDialogData {
  selectedVideoIds: string[];
  currentLibraryId: string;
}

@Component({
  selector: 'app-transfer-videos-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule,
    MatSelectModule,
    MatFormFieldModule,
    MatProgressSpinnerModule
  ],
  template: `
    <div class="transfer-dialog">
      <h2 mat-dialog-title>
        <mat-icon>drive_file_move</mat-icon>
        Transfer Videos
      </h2>

      <mat-dialog-content>
        <div class="dialog-content">
          <!-- Loading state -->
          <div *ngIf="loadingLibraries" class="loading-section">
            <mat-spinner diameter="40"></mat-spinner>
            <p>Loading libraries...</p>
          </div>

          <!-- Transfer options -->
          <div *ngIf="!loadingLibraries" class="transfer-options">
            <!-- Target library selection -->
            <div class="option-section">
              <h3>Target Library</h3>
              <mat-form-field appearance="outline" class="full-width">
                <mat-label>Select destination library</mat-label>
                <mat-select [(ngModel)]="selectedLibraryId">
                  <mat-option *ngFor="let library of availableLibraries" [value]="library.id">
                    {{ library.name }}
                  </mat-option>
                </mat-select>
              </mat-form-field>
              <p class="help-text">
                <mat-icon>info</mat-icon>
                Transferring {{ data.selectedVideoIds.length }} video{{ data.selectedVideoIds.length > 1 ? 's' : '' }}
              </p>
            </div>

            <!-- Action type: Move or Copy -->
            <div class="option-section">
              <h3>Transfer Action</h3>
              <mat-radio-group [(ngModel)]="transferAction" class="radio-group">
                <mat-radio-button value="move">
                  <div class="radio-content">
                    <div class="radio-header">
                      <mat-icon>drive_file_move</mat-icon>
                      <strong>Move</strong>
                    </div>
                    <p>Remove videos from current library and add to target library</p>
                  </div>
                </mat-radio-button>
                <mat-radio-button value="copy">
                  <div class="radio-content">
                    <div class="radio-header">
                      <mat-icon>content_copy</mat-icon>
                      <strong>Copy</strong>
                    </div>
                    <p>Keep videos in current library and add copies to target library</p>
                  </div>
                </mat-radio-button>
              </mat-radio-group>
            </div>

            <!-- Replace existing option -->
            <div class="option-section">
              <h3>Conflict Resolution</h3>
              <mat-checkbox [(ngModel)]="replaceExisting" class="replace-checkbox">
                <div class="checkbox-content">
                  <strong>Replace existing videos</strong>
                  <p>If a video with the same filename exists in the target library, replace its data (transcript, analysis, tags, etc.)</p>
                </div>
              </mat-checkbox>
              <p class="warning-text" *ngIf="!replaceExisting">
                <mat-icon>warning</mat-icon>
                Videos that already exist in the target library will be skipped
              </p>
            </div>
          </div>
        </div>
      </mat-dialog-content>

      <mat-dialog-actions align="end">
        <button mat-button (click)="cancel()">Cancel</button>
        <button
          mat-raised-button
          color="primary"
          [disabled]="!selectedLibraryId || isTransferring"
          (click)="confirmTransfer()">
          <mat-spinner *ngIf="isTransferring" diameter="20" style="display: inline-block; margin-right: 8px;"></mat-spinner>
          <mat-icon *ngIf="!isTransferring">{{ transferAction === 'move' ? 'drive_file_move' : 'content_copy' }}</mat-icon>
          {{ isTransferring ? 'Transferring...' : (transferAction === 'move' ? 'Move Videos' : 'Copy Videos') }}
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .transfer-dialog {
      min-width: 500px;
      max-width: 600px;
    }

    h2[mat-dialog-title] {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 0;
      padding: 24px 24px 16px;

      mat-icon {
        font-size: 28px;
        width: 28px;
        height: 28px;
        color: var(--primary-orange);
      }
    }

    mat-dialog-content {
      padding: 0 24px;
      max-height: 70vh;
      overflow-y: auto;
    }

    .dialog-content {
      display: flex;
      flex-direction: column;
      gap: 24px;
      padding: 16px 0;
    }

    .loading-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 32px;
      color: var(--text-secondary);
    }

    .transfer-options {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .option-section {
      display: flex;
      flex-direction: column;
      gap: 12px;

      h3 {
        margin: 0;
        font-size: 16px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .full-width {
        width: 100%;
      }

      .help-text {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 12px;
        background: rgba(255, 143, 71, 0.1);
        border-radius: 4px;
        font-size: 14px;
        color: var(--text-secondary);

        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
          color: var(--primary-orange);
        }
      }

      .warning-text {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 12px;
        background: rgba(255, 152, 0, 0.1);
        border-radius: 4px;
        font-size: 14px;
        color: #ff9800;

        mat-icon {
          font-size: 18px;
          width: 18px;
          height: 18px;
        }
      }
    }

    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 16px;

      mat-radio-button {
        ::ng-deep .mdc-form-field {
          align-items: flex-start;
        }

        ::ng-deep .mdc-radio {
          margin-top: 4px;
        }
      }

      .radio-content {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 12px;
        border: 1px solid var(--border-color);
        border-radius: 4px;
        transition: all 0.2s;

        .radio-header {
          display: flex;
          align-items: center;
          gap: 8px;

          mat-icon {
            font-size: 20px;
            width: 20px;
            height: 20px;
            color: var(--primary-orange);
          }

          strong {
            font-size: 15px;
            color: var(--text-primary);
          }
        }

        p {
          margin: 0;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.4;
        }
      }

      mat-radio-button.mat-mdc-radio-checked .radio-content {
        background: rgba(255, 143, 71, 0.1);
        border-color: var(--primary-orange);
      }
    }

    .replace-checkbox {
      ::ng-deep .mdc-form-field {
        align-items: flex-start;
      }

      ::ng-deep .mdc-checkbox {
        margin-top: 2px;
      }

      .checkbox-content {
        display: flex;
        flex-direction: column;
        gap: 4px;

        strong {
          font-size: 14px;
          color: var(--text-primary);
        }

        p {
          margin: 0;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.4;
        }
      }
    }

    mat-dialog-actions {
      padding: 16px 24px;
      gap: 12px;
    }
  `]
})
export class TransferVideosDialogComponent implements OnInit {
  loadingLibraries = true;
  isTransferring = false;
  availableLibraries: ClipLibrary[] = [];
  selectedLibraryId: string = '';
  transferAction: 'move' | 'copy' = 'move';
  replaceExisting = false;

  constructor(
    private dialogRef: MatDialogRef<TransferVideosDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: TransferDialogData,
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private notificationService: NotificationService
  ) {}

  async ngOnInit() {
    await this.loadLibraries();
  }

  async loadLibraries() {
    try {
      this.loadingLibraries = true;
      const url = await this.backendUrlService.getApiUrl('/database/libraries');
      const response = await this.http.get<{
        libraries: ClipLibrary[];
        activeLibrary: ClipLibrary | null;
      }>(url).toPromise();

      if (response) {
        // Filter out the current library from the available options
        this.availableLibraries = response.libraries.filter(
          lib => lib.id !== this.data.currentLibraryId
        );

        // Auto-select the first available library if there's only one option
        if (this.availableLibraries.length === 1) {
          this.selectedLibraryId = this.availableLibraries[0].id;
        }
      }
    } catch (error) {
      console.error('Failed to load libraries:', error);
      this.notificationService.toastOnly('error', 'Error', 'Failed to load libraries');
    } finally {
      this.loadingLibraries = false;
    }
  }

  async confirmTransfer() {
    if (!this.selectedLibraryId) {
      return;
    }

    this.isTransferring = true;

    try {
      const url = await this.backendUrlService.getApiUrl('/database/transfer-videos');
      const response = await this.http.post<{
        success: boolean;
        transferred: number;
        skipped: number;
        replaced: number;
        errors: string[];
        message: string;
      }>(url, {
        videoIds: this.data.selectedVideoIds,
        targetLibraryId: this.selectedLibraryId,
        action: this.transferAction,
        replaceExisting: this.replaceExisting
      }).toPromise();

      if (response?.success) {
        // Build result message
        let message = `${this.transferAction === 'move' ? 'Moved' : 'Copied'} ${response.transferred} video${response.transferred !== 1 ? 's' : ''}`;

        if (response.replaced > 0) {
          message += `, replaced ${response.replaced}`;
        }

        if (response.skipped > 0) {
          message += `, skipped ${response.skipped} (already exist)`;
        }

        this.notificationService.toastOnly(
          response.errors.length > 0 ? 'warning' : 'success',
          'Transfer Complete',
          message
        );

        // Close dialog and return result
        this.dialogRef.close({
          success: true,
          transferred: response.transferred,
          skipped: response.skipped,
          replaced: response.replaced,
          action: this.transferAction
        });
      } else {
        throw new Error(response?.message || 'Transfer failed');
      }
    } catch (error: any) {
      console.error('Transfer failed:', error);
      this.notificationService.toastOnly(
        'error',
        'Transfer Failed',
        error.error?.message || error.message || 'Failed to transfer videos'
      );
      this.isTransferring = false;
    }
  }

  cancel() {
    this.dialogRef.close(null);
  }
}
