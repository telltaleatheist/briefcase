import { Component, output, signal, ViewChild, ElementRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LibraryService } from '../../services/library.service';

export interface UrlEntry {
  url: string;
  title: string;
  duration?: string;
  thumbnail?: string;
  loading: boolean;
}

@Component({
  selector: 'app-url-input',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './url-input.component.html',
  styleUrls: ['./url-input.component.scss']
})
export class UrlInputComponent {
  private libraryService = inject(LibraryService);

  @ViewChild('urlInput') urlInput!: ElementRef<HTMLTextAreaElement>;

  // Outputs
  urlsAdded = output<UrlEntry[]>();

  // State
  inputValue = signal('');
  isProcessing = signal(false);

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.processInput();
    }
  }

  onPaste(event: ClipboardEvent): void {
    // Let the paste happen, then process after a brief delay
    setTimeout(() => {
      this.processInput();
    }, 0);
  }

  async processInput(): Promise<void> {
    const value = this.inputValue();
    if (!value.trim()) return;

    // Split by newlines and filter valid URLs
    const lines = value.split(/[\r\n]+/).map(line => line.trim()).filter(line => line);
    const urls = lines.filter(line => this.isValidUrl(line));

    if (urls.length === 0) return;

    // Emit URLs immediately with placeholder titles
    const entries: UrlEntry[] = urls.map(url => ({
      url,
      title: this.extractNameFromUrl(url),
      loading: true
    }));

    this.urlsAdded.emit(entries);

    // Clear the input immediately
    this.inputValue.set('');
    // Also clear the native element to ensure it updates
    if (this.urlInput) {
      this.urlInput.nativeElement.value = '';
    }

    // Fetch actual metadata in background and emit updates
    urls.forEach(async (url, index) => {
      try {
        const info = await this.fetchVideoInfo(url);
        // Emit update with fetched metadata (title, duration, thumbnail)
        if (info.title && (info.title !== entries[index].title || info.duration || info.thumbnail)) {
          this.urlsAdded.emit([{
            url,
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            loading: false
          }]);
        }
      } catch (error) {
        console.error('Failed to fetch video info for:', url, error);
      }
    });
  }

  private async fetchVideoInfo(url: string): Promise<{ title: string; duration?: string; thumbnail?: string }> {
    return new Promise((resolve, reject) => {
      this.libraryService.getVideoInfo(url).subscribe({
        next: (response) => {
          if (response.success && response.data) {
            resolve({
              title: response.data.title,
              duration: response.data.duration ? this.formatDuration(response.data.duration) : undefined,
              thumbnail: response.data.thumbnail
            });
          } else {
            reject(new Error('Failed to fetch video info'));
          }
        },
        error: (error) => reject(error)
      });
    });
  }

  // Format duration from seconds to HH:MM:SS or MM:SS
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  private isValidUrl(string: string): boolean {
    try {
      const url = new URL(string);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private extractNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const segments = pathname.split('/').filter(s => s);

      // For YouTube-like URLs, use the video parameter
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        return `Video ${videoId}`;
      }

      // Use last path segment or hostname
      if (segments.length > 0) {
        return segments[segments.length - 1];
      }

      return urlObj.hostname;
    } catch {
      return 'Unknown Video';
    }
  }

  // Public method to focus the input
  focus(): void {
    if (this.urlInput) {
      this.urlInput.nativeElement.focus();
    }
  }
}
