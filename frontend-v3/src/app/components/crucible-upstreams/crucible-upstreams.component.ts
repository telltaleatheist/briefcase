import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type { CrucibleSettingsView, UpstreamName } from '@crucible-wire/settings-wire';
import { CrucibleService, type CrucibleRefusal } from '../../services/crucible.service';
import { ElectronService } from '../../services/electron.service';
import { UiButtonComponent } from '../../ui';

interface UpstreamRow {
  name: UpstreamName;
  label: string;
  field: 'key' | 'url';
  placeholder: string;
  getLink: string;
  getLabel: string;
}

const ROWS: UpstreamRow[] = [
  { name: 'anthropic', label: 'Claude via Crucible', field: 'key', placeholder: 'sk-ant-…', getLink: 'https://console.anthropic.com/settings/keys', getLabel: 'Get a key' },
  { name: 'openai', label: 'OpenAI via Crucible', field: 'key', placeholder: 'sk-…', getLink: 'https://platform.openai.com/api-keys', getLabel: 'Get a key' },
  { name: 'ollama', label: 'Ollama via Crucible', field: 'url', placeholder: 'http://127.0.0.1:11434', getLink: 'https://ollama.com/download', getLabel: 'Get Ollama' },
];

/**
 * ONE CRUCIBLE SERVER'S UPSTREAMS: the Claude key, the OpenAI key and the
 * Ollama URL, edited on THAT server (keys live on whichever Crucible serves
 * the call). Each row is paste, Test, Save. Only the server's `keyHint` is
 * ever shown; a pasted key crosses once, on its way in, and the field is
 * cleared after saving. Used by Settings › AI and the setup wizard.
 */
