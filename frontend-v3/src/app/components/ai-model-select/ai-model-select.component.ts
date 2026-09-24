import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AiModelOptionsService } from '../../services/ai-model-options.service';
import { CrucibleReadinessService } from '../../services/crucible-readiness.service';

/**
 * THE AI MODEL PICKER. Every analysis-model dropdown in Briefcase is this one
 * (the Process inspector, the Add dialog, a queued item's options, Settings ›
 * AI Analysis, the setup wizard), so they all list the same thing: what the
 * connected Crucible offers, grouped as it presents it (AiModelOptionsService).
 *
 *   - Bound with ngModel, never [value]: a native select bound by value
 *     shows its first option until the options render (model-picker-select-binding).
 *   - The list is only what the server offers. A stored value that is an
 *     option under another spelling (`ollama:qwen3.8:27b`) is replaced by that
 *     option; one the server offers nothing for (Claude with no Claude
 *     upstream, a model it dropped) is replaced by the server's own pick for
 *     analysis (or the empty choice, where there is one). Either way the
 *     replacement is emitted, so what the host queues is what is shown.
 *   - While Crucible is not ready, it shows the readiness reason and the one
 *     door that repairs it (Start / Install / Connect), not a stale list.
 *
 * `valueChange` emits on a pick, and when a stored value is replaced as above,
 * with the option's value (the Crucible spelling), or '' for the empty choice.
 */
@Component({
  selector: 'app-ai-model-select',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!readiness.ready()) {
      <select class="ams-select" [attr.id]="selectId()" disabled [attr.aria-label]="ariaLabel()">
        <option>AI needs Crucible</option>
      </select>
      <p class="ams-line ams-warn">
        {{ readiness.reason() }}
        @if (readiness.doorLabel(); as door) {
          <button type="button" class="ams-door" (click)="openDoor()">{{ door }}</button>
        }
      </p>
    } @else {
      <select
        class="ams-select"
        [attr.id]="selectId()"
        [attr.aria-label]="ariaLabel()"
        [ngModel]="shown()"
        [disabled]="disabled() || !store.loaded()"
        (ngModelChange)="pick($event)">
        @if (!store.loaded()) {
          <option [value]="shown()">{{ store.error() ? "Couldn't list models" : 'Loading models…' }}</option>
        } @else {
          @if (emptyLabel() !== null) {
            <option value="">{{ emptyLabel() }}</option>
          } @else if (!shown()) {
            <option value="" disabled>{{ store.options().length ? 'Select a model…' : 'No models available' }}</option>
          }
          @for (group of store.groups(); track group.kind) {
            <optgroup [label]="group.label">
              @for (option of group.options; track option.value) {
                <option [value]="option.value">{{ option.label }}</option>
              }
              @if (group.error) {
                <option disabled>Couldn't list: {{ group.error }}</option>
              } @else if (group.options.length === 0) {
                <option disabled>Lists no models</option>
              }
            </optgroup>
          }
        }
      </select>
      @if (line(); as said) {
        <p class="ams-line" [class.ams-warn]="said.warn">
          {{ said.text }}
          @if (said.retry) {
            <button type="button" class="ams-door" (click)="store.refresh()">Retry</button>
          }
        </p>
      }
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .ams-select {
      width: 100%;
      min-width: 0;
      padding: 6px 8px;
      border: 1px solid var(--border-color);
      border-radius: 7px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 12.5px;
    }
    .ams-select:focus { outline: none; border-color: var(--primary-orange); }
    .ams-select:disabled { opacity: 0.65; }
    .ams-line { margin: 4px 0 0; font-size: 11.5px; line-height: 1.4; color: var(--text-secondary); white-space: normal; }
    .ams-warn { color: var(--warning, var(--text-secondary)); }
    .ams-door {
      margin-left: 4px; padding: 0; border: 0; background: none; cursor: pointer;
      color: var(--primary-orange); font: inherit; text-decoration: underline;
    }
  `],
})
export class AiModelSelectComponent {
  readonly store = inject(AiModelOptionsService);
  readonly readiness = inject(CrucibleReadinessService);

  /** The stored value (`provider:model`), '' for none. */
  readonly value = input<string>('');
  /** When set, an empty choice with this label is offered (e.g. "Same as the analysis model"). */
  readonly emptyLabel = input<string | null>(null);
  readonly disabled = input(false);
  readonly selectId = input<string | null>(null);
  readonly ariaLabel = input<string>('AI model');

  readonly valueChange = output<string>();

  constructor() {
    effect(() => {
      const value = this.value();
      untracked(() => this.store.use([value]));
    });
    // A stored value the list doesn't hold as spelled: hand the host the option it is, or the replacement.
    effect(() => {
      const replacement = this.replacement();
      if (replacement !== null) untracked(() => this.valueChange.emit(replacement));
    });
  }

  readonly resolution = computed(() => this.store.resolution(this.value()));

  /**
   * What the stored value becomes, once the server has answered for it; null
   * when it stays as it is (or it is not known yet). An option under another
   * spelling becomes that option. One the server can't run becomes the
   * empty choice where the picker has one, else the server's pick for
   * analysis, else its first option; with no option at all it stays, and the
   * line says the list is empty.
   */
  readonly replacement = computed<string | null>(() => {
    const value = (this.value() ?? '').trim();
    if (!value || !this.readiness.ready() || !this.store.loaded() || this.store.error()) return null;
    const resolution = this.resolution();
    if (resolution === null) return null;
    if (resolution.option !== null) return resolution.option === value ? null : resolution.option;
    if (this.emptyLabel() !== null) return '';
    const options = this.store.options();
    const pick = this.store.view()?.analysisDefault;
    if (pick && options.some((o) => o.value === pick)) return pick;
    return options[0]?.value ?? null;
  });

  /** What the select shows: the replacement while it is on its way to the host, else the stored value when it is an option, else the placeholder. */
  readonly shown = computed(() => {
    const value = this.replacement() ?? (this.value() ?? '').trim();
    return this.store.options().some((o) => o.value === value) ? value : '';
  });

  readonly emptyReason = computed(() => {
    const view = this.store.view();
    if (view?.unavailable) return view.unavailable;
    return `${view?.server ?? 'The Crucible server'} offers no model that can analyse. Download one on it, or connect Claude, OpenAI or Ollama via Crucible in Settings › AI Analysis.`;
  });

  /** The one line under the picker: a listing failure, or why the list is empty. */
  readonly line = computed<{ text: string; warn: boolean; retry: boolean } | null>(() => {
    const error = this.store.error();
    if (error) return { text: error, warn: true, retry: true };
    if (this.store.loaded() && this.store.options().length === 0) return { text: this.emptyReason(), warn: true, retry: false };
    return null;
  });

  pick(value: string): void {
    this.valueChange.emit(value ?? '');
  }

  openDoor(): void {
    void this.readiness.openDoor();
  }
}
