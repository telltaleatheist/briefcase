import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import type { CrucibleReadinessView } from '@crucible-wire/readiness-wire';
import { ErrorSurface } from '../../../core/error-surface.service';
import { CrucibleService } from '../../../services/crucible.service';
import { CrucibleReadinessService, readinessDoorLabel } from '../../../services/crucible-readiness.service';
import { readinessView } from '../../../services/crucible-readiness.testing';
import { LibraryService } from '../../../services/library.service';
import { ProcessConfigComponent } from './process-config.component';

class FakeReadiness {
  readonly view = signal<CrucibleReadinessView | null>(readinessView());
  readonly ready = computed(() => this.view()?.state === 'ready');
  readonly action = computed(() => this.view()?.action ?? null);
  readonly doorLabel = computed(() => readinessDoorLabel(this.action()));
  readonly reason = computed(() => (this.ready() ? '' : this.view()?.reason ?? ''));
  requireReady = jasmine.createSpy('requireReady').and.callFake(() => this.ready());
  openDoor = jasmine.createSpy('openDoor').and.resolveTo();
}

const STORAGE_KEY = 'briefcase-pipeline-presets';

describe('ProcessConfigComponent Crucible gate', () => {
  let fixture: ComponentFixture<ProcessConfigComponent>;
  let readiness: FakeReadiness;

  beforeEach(() => {
    // Last-used composition: normalize + transcribe + analyze.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      presets: [],
      lastSteps: [
        { type: 'normalize-audio', config: { targetLevel: -16 } },
        { type: 'transcribe', config: { model: 'base', language: 'en', translate: true } },
        { type: 'ai-analyze', config: { customInstructions: '', aiModel: 'claude:sonnet' } },
      ],
    }));
    TestBed.configureTestingModule({
      imports: [ProcessConfigComponent],
      providers: [
        { provide: CrucibleReadinessService, useClass: FakeReadiness },
        { provide: CrucibleService, useValue: { modelOptions: () => of([{ value: 'claude:sonnet', label: 'Sonnet', provider: 'claude' }]) } },
        {
          provide: LibraryService,
          useValue: {
            getCustomInstructionsHistory: () => of({ success: true, history: [] }),
            getDefaultAI: () => of({ success: true, defaultAI: null }),
          },
        },
        { provide: ErrorSurface, useValue: { surfaceError: () => {} } },
      ],
    });
    fixture = TestBed.createComponent(ProcessConfigComponent);
    fixture.componentRef.setInput('selectionCount', 2);
    readiness = TestBed.inject(CrucibleReadinessService) as unknown as FakeReadiness;
    fixture.detectChanges();
  });

  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  const cards = () => Array.from(fixture.nativeElement.querySelectorAll('.step-card')) as HTMLElement[];
  const card = (label: string) => cards().find(c => c.textContent!.includes(label))!;

  it('shows transcribe and analyze disabled and unchecked with the reason and the door when Crucible is not ready', () => {
    for (const label of ['Transcribe', 'AI Analyze']) {
      const el = card(label);
      const box = el.querySelector('input.step-box') as HTMLInputElement;
      expect(el.classList).toContain('disabled');
      expect(box.disabled).toBeTrue();
      expect(box.checked).toBeFalse();
      expect(el.textContent).toContain('The Crucible on this computer is not running.');
      expect(el.querySelector('.link-affordance')!.textContent!.trim()).toBe('Start Crucible');
    }
    // Non-AI steps are untouched, and the composed pipeline goes without the AI steps.
    expect((card('Normalize').querySelector('input.step-box') as HTMLInputElement).checked).toBeTrue();
    expect(fixture.componentInstance.composedSteps().map(s => s.type)).toEqual(['normalize-audio']);
  });

  it('the door on a locked step opens the readiness door', () => {
    (card('Transcribe').querySelector('.link-affordance') as HTMLButtonElement).click();
    expect(readiness.openDoor).toHaveBeenCalled();
  });

  it('brings the remembered AI steps back when Crucible is ready, with no stale transcribe options', () => {
    readiness.view.set(readinessView({ state: 'ready', action: null, server: 'mac' }));
    fixture.detectChanges();
    const transcribe = card('Transcribe');
    expect(transcribe.classList).not.toContain('disabled');
    expect((transcribe.querySelector('input.step-box') as HTMLInputElement).checked).toBeTrue();
    const steps = fixture.componentInstance.composedSteps();
    expect(steps.map(s => s.type)).toEqual(['normalize-audio', 'transcribe', 'ai-analyze']);
    expect(steps.find(s => s.type === 'transcribe')!.config).toEqual({});
  });
});
