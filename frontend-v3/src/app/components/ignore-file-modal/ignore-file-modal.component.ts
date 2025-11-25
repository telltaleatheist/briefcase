import { Component, Input, Output, EventEmitter, signal, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LibraryService } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-ignore-file-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './ignore-file-modal.component.html',
  styleUrls: ['./ignore-file-modal.component.scss']
})
export class IgnoreFileModalComponent implements OnInit {
  private libraryService = inject(LibraryService);
  private notificationService = inject(NotificationService);

  @Input() show = false;
  @Output() closed = new EventEmitter<void>();

  fileContent = signal('');
  filePath = signal('');
  isLoading = signal(false);
  isScanning = signal(false);
  isSaving = signal(false);

  ngOnInit() {
    if (this.show) {
      this.loadIgnoreFile();
    }
  }

  ngOnChanges() {
    if (this.show) {
      this.loadIgnoreFile();
    }
  }

  loadIgnoreFile() {
    this.isLoading.set(true);
    this.libraryService.getIgnoreFile().subscribe({
      next: (response: any) => {
        if (response.success) {
          // Backend returns data at root level, not nested under 'data'
          this.fileContent.set(response.content || '');
          this.filePath.set(response.filePath || '');
        } else {
          this.notificationService.error('Load Failed', response.error || 'Failed to load ignore file');
        }
        this.isLoading.set(false);
      },
      error: (error) => {
        console.error('Failed to load ignore file:', error);
        this.notificationService.error('Load Failed', error.error?.error || error.message);
        this.isLoading.set(false);
      }
    });
  }

  saveChanges() {
    this.isSaving.set(true);
    this.libraryService.updateIgnoreFile(this.fileContent()).subscribe({
      next: (response) => {
        this.isSaving.set(false);
        if (response.success) {
          this.notificationService.success('Saved', 'Ignore file updated successfully');
          this.close();
        } else {
          this.notificationService.error('Save Failed', response.error || 'Failed to save ignore file');
        }
      },
      error: (error) => {
        console.error('Failed to save ignore file:', error);
        this.notificationService.error('Save Failed', error.error?.error || error.message);
        this.isSaving.set(false);
      }
    });
  }

  rescanDatabase() {
    if (!confirm('This will scan the database and remove entries that match ignore patterns. Files on disk will NOT be deleted. Continue?')) {
      return;
    }

    this.isScanning.set(true);
    this.libraryService.scanAndRemoveIgnored().subscribe({
      next: (response: any) => {
        if (response.success) {
          // Backend returns found/deleted at root level
          const count = response.deleted || 0;
          this.notificationService.success(
            'Scan Complete',
            response.message || `Removed ${count} database entr${count !== 1 ? 'ies' : 'y'}`
          );
        } else {
          this.notificationService.error('Scan Failed', response.error || 'Failed to scan database');
        }
        this.isScanning.set(false);
      },
      error: (error) => {
        console.error('Failed to scan database:', error);
        this.notificationService.error('Scan Failed', error.error?.error || error.message);
        this.isScanning.set(false);
      }
    });
  }

  close() {
    this.closed.emit();
  }

  handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }
}
