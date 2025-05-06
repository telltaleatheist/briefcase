// clippy/frontend/src/app/components/download-progress/download-progress.component.ts
import { Component, OnInit, OnDestroy, ChangeDetectorRef, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatIconModule } from '@angular/material/icon';

import { SocketService } from '../../services/socket.service';
import { DownloadProgress } from '../../models/download.model';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-download-progress',
  templateUrl: './download-progress.component.html',
  styleUrls: ['./download-progress.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatProgressBarModule,
    MatIconModule
  ]
})
export class DownloadProgressComponent implements OnInit, OnDestroy {
  @Input() jobId?: string;
  
  progress = 0;
  task = 'Preparing download...';
  isConnected = true;
  
  private downloadSubscription: Subscription | null = null;
  private processingSubscription: Subscription | null = null;
  private connectionSubscription: Subscription | null = null;

  constructor(
    private cdr: ChangeDetectorRef,
    private socketService: SocketService
  ) {}

  ngOnInit(): void {
    this.connectionSubscription = this.socketService.getConnectionStatus().subscribe(isConnected => {
      this.isConnected = isConnected;
      if (!isConnected) {
        this.task = 'Connection lost. Trying to reconnect...';
      }
      this.cdr.detectChanges();
    });
    
    // Download progress events
    this.downloadSubscription = this.socketService.onDownloadProgress().subscribe((data: DownloadProgress) => {
      
      // Only update if no jobId is set or if the jobId matches
      if (!this.jobId || (data.jobId && data.jobId === this.jobId)) {
        this.updateProgress(data.progress, data.task || 'Downloading...');
      }
    });

    // Processing progress events  
    this.processingSubscription = this.socketService.onProcessingProgress().subscribe((data: DownloadProgress) => {

      if (!this.jobId || (data.jobId && data.jobId === this.jobId)) {
        this.updateProgress(data.progress, data.task || 'Processing video...');
      }
    });
    
    // Initialize with last known progress if we have a jobId
    if (this.jobId) {
      const lastProgress = this.socketService.getLastKnownProgress(this.jobId);
      if (lastProgress) {
        this.updateProgress(lastProgress.progress, lastProgress.task || 'Processing...');
      }
    }
  }
  
  /**
   * Update progress and trigger change detection
   */
  private updateProgress(progress: number, task: string): void {
    // Ensure progress is a valid number and within range
    this.progress = Math.max(0, Math.min(100, Number(progress) || 0));
    this.task = task || 'Processing...';
    
    // Force change detection
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    if (this.downloadSubscription) {
      this.downloadSubscription.unsubscribe();
    }
    if (this.processingSubscription) {
      this.processingSubscription.unsubscribe();
    }
    if (this.connectionSubscription) {
      this.connectionSubscription.unsubscribe();
    }
  }
}