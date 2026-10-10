import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of } from 'rxjs';
import type { TranscriptionSegment } from '../../../models/video-info.model';
import { LibraryService } from '../../../services/library.service';
import { AnalysisPanelComponent } from './analysis-panel.component';

const seg = (i: number, text: string): TranscriptionSegment => ({ id: `s${i}`, startTime: i * 5, endTime: i * 5 + 5, text });
const TRANSCRIPT = [
  seg(0, 'Welcome back to the show, everybody.'),
  seg(1, 'Black lives matter are demon spawns from hell, she said.'),
  seg(2, 'Then the pastor talked about spiritual warfare.'),
  seg(3, 'Our sponsor today is a water filter company.'),
];

describe('AnalysisPanelComponent: transcript search', () => {
  let fixture: ComponentFixture<AnalysisPanelComponent>;
  let panel: AnalysisPanelComponent;
  let meaning: jasmine.Spy;

  beforeEach(() => {
    localStorage.removeItem('briefcase-transcript-expanded-search');
    meaning = jasmine.createSpy('transcriptMeaning').and.returnValue(of({ hits: [{ first: 3, last: 3, start: 15, score: 0.7 }], chunks: 4, embeddedNow: false }));
    TestBed.configureTestingModule({ imports: [AnalysisPanelComponent], providers: [{ provide: LibraryService, useValue: { transcriptMeaning: meaning } }] });
    fixture = TestBed.createComponent(AnalysisPanelComponent);
    panel = fixture.componentInstance;
    panel.videoId = 'v1';
    panel.transcript = TRANSCRIPT;
    panel.ngOnChanges({ transcript: { currentValue: TRANSCRIPT, previousValue: [], firstChange: true, isFirstChange: () => true } });
  });

  it('lists every line with no search, and the closest line to a misremembered quote with its words marked', fakeAsync(() => {
    expect(panel.transcriptRows().length).toBe(4);
    panel.onTranscriptSearchChange('black lives matter is demon spawns from satan');
    tick(250);
    const rows = panel.transcriptRows();
    expect(rows.map(r => r.segment.id)).toEqual(['s1']);
    expect(rows[0].pieces.filter(p => p.hit).map(p => p.text)).toEqual(['Black', 'lives', 'matter', 'demon', 'spawns', 'from']);
    expect(meaning).not.toHaveBeenCalled();
  }));

  it('expanded search adds the lines that mean what was typed, after the word matches and without repeating them', fakeAsync(() => {
    panel.setExpandedSearch(true);
    panel.onTranscriptSearchChange('pastor');
    tick(250);
    expect(meaning).toHaveBeenCalledWith('v1', 'pastor');
    expect(panel.transcriptRows().map(r => r.segment.id)).toEqual(['s2']);
    expect(panel.relatedRows().map(r => r.segment.id)).toEqual(['s3']);

    panel.clearTranscriptSearch();
    expect(panel.relatedRows()).toEqual([]);
  }));
});
