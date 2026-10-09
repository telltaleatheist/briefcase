import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { highlightPieces, LibrarySearchResponse, SearchHit } from '../../models/library-search.model';
import { VideoItem } from '../../models/video.model';

/** A request to open a video, at a moment or from the start. */
export interface OpenAt {
  video: VideoItem;
  seconds: number;
}

/** Moments shown per video before "Show all". */
const MOMENTS_SHOWN = 3;

/**
 * The library search's results (GET /api/database/search): each matching
 * video, title matches first, with the moments where the query is said.
 * Clicking a moment opens the video there; clicking the title opens it from
 * the start. The search itself and the filters live in the library page.
 */
@Component({
  selector: 'app-search-results',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './search-results.component.html',
  styleUrls: ['./search-results.component.scss'],
})
export class SearchResultsComponent {
  readonly response = input<LibrarySearchResponse | null>(null);
  /** The hits to show: the response's, after the library filters. */
  readonly hits = input<SearchHit[]>([]);
  readonly loading = input(false);
  readonly error = input<string | null>(null);

  readonly open = output<OpenAt>();

  /** Videos whose moments are all shown. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  readonly summary = computed(() => {
    const res = this.response();
    if (!res) return '';
    const hits = this.hits();
    const titled = hits.filter((h) => h.titleHighlights.length > 0).length;
    const moments = hits.reduce((n, h) => n + h.momentCount, 0);
    const parts = [`${hits.length} ${hits.length === 1 ? 'video' : 'videos'}`];
    if (titled) parts.push(`${titled} by title`);
    parts.push(`${res.capped ? 'at least ' : ''}${moments} ${moments === 1 ? 'moment' : 'moments'}`);
    return parts.join(' · ');
  });

  /** "somalies also matched somalis, somali" lines, for widened words. */
  readonly spellingNotes = computed(() => {
    const spellings = this.response()?.spellings ?? {};
    return Object.entries(spellings)
      .filter(([, words]) => words.length > 1)
      .map(([word, words]) => `“${word}” also matched ${words.filter((w) => w !== word).join(', ')}`);
  });

  readonly pieces = highlightPieces;

  momentsShown(hit: SearchHit) {
    return this.expanded().has(hit.video.id) ? hit.moments : hit.moments.slice(0, MOMENTS_SHOWN);
  }

  hiddenCount(hit: SearchHit): number {
    return this.expanded().has(hit.video.id) ? 0 : Math.max(0, hit.moments.length - MOMENTS_SHOWN);
  }

  showAll(hit: SearchHit): void {
    this.expanded.update((set) => new Set([...set, hit.video.id]));
  }

  formatTime(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}
