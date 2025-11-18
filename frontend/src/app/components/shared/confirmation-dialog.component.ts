import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface ConfirmationDialogData {
  title: string;
  message: string;
  type?: 'info' | 'warning' | 'error' | 'success' | 'confirm';
  confirmText?: string;
  cancelText?: string;
  showCancel?: boolean;
}

@Component({
  selector: 'app-confirmation-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  template: `
    <div class="confirmation-dialog" [class]="data.type || 'info'">
      <div class="dialog-icon">
        <mat-icon>{{ getIcon() }}</mat-icon>
      </div>

      <h2 class="dialog-title">{{ data.title }}</h2>

      <p class="dialog-message">{{ data.message }}</p>

      <div class="dialog-actions">
        <button
          *ngIf="data.showCancel !== false"
          mat-stroked-button
          (click)="onCancel()"
          class="cancel-btn">
          {{ data.cancelText || 'Cancel' }}
        </button>
        <button
          mat-raised-button
          [color]="getButtonColor()"
          (click)="onConfirm()"
          class="confirm-btn">
          {{ data.confirmText || 'OK' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .confirmation-dialog {
      padding: 40px 30px 30px;
      text-align: center;
      min-width: 400px;
      max-width: 500px;
      width: 100%;
      overflow-x: hidden;
      animation: slideIn 0.3s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: scale(0.95) translateY(-10px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .dialog-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: iconBounce 0.6s ease-out;

      mat-icon {
        font-size: 48px;
        width: 48px;
        height: 48px;
        color: white;
      }
    }

    @keyframes iconBounce {
      0% {
        transform: scale(0);
      }
      50% {
        transform: scale(1.1);
      }
      100% {
        transform: scale(1);
      }
    }

    .confirmation-dialog.info .dialog-icon {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.3);
    }

    .confirmation-dialog.success .dialog-icon {
      background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
      box-shadow: 0 8px 24px rgba(72, 187, 120, 0.3);
    }

    .confirmation-dialog.warning .dialog-icon {
      background: linear-gradient(135deg, #ed8936 0%, #dd6b20 100%);
      box-shadow: 0 8px 24px rgba(237, 137, 54, 0.3);
    }

    .confirmation-dialog.error .dialog-icon {
      background: linear-gradient(135deg, #fc8181 0%, #f56565 100%);
      box-shadow: 0 8px 24px rgba(252, 129, 129, 0.3);
    }

    .confirmation-dialog.confirm .dialog-icon {
      background: linear-gradient(135deg, #4299e1 0%, #3182ce 100%);
      box-shadow: 0 8px 24px rgba(66, 153, 225, 0.3);
    }

    .dialog-title {
      margin: 0 0 16px 0;
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary, #1a202c);
    }

    .dialog-message {
      margin: 0 0 32px 0;
      font-size: 15px;
      line-height: 1.6;
      color: var(--text-secondary, #4a5568);
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      max-width: 100%;
    }

    .dialog-actions {
      display: flex;
      gap: 12px;
      justify-content: center;
    }

    .cancel-btn,
    .confirm-btn {
      min-width: 100px;
      height: 44px;
      border-radius: 10px;
      font-weight: 600;
      font-size: 14px;
      letter-spacing: 0.3px;
      transition: all 0.2s ease;

      &:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }
    }

    .cancel-btn {
      border-width: 2px;
    }

    // Dark mode
    @media (prefers-color-scheme: dark) {
      .dialog-title {
        color: #f7fafc;
      }

      .dialog-message {
        color: #cbd5e0;
      }

      .cancel-btn {
        color: #e2e8f0 !important;
        border-color: #4a5568;

        &:hover {
          background: rgba(255, 255, 255, 0.05);
        }
      }

      .confirm-btn {
        color: white !important;
      }
    }
  `]
})
export class ConfirmationDialogComponent {
  constructor(
    private dialogRef: MatDialogRef<ConfirmationDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: ConfirmationDialogData
  ) {
    // Set defaults
    this.data = {
      type: 'info',
      showCancel: true,
      ...data
    };
  }

  getIcon(): string {
    switch (this.data.type) {
      case 'success':
        return 'check_circle';
      case 'warning':
        return 'warning';
      case 'error':
        return 'error';
      case 'confirm':
        return 'help';
      default:
        return 'info';
    }
  }

  getButtonColor(): string {
    switch (this.data.type) {
      case 'error':
        return 'warn';
      case 'success':
      case 'confirm':
      case 'warning':
        return 'primary';
      default:
        return 'primary';
    }
  }

  onConfirm(): void {
    this.dialogRef.close(true);
  }

  onCancel(): void {
    this.dialogRef.close(false);
  }
}
