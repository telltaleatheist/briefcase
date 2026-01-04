import { Component, input, output, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CustomMarker, TimelineChapter } from '../../../models/video-editor.model';

export type MarkerType = 'marker' | 'chapter';

export interface MarkerDialogData {
  videoId: string;
  startTime: number;
  endTime?: number;
  marker?: CustomMarker; // For editing existing marker
  chapter?: TimelineChapter; // For editing existing chapter
  initialType?: MarkerType; // Pre-select type when opening
}

@Component({
  selector: 'app-marker-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './marker-dialog.component.html',
  styleUrls: ['./marker-dialog.component.scss']
})
export class MarkerDialogComponent implements OnInit {
  // Inputs
  data = input.required<MarkerDialogData>();

  // Outputs
  save = output<Partial<CustomMarker>>();
  saveChapter = output<Partial<TimelineChapter>>();
  cancel = output<void>();
  delete = output<string>(); // marker id
  deleteChapter = output<string>(); // chapter id

  // Form fields
  markerType = signal<MarkerType>('marker');
  message = signal('');
  title = signal(''); // For chapters
  category = signal('marker');
  isRange = signal(false);

  // Available marker categories
  categories = [
    { value: 'marker', label: 'Marker', color: '#3b82f6' },
    { value: 'highlight', label: 'Highlight', color: '#f59e0b' },
    { value: 'note', label: 'Note', color: '#8b5cf6' },
    { value: 'todo', label: 'To-Do', color: '#ef4444' },
    { value: 'important', label: 'Important', color: '#10b981' }
  ];

  ngOnInit() {
    const dialogData = this.data();

    // Check if editing existing chapter
    if (dialogData.chapter) {
      this.markerType.set('chapter');
      this.title.set(dialogData.chapter.title);
      this.message.set(dialogData.chapter.description || '');
      this.isRange.set(true); // Chapters always have a range
    }
    // Check if editing existing marker
    else if (dialogData.marker) {
      this.markerType.set('marker');
      this.message.set(dialogData.marker.message);
      this.category.set(dialogData.marker.category || 'marker');
      this.isRange.set(!!dialogData.marker.endTime);
    }
    // New item
    else {
      this.markerType.set(dialogData.initialType || 'marker');
      this.isRange.set(!!dialogData.endTime && dialogData.endTime !== dialogData.startTime);
    }
  }

  get isEditingMarker(): boolean {
    return !!this.data().marker;
  }

  get isEditingChapter(): boolean {
    return !!this.data().chapter;
  }

  get isEditing(): boolean {
    return this.isEditingMarker || this.isEditingChapter;
  }

  get dialogTitle(): string {
    if (this.isEditingChapter) return 'Edit Chapter';
    if (this.isEditingMarker) return 'Edit Marker';
    return this.markerType() === 'chapter' ? 'Add Chapter' : 'Add Marker';
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  get startTimeFormatted(): string {
    return this.formatTime(this.data().startTime);
  }

  get endTimeFormatted(): string {
    const endTime = this.data().endTime;
    return endTime ? this.formatTime(endTime) : '';
  }

  getCategoryColor(categoryValue: string): string {
    const cat = this.categories.find(c => c.value === categoryValue);
    return cat?.color || '#3b82f6';
  }

  get canSave(): boolean {
    if (this.markerType() === 'chapter') {
      return !!this.title().trim();
    }
    return !!this.message().trim();
  }

  onSave() {
    const dialogData = this.data();

    if (this.markerType() === 'chapter') {
      // Save as chapter
      const chapter: Partial<TimelineChapter> = {
        videoId: dialogData.videoId,
        startTime: dialogData.startTime,
        endTime: dialogData.endTime || dialogData.startTime + 60, // Default 1 min if no end time
        title: this.title(),
        description: this.message() || undefined,
        source: 'user'
      };

      if (dialogData.chapter) {
        chapter.id = dialogData.chapter.id;
        chapter.sequence = dialogData.chapter.sequence;
      }

      this.saveChapter.emit(chapter);
    } else {
      // Save as marker
      const marker: Partial<CustomMarker> = {
        videoId: dialogData.videoId,
        startTime: dialogData.startTime,
        message: this.message(),
        category: this.category()
      };

      if (this.isRange() && dialogData.endTime) {
        marker.endTime = dialogData.endTime;
      }

      if (dialogData.marker) {
        marker.id = dialogData.marker.id;
      }

      this.save.emit(marker);
    }
  }

  onCancel() {
    this.cancel.emit();
  }

  onDelete() {
    if (this.isEditingChapter) {
      const chapter = this.data().chapter;
      if (chapter) {
        this.deleteChapter.emit(chapter.id);
      }
    } else {
      const marker = this.data().marker;
      if (marker) {
        this.delete.emit(marker.id);
      }
    }
  }
}
