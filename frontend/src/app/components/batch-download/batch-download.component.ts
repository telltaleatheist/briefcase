// clippy/frontend/src/app/components/batch-download/batch-download.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatDividerModule } from '@angular/material/divider';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { BatchApiService } from '../../services/batch-api.service';
import { SocketService } from '../../services/socket.service';
import { SettingsService } from '../../services/settings.service';
import { BROWSER_OPTIONS, QUALITY_OPTIONS } from '../download-form/download-form.constants';
import { BatchQueueStatus, DownloadOptions, VideoInfo, DownloadProgress, BatchJob } from '../../models/download.model';
import { Settings } from '../../models/settings.model';
import { Subscription, catchError, of } from 'rxjs';

@Component({
  selector: 'app-batch-download',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatCheckboxModule,
    MatExpansionModule,
    MatProgressBarModule,
    MatListModule,
    MatChipsModule,
    MatDividerModule,
    MatTooltipModule
  ],
  templateUrl: './batch-download.component.html',
  styleUrls: ['./batch-download.component.scss']
})
export class BatchDownloadComponent implements OnInit, OnDestroy {
  batchForm: FormGroup;
  configForm: FormGroup;
  batchQueueStatus: BatchQueueStatus | null = null;
  multiUrlText: string = '';
  private disableUrlChangesListener = false;
  private textareaIntentionallyCleared = false;
  private urlChangeSubscription: Subscription | null = null;

  qualityOptions = QUALITY_OPTIONS;
  browserOptions = BROWSER_OPTIONS;
  
  private socketSubscription: Subscription | null = null;
  private settingsSubscription: Subscription | null = null;
  private downloadProgressSubscription: Subscription | null = null;
  private processingProgressSubscription: Subscription | null = null;
  
  constructor(
    private fb: FormBuilder,
    private batchApiService: BatchApiService,
    private socketService: SocketService,
    private settingsService: SettingsService,
    private snackBar: MatSnackBar
  ) {
    this.batchForm = this.createBatchForm();
    this.configForm = this.createConfigForm();
  }

  ngOnInit(): void {
    // Load user settings
    this.settingsSubscription = this.settingsService.getSettings().subscribe((settings: Settings) => {
      this.updateDefaultValues(settings);
    });
    
    // Listen for batch queue updates
    this.socketSubscription = this.socketService.onBatchQueueUpdated().subscribe(
      (status: BatchQueueStatus) => {
        this.batchQueueStatus = status;
      }
    );
    
    // Listen for download progress updates
    this.downloadProgressSubscription = this.socketService.onDownloadProgress().subscribe(
      (progress: DownloadProgress) => {
        if (progress.jobId) {
          this.updateJobProgress(progress.jobId, progress.progress, progress.task);
        }
      }
    );
    
    // Listen for processing progress updates
    this.processingProgressSubscription = this.socketService.onProcessingProgress().subscribe(
      (progress: DownloadProgress) => {
        if (progress.jobId) {
          this.updateJobProgress(progress.jobId, progress.progress, progress.task);
        }
      }
    );
    
    // Get initial batch status
    this.refreshBatchStatus();
    
    // Listen for batch completion
    this.socketService.onBatchCompleted().subscribe(() => {
      this.snackBar.open('Batch processing completed!', 'Dismiss', { duration: 5000 });
      this.refreshBatchStatus();
    });
  }

  ngOnDestroy(): void {
    if (this.socketSubscription) {
      this.socketSubscription.unsubscribe();
    }
    
    if (this.settingsSubscription) {
      this.settingsSubscription.unsubscribe();
    }
    
    if (this.urlChangeSubscription) {
      this.urlChangeSubscription.unsubscribe();
    }
    
    if (this.downloadProgressSubscription) {
      this.downloadProgressSubscription.unsubscribe();
    }
    
    if (this.processingProgressSubscription) {
      this.processingProgressSubscription.unsubscribe();
    }
  }
  
