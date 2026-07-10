import { ChangeDetectionStrategy, Component, computed, inject, input, signal, viewChild } from '@angular/core';
import { CdkOverlayOrigin, OverlayModule } from '@angular/cdk/overlay';
import { InspectorStore } from '../../core/stores/inspector.store';
import { SelectionStore } from '../../core/stores/selection.store';
import { WorkspaceAction, WorkspaceActionsService } from '../../core/stores/workspace-actions.service';
import { formatBytes, formatDate } from '../../core/format';
import { VideoTab } from '../../services/tabs.service';
import { UiButtonComponent } from '../../ui';

/**
 * Right inspector panel — details, pipeline status, and actions for the
 * current selection.
 *
 * Dumb projection over InspectorStore/SelectionStore; every action dispatches
 * through the WorkspaceActions channel to the persistent workspace host,
 * which owns the real handlers. The transcript preview is fetched lazily by
 * the store (only while this panel is open).
 *
 * The mockup's "Connected" section is Phase 6 (connections data model) and is
 * intentionally absent here.
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
  private actions = inject(WorkspaceActionsService);

  /** Whether an AI provider is configured (Analyze affordances). */
  aiReady = input(false);
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

  /** Transcript preview belongs to the currently selected item only. */
  preview = computed(() => {
    const preview = this.store.transcriptPreview();
    const item = this.item();
    return preview && item && preview.videoId === item.id ? preview.text : null;
  });

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
