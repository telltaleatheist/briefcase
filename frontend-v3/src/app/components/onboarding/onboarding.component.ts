import { Component, Output, EventEmitter, signal, inject, OnInit, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LibraryService } from '../../services/library.service';
import { ElectronService } from '../../services/electron.service';
import { Library, NewLibrary } from '../../models/library.model';
import { AiSetupWizardComponent } from '../ai-setup-wizard/ai-setup-wizard.component';

type OnboardingStep = 'welcome' | 'library' | 'ai-setup' | 'complete';
type LibraryMode = 'select' | 'create' | 'open';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [CommonModule, FormsModule, AiSetupWizardComponent],
  templateUrl: './onboarding.component.html',
  styleUrls: ['./onboarding.component.scss']
})
export class OnboardingComponent implements OnInit {
  private libraryService = inject(LibraryService);
  private electronService = inject(ElectronService);

  @Output() completed = new EventEmitter<void>();

  currentStep = signal<OnboardingStep>('welcome');
  libraryMode = signal<LibraryMode>('create');

  // Library data
  existingLibraries = signal<Library[]>([]);
  selectedLibrary = signal<Library | null>(null);
  newLibraryName = signal('');
  newLibraryPath = signal('');
  openLibraryPath = signal('');

  // Loading states
  isLoading = signal(false);
  error = signal<string | null>(null);

  // Track if library was successfully created/selected
  libraryReady = signal(false);

  // Show AI wizard as overlay
  showAiWizard = signal(false);

  // Computed: has existing libraries
  hasExistingLibraries = computed(() => this.existingLibraries().length > 0);

  async ngOnInit() {
    // Load existing libraries
    await this.loadLibraries();
  }

  private async loadLibraries() {
    this.isLoading.set(true);
    try {
      const response = await firstValueFrom(this.libraryService.getLibraries());
      if (response.success) {
        this.existingLibraries.set(response.data);

        // If there are existing libraries, default to select mode
        if (response.data.length > 0) {
          this.libraryMode.set('select');
        }
      }
    } catch (err) {
      console.error('Failed to load libraries:', err);
    } finally {
      this.isLoading.set(false);
    }
  }

  // Navigation
  goToLibraryStep() {
    this.currentStep.set('library');
  }

  goToAiStep() {
    this.currentStep.set('ai-setup');
    this.showAiWizard.set(true);
  }

  skipAiSetup() {
    this.completeOnboarding();
  }

  completeOnboarding() {
    // Mark onboarding as complete in localStorage
    localStorage.setItem('clipchimp-onboarding-complete', 'true');
    this.completed.emit();
  }

  // Library mode selection
  setLibraryMode(mode: LibraryMode) {
    this.libraryMode.set(mode);
    this.error.set(null);
  }

  // Browse for folder
  async browseForFolder() {
    try {
      const result = await this.electronService.openDirectoryPicker();
      if (result) {
        if (this.libraryMode() === 'create') {
          this.newLibraryPath.set(result);
        } else if (this.libraryMode() === 'open') {
          this.openLibraryPath.set(result);
        }
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err);
    }
  }

  // Select existing library
  selectLibrary(library: Library) {
    this.selectedLibrary.set(library);
  }

  // Create new library
  async createLibrary() {
    if (!this.newLibraryName() || !this.newLibraryPath()) {
      this.error.set('Please provide both a name and path for your library');
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    try {
      const newLibrary: NewLibrary = {
        name: this.newLibraryName(),
        path: this.newLibraryPath()
      };

      const response = await firstValueFrom(this.libraryService.createLibrary(newLibrary));
      if (response.success) {
        this.libraryReady.set(true);
        this.goToAiStep();
      } else {
        this.error.set('Failed to create library');
      }
    } catch (err: any) {
      this.error.set(err.message || 'Failed to create library');
    } finally {
      this.isLoading.set(false);
    }
  }

  // Open existing library folder
  async openExistingLibrary() {
    if (!this.openLibraryPath()) {
      this.error.set('Please select a library folder');
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    try {
      const response = await firstValueFrom(this.libraryService.openLibrary(this.openLibraryPath()));
      if (response.success) {
        this.libraryReady.set(true);
        this.goToAiStep();
      } else {
        this.error.set('Failed to open library');
      }
    } catch (err: any) {
      this.error.set(err.message || 'Failed to open library');
    } finally {
      this.isLoading.set(false);
    }
  }

  // Use selected existing library
  async useSelectedLibrary() {
    const library = this.selectedLibrary();
    if (!library) {
      this.error.set('Please select a library');
      return;
    }

    this.isLoading.set(true);
    this.error.set(null);

    try {
      const response = await firstValueFrom(this.libraryService.switchLibrary(library.id));
      if (response.success) {
        this.libraryReady.set(true);
        this.goToAiStep();
      } else {
        this.error.set('Failed to switch to library');
      }
    } catch (err: any) {
      this.error.set(err.message || 'Failed to switch to library');
    } finally {
      this.isLoading.set(false);
    }
  }

  // AI Wizard events
  onAiWizardClosed() {
    this.showAiWizard.set(false);
    this.completeOnboarding();
  }

  onAiWizardCompleted() {
    this.showAiWizard.set(false);
    this.completeOnboarding();
  }
}
