import { Component, input, output, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CustomMarker } from '../../../models/video-editor.model';

export interface MarkerDialogData {
  videoId: string;
  startTime: number;
  endTime?: number;
  marker?: CustomMarker; // For editing existing marker
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
  cancel = output<void>();
  delete = output<string>(); // marker id

  // Form fields
  message = signal('');
  category = signal('marker');
  isRange = signal(false);

  // Available categories
  categories = [
    { value: 'marker', label: 'Marker', color: '#3b82f6' },
    { value: 'highlight', label: 'Highlight', color: '#f59e0b' },
    { value: 'note', label: 'Note', color: '#8b5cf6' },
    { value: 'todo', label: 'To-Do', color: '#ef4444' },
    { value: 'important', label: 'Important', color: '#10b981' }
  ];

  ngOnInit() {
    const dialogData = this.data();
    if (dialogData.marker) {
      // Editing existing marker
      this.message.set(dialogData.marker.message);
      this.category.set(dialogData.marker.category || 'marker');
      this.isRange.set(!!dialogData.marker.endTime);
    } else {
      // New marker - check if it's a range
      this.isRange.set(!!dialogData.endTime && dialogData.endTime !== dialogData.startTime);
    }
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

  get isEditing(): boolean {
    return !!this.data().marker;
  }

  getCategoryColor(categoryValue: string): string {
    const cat = this.categories.find(c => c.value === categoryValue);
    return cat?.color || '#3b82f6';
  }

  onSave() {
    const dialogData = this.data();
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

  onCancel() {
    this.cancel.emit();
  }

  onDelete() {
    const marker = this.data().marker;
    if (marker) {
      this.delete.emit(marker.id);
    }
  }
}
