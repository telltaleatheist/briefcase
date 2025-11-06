// clippy/frontend/src/app/components/settings/settings.component.ts
import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { RouterModule, Router } from '@angular/router';
import { ThemeService } from '../../services/theme.service';
import { Observable } from 'rxjs';
import { MatExpansionModule } from '@angular/material/expansion';

import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatOptionModule } from '@angular/material/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { SettingsService } from '../../services/settings.service';
import { PathService } from '../../services/path.service';
import { NotificationService } from '../../services/notification.service';
import { Settings } from '../../models/settings.model';
import { BROWSER_OPTIONS, QUALITY_OPTIONS } from '../download-form/download-form.constants';
import { finalize } from 'rxjs';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';

@Component({
  selector: 'app-settings',
  standalone: true,  // Change this to true to match the imports array
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss'],
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule,
    MatSnackBarModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatIconModule,
    MatButtonModule,
    MatOptionModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatExpansionModule
  ]
})
export class SettingsComponent implements OnInit {
  private fb = inject(FormBuilder);
  private settingsService = inject(SettingsService);
  private pathService = inject(PathService);
  private snackBar = inject(MatSnackBar);
  private notificationService = inject(NotificationService);
  private router = inject(Router);
  private themeService = inject(ThemeService);

  settingsForm: FormGroup;
  browserOptions = BROWSER_OPTIONS;
  qualityOptions = QUALITY_OPTIONS;
  
  isValidatingPath = false;
  isElectron = false;
  isDarkTheme$: Observable<boolean>;

  constructor() {
    this.settingsForm = this.createForm();
    // Check if we're running in Electron
    this.isElectron = !!(window as any).electron;
    
    // Get theme observable
    this.isDarkTheme$ = this.themeService.isDarkTheme$;
  }

  ngOnInit(): void {
    this.settingsService.getSettings().subscribe(settings => {
      this.updateForm(settings);
      
      // If outputDir is empty, get the default from the backend
      if (!settings.outputDir) {
        this.getDefaultPath();
      }
    });
  }

  createForm(): FormGroup {
    return this.fb.group({
      outputDir: [''],
      quality: ['720'],
      convertToMp4: [true],
      useCookies: [false],
      fixAspectRatio: [true],
      browser: ['auto'],
      theme: ['light'],
      // Batch processing settings
      batchProcessingEnabled: [true],
      maxConcurrentDownloads: [2, [Validators.required, Validators.min(1), Validators.max(10)]]
    });
  }

  updateForm(settings: Settings): void {
    this.settingsForm.patchValue({
      outputDir: settings.outputDir,
      quality: settings.quality,
      convertToMp4: settings.convertToMp4,
      useCookies: settings.useCookies,
      fixAspectRatio: settings.fixAspectRatio,
      browser: settings.browser,
      theme: settings.theme,
      // Batch processing settings
      batchProcessingEnabled: settings.batchProcessingEnabled !== undefined ? settings.batchProcessingEnabled : true,
      maxConcurrentDownloads: settings.maxConcurrentDownloads || 2
    });
  }

  onSubmit(): void {
    if (this.settingsForm.invalid) return;
    
    // Validate the path before saving
    const outputDir = this.settingsForm.get('outputDir')?.value;
    if (outputDir) {
      this.validatePath(outputDir, true);
    } else {
      // No path specified, fallback to default
      this.getDefaultPath(true);
    }
  }

  resetToDefaults(): void {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      this.settingsService.resetSettings();
      // Get the default path from the backend
      this.getDefaultPath();
      // Badge only - user explicitly reset, result is obvious
      this.notificationService.success('Settings Reset', 'All settings have been reset to defaults', false);
    }
  }

  browseOutputDir(): void {
    if (this.isElectron) {
      this.pathService.openDirectoryPicker().subscribe({
        next: (path) => {
          if (path) {
            this.settingsForm.patchValue({ outputDir: path });
            this.validatePath(path);
          }
        },
        error: (error) => {
          console.error('Error picking directory:', error);
          this.notificationService.error('Directory Selection Failed', error.message || 'Could not select directory');
        }
      });
    } else {
      this.notificationService.info('Not Available', 'Directory selection is only available in the desktop version');
    }
  }

  getDefaultPath(saveAfter = false): void {
    this.pathService.getDefaultPath().subscribe({
      next: (response) => {
        if (response.success) {
          this.settingsForm.patchValue({ outputDir: response.path });
          if (saveAfter) {
            this.saveSettings();
          }
        }
      },
      error: (error) => {
        console.error('Error getting default path:', error);
        this.notificationService.error('Path Error', 'Could not get default download path');
      }
    });
  }

  validatePath(path: string, saveAfter = false): void {
    this.isValidatingPath = true;

    this.pathService.validatePath(path)
      .pipe(finalize(() => this.isValidatingPath = false))
      .subscribe({
        next: (result) => {
          if (result.success) {
            if (result.isValid) {
              if (saveAfter) {
                this.saveSettings();
              } else {
                // Badge only - intermediate validation feedback
                this.notificationService.success('Path Valid', 'Directory is valid and writable', false);
              }
            } else {
              this.notificationService.warning('Path Not Writable', 'Directory is not writable. Please choose another location.');
            }
          }
        },
        error: (error) => {
          console.error('Error validating path:', error);
          this.notificationService.error('Validation Error', 'Could not validate directory');
        }
      });
  }

  saveSettings(): void {
    this.settingsService.updateSettings(this.settingsForm.value);
    // Badge only - no toast for expected save action
    this.notificationService.success('Settings Saved', 'Your preferences have been updated successfully', false);
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }
}