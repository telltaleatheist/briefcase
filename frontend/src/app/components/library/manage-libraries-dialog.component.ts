import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';

interface ClipLibrary {
  id: string;
  name: string;
  databasePath: string;
  clipsFolderPath: string;
  createdAt: string;
  lastAccessedAt: string;
}

@Component({
  selector: 'app-manage-libraries-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSnackBarModule
  ],
  template: `
    <h2 mat-dialog-title>
      <mat-icon>video_library</mat-icon>
      Manage Libraries
    </h2>

    <mat-dialog-content>
      <div class="library-manager">
        <!-- Create New Library Section -->
        <div class="create-section">
          <h3>Create New Library</h3>
          <mat-form-field appearance="outline" class="library-name-field">
            <mat-label>Library Name</mat-label>
            <input
              matInput
              [(ngModel)]="newLibraryName"
              (ngModelChange)="onNameChange()"
              placeholder="My Media Library">
            <mat-error *ngIf="nameAlreadyExists">
              This name is already taken
            </mat-error>
          </mat-form-field>

          <button
            mat-raised-button
            color="primary"
            (click)="selectClipsFolder()"
            [disabled]="!newLibraryName.trim() || nameAlreadyExists || creating"
            class="folder-button">
            <mat-icon>folder_open</mat-icon>
            Select Clips Folder
          </button>

          <div *ngIf="selectedFolderPath" class="selected-folder">
            <mat-icon>check_circle</mat-icon>
            <span>{{ selectedFolderPath }}</span>
          </div>

          <button
            mat-raised-button
            color="accent"
            (click)="createLibrary()"
            [disabled]="!selectedFolderPath || nameAlreadyExists || creating"
            class="submit-button">
            <mat-spinner *ngIf="creating" diameter="20"></mat-spinner>
            <mat-icon *ngIf="!creating">add</mat-icon>
            {{ creating ? 'Creating...' : 'Create Library' }}
          </button>
        </div>

        <!-- Existing Libraries Section -->
        <div class="libraries-section" *ngIf="libraries.length > 0">
          <h3>Existing Libraries</h3>

          <mat-list class="libraries-list">
            <mat-list-item *ngFor="let library of libraries" class="library-item">
              <div class="library-info">
                <div class="library-row">
                  <mat-icon>video_library</mat-icon>
                  <span class="library-name">{{ library.name }}</span>
                  <span *ngIf="isActive(library)" class="active-badge">Active</span>
                </div>
                <div class="library-row">
                  <mat-icon class="small-icon">folder</mat-icon>
                  <span class="detail-text">{{ library.clipsFolderPath }}</span>
                  <button
                    mat-icon-button
                    color="warn"
                    (click)="confirmDelete(library)"
                    [disabled]="deleting === library.id"
                    matTooltip="Delete Library"
                    class="delete-button">
                    <mat-spinner *ngIf="deleting === library.id" diameter="20"></mat-spinner>
                    <mat-icon *ngIf="deleting !== library.id">delete</mat-icon>
                  </button>
                </div>
              </div>
            </mat-list-item>
          </mat-list>
        </div>
      </div>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="librariesChanged" [disabled]="creating || deleting">Close</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 600px;
      max-width: 800px;
      min-height: 400px;
      padding: 24px;
    }

    h2 {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    h3 {
      margin-top: 0;
      margin-bottom: 16px;
      font-size: 16px;
      font-weight: 500;
    }

    .library-manager {
      display: flex;
      flex-direction: column;
      gap: 32px;
    }

    .create-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 20px;
      background: rgba(var(--accent-color-rgb, 63, 81, 181), 0.05);
      border-radius: 8px;
    }

    .library-name-field {
      width: 100%;
    }

    .folder-button,
    .submit-button {
      width: 100%;
    }

    .selected-folder {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px;
      background: rgba(76, 175, 80, 0.1);
      border-radius: 4px;
      font-size: 14px;
    }

    .selected-folder mat-icon {
      color: #4caf50;
      font-size: 20px;
      width: 20px;
      height: 20px;
    }

    .libraries-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 32px;
    }

    .libraries-list {
      padding: 0;
    }

    .library-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border: 1px solid rgba(var(--text-color-rgb, 255, 255, 255), 0.1);
      border-radius: 8px;
      margin-bottom: 12px;
      height: auto !important;
    }

    .library-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .library-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .library-name {
      font-size: 16px;
      font-weight: 500;
    }

    .active-badge {
      background: #4caf50;
      color: white;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
    }

    .detail-text {
      font-size: 13px;
      color: rgba(var(--text-color-rgb, 255, 255, 255), 0.7);
      flex: 1;
    }

    .delete-button {
      margin-left: auto;
    }

    .small-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }

    .detail-text {
      word-break: break-all;
    }

    .library-actions {
      display: flex;
      gap: 8px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 48px;
      color: rgba(var(--text-color-rgb, 255, 255, 255), 0.5);
    }

    .empty-state mat-icon {
      font-size: 64px;
      width: 64px;
      height: 64px;
    }

    mat-dialog-actions {
      padding: 16px 24px;
    }

    mat-spinner {
      display: inline-block;
    }
  `]
})
export class ManageLibrariesDialogComponent implements OnInit {
  libraries: ClipLibrary[] = [];
  activeLibraryId: string | null = null;
  loading = false;
  creating = false;
  deleting: string | null = null;
  librariesChanged = false;

