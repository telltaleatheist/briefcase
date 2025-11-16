import { Component, Inject, OnInit, ViewChild, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { CascadeListComponent } from '../../libs/cascade/src/lib/components/cascade-list/cascade-list.component';
import { ListItem, ItemDisplayConfig, GroupConfig, SelectionMode, ItemStatus } from '../../libs/cascade/src/lib/types/cascade.types';
import { NotificationService } from '../../services/notification.service';
import { BackendUrlService } from '../../services/backend-url.service';

interface ExportSection extends ListItem {
  id: string;
  category: string;
  description: string;
  startSeconds: number;
  endSeconds: number;
  timeRange: string;
}

@Component({
  selector: 'app-export-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatProgressBarModule,
    MatCheckboxModule,
    MatTooltipModule,
    CascadeListComponent
  ],
  templateUrl: './export-dialog.component.html',
  styleUrls: ['./export-dialog.component.scss']
})
export class ExportDialogComponent implements OnInit, AfterViewInit {
  @ViewChild(CascadeListComponent) cascadeList?: CascadeListComponent<ExportSection>;

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

  // Cascade list configuration
  sections: ExportSection[] = [];
  selectedSectionIds = new Set<string>();
  displayConfig: ItemDisplayConfig = {
    primaryField: 'description',
    secondaryField: 'timeRange',
    iconField: 'icon'
  };
  selectionMode = SelectionMode.Multiple;

  // Track which groups are collapsed
  collapsedGroups = new Set<string>();
  allCollapsed = true;

  // Group config with custom sort to put Selection first
  groupConfig: GroupConfig<ExportSection> = {
    enabled: true,
    groupBy: (item: ExportSection) => item.category,
    groupLabel: (key: string) => key,
    sortDescending: false,
    selectableGroups: false
  };

  constructor(
    @Inject(MAT_DIALOG_DATA) public data: {
      sections: ExportSection[];
      selectionStart?: number;
      selectionEnd?: number;
      videoId: string;
      videoPath: string;
      videoTitle: string;
    },
    private dialogRef: MatDialogRef<ExportDialogComponent>,
    private http: HttpClient,
    private notificationService: NotificationService,
    private backendUrlService: BackendUrlService
  ) {}

