import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../../services/backend-url.service';
import { LibraryStateService, ClipLibrary } from '../../services/library-state.service';
import { ConfirmationDialogComponent } from '../shared/confirmation-dialog.component';
import { PromptDialogComponent } from '../shared/prompt-dialog.component';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-library-config',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatFormFieldModule,
    MatCardModule,
    MatListModule,
    MatMenuModule,
    MatTooltipModule,
    MatDialogModule,
    MatExpansionModule
  ],
  template: `
    <div class="library-config-container">
      <div class="header">
        <h2>
          <mat-icon>folder_special</mat-icon>
          Library Management
        </h2>
        <p class="subtitle">Manage your video libraries</p>
      </div>

      <!-- Libraries List (Card Style) -->
      <div class="libraries-section" *ngIf="libraries.length > 0">
        <h3>Your Libraries</h3>
        <div class="libraries-grid">
          <div
            *ngFor="let library of libraries"
            class="library-card"
            [class.active]="library.id === currentLibraryId">

            <div class="library-card-header">
              <div class="library-icon-wrapper">
                <mat-icon>{{ library.id === currentLibraryId ? 'folder_open' : 'folder' }}</mat-icon>
              </div>
              <div class="library-info">
                <h4>{{ library.name }}</h4>
                <span class="status-badge" *ngIf="library.id === currentLibraryId">
                  <mat-icon>check_circle</mat-icon>
                  Active
                </span>
              </div>
            </div>

            <div class="library-card-body">
              <div class="info-item">
                <mat-icon>folder</mat-icon>
                <div class="info-text">
                  <span class="label">Location</span>
                  <span class="value">{{ library.clipsFolderPath }}</span>
                </div>
              </div>

              <div class="info-item compact">
                <mat-icon>event</mat-icon>
                <div class="info-text">
                  <span class="label">Created</span>
                  <span class="value">{{ library.createdAt | date:'short' }}</span>
                </div>
              </div>
            </div>

            <div class="library-card-actions">
              <button
                mat-raised-button
                color="primary"
                *ngIf="library.id !== currentLibraryId"
                (click)="switchLibrary(library.id); $event.stopPropagation()"
                class="switch-btn">
                <mat-icon>check_circle</mat-icon>
                Switch
              </button>
              <button
                mat-icon-button
                (click)="renameLibrary(library); $event.stopPropagation()"
                matTooltip="Rename library"
                class="action-btn">
                <mat-icon>edit</mat-icon>
              </button>
              <button
                mat-icon-button
                color="warn"
                (click)="deleteLibrary(library); $event.stopPropagation()"
                [disabled]="library.id === currentLibraryId"
                matTooltip="Delete library"
                class="action-btn delete-btn">
                <mat-icon>delete</mat-icon>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Empty State -->
      <div class="empty-state" *ngIf="libraries.length === 0 && !isLoading">
        <mat-icon>folder_off</mat-icon>
        <h3>No Libraries Yet</h3>
        <p>Create your first library to start organizing your videos</p>
      </div>

      <!-- Add Library Section -->
      <div class="create-section">
        <h3>{{ libraries.length === 0 ? 'Set Up Your First Library' : 'Add Library' }}</h3>

        <!-- Action Buttons -->
        <div class="action-buttons">
          <button
            mat-raised-button
            color="primary"
            (click)="showCreateForm = true; showLinkForm = false">
            <mat-icon>add</mat-icon>
            Create New Library
          </button>
          <button
            mat-raised-button
            class="link-library-btn"
            (click)="showLinkForm = true; showCreateForm = false">
            <mat-icon>link</mat-icon>
            Link Existing Library
          </button>
        </div>

        <!-- Create New Library Form -->
        <div class="create-form" *ngIf="showCreateForm">
          <h4>
            <mat-icon>add_circle</mat-icon>
            Create New Library
          </h4>
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Library Name</mat-label>
            <input
              matInput
              [(ngModel)]="newLibraryName"
              placeholder="My Media Library"
              (keyup.enter)="chooseFolderForNew()">
            <mat-icon matPrefix>label</mat-icon>
          </mat-form-field>

          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Folder Path</mat-label>
            <input
              matInput
              [(ngModel)]="newLibraryPath"
              placeholder="Choose a folder for your library"
              readonly>
            <mat-icon matPrefix>folder</mat-icon>
            <button
              mat-icon-button
              matSuffix
              (click)="chooseFolderForNew()"
              matTooltip="Choose folder">
              <mat-icon>folder_open</mat-icon>
            </button>
          </mat-form-field>

          <div class="form-actions">
            <button mat-button (click)="cancelForms()">Cancel</button>
            <button
              mat-raised-button
              color="primary"
              [disabled]="!canCreateLibrary()"
              (click)="createLibrary()">
              <mat-icon>add</mat-icon>
              Create Library
            </button>
          </div>
        </div>

        <!-- Link Existing Library Form -->
        <div class="link-form" *ngIf="showLinkForm">
          <h4>
            <mat-icon>link</mat-icon>
            Link Existing Library
          </h4>
          <p class="helper-text">
            Select a folder that contains an existing library database file (.library.db)
          </p>
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Folder Path</mat-label>
            <input
              matInput
              [(ngModel)]="linkLibraryPath"
              placeholder="Choose folder containing .library.db file"
              readonly>
            <mat-icon matPrefix>folder</mat-icon>
            <button
              mat-icon-button
              matSuffix
              (click)="chooseFolderForLink()"
              matTooltip="Choose folder">
              <mat-icon>folder_open</mat-icon>
            </button>
          </mat-form-field>

          <mat-form-field appearance="outline" class="full-width" *ngIf="linkLibraryPath">
            <mat-label>Library Name (Optional)</mat-label>
            <input
              matInput
              [(ngModel)]="linkLibraryName"
              placeholder="Leave empty to use folder name">
            <mat-icon matPrefix>label</mat-icon>
          </mat-form-field>

          <div class="form-actions">
            <button mat-button (click)="cancelForms()">Cancel</button>
            <button
              mat-raised-button
              color="primary"
              [disabled]="!canLinkLibrary()"
              (click)="linkExistingLibrary()">
              <mat-icon>link</mat-icon>
              Link Library
            </button>
          </div>
        </div>
      </div>

      <!-- Info Box -->
      <div class="info-box">
        <mat-icon>info</mat-icon>
        <div class="info-content">
          <strong>About Libraries</strong>
          <p>Each library is stored in its own folder with a database file. You can have multiple libraries for different projects or categories.</p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .library-config-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 30px;
      animation: fadeIn 0.3s ease-in;
      background: var(--bg-secondary);
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .header {
      text-align: center;
      margin-bottom: 40px;

      h2 {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        font-size: 32px;
        font-weight: 700;
        margin: 0 0 10px 0;
        color: var(--text-primary);

        mat-icon {
          font-size: 40px;
          width: 40px;
          height: 40px;
          color: var(--primary-orange);
        }
      }

      .subtitle {
        margin: 0;
        color: var(--text-secondary);
        font-size: 16px;
      }
    }

    .libraries-section {
      margin-bottom: 40px;

      h3 {
        margin: 0 0 24px 0;
        font-size: 20px;
        font-weight: 600;
        color: var(--text-primary);
        text-align: center;
      }

      .libraries-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 24px;
      }

      .library-card {
        background: var(--bg-card);
        border: 2px solid var(--border-color);
        border-radius: 0;
        padding: 16px;
        transition: var(--transition);
        position: relative;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);

        &:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
          border-color: var(--border-color);
        }

        &.active {
          border-color: var(--primary-orange);
          background: var(--bg-card);
          box-shadow: 0 4px 20px rgba(255, 107, 53, 0.15);

          &:hover {
            border-color: var(--dark-orange);
            box-shadow: 0 12px 28px rgba(255, 107, 53, 0.25);
          }
        }

        .library-card-header {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 2px solid var(--border-color);

          .library-icon-wrapper {
            width: 56px;
            height: 56px;
            border-radius: 0;
            background: linear-gradient(135deg, var(--primary-orange) 0%, var(--dark-orange) 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 4px 12px rgba(255, 107, 53, 0.3);

            mat-icon {
              font-size: 32px;
              width: 32px;
              height: 32px;
              color: white;
            }
          }

          .library-info {
            flex: 1;

            h4 {
              margin: 0 0 8px 0;
              font-size: 20px;
              font-weight: 700;
              color: var(--text-primary);
            }

            .status-badge {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              padding: 6px 14px;
              background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
              color: white;
              border-radius: 0;
              font-size: 12px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.5px;
              box-shadow: 0 2px 8px rgba(72, 187, 120, 0.3);

              mat-icon {
                font-size: 16px;
                width: 16px;
                height: 16px;
              }
            }
          }
        }

        .library-card-body {
          margin-bottom: 12px;

          .info-item {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
            background: var(--bg-secondary);
            padding: 12px;
            border-radius: 0;

            &.compact {
              margin-bottom: 0;
            }

            mat-icon {
              font-size: 20px;
              width: 20px;
              height: 20px;
              color: var(--primary-orange);
              flex-shrink: 0;
              margin-top: 2px;
            }

            .info-text {
              flex: 1;
              display: flex;
              flex-direction: column;
              gap: 4px;
              min-width: 0;

              .label {
                font-size: 11px;
                color: var(--text-secondary);
                text-transform: uppercase;
                font-weight: 700;
                letter-spacing: 0.8px;
              }

              .value {
                font-size: 13px;
                color: var(--text-primary);
                word-break: break-all;
                font-family: 'Monaco', 'Courier New', monospace;
                font-weight: 500;
              }
            }
          }

          .info-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }
        }

        .library-card-actions {
          display: flex;
          gap: 10px;
          align-items: center;
          padding-top: 16px;
          border-top: 2px solid var(--border-color);

          .switch-btn {
            flex: 1;
            height: 42px;
            border-radius: var(--border-radius);
            font-weight: 600;
            font-size: 14px;
            letter-spacing: 0.3px;

            mat-icon {
              margin-right: 8px;
              font-size: 20px;
              width: 20px;
              height: 20px;
            }
          }

          .action-btn {
            width: 42px;
            height: 42px;
            border-radius: var(--border-radius);
            color: var(--text-secondary);
            transition: var(--transition);

            mat-icon {
              font-size: 20px;
              width: 20px;
              height: 20px;
            }

            &:hover:not(:disabled) {
              color: var(--primary-orange);
              background: rgba(255, 107, 53, 0.1);
              transform: scale(1.05);
            }

            &.delete-btn {
              &:hover:not(:disabled) {
                color: #fc8181;
                background: rgba(252, 129, 129, 0.1);
              }

              &:disabled {
                opacity: 0.3;
                cursor: not-allowed;
              }
            }
          }
        }
      }
    }

    .empty-state {
      text-align: center;
      padding: 60px 30px;
      background: var(--bg-card);
      border-radius: 0;
      border: 2px dashed var(--border-color);
      margin-bottom: 40px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);

      mat-icon {
        font-size: 80px;
        width: 80px;
        height: 80px;
        color: var(--text-muted);
        margin-bottom: 12px;
      }

      h3 {
        margin: 0 0 10px 0;
        font-size: 24px;
        font-weight: 700;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 16px;
      }
    }

    .create-section {
      padding: 30px;
      background: var(--bg-card);
      border-radius: 0;
      border: 2px solid var(--border-color);
      margin-bottom: 32px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);

      h3 {
        margin: 0 0 24px 0;
        font-size: 22px;
        font-weight: 700;
        color: var(--text-primary);
        text-align: center;
      }

      .action-buttons {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-bottom: 28px;

        button {
          height: 56px;
          border-radius: var(--border-radius);
          font-weight: 600;
          font-size: 15px;
          letter-spacing: 0.3px;
          transition: var(--transition);

          mat-icon {
            margin-right: 10px;
            font-size: 22px;
            width: 22px;
            height: 22px;
          }

          &:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
          }

          &.link-library-btn {
            background: var(--bg-card);
            color: var(--text-primary);
            border: 1px solid var(--border-color);
          }
        }
      }

      .create-form,
      .link-form {
        padding: 16px;
        background: var(--bg-secondary);
        border-radius: 0;
        border: 2px solid var(--border-color);
        animation: slideDown 0.3s ease-out;

        h4 {
          display: flex;
          align-items: center;
          gap: 10px;
          margin: 0 0 20px 0;
          font-size: 18px;
          font-weight: 700;
          color: var(--text-primary);

          mat-icon {
            color: var(--primary-orange);
            font-size: 24px;
            width: 24px;
            height: 24px;
          }
        }

        .helper-text {
          margin: 0 0 20px 0;
          font-size: 14px;
          color: var(--text-secondary);
          line-height: 1.6;
        }

        .full-width {
          width: 100%;
          margin-bottom: 18px;
        }

        .form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          margin-top: 12px;

          button {
            height: 44px;
            border-radius: 0;
            font-weight: 600;
            min-width: 100px;

            mat-icon {
              margin-right: 8px;
            }
          }
        }
      }
    }

    @keyframes slideDown {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .info-box {
      display: flex;
      gap: 16px;
      padding: 12px;
      background: var(--bg-tertiary);
      border-radius: 0;
      border: 2px solid var(--border-color);

      mat-icon {
        color: var(--primary-orange);
        flex-shrink: 0;
        font-size: 28px;
        width: 28px;
        height: 28px;
      }

      .info-content {
        flex: 1;

        strong {
          display: block;
          margin-bottom: 8px;
          color: var(--text-primary);
          font-size: 16px;
          font-weight: 700;
        }

        p {
          margin: 0;
          color: var(--text-secondary);
          font-size: 14px;
          line-height: 1.6;
        }
      }
    }

    // Dark mode support
  `]
})
export class LibraryConfigComponent implements OnInit {
  libraries: ClipLibrary[] = [];
  currentLibraryId: string | null = null;
  isLoading = false;

