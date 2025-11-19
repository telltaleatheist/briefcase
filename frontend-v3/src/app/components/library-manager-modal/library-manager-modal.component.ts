import { Component, Input, Output, EventEmitter, signal, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Library, NewLibrary, RelinkLibrary, LibraryManagerMode } from '../../models/library.model';
import { VideoWeek, VideoItem, DeleteMode } from '../../models/video.model';
import { ElectronService } from '../../services/electron.service';
import { CascadeComponent } from '../cascade/cascade.component';

@Component({
  selector: 'app-library-manager-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, CascadeComponent],
  templateUrl: './library-manager-modal.component.html',
  styleUrls: ['./library-manager-modal.component.scss']
})
export class LibraryManagerModalComponent {
  private electronService = inject(ElectronService);

  @Input() show = false;
  @Input() existingLibraries: Library[] = [];
  @Output() closed = new EventEmitter<void>();
  @Output() librarySelected = new EventEmitter<Library>();
  @Output() libraryCreated = new EventEmitter<NewLibrary>();
  @Output() libraryRelinked = new EventEmitter<RelinkLibrary>();
  @Output() librariesDeleted = new EventEmitter<string[]>();
  @Output() libraryUpdated = new EventEmitter<{ id: string; name: string; path: string }>();

  // Current mode: 'select' or 'create'
  mode = signal<LibraryManagerMode>('select');

  // Selected library for selection mode
  selectedLibrary = signal<Library | null>(null);

  // Selected library IDs for multi-select
  selectedLibraryIds = signal<Set<string>>(new Set());

  // Confirmation dialog state
  showDeleteConfirm = signal(false);

  // Edit library state
  editingLibrary = signal<Library | null>(null);
  editName = signal('');
  editPath = signal('');

  // New library form data
  newLibraryName = signal('');
  newLibraryPath = signal('');

  // Relink library path
  relinkPath = signal('');

  // Transform libraries into Cascade format
  libraryWeeks = computed<VideoWeek[]>(() => {
    if (this.existingLibraries.length === 0) return [];

    // Create video items from libraries
    const items: VideoItem[] = this.existingLibraries.map(lib => ({
      id: lib.id,
      name: lib.name,
      filePath: lib.path
    }));

    // Return as a single "week" (no grouping)
    return [{
      weekLabel: 'Your Libraries',
      videos: items
    }];
  });

  // Handle cascade selection
  onCascadeSelectionChanged(event: { count: number; ids: Set<string> }) {
    // Extract library IDs from itemIds (format: "weekLabel|libraryId")
    const libraryIds = new Set<string>();
    for (const itemId of event.ids) {
      const parts = itemId.split('|');
      const libraryId = parts.length > 1 ? parts[1] : itemId;
      libraryIds.add(libraryId);
    }
    this.selectedLibraryIds.set(libraryIds);

    if (event.count === 1) {
      const libraryId = Array.from(libraryIds)[0];
      const library = this.existingLibraries.find(lib => lib.id === libraryId);
      if (library) {
        this.selectedLibrary.set(library);
      }
    } else {
      this.selectedLibrary.set(null);
    }
  }

  // Get selected count for display
  get selectedCount(): number {
    return this.selectedLibraryIds().size;
  }

  // Show delete confirmation
  promptDelete() {
    if (this.selectedLibraryIds().size > 0) {
      this.showDeleteConfirm.set(true);
    }
  }

  // Confirm deletion
  confirmDelete() {
    const ids = Array.from(this.selectedLibraryIds());
    if (ids.length > 0) {
      this.librariesDeleted.emit(ids);
      this.selectedLibraryIds.set(new Set());
      this.selectedLibrary.set(null);
    }
    this.showDeleteConfirm.set(false);
  }

  // Cancel deletion
  cancelDelete() {
    this.showDeleteConfirm.set(false);
  }

