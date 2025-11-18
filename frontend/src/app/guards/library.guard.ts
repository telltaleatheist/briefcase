import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { LibraryStateService } from '../services/library-state.service';
import { LibraryManagementDialogComponent } from '../components/library/library-management-dialog.component';
import { firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { BackendUrlService } from '../services/backend-url.service';

export const libraryGuard: CanActivateFn = async (route, state) => {
  const libraryState = inject(LibraryStateService);
  const dialog = inject(MatDialog);
  const router = inject(Router);
  const http = inject(HttpClient);
  const backendUrlService = inject(BackendUrlService);

  // Check if libraries are already loaded in state
  let libraries = libraryState.getLibraries();

  // If not loaded yet, fetch from backend
  if (!libraries || libraries.length === 0) {
    try {
      const url = await backendUrlService.getApiUrl('/database/libraries');
      const response = await firstValueFrom(
        http.get<{ libraries: any[]; activeLibrary: any | null }>(url)
      );

      if (response?.libraries) {
        libraries = response.libraries;
        // Update the state service
        libraryState.setLibraries(libraries);
        libraryState.setCurrentLibrary(response.activeLibrary);
      }
    } catch (error) {
      console.error('Failed to load libraries in guard:', error);
      libraries = [];
    }
  }

  if (!libraries || libraries.length === 0) {
    // No libraries exist - show setup dialog
    const dialogRef = dialog.open(LibraryManagementDialogComponent, {
      disableClose: true,
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      data: { isInitialSetup: true }
    });

    // Wait for dialog to close
    await firstValueFrom(dialogRef.afterClosed());

    // Check again if a library was created (the dialog should have updated the state)
    const updatedLibraries = libraryState.getLibraries();
    if (!updatedLibraries || updatedLibraries.length === 0) {
      // Still no library - redirect to settings
      router.navigate(['/settings']);
      return false;
    }
  }

  return true;
};
