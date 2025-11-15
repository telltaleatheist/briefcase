import { Component, OnInit, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatStepperModule } from '@angular/material/stepper';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { DatabaseMigrationService, MigrationOptions, MigrationStatus } from '../../services/database-migration.service';

interface WizardStep {
  title: string;
  description: string;
  completed: boolean;
}

@Component({
  selector: 'app-database-migration-wizard',
  standalone: true,
  encapsulation: ViewEncapsulation.None, // DISABLE encapsulation so global styles work!
  imports: [
    CommonModule,
    FormsModule,
    MatStepperModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
    MatExpansionModule,
    MatSnackBarModule,
  ],
  templateUrl: './database-migration-wizard.component.html',
  styleUrls: ['./database-migration-wizard.component.scss']
})
export class DatabaseMigrationWizardComponent implements OnInit {
  currentStep = 0;
  steps: WizardStep[] = [
    {
      title: 'Welcome',
      description: 'Introduction to database migration',
      completed: false
    },
    {
      title: 'Configure Paths',
      description: 'Tell us where your files are located',
      completed: false
    },
    {
      title: 'Preview Changes',
      description: 'See what will be migrated',
      completed: false
    },
    {
      title: 'Run Migration',
      description: 'Perform the actual migration',
      completed: false
    },
    {
      title: 'Complete',
      description: 'Migration finished!',
      completed: false
    }
  ];

  // Migration configuration
  migrationConfig: MigrationOptions = {
    computerName: '',
    nasRoot: '',
    clipsFolder: '',
    downloadsFolder: '',
    librariesFolder: '',
    moveClipsTo: '',
  };

  // Status
  status: MigrationStatus | null = null;
  previewResult: any = null;
  migrationResult: any = null;
  isLoading = false;
  migrationInProgress = false;
  migrationProgress: any = null;

  // Instructions
  instructions: any = null;

  constructor(
    private migrationService: DatabaseMigrationService,
    private snackBar: MatSnackBar,
    private dialog: MatDialog
  ) {}

  ngOnInit(): void {
    this.loadStatus();
    this.loadInstructions();
    this.detectPlatformDefaults();
  }

  /**
   * Load current migration status
   */
  loadStatus(): void {
    this.migrationService.getStatus().subscribe({
      next: (status) => {
        this.status = status;

        if (status.isConfigured) {
          // Pre-fill form with existing config
          if (status.config) {
            this.migrationConfig.computerName = status.config.computerName;
            this.migrationConfig.nasRoot = status.config.nasRoot;
            this.migrationConfig.clipsFolder = status.config.pathMappings.clips;
            this.migrationConfig.downloadsFolder = status.config.pathMappings.downloads;
            this.migrationConfig.librariesFolder = status.config.pathMappings.libraries;
          }

          // If already configured, show different message
          this.showInfo('Path mapping already configured. You can reconfigure or skip to other computers.');
        }
      },
      error: (err) => {
        this.showError('Failed to load migration status: ' + err.message);
      }
    });
  }

  /**
   * Load migration instructions
   */
  loadInstructions(): void {
    this.migrationService.getInstructions().subscribe({
      next: (instructions) => {
        this.instructions = instructions;
      },
      error: (err) => {
        console.error('Failed to load instructions:', err);
      }
    });
  }

  /**
   * Detect platform and set sensible defaults
   */
  detectPlatformDefaults(): void {
    const platform = navigator.platform.toLowerCase();
    const hostname = window.location.hostname || 'unknown';

    // Try to guess computer name
    this.migrationConfig.computerName = hostname.charAt(0).toUpperCase() + hostname.slice(1);

    // Platform-specific defaults
    if (platform.includes('mac')) {
      this.migrationConfig.nasRoot = '/Volumes/';
      this.migrationConfig.clipsFolder = '/Volumes/YOUR_NAS/clips';
      this.migrationConfig.downloadsFolder = '/Volumes/YOUR_NAS/downloads';
      this.migrationConfig.librariesFolder = '/Volumes/YOUR_NAS/libraries';
    } else if (platform.includes('win')) {
      this.migrationConfig.nasRoot = 'Z:\\';
      this.migrationConfig.clipsFolder = 'Z:\\clips';
      this.migrationConfig.downloadsFolder = 'Z:\\downloads';
      this.migrationConfig.librariesFolder = 'Z:\\libraries';
    } else {
      // Linux
      this.migrationConfig.nasRoot = '/mnt/nas';
      this.migrationConfig.clipsFolder = '/mnt/nas/clips';
      this.migrationConfig.downloadsFolder = '/mnt/nas/downloads';
      this.migrationConfig.librariesFolder = '/mnt/nas/libraries';
    }
  }

