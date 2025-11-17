import { Component, Inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatIconModule } from '@angular/material/icon';
import { TabsService, VideoTab } from '../../services/tabs.service';

export interface AddToTabDialogData {
  videoIds: string[];
}

export interface AddToTabDialogResult {
  action: 'existing' | 'new';
  tabId?: string;
  tabName?: string;
}

@Component({
  selector: 'app-add-to-tab-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatIconModule,
  ],
  template: `
    <h2 mat-dialog-title>Add to Tab</h2>
    <mat-dialog-content>
      <div class="dialog-content">
        <p class="video-count">
          Adding {{ data.videoIds.length }} video{{ data.videoIds.length > 1 ? 's' : '' }}
        </p>

        <div *ngIf="loading" class="loading">
          <mat-spinner diameter="40"></mat-spinner>
          <p>Loading tabs...</p>
        </div>

        <div *ngIf="!loading" class="options">
          <mat-radio-group [(ngModel)]="selectedOption" class="radio-group">
            <mat-radio-button value="existing" [disabled]="tabs.length === 0">
              Add to existing tab
            </mat-radio-button>
            <mat-radio-button value="new">
              Create new tab
            </mat-radio-button>
          </mat-radio-group>

          <div *ngIf="selectedOption === 'existing'" class="existing-tab-section">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Select Tab</mat-label>
              <mat-select [(ngModel)]="selectedTabId">
                <mat-option *ngFor="let tab of tabs" [value]="tab.id">
                  {{ tab.name }} ({{ tab.video_count }} videos)
                </mat-option>
              </mat-select>
            </mat-form-field>
          </div>

          <div *ngIf="selectedOption === 'new'" class="new-tab-section">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>Tab Name</mat-label>
              <input matInput [(ngModel)]="newTabName" placeholder="Enter tab name" />
              <mat-icon matPrefix>tab</mat-icon>
            </mat-form-field>
          </div>
        </div>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button
        mat-raised-button
        color="primary"
        (click)="onConfirm()"
        [disabled]="!canConfirm()"
      >
        Add to Tab
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .dialog-content {
      min-width: 400px;
      padding: 20px 0;
    }

    .video-count {
      margin: 0 0 20px 0;
      color: #666;
      font-size: 14px;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 15px;
      padding: 40px 0;

      p {
        margin: 0;
        color: #666;
      }
    }

    .options {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }

    .existing-tab-section,
    .new-tab-section {
      margin-left: 32px;
      margin-top: 10px;
    }

    .full-width {
      width: 100%;
    }

    mat-dialog-actions {
      padding: 16px 0 0 0;
      margin: 0;
    }
  `]
})
export class AddToTabDialogComponent implements OnInit {
  loading = true;
  tabs: VideoTab[] = [];
  selectedOption: 'existing' | 'new' = 'new';
  selectedTabId: string = '';
  newTabName: string = '';

  constructor(
    public dialogRef: MatDialogRef<AddToTabDialogComponent>,
    @Inject(MAT_DIALOG_DATA) public data: AddToTabDialogData,
    private tabsService: TabsService
  ) {}

  async ngOnInit() {
    try {
      this.tabs = await this.tabsService.loadTabs();

      // If there are existing tabs, default to selecting the first one
      if (this.tabs.length > 0) {
        this.selectedOption = 'existing';
        this.selectedTabId = this.tabs[0].id;
      }
    } catch (error) {
      console.error('Failed to load tabs:', error);
    } finally {
      this.loading = false;
    }
  }

  canConfirm(): boolean {
    if (this.loading) return false;

    if (this.selectedOption === 'existing') {
      return !!this.selectedTabId;
    } else {
      return this.newTabName.trim().length > 0;
    }
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  onConfirm(): void {
    const result: AddToTabDialogResult = {
      action: this.selectedOption,
      tabId: this.selectedOption === 'existing' ? this.selectedTabId : undefined,
      tabName: this.selectedOption === 'new' ? this.newTabName.trim() : undefined,
    };
    this.dialogRef.close(result);
  }
}
