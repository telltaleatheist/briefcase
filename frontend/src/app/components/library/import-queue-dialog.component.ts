import { Component, OnInit, OnDestroy, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatListModule } from '@angular/material/list';
import { ImportQueueService, ImportItem, ImportQueueState } from '../../services/import-queue.service';
import { Subject, takeUntil } from 'rxjs';

@Component({
  selector: 'app-import-queue-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatListModule
  ],
  template: `
    <div class="import-dialog">
      <div class="header">
        <h2>
          <mat-icon>cloud_upload</mat-icon>
          Importing Files
        </h2>
        <div class="header-actions">
          <button mat-button (click)="minimize()" class="minimize-btn" *ngIf="state.isImporting">
            <mat-icon>minimize</mat-icon>
            <span>Minimize</span>
          </button>
          <button mat-icon-button (click)="close()" class="close-btn" *ngIf="!state.isImporting">
            <mat-icon>close</mat-icon>
          </button>
        </div>
      </div>

      <div class="content">
        <!-- Progress Overview -->
        <div class="progress-overview">
          <div class="stats">
            <div class="stat success">
              <mat-icon>check_circle</mat-icon>
              <span>{{ state.completedItems }}</span>
            </div>
            <div class="stat pending">
              <mat-icon>schedule</mat-icon>
              <span>{{ pendingCount }}</span>
            </div>
            <div class="stat error" *ngIf="state.errorItems > 0">
              <mat-icon>error</mat-icon>
              <span>{{ state.errorItems }}</span>
            </div>
          </div>

          <div class="progress-text">
            <span class="batch-info" *ngIf="state.isImporting">
              Batch {{ state.currentBatch }} of {{ state.totalBatches }}
            </span>
            <span class="complete-info" *ngIf="!state.isImporting">
              Import Complete
            </span>
          </div>

          <mat-progress-bar
            mode="determinate"
            [value]="progressPercent"
            [color]="state.errorItems > 0 ? 'warn' : 'primary'">
          </mat-progress-bar>
        </div>

        <!-- File List (scrollable) -->
        <div class="file-list">
          <div class="file-item"
               *ngFor="let item of visibleItems"
               [class.importing]="item.status === 'importing'"
               [class.completed]="item.status === 'completed'"
               [class.error]="item.status === 'error'">

            <mat-icon class="status-icon">
              <ng-container [ngSwitch]="item.status">
                <ng-container *ngSwitchCase="'pending'">schedule</ng-container>
                <ng-container *ngSwitchCase="'importing'">
                  <mat-icon class="spinning">sync</mat-icon>
                </ng-container>
                <ng-container *ngSwitchCase="'completed'">check_circle</ng-container>
                <ng-container *ngSwitchCase="'error'">error</ng-container>
              </ng-container>
            </mat-icon>

            <div class="file-info">
              <div class="filename">{{ item.filename }}</div>
              <div class="error-msg" *ngIf="item.error">{{ item.error }}</div>
            </div>
          </div>

          <div class="more-items" *ngIf="hiddenItemCount > 0">
            + {{ hiddenItemCount }} more files...
          </div>
        </div>
      </div>

      <div class="actions">
        <button mat-button (click)="close()" *ngIf="!state.isImporting">
          Close
        </button>
        <button mat-button (click)="cancel()" *ngIf="state.isImporting" color="warn">
          Cancel
        </button>
      </div>
    </div>
  `,
  styles: [`
    .import-dialog {
      width: 500px;
      max-height: 600px;
      display: flex;
      flex-direction: column;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 16px 8px 16px;
      border-bottom: 1px solid #e0e0e0;

      h2 {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0;
        font-size: 20px;
        font-weight: 500;

        mat-icon {
          color: #ff8f47;
        }
      }

      .header-actions {
        display: flex;
        gap: 8px;

        .minimize-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          color: #666;
          font-size: 13px;

          mat-icon {
            font-size: 20px;
            width: 20px;
            height: 20px;
          }

          &:hover {
            background: rgba(0, 0, 0, 0.05);
          }
        }

        .close-btn {
          width: 32px;
          height: 32px;
        }
      }
    }

    .content {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .progress-overview {
      padding: 16px;
      background: #f9f9f9;
      border-bottom: 1px solid #e0e0e0;
      flex-shrink: 0;

      .stats {
        display: flex;
        gap: 24px;
        margin-bottom: 12px;

        .stat {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 16px;
          font-weight: 600;

          &.success {
            color: #4caf50;
          }

          &.pending {
            color: #ff9800;
          }

          &.error {
            color: #f44336;
          }

          mat-icon {
            font-size: 20px;
            width: 20px;
            height: 20px;
          }
        }
      }

      .progress-text {
        margin-bottom: 8px;
        font-size: 13px;
        color: #666;
        min-height: 18px;

        .batch-info {
          font-weight: 500;
        }

        .complete-info {
          font-weight: 600;
          color: #4caf50;
        }
      }

      mat-progress-bar {
        height: 6px;
        border-radius: 3px;
      }
    }

    .file-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      min-height: 0;

      .file-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        margin-bottom: 4px;
        background: white;
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        transition: all 0.3s ease-out;
        animation: slideIn 0.3s ease-out;

        &.importing {
          background: #fff8e1;
          border-color: #ffa726;

          .status-icon {
            color: #ff9800;
          }
        }

        &.completed {
          background: #e8f5e9;
          border-color: #66bb6a;
          opacity: 0.8;

          .status-icon {
            color: #4caf50;
          }
        }

        &.error {
          background: #ffebee;
          border-color: #ef5350;

          .status-icon {
            color: #f44336;
          }
        }

        .status-icon {
          flex-shrink: 0;
          font-size: 20px;
          width: 20px;
          height: 20px;

          .spinning {
            animation: spin 1s linear infinite;
          }
        }

        .file-info {
          flex: 1;
          min-width: 0;

          .filename {
            font-size: 14px;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #333;
          }

          .error-msg {
            font-size: 12px;
            color: #f44336;
            margin-top: 4px;
          }
        }
      }

      .more-items {
        text-align: center;
        padding: 12px;
        color: #999;
        font-size: 13px;
        font-style: italic;
      }
    }

    .actions {
      padding: 12px 16px;
      border-top: 1px solid #e0e0e0;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-shrink: 0;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* Dark mode */
    :host-context(.dark-theme),
    :host-context(.theme-dark) {
      .header {
        border-bottom-color: #444;

        .header-actions {
          .minimize-btn {
            color: #e0e0e0;

            &:hover {
              background: rgba(255, 255, 255, 0.1);
              color: white;
            }
          }
        }
      }

      .progress-overview {
        background: #2a2a2a;
        border-bottom-color: #444;

        .progress-text {
          color: #999;
        }
      }

      .file-list {
        .file-item {
          background: #2d2d2d;
          border-color: #444;

          .filename {
            color: #e0e0e0;
          }

          &.importing {
            background: #3d3520;
            border-color: #ffa726;
          }

          &.completed {
            background: #1f3d20;
            border-color: #66bb6a;
          }

          &.error {
            background: #3d1f20;
            border-color: #ef5350;
          }
        }

        .more-items {
          color: #666;
        }
      }

      .actions {
        border-top-color: #444;
      }
    }
  `]
})
export class ImportQueueDialogComponent implements OnInit, OnDestroy {
  state: ImportQueueState = {
    items: [],
    totalItems: 0,
    completedItems: 0,
    errorItems: 0,
    isImporting: false,
    currentBatch: 0,
    totalBatches: 0,
    isMinimized: false
  };