  ngOnInit() {
    // Prepare sections for cascade list
    const cascadeSections: ExportSection[] = [];

    // Check if there's a valid selection and add it as the first item
    if (this.data.selectionStart !== undefined && this.data.selectionEnd !== undefined) {
      const duration = this.data.selectionEnd - this.data.selectionStart;
      if (duration >= 1) {
        this.hasSelection = true;
        this.selectionStart = this.data.selectionStart;
        this.selectionEnd = this.data.selectionEnd;
        this.selectionDuration = this.formatTime(duration);

        // Add selection as a cascade list item at the top
        // Use a leading space to ensure it sorts first
        cascadeSections.push({
          id: '__selection__',
          category: ' Current Selection',
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

    // Initialize all groups as collapsed except Current Selection
    const categories = new Set(this.sections.map(s => s.category));
    this.collapsedGroups = new Set(
      Array.from(categories).filter(cat => cat.trim() !== 'Current Selection')
    );

    // Update groupConfig with custom sort to put Selection first
    this.groupConfig = {
      enabled: true,
      groupBy: (item: ExportSection) => item.category,
      groupLabel: (key: string) => key,
      sortDescending: false,
      selectableGroups: false
    };

    // Update the allCollapsed state based on actual collapsed groups
    this.updateAllCollapsedState();
  }

  ngAfterViewInit() {
    // Sync collapsed groups with cascade list after view init
    if (this.cascadeList) {
      this.collapsedGroups.forEach(cat => this.cascadeList!.collapsedGroups.add(cat));
      this.cascadeList['updateGroupedItems']();
    }
  }

  getCategoryColor(category: string): string {
    const colors: { [key: string]: string } = {
      ' current selection': '#ff6600',
      'hate': '#ff4444',
      'custom': '#ff6600',
      'highlight': '#ffaa00',
      'general': '#4488ff',
      'intro': '#44ff88',
      'outro': '#ff44aa',
      'other': '#999999'
    };
    return colors[category.toLowerCase()] || '#999999';
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

  // Handle section selection from cascade list
  onSectionsSelected(sections: ExportSection[]) {
    sections.forEach(section => this.selectedSectionIds.add(section.id));
  }

  onSectionsDeselected(sections: ExportSection[]) {
    sections.forEach(section => this.selectedSectionIds.delete(section.id));
  }

  getSelectedCount(): number {
    return this.selectedSectionIds.size;
  }

  getSelectedSections(): ExportSection[] {
    return this.sections.filter(section => this.selectedSectionIds.has(section.id));
  }

  // Check if overwrite option should be enabled
  // Only allow overwriting when exactly one section is selected and it's the current selection
  canOverwriteOriginal(): boolean {
    if (!this.hasSelection) {
      return false;
    }
    const selectedSections = this.getSelectedSections();
    return selectedSections.length === 1 && selectedSections[0].id === '__selection__';
  }

  // Status mapper to apply category colors
  getItemStatus = (item: ExportSection): ItemStatus | null => {
    const color = this.getCategoryColor(item.category);
    return {
      color: color,
      tooltip: item.category
    };
  }

  // Handle group toggle to track collapsed state
  onGroupToggle(event: { groupId: string; collapsed: boolean }) {
    if (event.collapsed) {
      this.collapsedGroups.add(event.groupId);
    } else {
      this.collapsedGroups.delete(event.groupId);
    }
    this.updateAllCollapsedState();
  }

  // Expand all groups
  expandAll() {
    this.collapsedGroups.clear();
    this.allCollapsed = false;

    // Trigger cascade list to update
    if (this.cascadeList) {
      this.cascadeList.collapsedGroups.clear();
      this.cascadeList['updateGroupedItems']();
    }
  }

  // Collapse all groups (except Current Selection which stays expanded)
  collapseAll() {
    const categories = new Set(this.sections.map(s => s.category));
    this.collapsedGroups = new Set(
      Array.from(categories).filter(cat => cat.trim() !== 'Current Selection')
    );
    this.allCollapsed = true;

    // Trigger cascade list to update
    if (this.cascadeList) {
      this.cascadeList.collapsedGroups.clear();
      this.collapsedGroups.forEach(cat => this.cascadeList!.collapsedGroups.add(cat));
      this.cascadeList['updateGroupedItems']();
    }
  }

  // Update the allCollapsed state based on current collapsed groups
  // (Current Selection is always expanded and doesn't count toward collapse state)
  private updateAllCollapsedState() {
    const categories = new Set(this.sections.map(s => s.category));
    const collapsibleCategories = Array.from(categories).filter(cat => cat.trim() !== 'Current Selection');
    const totalCollapsibleGroups = collapsibleCategories.length;

    // Count how many collapsible groups are actually collapsed
    const collapsedCount = Array.from(this.collapsedGroups).filter(cat => cat.trim() !== 'Current Selection').length;

    this.allCollapsed = collapsedCount === totalCollapsibleGroups;
  }

  cancel() {
    this.dialogRef.close();
  }

  async chooseOutputDirectory() {
    // Use Electron dialog if available (desktop app)
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
      // Web mode - inform user that default location will be used
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

    // If overwrite is enabled, show confirmation dialog
    if (this.overwriteOriginal && this.canOverwriteOriginal()) {
      const confirmed = await this.confirmOverwrite();
      if (!confirmed) {
        return;
      }

      // Perform the overwrite operation
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

      await firstValueFrom(
        this.http.post(url, {
          videoId: this.data.videoId,
          videoPath: this.data.videoPath,
          startTime: section.startSeconds,
          endTime: section.endSeconds,
          reEncode: this.reEncode,
        })
      );

      this.successCount = 1;
      this.exportProgress = 100;
      this.notificationService.success('Success', 'Video file has been overwritten with the selected section');
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

    await firstValueFrom(
      this.http.post(url, {
        videoPath: this.data.videoPath,
        startTime: section.startSeconds,
        endTime: section.endSeconds,
        category: section.category,
        title: section.description,
        customDirectory: this.outputDirectory || undefined,
        reEncode: this.reEncode,
      })
    );
  }

  close() {
    this.dialogRef.close({ exported: this.exportComplete });
  }
}
