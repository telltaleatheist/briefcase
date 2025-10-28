import { Component, OnInit, OnDestroy, Inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatRadioModule } from '@angular/material/radio';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatExpansionModule, MatExpansionPanel } from '@angular/material/expansion';
import { MatDividerModule } from '@angular/material/divider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';

interface AnalysisJob {
  id: string;
  status: string;
  progress: number;
  currentPhase: string;
  error?: string;
  videoPath?: string;
  transcriptPath?: string;
  analysisPath?: string;
}

@Component({
  selector: 'app-video-analysis',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatRadioModule,
    MatProgressBarModule,
    MatExpansionModule,
    MatDividerModule,
    MatTabsModule,
    MatDialogModule,
  ],
  templateUrl: './video-analysis.component.html',
  styleUrls: ['./video-analysis.component.scss']
})
export class VideoAnalysisComponent implements OnInit, OnDestroy {
  analysisForm: FormGroup;
  currentJob: AnalysisJob | null = null;
  isProcessing = false;

  @ViewChild(MatExpansionPanel) advancedPanel!: MatExpansionPanel;

  private pollingInterval: any = null;

  constructor(
    private fb: FormBuilder,
    private snackBar: MatSnackBar,
    private dialog: MatDialog,
  ) {
    this.analysisForm = this.createForm();
  }

  async ngOnInit(): Promise<void> {
    // Load saved settings (AI model, etc.)
    await this.loadSettings();

    // Check for any active jobs and restore state
    await this.checkForActiveJobs();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  createForm(): FormGroup {
    return this.fb.group({
      inputType: ['url', Validators.required],
      input: ['', Validators.required],
      aiModel: ['qwen2.5:7b', Validators.required],
      ollamaEndpoint: ['http://localhost:11434'],
      whisperModel: ['base'],
      language: ['en'],
      outputPath: [''],
    });
  }

  async onSubmit(): Promise<void> {
    if (this.analysisForm.invalid) {
      this.snackBar.open('Please fill in all required fields', 'Dismiss', { duration: 3000 });
      return;
    }

    const formValue = this.analysisForm.value;

    try {
      this.isProcessing = true;

      // Start analysis via API (backend will check model availability)
      const response = await fetch('/api/api/analysis/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formValue),
      });

      if (!response.ok) {
        const errorData = await response.json();

        // Check if it's a model unavailability error (HTTP 412)
        if (response.status === 412 && errorData.instructions) {
          this.showModelUnavailableDialog(formValue.aiModel, errorData.instructions);
          this.isProcessing = false;
          return;
        }

        throw new Error(errorData.message || 'Failed to start analysis');
      }

      const result = await response.json();

      this.currentJob = {
        id: result.jobId,
        status: 'pending',
        progress: 0,
        currentPhase: 'Starting analysis...',
      };

      this.snackBar.open('Analysis started!', 'Dismiss', { duration: 3000 });

      // Start polling for progress updates
      this.startPolling();

    } catch (error: any) {
      this.snackBar.open(`Error: ${error.message}`, 'Dismiss', { duration: 5000 });
      this.isProcessing = false;
    }
  }

  /**
   * Start polling for job progress updates (REST polling - simple and reliable)
   */
  private startPolling(): void {
    // Clear any existing polling
    this.stopPolling();

    console.log('[Video Analysis] Starting REST polling for job:', this.currentJob?.id);

    // Poll every 500ms
    this.pollingInterval = setInterval(async () => {
      if (!this.currentJob) {
        this.stopPolling();
        return;
      }

      try {
        const response = await fetch(`/api/api/analysis/job/${this.currentJob.id}`);

        if (!response.ok) {
          console.error('[Video Analysis] Failed to fetch job status:', response.status);
          return;
        }

        const data = await response.json();

        if (data.success && data.job) {
          console.log('[Video Analysis] Polled job status:', data.job);

          // Update the entire job object
          this.currentJob = {
            ...this.currentJob,
            ...data.job
          };

          // Check if job is complete
          if (data.job.status === 'completed') {
            this.isProcessing = false;
            this.stopPolling();
            this.snackBar.open('Analysis complete!', 'Dismiss', { duration: 5000 });
          } else if (data.job.status === 'failed') {
            this.isProcessing = false;
            this.stopPolling();
            this.snackBar.open(`Analysis failed: ${data.job.error || 'Unknown error'}`, 'Dismiss', { duration: 5000 });
          }
        }
      } catch (error: any) {
        console.error('[Video Analysis] Polling error:', error);
      }
    }, 500);
  }

