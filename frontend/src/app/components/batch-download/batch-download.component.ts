// clippy/frontend/src/app/components/batch-download/batch-download.component.ts
import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
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
import { Subscription, catchError, of, interval } from 'rxjs';

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
  
  // Map to store display names for URLs
  private urlDisplayNames: Map<string, string> = new Map();

  qualityOptions = QUALITY_OPTIONS;
  browserOptions = BROWSER_OPTIONS;
  
  private socketSubscription: Subscription | null = null;
  private settingsSubscription: Subscription | null = null;
  private downloadProgressSubscription: Subscription | null = null;
  private processingProgressSubscription: Subscription | null = null;
  private refreshSubscription: Subscription | null = null;
  private originalJobOrder: string[] = [];

  constructor(
    private fb: FormBuilder,
    private batchApiService: BatchApiService,
    private socketService: SocketService,
    private settingsService: SettingsService,
    private snackBar: MatSnackBar,
    private cdr: ChangeDetectorRef
  ) {
    this.batchForm = this.createBatchForm();
    this.configForm = this.createConfigForm();
  }
  
  ngOnInit(): void {
    this.settingsSubscription = this.settingsService.getSettings().subscribe((settings: Settings) => {
      this.updateDefaultValues(settings);
    });
    
    // Listen for batch queue updates
    this.socketService.onBatchQueueUpdated().subscribe(
      (status: BatchQueueStatus) => {
        console.log('Batch queue update received:', status);
        
        // Check download queue contents
        if (status.downloadQueue.length > 0) {
          console.log('Download queue jobs:', status.downloadQueue);
        }
            
        // If we get a status update, ensure our order tracking is up to date
        const allJobIds = [
          ...(status.downloadQueue || []).map(job => job.id),
          ...(status.processingQueue || []).map(job => job.id),
          ...(status.completedJobs || []).map(job => job.id),
          ...(status.failedJobs || []).map(job => job.id)
        ];
        
        // Add any new jobs to our tracking
        allJobIds.forEach(id => {
          if (!this.originalJobOrder.includes(id)) {
            this.originalJobOrder.push(id);
          }
        });
        
        this.cdr.detectChanges();
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
    
    // Listen for download started events for better status tracking
    this.socketService.onDownloadStarted().subscribe(
      (data: {url: string, jobId?: string}) => {
        if (data.jobId) {
          // Update the job status to downloading
          this.updateJobStatus(data.jobId, 'downloading', 'Starting download...');
        }
      }
    );
    
    // Listen for download completed events
    this.socketService.onDownloadCompleted().subscribe(
      (data: {outputFile: string, url: string, jobId?: string, isImage?: boolean}) => {
        if (data.jobId) {
          // For non-image downloads, they'll move to processing
          if (!data.isImage) {
            this.updateJobStatus(data.jobId, 'processing', 'Download complete, preparing to process...');
          } else {
            // For images, they're done immediately
            this.updateJobStatus(data.jobId, 'completed', 'Image download completed');
          }
        }
      }
    );
    
    // Listen for download failed events
    this.socketService.onDownloadFailed().subscribe(
      (data: {error: string, url: string, jobId?: string}) => {
        if (data.jobId) {
          this.updateJobStatus(data.jobId, 'failed', `Failed: ${data.error}`);
        }
      }
    );
    
    // Get initial batch status
    this.refreshBatchStatus();
    
    // Listen for batch completion
    this.socketService.onBatchCompleted().subscribe((data) => {
      this.snackBar.open(`Batch processing completed! ${data.completedJobsCount} completed, ${data.failedJobsCount} failed.`, 'Dismiss', { duration: 5000 });
      this.refreshBatchStatus();
    });
    
    // Refresh status periodically (every 10 seconds)
    this.refreshSubscription = interval(10000).subscribe(() => {
      this.refreshBatchStatus();
    });
    
    // Connection status handling
    this.socketService.onConnect().subscribe(() => {
      this.refreshBatchStatus();
    });
    
    this.socketService.onDisconnect().subscribe(() => {
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
    
    if (this.refreshSubscription) {
      this.refreshSubscription.unsubscribe();
    }
  }
  
  updateJobStatus(jobId: string, status: string, task: string): void {
    if (!this.batchQueueStatus) return;
    
    // Function to find and update job status in a queue
    const updateJobStatusInQueue = (queue: any[]) => {
      const job = queue.find(j => j.id === jobId);
      if (job) {
        job.status = status;
        job.currentTask = task;
        return true;
      }
      return false;
    };
    
    // Try to find the job in all queues
    const queues = [
      this.batchQueueStatus.downloadQueue || [],
      this.batchQueueStatus.processingQueue || [],
      this.batchQueueStatus.completedJobs || [],
      this.batchQueueStatus.failedJobs || []
    ];
    
    let found = false;
    for (const queue of queues) {
      if (updateJobStatusInQueue(queue)) {
        found = true;
        break;
      }
    }
    
    // If job was found and updated, trigger change detection
    if (found) {
      this.cdr.detectChanges();
    }
  }
  
  /**
   * Extract a readable name from a URL
   */
  getShortUrl(url: string): string {
    try {
      // Try to extract just the main part of the URL
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/');
      
      // Extract domain for better context
      const domainName = urlObj.hostname
        .replace('www.', '')
        .split('.')[0];
      
      // Special handling for common video sites
      if (domainName === 'youtube' || domainName === 'youtu') {
        // YouTube URLs - extract video ID from query params or path
        const videoId = urlObj.searchParams.get('v') || 
          (pathParts.length > 1 ? pathParts[pathParts.length - 1] : '');
        
        return `youtube: ${videoId || 'video'}`;
      }
      
      if (domainName === 'vimeo') {
        // Vimeo URLs - usually have the ID in the path
        const videoId = pathParts.filter(p => p.length > 0).pop();
        return `vimeo: ${videoId || 'video'}`;
      }
      
      if (domainName === 'reddit') {
        // Reddit URLs - extract subreddit and post title
        const filteredParts = pathParts.filter(part => part.length > 0);
        
        // Typical reddit URL: reddit.com/r/subreddit/comments/id/title
        if (filteredParts.length >= 5 && filteredParts[0] === 'r') {
          const subreddit = filteredParts[1];
          const title = filteredParts[4]; // Title is usually the last part
          if (title) {
            // Clean up the title
            return `reddit: ${this.formatUrlPart(title)}`;
          }
          return `reddit: r/${subreddit} post`;
        }
        
        // Fallback for other reddit URLs
        return 'reddit: post';
      }
      
      // Generic URL handling for other sites
      // Look for a meaningful part in the path
      const meaningfulPart = pathParts
        .filter(part => part.length > 0 && !part.includes('comments'))
        .pop();
        
      if (meaningfulPart) {
        // Clean up the part (remove underscores, dashes)
        return `${domainName}: ${this.formatUrlPart(meaningfulPart)}`;
      }
      
      // Skip query string handling since it's causing TypeScript issues
      // Just use the domain name
      return domainName;
    } catch (e) {
      // If parsing fails, return a portion of the URL
      return url.substring(0, 30) + (url.length > 30 ? '...' : '');
    }
  }
  
  /**
   * Format a URL part to make it more readable
   */
  private formatUrlPart(part: string): string {
    if (!part || typeof part !== 'string') {
      return 'unknown';
    }
    
    // Replace dashes, underscores, and plus signs with spaces
    let formatted = part.replace(/[-_+]/g, ' ');
    
    // Decode URI component to handle URL encoding
    try {
      formatted = decodeURIComponent(formatted);
    } catch (e) {
      // If decoding fails, use the original string
    }
    
    // Remove file extensions
    formatted = formatted.replace(/\.(html|php|aspx|htm|jsp)$/, '');
    
    // Trim to reasonable length
    if (formatted.length > 40) {
      formatted = formatted.substring(0, 40) + '...';
    }
    
    return formatted;
  }
    
  /**
   * Get a human-readable display name for a job
   */
  getDisplayName(job: any): string {
    if (!job) {
      return 'Unknown';
    }
    
    // First priority: use the displayName property that we added to job objects
    if (job.displayName && typeof job.displayName === 'string' && job.displayName.trim() !== '') {
      return job.displayName;
    }
    
    // Second priority: check if we have a stored display name for this URL in our map
    if (job.url && this.urlDisplayNames.has(job.url)) {
      return this.urlDisplayNames.get(job.url) as string;
    }
    
    // Third priority: use the output file name if available (for completed jobs)
    if (job.outputFile) {
      try {
        // Extract just the filename from the path
        const parts = job.outputFile.split(/[\/\\]/);
        const filename = parts[parts.length - 1];
        
        // Store it for future reference
        if (job.url) {
          this.urlDisplayNames.set(job.url, filename);
        }
        
        return filename;
      } catch (e) {
        // If parsing fails, fall back to URL
        console.warn('Failed to parse output file path:', e);
      }
    }
    
    // Last resort: use a truncated URL
    if (job.url) {
      const displayName = job.url.length > 50 ? job.url.substring(0, 50) + '...' : job.url;
      return displayName;
    }
    
    return 'Unknown Job';
  }

  // Update progress for a specific job
  updateJobProgress(jobId: string, progress: number, task: string | undefined): void {
    if (!this.batchQueueStatus) return;
    
    // Function to find and update job in a queue
    const updateJobInQueue = (queue: any[]) => {
      const job = queue.find(j => j.id === jobId);
      if (job) {
        job.progress = progress;
        if (task !== undefined) {
          job.currentTask = task;
        }
        return true;
      }
      return false;
    };
    
    // Try to find the job in all queues
    const queues = [
      this.batchQueueStatus.downloadQueue || [],
      this.batchQueueStatus.processingQueue || [],
      this.batchQueueStatus.completedJobs || [],
      this.batchQueueStatus.failedJobs || []
    ];
    
    let found = false;
    for (const queue of queues) {
      if (updateJobInQueue(queue)) {
        found = true;
        break;
      }
    }
    
    // If job was found and updated, trigger change detection
    if (found) {
      this.cdr.detectChanges();
    }
  }
  
  // Get all jobs as a single array for display
  getAllJobsForDisplay(): any[] {
    if (!this.batchQueueStatus) return [];
    
    // Combine all jobs from all sources into a single map for lookups
    const jobsMap = new Map<string, any>();
    
    // Add all jobs to the map by ID for quick access
    [
      ...(this.batchQueueStatus.downloadQueue || []),
      ...(this.batchQueueStatus.processingQueue || []),
      ...(this.batchQueueStatus.activeDownloads.map(id => ({ id })) || []),
      ...(this.batchQueueStatus.completedJobs || []),
      ...(this.batchQueueStatus.failedJobs || [])
    ].forEach(job => {
      if (job && job.id) {
        jobsMap.set(job.id, job);
      }
    });
    
    const newJobIds = Array.from(jobsMap.keys()).filter(id => !this.originalJobOrder.includes(id));
    if (newJobIds.length > 0) {
      newJobIds.forEach(id => {
        this.originalJobOrder.push(id);
        console.log(`Added new job ${id} to original order tracking`);
      });
    }
    
    // Filter out jobs that no longer exist
    this.originalJobOrder = this.originalJobOrder.filter(id => jobsMap.has(id));
    
    // Create the result array using the original order
    const result = this.originalJobOrder.map(id => {
      const job = jobsMap.get(id);
      if (!job) {
        // This should almost never happen since we filter above
        return null;
      }
      return job;
    }).filter(job => job !== null);
    
    return result;
  }
    
  /**
   * Check if a job is in the processing queue
   */
  isProcessingJob(job: any): boolean {
    return job.status === 'processing' || 
           (job.queueType === 'process' && job.status === 'queued');
  }
  
  /**
   * Get CSS class for job status with null check
   */
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
    
  /**
   * Get both status and queue type classes
   */
  getJobStatusClassWithQueueType(job: any): string {
    if (!job) return '';
    
    // First, check if it's actively downloading
    if (this.batchQueueStatus?.activeDownloads.includes(job.id) || job.status === 'downloading') {
      return 'status-downloading';
    }
    
    // Next, handle processing queue
    if (job.queueType === 'process' && job.status === 'queued') {
      return 'status-processing-queued';
    }
    
    // Then use the normal status class
    return this.getJobStatusClass(job.status);
  }
    
  /**
   * Get icon for job status with null check
   */
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
  
  /**
   * Get color for status chip with null check
   */
  getStatusChipColor(status: string): string {
    if (!status) return 'default';
    
    switch (status) {
      case 'queued': return 'primary';
      case 'downloading': return 'primary';
      case 'processing': return 'accent';
      case 'completed': return 'primary';
      case 'failed': return 'warn';
      default: return 'default';
    }
  }
  
  /**
   * Get color for progress bar with null check
   */
  getProgressBarColor(status: string): string {
    if (!status) return 'primary';
    
    switch (status) {
      case 'downloading': return 'primary';
      case 'processing': return 'accent';
      case 'completed': return 'primary';
      case 'failed': return 'warn';
      default: return 'primary';
    }
  }
  
  /**
   * Get default task text based on status
   */
  getDefaultTaskForStatus(status: string): string {
    switch (status) {
      case 'queued': return 'Waiting in queue...';
      case 'downloading': return 'Downloading...';
      case 'processing': return 'Processing...';
      case 'completed': return 'Download completed';
      case 'failed': return 'Download failed';
      default: return 'Waiting...';
    }
  }
  
  /**
   * Check if there are any active jobs
   */
  hasActiveJobs(): boolean {
    if (!this.batchQueueStatus) return false;
    
    return (
      this.batchQueueStatus.downloadQueue.length > 0 ||
      this.batchQueueStatus.processingQueue.length > 0 ||
      this.batchQueueStatus.activeDownloads.length > 0 ||
      (this.batchQueueStatus.completedJobs?.length || 0) > 0 ||
      (this.batchQueueStatus.failedJobs?.length || 0) > 0
    );
  }
  
  /**
   * Form creation and management
   */
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
          const safeUrl = this.sanitizeFilename(url);
          urlGroup.get('title')?.setValue(safeUrl);
          urlGroup.get('uploadDate')?.setValue('');
          urlGroup.get('fullFileName')?.setValue(safeUrl);
          
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
          
          // Sanitize the title before using it
          const safeTitle = this.sanitizeFilename(info.title);
          
          // Set the full filename for tooltip (which matches what the backend will create)
          const fullFileName = `${dateStr} ${safeTitle}`;
          
          // Update form values
          urlGroup.get('title')?.setValue(safeTitle);
          urlGroup.get('uploadDate')?.setValue(dateStr);
          urlGroup.get('fullFileName')?.setValue(fullFileName);
        } else {
          // Set fallback values
          const safeUrl = this.sanitizeFilename(url);
          urlGroup.get('title')?.setValue(safeUrl);
          urlGroup.get('uploadDate')?.setValue('');
          urlGroup.get('fullFileName')?.setValue(safeUrl);
        }
      });
  }

  private sanitizeFilename(input: string): string {
    if (!input) return 'Unknown';
    
    // Step 1: Replace characters that are illegal in macOS filenames
    let sanitized = input
      .replace(/[\/:]/g, '-')        // Replace : and / with hyphens
      .replace(/[\\<>*|?]/g, '')     // Remove characters illegal in most filesystems
      .replace(/"/g, '')             // Remove quotes
      .replace(/'/g, '')             // Remove single quotes
      .replace(/\u2018|\u2019/g, '') // Remove smart single quotes
      .replace(/\u201C|\u201D/g, '') // Remove smart double quotes
      .replace(/\uFEFF/g, '')        // Remove BOM
      .replace(/\u00A0/g, ' ')       // Replace non-breaking spaces with regular spaces
      .replace(/\u2002-\u2003/g, ' ') // Replace various Unicode spaces with regular spaces
      .replace(/\t/g, ' ')           // Replace tabs with spaces
      .replace(/\r?\n|\r/g, ' ')     // Replace line breaks with spaces
      .replace(/\u00A9/g, '(c)')     // Replace © with (c)
      .replace(/\u00AE/g, '(r)')     // Replace ® with (r)
      .replace(/\u2122/g, '(tm)');   // Replace ™ with (tm)
      
    // Step 2: Collapse multiple spaces into one
    sanitized = sanitized.replace(/\s+/g, ' ');
    
    // Step 3: Trim to reasonable length (avoid filesystem path length issues)
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 197) + '...';
    }
    
    // Step 4: Trim leading/trailing whitespace
    sanitized = sanitized.trim();
    
    // If nothing is left, provide a fallback
    if (!sanitized) {
      return 'Unknown';
    }
    
    return sanitized;
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
    
    // Validate URLs
    const validUrls = urlValues.filter(url => url && url.trim().length > 0);
    
    if (validUrls.length === 0) {
      this.snackBar.open('Please add at least one valid URL', 'Dismiss', { duration: 3000 });
      return;
    }
    
    // Create download options for each URL - adding sanitized displayName to each option
    const downloadOptions: DownloadOptions[] = [];
    
    validUrls.forEach((url, index) => {
      // Get the corresponding form group to extract metadata
      const urlGroup = urlControls[index] as FormGroup;
      
      // Get the full filename that was determined during metadata fetch and sanitize it
      let fullFileName = urlGroup.get('fullFileName')?.value || '';
      if (fullFileName) {
        fullFileName = this.sanitizeFilename(fullFileName);
      }
      
      // Create the download options with the sanitized displayName field
      downloadOptions.push({
        url,
        quality: formValues.quality,
        convertToMp4: formValues.convertToMp4,
        fixAspectRatio: formValues.fixAspectRatio,
        useCookies: formValues.useCookies,
        browser: formValues.browser,
        outputDir: formValues.outputDir,
        displayName: fullFileName || this.sanitizeFilename(url)
      });
      
      // Also store in the local map for immediate UI display
      if (fullFileName) {
        this.urlDisplayNames.set(url, fullFileName);
      } else {
        // Fallback to sanitized title or truncated URL if no filename
        const title = urlGroup.get('title')?.value;
        if (title && title.trim() !== '') {
          this.urlDisplayNames.set(url, this.sanitizeFilename(title));
        } else {
          // Last resort - sanitized and truncated URL
          const shortUrl = url.length > 50 ? url.substring(0, 50) + '...' : url;
          this.urlDisplayNames.set(url, this.sanitizeFilename(shortUrl));
        }
      }
    });
    
    // Add to batch queue
    this.batchApiService.addMultipleToBatchQueue(downloadOptions).subscribe({
      next: (response) => {
        this.snackBar.open(`Added ${response.jobIds.length} downloads to batch queue`, 'Dismiss', { duration: 3000 });
        
        // Create placeholder jobs in the UI immediately with the URLs and jobIds we know
        if (response.jobIds && response.jobIds.length > 0) {
          // Add each job to our tracking right away
          response.jobIds.forEach((jobId, index) => {
            if (!this.originalJobOrder.includes(jobId)) {
              this.originalJobOrder.push(jobId);
              
              // If we have the batch queue status, create a placeholder job
              if (this.batchQueueStatus) {
                const url = validUrls[index] || 'Unknown URL';
                
                // See if the job already exists in any queue
                const existingJob = [
                  ...(this.batchQueueStatus.downloadQueue || []),
                  ...(this.batchQueueStatus.processingQueue || []),
                  ...(this.batchQueueStatus.completedJobs || []),
                  ...(this.batchQueueStatus.failedJobs || [])
                ].find(job => job.id === jobId);
                
                if (!existingJob) {
                  // Get the display name we just set (should already be sanitized)
                  const displayName = this.urlDisplayNames.get(url) || this.sanitizeFilename(url);
                  
                  // Create a properly typed placeholder job
                  const placeholderJob: BatchJob = {
                    id: jobId,
                    url: url,
                    status: 'queued',
                    progress: 0,
                    currentTask: 'Waiting in queue...',
                    createdAt: new Date().toISOString(),
                    queueType: 'download',
                    displayName: displayName
                  };
                  
                  // Add to download queue array
                  this.batchQueueStatus.downloadQueue.push(placeholderJob);
                }
              }
            }
          });
          
          // Force change detection to show the new jobs immediately
          this.cdr.detectChanges();
        }
        
        // Wait a moment before refreshing to ensure backend has processed
        setTimeout(() => this.refreshBatchStatus(), 300);
        
        // Reset the form to a single empty URL
        this.batchForm.setControl('urls', this.fb.array([this.createUrlField()]));
        
        // Clear the textarea
        this.multiUrlText = '';
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
      next: () => {
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

        // Immediate refresh
        this.refreshBatchStatus();
      },
      error: (error) => {
        this.snackBar.open('Failed to update batch configuration', 'Dismiss', { duration: 3000 });
        console.error('Error updating batch config:', error);
      }
    });
  }

  cancelJob(jobId: string): void {
    this.batchApiService.cancelJob(jobId).subscribe({
      next: () => {
        this.snackBar.open('Job cancelled', 'Dismiss', { duration: 3000 });
        setTimeout(() => this.refreshBatchStatus(), 300);
      },
      error: (error) => {
        this.snackBar.open('Failed to cancel job', 'Dismiss', { duration: 3000 });
        console.error('Error cancelling job:', error);
      }
    });
  }
  
  retryJob(jobId: string): void {
    this.batchApiService.retryJob(jobId).subscribe({
      next: () => {
        this.snackBar.open('Job retried', 'Dismiss', { duration: 3000 });
        setTimeout(() => this.refreshBatchStatus(), 300);
      },
      error: (error) => {
        this.snackBar.open('Failed to retry job', 'Dismiss', { duration: 3000 });
        console.error('Error retrying job:', error);
      }
    });
  }

  clearQueue(): void {
    if (confirm('Are you sure you want to clear the batch queue?')) {
      this.batchApiService.clearBatchQueues().subscribe({
        next: () => {
          this.snackBar.open('Batch queue cleared', 'Dismiss', { duration: 3000 });
          
          // Clear local state immediately before server responds
          if (this.batchQueueStatus) {
            this.batchQueueStatus.downloadQueue = [];
            this.batchQueueStatus.processingQueue = [];
            this.batchQueueStatus.activeDownloads = [];
          }
          
          // Then refresh from server
          setTimeout(() => this.refreshBatchStatus(), 300);
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
        
        // Ensure we're tracking any new jobs from the server
        const allJobIds = [
          ...(status.downloadQueue || []).map(job => job.id),
          ...(status.processingQueue || []).map(job => job.id),
          ...(status.completedJobs || []).map(job => job.id),
          ...(status.failedJobs || []).map(job => job.id)
        ];
        
        allJobIds.forEach(id => {
          if (!this.originalJobOrder.includes(id)) {
            // This job came from the server but wasn't in our tracking
            // Add it to the end of our tracked order
            this.originalJobOrder.push(id);
          }
        });
        
        this.cdr.detectChanges();
      },
      error: (error) => {
        console.error('Error getting batch status:', error);
        
        // If we encounter an error but have a previous status, keep it
        if (!this.batchQueueStatus) {
          // Create an empty status as fallback
          this.batchQueueStatus = {
            downloadQueue: [],
            processingQueue: [],
            completedJobs: [],
            failedJobs: [],
            activeDownloads: [],
            maxConcurrentDownloads: 2,
            isProcessing: false
          };
        }
        
        // Show error notification to user
        this.snackBar.open('Failed to refresh batch status. Will try again later.', 'Dismiss', { 
          duration: 3000 
        });
        
        this.cdr.detectChanges();
      }
    });
  }
}