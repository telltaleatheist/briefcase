import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { VideoItem } from '../../models/video.model';
import { LibraryService } from '../../services/library.service';
import { classifyItemKind } from '../item-kind';
import { SelectionStore } from './selection.store';

/** One transcript cue (timestamp only present when the source had them). */
export interface TranscriptSegment {
  /** Start time as HH:MM:SS (project convention). */
  start: string;
  text: string;
}

/** Full transcript for the selected item, shown in the inspector. */
export interface InspectorTranscript {
  videoId: string;
  /** Flowing plain text (no timestamps). */
  plainText: string;
  /** Timestamped cues — null when the source has no timing data. */
  segments: TranscriptSegment[] | null;
}

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

/** "00:05:32,450" or "00:05:32.450" → "00:05:32" (project HH:MM:SS convention). */
function srtTimeToHms(time: string): string {
  return time.trim().split(/[,.]/)[0].padStart(8, '0');
}

/** Parse SRT cues into timestamped segments. */
function parseSrtSegments(srt: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const block of srt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length === 0) continue;
    const timingIndex = lines.findIndex(l => l.includes('-->'));
    if (timingIndex === -1) continue;
    const start = srtTimeToHms(lines[timingIndex].split('-->')[0]);
    const text = lines.slice(timingIndex + 1).join(' ').trim();
    if (text) {
      segments.push({ start, text });
    }
  }
  return segments;
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

  /** Lazy full transcript for the single selected item. */
  transcript = signal<InspectorTranscript | null>(null);
  transcriptLoading = signal(false);
  /**
   * Set when the transcript fetch FAILED — distinct from "no transcript".
   * An item marked "Transcribed ✓" must never silently show an empty
   * transcript section (fallback-audit high #10).
   */
  transcriptError = signal<string | null>(null);
  /** Bumped by retryTranscript() to re-run the fetch after a failure. */
  private transcriptRetryCounter = signal(0);

  constructor() {
    effect(onCleanup => {
      this.transcriptRetryCounter(); // retry dependency
      const item = this.singleItem();

      if (!item || !item.hasTranscript) {
        this.transcriptLoading.set(false);
        this.transcriptError.set(null);
        return;
      }
      if (this.transcript()?.videoId === item.id) {
        return; // already loaded for this item
      }

      this.transcriptLoading.set(true);
      this.transcriptError.set(null);
      const sub: Subscription = this.libraryService.getVideoTranscript(item.id).subscribe({
        next: response => {
          const data = response?.data;
          const srt: string = data?.srt_format || data?.srt_content || '';
          const segments = srt ? parseSrtSegments(srt) : null;
          const plainText: string =
            data?.plain_text ||
            data?.txt_content ||
            (segments ? segments.map(s => s.text).join(' ') : '');
          this.transcript.set(
            plainText
              ? {
                  videoId: item.id,
                  plainText,
                  segments: segments && segments.length > 0 ? segments : null,
                }
              : null
          );
          this.transcriptLoading.set(false);
        },
        error: error => {
          console.error('[InspectorStore] Transcript fetch failed:', error);
          this.transcript.set(null);
          this.transcriptError.set('Failed to load the transcript.');
          this.transcriptLoading.set(false);
        },
      });
      onCleanup(() => sub.unsubscribe());
      // allowSignalWrites: the loading flag is set synchronously in here.
    }, { allowSignalWrites: true });
  }

  /** Retry a failed transcript fetch (inspector's "Retry" affordance). */
  retryTranscript(): void {
    this.transcriptError.set(null);
    this.transcriptRetryCounter.update(n => n + 1);
  }

  /** Called by the workspace host whenever its week data changes. */
  setLibraryItems(items: VideoItem[]): void {
    this.libraryItems.set(items);
  }

  /** Called by the workspace host on destroy. */
  reset(): void {
    this.libraryItems.set([]);
    this.transcript.set(null);
    this.transcriptLoading.set(false);
    this.transcriptError.set(null);
  }
}
