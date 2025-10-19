// frontend/src/app/components/executable-error-handler/executable-config-dialog.component.ts
import { Component } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { ConfigService } from '../../services/config.service';

@Component({
  selector: 'app-executable-config-dialog',
  template: `
    <h2 mat-dialog-title>Required Executables Not Found</h2>
    <mat-dialog-content>
      <p>
        To use this application, you need to have FFmpeg, FFprobe, and yt-dlp
        installed on your system.
      </p>
      <p>
        If you already have these executables installed, please help us locate them.
        Otherwise, you'll need to download and install them first.
      </p>
      <div *ngIf="errorMessage" class="error-message">
        {{ errorMessage }}
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button color="warn" (click)="exitApp()">Exit Application</button>
      <button mat-button (click)="openHelpPage()">Get Help</button>
      <button mat-raised-button color="primary" (click)="configureExecutables()">
        Configure Executables
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .error-message {
      color: #f44336;
      background-color: #ffebee;
      padding: 10px;
      border-radius: 4px;
      margin-top: 16px;
    }
  `]
})
export class ExecutableConfigDialogComponent {
  errorMessage: string | null = null;

  constructor(
    private dialogRef: MatDialogRef<ExecutableConfigDialogComponent>,
    private configService: ConfigService
  ) {}

  configureExecutables(): void {
    this.dialogRef.close('electron-dialog');
  }

  openHelpPage(): void {
    // Open a help page in the default browser
    window.electronAPI.openExternal('https://github.com/yt-dlp/yt-dlp/wiki/Installation');
  }

  exitApp(): void {
    window.electronAPI.exitApp();
  }
}