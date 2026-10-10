import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { TimelineChapter } from '../../../models/video-editor.model';
import { LibraryService } from '../../../services/library.service';
import { AnalysisPanelComponent } from './analysis-panel.component';

/** Scout's Chapters tab on a stories outline: stories as an accordion, opened by the chevron only. */
const ch = (id: string, sequence: number, start: number, end: number, parentId: string | null = null): TimelineChapter => ({
  id, videoId: 'v', sequence, startTime: start, endTime: end, title: `Title ${id}`, source: 'ai', parentId,
});

const OUTLINE: TimelineChapter[] = [
  { ...ch('S1', 1, 0, 600), description: 'Why the timeline lines up with 9/11.' },
  ch('S1c1', 2, 0, 300, 'S1'),
  ch('S1c2', 3, 300, 600, 'S1'),
  ch('S2', 4, 600, 3725),
  ch('S2c1', 5, 600, 3725, 'S2'),
];

describe('AnalysisPanelComponent: stories accordion', () => {
  let fixture: ComponentFixture<AnalysisPanelComponent>;
  let panel: AnalysisPanelComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [AnalysisPanelComponent], providers: [{ provide: LibraryService, useValue: {} }] });
    fixture = TestBed.createComponent(AnalysisPanelComponent);
    panel = fixture.componentInstance;
    panel.chapters = OUTLINE;
    panel.ngOnChanges({ chapters: { currentValue: OUTLINE, previousValue: [], firstChange: true, isFirstChange: () => true } });
    panel.setActiveTab('chapters');
    fixture.detectChanges();
  });

  const rows = () => Array.from(fixture.nativeElement.querySelectorAll('.chapter-item')) as HTMLElement[];
  const titles = () => rows().map((r) => r.querySelector('.chapter-title')!.textContent!.trim());

  it('shows the stories collapsed, each with its HH:MM:SS start-end and chapter count, and a chevron', () => {
    expect(titles()).toEqual(['Title S1', 'Title S2']);
    const metas = rows().map((r) => r.querySelector('.chapter-meta')!.textContent!.trim());
    expect(metas).toEqual(['00:00:00 – 00:10:00 · 2 chapters', '00:10:00 – 01:02:05 · 1 chapter']);
    expect(rows().every((r) => r.classList.contains('story'))).toBeTrue();
    expect(rows().every((r) => r.querySelector('.chapter-chevron'))).toBeTrue();
    // The Chapters tab counts chapters, not stories.
    expect(fixture.nativeElement.querySelectorAll('.tab-count')[0].textContent.trim()).toBe('3');
  });

  it('clicking a story row seeks and never opens it; the chevron opens and closes it', () => {
    const seeks: TimelineChapter[] = [];
    panel.chapterClick.subscribe((c) => seeks.push(c));
    (rows()[0].querySelector('.chapter-content') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(seeks.map((c) => c.id)).toEqual(['S1']);
    expect(titles()).toEqual(['Title S1', 'Title S2']);

    (rows()[0].querySelector('.chapter-chevron') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(titles()).toEqual(['Title S1', 'Title S1c1', 'Title S1c2', 'Title S2']);
    expect(rows().map((r) => r.querySelector('.chapter-number')!.textContent!.trim())).toEqual(['1', '1.1', '1.2', '2']);
    expect(rows()[0].querySelector('.chapter-chevron')!.getAttribute('aria-expanded')).toBe('true');

    (rows()[0].querySelector('.chapter-chevron') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(titles()).toEqual(['Title S1', 'Title S2']);
  });

  it('the analyze button is on a story and on each of its chapters', () => {
    const asked: string[] = [];
    panel.chapterAnalyze.subscribe((c) => asked.push(c.id));
    (rows()[1].querySelector('.chapter-chevron') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(rows().map((r) => !!r.querySelector('.chapter-analyze'))).toEqual([true, true, true]);
    (rows()[1].querySelector('.chapter-analyze') as HTMLButtonElement).click();
    (rows()[2].querySelector('.chapter-analyze') as HTMLButtonElement).click();
    expect(asked).toEqual(['S2', 'S2c1']);
    expect(panel.chapterAnalyzeTitle(OUTLINE[3])).toContain('Analyze this story');
    expect(panel.chapterAnalyzeTitle(OUTLINE[4])).toContain('Analyze this chapter');
  });

  it('following the playhead never opens a story', () => {
    panel.currentTime = 400;
    panel.ngOnChanges({ currentTime: { currentValue: 400, previousValue: 0, firstChange: false, isFirstChange: () => false } });
    fixture.detectChanges();
    expect(titles()).toEqual(['Title S1', 'Title S2']);
    expect(panel.currentChapterId).toBe('S1');
    // Opened by the user, the chapter at the playhead is the current row.
    (rows()[0].querySelector('.chapter-chevron') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(panel.currentChapterId).toBe('S1c2');
  });

  it('an open story shows its summary above its chapters; a closed one does not', () => {
    const summary = () => rows()[0].querySelector('.story-summary')?.textContent?.trim();
    expect(summary()).toBeUndefined();
    (rows()[0].querySelector('.chapter-chevron') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(summary()).toBe('Why the timeline lines up with 9/11.');
  });

  it('an outline of one story shows its chapters alone, numbered 1..n, with no story row', () => {
    const lone = [ch('S', 1, 0, 600), ch('C1', 2, 0, 300, 'S'), ch('C2', 3, 300, 600, 'S')];
    panel.chapters = lone;
    panel.ngOnChanges({ chapters: { currentValue: lone, previousValue: OUTLINE, firstChange: false, isFirstChange: () => false } });
    fixture.detectChanges();
    expect(titles()).toEqual(['Title C1', 'Title C2']);
    expect(rows().map((r) => r.querySelector('.chapter-number')!.textContent!.trim())).toEqual(['1', '2']);
    expect(rows().some((r) => r.classList.contains('story') || r.querySelector('.chapter-chevron'))).toBeFalse();
  });
});
