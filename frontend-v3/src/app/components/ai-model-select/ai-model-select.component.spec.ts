import { Component, computed, signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { of } from 'rxjs';
import type { AiModelsView, AiResolvedValue } from '@crucible-wire/ai-wire';
import type { CrucibleReadinessView } from '@crucible-wire/readiness-wire';
import { CrucibleService } from '../../services/crucible.service';
import { CrucibleReadinessService, readinessDoorLabel } from '../../services/crucible-readiness.service';
import { readinessView } from '../../services/crucible-readiness.testing';
import { modelsView } from '../../services/ai-model-options.testing';
import { WebsocketService } from '../../services/websocket.service';
import { AiModelSelectComponent } from './ai-model-select.component';

class FakeReadiness {
  readonly view = signal<CrucibleReadinessView | null>(readinessView({ state: 'ready', action: null, reason: '', server: 'owens-mac-studio' }));
  readonly ready = computed(() => this.view()?.state === 'ready');
  readonly action = computed(() => this.view()?.action ?? null);
  readonly doorLabel = computed(() => readinessDoorLabel(this.action()));
  readonly reason = computed(() => (this.ready() ? '' : this.view()?.reason ?? ''));
  openDoor = jasmine.createSpy('openDoor').and.resolveTo();
}

@Component({
  standalone: true,
  imports: [AiModelSelectComponent],
  template: `<app-ai-model-select [value]="value()" [emptyLabel]="emptyLabel()" [offerClaudeCliWithoutCrucible]="offerCli()" (valueChange)="picked.push($event)" />`,
})
class HostComponent {
  readonly value = signal('');
  readonly offerCli = signal(false);
  readonly emptyLabel = signal<string | null>(null);
  readonly picked: string[] = [];
}

/** TEMPORARY (claude-cli): the local Claude Code CLI's group, as the backend lists it last. */
const CLI_GROUP: AiModelsView['groups'][number] = {
  kind: 'claude-cli', label: 'Claude Code (this computer)', error: null, options: [
    { value: 'claude-cli:claude-sonnet-5-5', label: 'Sonnet 5.5 (Claude Code)', group: 'claude-cli', sizeB: null, resident: null, serverChoice: false },
    { value: 'claude-cli:claude-haiku-5-5', label: 'Haiku 5.5 (Claude Code)', group: 'claude-cli', sizeB: null, resident: null, serverChoice: false },
  ],
};

const resolved = (value: string, option: string | null, extra: Partial<AiResolvedValue> = {}): AiResolvedValue =>
  ({ value, option, note: null, unavailable: null, ...extra });

describe('AiModelSelectComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let readiness: FakeReadiness;
  let answer: AiModelsView;
  let aiModels: jasmine.Spy;

  beforeEach(() => {
    answer = modelsView();
    aiModels = jasmine.createSpy('aiModels').and.callFake(() => of(answer));
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: CrucibleReadinessService, useClass: FakeReadiness },
        { provide: CrucibleService, useValue: { aiModels } },
        { provide: WebsocketService, useValue: { onCrucibleServersChanged: () => () => {}, onCrucibleCoordination: () => () => {} } },
      ],
    });
    fixture = TestBed.createComponent(HostComponent);
    readiness = TestBed.inject(CrucibleReadinessService) as unknown as FakeReadiness;
  });

  const el = () => fixture.nativeElement as HTMLElement;
  const select = () => el().querySelector('select') as HTMLSelectElement;
  const lines = () => Array.from(el().querySelectorAll('.ams-line')).map((p) => p.textContent!.trim());

  function render(value: string): void {
    fixture.componentInstance.value.set(value);
    fixture.detectChanges();
    flushMicrotasks();
    fixture.detectChanges();
    tick();
    fixture.detectChanges();
  }

  it('lists what the server offers, grouped as it presents them, and shows the stored choice (ngModel, not the first option)', fakeAsync(() => {
    answer = modelsView({
      groups: [
        ...modelsView().groups,
        { kind: 'anthropic', label: 'Claude via Crucible', error: null, options: [
          { value: 'claude:claude-sonnet-5', label: 'claude-sonnet-5', group: 'anthropic', sizeB: null, resident: null, serverChoice: false },
        ] },
      ],
    });
    render('local:qwen3.5-9b');
    const groups = Array.from(select().querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual(['On this Crucible', 'Claude via Crucible']);
    expect(Array.from(select().options).map((o) => o.textContent!.trim())).toEqual([
      'Biggest that fits, up to 27B (qwen3.8-27b-8bit)',
      'qwen3.5-9b',
      'claude-sonnet-5',
    ]);
    expect(select().value).toBe('local:qwen3.5-9b');
    expect(el().textContent).not.toMatch(/Ollama/);
  }));

  it('a legacy Ollama choice becomes the server model it runs as, handed to the host, with no extra line', fakeAsync(() => {
    answer = modelsView({
      resolved: [resolved('ollama:qwen3.5:9b', 'local:qwen3.5-9b', { note: 'Saved as qwen3.5:9b (Ollama). It runs as qwen3.5-9b.' })],
    });
    render('ollama:qwen3.5:9b');
    expect(aiModels).toHaveBeenCalledWith(undefined, ['ollama:qwen3.5:9b']);
    expect(select().value).toBe('local:qwen3.5-9b');
    expect(fixture.componentInstance.picked).toEqual(['local:qwen3.5-9b']);
    expect(lines()).toEqual([]);
  }));

  it('a saved 27B quantisation becomes the 27B ceiling, handed to the host', fakeAsync(() => {
    answer = modelsView({
      resolved: [resolved('local:qwen3.8-27b-8bit', 'local:max-27b', { note: 'Saved as local:qwen3.8-27b-8bit. It now means the biggest model up to 27B that fits.' })],
    });
    render('local:qwen3.8-27b-8bit');
    expect(select().value).toBe('local:max-27b');
    expect(fixture.componentInstance.picked).toEqual(['local:max-27b']);
  }));

  it('a saved choice the server offers nothing for is not listed: it becomes the server\'s pick for analysis, with no message', fakeAsync(() => {
    answer = modelsView({
      resolved: [resolved('claude:claude-sonnet-5', null, { unavailable: 'Claude is not set up on owens-mac-studio.' })],
    });
    render('claude:claude-sonnet-5');
    expect(select().value).toBe('local:max-27b');
    expect(Array.from(select().options).map((o) => o.textContent!.trim())).not.toContain('claude:claude-sonnet-5 (unavailable)');
    expect(fixture.componentInstance.picked).toEqual(['local:max-27b']);
    expect(lines()).toEqual([]);
  }));

  it('where the picker has an empty choice, an unavailable saved choice becomes that', fakeAsync(() => {
    fixture.componentInstance.emptyLabel.set('Same as the analysis model');
    answer = modelsView({ resolved: [resolved('claude:claude-haiku-5', null, { unavailable: 'Claude is not set up.' })] });
    render('claude:claude-haiku-5');
    expect(fixture.componentInstance.picked).toEqual(['']);
    expect(select().value).toBe('');
  }));

  it('an empty choice is offered when the host names one, and a pick emits the option value', fakeAsync(() => {
    fixture.componentInstance.emptyLabel.set('Same as the analysis model');
    render('');
    expect(select().options[0].textContent!.trim()).toBe('Same as the analysis model');
    expect(select().value).toBe('');
    select().value = 'local:max-27b';
    select().dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.picked).toEqual(['local:max-27b']);
  }));

  it('while Crucible is not ready: the reason and the door, not a stale list; and the list is read again when it is', fakeAsync(() => {
    render('local:qwen3.5-9b');
    const calls = aiModels.calls.count();
    readiness.view.set(readinessView());
    fixture.detectChanges();
    flushMicrotasks();
    fixture.detectChanges();
    expect(select().disabled).toBeTrue();
    expect(select().querySelectorAll('optgroup').length).toBe(0);
    expect(el().textContent).toContain('The Crucible on this computer is not running.');
    const door = el().querySelector('.ams-door') as HTMLButtonElement;
    expect(door.textContent!.trim()).toBe('Start Crucible');
    door.click();
    expect(readiness.openDoor).toHaveBeenCalled();

    readiness.view.set(readinessView({ state: 'ready', action: null, reason: '', server: 'owens-pc' }));
    fixture.detectChanges();
    flushMicrotasks();
    fixture.detectChanges();
    expect(aiModels.calls.count()).toBeGreaterThan(calls);
  }));

  it('a server with nothing to offer says why', fakeAsync(() => {
    answer = modelsView({ groups: [] });
    render('');
    expect(lines()[0]).toContain('owens-mac-studio offers no model that can analyse');
  }));

  // TEMPORARY (claude-cli): the local Claude Code CLI, the user's exception to Crucible-only AI.
  it('lists the Claude Code models in their own group, and a pick of one is kept', fakeAsync(() => {
    answer = modelsView({ groups: [...modelsView().groups, CLI_GROUP] });
    render('claude-cli:claude-haiku-5-5');
    expect(Array.from(select().querySelectorAll('optgroup')).map((g) => g.label)).toEqual(['On this Crucible', 'Claude Code (this computer)']);
    expect(select().value).toBe('claude-cli:claude-haiku-5-5');
    expect(fixture.componentInstance.picked).toEqual([]);
  }));

  it('a Claude Code model is never the replacement, even when the server offers nothing else', fakeAsync(() => {
    answer = modelsView({ groups: [CLI_GROUP], analysisDefault: null, resolved: [resolved('local:gone', null, { unavailable: 'gone' })] });
    render('local:gone');
    expect(fixture.componentInstance.picked).toEqual([]);
    expect(lines()[0]).toContain('offers no model that can analyse');
  }));

  it('while Crucible is not ready, only a host that asks keeps the Claude Code models pickable, and nothing is picked for it', fakeAsync(() => {
    answer = modelsView({ server: null, groups: [CLI_GROUP], analysisDefault: null, unavailable: 'Crucible is not running.' });
    readiness.view.set(readinessView());
    render('local:max-27b');
    expect(select().disabled).toBeTrue();

    fixture.componentInstance.offerCli.set(true);
    render('local:max-27b');
    expect(select().disabled).toBeFalse();
    expect(Array.from(select().querySelectorAll('optgroup')).map((g) => g.label)).toEqual(['Claude Code (this computer)']);
    expect(select().value).toBe('');
    expect(el().textContent).toContain('The Crucible on this computer is not running.');
    expect(fixture.componentInstance.picked).toEqual([]);
    select().value = 'claude-cli:claude-sonnet-5-5';
    select().dispatchEvent(new Event('change'));
    expect(fixture.componentInstance.picked).toEqual(['claude-cli:claude-sonnet-5-5']);
  }));
});
