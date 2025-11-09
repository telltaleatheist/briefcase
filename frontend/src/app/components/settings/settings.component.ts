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
    });
  }

  createForm(): FormGroup {
    return this.fb.group({
      quality: ['720'],
      convertToMp4: [true],
      useCookies: [false],
      fixAspectRatio: [true],
      browser: ['auto'],
      theme: ['light'],
      // Batch processing settings (batch downloads always enabled)
      maxConcurrentDownloads: [2, [Validators.required, Validators.min(1), Validators.max(10)]]
    });
  }

  updateForm(settings: Settings): void {
    this.settingsForm.patchValue({
      quality: settings.quality,
      convertToMp4: settings.convertToMp4,
      useCookies: settings.useCookies,
      fixAspectRatio: settings.fixAspectRatio,
      browser: settings.browser,
      theme: settings.theme,
      // Batch processing settings
      maxConcurrentDownloads: settings.maxConcurrentDownloads || 2
    });
  }

  onSubmit(): void {
    if (this.settingsForm.invalid) return;
    this.saveSettings();
  }

  resetToDefaults(): void {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      this.settingsService.resetSettings();
      // Badge only - user explicitly reset, result is obvious
      this.notificationService.success('Settings Reset', 'All settings have been reset to defaults', false);
    }
  }

  saveSettings(): void {
    // Always enable batch processing (it's a core feature)
    const settings = {
      ...this.settingsForm.value,
      batchProcessingEnabled: true
    };
    this.settingsService.updateSettings(settings);
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