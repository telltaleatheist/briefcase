import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../../environment/environment';
import { AudioNormalizeStateService, AudioFile } from '../../services/audio-normalize-state.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-audio-normalize',
  templateUrl: './audio-normalize.component.html',
  styleUrls: ['./audio-normalize.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatChipsModule,
    MatTooltipModule,
    MatDialogModule
  ]
})
export class AudioNormalizeComponent implements OnInit, OnDestroy {
  private fb = inject(FormBuilder);
  private http = inject(HttpClient);
  private notificationService = inject(NotificationService);
  private dialog = inject(MatDialog);
  private stateService = inject(AudioNormalizeStateService);

  normalizeForm!: FormGroup;
  selectedFiles: AudioFile[] = [];
  isProcessing = false;
  isElectron = false;

  private filesSubscription?: Subscription;
  private isProcessingSubscription?: Subscription;
  private processingInBackground = false;

  private extractFileName(filePath: string): string {
    // Handle both forward slashes and backslashes
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const fileName = parts[parts.length - 1] || filePath;
    console.log(`extractFileName input: "${filePath}" -> output: "${fileName}"`);
    return fileName;
  }

  ngOnInit(): void {
    this.isElectron = !!(window as any).electron;

    this.normalizeForm = this.fb.group({
      targetVolume: [this.stateService.getTargetVolumeValue(), [Validators.required, Validators.min(-60), Validators.max(0)]]
    });

    // Subscribe to state changes
    this.filesSubscription = this.stateService.getFiles().subscribe(files => {
      this.selectedFiles = files;
    });

    this.isProcessingSubscription = this.stateService.getIsProcessing().subscribe(isProcessing => {
      this.isProcessing = isProcessing;
    });

    // If processing is already happening, continue in background
    if (this.isProcessing) {
      this.processingInBackground = true;
      this.continueBackgroundProcessing();
    }
  }

  ngOnDestroy(): void {
    this.filesSubscription?.unsubscribe();
    this.isProcessingSubscription?.unsubscribe();
  }

