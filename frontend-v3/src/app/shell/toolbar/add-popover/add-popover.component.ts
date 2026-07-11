import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AddDownloadsPayload } from '../../../core/stores/workspace-actions.service';
import { AddDefaultsService, DownloadQuality, QUALITY_OPTIONS } from '../../../core/stores/add-defaults.service';
import { UiTimecodeInputComponent } from '../../../ui/timecode-input/ui-timecode-input.component';
import { ProcessConfigComponent } from '../../inspector/process-config/process-config.component';

/** Zero-pad to two digits. */
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Format seconds as HH:MM:SS with leading zeros (ported from the trim-opener
 * modal's hours/minutes/seconds split). Used for the collapsed-card summary.
 */
function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * One-shot Add popover content (lives in a CDK connected overlay anchored to
 * the toolbar's "+ Add" button).
 *
 * Paste URLs → pick quality → optionally set trim amounts → configure the FULL
 * pipeline (the same process-config step cards the inspector uses, embedded in
 * compose mode) → Download. Quality + trim are remembered through
 * AddDefaultsService (shared with Settings → Downloads); the pipeline steps are
 * remembered through PipelinePresetsService (the SAME sticky composition the
 * inspector edits — one mental model, last-used everywhere). The legacy full
 * config dialog stays reachable via "Advanced…".
 */
@Component({
  selector: 'app-add-popover',
  standalone: true,
  imports: [FormsModule, UiTimecodeInputComponent, ProcessConfigComponent],
  templateUrl: './add-popover.component.html',
  styleUrls: ['./add-popover.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AddPopoverComponent {
  /** Whether an AI provider is configured (gates the embedded AI Analyze step). */
  aiReady = input(false);
  /** AI readiness UNKNOWN — the availability probe failed (retry, don't lie). */
  aiCheckFailed = input(false);

  submitAdd = output<AddDownloadsPayload>();
  importFiles = output<void>();
  openAdvanced = output<void>();
  setupAi = output<void>();
  /** Re-run the AI availability probe (embedded config's "check failed — retry"). */
  retryAi = output<void>();
  /** No whisper models installed — take the user to Settings → Components. */
  openComponents = output<void>();
  dismissed = output<void>();

  private addDefaults = inject(AddDefaultsService);

  /** The embedded pipeline composer — read at submit for the composed steps. */
  private config = viewChild(ProcessConfigComponent);

  urlText = signal('');
  quality = signal<DownloadQuality>(this.addDefaults.defaults().quality);
  trim = signal(this.addDefaults.defaults().trim);
  /** Accordion state; never auto-expands on check (house card-toggle pattern). */
  trimExpanded = signal(false);
  /** Trim amounts in seconds (0 = no trim on that side). The OTP timecode input
   *  owns parsing; these hold the parsed result it emits. */
  trimStartSeconds = signal(this.addDefaults.defaults().trimStartSeconds);
  trimEndSeconds = signal(this.addDefaults.defaults().trimEndSeconds);
  /** Out-of-range pair flagged by the timecode input (host disables submit). */
  trimStartInvalid = signal(false);
  trimEndInvalid = signal(false);

  readonly qualityOptions = QUALITY_OPTIONS;

  urls = computed(() =>
    this.urlText()
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^https?:\/\/\S+$/i.test(line))
  );

  // Trim is valid unless the card is on and the timecode input flagged a pair.
  private trimValid = computed(() =>
    !this.trim() || (!this.trimStartInvalid() && !this.trimEndInvalid())
  );

  /** Quiet summary for the collapsed card so remembered values stay visible. */
  trimSummary = computed(() => {
    const start = this.trimStartSeconds();
    const end = this.trimEndSeconds();
    const parts: string[] = [];
    if (start > 0) parts.push(`start +${formatHms(start)}`);
    if (end > 0) parts.push(`end −${formatHms(end)}`);
    return parts.length ? parts.join(' · ') : 'No trim set — tap to edit';
  });

  canSubmit = computed(() => {
    if (this.urls().length === 0 || !this.trimValid()) return false;
    // Never stage a doomed job: honor the embedded config's own gate (e.g.
    // transcribe enabled but no installed whisper model verified).
    const config = this.config();
    return !config || !config.transcribeBlocked();
  });
  submitLabel = computed(() => {
    const count = this.urls().length;
    return count > 1 ? `Download ${count}` : 'Download';
  });

  onTrimToggle(on: boolean): void {
    this.trim.set(on);
    // Never auto-expand on check; collapsing on uncheck keeps state tidy.
    if (!on) this.trimExpanded.set(false);
  }

  onTrimExpandToggle(): void {
    const next = !this.trimExpanded();
    // Reopening re-seeds the timecode inputs from the stored (always-valid)
    // seconds, so any stale invalid flag from before a collapse is cleared.
    if (next) {
      this.trimStartInvalid.set(false);
      this.trimEndInvalid.set(false);
    }
    this.trimExpanded.set(next);
  }

  onSubmit(): void {
    const urls = this.urls();
    if (urls.length === 0 || !this.trimValid()) return;
    const config = this.config();
    if (config?.transcribeBlocked()) return;

    const trimOn = this.trim();
    const startSeconds = trimOn ? this.trimStartSeconds() : 0;
    const endSeconds = trimOn ? this.trimEndSeconds() : 0;

    this.addDefaults.update({
      quality: this.quality(),
      trim: trimOn,
      trimStartSeconds: startSeconds,
      trimEndSeconds: endSeconds,
    });

    // The embedded config's steps are already sticky-persisted (shared with the
    // inspector); read the composed set for THIS add and carry it whole so every
    // option survives (translate, granularity, stripBlackBars, customInstructions).
    const steps = config?.composedSteps() ?? [];
    const quality = this.quality();

    this.submitAdd.emit({
      items: urls.map(url => ({
        url,
        name: '',
        quality,
        // Clone per item so jobs never share a config object reference.
        steps: steps.map(step => ({ type: step.type, config: { ...step.config } })),
        // Zero on either side = no trim there; card ON with no values does nothing.
        trimStartSeconds: startSeconds > 0 ? startSeconds : undefined,
        trimEndSeconds: endSeconds > 0 ? endSeconds : undefined,
      })),
    });
    this.urlText.set('');
  }

  onTextareaEnter(event: Event): void {
    // Plain Enter submits when there's a single valid URL (paste → Enter);
    // Shift+Enter inserts a newline for multi-URL entry.
    const keyboard = event as KeyboardEvent;
    if (!keyboard.shiftKey && this.canSubmit()) {
      event.preventDefault();
      this.onSubmit();
    }
  }

}
