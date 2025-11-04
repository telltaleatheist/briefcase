import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

export interface TranscriptMatch {
  index: number;
  text: string;
  context: string;
  timestamp?: number; // Timestamp in seconds if we can parse it from SRT
}

@Component({
  selector: 'app-transcript-search',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './transcript-search.component.html',
  styleUrls: ['./transcript-search.component.scss']
})
export class TranscriptSearchComponent implements OnInit, OnDestroy {
  @Input() transcriptText: string | null = null;
  @Input() transcriptExists = false;
  @Output() seekToTime = new EventEmitter<number>();
  @Output() runAnalysis = new EventEmitter<void>();

  searchQuery = '';
  matches: TranscriptMatch[] = [];
  isSearching = false;
  selectedMatchIndex = -1;

  private searchSubject = new Subject<string>();

  ngOnInit() {
    // Debounce search input
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged()
      )
      .subscribe(query => {
        this.performSearch(query);
      });
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  onSearchInput() {
    this.searchSubject.next(this.searchQuery);
  }

  performSearch(query: string) {
    if (!query || !this.transcriptText) {
      this.matches = [];
      return;
    }

    this.isSearching = true;
    this.matches = [];

    try {
      // Split transcript into lines
      const lines = this.transcriptText.split('\n');
      const regex = new RegExp(query, 'gi');

      // Search through each line
      lines.forEach((line, lineIndex) => {
        let match;
        while ((match = regex.exec(line)) !== null) {
          const startIdx = Math.max(0, match.index - 50);
          const endIdx = Math.min(line.length, match.index + query.length + 50);
          const context = line.substring(startIdx, endIdx);

          this.matches.push({
            index: this.matches.length,
            text: match[0],
            context: startIdx > 0 ? '...' + context : context,
            timestamp: this.extractTimestamp(lines, lineIndex)
          });
        }
      });
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      this.isSearching = false;
    }
  }

  /**
   * Try to extract timestamp from preceding lines (SRT format detection)
   */
  private extractTimestamp(lines: string[], currentIndex: number): number | undefined {
    // Look backwards for a timestamp in SRT format (HH:MM:SS,mmm --> HH:MM:SS,mmm)
    for (let i = currentIndex - 1; i >= Math.max(0, currentIndex - 5); i--) {
      const line = lines[i];
      const timestampMatch = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/);
      if (timestampMatch) {
        const hours = parseInt(timestampMatch[1], 10);
        const minutes = parseInt(timestampMatch[2], 10);
        const seconds = parseInt(timestampMatch[3], 10);
        const milliseconds = parseInt(timestampMatch[4], 10);
        return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
      }
    }
    return undefined;
  }

  onMatchClick(match: TranscriptMatch) {
    this.selectedMatchIndex = match.index;
    if (match.timestamp !== undefined) {
      this.seekToTime.emit(match.timestamp);
    }
  }

  clearSearch() {
    this.searchQuery = '';
    this.matches = [];
    this.selectedMatchIndex = -1;
  }

  onRunAnalysis() {
    this.runAnalysis.emit();
  }

  formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
