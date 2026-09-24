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
import { CascadeComponent } from './cascade.component';

class FakeReadiness {
  readonly view = signal<CrucibleReadinessView | null>(readinessView());
  readonly ready = computed(() => this.view()?.state === 'ready');
  readonly doorLabel = computed(() => readinessDoorLabel(this.view()?.action ?? null));
  readonly reason = computed(() => (this.ready() ? '' : this.view()?.reason ?? ''));
  openDoor = jasmine.createSpy('openDoor').and.resolveTo();
}

describe('CascadeComponent Run Analysis gate', () => {
  let fixture: ComponentFixture<CascadeComponent>;
  let readiness: FakeReadiness;

  const video = { id: 'v1', name: 'Clip.mp4', mediaType: 'video/mp4' } as VideoItem;

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
    readiness = TestBed.inject(CrucibleReadinessService) as unknown as FakeReadiness;
    fixture.componentInstance.contextMenuVideo.set(video);
  });

  const item = (label: string) =>
    fixture.componentInstance.contextMenuActions().find(a => a.label.startsWith(label));

  it('disables Run Analysis with the reason and offers the door when Crucible is not ready', () => {
    const run = item('Run Analysis')!;
    expect(run.disabled).toBeTrue();
    expect(run.title).toBe('The Crucible on this computer is not running.');
    expect(item('Start Crucible')?.action).toBe('crucibleDoor');

    fixture.componentInstance.onContextMenuAction('crucibleDoor');
    expect(readiness.openDoor).toHaveBeenCalled();
  });

  it('enables Run Analysis, with no door, when Crucible is ready', () => {
    readiness.view.set(readinessView({ state: 'ready', action: null, server: 'mac' }));
    expect(item('Run Analysis')!.disabled).toBeFalsy();
    expect(item('Start Crucible')).toBeUndefined();
  });
});
