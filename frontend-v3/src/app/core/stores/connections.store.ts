import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription, forkJoin } from 'rxjs';
import { VideoItem } from '../../models/video.model';
import { getApiBase } from '../runtime-url';
import { ItemKind, classifyItemKind } from '../item-kind';
import { InspectorStore } from './inspector.store';

/**
 * A member of the anchor's connected group, as shown in the inspector.
 *
 * A group member may be reachable only transitively (it need not share a
 * direct edge with the anchor), so there is no per-row relationship id to key
 * on — actions key on `videoId`.
 */
export interface ConnectedItem {
  videoId: string;
  title: string;
  kind: ItemKind;
}

/** One OTHER member of a connected group, as returned by the group endpoint. */
interface ConnectedGroupMemberDto {
  id: string;
  filename?: string;
  media_type?: string;
  file_extension?: string;
}

function toConnectedItem(record: ConnectedGroupMemberDto): ConnectedItem {
  return {
    videoId: record.id,
    title: record.filename ?? record.id,
    kind: classifyItemKind({
      id: record.id,
      mediaType: record.media_type,
      fileExtension: record.file_extension,
    } as VideoItem),
  };
}

/**
 * Connections (undirected links between library items) for the inspector.
 * Loaded lazily — only while the inspector is open and one or two items are
 * selected — mirroring InspectorStore's transcript-preview pattern.
 *
 * Connections are now transitive: an item belongs to a *group* (the connected
 * component of the relationship graph), and the inspector shows every OTHER
 * member of the anchor's group. Backed by:
 *   GET    /database/videos/:id/connected-group   (whole group)
 *   POST   /database/videos/:id/link              (add an edge)
 *   DELETE /database/videos/:id/connections       (remove item from its group)
 */
@Injectable({ providedIn: 'root' })
export class ConnectionsStore {
  private http = inject(HttpClient);
  private inspectorStore = inject(InspectorStore);

  private readonly apiBase = `${getApiBase()}/database`;

  /** The anchor's connected group (single- and pair-selection). */
  connections = signal<ConnectedItem[]>([]);
  connectionsLoading = signal(false);
  /**
   * Set when the connections fetch FAILED — a failed load must not render
   * (or cache) as "no connections" (fallback-audit high #11).
   */
  connectionsError = signal<string | null>(null);
  /**
   * Set when a connect/disconnect MUTATION failed (fully or partially). Kept
   * separate from `connectionsError` so the post-mutation refetch (which
   * clears the load error) does not silently swallow it — the refetch shows
   * the true server state and this flag says some of the change did not land.
   */
  mutationError = signal<string | null>(null);
  /** Which item the current `connections` belong to (null = none loaded). */
  private loadedForVideoId = signal<string | null>(null);
  /** Bumped after connect/disconnect (and by retry) to force a refetch. */
  private refreshCounter = signal(0);

  /** The selection pair when exactly two items are selected. */
  private selectedPair = computed<[VideoItem, VideoItem] | null>(() => {
    const items = this.inspectorStore.selectedItems();
    return items.length === 2 ? [items[0], items[1]] : null;
  });

  /**
   * When two items are selected: whether the second item is already in the
   * first item's group (directly or transitively). `connections` holds item
   * A's group; look item B up among it.
   */
  pairConnection = computed<ConnectedItem | null>(() => {
    const pair = this.selectedPair();
    if (!pair || this.loadedForVideoId() !== pair[0].id) return null;
    return this.connections().find(c => c.videoId === pair[1].id) ?? null;
  });

  /** True while an add/remove request is in flight. */
  mutating = signal(false);

  constructor() {
    effect(onCleanup => {
      this.refreshCounter(); // reload dependency
      const items = this.inspectorStore.selectedItems();
      const anchor = items.length === 1 || items.length === 2 ? items[0] : null;

      if (!anchor) {
        this.connectionsLoading.set(false);
        return;
      }
      if (this.loadedForVideoId() === anchor.id) {
        return; // already loaded for this item
      }

      this.connectionsLoading.set(true);
      this.connectionsError.set(null);
      const sub: Subscription = this.http
        .get<{ success: boolean; group: ConnectedGroupMemberDto[] }>(
          `${this.apiBase}/videos/${anchor.id}/connected-group`
        )
        .subscribe({
          next: response => {
            const records = response?.group ?? [];
            this.connections.set(records.map(toConnectedItem));
            this.loadedForVideoId.set(anchor.id);
            this.connectionsLoading.set(false);
          },
          error: error => {
            console.error('[ConnectionsStore] Connections fetch failed:', error);
            // Do NOT set loadedForVideoId — a failure must not be cached as
            // "this item has no connections".
            this.connections.set([]);
            this.connectionsError.set('Failed to load connections.');
            this.connectionsLoading.set(false);
          },
        });
      onCleanup(() => sub.unsubscribe());
      // allowSignalWrites: the loading flag is set synchronously in here.
    }, { allowSignalWrites: true });
  }

  /** Retry a failed connections fetch (inspector's "Retry" affordance). */
  retryLoad(): void {
    this.connectionsError.set(null);
    this.refreshCounter.update(n => n + 1);
  }

  /**
   * Connect every currently selected item into one group. Generalizes the old
   * pair-connect to any N ≥ 2 (also the N = 2 case).
   */
  connectSelection(): void {
    this.connectAll(this.inspectorStore.selectedItems());
  }

  /**
   * Link N ≥ 2 items into a single group using a star topology (every item
   * after the first is linked to the first). Because connections are
   * transitive the topology is irrelevant — a star yields the same group as a
   * clique. Partial failures are surfaced honestly: `mutationError` is set and
   * the group is refetched so the UI shows exactly which links landed.
   */
  connectAll(items: VideoItem[]): void {
    if (items.length < 2 || this.mutating()) return;
    const [anchor, ...rest] = items;
    this.mutating.set(true);
    this.mutationError.set(null);

    const requests = rest.map(item =>
      this.http.post<{ success: boolean }>(`${this.apiBase}/videos/${anchor.id}/link`, {
        relatedMediaId: item.id,
        relationshipType: 'connected',
      })
    );

    forkJoin(requests).subscribe({
      next: responses => {
        if (responses.some(r => !r?.success)) {
          this.mutationError.set('Some items could not be connected.');
        }
        this.afterMutation();
      },
      error: () => {
        this.mutationError.set('Failed to connect the selected items.');
        this.afterMutation();
      },
    });
  }

  /**
   * Remove an item from the anchor's group entirely (delete all of its edges).
   * The group is refetched afterward, so a failed delete honestly shows the
   * item still present rather than faking its removal.
   */
  disconnect(videoId: string): void {
    if (this.mutating()) return;
    this.mutating.set(true);
    this.mutationError.set(null);
    this.http
      .delete<{ success: boolean }>(`${this.apiBase}/videos/${videoId}/connections`)
      .subscribe({
        next: response => {
          if (!response?.success) {
            this.mutationError.set('Failed to remove the connection.');
          }
          this.afterMutation();
        },
        error: () => {
          this.mutationError.set('Failed to remove the connection.');
          this.afterMutation();
        },
      });
  }

  private afterMutation(): void {
    this.mutating.set(false);
    this.loadedForVideoId.set(null); // invalidate cache
    this.refreshCounter.update(n => n + 1);
  }
}
