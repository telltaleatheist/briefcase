// clippy/frontend/src/app/components/download-progress/download-progress.component.ts
import { Component, OnInit, OnDestroy, inject } from '@angular/core';
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
  standalone: true,  // Add this line
  imports: [
    CommonModule,
    MatCardModule,
    MatProgressBarModule,
    MatIconModule
  ]
})
export class DownloadProgressComponent implements OnInit, OnDestroy {
  private socketService = inject(SocketService);

  progress = 0;
  task = 'Preparing download...';
  private downloadSubscription: Subscription | null = null;
  private processingSubscription: Subscription | null = null;

  ngOnInit(): void {
    this.downloadSubscription = this.socketService.onDownloadProgress().subscribe((data: DownloadProgress) => {
      this.progress = data.progress;
      this.task = data.task || 'Downloading...';
    });

    this.processingSubscription = this.socketService.onProcessingProgress().subscribe((data: DownloadProgress) => {
      this.progress = data.progress;
      this.task = data.task || 'Processing video...';
    });
  }

  ngOnDestroy(): void {
    this.downloadSubscription?.unsubscribe();
    this.processingSubscription?.unsubscribe();
  }
}
