import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineChapter, ZoomState } from '../../../../models/video-editor.model';

interface ChapterStyle {
  left: string;
  width: string;
  display: string;
}

@Component({
  selector: 'app-timeline-chapters-layer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timeline-chapters-layer.component.html',
  styleUrls: ['./timeline-chapters-layer.component.scss']
})
export class TimelineChaptersLayerComponent implements OnChanges {
  @Input() chapters: TimelineChapter[] = [];
  @Input() duration: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() currentTime: number = 0;
  @Input() selectedChapterId?: string;
  @Output() chapterClick = new EventEmitter<TimelineChapter>();
  @Output() chapterHover = new EventEmitter<TimelineChapter | null>();

  chapterStyles: Map<string, ChapterStyle> = new Map();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['chapters'] || changes['duration'] || changes['zoomState']) {
      this.updateChapterStyles();
    }
  }

  private updateChapterStyles(): void {
    this.chapterStyles.clear();

    if (this.duration <= 0) return;

    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;
    const visibleEnd = visibleStart + visibleDuration;

    // Guard against invalid visibleDuration
    if (visibleDuration <= 0 || !isFinite(visibleDuration)) {
      return;
    }

    for (const chapter of this.chapters) {
      // If chapter is completely outside visible range, hide it
      if (chapter.endTime < visibleStart || chapter.startTime > visibleEnd) {
        this.chapterStyles.set(chapter.id, {
          left: '0',
          width: '0',
          display: 'none'
        });
        continue;
      }

      // Calculate visible portion of chapter
      const chapterStart = Math.max(chapter.startTime, visibleStart);
      const chapterEnd = Math.min(chapter.endTime, visibleEnd);

      const startPercentage = ((chapterStart - visibleStart) / visibleDuration) * 100;
      const endPercentage = ((chapterEnd - visibleStart) / visibleDuration) * 100;

      this.chapterStyles.set(chapter.id, {
        left: `${startPercentage}%`,
        width: `${endPercentage - startPercentage}%`,
        display: 'flex'
      });
    }
  }

  getChapterStyle(chapter: TimelineChapter): ChapterStyle {
    return this.chapterStyles.get(chapter.id) || {
      left: '0',
      width: '0',
      display: 'none'
    };
  }

  isCurrentChapter(chapter: TimelineChapter): boolean {
    return this.currentTime >= chapter.startTime && this.currentTime < chapter.endTime;
  }

  onChapterClick(chapter: TimelineChapter, event: MouseEvent): void {
    event.stopPropagation();
    this.chapterClick.emit(chapter);
  }

  onChapterMouseEnter(chapter: TimelineChapter): void {
    this.chapterHover.emit(chapter);
  }

  onChapterMouseLeave(): void {
    this.chapterHover.emit(null);
  }

  formatDuration(chapter: TimelineChapter): string {
    const duration = chapter.endTime - chapter.startTime;
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
}
