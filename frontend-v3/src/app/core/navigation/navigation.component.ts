import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { ThemeService } from '../../services/theme.service';
import { LibraryService } from '../../services/library.service';
import { LoggerService } from '../../services/logger.service';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { Library, NewLibrary, RelinkLibrary } from '../../models/library.model';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [CommonModule, RouterModule, LibraryManagerModalComponent],
  templateUrl: './navigation.component.html',
  styleUrls: ['./navigation.component.scss']
})
export class NavigationComponent {
  themeService = inject(ThemeService);
  libraryService = inject(LibraryService);
  private loggerService = inject(LoggerService);
  mobileMenuOpen = signal(false);
  libraryManagerOpen = signal(false);

  navLinks = [
    { path: '/', label: 'Media Library', icon: '📹' },
    { path: '/settings', label: 'Settings', icon: '⚙️' }
  ];

  toggleMobileMenu() {
    this.mobileMenuOpen.update(value => !value);
  }

  closeMobileMenu() {
    this.mobileMenuOpen.set(false);
  }

  toggleTheme() {
    this.themeService.toggleTheme();
  }

  openLibraryManager() {
    this.libraryService.refreshLibraries();
    this.libraryManagerOpen.set(true);
  }

  onLibrarySelected(library: Library) {
    this.libraryService.switchLibrary(library.id).subscribe({
      next: (response) => {
        if (response.success) {
          this.libraryService.currentLibrary.set(response.data);
          window.location.reload();
        }
      },
      error: (error) => {
        console.error('Failed to switch library:', error);
        alert('Failed to switch library. Please try again.');
      }
    });
  }

  onLibraryCreated(newLibrary: NewLibrary) {
    this.libraryService.createLibrary(newLibrary).subscribe({
      next: (response) => {
        if (response.success) {
          this.libraryService.currentLibrary.set(response.data);
          window.location.reload();
        }
      },
      error: (error) => {
        console.error('Failed to create library:', error);
        alert('Failed to create library. Please try again.');
      }
    });
  }

  onLibraryRelinked(relink: RelinkLibrary) {
    const currentLib = this.libraryService.currentLibrary();
    if (currentLib) {
      this.libraryService.relinkLibrary(currentLib.id, relink.path).subscribe({
        next: (response) => {
          if (response.success) {
            this.libraryService.currentLibrary.set(response.data);
            alert('Library relinked successfully!');
          }
        },
        error: (error) => {
          console.error('Failed to relink library:', error);
          alert('Failed to relink library. Please try again.');
        }
      });
    }
  }

  downloadLogs() {
    this.loggerService.downloadLogs();
  }
}