  // Handle cascade actions (like delete from X button)
  onCascadeAction(event: { action: string; videos: VideoItem[] }) {
    if (event.action === 'delete') {
      // Set selected libraries and show confirmation
      const libraryIds = new Set(event.videos.map(v => v.id));
      this.selectedLibraryIds.set(libraryIds);
      this.showDeleteConfirm.set(true);
    } else if (event.action === 'edit' && event.videos.length === 1) {
      // Start editing the library
      const videoItem = event.videos[0];
      const library = this.existingLibraries.find(lib => lib.id === videoItem.id);
      if (library) {
        this.startEdit(library);
      }
    }
  }

  // Start editing a library
  startEdit(library: Library) {
    console.log('Editing library:', library);
    console.log('Library path:', library.path);
    this.editingLibrary.set(library);
    this.editName.set(library.name);
    this.editPath.set(library.path || '');
  }

  // Cancel editing
  cancelEdit() {
    this.editingLibrary.set(null);
    this.editName.set('');
    this.editPath.set('');
  }

  // Save edit changes
  saveEdit() {
    const library = this.editingLibrary();
    if (library && this.isEditValid()) {
      this.libraryUpdated.emit({
        id: library.id,
        name: this.editName().trim(),
        path: this.editPath().trim()
      });
      this.cancelEdit();
    }
  }

  // Check if edit form is valid
  isEditValid(): boolean {
    return this.editName().trim() !== '' && this.editPath().trim() !== '';
  }

  // Browse for edit path
  async browseEditPath() {
    const selectedPath = await this.electronService.selectDirectory();
    if (selectedPath) {
      this.editPath.set(selectedPath);
    }
  }

  // Switch between modes
  switchMode(newMode: LibraryManagerMode) {
    this.mode.set(newMode);
    this.selectedLibrary.set(null);
    this.newLibraryName.set('');
    this.newLibraryPath.set('');
    this.relinkPath.set('');
  }

  // Select an existing library
  selectLibrary(library: Library) {
    this.selectedLibrary.set(library);
  }

  // Browse for folder using Electron's directory picker
  async browsePath() {
    const selectedPath = await this.electronService.selectDirectory();
    if (selectedPath) {
      this.newLibraryPath.set(selectedPath);
    }
  }

  // Browse for existing library folder (relink mode)
  async browseRelinkPath() {
    const selectedPath = await this.electronService.selectDirectory();
    if (selectedPath) {
      this.relinkPath.set(selectedPath);
    }
  }

  // Confirm selection or creation
  confirm() {
    if (this.mode() === 'select') {
      const selected = this.selectedLibrary();
      if (selected) {
        this.librarySelected.emit(selected);
        this.close();
      }
    } else if (this.mode() === 'create') {
      const name = this.newLibraryName().trim();
      const path = this.newLibraryPath().trim();

      if (name && path) {
        this.libraryCreated.emit({ name, path });
        this.close();
      }
    } else if (this.mode() === 'relink') {
      const path = this.relinkPath().trim();

      if (path) {
        this.libraryRelinked.emit({ path });
        this.close();
      }
    }
  }

  // Close modal
  close() {
    this.closed.emit();
    this.reset();
  }

  // Reset state
  reset() {
    this.mode.set('select');
    this.selectedLibrary.set(null);
    this.selectedLibraryIds.set(new Set());
    this.newLibraryName.set('');
    this.newLibraryPath.set('');
    this.relinkPath.set('');
    this.showDeleteConfirm.set(false);
    this.editingLibrary.set(null);
    this.editName.set('');
    this.editPath.set('');
  }

  // Check if form is valid
  isValid(): boolean {
    if (this.mode() === 'select') {
      return this.selectedLibrary() !== null;
    } else if (this.mode() === 'create') {
      return this.newLibraryName().trim() !== '' && this.newLibraryPath().trim() !== '';
    } else if (this.mode() === 'relink') {
      return this.relinkPath().trim() !== '';
    }
    return false;
  }

  // Format date
  formatDate(date: Date): string {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // Format file size
  formatSize(bytes?: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  // Handle backdrop click
  onBackdropClick(event: MouseEvent) {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close();
    }
  }
}
