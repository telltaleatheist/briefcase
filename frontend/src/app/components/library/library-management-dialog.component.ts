import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { LibraryConfigComponent } from '../settings/library-config.component';

export interface LibraryManagementDialogData {
  isInitialSetup?: boolean;  // True if this is the first-time setup (no libraries exist)
}

@Component({
  selector: 'app-library-management-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    LibraryConfigComponent
  ],
  template: `
    <div class="library-management-dialog">
      <div class="dialog-content">
        <app-library-config></app-library-config>
      </div>

      <mat-dialog-actions align="end">
        <button mat-button (click)="closeDialog()" class="close-button">
          <mat-icon>{{ data?.isInitialSetup ? 'schedule' : 'close' }}</mat-icon>
          {{ data?.isInitialSetup ? "I'll set this up later" : 'Close' }}
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    :host ::ng-deep .mat-mdc-dialog-surface {
      background: #fafafa;
    }

    .library-management-dialog {
      width: 700px;
      max-width: 90vw;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      background: transparent;
    }

    .dialog-content {
      padding: 0;
      max-height: calc(85vh - 80px);
      overflow-y: auto;
      flex: 1;
    }

    mat-dialog-actions {
      padding: 16px 24px;
      border-top: 2px solid #e0e0e0;
      background: #ffffff;

      .close-button {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 44px;
        padding: 0 20px;
        border-radius: 10px;
        font-weight: 600;
        color: #4a5568;
        transition: all 0.2s ease;

        mat-icon {
          font-size: 20px;
          width: 20px;
          height: 20px;
        }

        &:hover {
          background: rgba(255, 107, 0, 0.1);
          color: #ff6b00;
        }
      }
    }

    @media (prefers-color-scheme: dark) {
      :host ::ng-deep .mat-mdc-dialog-surface {
        background: #0a0a0a;
      }

      mat-dialog-actions {
        border-top-color: #3a3a3a;
        background: #1f1f1f;

        .close-button {
          color: #e2e8f0 !important;

          &:hover {
            background: rgba(255, 107, 0, 0.2);
            color: #f7fafc !important;
          }
        }
      }
    }
  `]
})
export class LibraryManagementDialogComponent {
  constructor(
    private dialogRef: MatDialogRef<LibraryManagementDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: LibraryManagementDialogData
  ) {
    // Default to false if not provided
    this.data = this.data || { isInitialSetup: false };
  }

  closeDialog() {
    this.dialogRef.close();
  }
}
