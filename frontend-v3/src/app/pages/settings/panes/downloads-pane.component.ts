import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AddDefaultsService, DownloadQuality, QUALITY_OPTIONS } from '../../../core/stores/add-defaults.service';

/**
 * Settings → Downloads: defaults for the toolbar's one-shot Add flow.
 * Reads/writes the same AddDefaultsService the popover uses, so the two
 * surfaces can't drift.
 */
@Component({
  selector: 'app-downloads-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  template: `
    <h2 class="pane-title">Downloads</h2>
    <p class="pane-lede">
      Defaults for the “+ Add” flow. These are also updated automatically each time
      you change them in the Add popover — the popover always remembers your last choice.
    </p>

    <div class="pane-section">
      <p class="section-label">Default quality</p>
      <label class="field-label" for="quality">Video quality for new downloads</label>
      <select
        id="quality"
        class="select"
        [value]="defaults.defaults().quality"
        (change)="setQuality($event)">
        @for (option of qualityOptions; track option.value) {
          <option [value]="option.value">{{ option.label }}</option>
        }
      </select>
      <p class="hint">
        Lower qualities download faster. Imported files are never re-encoded —
        whatever you drag in keeps its original quality.
      </p>
    </div>

    <div class="pane-section">
      <p class="section-label">Default pipeline</p>
      <label class="check-row">
        <input
          type="checkbox"
          [checked]="defaults.defaults().trim"
          (change)="setFlag('trim', $event)" />
        Trim after download
        <span class="check-hint">— opens the trimmer when the download finishes</span>
      </label>
      <label class="check-row">
        <input
          type="checkbox"
          [checked]="defaults.defaults().transcribe"
          (change)="setFlag('transcribe', $event)" />
        Transcribe
      </label>
      <label class="check-row">
        <input
          type="checkbox"
          [checked]="defaults.defaults().analyze"
          (change)="setFlag('analyze', $event)" />
        Analyze with AI
        <span class="check-hint">— requires an AI provider (Settings → AI)</span>
      </label>
    </div>
  `
})
export class DownloadsPaneComponent {
  defaults = inject(AddDefaultsService);
  readonly qualityOptions = QUALITY_OPTIONS;

  setQuality(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as DownloadQuality;
    this.defaults.update({ quality: value });
  }

  setFlag(flag: 'trim' | 'transcribe' | 'analyze', event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.defaults.update({ [flag]: checked });
  }
}
