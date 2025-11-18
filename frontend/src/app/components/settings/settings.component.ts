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
import { MatDialog, MatDialogModule } from '@angular/material/dialog';

import { SettingsService } from '../../services/settings.service';
import { PathService } from '../../services/path.service';
import { NotificationService } from '../../services/notification.service';
import { Settings } from '../../models/settings.model';
import { BROWSER_OPTIONS, QUALITY_OPTIONS } from '../download-form/download-form.constants';
import { finalize } from 'rxjs';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { AiSetupHelperService, AIAvailability } from '../../services/ai-setup-helper.service';
import { AiSetupWizardComponent } from '../ai-setup-wizard/ai-setup-wizard.component';
import { LibraryManagementDialogComponent } from '../library/library-management-dialog.component';

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
    MatExpansionModule,
    MatDialogModule
  ]
})
export class SettingsComponent implements OnInit {
  private fb = inject(FormBuilder);
  private settingsService = inject(SettingsService);
  private pathService = inject(PathService);
  private snackBar = inject(MatSnackBar);
  private notificationService = inject(NotificationService);
  private router = inject(Router);
  private dialog = inject(MatDialog);
  private aiSetupHelper = inject(AiSetupHelperService);

  aiAvailability: AIAvailability | null = null;
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

  async ngOnInit(): Promise<void> {
    this.settingsService.getSettings().subscribe(settings => {
      this.updateForm(settings);
    });

    // Check AI availability for the AI setup section
    this.aiAvailability = await this.aiSetupHelper.checkAIAvailability();
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

  /**
   * Open AI setup wizard
   */
  openAISetup(): void {
    const dialogRef = this.dialog.open(AiSetupWizardComponent, {
      width: '800px',
      maxWidth: '90vw',
      maxHeight: '80vh',
      disableClose: false,
      data: { forceSetup: false }
    });

    dialogRef.afterClosed().subscribe(async (result) => {
      if (result?.completed || result?.skipped) {
        // Refresh AI availability
        this.aiAvailability = await this.aiSetupHelper.checkAIAvailability();

        if (result?.completed) {
          this.notificationService.success('AI Setup Complete', 'Your AI providers are now configured!');
        }
      }
    });
  }

  /**
   * Navigate to Relink Files tool
   */
  openRelinkFiles(): void {
    this.router.navigate(['/relink']);
  }

  /**
   * Navigate to Analysis Parameters
   */
  openAnalysisParameters(): void {
    this.router.navigate(['/analysis-parameters']);
  }

  /**
   * Open Library Management dialog
   */
  openLibraryManagement(): void {
    const dialogRef = this.dialog.open(LibraryManagementDialogComponent, {
      width: '700px',
      maxWidth: '90vw',
      maxHeight: '85vh',
      disableClose: false,
      data: { isInitialSetup: false }
    });

    dialogRef.afterClosed().subscribe(() => {
      // Dialog closed - no additional action needed
    });
  }

  /**
   * Get AI status summary for display
   */
  getAIStatusSummary(): string {
    if (!this.aiAvailability) {
      return 'Checking...';
    }

    const providers: string[] = [];

    if (this.aiAvailability.hasOllama && this.aiAvailability.ollamaModels.length > 0) {
      providers.push(`Ollama (${this.aiAvailability.ollamaModels.length} models)`);
    }
    if (this.aiAvailability.hasClaudeKey) {
      providers.push('Claude API');
    }
    if (this.aiAvailability.hasOpenAIKey) {
      providers.push('OpenAI API');
    }

    if (providers.length === 0) {
      return 'Not configured';
    }

    return providers.join(', ');
  }

  /**
   * Check if any AI provider is configured
   */
  hasAnyAIProvider(): boolean {
    if (!this.aiAvailability) return false;

    return (this.aiAvailability.hasOllama && this.aiAvailability.ollamaModels.length > 0) ||
           this.aiAvailability.hasClaudeKey ||
           this.aiAvailability.hasOpenAIKey;
  }
}