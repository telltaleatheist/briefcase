// clippy/frontend/src/app/components/download-history/download-history.component.ts
import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ApiService } from '../../services/api.service';
import { SocketService } from '../../services/socket.service';
import { NotificationService } from '../../services/notification.service';
import { HistoryItem } from '../../models/download.model';
import { Subscription } from 'rxjs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-download-history',
  templateUrl: './download-history.component.html',
  styleUrls: ['./download-history.component.scss'],
  standalone: true,  // Add this line
  imports: [
    CommonModule,
    MatDialogModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule
  ]
})
export class DownloadHistoryComponent implements OnInit, OnDestroy {
  private apiService = inject(ApiService);
  private socketService = inject(SocketService);
  private notificationService = inject(NotificationService);
  private dialog = inject(MatDialog);

  historyItems: HistoryItem[] = [];
  isLoading = true;
  private historySubscription: Subscription | null = null;

  ngOnInit(): void {
    this.loadHistory();

    this.historySubscription = this.socketService.onDownloadHistoryUpdated()
      .subscribe((history: HistoryItem[]) => {
        this.historyItems = history;
      });
  }

  ngOnDestroy(): void {
    this.historySubscription?.unsubscribe();
  }

  loadHistory(): void {
    this.isLoading = true;
    this.apiService.getDownloadHistory().subscribe({
      next: (history) => {
        this.historyItems = history;
        this.isLoading = false;
      },
      error: () => {
        this.notificationService.toastOnly('error', 'Load Failed', 'Failed to load download history');
        this.isLoading = false;
      }
    });
  }

  formatFileSize(size: number | undefined): string {
    if (!size) return 'Unknown';

    const units = ['B', 'KB', 'MB', 'GB'];
    let fileSize = size;
    let unitIndex = 0;

    while (fileSize >= 1024 && unitIndex < units.length - 1) {
      fileSize /= 1024;
      unitIndex++;
    }

    return `${fileSize.toFixed(1)} ${units[unitIndex]}`;
  }

  downloadFile(item: HistoryItem): void {
    const downloadUrl = this.apiService.getFileUrl(item.id);
    window.open(downloadUrl, '_blank');
  }

  streamFile(item: HistoryItem): void {
    const streamUrl = this.apiService.getStreamUrl(item.id);
    window.open(streamUrl, '_blank');
  }

  removeFromHistory(item: HistoryItem, event: Event): void {
    event.stopPropagation();

    this.apiService.removeFromHistory(item.id).subscribe({
      next: (result) => {
        if (result.success) {
          this.historyItems = this.historyItems.filter(i => i.id !== item.id);
          this.notificationService.toastOnly('success', 'Item Removed', 'Removed from history');
        } else {
          this.notificationService.toastOnly('error', 'Removal Failed', 'Failed to remove item');
        }
      },
      error: () => {
        this.notificationService.toastOnly('error', 'Removal Error', 'Error removing item');
      }
    });
  }

  clearHistory(): void {
    if (confirm('Are you sure you want to clear the download history?')) {
      this.apiService.clearHistory().subscribe({
        next: (result) => {
          if (result.success) {
            this.historyItems = [];
            this.notificationService.toastOnly('success', 'History Cleared', 'Download history cleared');
          } else {
            this.notificationService.toastOnly('error', 'Clear Failed', 'Failed to clear history');
          }
        },
        error: () => {
          this.notificationService.toastOnly('error', 'Clear Error', 'Error clearing history');
        }
      });
    }
  }
}
