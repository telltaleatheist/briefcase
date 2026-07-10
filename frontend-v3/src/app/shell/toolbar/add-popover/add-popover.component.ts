import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AddDownloadsPayload } from '../../../core/stores/workspace-actions.service';
import { AddDefaultsService, DownloadQuality, QUALITY_OPTIONS } from '../../../core/stores/add-defaults.service';
import { VideoJobSettings } from '../../../models/video-processing.model';

/**
 * One-shot Add popover content (lives in a CDK connected overlay anchored to
 * the toolbar's "+ Add" button).
 *
 * Paste URLs → pick quality → tick pipeline steps → Add to Queue. Choices are
 * remembered through AddDefaultsService (shared with Settings → Downloads) so
 * the daily loop is paste → Enter. The legacy full config dialog stays
 * reachable via "Advanced…".
 */
@Component({
  selector: 'app-add-popover',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './add-popover.component.html',
  styleUrls: ['./add-popover.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AddPopoverComponent {
  /** Whether an AI provider is configured (Analyze gate). */
  aiReady = input(false);

  submitAdd = output<AddDownloadsPayload>();
  importFiles = output<void>();
  openAdvanced = output<void>();
  setupAi = output<void>();
  dismissed = output<void>();

  private addDefaults = inject(AddDefaultsService);

  urlText = signal('');
  quality = signal<DownloadQuality>(this.addDefaults.defaults().quality);
  trim = signal(this.addDefaults.defaults().trim);
  transcribe = signal(this.addDefaults.defaults().transcribe);
  analyze = signal(this.addDefaults.defaults().analyze);

  readonly qualityOptions = QUALITY_OPTIONS;

  urls = computed(() =>
    this.urlText()
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^https?:\/\/\S+$/i.test(line))
  );
  canSubmit = computed(() => this.urls().length > 0);

  onSubmit(): void {
    const urls = this.urls();
    if (urls.length === 0) return;

    this.addDefaults.update({
      quality: this.quality(),
      trim: this.trim(),
      transcribe: this.transcribe(),
      analyze: this.analyze(),
    });

    const settings: VideoJobSettings = {
      fixAspectRatio: false,
      normalizeAudio: false,
      transcribe: this.transcribe(),
      aiAnalysis: this.aiReady() && this.analyze(),
      downloadQuality: this.quality()
    };

    this.submitAdd.emit({
      items: urls.map(url => ({ url, name: '', settings: { ...settings } })),
      trimAfter: this.trim()
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
