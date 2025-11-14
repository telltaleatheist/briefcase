import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Subject } from 'rxjs';
import { BackendUrlService } from './backend-url.service';
import { NotificationService } from './notification.service';

export interface ImportItem {
  id: string;
  path: string;
  filename: string;
  status: 'pending' | 'importing' | 'completed' | 'error';
  error?: string;
  progress?: number;
}

export interface ImportQueueState {
  items: ImportItem[];
  totalItems: number;
  completedItems: number;
  errorItems: number;
  isImporting: boolean;
  currentBatch: number;
  totalBatches: number;
  isMinimized: boolean;
}

/**
 * Background import queue service - handles imports without blocking UI
 */
@Injectable({
  providedIn: 'root'
})
export class ImportQueueService {
  private readonly BATCH_SIZE = 3; // Import 3 files at a time

  private queueState$ = new BehaviorSubject<ImportQueueState>({
    items: [],
    totalItems: 0,
    completedItems: 0,
    errorItems: 0,
    isImporting: false,
    currentBatch: 0,
    totalBatches: 0,
    isMinimized: false
  });

  private importComplete$ = new Subject<{ success: number; errors: number }>();

  constructor(
    private http: HttpClient,
    private backendUrlService: BackendUrlService,
    private notificationService: NotificationService
  ) {}

  /**
   * Get current queue state as observable
   */
  getQueueState() {
    return this.queueState$.asObservable();
  }

  /**
   * Get import complete event
   */
  getImportCompleteEvent() {
    return this.importComplete$.asObservable();
  }

  /**
   * Add files to import queue and start processing
   */
  async queueImport(filePaths: string[]) {
    // Filter out ._ files
    const validPaths = filePaths.filter(path => {
      const filename = path.split('/').pop() || '';
      return !filename.startsWith('._');
    });

    if (validPaths.length === 0) {
      this.notificationService.info('No Files', 'No valid files to import');
      return;
    }

    // Create import items
    const items: ImportItem[] = validPaths.map(path => ({
      id: this.generateId(),
      path,
      filename: path.split('/').pop() || path,
      status: 'pending'
    }));

    const totalBatches = Math.ceil(items.length / this.BATCH_SIZE);

    // Update state
    this.queueState$.next({
      items,
      totalItems: items.length,
      completedItems: 0,
      errorItems: 0,
      isImporting: true,
      currentBatch: 0,
      totalBatches,
      isMinimized: false
    });

    // Start processing in background
    this.processQueue();
  }

  /**
   * Process import queue in batches
   */
  private async processQueue() {
    const state = this.queueState$.value;

    if (!state.isImporting) {
      return;
    }

    // Get next batch of pending items
    const pendingItems = state.items.filter(item => item.status === 'pending');

    if (pendingItems.length === 0) {
      // All done!
      this.finishImport();
      return;
    }

    const batch = pendingItems.slice(0, this.BATCH_SIZE);
    const batchPaths = batch.map(item => item.path);

    // Update batch number
    const currentBatch = state.currentBatch + 1;
    this.updateState({ currentBatch });

    // Mark batch as importing
    for (const item of batch) {
      this.updateItemStatus(item.id, 'importing');
    }

    try {
      // Import batch via backend
      const url = await this.backendUrlService.getApiUrl('/database/import');
      const response = await this.http.post<any>(url, {
        videoPaths: batchPaths
      }).toPromise();

      // Update items based on response
      if (response.success) {
        // Mark all as completed for now (we can enhance this later with per-file status)
        for (const item of batch) {
          this.updateItemStatus(item.id, 'completed');
        }

        // Handle any errors from response
        if (response.errors && response.errors.length > 0) {
          for (const error of response.errors) {
            // Try to match error to item
            const errorItem = batch.find(item => error.includes(item.filename));
            if (errorItem) {
              this.updateItemStatus(errorItem.id, 'error', error);
            }
          }
        }
      }
    } catch (error: any) {
      console.error('Batch import failed:', error);

      // Mark batch as error
      for (const item of batch) {
        this.updateItemStatus(item.id, 'error', error.message || 'Import failed');
      }
    }

    // Small delay before next batch to prevent overwhelming the system
    await this.delay(500);

    // Process next batch
    this.processQueue();
  }

  /**
   * Update item status
   */
  private updateItemStatus(itemId: string, status: ImportItem['status'], error?: string) {
    const state = this.queueState$.value;
    const items = state.items.map(item => {
      if (item.id === itemId) {
        return { ...item, status, error };
      }
      return item;
    });

    const completedItems = items.filter(i => i.status === 'completed').length;
    const errorItems = items.filter(i => i.status === 'error').length;

    this.queueState$.next({
      ...state,
      items,
      completedItems,
      errorItems
    });
  }

  /**
   * Update state
   */
  private updateState(updates: Partial<ImportQueueState>) {
    this.queueState$.next({
      ...this.queueState$.value,
      ...updates
    });
  }

  /**
   * Finish import process
   */
  private finishImport() {
    const state = this.queueState$.value;

    this.updateState({ isImporting: false });

    // Show completion notification
    if (state.errorItems === 0) {
      this.notificationService.success(
        'Import Complete',
        `Successfully imported ${state.completedItems} files`
      );
    } else if (state.completedItems === 0) {
      this.notificationService.error(
        'Import Failed',
        `All ${state.errorItems} files failed to import`
      );
    } else {
      this.notificationService.warning(
        'Import Complete with Errors',
        `${state.completedItems} succeeded, ${state.errorItems} failed`
      );
    }

    // Emit completion event
    this.importComplete$.next({
      success: state.completedItems,
      errors: state.errorItems
    });
  }

  /**
   * Clear queue
   */
  clearQueue() {
    this.queueState$.next({
      items: [],
      totalItems: 0,
      completedItems: 0,
      errorItems: 0,
      isImporting: false,
      currentBatch: 0,
      totalBatches: 0,
      isMinimized: false
    });
  }

  /**
   * Cancel import
   */
  cancelImport() {
    this.updateState({ isImporting: false, isMinimized: false });

    this.notificationService.info(
      'Import Cancelled',
      'Import process has been cancelled'
    );
  }

  /**
   * Set minimized state
   */
  setMinimized(minimized: boolean) {
    this.updateState({ isMinimized: minimized });
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `import_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
