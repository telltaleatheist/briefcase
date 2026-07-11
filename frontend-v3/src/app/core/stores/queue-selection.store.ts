import { Injectable, computed, signal } from '@angular/core';

/**
 * Selection state for the queue page's staging (pending) rows.
 *
 * Mirrors SelectionStore, but scoped to the queue: it holds the RAW pending
 * job ids (prefixes already stripped) of the jobs the user has selected in the
 * queue cascade. The inspector reads this to host per-job config for pending
 * jobs, while the library SelectionStore stays untouched (InspectorStore
 * deliberately filters staging-/queue- ids out of the library selection).
 *
 * The queue-tab is the sole writer; it prunes ids whose job has left the
 * pending set (started or removed) so the inspector never points at a job that
 * no longer exists.
 */
@Injectable({ providedIn: 'root' })
export class QueueSelectionStore {
  /** Raw pending job ids (no `staging-`/week prefix). */
  selectedJobIds = signal<Set<string>>(new Set());

  count = computed(() => this.selectedJobIds().size);
  hasSelection = computed(() => this.count() > 0);
  firstId = computed(() => (this.count() > 0 ? [...this.selectedJobIds()][0] : null));

  set(ids: Iterable<string>): void {
    this.selectedJobIds.set(new Set(ids));
  }

  clear(): void {
    this.selectedJobIds.set(new Set());
  }
}