@Component({
  selector: 'app-crucible-upstreams',
  standalone: true,
  imports: [FormsModule, UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loadError(); as error) {
      <p class="up-error">{{ error }}</p>
    }
    @for (row of offeredRows(); track row.name) {
      <div class="up-row">
        <div class="up-head">
          <span class="up-name">{{ row.label }}</span>
          @if (stateOf(row.name); as state) {
            @if (state.configured) {
              <span class="up-pill ok">{{ row.field === 'key' ? 'Key ' + (state.hint ?? 'set') : 'At ' + (state.hint ?? 'set') }}</span>
            } @else {
              <span class="up-pill off">Not set</span>
            }
          }
          <button type="button" class="up-link" (click)="open(row.getLink)">{{ row.getLabel }}</button>
        </div>
        <div class="up-input">
          <input
            [type]="row.field === 'key' ? 'password' : 'text'"
            class="up-field"
            autocomplete="off"
            [placeholder]="stateOf(row.name)?.configured ? (row.field === 'key' ? 'Paste a new key to replace it' : 'A new URL') : row.placeholder"
            [ngModel]="draft()[row.name] ?? ''"
            (ngModelChange)="setDraft(row.name, $event)" />
          <ui-button size="sm" [disabled]="busy() !== null || (!draft()[row.name] && !stateOf(row.name)?.configured)" (pressed)="test(row)">Test</ui-button>
          <ui-button size="sm" variant="primary" [disabled]="busy() !== null || !draft()[row.name]" (pressed)="save(row)">Save</ui-button>
          @if (stateOf(row.name)?.configured) {
            <ui-button size="sm" variant="ghost" [disabled]="busy() !== null" (pressed)="clear(row)">Remove</ui-button>
          }
        </div>
        @if (result()[row.name]; as line) {
          <p class="up-result" [class.bad]="!line.ok">{{ line.text }}</p>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .up-row { border: 1px solid var(--border-color); border-radius: 10px; background: var(--bg-card); padding: 10px 12px; margin-bottom: 8px; }
    .up-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .up-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .up-pill { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    .up-pill.ok { color: var(--success); background: rgba(34, 197, 94, 0.12); }
    .up-pill.off { color: var(--text-tertiary); background: var(--bg-input); }
    .up-link { margin-left: auto; background: none; border: 0; padding: 0; font: inherit; font-size: 12px; color: var(--primary-orange); cursor: pointer; }
    .up-input { display: flex; gap: 6px; align-items: center; }
    .up-field { flex: 1; min-width: 0; border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-primary); border-radius: 7px; padding: 6px 9px; font-size: 13px; font-family: inherit; outline: none; }
    .up-field:focus { border-color: var(--primary-orange); }
    .up-result { margin: 6px 0 0; font-size: 12px; color: var(--success); }
    .up-result.bad, .up-error { color: var(--warning); }
    .up-error { font-size: 12.5px; margin: 0 0 8px; }
  `],
})
export class CrucibleUpstreamsComponent {
  private readonly crucible = inject(CrucibleService);
  private readonly electron = inject(ElectronService);

  /** The registered server whose settings these are. */
  readonly server = input.required<string>();
  /** Emitted after a save or a removal, so the caller re-reads its model list. */
  readonly changed = output<CrucibleSettingsView>();

  readonly rows = ROWS;
  readonly settings = signal<CrucibleSettingsView | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly draft = signal<Partial<Record<UpstreamName, string>>>({});
  readonly result = signal<Partial<Record<UpstreamName, { ok: boolean; text: string }>>>({});
  readonly busy = signal<UpstreamName | null>(null);

  constructor() {
    effect(() => {
      const name = this.server();
      this.settings.set(null);
      this.draft.set({});
      this.result.set({});
      void this.load(name);
    }, { allowSignalWrites: true });
  }

  /** The rows this server offers: a card it sends as null is an upstream it does not have, and is left out. */
  offeredRows(): readonly UpstreamRow[] {
    const doc = this.settings();
    return doc === null ? this.rows : this.rows.filter((row) => doc.upstreams[row.name] !== null);
  }

  stateOf(name: UpstreamName): { configured: boolean; hint: string | null } | null {
    const doc = this.settings();
    if (doc === null) return null;
    if (name === 'ollama') {
      const card = doc.upstreams.ollama;
      return card === null ? null : { configured: card.configured, hint: card.url };
    }
    const card = doc.upstreams[name];
    return card === null ? null : { configured: card.configured, hint: card.keyHint };
  }

  setDraft(name: UpstreamName, value: string): void {
    this.draft.update((d) => ({ ...d, [name]: value }));
  }

  private say(name: UpstreamName, ok: boolean, text: string): void {
    this.result.update((r) => ({ ...r, [name]: { ok, text } }));
  }

  private async load(name: string): Promise<void> {
    try {
      this.settings.set(await firstValueFrom(this.crucible.settings(name)));
      this.loadError.set(null);
    } catch (error) {
      this.loadError.set((error as CrucibleRefusal).message ?? `Couldn't read "${name}"'s settings.`);
    }
  }

  async test(row: UpstreamRow): Promise<void> {
    const value = (this.draft()[row.name] ?? '').trim();
    this.busy.set(row.name);
    try {
      const answer = await firstValueFrom(this.crucible.testUpstream(this.server(), row.name, value ? { [row.field]: value } : {}));
      if (answer.ok) this.say(row.name, true, `Works: ${answer.models.length} model${answer.models.length === 1 ? '' : 's'} available.`);
      else this.say(row.name, false, answer.message);
    } catch (error) {
      this.say(row.name, false, (error as CrucibleRefusal).message ?? 'The test did not run.');
    } finally {
      this.busy.set(null);
    }
  }

  async save(row: UpstreamRow): Promise<void> {
    const value = (this.draft()[row.name] ?? '').trim();
    if (!value) return;
    this.busy.set(row.name);
    try {
      const view = await firstValueFrom(this.crucible.putSettings(this.server(), { upstreams: { [row.name]: { [row.field]: value } } }));
      this.settings.set(view);
      this.setDraft(row.name, '');
      this.say(row.name, true, `Saved on ${this.server()}.`);
      await firstValueFrom(this.crucible.refreshAiModels(this.server())).catch(() => undefined);
      this.changed.emit(view);
    } catch (error) {
      this.say(row.name, false, (error as CrucibleRefusal).message ?? 'It did not save.');
    } finally {
      this.busy.set(null);
    }
  }

  async clear(row: UpstreamRow): Promise<void> {
    if (!confirm(`Remove ${row.label} from ${this.server()}? Anything routed to it there stops working.`)) return;
    this.busy.set(row.name);
    try {
      const view = await firstValueFrom(this.crucible.putSettings(this.server(), { upstreams: { [row.name]: null } }));
      this.settings.set(view);
      this.say(row.name, true, `Removed from ${this.server()}.`);
      await firstValueFrom(this.crucible.refreshAiModels(this.server())).catch(() => undefined);
      this.changed.emit(view);
    } catch (error) {
      this.say(row.name, false, (error as CrucibleRefusal).message ?? 'It was not removed.');
    } finally {
      this.busy.set(null);
    }
  }

  open(url: string): void {
    if (this.electron.isElectron) this.electron.openExternal(url);
    else window.open(url, '_blank');
  }
}
