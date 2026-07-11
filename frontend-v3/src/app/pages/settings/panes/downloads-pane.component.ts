import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AddDefaultsService, DownloadQuality, QUALITY_OPTIONS } from '../../../core/stores/add-defaults.service';

/**
 * Settings → Downloads: the default download quality.
 *
 * Pipeline steps are configured per item, not here: the Add popover picks the
 * steps for each add, and the toolbar's Process popover composes pipelines
 * (with savable presets) for anything already in the library. Both remember
 * your last choice on their own.
 */
@Component({
  selector: 'app-downloads-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  template: `
    <h2 class="pane-title">Downloads</h2>
    <p class="pane-lede">
      Which jobs run on a video is chosen per add — in the “＋ Add” popover — and per
      selection via the toolbar's “⚡ Process” pipeline. Both remember your last choice.
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
  `
})
export class DownloadsPaneComponent {
  defaults = inject(AddDefaultsService);
  readonly qualityOptions = QUALITY_OPTIONS;

  setQuality(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as DownloadQuality;
    this.defaults.update({ quality: value });
  }
}
