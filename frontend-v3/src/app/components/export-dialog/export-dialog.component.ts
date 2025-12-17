import { Component, Input, Output, EventEmitter, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';
import { CascadeComponent } from '../cascade/cascade.component';
import { VideoWeek, VideoItem } from '../../models/video.model';

export interface ExportSection {
  id: string;
  category: string;
  description: string;
  startSeconds: number;
  endSeconds: number;
  timeRange: string;
  icon?: string;
}

export interface ExportDialogData {
  sections: ExportSection[];
  selectionStart?: number;
  selectionEnd?: number;
  videoId: string;
  videoPath?: string | null;  // Optional - backend can look it up by videoId if missing
  videoTitle: string;
}

// Category colors for consistent styling
const CATEGORY_COLORS: Record<string, string> = {
  'export changes': '#22c55e',      // Green
  'current selection': '#ff6b35',   // Orange
  'routine': '#3b82f6',             // Blue
  'shocking': '#f59e0b',            // Amber
  'political-violence': '#b91c1c',  // Dark Red
  'hate': '#dc2626',                // Red
  'violence': '#ef4444',            // Red
  'extremism': '#f97316',           // Orange
  'misinformation': '#eab308',      // Yellow
  'conspiracy': '#a855f7',          // Purple
  'christian-nationalism': '#ec4899', // Pink
  'false-prophecy': '#8b5cf6',      // Violet
  'marker': '#6b7280',              // Gray
  'default': '#6c757d'
};

@Component({
  selector: 'app-export-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, CascadeComponent],
  templateUrl: './export-dialog.component.html',
  styleUrls: ['./export-dialog.component.scss']
})
export class ExportDialogComponent implements OnInit {
  @Input() data!: ExportDialogData;
  @Output() close = new EventEmitter<{ exported: boolean }>();

  // Selection state
  hasSelection = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDuration = '';
  isExporting = false;

  // Export options
  outputDirectory: string | null = null;
  reEncode = false;
  overwriteOriginal = false;

  // Export progress
  exportComplete = false;
  currentClip = 0;
  totalClips = 0;
  exportProgress = 0;
  currentClipName = '';
  successCount = 0;
  failedCount = 0;

  // Sections list configuration
  sections: ExportSection[] = [];
  selectedSectionIds = new Set<string>();

  // Cascade weeks data (sections grouped by category)
  cascadeWeeks = signal<VideoWeek[]>([]);

  // Map section IDs to ExportSection for lookup
  private sectionMap = new Map<string, ExportSection>();

  constructor(
    private http: HttpClient,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService
  ) {}

  ngOnInit() {
    // Prepare sections for cascade list
    const cascadeSections: ExportSection[] = [];

    // Always add "Export Changes" option at the top (for scale/other changes to full video)
    // Use 0 as start and a very large number as end to represent full video
    cascadeSections.push({
      id: '__full_video__',
      category: 'Export Changes',
      description: 'Export entire video with changes (scale, etc.)',
      startSeconds: 0,
      endSeconds: Number.MAX_SAFE_INTEGER, // Will be replaced with actual duration in backend
      timeRange: 'Full Video',
      icon: 'video'
    });

    // Check if there's a valid selection and add it as the first item
    if (this.data.selectionStart !== undefined && this.data.selectionEnd !== undefined) {
      const duration = this.data.selectionEnd - this.data.selectionStart;
      if (duration >= 1) {
        this.hasSelection = true;
        this.selectionStart = this.data.selectionStart;
        this.selectionEnd = this.data.selectionEnd;
        this.selectionDuration = this.formatTime(duration);

        // Add selection as a cascade list item at the top
        cascadeSections.push({
          id: '__selection__',
          category: 'Current Selection',
          description: 'Current timeline selection',
          startSeconds: this.selectionStart,
          endSeconds: this.selectionEnd,
          timeRange: `${this.formatTime(this.selectionStart)} - ${this.formatTime(this.selectionEnd)} (${this.selectionDuration})`,
          icon: 'highlight'
        });
      }
    }

    // Add marker sections
    cascadeSections.push(...this.data.sections.map(section => ({
      ...section,
      icon: 'bookmark'
    })));

    this.sections = cascadeSections;

    // Build section map for lookup
    cascadeSections.forEach(section => {
      this.sectionMap.set(section.id, section);
    });

    // Build cascadeWeeks by grouping sections by category
    this.buildCascadeWeeks(cascadeSections);
  }

  /**
   * Build VideoWeek[] grouped by category for the cascade component
   */
  private buildCascadeWeeks(sections: ExportSection[]) {
    // Group sections by category
    const categoryMap = new Map<string, ExportSection[]>();

    // Define the order of categories (special ones first)
    const categoryOrder = ['Export Changes', 'Current Selection'];

    sections.forEach(section => {
      const category = section.category;
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(section);
    });

    // Sort categories: special ones first, then alphabetically
    const sortedCategories = Array.from(categoryMap.keys()).sort((a, b) => {
      const aIndex = categoryOrder.indexOf(a);
      const bIndex = categoryOrder.indexOf(b);

      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.localeCompare(b);
    });

    // Build weeks array
    const weeks: VideoWeek[] = sortedCategories.map(category => {
      const categorySections = categoryMap.get(category)!;
      const categoryColor = this.getCategoryColor(category);

      // Convert ExportSections to VideoItems
      const videos: VideoItem[] = categorySections.map(section => ({
        id: section.id,
        name: section.description,
        duration: section.timeRange,
        tags: [`category:${section.category}`, `color:${categoryColor}`],
        suggestedTitle: section.timeRange // Show time range as secondary info
      }));

      // Get icon for category
      const icon = this.getCategoryIcon(category);

      return {
        weekLabel: `${icon} ${category}`,
        videos,
        expanded: category === 'Export Changes' || category === 'Current Selection' // Expand special categories by default
      };
    });

    this.cascadeWeeks.set(weeks);
  }

  /**
   * Get icon for category
   */
  private getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      'export changes': '📹',
      'current selection': '✂️',
      'hate': '🚫',
      'violence': '⚠️',
      'extremism': '🔥',
      'misinformation': '❌',
      'conspiracy': '🔮',
      'marker': '📍',
      'routine': '📋',
      'shocking': '⚡'
    };
    return icons[category.toLowerCase()] || '📍';
  }

  /**
   * Handle selection changes from cascade component
   */
  onCascadeSelectionChanged(event: { count: number; ids: Set<string> }) {
    this.selectedSectionIds = event.ids;
  }

  /**
   * Handle video actions from cascade (like double-click)
   */
  onCascadeVideoAction(event: { action: string; videos: VideoItem[] }) {
    // Toggle selection on action
    if (event.action === 'open' || event.action === 'edit') {
      event.videos.forEach(video => {
        if (this.selectedSectionIds.has(video.id)) {
          this.selectedSectionIds.delete(video.id);
        } else {
          this.selectedSectionIds.add(video.id);
        }
      });
    }
  }

  onOverlayClick(event: MouseEvent) {
    // Only close if clicking directly on the overlay, not the content
    if (event.target === event.currentTarget) {
      this.cancel();
    }
  }

  getCategoryColor(category: string): string {
    return CATEGORY_COLORS[category.toLowerCase()] || CATEGORY_COLORS['default'];
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }

  getSelectedCount(): number {
    return this.selectedSectionIds.size;
  }

  getSelectedSections(): ExportSection[] {
    return this.sections.filter(section => this.selectedSectionIds.has(section.id));
  }

  canOverwriteOriginal(): boolean {
    const selectedSections = this.getSelectedSections();
    // Can overwrite if only one section is selected and it's either:
    // 1. The full video export (for scale-only changes)
    // 2. The current selection
    return selectedSections.length === 1 && (
      selectedSections[0].id === '__full_video__' ||
      selectedSections[0].id === '__selection__'
    );
  }

  selectAll() {
    this.sections.forEach(section => this.selectedSectionIds.add(section.id));
  }

  deselectAll() {
    this.selectedSectionIds.clear();
  }

  areAllSelected(): boolean {
    return this.sections.length > 0 && this.selectedSectionIds.size === this.sections.length;
  }

  getSelectedDuration(): string {
    const totalSeconds = this.getSelectedSections().reduce(
      (total, section) => total + (section.endSeconds - section.startSeconds),
      0
    );
    return this.formatTime(totalSeconds);
  }

  cancel() {
    if (!this.isExporting) {
      this.close.emit({ exported: false });
    }
  }

  async chooseOutputDirectory() {
    const electron = (window as any).electron;
    if (electron && electron.showOpenDialog) {
      try {
        const result = await electron.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose Output Folder for Clips'
        });

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          this.outputDirectory = result.filePaths[0];
        }
      } catch (error) {
        console.error('Failed to open directory picker:', error);
        this.notificationService.error('Error', 'Failed to open directory picker');
      }
    } else {
      this.notificationService.info(
        'Default Location',
        'Clips will be exported to your library folder. Directory picker is only available in the desktop app.'
      );
    }
  }

  async export() {
    const selectedSections = this.getSelectedSections();

    if (selectedSections.length === 0) {
      return;
    }

    if (this.overwriteOriginal && this.canOverwriteOriginal()) {
      const confirmed = await this.confirmOverwrite();
      if (!confirmed) {
        return;
      }
      await this.performOverwrite(selectedSections[0]);
      return;
    }

    this.isExporting = true;
    this.totalClips = selectedSections.length;
    this.currentClip = 0;
    this.successCount = 0;
    this.failedCount = 0;

    for (const section of selectedSections) {
      this.currentClip++;
      this.currentClipName = section.description || 'Unnamed section';
      this.exportProgress = (this.currentClip / this.totalClips) * 100;

      try {
        await this.exportSection(section);
        this.successCount++;
      } catch (error) {
        console.error('Failed to export section:', error);
        this.failedCount++;
      }
    }

    this.isExporting = false;
    this.exportComplete = true;
  }

  private async confirmOverwrite(): Promise<boolean> {
    return new Promise((resolve) => {
      const confirmed = confirm(
        'WARNING: This will permanently overwrite the original video file and delete ALL metadata including:\n\n' +
        '• Transcript\n' +
        '• Analysis sections\n' +
        '• Custom markers\n' +
        '• All other metadata\n\n' +
        'The video file will be replaced with only the highlighted section.\n\n' +
        'This action CANNOT be undone. Are you sure you want to continue?'
      );
      resolve(confirmed);
    });
  }

  private async performOverwrite(section: ExportSection): Promise<void> {
    this.isExporting = true;
    this.totalClips = 1;
    this.currentClip = 1;
    this.successCount = 0;
    this.failedCount = 0;
    this.currentClipName = 'Overwriting original file...';
    this.exportProgress = 50;

    try {
      const url = await this.backendUrlService.getApiUrl('/library/overwrite-with-clip');

      // For full video export with only scale changes, send null for times
      const isFullVideo = section.id === '__full_video__';

      await firstValueFrom(
        this.http.post(url, {
          videoId: this.data.videoId,
          videoPath: this.data.videoPath,
          startTime: isFullVideo ? null : section.startSeconds,
          endTime: isFullVideo ? null : section.endSeconds,
          reEncode: this.reEncode,
        })
      );

      this.successCount = 1;
      this.exportProgress = 100;
      this.notificationService.success('Success', 'Video file has been overwritten with the changes');
    } catch (error) {
      console.error('Failed to overwrite video:', error);
      this.failedCount = 1;
      this.notificationService.error('Error', 'Failed to overwrite video file');
    } finally {
      this.isExporting = false;
      this.exportComplete = true;
    }
  }

  private async exportSection(section: ExportSection): Promise<void> {
    const url = await this.backendUrlService.getApiUrl('/library/extract-clip');

    // For full video export, send null for times to indicate full video
    const isFullVideo = section.id === '__full_video__';

    await firstValueFrom(
      this.http.post(url, {
        videoPath: this.data.videoPath,
        startTime: isFullVideo ? null : section.startSeconds,
        endTime: isFullVideo ? null : section.endSeconds,
        category: section.category,
        title: section.description,
        customDirectory: this.outputDirectory || undefined,
        reEncode: this.reEncode,
      })
    );
  }

  closeDialog() {
    this.close.emit({ exported: this.exportComplete });
  }
}