  /**
   * Navigate to next step
   */
  nextStep(): void {
    if (this.currentStep < this.steps.length - 1) {
      this.steps[this.currentStep].completed = true;
      this.currentStep++;
    }
  }

  /**
   * Navigate to previous step
   */
  previousStep(): void {
    if (this.currentStep > 0) {
      this.currentStep--;
    }
  }

  /**
   * Go to a specific step
   */
  goToStep(index: number): void {
    this.currentStep = index;
  }

  /**
   * Validate configuration form
   */
  isConfigValid(): boolean {
    return !!(
      this.migrationConfig.computerName &&
      this.migrationConfig.nasRoot &&
      this.migrationConfig.clipsFolder &&
      this.migrationConfig.librariesFolder
    );
  }

  /**
   * Run preview (dry run)
   */
  runPreview(): void {
    if (!this.isConfigValid()) {
      this.showError('Please fill in all required fields');
      return;
    }

    this.isLoading = true;
    this.previewResult = null;

    this.migrationService.previewMigration(this.migrationConfig).subscribe({
      next: (result) => {
        this.isLoading = false;
        this.previewResult = result;
        this.showSuccess('Preview completed! Review the results below.');
      },
      error: (err) => {
        this.isLoading = false;
        this.showError('Preview failed: ' + err.error?.message || err.message);
      }
    });
  }

  /**
   * Run actual migration
   */
  runActualMigration(): void {
    if (!this.isConfigValid()) {
      this.showError('Please fill in all required fields');
      return;
    }

    const confirmed = confirm(
      'This will migrate your database to shared mode. A backup will be created automatically.\n\n' +
      'This may take several minutes for large libraries.\n\n' +
      'Continue?'
    );

    if (!confirmed) {
      return;
    }

    this.migrationInProgress = true;
    this.migrationResult = null;

    this.migrationService.runMigration({
      ...this.migrationConfig,
      dryRun: false
    }).subscribe({
      next: (result) => {
        this.migrationInProgress = false;
        this.migrationResult = result;

        if (result.success) {
          this.showSuccess('Migration completed successfully!');
          this.nextStep(); // Go to completion step
        } else {
          this.showError('Migration completed with errors. Check the results below.');
        }
      },
      error: (err) => {
        this.migrationInProgress = false;
        this.showError('Migration failed: ' + err.error?.message || err.message);
      }
    });
  }

  /**
   * Configure paths only (for additional computers)
   */
  configurePathsOnly(): void {
    if (!this.isConfigValid()) {
      this.showError('Please fill in all required fields');
      return;
    }

    this.isLoading = true;

    this.migrationService.configurePaths({
      computerName: this.migrationConfig.computerName,
      nasRoot: this.migrationConfig.nasRoot,
      clipsFolder: this.migrationConfig.clipsFolder,
      downloadsFolder: this.migrationConfig.downloadsFolder,
      librariesFolder: this.migrationConfig.librariesFolder,
    }).subscribe({
      next: (result) => {
        this.isLoading = false;
        this.showSuccess('Path mapping configured! This computer is now connected to the shared database.');
        this.loadStatus();
      },
      error: (err) => {
        this.isLoading = false;
        this.showError('Configuration failed: ' + err.error?.message || err.message);
      }
    });
  }

  /**
   * Show success message
   */
  showSuccess(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 5000,
      panelClass: ['success-snackbar']
    });
  }

  /**
   * Show error message
   */
  showError(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 10000,
      panelClass: ['error-snackbar']
    });
  }

  /**
   * Show info message
   */
  showInfo(message: string): void {
    this.snackBar.open(message, 'Close', {
      duration: 5000,
      panelClass: ['info-snackbar']
    });
  }

  /**
   * Format file count for display
   */
  formatCount(count: number): string {
    return count.toLocaleString();
  }

  /**
   * Get progress percentage
   */
  getProgressPercentage(): number {
    if (!this.migrationProgress) return 0;
    return Math.round((this.migrationProgress.current / this.migrationProgress.total) * 100);
  }
}
