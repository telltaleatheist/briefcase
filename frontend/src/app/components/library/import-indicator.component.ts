import { Component, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ImportQueueService, ImportQueueState } from '../../services/import-queue.service';
import { Subject, takeUntil } from 'rxjs';

/**
 * Floating import indicator - shows when import is running but dialog is minimized
 */
@Component({
  selector: 'app-import-indicator',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule
  ],
  template: `
    <button
      *ngIf="shouldShow"
      mat-fab
      color="primary"
      class="import-indicator"
      (click)="reopen.emit()"
      [class.pulse]="state.isImporting">
      <div class="indicator-content">
        <mat-icon *ngIf="state.isImporting">cloud_upload</mat-icon>
        <mat-icon *ngIf="!state.isImporting && state.errorItems === 0">check_circle</mat-icon>
        <mat-icon *ngIf="!state.isImporting && state.errorItems > 0">warning</mat-icon>

        <div class="progress-badge">
          <span class="completed">{{ state.completedItems }}</span>
          <span class="separator">/</span>
          <span class="total">{{ state.totalItems }}</span>
        </div>
      </div>

      <!-- Spinner overlay for active import -->
      <mat-spinner
        *ngIf="state.isImporting"
        diameter="60"
        class="spinner-overlay"
        color="accent">
      </mat-spinner>
    </button>
  `,
  styles: [`
    .import-indicator {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 64px !important;
      height: 64px !important;
      z-index: 1000;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      transition: all 0.3s ease;
      background: #ff8f47 !important;

      &:hover {
        transform: scale(1.1);
        box-shadow: 0 6px 20px rgba(255, 143, 71, 0.5);
      }

      &.pulse {
        animation: pulse 2s infinite;
      }

      .indicator-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        position: relative;
        z-index: 2;

        mat-icon {
          font-size: 28px;
          width: 28px;
          height: 28px;
          color: white;
          margin-bottom: 2px;
        }

        .progress-badge {
          font-size: 11px;
          font-weight: 700;
          color: white;
          display: flex;
          align-items: center;
          gap: 2px;
          line-height: 1;

          .completed {
            color: #fff;
          }

          .separator {
            opacity: 0.7;
          }

          .total {
            opacity: 0.9;
          }
        }
      }

      .spinner-overlay {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 1;
        pointer-events: none;

        ::ng-deep circle {
          stroke: white !important;
        }
      }
    }

    @keyframes pulse {
      0%, 100% {
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      }
      50% {
        box-shadow: 0 4px 16px rgba(255, 143, 71, 0.6), 0 0 0 4px rgba(255, 143, 71, 0.3);
      }
    }

    /* Dark mode */
    :host-context(.dark-theme),
    :host-context(.theme-dark) {
      .import-indicator {
        &:hover {
          box-shadow: 0 6px 20px rgba(255, 143, 71, 0.7);
        }
      }
    }
  `]
})
export class ImportIndicatorComponent implements OnInit, OnDestroy {
  @Output() reopen = new EventEmitter<void>();

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

  constructor(private importQueueService: ImportQueueService) {}

  ngOnInit() {
    this.importQueueService.getQueueState()
      .pipe(takeUntil(this.destroy$))
      .subscribe(state => {
        this.state = state;
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  get shouldShow(): boolean {
    // Show if import is in progress or just finished, AND dialog is minimized
    return this.state.isMinimized && (this.state.isImporting || this.state.completedItems > 0);
  }
}
