import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimelineSectionsLayerComponent } from '../timeline-sections-layer/timeline-sections-layer.component';
import { TimelineChaptersLayerComponent } from '../timeline-chapters-layer/timeline-chapters-layer.component';
import { TimelineMuteLayerComponent, MuteResizeEvent } from '../timeline-mute-layer/timeline-mute-layer.component';
import { TimelineWaveformComponent } from '../timeline-waveform/timeline-waveform.component';
import { TimelineSection, TimelineChapter, MuteSection, ZoomState, WaveformData, TimelineSelection } from '../../../../models/video-editor.model';

@Component({
  selector: 'app-timeline-track',
  standalone: true,
  imports: [
    CommonModule,
    TimelineSectionsLayerComponent,
    TimelineChaptersLayerComponent,
    TimelineMuteLayerComponent,
    TimelineWaveformComponent
  ],
  templateUrl: './timeline-track.component.html',
  styleUrls: ['./timeline-track.component.scss']
})
export class TimelineTrackComponent {
  @Input() sections: TimelineSection[] = [];
  @Input() chapters: TimelineChapter[] = [];
  @Input() muteSections: MuteSection[] = [];
  @Input() duration: number = 0;
  @Input() currentTime: number = 0;
  @Input() zoomState: ZoomState = { level: 1, offset: 0 };
  @Input() selectedSection: TimelineSection | undefined;
  @Input() selectedChapterId?: string;
  @Input() selectedMuteSection?: MuteSection;
  @Input() waveformData: WaveformData = { samples: [], sampleRate: 44100, duration: 0 };
  @Input() waveformColor: string = '#ff6b35';

  // Selection highlight inputs
  @Input() selection: TimelineSelection | null = null;

  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() sectionHover = new EventEmitter<TimelineSection | null>();
  @Output() chapterClick = new EventEmitter<TimelineChapter>();
  @Output() chapterHover = new EventEmitter<TimelineChapter | null>();
  @Output() muteSectionClick = new EventEmitter<MuteSection>();
  @Output() muteSectionDelete = new EventEmitter<MuteSection>();
  @Output() muteSectionResizeStart = new EventEmitter<MuteResizeEvent>();
  @Output() selectionHandleStart = new EventEmitter<{ event: MouseEvent; handle: 'left' | 'right' }>();
  @Output() selectionDragStart = new EventEmitter<MouseEvent>();

  onSectionClick(section: TimelineSection) {
    this.sectionClick.emit(section);
  }

  onSectionHover(section: TimelineSection | null) {
    this.sectionHover.emit(section);
  }

  onChapterClick(chapter: TimelineChapter) {
    this.chapterClick.emit(chapter);
  }

  onChapterHover(chapter: TimelineChapter | null) {
    this.chapterHover.emit(chapter);
  }

  onMuteSectionClick(section: MuteSection) {
    this.muteSectionClick.emit(section);
  }

  onMuteSectionDelete(section: MuteSection) {
    this.muteSectionDelete.emit(section);
  }

  onMuteSectionResizeStart(event: MuteResizeEvent) {
    this.muteSectionResizeStart.emit(event);
  }

  onSelectionHandleMouseDown(event: MouseEvent, handle: 'left' | 'right') {
    event.stopPropagation();
    this.selectionHandleStart.emit({ event, handle });
  }

  onSelectionDragMouseDown(event: MouseEvent) {
    event.stopPropagation();
    this.selectionDragStart.emit(event);
  }

  // Calculate selection position based on zoom state
  getSelectionLeft(): number {
    if (!this.selection || this.duration === 0) return 0;

    const visibleStart = this.zoomState.offset;
    const visibleDuration = this.duration / this.zoomState.level;

    // Guard against invalid visibleDuration
    if (!isFinite(visibleDuration) || visibleDuration <= 0) return 0;

    // Calculate position relative to visible area
    const relativeStart = (this.selection.startTime - visibleStart) / visibleDuration;
    return Math.max(0, relativeStart * 100);
  }

  getSelectionWidth(): number {
    if (!this.selection || this.duration === 0) return 0;

    const visibleDuration = this.duration / this.zoomState.level;

    // Guard against invalid visibleDuration
    if (!isFinite(visibleDuration) || visibleDuration <= 0) return 0;

    const selectionDuration = this.selection.endTime - this.selection.startTime;

    return (selectionDuration / visibleDuration) * 100;
  }
}