  // Create new library
  newLibraryName = '';
  newLibraryPath = '';

  // Link existing library
  linkLibraryPath = '';
  linkLibraryName = '';

  // Form visibility
  showCreateForm = false;
  showLinkForm = false;

  constructor(
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private libraryState: LibraryStateService,
    private dialog: MatDialog
  ) {}

  ngOnInit() {
    this.loadLibraries();
  }

  /**
   * Show an alert dialog
   */
  private async showAlert(title: string, message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<void> {
    const dialogRef = this.dialog.open(ConfirmationDialogComponent, {
      width: '450px',
      data: {
        title,
        message,
        type,
        confirmText: 'OK',
        showCancel: false
      }
    });

    await firstValueFrom(dialogRef.afterClosed());
  }

  /**
   * Show a confirmation dialog
   */
  private async showConfirm(title: string, message: string, confirmText: string = 'Yes', cancelText: string = 'No'): Promise<boolean> {
    const dialogRef = this.dialog.open(ConfirmationDialogComponent, {
      width: '450px',
      data: {
        title,
        message,
        type: 'confirm',
        confirmText,
        cancelText,
        showCancel: true
      }
    });

    const result = await firstValueFrom(dialogRef.afterClosed());
    return result === true;
  }

  /**
   * Show a prompt dialog
   */
  private async showPrompt(title: string, defaultValue: string = ''): Promise<string | null> {
    const dialogRef = this.dialog.open(PromptDialogComponent, {
      width: '450px',
      data: {
        title,
        message: '',
        defaultValue,
        confirmText: 'Save',
        cancelText: 'Cancel'
      }
    });

    const result = await firstValueFrom(dialogRef.afterClosed());
    return result || null;
  }

  async loadLibraries() {
    this.isLoading = true;
    try {
      const url = await this.backendUrlService.getApiUrl('/database/libraries');
      const response = await this.http.get<{ libraries: ClipLibrary[] }>(url).toPromise();

      if (response) {
        this.libraries = response.libraries;
        const currentLib = this.libraryState.getCurrentLibrary();
        this.currentLibraryId = currentLib?.id || null;
      }
    } catch (error) {
      console.error('Failed to load libraries:', error);
    } finally {
      this.isLoading = false;
    }
  }

  async chooseFolderForNew() {
    try {
      // Use Electron's dialog to choose folder
      const result = await (window as any).electron.selectDirectory();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        this.newLibraryPath = result.filePaths[0];
      }
    } catch (error) {
      console.error('Failed to choose folder:', error);
      await this.showAlert('Folder Picker Error', 'Failed to open folder picker. Please ensure the app has the necessary permissions.', 'error');
    }
  }