  /**
   * Stop polling for progress updates
   */
  private stopPolling(): void {
    if (this.pollingInterval) {
      console.log('[Video Analysis] Stopping REST polling');
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async browseFile(): Promise<void> {
    try {
      // Use Electron dialog API to select file
      const result = await (window as any).electron?.selectVideoFile();

      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const filePath = result.filePaths[0];
        this.analysisForm.patchValue({ input: filePath });
        this.snackBar.open('File selected', 'Dismiss', { duration: 2000 });
      }
    } catch (error) {
      console.error('Error selecting file:', error);
      this.snackBar.open('Failed to select file', 'Dismiss', { duration: 3000 });
    }
  }

  async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      this.analysisForm.patchValue({ input: text });
      this.snackBar.open('Pasted from clipboard', 'Dismiss', { duration: 2000 });
    } catch (error) {
      this.snackBar.open('Failed to paste from clipboard', 'Dismiss', { duration: 2000 });
    }
  }

  getProgressColor(): string {
    if (!this.currentJob) return 'primary';

    if (this.currentJob.status === 'completed') return 'accent';
    if (this.currentJob.status === 'failed') return 'warn';

    return 'primary';
  }

  getStatusIcon(): string {
    if (!this.currentJob) return 'info';

    switch (this.currentJob.status) {
      case 'downloading': return 'cloud_download';
      case 'extracting': return 'music_note';
      case 'transcribing': return 'mic';
      case 'analyzing': return 'psychology';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'hourglass_empty';
    }
  }

  private async loadSettings(): Promise<void> {
    // Load saved model from localStorage
    const savedModel = localStorage.getItem('clippy_ai_model');
    if (savedModel) {
      this.analysisForm.patchValue({ aiModel: savedModel });
    }
    // No validation - we'll check when user actually starts analysis
  }

  saveSettings(): void {
    const aiModel = this.analysisForm.get('aiModel')?.value;
    localStorage.setItem('clippy_ai_model', aiModel);
    this.snackBar.open('Settings saved', 'Dismiss', { duration: 2000 });

    // Close the advanced options accordion
    if (this.advancedPanel) {
      this.advancedPanel.close();
    }
  }

  async openAnalysisFile(): Promise<void> {
    if (this.currentJob?.analysisPath) {
      // Open file in default application using electron API
      try {
        await (window as any).electron?.openFile(this.currentJob.analysisPath);
      } catch (error) {
        this.snackBar.open('Failed to open file', 'Dismiss', { duration: 3000 });
      }
    }
  }

  async openTranscriptFile(): Promise<void> {
    if (this.currentJob?.transcriptPath) {
      try {
        await (window as any).electron?.openFile(this.currentJob.transcriptPath);
      } catch (error) {
        this.snackBar.open('Failed to open file', 'Dismiss', { duration: 3000 });
      }
    }
  }

  showModelUnavailableDialog(model: string, instructions: string): void {
    const dialogRef = this.dialog.open(ModelUnavailableDialog, {
      width: '600px',
      data: { model, instructions }
    });
  }

  /**
   * Check for any active jobs on component init
   */
  private async checkForActiveJobs(): Promise<void> {
    try {
      const response = await fetch('/api/api/analysis/jobs');
      if (!response.ok) return;

      const data = await response.json();
      if (data.success && data.jobs && data.jobs.length > 0) {
        // Find the first non-completed job
        const activeJob = data.jobs.find((job: AnalysisJob) =>
          job.status !== 'completed' && job.status !== 'failed'
        );

        if (activeJob) {
          console.log('[Video Analysis] Found active job on init:', activeJob.id);
          this.currentJob = activeJob;
          this.isProcessing = true;
          this.startPolling();
        }
      }
    } catch (error) {
      console.error('[Video Analysis] Error checking for active jobs:', error);
    }
  }

  getPhaseDescription(phase: string): string {
    const descriptions: {[key: string]: string} = {
      'Starting analysis...': 'Initializing video analysis pipeline',
      'Downloading video...': 'Fetching video from URL',
      'Extracting audio...': 'Extracting audio track from video file',
      'Loading Whisper model (base)...': 'Loading AI transcription model into memory',
      'Transcribing audio (this may take a few minutes)...': 'Converting speech to text using Whisper AI',
      'Transcription complete, formatting results...': 'Generating transcript file with timestamps',
      'Starting AI analysis...': 'Initializing Ollama AI model for content analysis',
      'Analyzing transcript...': 'AI is reading and analyzing the transcript content',
      'Finding interesting sections...': 'AI is identifying notable quotes and moments',
      'Analysis complete...': 'Finalizing analysis report'
    };
    return descriptions[phase] || phase || 'Processing...';
  }
}

// Dialog component for model unavailable
@Component({
  selector: 'model-unavailable-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <div class="model-dialog">
      <h2 mat-dialog-title>
        <mat-icon>error_outline</mat-icon>
        AI Model Not Available
      </h2>
      <mat-dialog-content>
        <p class="dialog-message">
          The AI model <strong>{{ data.model }}</strong> is not currently available on your system.
        </p>

        <div class="instructions-box">
          <h3>Installation Instructions:</h3>
          <pre>{{ data.instructions }}</pre>
        </div>

        <p class="dialog-note">
          After installing the model, try starting the analysis again.
        </p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-raised-button color="primary" mat-dialog-close>
          <mat-icon>check</mat-icon>
          OK
        </button>
      </mat-dialog-actions>
    </div>
  `,
  styles: [`
    .model-dialog {
      h2 {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--primary-orange);
        margin: 0;
      }

      mat-icon {
        color: var(--primary-orange);
      }
    }

    .dialog-message {
      margin: 1rem 0;
      font-size: 1rem;
      color: var(--text-primary);
    }

    .instructions-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--border-radius);
      padding: 1rem;
      margin: 1rem 0;

      h3 {
        margin: 0 0 0.5rem 0;
        font-size: 0.9rem;
        color: var(--primary-orange);
      }

      pre {
        background: var(--bg-primary);
        padding: 1rem;
        border-radius: 4px;
        font-family: 'Courier New', monospace;
        font-size: 0.875rem;
        line-height: 1.6;
        color: var(--text-primary);
        white-space: pre-wrap;
        margin: 0;
      }
    }

    .dialog-note {
      font-size: 0.9rem;
      color: var(--text-secondary);
      font-style: italic;
      margin: 1rem 0 0 0;
    }

    mat-dialog-actions {
      padding: 1rem 0 0 0;
      margin: 0;
    }
  `]
})
export class ModelUnavailableDialog {
  constructor(@Inject(MAT_DIALOG_DATA) public data: any) {}
}
