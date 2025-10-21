import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatChipsModule } from '@angular/material/chips';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environment/environment';

interface AudioFile {
  path: string;
  name: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  error?: string;
}

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
    MatSnackBarModule,
    MatTooltipModule
  ]
})
export class AudioNormalizeComponent implements OnInit {
  private fb = inject(FormBuilder);
  private http = inject(HttpClient);
  private snackBar = inject(MatSnackBar);

  normalizeForm!: FormGroup;
  selectedFiles: AudioFile[] = [];
  isProcessing = false;
  isElectron = false;

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
      targetVolume: [-20, [Validators.required, Validators.min(-60), Validators.max(0)]]
    });
  }

  async selectFiles(): Promise<void> {
    if (!this.isElectron) {
      this.snackBar.open('File selection is only available in Electron', 'Dismiss', { duration: 3000 });
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

      // Add selected files to the list
      result.filePaths.forEach((filePath: string) => {
        const fileName = this.extractFileName(filePath);
        if (!this.selectedFiles.find(f => f.path === filePath)) {
          this.selectedFiles.push({
            path: filePath,
            name: fileName,
            status: 'pending'
          });
        }
      });

      this.snackBar.open(`Added ${result.filePaths.length} file(s)`, 'Dismiss', { duration: 2000 });
    } catch (error) {
      console.error('Error selecting files:', error);
      this.snackBar.open('Failed to select files', 'Dismiss', { duration: 3000 });
    }
  }

  async selectFolder(): Promise<void> {
    if (!this.isElectron) {
      this.snackBar.open('Folder selection is only available in Electron', 'Dismiss', { duration: 3000 });
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

        let addedCount = 0;
        response.files.forEach((filePath: string) => {
          console.log('Processing file path:', filePath);
          const fileName = this.extractFileName(filePath);
          console.log('Extracted file name:', fileName);

          // Filter out files that start with ._ (macOS metadata files)
          if (!fileName.startsWith('._') && !this.selectedFiles.find(f => f.path === filePath)) {
            this.selectedFiles.push({
              path: filePath,
              name: fileName,
              status: 'pending'
            });
            addedCount++;
            console.log('Added file:', fileName);
          } else {
            console.log('Skipped file:', fileName);
          }
        });

        this.snackBar.open(`Added ${addedCount} file(s) from folder`, 'Dismiss', { duration: 2000 });
      } else {
        console.log('Backend response:', response);
        this.snackBar.open('No media files found in folder', 'Dismiss', { duration: 3000 });
      }
    } catch (error) {
      console.error('Error selecting folder:', error);
      this.snackBar.open('Failed to select folder', 'Dismiss', { duration: 3000 });
    }
  }

  removeFile(index: number): void {
    this.selectedFiles.splice(index, 1);
  }

  clearAll(): void {
    this.selectedFiles = [];
  }

  async startNormalization(): Promise<void> {
    if (this.selectedFiles.length === 0) {
      this.snackBar.open('Please select files first', 'Dismiss', { duration: 3000 });
      return;
    }

    if (this.normalizeForm.invalid) {
      this.snackBar.open('Please enter a valid target volume', 'Dismiss', { duration: 3000 });
      return;
    }

    this.isProcessing = true;
    const targetVolume = this.normalizeForm.value.targetVolume;

    // Process files sequentially
    for (let i = 0; i < this.selectedFiles.length; i++) {
      const file = this.selectedFiles[i];
      file.status = 'processing';
      file.progress = 0;

      try {
        const response = await this.http.post<{ success: boolean; outputFile?: string; message?: string }>(
          `${environment.apiBaseUrl}/ffmpeg/normalize-audio`,
          {
            filePath: file.path,
            targetVolume: targetVolume
          }
        ).toPromise();

        if (response?.success) {
          file.status = 'completed';
          file.progress = 100;
        } else {
          file.status = 'failed';
          file.error = response?.message || 'Unknown error';
        }
      } catch (error: any) {
        console.error(`Error normalizing ${file.name}:`, error);
        file.status = 'failed';
        file.error = error.message || 'Network error';
      }
    }

    this.isProcessing = false;

    const completed = this.selectedFiles.filter(f => f.status === 'completed').length;
    const failed = this.selectedFiles.filter(f => f.status === 'failed').length;

    this.snackBar.open(
      `Normalization complete: ${completed} succeeded, ${failed} failed`,
      'Dismiss',
      { duration: 5000 }
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
}
