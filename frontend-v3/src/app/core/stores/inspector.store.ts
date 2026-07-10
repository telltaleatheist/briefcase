import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { VideoItem } from '../../models/video.model';
import { LibraryService } from '../../services/library.service';
import { classifyItemKind } from '../item-kind';
import { NavigationStore } from './navigation.store';
import { SelectionStore } from './selection.store';

/** Truncated transcript snippet shown in the inspector. */
export interface TranscriptPreview {
  videoId: string;
  text: string;
}

const PREVIEW_MAX_CHARS = 420;

/**
 * Resolve selected cascade ids to library items.
 *
 * Cascade selection ids may be composite ("<week>|<videoId>") and may include
 * queue/staging rows that have no library item — mirrors the resolution rules
 * of library-page's getSelectedLibraryVideos().
 */
function resolveSelection(ids: Set<string>, items: VideoItem[]): VideoItem[] {
  const resolved: VideoItem[] = [];
  const seen = new Set<string>();
  for (const itemId of ids) {
    const parts = itemId.split('|');
    const videoId = parts.length > 1 ? parts[1] : itemId;
    if (videoId.startsWith('queue-') || videoId.startsWith('staging-') || seen.has(videoId)) {
      continue;
    }
    const item = items.find(v => v.id === videoId) ?? items.find(v => v.id === itemId);
    if (item) {
      seen.add(videoId);
      resolved.push(item);
    }
  }
  return resolved;
}

/** Strip SRT cue numbers/timestamps down to plain text. */
function srtToPlainText(srt: string): string {
  return srt
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && !/^\d+$/.test(line.trim()) && !line.includes('-->'))
    .join(' ');
}

/**
 * State for the shell's right inspector panel.
 *
 * The persistent workspace (library-page) feeds the flattened library items;
 * everything else derives from SelectionStore. The transcript preview is
 * fetched lazily — only while the inspector is open and exactly one
 * transcribed item is selected.
 */
@Injectable({ providedIn: 'root' })
export class InspectorStore {
  private libraryService = inject(LibraryService);
  private selectionStore = inject(SelectionStore);
  private navigationStore = inject(NavigationStore);

  /** Flattened library items, kept fresh by the workspace host. */
  private libraryItems = signal<VideoItem[]>([]);

  /** Selected library items (queue/staging rows excluded). */
  selectedItems = computed(() =>
    resolveSelection(this.selectionStore.selectedIds(), this.libraryItems())
  );

  singleItem = computed<VideoItem | null>(() => {
    const items = this.selectedItems();
    return items.length === 1 ? items[0] : null;
  });

  singleItemKind = computed(() => {
    const item = this.singleItem();
    return item ? classifyItemKind(item) : null;
  });

  /** Multi-select summary counts. */
  withoutTranscript = computed(
    () =>
      this.selectedItems().filter(v => classifyItemKind(v) === 'video' && !v.hasTranscript).length
  );
  notAnalyzed = computed(() => this.selectedItems().filter(v => !v.hasAnalysis).length);
  anyVideos = computed(() => this.selectedItems().some(v => classifyItemKind(v) === 'video'));

  /** Lazy transcript preview for the single selected item. */
  transcriptPreview = signal<TranscriptPreview | null>(null);
  transcriptLoading = signal(false);

  constructor() {
    effect(onCleanup => {
      const open = this.navigationStore.inspectorOpen();
      const item = this.singleItem();

      if (!open || !item || !item.hasTranscript) {
        this.transcriptLoading.set(false);
        return;
      }
      if (this.transcriptPreview()?.videoId === item.id) {
        return; // already loaded for this item
      }

      this.transcriptLoading.set(true);
      const sub: Subscription = this.libraryService.getVideoTranscript(item.id).subscribe({
        next: response => {
          const transcript = response?.data;
          const plain: string =
            transcript?.plain_text ||
            transcript?.txt_content ||
            (transcript?.srt_format || transcript?.srt_content
              ? srtToPlainText(transcript.srt_format || transcript.srt_content)
              : '');
          const text =
            plain.length > PREVIEW_MAX_CHARS ? `${plain.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…` : plain;
          this.transcriptPreview.set(text ? { videoId: item.id, text } : null);
          this.transcriptLoading.set(false);
        },
        error: () => {
          this.transcriptPreview.set(null);
          this.transcriptLoading.set(false);
        },
      });
      onCleanup(() => sub.unsubscribe());
      // allowSignalWrites: the loading flag is set synchronously in here.
    }, { allowSignalWrites: true });
  }

  /** Called by the workspace host whenever its week data changes. */
  setLibraryItems(items: VideoItem[]): void {
    this.libraryItems.set(items);
  }

  /** Called by the workspace host on destroy. */
  reset(): void {
    this.libraryItems.set([]);
    this.transcriptPreview.set(null);
    this.transcriptLoading.set(false);
  }
}
