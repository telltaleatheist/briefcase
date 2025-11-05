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
      const seenLines = new Set<number>(); // Track lines we've already added

      // Search through each line
      lines.forEach((line, lineIndex) => {
        // Skip if we've already found a match in this line
        if (seenLines.has(lineIndex)) {
          return;
        }

        const match = regex.exec(line);
        if (match) {
          seenLines.add(lineIndex);
          const startIdx = Math.max(0, match.index - 50);
          const endIdx = Math.min(line.length, match.index + query.length + 50);
          const context = line.substring(startIdx, endIdx);
          const timestamp = this.extractTimestamp(lines, lineIndex);

          console.log('Found match on line', lineIndex, 'with timestamp:', timestamp);

          this.matches.push({
            index: this.matches.length,
            text: match[0],
            context: startIdx > 0 ? '...' + context : context,
            timestamp: timestamp
          });
        }
        // Reset regex lastIndex for next line
        regex.lastIndex = 0;
      });

      console.log('Total matches found:', this.matches.length);
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
    // or also check for just the start timestamp (HH:MM:SS,mmm)
    for (let i = currentIndex - 1; i >= Math.max(0, currentIndex - 10); i--) {
      const line = lines[i];

      // Try SRT format with arrow
      let timestampMatch = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/);

      // If not found, try just timestamp at start of line
      if (!timestampMatch) {
        timestampMatch = line.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      }

      // Also try without milliseconds (MM:SS format)
      if (!timestampMatch) {
        timestampMatch = line.match(/^(\d{1,2}):(\d{2})/);
        if (timestampMatch) {
          const minutes = parseInt(timestampMatch[1], 10);
          const seconds = parseInt(timestampMatch[2], 10);
          return minutes * 60 + seconds;
        }
      }

      if (timestampMatch && timestampMatch.length >= 4) {
        const hours = parseInt(timestampMatch[1], 10);
        const minutes = parseInt(timestampMatch[2], 10);
        const seconds = parseInt(timestampMatch[3], 10);
        const milliseconds = timestampMatch[4] ? parseInt(timestampMatch[4], 10) : 0;
        const timestamp = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        console.log('Extracted timestamp', timestamp, 'from line', i, ':', line);
        return timestamp;
      }
    }
    console.log('No timestamp found for line', currentIndex);
    return undefined;
  }

  onMatchClick(match: TranscriptMatch) {
    console.log('Match clicked:', match);
    this.selectedMatchIndex = match.index;
    if (match.timestamp !== undefined) {
      console.log('Emitting seekToTime with timestamp:', match.timestamp);
      this.seekToTime.emit(match.timestamp);
    } else {
      console.warn('Match has no timestamp:', match);
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
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}