  async selectFiles(): Promise<void> {
    if (!this.isElectron) {
      this.notificationService.toastOnly('info', 'Electron Required', 'File selection is only available in Electron');
      return;
    }

    try {
      const result = await (window as any).electron.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Audio/Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'aac', 'flac', 'm4a', 'webm'] }
        ]
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return;
      }

      // Add selected files to the state
      const newFiles: AudioFile[] = [];
      result.filePaths.forEach((filePath: string) => {
        const fileName = this.extractFileName(filePath);
        if (!this.selectedFiles.find(f => f.path === filePath)) {
          newFiles.push({
            path: filePath,
            name: fileName,
            status: 'pending'
          });
        }
      });

      this.stateService.addFiles(newFiles);
      this.notificationService.toastOnly('success', 'Files Added', `Added ${result.filePaths.length} file(s)`);
    } catch (error) {
      console.error('Error selecting files:', error);
      this.notificationService.toastOnly('error', 'Selection Failed', 'Failed to select files');
    }
  }

  async selectFolder(): Promise<void> {
    if (!this.isElectron) {
      this.notificationService.toastOnly('info', 'Electron Required', 'Folder selection is only available in Electron');
      return;
    }

    try {
      const result = await (window as any).electron.showOpenDialog({
        properties: ['openDirectory']
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return;
      }

      const folderPath = result.filePaths[0];

      // Request the backend to list files in the folder
      const response = await this.http.post<{ success: boolean; files: string[]; message?: string }>(
        `${environment.apiBaseUrl}/ffmpeg/list-media-files`,
        { folderPath }
      ).toPromise();

      if (response?.success && response.files && response.files.length > 0) {
        console.log('Received files from backend:', response.files);

        const newFiles: AudioFile[] = [];
        response.files.forEach((filePath: string) => {
          console.log('Processing file path:', filePath);
          const fileName = this.extractFileName(filePath);
          console.log('Extracted file name:', fileName);

          // Filter out files that start with ._ (macOS metadata files)
          if (!fileName.startsWith('._') && !this.selectedFiles.find(f => f.path === filePath)) {
            newFiles.push({
              path: filePath,
              name: fileName,
              status: 'pending'
            });
            console.log('Added file:', fileName);
          } else {
            console.log('Skipped file:', fileName);
          }
        });

        this.stateService.addFiles(newFiles);
        this.notificationService.toastOnly('success', 'Files Added', `Added ${newFiles.length} file(s) from folder`);
      } else {
        console.log('Backend response:', response);
        this.notificationService.toastOnly('info', 'No Files', 'No media files found in folder');
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
      this.notificationService.toastOnly('error', 'Selection Failed', 'Failed to select folder');
    }
  }

  removeFile(index: number): void {
    this.stateService.removeFile(index);
  }

  clearAll(): void {
    this.stateService.clearFiles();
  }

  async startNormalization(): Promise<void> {
    if (this.selectedFiles.length === 0) {
      this.notificationService.toastOnly('warning', 'No Files', 'Please select files first');
      return;
    }

    if (this.normalizeForm.invalid) {
      this.notificationService.toastOnly('warning', 'Invalid Input', 'Please enter a valid target volume');
      return;
    }

    // Save target volume to state
    this.stateService.setTargetVolume(this.normalizeForm.value.targetVolume);
    this.stateService.setIsProcessing(true);

    await this.processFiles();
  }

  private async continueBackgroundProcessing(): Promise<void> {
    // Continue processing files that are still pending or processing
    await this.processFiles();
  }

  private async processFiles(): Promise<void> {
    const targetVolume = this.stateService.getTargetVolumeValue();

    // Process files sequentially
    for (let i = 0; i < this.selectedFiles.length; i++) {
      const file = this.selectedFiles[i];

      // Skip files that are already completed or failed
      if (file.status === 'completed' || file.status === 'failed') {
        continue;
      }

      // Update file status to processing
      this.stateService.updateFile(i, { status: 'processing', progress: 0 });

      try {
        const response = await this.http.post<{ success: boolean; outputFile?: string; message?: string }>(
          `${environment.apiBaseUrl}/ffmpeg/normalize-audio`,
          {
            filePath: file.path,
            targetVolume: targetVolume
          }
        ).toPromise();

        if (response?.success) {
          this.stateService.updateFile(i, { status: 'completed', progress: 100 });
        } else {
          this.stateService.updateFile(i, {
            status: 'failed',
            error: response?.message || 'Unknown error'
          });
        }
      } catch (error: any) {
        console.error(`Error normalizing ${file.name}:`, error);
        this.stateService.updateFile(i, {
          status: 'failed',
          error: error.message || 'Network error'
        });
      }
    }

    this.stateService.setIsProcessing(false);

    const completed = this.selectedFiles.filter(f => f.status === 'completed').length;
    const failed = this.selectedFiles.filter(f => f.status === 'failed').length;

    this.notificationService.toastOnly(
      'info',
      'Normalization Complete',
      `${completed} succeeded, ${failed} failed`
    );
  }

  getStatusColor(status: string): string {
    switch (status) {
      case 'pending': return 'primary';
      case 'processing': return 'accent';
      case 'completed': return 'primary';
      case 'failed': return 'warn';
      default: return 'primary';
    }
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'pending': return 'schedule';
      case 'processing': return 'refresh';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'help';
    }
  }

  getStatusBadgeType(status: string): string {
    switch (status) {
      case 'pending': return 'info';
      case 'processing': return 'warning';
      case 'completed': return 'success';
      case 'failed':
      case 'error': return 'danger';
      default: return 'info';
    }
  }

  async selectMedia(): Promise<void> {
    if (!this.isElectron) {
      this.notificationService.toastOnly('info', 'Electron Required', 'File selection is only available in Electron');
      return;
    }

    try {
      // Allow both files and directories to be selected
      const result = await (window as any).electron.showOpenDialog({
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [
          { name: 'Audio/Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'aac', 'flac', 'm4a', 'webm'] }
        ]
      });

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return;
      }

      const newFiles: AudioFile[] = [];

      for (const selectedPath of result.filePaths) {
        // Check if it's a directory using Electron's fs API
        const isDirectory = await (window as any).electron.isDirectory(selectedPath);

        if (isDirectory) {
          // It's a folder - get all media files from it
          const response = await this.http.post<{ success: boolean; files: string[]; message?: string }>(
            `${environment.apiBaseUrl}/ffmpeg/list-media-files`,
            { folderPath: selectedPath }
          ).toPromise();

          if (response?.success && response.files && response.files.length > 0) {
            response.files.forEach((filePath: string) => {
              const fileName = this.extractFileName(filePath);
              if (!fileName.startsWith('._') && !this.selectedFiles.find(f => f.path === filePath)) {
                newFiles.push({
                  path: filePath,
                  name: fileName,
                  status: 'pending'
                });
              }
            });
          }
        } else {
          // It's a file - add it directly
          const fileName = this.extractFileName(selectedPath);
          if (!this.selectedFiles.find(f => f.path === selectedPath)) {
            newFiles.push({
              path: selectedPath,
              name: fileName,
              status: 'pending'
            });
          }
        }
      }

      if (newFiles.length > 0) {
        this.stateService.addFiles(newFiles);
        this.notificationService.toastOnly('success', 'Files Added', `Added ${newFiles.length} file(s)`);
      } else {
        this.notificationService.toastOnly('info', 'No New Files', 'No new files to add');
      }
    } catch (error) {
      console.error('Error selecting media:', error);
      this.notificationService.toastOnly('error', 'Selection Failed', 'Failed to select media');
    }
  }

  openSettingsDialog(): void {
    const dialogRef = this.dialog.open(AudioNormalizeSettingsDialog, {
      width: '400px',
      data: { targetVolume: this.stateService.getTargetVolumeValue() }
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result !== undefined) {
        this.normalizeForm.patchValue({ targetVolume: result });
        this.stateService.setTargetVolume(result);
      }
    });
  }
}

