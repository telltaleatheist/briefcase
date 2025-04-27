import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
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
  progress = 0;
  task = 'Preparing download...';
  private downloadSubscription: Subscription | null = null;
  private processingSubscription: Subscription | null = null;

  constructor(
    private cdr: ChangeDetectorRef,
    private socketService: SocketService
  ) {}

  ngOnInit(): void {
    console.log('DownloadProgressComponent initialized');
    
    this.downloadSubscription = this.socketService.onDownloadProgress().subscribe((data: DownloadProgress) => {
      console.log('Received download progress:', data);
      this.progress = Math.max(0, Math.min(100, Number(data.progress)));
      this.task = data.task || 'Downloading...';
      this.cdr.detectChanges();
    });

    this.processingSubscription = this.socketService.onProcessingProgress().subscribe((data: DownloadProgress) => {
      console.log('Received processing progress:', data);
      this.progress = Math.max(0, Math.min(100, Number(data.progress)));
      this.task = data.task || 'Processing video...';
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy(): void {
    if (this.downloadSubscription) {
      this.downloadSubscription.unsubscribe();
    }
    if (this.processingSubscription) {
      this.processingSubscription.unsubscribe();
    }
  }
}