  async chooseFolderForLink() {
    try {
      // Use Electron's dialog to choose folder
      const result = await (window as any).electron.selectDirectory();
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        this.linkLibraryPath = result.filePaths[0];
      }
    } catch (error) {
      console.error('Failed to choose folder:', error);
      await this.showAlert('Folder Picker Error', 'Failed to open folder picker. Please ensure the app has the necessary permissions.', 'error');
    }
  }

  cancelForms() {
    this.showCreateForm = false;
    this.showLinkForm = false;
    this.newLibraryName = '';
    this.newLibraryPath = '';
    this.linkLibraryPath = '';
    this.linkLibraryName = '';
  }

  canCreateLibrary(): boolean {
    return this.newLibraryName.trim().length > 0 && this.newLibraryPath.trim().length > 0;
  }

  canLinkLibrary(): boolean {
    return this.linkLibraryPath.trim().length > 0;
  }

  async createLibrary() {
    if (!this.canCreateLibrary()) {
      return;
    }

    try {
      const url = await this.backendUrlService.getApiUrl('/database/libraries');
      const response = await this.http.post<{ success: boolean; library: ClipLibrary }>(url, {
        name: this.newLibraryName.trim(),
        clipsFolderPath: this.newLibraryPath.trim()
      }).toPromise();

      if (response?.success) {
        await this.showAlert('Success!', `Library "${this.newLibraryName}" created successfully!`, 'success');
        this.cancelForms();
        await this.loadLibraries();
      }
    } catch (error: any) {
      console.error('Failed to create library:', error);
      await this.showAlert('Error', `Failed to create library: ${error.error?.error || error.message || 'Unknown error'}`, 'error');
    }
  }

  async linkExistingLibrary() {
    if (!this.canLinkLibrary()) {
      return;
    }

    try {
      const url = await this.backendUrlService.getApiUrl('/database/libraries/open');
      const response = await this.http.post<{ success: boolean; library: ClipLibrary; error?: string }>(url, {
        clipsFolderPath: this.linkLibraryPath.trim(),
        name: this.linkLibraryName.trim() || undefined
      }).toPromise();

      if (response?.success) {
        const libraryName = response.library?.name || this.linkLibraryName || 'Library';
        await this.showAlert('Success!', `Library "${libraryName}" linked successfully!`, 'success');
        this.cancelForms();
        await this.loadLibraries();
      } else {
        await this.showAlert('Error', `Failed to link library: ${response?.error || 'No .library.db file found in the selected folder'}`, 'error');
      }
    } catch (error: any) {
      console.error('Failed to link library:', error);
      await this.showAlert('Error', `Failed to link library: ${error.error?.error || error.message || 'Unknown error'}`, 'error');
    }
  }

  async switchLibrary(libraryId: string) {
    try {
      const url = await this.backendUrlService.getApiUrl(`/database/libraries/${libraryId}/switch`);
      const response = await this.http.post<{ success: boolean }>(url, {}).toPromise();

      if (response?.success) {
        this.currentLibraryId = libraryId;
        const library = this.libraries.find(l => l.id === libraryId);
        if (library) {
          this.libraryState.setCurrentLibrary(library);
        }
        await this.showAlert('Success!', 'Library switched successfully!', 'success');
      }
    } catch (error) {
      console.error('Failed to switch library:', error);
      await this.showAlert('Error', 'Failed to switch library', 'error');
    }
  }

  async renameLibrary(library: ClipLibrary) {
    const newName = await this.showPrompt(`Rename library "${library.name}" to:`, library.name);

    if (!newName || newName.trim() === '' || newName.trim() === library.name) {
      return;
    }

    try {
      const url = await this.backendUrlService.getApiUrl(`/database/libraries/${library.id}`);
      const response = await this.http.patch<{ success: boolean }>(url, {
        name: newName.trim()
      }).toPromise();

      if (response?.success) {
        await this.loadLibraries();
        // Update the library state service as well
        this.libraryState.setLibraries(this.libraries);
      }
    } catch (error) {
      console.error('Failed to rename library:', error);
      await this.showAlert('Error', 'Failed to rename library', 'error');
    }
  }

  async deleteLibrary(library: ClipLibrary) {
    const confirmed = await this.showConfirm(
      'Delete Library?',
      `Are you sure you want to delete "${library.name}"?\n\nThis will remove the library from Clippy but will NOT delete your video files.`,
      'Delete',
      'Cancel'
    );

    if (!confirmed) {
      return;
    }

    try {
      const url = await this.backendUrlService.getApiUrl(`/database/libraries/${library.id}?deleteFiles=false`);
      const response = await this.http.delete<{ success: boolean }>(url).toPromise();

      if (response?.success) {
        await this.loadLibraries();
      }
    } catch (error) {
      console.error('Failed to delete library:', error);
      await this.showAlert('Error', 'Failed to delete library', 'error');
    }
  }
}
