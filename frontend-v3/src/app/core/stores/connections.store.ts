import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { VideoItem } from '../../models/video.model';
import { getApiBase } from '../runtime-url';
import { ItemKind, classifyItemKind } from '../item-kind';
import { NavigationStore } from './navigation.store';
import { InspectorStore } from './inspector.store';

/** A connection edge as shown in the inspector. */
export interface ConnectedItem {
  relationshipId: string;
  videoId: string;
  title: string;
  kind: ItemKind;
}

interface MediaRelationshipDto {
  id: string;
  primary_media_id: string;
  related_media_id: string;
  relationship_type: string;
  created_at: string;
  filename?: string;
  media_type?: string;
  file_extension?: string;
}

function toConnectedItem(record: MediaRelationshipDto, selfId: string): ConnectedItem {
  const videoId =
    record.primary_media_id === selfId ? record.related_media_id : record.primary_media_id;
  return {
    relationshipId: record.id,
    videoId,
    title: record.filename ?? videoId,
    kind: classifyItemKind({
      id: videoId,
      mediaType: record.media_type,
      fileExtension: record.file_extension,
    } as VideoItem),
  };
}

/**
 * Connections (flat, undirected links between library items) for the
 * inspector. Loaded lazily — only while the inspector is open and one or two
 * items are selected — mirroring InspectorStore's transcript-preview pattern.
 *
 * Backed by the media_relationships endpoints:
 *   GET    /database/videos/:id/related
 *   POST   /database/videos/:id/link
 *   DELETE /database/relationships/:relationshipId
 */
@Injectable({ providedIn: 'root' })
export class ConnectionsStore {
  private http = inject(HttpClient);
  private navigationStore = inject(NavigationStore);
  private inspectorStore = inject(InspectorStore);

  private readonly apiBase = `${getApiBase()}/database`;

  /** Connections of the first selected item (single- and pair-selection). */
  connections = signal<ConnectedItem[]>([]);
  connectionsLoading = signal(false);
  /** Which item the current `connections` belong to (null = none loaded). */
  private loadedForVideoId = signal<string | null>(null);
  /** Bumped after connect/disconnect to force a refetch. */
  private refreshCounter = signal(0);

  /** The selection pair when exactly two items are selected. */
  private selectedPair = computed<[VideoItem, VideoItem] | null>(() => {
    const items = this.inspectorStore.selectedItems();
    return items.length === 2 ? [items[0], items[1]] : null;
  });

  /**
   * When two items are selected: the connection edge between them, if any.
   * `connections` holds item A's edges; look item B up among them.
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
      const open = this.navigationStore.inspectorOpen();
      const items = this.inspectorStore.selectedItems();
      const anchor = items.length === 1 || items.length === 2 ? items[0] : null;

      if (!open || !anchor) {
        this.connectionsLoading.set(false);
        return;
      }
      if (this.loadedForVideoId() === anchor.id) {
        return; // already loaded for this item
      }

      this.connectionsLoading.set(true);
      const sub: Subscription = this.http
        .get<{ success: boolean; relatedMedia: MediaRelationshipDto[] }>(
          `${this.apiBase}/videos/${anchor.id}/related`
        )
        .subscribe({
          next: response => {
            const records = response?.relatedMedia ?? [];
            this.connections.set(records.map(r => toConnectedItem(r, anchor.id)));
            this.loadedForVideoId.set(anchor.id);
            this.connectionsLoading.set(false);
          },
          error: () => {
            this.connections.set([]);
            this.loadedForVideoId.set(anchor.id);
            this.connectionsLoading.set(false);
          },
        });
      onCleanup(() => sub.unsubscribe());
      // allowSignalWrites: the loading flag is set synchronously in here.
    }, { allowSignalWrites: true });
  }

  /** Connect the currently selected pair. */
  connectPair(): void {
    const pair = this.selectedPair();
    if (!pair || this.mutating()) return;
    this.mutating.set(true);
    this.http
      .post<{ success: boolean }>(`${this.apiBase}/videos/${pair[0].id}/link`, {
        relatedMediaId: pair[1].id,
        relationshipType: 'connected',
      })
      .subscribe({
        next: () => this.afterMutation(),
        error: () => this.afterMutation(),
      });
  }

  /** Remove a connection edge by its relationship id. */
  disconnect(relationshipId: string): void {
    if (this.mutating()) return;
    this.mutating.set(true);
    this.http
      .delete<{ success: boolean }>(`${this.apiBase}/relationships/${relationshipId}`)
      .subscribe({
        next: () => this.afterMutation(),
        error: () => this.afterMutation(),
      });
  }

  private afterMutation(): void {
    this.mutating.set(false);
    this.loadedForVideoId.set(null); // invalidate cache
    this.refreshCounter.update(n => n + 1);
  }
}
