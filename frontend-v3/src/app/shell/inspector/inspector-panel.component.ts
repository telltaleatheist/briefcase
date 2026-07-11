import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { CdkOverlayOrigin, OverlayModule } from '@angular/cdk/overlay';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { timer } from 'rxjs';
import { ConnectionsStore } from '../../core/stores/connections.store';
import { InspectorStore } from '../../core/stores/inspector.store';
import { SelectionStore } from '../../core/stores/selection.store';
import { WorkspaceAction, WorkspaceActionsService } from '../../core/stores/workspace-actions.service';
import { formatBytes, formatDate } from '../../core/format';
import { VideoTab } from '../../services/tabs.service';
import { UiButtonComponent } from '../../ui';

/**
 * Right inspector panel — details, pipeline status, connections, and actions
 * for the current selection.
 *
 * Dumb projection over InspectorStore/SelectionStore/ConnectionsStore; every
 * workspace action dispatches through the WorkspaceActions channel to the
 * persistent workspace host, which owns the real handlers. Transcript preview
 * and connections are fetched lazily by their stores (only while this panel
 * is open).
 */
@Component({
  selector: 'app-inspector-panel',
  standalone: true,
  imports: [OverlayModule, UiButtonComponent],
  templateUrl: './inspector-panel.component.html',
  styleUrls: ['./inspector-panel.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InspectorPanelComponent {
  store = inject(InspectorStore);
  selection = inject(SelectionStore);
  connectionsStore = inject(ConnectionsStore);
  private actions = inject(WorkspaceActionsService);
  private router = inject(Router);

  /** Whether an AI provider is configured (Analyze affordances). */
  aiReady = input(false);
  /** AI readiness unknown — the availability probe failed. */
  aiCheckFailed = input(false);
  /** Collections ("tabs") for the Add to Collection menu. */
  collections = input<VideoTab[]>([]);

  collectionsMenuOpen = signal(false);

  /**
   * The "Add to Collection…" trigger — queried instead of a template ref
   * because it lives inside @if branches (single vs multi selection), whose
   * template reference variables aren't visible at the template top level.
   */
  collectionsTrigger = viewChild(CdkOverlayOrigin);

  item = this.store.singleItem;
  kind = this.store.singleItemKind;

  kindIcon = computed(() => {
    switch (this.kind()) {
      case 'web': return '🌐';
      case 'doc': return '📄';
      default: return null; // videos show a thumbnail
    }
  });

  resolution = computed(() => {
    const item = this.item();
    if (!item?.width || !item?.height) return null;
    return `${item.width}×${item.height}${item.fps ? ` · ${Math.round(item.fps)}fps` : ''}`;
  });

  addedDate = computed(() => {
    const item = this.item();
    return formatDate(item?.addedAt ?? item?.downloadDate ?? item?.uploadDate);
  });

  size = computed(() => formatBytes(this.item()?.size));

  /** Transcript belongs to the currently selected item only. */
  transcript = computed(() => {
    const transcript = this.store.transcript();
    const item = this.item();
    return transcript && item && transcript.videoId === item.id ? transcript : null;
  });

  /** Whether timestamped rendering is even possible for this transcript. */
  hasTimestamps = computed(() => (this.transcript()?.segments?.length ?? 0) > 0);

  /** Timestamps default OFF — clean flowing text. */
  showTimestamps = signal(false);

  /** Brief "Copied ✓" confirmation state. */
  copied = signal(false);
  private destroyRef = inject(DestroyRef);

  copyTranscript(): void {
    const transcript = this.transcript();
    if (!transcript) return;
    const text =
      this.showTimestamps() && transcript.segments
        ? transcript.segments.map(s => `[${s.start}] ${s.text}`).join('\n')
        : transcript.plainText;
    navigator.clipboard.writeText(text).then(() => {
      this.copied.set(true);
      timer(1500)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.copied.set(false));
    });
  }

  /** Exactly two items selected — the "Connect these two" case. */
  isPair = computed(() => this.store.selectedItems().length === 2);

  kindIconFor(kind: string): string {
    switch (kind) {
      case 'web': return '🌐';
      case 'doc': return '📄';
      default: return '🎞';
    }
  }

  kindLabelFor(kind: string): string {
    switch (kind) {
      case 'web': return 'Web Archive';
      case 'doc': return 'Document';
      default: return 'Video';
    }
  }

  /**
   * Jump to a connected item. Navigates to its full-info view — the same
   * behavior as cascade's existing relationship rows.
   */
  openConnected(videoId: string): void {
    this.router.navigate(['/video', videoId]);
  }

  /** Open the toolbar's Process popover for the current selection. */
  requestProcess(): void {
    this.actions.requestProcessPopover();
  }

  dispatch(action: WorkspaceAction): void {
    this.actions.dispatch(action);
  }

  addToCollection(tabId: string): void {
    this.collectionsMenuOpen.set(false);
    this.dispatch({ type: 'addSelectionToTab', tabId });
  }

  addToNewCollection(): void {
    this.collectionsMenuOpen.set(false);
    this.dispatch({ type: 'createTabWithSelection' });
  }
}
