import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { ThemeService } from '../../services/theme.service';
import { LibraryService } from '../../services/library.service';
import { LoggerService } from '../../services/logger.service';
import { NotificationService } from '../../services/notification.service';
import { LibraryManagerModalComponent } from '../../components/library-manager-modal/library-manager-modal.component';
import { NotificationBellComponent } from '../../components/notification-bell/notification-bell.component';
import { Library, NewLibrary, OpenLibrary } from '../../models/library.model';

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [CommonModule, RouterModule, LibraryManagerModalComponent, NotificationBellComponent],
  templateUrl: './navigation.component.html',
  styleUrls: ['./navigation.component.scss']
})
export class NavigationComponent {
  private router = inject(Router);
  themeService = inject(ThemeService);
  libraryService = inject(LibraryService);
  private loggerService = inject(LoggerService);
  private notificationService = inject(NotificationService);
  mobileMenuOpen = signal(false);
  libraryManagerOpen = signal(false);
  currentUrl = signal('/');

  isHome = computed(() => this.currentUrl() === '/');
  isSettings = computed(() => this.currentUrl().startsWith('/settings'));

  navLinks = [
    { path: '/', label: 'Media Library', icon: '📹' },
    { path: '/settings', label: 'Settings', icon: '⚙️' }
  ];

  constructor() {
    this.currentUrl.set(this.router.url);
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd)
    ).subscribe((event) => {
      this.currentUrl.set(event.urlAfterRedirects);
    });
  }

  goBack() {
    this.router.navigate(['/']);
  }

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
        this.notificationService.error('Library Switch Failed', 'Failed to switch library. Please try again.');
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
        this.notificationService.error('Library Creation Failed', 'Failed to create library. Please try again.');
      }
    });
  }

  onLibraryOpened(openLib: OpenLibrary) {
    // Open an existing library from a folder containing .library.db
    this.libraryService.openLibrary(openLib.path).subscribe({
      next: (response) => {
        if (response.success) {
          // Refresh the libraries list to show the new library
          this.libraryService.refreshLibraries();
          // Switch to the imported library
          this.libraryService.currentLibrary.set(response.data);
          this.notificationService.success('Library Opened', `Library "${response.data.name}" opened successfully!`);
        }
      },
      error: (error) => {
        console.error('Failed to open library:', error);
        this.notificationService.error('Open Failed', error.message || 'Failed to open library. Make sure the folder contains a .library.db file.');
      }
    });
  }

  onLibraryUpdated(update: { id: string; name: string; path: string }) {
    this.libraryService.updateLibrary(update.id, update.name, update.path).subscribe({
      next: (response) => {
        if (response.success) {
          // Refresh libraries list
          this.libraryService.refreshLibraries();
          // Update current library if it was the one edited
          const currentLib = this.libraryService.currentLibrary();
          if (currentLib && currentLib.id === update.id) {
            this.libraryService.currentLibrary.set(response.data);
          }
        }
      },
      error: (error) => {
        console.error('Failed to update library:', error);
        this.notificationService.error('Update Failed', 'Failed to update library. Please try again.');
      }
    });
  }

  onLibrariesDeleted(ids: string[]) {
    // Delete each library
    for (const id of ids) {
      this.libraryService.deleteLibrary(id).subscribe({
        next: (response) => {
          if (response.success) {
            this.libraryService.refreshLibraries();
          }
        },
        error: (error) => {
          console.error('Failed to delete library:', error);
          this.notificationService.error('Delete Failed', 'Failed to delete library. Please try again.');
        }
      });
    }
  }

  downloadLogs() {
    this.loggerService.downloadLogs();
  }
}
