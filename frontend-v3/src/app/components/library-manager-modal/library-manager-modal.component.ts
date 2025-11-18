import { Component, Input, Output, EventEmitter, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Library, NewLibrary, RelinkLibrary, LibraryManagerMode } from '../../models/library.model';
import { ElectronService } from '../../services/electron.service';

@Component({
  selector: 'app-library-manager-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
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

  // Current mode: 'select' or 'create'
  mode = signal<LibraryManagerMode>('select');

  // Selected library for selection mode
  selectedLibrary = signal<Library | null>(null);

  // New library form data
  newLibraryName = signal('');
  newLibraryPath = signal('');

  // Relink library path
  relinkPath = signal('');

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
    this.newLibraryName.set('');
    this.newLibraryPath.set('');
    this.relinkPath.set('');
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