  // Update progress for a specific job
  updateJobProgress(jobId: string, progress: number, task: string | undefined): void {
    if (!this.batchQueueStatus) return;
    
    // Check all queues for the job
    const queues = [
      this.batchQueueStatus.downloadQueue,
      this.batchQueueStatus.processingQueue,
      this.batchQueueStatus.completedJobs || [],
      this.batchQueueStatus.failedJobs || []
    ];
    
    for (const queue of queues) {
      const job = queue.find(j => j.id === jobId);
      if (job) {
        job.progress = progress;
        // Only update task if it's defined
        if (task !== undefined) {
          job.currentTask = task;
        }
        // Don't break, as a job might appear in multiple queues during transitions
      }
    }
  }
  
  // Get all jobs as a single array for display
  getAllJobsForDisplay(): BatchJob[] {
    if (!this.batchQueueStatus) return [];
    
    const allJobs = [
      ...(this.batchQueueStatus.downloadQueue || []),
      ...(this.batchQueueStatus.processingQueue || []),
      ...(this.batchQueueStatus.completedJobs || []),
      ...(this.batchQueueStatus.failedJobs || [])
    ];
    
    // Put completed and failed jobs at the end
    return allJobs.sort((a, b) => {
      // Helper function to get sort priority
      const getPriority = (status: string): number => {
        switch (status) {
          case 'downloading': return 1;
          case 'processing': return 2;
          case 'queued': return 3;
          case 'completed': return 4;
          case 'failed': return 5;
          default: return 6;
        }
      };
      
      return getPriority(a.status) - getPriority(b.status);
    });
  }
  
  // Get CSS class for job status with null check
  getJobStatusClass(status: string | undefined): string {
    if (!status) return '';
    
    switch (status) {
      case 'queued': return 'status-queued';
      case 'downloading': return 'status-downloading';
      case 'processing': return 'status-processing';
      case 'completed': return 'status-completed';
      case 'failed': return 'status-failed';
      default: return '';
    }
  }
  
  // Get icon for job status with null check
  getJobStatusIcon(status: string | undefined): string {
    if (!status) return 'help';
    
    switch (status) {
      case 'queued': return 'queue';
      case 'downloading': return 'downloading';
      case 'processing': return 'settings';
      case 'completed': return 'check_circle';
      case 'failed': return 'error';
      default: return 'help';
    }
  }
  
  // Get color for status chip with null check
  getStatusChipColor(status: string | undefined): string {
    if (!status) return 'default';
    
    switch (status) {
      case 'queued': return 'primary';
      case 'downloading': return 'accent';
      case 'processing': return 'warn';
      case 'completed': return 'success';
      case 'failed': return 'warn';
      default: return 'default';
    }
  }
  
  // Get color for progress bar with null check
  getProgressBarColor(status: string | undefined): string {
    if (!status) return 'primary';
    
    switch (status) {
      case 'downloading': return 'primary';
      case 'processing': return 'accent';
      case 'completed': return 'primary';
      case 'failed': return 'warn';
      default: return 'primary';
    }
  }
  
  // Check if there are any active jobs
  hasActiveJobs(): boolean {
    if (!this.batchQueueStatus) return false;
    
    return (
      this.batchQueueStatus.downloadQueue.length > 0 ||
      this.batchQueueStatus.processingQueue.length > 0 ||
      (this.batchQueueStatus.completedJobs?.length || 0) > 0 ||
      (this.batchQueueStatus.failedJobs?.length || 0) > 0
    );
  }
  
  onMultiUrlInput(text: string): void {
    // Store the current focus state to restore it later
    const activeElement = document.activeElement;
    
    const urls = text
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0);
    
    // Get the current FormArray
    const urlsFormArray = this.batchForm.get('urls') as FormArray;
    
    // Temporarily turn off valueChanges emission to prevent feedback loop
    this.disableUrlChangesListener = true;
    
    // Clear and rebuild the form array entirely (simpler approach)
    while (urlsFormArray.length) {
      urlsFormArray.removeAt(0);
    }
    
    // Add new form controls for each URL
    urls.forEach(url => {
      urlsFormArray.push(this.createUrlFieldWithUrl(url));
      
      // Get the index of the just-added URL
      const index = urlsFormArray.length - 1;
      
      // Load the filename for this URL
      this.loadFileNameForUrl(index);
    });
    
