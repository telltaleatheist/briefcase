import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AddDownloadsPayload } from '../../../core/stores/workspace-actions.service';
import { VideoJobSettings } from '../../../models/video-processing.model';

type DownloadQuality = NonNullable<VideoJobSettings['downloadQuality']>;

interface AddDefaults {
  quality: DownloadQuality;
  trim: boolean;
  transcribe: boolean;
  analyze: boolean;
}

const STORAGE_KEY = 'briefcase-add-defaults';
const FALLBACK_DEFAULTS: AddDefaults = { quality: 'best', trim: false, transcribe: true, analyze: false };

/**
 * One-shot Add popover content (lives in a CDK connected overlay anchored to
 * the toolbar's "+ Add" button).
 *
 * Paste URLs → pick quality → tick pipeline steps → Add to Queue. Choices are
 * remembered (localStorage) so the daily loop is paste → Enter. The legacy
 * full config dialog stays reachable via "Advanced…".
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

  urlText = signal('');
  quality = signal<DownloadQuality>(FALLBACK_DEFAULTS.quality);
  trim = signal(FALLBACK_DEFAULTS.trim);
  transcribe = signal(FALLBACK_DEFAULTS.transcribe);
  analyze = signal(FALLBACK_DEFAULTS.analyze);

  readonly qualityOptions: { value: DownloadQuality; label: string }[] = [
    { value: 'best', label: 'Best available' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p — faster' },
    { value: '480', label: '480p — fastest' },
  ];

  urls = computed(() =>
    this.urlText()
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^https?:\/\/\S+$/i.test(line))
  );
  canSubmit = computed(() => this.urls().length > 0);

  constructor() {
    this.restoreDefaults();
  }

  onSubmit(): void {
    const urls = this.urls();
    if (urls.length === 0) return;

    this.persistDefaults();

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

  private restoreDefaults(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<AddDefaults>;
      if (saved.quality && this.qualityOptions.some(o => o.value === saved.quality)) {
        this.quality.set(saved.quality);
      }
      if (typeof saved.trim === 'boolean') this.trim.set(saved.trim);
      if (typeof saved.transcribe === 'boolean') this.transcribe.set(saved.transcribe);
      if (typeof saved.analyze === 'boolean') this.analyze.set(saved.analyze);
    } catch (error) {
      console.warn('[AddPopover] Failed to restore add defaults', error);
    }
  }

  private persistDefaults(): void {
    try {
      const defaults: AddDefaults = {
        quality: this.quality(),
        trim: this.trim(),
        transcribe: this.transcribe(),
        analyze: this.analyze()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
    } catch (error) {
      console.warn('[AddPopover] Failed to persist add defaults', error);
    }
  }
}