  newLibraryName = '';
  selectedFolderPath = '';
  nameAlreadyExists = false;

  constructor(
    private dialogRef: MatDialogRef<ManageLibrariesDialogComponent>,
    private http: HttpClient,
    private snackBar: MatSnackBar,
    private backendUrlService: BackendUrlService,
    @Inject(MAT_DIALOG_DATA) public data: { activeLibraryId: string | null }
  ) {
    this.activeLibraryId = data.activeLibraryId;
  }

  async ngOnInit() {
    await this.loadLibraries();
  }

  async loadLibraries() {
    this.loading = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/libraries');
      const response = await this.http.get<{
        libraries: ClipLibrary[];
        activeLibrary: ClipLibrary | null;
      }>(url).toPromise();

      if (response) {
        this.libraries = response.libraries;
        this.activeLibraryId = response.activeLibrary?.id || null;
      }
    } catch (error) {
      console.error('Failed to load libraries:', error);
      this.snackBar.open('Failed to load libraries', 'Close', { duration: 3000 });
    } finally {
      this.loading = false;
    }
  }

  onNameChange() {
    // Check if name already exists (case-insensitive)
    const trimmedName = this.newLibraryName.trim().toLowerCase();
    this.nameAlreadyExists = this.libraries.some(
      lib => lib.name.toLowerCase() === trimmedName
    );
  }

  async selectClipsFolder() {
    if (!this.newLibraryName.trim()) {
      this.snackBar.open('Please enter a library name first', 'Close', { duration: 3000 });
      return;
    }

    try {
      // Use Electron's dialog to select folder
      const result = await (window as any).electron.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Select Clips Folder',
        message: 'Choose where your video clips will be stored'
      });

      if (!result.canceled && result.filePaths.length > 0) {
        this.selectedFolderPath = result.filePaths[0];
      }
    } catch (error) {
      console.error('Failed to select folder:', error);
      this.snackBar.open('Failed to select folder', 'Close', { duration: 3000 });
    }
  }

  async createLibrary() {
    console.log('createLibrary called', {
      name: this.newLibraryName,
      folder: this.selectedFolderPath
    });

    if (!this.newLibraryName.trim() || !this.selectedFolderPath) {
      this.snackBar.open('Please provide both library name and clips folder', 'Close', {
        duration: 3000
      });
      return;
    }

    // Check for duplicate name one more time before creating
    if (this.nameAlreadyExists) {
      this.snackBar.open('A library with this name already exists', 'Close', {
        duration: 3000
      });
      return;
    }

    this.creating = true;
    console.log('Starting library creation...');

    try {
      const payload = {
        name: this.newLibraryName.trim(),
        clipsFolderPath: this.selectedFolderPath
      };
      console.log('Sending request to create library:', payload);

      const url = await this.backendUrlService.getApiUrl('/database/libraries');
      console.log('Backend URL:', url);

      const response = await this.http.post<{
        success: boolean;
        library?: ClipLibrary;
        error?: string;
      }>(url, payload, {
        headers: { 'Content-Type': 'application/json' }
      }).toPromise();

      console.log('Create library response:', response);

      if (response?.success) {
        this.snackBar.open('Library created successfully!', 'Close', { duration: 3000 });
        this.newLibraryName = '';
        this.selectedFolderPath = '';
        this.nameAlreadyExists = false;
        this.librariesChanged = true;
        await this.loadLibraries();
      } else {
        this.snackBar.open(response?.error || 'Failed to create library', 'Close', {
          duration: 3000
        });
      }
    } catch (error: any) {
      console.error('Failed to create library:', error);
      this.snackBar.open(
        error.error?.error || 'Failed to create library',
        'Close',
        { duration: 3000 }
      );
    } finally {
      console.log('Library creation complete, setting creating = false');
      this.creating = false;
    }
  }

  async confirmDelete(library: ClipLibrary) {
    const confirmed = confirm(
      `Are you sure you want to delete "${library.name}"?\n\n` +
      `This will delete the database but NOT the video files in:\n${library.clipsFolderPath}`
    );

    if (confirmed) {
      await this.deleteLibrary(library);
    }
  }

  async deleteLibrary(library: ClipLibrary) {
    this.deleting = library.id;
    try {
      const baseUrl = await this.backendUrlService.getApiUrl('/database/libraries');
      const url = `${baseUrl}/${library.id}?deleteFiles=false`;

      const response = await this.http.delete<{
        success: boolean;
        message?: string;
        error?: string;
      }>(url).toPromise();

      if (response?.success) {
        this.snackBar.open('Library deleted successfully', 'Close', { duration: 3000 });
        this.librariesChanged = true;
        await this.loadLibraries();
      } else {
        this.snackBar.open(response?.error || 'Failed to delete library', 'Close', {
          duration: 3000
        });
      }
    } catch (error: any) {
      console.error('Failed to delete library:', error);
      this.snackBar.open(
        error.error?.error || 'Failed to delete library',
        'Close',
        { duration: 3000 }
      );
    } finally {
      this.deleting = null;
    }
  }

  isActive(library: ClipLibrary): boolean {
    return library.id === this.activeLibraryId;
  }
}