  private destroy$ = new Subject<void>();
  private readonly MAX_VISIBLE_ITEMS = 20;
  private readonly COMPLETED_ITEMS_TO_KEEP = 5; // Show last 5 completed items

  constructor(
    private dialogRef: MatDialogRef<ImportQueueDialogComponent>,
    private importQueueService: ImportQueueService,
    @Inject(MAT_DIALOG_DATA) public data: { filePaths: string[] }
  ) {}

  ngOnInit() {
    // Subscribe to queue state
    this.importQueueService.getQueueState()
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.state = state;
      });

    // Subscribe to completion event
    this.importQueueService.getImportCompleteEvent()
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        // Auto-close after 2 seconds on completion
        setTimeout(() => {
          if (!this.state.isImporting) {
            this.close();
          }
        }, 2000);
      });

    // Start import
    if (this.data.filePaths && this.data.filePaths.length > 0) {
      this.importQueueService.queueImport(this.data.filePaths);
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get progressPercent(): number {
    if (this.state.totalItems === 0) return 0;
    const processed = this.state.completedItems + this.state.errorItems;
    return (processed / this.state.totalItems) * 100;
  }

  get pendingCount(): number {
    return this.state.items.filter(i => i.status === 'pending' || i.status === 'importing').length;
  }

  get visibleItems(): ImportItem[] {
    // Show a rolling window: last N completed + all importing + next pending items
    const items = this.state.items;

    // Find indices
    const completedItems = items.filter(i => i.status === 'completed' || i.status === 'error');
    const importingItems = items.filter(i => i.status === 'importing');
    const pendingItems = items.filter(i => i.status === 'pending');

    // Build rolling window
    const visible: ImportItem[] = [];

    // Add last N completed items (most recent ones)
    const recentCompleted = completedItems.slice(-this.COMPLETED_ITEMS_TO_KEEP);
    visible.push(...recentCompleted);

    // Add all importing items
    visible.push(...importingItems);

    // Add next pending items (up to max limit)
    const remainingSlots = this.MAX_VISIBLE_ITEMS - visible.length;
    const nextPending = pendingItems.slice(0, Math.max(remainingSlots, 5)); // Show at least 5 pending
    visible.push(...nextPending);

    return visible;
  }

  get hiddenItemCount(): number {
    const completed = this.state.items.filter(i => i.status === 'completed' || i.status === 'error').length;
    const pending = this.state.items.filter(i => i.status === 'pending').length;

    // Hidden = old completed items + pending items not shown
    const hiddenCompleted = Math.max(0, completed - this.COMPLETED_ITEMS_TO_KEEP);
    const hiddenPending = Math.max(0, pending - this.visibleItems.filter(i => i.status === 'pending').length);

    return hiddenCompleted + hiddenPending;
  }

  minimize() {
    // Set minimized state
    this.importQueueService.setMinimized(true);
    // Close dialog but keep import running in background
    this.dialogRef.close({ minimized: true });
  }

  cancel() {
    this.importQueueService.cancelImport();
    this.dialogRef.close({ cancelled: true });
  }

  close() {
    this.importQueueService.setMinimized(false);
    this.dialogRef.close({ success: this.state.completedItems, errors: this.state.errorItems });
  }
}
