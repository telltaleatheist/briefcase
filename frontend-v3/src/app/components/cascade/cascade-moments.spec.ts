import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { CrucibleReadinessView } from '@crucible-wire/readiness-wire';
import { VideoItem } from '../../models/video.model';
import { CrucibleReadinessService, readinessDoorLabel } from '../../services/crucible-readiness.service';
import { readinessView } from '../../services/crucible-readiness.testing';
import { ElectronService } from '../../services/electron.service';
import { LibraryService } from '../../services/library.service';
import { NotificationService } from '../../services/notification.service';
import { TabsService } from '../../services/tabs.service';
import { CascadeComponent, CascadeMoments } from './cascade.component';

class FakeReadiness {
  readonly view = signal<CrucibleReadinessView | null>(readinessView());
  readonly ready = computed(() => this.view()?.state === 'ready');
  readonly doorLabel = computed(() => readinessDoorLabel(this.view()?.action ?? null));
  readonly reason = computed(() => (this.ready() ? '' : this.view()?.reason ?? ''));
  openDoor = jasmine.createSpy('openDoor').and.resolveTo();
}

const video = (id: string) => ({ id, name: `${id}.mp4`, mediaType: 'video/mp4' } as VideoItem);
const moment = (start: number) => ({ start, end: start + 5, text: `said at ${start}`, highlights: [[0, 4]] as Array<[number, number]>, score: 1 });

/**
 * Search results are ordinary cascade rows (selectable, right-clickable, ready
 * for collections), with each video's moments as rows under it.
 */
describe('CascadeComponent search moments', () => {
  let fixture: ComponentFixture<CascadeComponent>;
  let cascade: CascadeComponent;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CascadeComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        { provide: CrucibleReadinessService, useClass: FakeReadiness },
        { provide: ElectronService, useValue: {} },
        { provide: LibraryService, useValue: { currentLibrary: signal(null) } },
        { provide: NotificationService, useValue: {} },
        { provide: TabsService, useValue: { recentTabs: signal([]), loadTabs: () => of([]) } },
      ],
    });
    TestBed.overrideComponent(CascadeComponent, { set: { template: '' } });
    fixture = TestBed.createComponent(CascadeComponent);
    cascade = fixture.componentInstance;
    cascade.weeks = [{ weekLabel: 'Search results', videos: [video('a'), video('b'), video('c')] }];
  });

  const setMoments = (entries: Array<[string, CascadeMoments]>) => fixture.componentRef.setInput('moments', new Map(entries));
  const rows = () => cascade.virtualItems().map((r) => (r.type === 'header' ? 'header' : `${r.type}:${r.video.id}${r.type === 'moment' ? '@' + r.moment.start : ''}`));

  it('puts each video\'s first three moments under it, then a "show more" row', () => {
    setMoments([
      ['a', { moments: [10, 20, 30, 40, 50].map(moment), momentCount: 30 }],
      ['c', { moments: [moment(7)], momentCount: 1 }],
    ]);
    expect(rows()).toEqual([
      'header',
      'video:a', 'moment:a@10', 'moment:a@20', 'moment:a@30', 'more-moments:a',
      'video:b',
      'video:c', 'moment:c@7',
    ]);
    const more = cascade.virtualItems().find((r) => r.type === 'more-moments')!;
    expect(more.type === 'more-moments' && [more.hidden, more.unlisted]).toEqual([2, 25]);
  });

  it('"show more" lists every moment of that video', () => {
    setMoments([['a', { moments: [10, 20, 30, 40].map(moment), momentCount: 4 }]]);
    cascade.showAllMoments(video('a'), new Event('click'));
    expect(rows().filter((r) => r.startsWith('moment:a')).length).toBe(4);
    expect(rows()).not.toContain('more-moments:a');
  });

  it('a moment opens its video at its time', () => {
    setMoments([['b', { moments: [moment(65)], momentCount: 1 }]]);
    const opened: Array<[string, number]> = [];
    cascade.momentOpened.subscribe((o) => opened.push([o.video.id, o.seconds]));
    cascade.openMoment(video('b'), 65, new Event('click'));
    expect(opened).toEqual([['b', 65]]);
    expect(cascade.formatMomentTime(1725.4)).toBe('00:28:45');
  });

  it('moment rows break a selection group: two selected videos with moments between are two groups', () => {
    setMoments([['a', { moments: [moment(10)], momentCount: 1 }]]);
    cascade.selectedVideos.set(new Set(['Search results|a', 'Search results|b']));
    const index = (id: string) => cascade.virtualItems().findIndex((r) => r.type === 'video' && r.video.id === id);
    expect(cascade.isSelectionEdgeBottom(index('a'))).toBeTrue();
    expect(cascade.isSelectionEdgeTop(index('b'))).toBeTrue();
  });

  it('without moments the rows are the plain library rows', () => {
    expect(rows()).toEqual(['header', 'video:a', 'video:b', 'video:c']);
  });
});