// Settings Dialog Component
@Component({
  selector: 'audio-normalize-settings-dialog',
  template: `
    <h2 mat-dialog-title>Audio Normalization Settings</h2>
    <mat-dialog-content>
      <form [formGroup]="settingsForm">
        <mat-form-field appearance="outline" style="width: 100%;">
          <mat-label>Target Volume (dB)</mat-label>
          <input
            matInput
            type="number"
            formControlName="targetVolume"
            placeholder="-20"
          >
          <mat-hint>Recommended: -20dB to -14dB (quieter to louder)</mat-hint>
          <mat-error *ngIf="settingsForm.get('targetVolume')?.hasError('required')">
            Target volume is required
          </mat-error>
          <mat-error *ngIf="settingsForm.get('targetVolume')?.hasError('min')">
            Minimum value is -60dB
          </mat-error>
          <mat-error *ngIf="settingsForm.get('targetVolume')?.hasError('max')">
            Maximum value is 0dB
          </mat-error>
        </mat-form-field>
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-raised-button color="primary" [mat-dialog-close]="settingsForm.value.targetVolume" [disabled]="settingsForm.invalid">
        Save
      </button>
    </mat-dialog-actions>
  `,
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule
  ]
})
export class AudioNormalizeSettingsDialog implements OnInit {
  private fb = inject(FormBuilder);
  private dialogRef = inject(MatDialog);
  settingsForm!: FormGroup;
  data = inject<any>(MAT_DIALOG_DATA);

  ngOnInit(): void {
    this.settingsForm = this.fb.group({
      targetVolume: [this.data.targetVolume || -20, [Validators.required, Validators.min(-60), Validators.max(0)]]
    });
  }
}
