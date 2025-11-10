import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

export interface TranscriptLine {
  timestamp?: number;
  text: string;
  isTimestamp: boolean;
}

@Component({
  selector: 'app-transcript-viewer',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule
  ],
  templateUrl: './transcript-viewer.component.html',
  styleUrls: ['./transcript-viewer.component.scss']
})
export class TranscriptViewerComponent implements OnChanges {
  @Input() transcriptText: string | null = null;
  @Input() transcriptExists = false;
  @Input() currentTime = 0; // Current playback time for highlighting
  @Input() autoScrollEnabled = true; // Control auto-scroll behavior
  @Output() seekToTime = new EventEmitter<number>();
  @Output() runAnalysis = new EventEmitter<void>();

  transcriptLines: TranscriptLine[] = [];
  activeLineIndex = -1;

  // Search functionality
  searchQuery = '';
  searchResults: number[] = []; // Array of line indices that match
  currentSearchIndex = -1;

  constructor(private sanitizer: DomSanitizer) {}

  ngOnChanges(changes: SimpleChanges) {
    if (changes['transcriptText'] && this.transcriptText) {
      this.parseTranscript();
    }
    if (changes['currentTime']) {
      this.updateActiveLine();
    }
  }

  /**
   * Parse the transcript text into structured lines with timestamps
   */
  private parseTranscript() {
    if (!this.transcriptText) {
      this.transcriptLines = [];
      return;
    }

    const lines = this.transcriptText.split('\n');
    this.transcriptLines = [];
    let currentTimestamp: number | undefined = undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip empty lines and sequence numbers
      if (!line || /^\d+$/.test(line)) {
        continue;
      }

      // Check if this is a timestamp line (SRT format)
      const timestampMatch = line.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/);

      if (timestampMatch) {
        // Extract start timestamp
        const hours = parseInt(timestampMatch[1], 10);
        const minutes = parseInt(timestampMatch[2], 10);
        const seconds = parseInt(timestampMatch[3], 10);
        const milliseconds = parseInt(timestampMatch[4], 10);
        currentTimestamp = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
        continue;
      }

      // Check for simple timestamp format (MM:SS or HH:MM:SS)
      const simpleTimestampMatch = line.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (simpleTimestampMatch) {
        const part1 = parseInt(simpleTimestampMatch[1], 10);
        const part2 = parseInt(simpleTimestampMatch[2], 10);
        const part3 = simpleTimestampMatch[3] ? parseInt(simpleTimestampMatch[3], 10) : 0;

        // If there's a third part, it's HH:MM:SS
        if (simpleTimestampMatch[3]) {
          currentTimestamp = part1 * 3600 + part2 * 60 + part3;
        } else {
          // Otherwise it's MM:SS
          currentTimestamp = part1 * 60 + part2;
        }
        continue;
      }

      // This is actual transcript text
      if (line.length > 0) {
        this.transcriptLines.push({
          timestamp: currentTimestamp,
          text: line,
          isTimestamp: false
        });
        currentTimestamp = undefined; // Reset for next segment
      }
    }
  }

  /**
   * Update which line is currently active based on playback time
   */
  private updateActiveLine() {
    if (this.transcriptLines.length === 0) {
      this.activeLineIndex = -1;
      return;
    }

    // Find the line closest to current time but not after it
    let closestIndex = -1;
    let closestDiff = Infinity;

    for (let i = 0; i < this.transcriptLines.length; i++) {
      const line = this.transcriptLines[i];
      if (line.timestamp !== undefined) {
        const diff = this.currentTime - line.timestamp;
        // Only consider lines that have already been spoken (diff >= 0)
        // and find the one with smallest difference
        if (diff >= 0 && diff < closestDiff) {
          closestDiff = diff;
          closestIndex = i;
        }
      }
    }

    if (closestIndex !== this.activeLineIndex) {
      this.activeLineIndex = closestIndex;

      // Auto-scroll to active line (always when auto-scroll is enabled)
      this.scrollToActiveLine();
    } else if (this.autoScrollEnabled && closestIndex >= 0) {
      // Even if the index hasn't changed, ensure it's visible when auto-scroll is on
      this.scrollToActiveLine();
    }
  }

  /**
   * Scroll to the active line
   */
  private scrollToActiveLine() {
    if (!this.autoScrollEnabled || this.activeLineIndex < 0) {
      return;
    }

    setTimeout(() => {
      const activeElement = document.getElementById(`transcript-line-${this.activeLineIndex}`);
      if (activeElement) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }

  /**
   * Handle click on a transcript line with timestamp
   */
  onLineClick(line: TranscriptLine, index: number) {
    if (line.timestamp !== undefined) {
      this.seekToTime.emit(line.timestamp);
      this.activeLineIndex = index;
    }
  }

  /**
   * Format timestamp for display
   */
  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Handle run analysis button click
   */
  onRunAnalysis() {
    this.runAnalysis.emit();
  }

  /**
   * Check if a line is active
   */
  isLineActive(index: number): boolean {
    return this.activeLineIndex === index;
  }

  /**
   * Check if a line has a clickable timestamp
   */
  hasTimestamp(line: TranscriptLine): boolean {
    return line.timestamp !== undefined;
  }

  /**
   * Handle search input
   */
  onSearchInput() {
    if (!this.searchQuery.trim()) {
      this.clearSearch();
      return;
    }

    this.searchResults = [];
    const query = this.searchQuery.toLowerCase();

    this.transcriptLines.forEach((line, index) => {
      if (line.text.toLowerCase().includes(query)) {
        this.searchResults.push(index);
      }
    });

    if (this.searchResults.length > 0) {
      this.currentSearchIndex = 0;
      this.scrollToSearchResult(this.searchResults[0]);
    } else {
      this.currentSearchIndex = -1;
    }
  }

  /**
   * Clear search
   */
  clearSearch() {
    this.searchQuery = '';
    this.searchResults = [];
    this.currentSearchIndex = -1;
  }

  /**
   * Navigate to next search result
   */
  nextSearchResult() {
    if (this.searchResults.length === 0) return;

    this.currentSearchIndex = (this.currentSearchIndex + 1) % this.searchResults.length;
    this.scrollToSearchResult(this.searchResults[this.currentSearchIndex]);
  }

  /**
   * Navigate to previous search result
   */
  previousSearchResult() {
    if (this.searchResults.length === 0) return;

    this.currentSearchIndex = this.currentSearchIndex - 1;
    if (this.currentSearchIndex < 0) {
      this.currentSearchIndex = this.searchResults.length - 1;
    }
    this.scrollToSearchResult(this.searchResults[this.currentSearchIndex]);
  }

  /**
   * Scroll to a specific search result
   */
  private scrollToSearchResult(lineIndex: number) {
    setTimeout(() => {
      const element = document.getElementById(`transcript-line-${lineIndex}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  }

  /**
   * Check if a line index is a search result
   */
  isSearchResult(index: number): boolean {
    return this.searchResults.includes(index);
  }

  /**
   * Check if a line index is the current search result
   */
  isCurrentSearchResult(index: number): boolean {
    return this.searchResults.length > 0 &&
           this.searchResults[this.currentSearchIndex] === index;
  }

  /**
   * Highlight search term in text
   */
  highlightSearchTerm(text: string, lineIndex: number): SafeHtml {
    if (!this.searchQuery || !this.searchResults.includes(lineIndex)) {
      return text;
    }

    const query = this.searchQuery.trim();
    const regex = new RegExp(`(${query})`, 'gi');
    const highlighted = text.replace(regex, '<mark>$1</mark>');
    return this.sanitizer.bypassSecurityTrustHtml(highlighted);
  }
}