    // If no URLs, ensure at least one empty field
    if (urlsFormArray.length === 0) {
      urlsFormArray.push(this.createUrlField());
    }
    
    // Re-enable the listener
    setTimeout(() => {
      this.disableUrlChangesListener = false;
    }, 0);
    
    // Focus back to the original element if it was the textarea
    if (activeElement && activeElement.tagName === 'TEXTAREA') {
      (activeElement as HTMLTextAreaElement).focus();
    }
  }
  
  onMultiUrlTextareaInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement)?.value || '';
    this.onMultiUrlInput(value);
  }
  
  createBatchForm(): FormGroup {
    const form = this.fb.group({
      urls: this.fb.array([this.createUrlField()]),
      quality: ['720'],
      convertToMp4: [true],
      fixAspectRatio: [true],
      useCookies: [false],
      browser: ['auto'],
      outputDir: ['']
    });
  
    // Store the subscription so we can unsubscribe later
    this.urlChangeSubscription = this.subscribeToUrlChanges(form.get('urls') as FormArray);
  
    return form;
  }

  subscribeToUrlChanges(urlArray: FormArray): Subscription {
    return urlArray.valueChanges.subscribe(values => {
      // Skip if the listener is disabled
      if (this.disableUrlChangesListener) return;
      
      const newText = values
        .map((v: { url: string; }) => v.url?.trim())
        .filter((v: string | any[]) => v?.length > 0)
        .join('\n');
      
      // Update the textarea with new content
      this.multiUrlText = newText;
    });
  }

  addUrlsFromTextarea(): void {
    console.log('Textarea content:', this.multiUrlText);
    
    if (!this.multiUrlText || this.multiUrlText.trim() === '') {
      this.snackBar.open('Please enter URLs in the textarea', 'Dismiss', { duration: 3000 });
      return;
    }
    
    // Process the URLs
    const urls = this.multiUrlText
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0);
      
    // Get the current FormArray
    const urlsFormArray = this.batchForm.get('urls') as FormArray;
    
    // Temporarily turn off valueChanges emission to prevent feedback loop
    this.disableUrlChangesListener = true;
    
    // Clear and rebuild the form array entirely
    while (urlsFormArray.length) {
      urlsFormArray.removeAt(0);
    }
    
    // Add new form controls for each URL
    urls.forEach(url => {
      urlsFormArray.push(this.createUrlFieldWithUrl(url));
      
      // Get the index of the just-added URL
      const index = urlsFormArray.length - 1;
      
      // Load the filename for this URL
      this.loadFileNameForUrl(index);
    });
    
    // If no URLs, ensure at least one empty field
    if (urlsFormArray.length === 0) {
      urlsFormArray.push(this.createUrlField());
    }
    
    // Clear the textarea
    this.multiUrlText = '';
    
    // IMPORTANT: Unsubscribe and set up a new subscription that doesn't update the textarea
    this.setupOneWayUrlBinding();
    
    // Re-enable the listener
    setTimeout(() => {
      this.disableUrlChangesListener = false;
    }, 0);
    
    this.snackBar.open('URLs added to the list', 'Dismiss', { duration: 3000 });
  }

  setupOneWayUrlBinding(): void {
    // First, unsubscribe from the existing subscription if it exists
    if (this.urlChangeSubscription) {
      this.urlChangeSubscription.unsubscribe();
      this.urlChangeSubscription = null;
    }
    
    // Set up a new subscription that doesn't update the textarea
    const urlArray = this.batchForm.get('urls') as FormArray;
    this.urlChangeSubscription = urlArray.valueChanges.subscribe(() => {
      // Do nothing - we want to keep the textarea empty
    });
  }
  
  createConfigForm(): FormGroup {
    return this.fb.group({
      maxConcurrentDownloads: [2, [Validators.required, Validators.min(1), Validators.max(10)]],
      enabled: [true]
    });
  }

  createUrlField(): FormGroup {
    return this.fb.group({
      url: ['', [Validators.required, Validators.pattern(/^https?:\/\/.+/)]],
      title: [''],
      uploadDate: [''],
      fullFileName: [''],
      loading: [false]
    });
  }
  
  createUrlFieldWithUrl(url: string): FormGroup {
    return this.fb.group({
      url: [url, [Validators.required, Validators.pattern(/^https?:\/\/.+/)]],
      title: [''],
      uploadDate: [''],
      fullFileName: [''],
      loading: [false]
    });
  }

  get urls(): FormArray {
    return this.batchForm.get('urls') as FormArray;
  }

  addUrlField(): void {
    this.urls.push(this.createUrlField());
  }

  removeUrlField(i: number): void {
    const urls = this.batchForm.get('urls') as FormArray;
    
    // Get the URL that's being removed
    const removedUrl = (urls.at(i) as FormGroup).get('url')?.value;
    
    // Remove the URL from the form array
    urls.removeAt(i);
    
    // Ensure at least one empty field remains
    if (urls.length === 0) {
      urls.push(this.createUrlField());
    }
  }

  loadFileNameForUrl(index: number): void {
    const urlsFormArray = this.batchForm.get('urls') as FormArray;
    const urlGroup = urlsFormArray.at(index) as FormGroup;
    const url = urlGroup.get('url')?.value;
    
    if (!url || url.trim() === '') {
      return;
    }
    
    // Set loading state
    urlGroup.get('loading')?.setValue(true);
    
    // Call the API to get video info
    this.batchApiService.getVideoInfo(url)
      .pipe(
        catchError(err => {
          console.error('Error fetching video info:', err);
          // Reset loading state
          urlGroup.get('loading')?.setValue(false);
          
          // Set default values
          urlGroup.get('title')?.setValue('URL ' + (index + 1));
          urlGroup.get('uploadDate')?.setValue('');
          urlGroup.get('fullFileName')?.setValue('URL ' + (index + 1));
          
          return of(null);
        })
      )
      .subscribe((info: VideoInfo | null) => {
        // Reset loading state
        urlGroup.get('loading')?.setValue(false);
        
        if (info && info.title) {
          // Get formatted date
          let dateStr = '';
          if (info.uploadDate) {
            dateStr = info.uploadDate;
          } else {
            // If no upload date, use today's date
            dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
          }
          
          // Set the full filename for tooltip (which matches what the backend will create)
          const fullFileName = `${dateStr} ${info.title}`;
          
          // Update form values
          urlGroup.get('title')?.setValue(info.title);
          urlGroup.get('uploadDate')?.setValue(dateStr);
          urlGroup.get('fullFileName')?.setValue(fullFileName);
        } else {
          // Set fallback values
          urlGroup.get('title')?.setValue('URL ' + (index + 1));
          urlGroup.get('uploadDate')?.setValue('');
          urlGroup.get('fullFileName')?.setValue('URL ' + (index + 1));
        }
      });
  }

  updateMultiUrlTextarea(): void {
    if (this.disableUrlChangesListener || this.textareaIntentionallyCleared) return;
    
    const urls = (this.batchForm.get('urls') as FormArray).controls
      .map(control => {
        const formGroup = control as FormGroup;
        return formGroup.get('url')?.value?.trim() || '';
      })
      .filter(url => url !== ''); // ignore empty fields
    
    this.multiUrlText = urls.join('\n');
  }

  pasteFromClipboard(index: number): void {
    navigator.clipboard.readText().then(text => {
        const urlGroup = this.urls.controls[index] as FormGroup;
        urlGroup.get('url')?.setValue(text);
        
        // Load filename for the pasted URL
        this.loadFileNameForUrl(index);
    });
  }

  updateDefaultValues(settings: Settings): void {
    this.batchForm.patchValue({
      quality: settings.quality,
      convertToMp4: settings.convertToMp4,
      fixAspectRatio: settings.fixAspectRatio,
      useCookies: false,
      browser: settings.browser,
      outputDir: settings.outputDir
    });
    
    this.configForm.patchValue({
      maxConcurrentDownloads: settings.maxConcurrentDownloads || 2,
      enabled: settings.batchProcessingEnabled !== undefined ? settings.batchProcessingEnabled : true
    });
  }

  onSubmit(): void {
    if (this.batchForm.invalid) {
      this.snackBar.open('Please fill in all required fields correctly', 'Dismiss', { duration: 3000 });
      return;
    }
    
    const urlControls = this.urls.controls;
    const urlValues = urlControls.map(control => (control as FormGroup).get('url')?.value);
    const formValues = this.batchForm.value;
    
    // Create download options for each URL
    const downloadOptions: DownloadOptions[] = urlValues.map(url => ({
      url,
      quality: formValues.quality,
      convertToMp4: formValues.convertToMp4,
      fixAspectRatio: formValues.fixAspectRatio,
      useCookies: formValues.useCookies,
      browser: formValues.browser,
      outputDir: formValues.outputDir
    }));
    
    // Add to batch queue
    this.batchApiService.addMultipleToBatchQueue(downloadOptions).subscribe({
      next: (response) => {
        this.snackBar.open(`Added ${response.jobIds.length} downloads to batch queue`, 'Dismiss', { duration: 3000 });
        this.refreshBatchStatus();
        
        // Reset the form to a single empty URL
        this.batchForm.setControl('urls', this.fb.array([this.createUrlField()]));
      },
      error: (error) => {
        this.snackBar.open('Failed to add downloads to batch queue', 'Dismiss', { duration: 3000 });
        console.error('Error adding to batch queue:', error);
      }
    });
  }

  saveConfig(): void {
    if (this.configForm.invalid) {
      return;
    }
    
    const config = this.configForm.value;
    
    this.batchApiService.updateBatchConfig(config).subscribe({
      next: (response) => {
        this.snackBar.open('Batch configuration updated', 'Dismiss', { duration: 3000 });
        
        // Get current settings and update just the batch fields
        this.settingsService.getSettings().subscribe(currentSettings => {
            const updatedSettings = {
            ...currentSettings,
            maxConcurrentDownloads: config.maxConcurrentDownloads,
            batchProcessingEnabled: config.enabled
            };
            this.settingsService.updateSettings(updatedSettings);
        });

        this.refreshBatchStatus();
      },
      error: (error) => {
        this.snackBar.open('Failed to update batch configuration', 'Dismiss', { duration: 3000 });
        console.error('Error updating batch config:', error);
      }
    });
  }

  clearQueue(): void {
    if (confirm('Are you sure you want to clear the batch queue?')) {
      this.batchApiService.clearBatchQueues().subscribe({
        next: () => {
          this.snackBar.open('Batch queue cleared', 'Dismiss', { duration: 3000 });
          this.refreshBatchStatus();
        },
        error: (error) => {
          this.snackBar.open('Failed to clear batch queue', 'Dismiss', { duration: 3000 });
          console.error('Error clearing batch queue:', error);
        }
      });
    }
  }

  refreshBatchStatus(): void {
    this.batchApiService.getBatchStatus().subscribe({
      next: (status) => {
        this.batchQueueStatus = status;
      },
      error: (error) => {
        console.error('Error getting batch status:', error);
      }
    });
  }

  pasteMultipleUrls(): void {
    navigator.clipboard.readText().then(text => {
      // Split by newlines, filter empty lines, and trim whitespace
      const urls = text.split(/\r?\n/)
        .map(url => url.trim())
        .filter(url => url.length > 0 && url.match(/^https?:\/\/.+/));
      
      if (urls.length === 0) {
        this.snackBar.open('No valid URLs found in clipboard', 'Dismiss', { duration: 3000 });
        return;
      }
      
      // Reset the form and add a field for each URL
      const urlsArray = this.fb.array([]);
      
      urls.forEach(url => {
        const group = this.createUrlFieldWithUrl(url);
        // Use "as any" to bypass the type checking for the push operation
        urlsArray.push(group as any);
      });

      this.batchForm.setControl('urls', urlsArray);
      
      // Load filenames for each URL
      for (let i = 0; i < urls.length; i++) {
        this.loadFileNameForUrl(i);
      }
      
      this.snackBar.open(`Added ${urls.length} URLs from clipboard`, 'Dismiss', { duration: 3000 });
    });
  }
}