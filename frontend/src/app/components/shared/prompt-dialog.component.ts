import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { FormsModule } from '@angular/forms';

export interface PromptDialogData {
  title: string;
  message: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

@Component({
  selector: 'app-prompt-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    FormsModule
  ],
  template: `
    <div class="prompt-dialog">
      <div class="dialog-icon">
        <mat-icon>edit</mat-icon>
      </div>

      <h2 class="dialog-title">{{ data.title }}</h2>

      <p class="dialog-message" *ngIf="data.message">{{ data.message }}</p>

      <mat-form-field appearance="outline" class="input-field">
        <input
          matInput
          [(ngModel)]="inputValue"
          (keyup.enter)="onConfirm()"
          autofocus>
      </mat-form-field>

      <div class="dialog-actions">
        <button
          mat-stroked-button
          (click)="onCancel()"
          class="cancel-btn">
          {{ data.cancelText || 'Cancel' }}
        </button>
        <button
          mat-raised-button
          color="primary"
          (click)="onConfirm()"
          [disabled]="!inputValue || inputValue.trim() === ''"
          class="confirm-btn">
          {{ data.confirmText || 'OK' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .prompt-dialog {
      padding: 40px 30px 30px;
      text-align: center;
      min-width: 400px;
      max-width: 500px;
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
      background: linear-gradient(135deg, #ff6b00 0%, #ea580c 100%);
      box-shadow: 0 8px 24px rgba(255, 107, 0, 0.3);

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

    .dialog-title {
      margin: 0 0 16px 0;
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary, #1a202c);
    }

    .dialog-message {
      margin: 0 0 24px 0;
      font-size: 15px;
      line-height: 1.6;
      color: var(--text-secondary, #4a5568);
    }

    .input-field {
      width: 100%;
      margin-bottom: 24px;
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
export class PromptDialogComponent {
  inputValue: string;

  constructor(
    private dialogRef: MatDialogRef<PromptDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: PromptDialogData
  ) {
    this.inputValue = data.defaultValue || '';
  }

  onConfirm(): void {
    if (this.inputValue && this.inputValue.trim() !== '') {
      this.dialogRef.close(this.inputValue.trim());
    }
  }

  onCancel(): void {
    this.dialogRef.close(null);
  }
}
