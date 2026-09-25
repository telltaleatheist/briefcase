import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { CrucibleReadinessView } from '@crucible-wire/readiness-wire';
import { CrucibleReadinessService, readinessDoorLabel } from '../../services/crucible-readiness.service';
import { readinessView } from '../../services/crucible-readiness.testing';
import { CruciblePromptComponent } from './crucible-prompt.component';

/** The readiness service's surface the prompt reads, driven by one view signal. */
class FakeReadiness {
  readonly view = signal<CrucibleReadinessView | null>(null);
  readonly asked = signal(false);
  readonly ready = computed(() => this.view()?.state === 'ready');
  readonly starting = computed(() => this.view()?.state === 'starting');
  readonly doorLabel = computed(() => readinessDoorLabel(this.view()?.action ?? null));
  readonly reason = computed(() => this.view()?.reason ?? '');
  readonly refusalMessage = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly prompt = computed(() => {
    const v = this.view();
    if (!v || v.state === 'ready' || v.declined) return false;
    return v.aiWaiting > 0 || this.asked();
  });
  openDoor = jasmine.createSpy('openDoor').and.resolveTo();
  decline = jasmine.createSpy('decline').and.resolveTo();
}

describe('CruciblePromptComponent', () => {
  let fixture: ComponentFixture<CruciblePromptComponent>;
  let readiness: FakeReadiness;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CruciblePromptComponent],
      providers: [{ provide: CrucibleReadinessService, useClass: FakeReadiness }],
    });
    fixture = TestBed.createComponent(CruciblePromptComponent);
    readiness = TestBed.inject(CrucibleReadinessService) as unknown as FakeReadiness;
  });

  const card = () => fixture.nativeElement.querySelector('.crucible-prompt') as HTMLElement | null;
  const render = (view: CrucibleReadinessView) => {
    readiness.view.set(view);
    fixture.detectChanges();
  };

  it('shows the reason and the one door while AI tasks wait', () => {
    render(readinessView({ aiWaiting: 2 }));
    expect(card()).not.toBeNull();
    expect(card()!.textContent).toContain('The Crucible on this computer is not running.');
    expect(card()!.textContent).toContain('2 AI tasks waiting');
    const buttons = Array.from(card()!.querySelectorAll('button')).map(b => b.textContent!.trim());
    expect(buttons).toEqual(['Start Crucible', 'Not now']);

    (card()!.querySelector('button.primary') as HTMLButtonElement).click();
    expect(readiness.openDoor).toHaveBeenCalled();
    (card()!.querySelector('button.ghost') as HTMLButtonElement).click();
    expect(readiness.decline).toHaveBeenCalled();
  });

  it('stays hidden once declined, when ready, and when nothing needs AI', () => {
    render(readinessView({ aiWaiting: 2, declined: true }));
    expect(card()).toBeNull();
    render(readinessView({ state: 'ready', action: null, server: 'mac', aiWaiting: 0 }));
    expect(card()).toBeNull();
    render(readinessView({ aiWaiting: 0 }));
    expect(card()).toBeNull();
  });

  it('shows the start progress instead of buttons while starting', () => {
    readiness.asked.set(true);
    render(readinessView({ state: 'starting', action: null, progress: 'Loading qwen3-asr-1.7b' }));
    expect(card()!.textContent).toContain('Starting Crucible');
    expect(card()!.textContent).toContain('Loading qwen3-asr-1.7b');
    expect(card()!.querySelector('.spinner')).not.toBeNull();
    expect(card()!.querySelectorAll('button').length).toBe(0);
  });
});
