import { ComponentFixture, TestBed } from '@angular/core/testing';

import { highlightPieces, LibrarySearchResponse, SearchHit } from '../../models/library-search.model';
import { VideoItem } from '../../models/video.model';
import { startOfRange } from '../../services/library-filter.service';
import { OpenAt, SearchResultsComponent } from './search-results.component';

const video = (id: string): VideoItem => ({ id, name: `${id}.mp4`, duration: '01:36:29' } as VideoItem);

const moment = (start: number, text: string, highlights: Array<[number, number]>) => ({ start, end: start + 5, text, highlights, score: 1 });

function hitsOf(): SearchHit[] {
  return [
    {
      video: video('debate'),
      title: 'Bryce Crawford VS Logan Paul (God Debate)',
      titleHighlights: [[18, 23], [24, 28]],
      moments: [0, 1, 2, 3, 4].map((i) => moment(1725 + i * 60, `I hate Logan Paul, part ${i}.`, [[7, 12], [13, 17]])),
      momentCount: 5,
    },
    { video: video('podcast'), title: 'A podcast', titleHighlights: [], moments: [moment(65, 'Then Logan Paul boxed.', [[5, 10], [11, 15]])], momentCount: 1 },
  ];
}

function responseOf(hits: SearchHit[], extra: Partial<LibrarySearchResponse> = {}): LibrarySearchResponse {
  return { query: 'logan paul', hits, momentCount: 6, capped: false, spellings: {}, indexing: null, ...extra };
}

describe('SearchResultsComponent', () => {
  let fixture: ComponentFixture<SearchResultsComponent>;
  let el: HTMLElement;

  function render(response: LibrarySearchResponse | null, hits: SearchHit[] = response?.hits ?? []) {
    fixture.componentRef.setInput('response', response);
    fixture.componentRef.setInput('hits', hits);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SearchResultsComponent] });
    fixture = TestBed.createComponent(SearchResultsComponent);
    el = fixture.nativeElement;
  });

  it('lists each video with its marked title and its first three moments, timed HH:MM:SS', () => {
    render(responseOf(hitsOf()));
    expect(el.querySelector('.summary')!.textContent).toContain('2 videos · 1 by title · 6 moments');
    const titles = Array.from(el.querySelectorAll('.title')).map((t) => t.textContent);
    expect(titles[0]).toBe('Bryce Crawford VS Logan Paul (God Debate)');
    expect(el.querySelector('.moment .text')!.textContent).toBe('I hate Logan Paul, part 0.');
    expect(Array.from(el.querySelectorAll('.hit')[0].querySelectorAll('.title .match')).map((m) => m.textContent)).toEqual(['Logan', 'Paul']);
    const times = Array.from(el.querySelectorAll('.hit')[0].querySelectorAll('.time')).map((t) => t.textContent);
    expect(times).toEqual(['00:28:45', '00:29:45', '00:30:45']);
    expect(el.querySelector('.show-all')!.textContent).toContain('Show 2 more');
  });

  it('"Show more" lists every moment of that video', () => {
    render(responseOf(hitsOf()));
    (el.querySelector('.show-all') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.hit')[0].querySelectorAll('.moment').length).toBe(5);
    expect(el.querySelector('.show-all')).toBeNull();
  });

  it('a moment opens its video at its time; the title opens it from the start', () => {
    render(responseOf(hitsOf()));
    const opened: OpenAt[] = [];
    fixture.componentInstance.open.subscribe((o) => opened.push(o));
    (el.querySelectorAll('.hit')[1].querySelector('.moment') as HTMLButtonElement).click();
    (el.querySelector('.hit-head') as HTMLButtonElement).click();
    expect(opened.map((o) => [o.video.id, o.seconds])).toEqual([['podcast', 65], ['debate', 0]]);
  });

  it('says when nothing matched, when transcripts are still being indexed, and what a word was widened to', () => {
    render(responseOf([], { query: 'zebra', indexing: { pending: 100, total: 6095 } }));
    expect(el.querySelector('.empty')!.textContent).toContain('Nothing in the titles or transcripts matches “zebra”');
    expect(el.textContent).toContain('Indexing transcripts: 5995 of 6095 done');

    render(responseOf(hitsOf(), { spellings: { somalies: ['somalies', 'somalis', 'somali'] } }));
    expect(el.textContent).toContain('“somalies” also matched somalis, somali');
  });

  it('shows a failed search as an error, not as results', () => {
    fixture.componentRef.setInput('error', 'Search failed: boom');
    render(null);
    expect(el.querySelector('.empty.error')!.textContent).toContain('Search failed: boom');
  });
});

describe('highlightPieces', () => {
  it('cuts text into plain and matched pieces, skipping ranges that overlap or fall outside', () => {
    expect(highlightPieces('I hate Logan Paul.', [[7, 12], [13, 17]])).toEqual([
      { text: 'I hate ', hit: false },
      { text: 'Logan', hit: true },
      { text: ' ', hit: false },
      { text: 'Paul', hit: true },
      { text: '.', hit: false },
    ]);
    expect(highlightPieces('abc', [[1, 2], [1, 3], [2, 9]])).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ]);
  });
});

describe('startOfRange (the Date filter)', () => {
  it('is local midnight today, the Sunday of this week, the 1st of the month, and January 1st', () => {
    const now = new Date(2026, 9, 9, 15, 30); // Friday, Oct 9 2026
    expect(startOfRange('today', now)).toEqual(new Date(2026, 9, 9));
    expect(startOfRange('week', now)).toEqual(new Date(2026, 9, 4));
    expect(startOfRange('month', now)).toEqual(new Date(2026, 9, 1));
    expect(startOfRange('year', now)).toEqual(new Date(2026, 0, 1));
  });
});
