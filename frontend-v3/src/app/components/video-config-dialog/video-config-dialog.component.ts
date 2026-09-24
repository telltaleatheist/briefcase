import { Component, EventEmitter, Input, Output, OnInit, OnChanges, SimpleChanges, inject, ChangeDetectorRef, effect, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { VideoJobSettings } from '../../models/video-processing.model';
import { AiModelOptionsService } from '../../services/ai-model-options.service';
import { AiModelSelectComponent } from '../ai-model-select/ai-model-select.component';
import { CrucibleReadinessService } from '../../services/crucible-readiness.service';
import { TourService } from '../../services/tour.service';
import { LibraryService } from '../../services/library.service';
import { PipelinePresetsService } from '../../core/stores/pipeline-presets.service';
import { getApiBase } from '../../core/runtime-url';

interface CustomInstructionHistoryItem {
  id: number;
  instruction_text: string;
  used_at: string;
  use_count: number;
}

@Component({
  selector: 'app-video-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, AiModelSelectComponent],
  templateUrl: './video-config-dialog.component.html',
  styleUrls: ['./video-config-dialog.component.scss']
})
export class VideoConfigDialogComponent implements OnInit, OnChanges {
  /** The connected Crucible's analysis-model options (one source for every picker). */
  readonly modelOptions = inject(AiModelOptionsService);
  /** Transcribe and AI analyze need Crucible: while it is not ready they are locked off. */
  readonly readiness = inject(CrucibleReadinessService);
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private tourService = inject(TourService);
  private libraryService = inject(LibraryService);
  private presetsService = inject(PipelinePresetsService);
  private readonly API_BASE = getApiBase();

  @Input() isOpen = false;
  @Output() closeDialog = new EventEmitter<void>();
  @Output() submitConfig = new EventEmitter<{ url: string; name: string; settings: VideoJobSettings }[]>();
  @Output() captureWebpage = new EventEmitter<string[]>();

  captureMode: 'video' | 'webpage' = 'video';

  urlText = '';
  savedAsDefault = false;
  /** Stored choices to seed an empty picker from, in preference order: last used, library default, global default. */
  private readonly seedCandidates = signal<string[]>([]);

  constructor() {
    // Seed an empty picker once the options (and what each candidate is among them) are known.
    effect(() => {
      const candidates = this.seedCandidates();
      const seed = candidates.map((c) => this.modelOptions.optionFor(c)).find((o): o is string => !!o) ?? '';
      untracked(() => {
        if (seed && !this.settings.aiModel) {
          this.settings.aiModel = seed;
          this.cdr.markForCheck();
        }
      });
    });
  }

  // Custom instructions history
  instructionsHistory: CustomInstructionHistoryItem[] = [];
  showInstructionsDropdown = false;

  settings: VideoJobSettings = {
    fixAspectRatio: false,
    normalizeAudio: false,
    audioLevel: -16, // Default to -16 LUFS (standard web/podcast level)
    transcribe: false,
    aiAnalysis: false,
    aiModel: '',
    customInstructions: '',
    outputFormat: 'mp4',
    outputQuality: 'high'
  };

  ngOnInit() {
    void this.loadDefaultModels();
    this.loadInstructionsHistory();
  }

  /** A step that needs Crucible, while it is not ready: shown locked with the reason. */
  get aiLocked(): boolean {
    return !this.readiness.ready();
  }

  toggleAiStep(step: 'transcribe' | 'aiAnalysis'): void {
    if (this.aiLocked) {
      this.readiness.requireReady();
      return;
    }
    this.settings[step] = !this.settings[step];
  }

  openDoor(): void {
    void this.readiness.openDoor();
    if (this.readiness.action() !== 'start') this.close();
  }

  private loadInstructionsHistory() {
    this.libraryService.getCustomInstructionsHistory().subscribe({
      next: (response) => {
        if (response.success) {
          this.instructionsHistory = response.history;
        }
      },
      error: (error) => {
        console.error('Failed to load instructions history:', error);
      }
    });
  }

  toggleInstructionsDropdown() {
    this.showInstructionsDropdown = !this.showInstructionsDropdown;
    if (this.showInstructionsDropdown) {
      this.loadInstructionsHistory();
    }
  }

  selectHistoryItem(item: CustomInstructionHistoryItem) {
    this.settings.customInstructions = item.instruction_text;
    this.showInstructionsDropdown = false;
  }

  truncateInstruction(text: string, maxLength: number = 60): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  // THE DETECTION-SENSITIVITY SLIDER USED TO BE HERE, AND IS GONE ON PURPOSE.
  // See process-config.component.ts for the full note: the analysis now captures
  // everything and stores every verdict, the dial became a display filter in the
  // video editor, and the operator removed the run-side control outright. This
  // dialog no longer sets `analysisGranularity`.

  getAudioLevelLabel(): string {
    const level = this.settings.audioLevel || -16;
    return `${level} LUFS`;
  }

  getAudioLevelDescription(): string {
    const level = this.settings.audioLevel || -16;
    if (level <= -22) return 'Very quiet - suitable for background music or ambient content';
    if (level <= -19) return 'Quiet - similar to traditional broadcast standards (EBU R128)';
    if (level <= -17) return 'Moderate - good for podcasts and general web content';
    if (level <= -15) return 'Standard - typical for YouTube and streaming platforms';
    return 'Loud - maximizes perceived volume, may reduce dynamic range';
  }


  ngOnChanges(changes: SimpleChanges) {
    // Reload models every time the modal opens to get the latest library default
    if (changes['isOpen'] && changes['isOpen'].currentValue === true) {
      void this.loadDefaultModels();

      // Start the video config tour
      setTimeout(() => {
        this.tourService.tryAutoStartTour('video-config', 500);
      }, 300);
    }
  }

  /**
   * The stored choices an empty picker is seeded from, in order: the model the
   * user last chose (a personal preference, tracked across every picker) → the
   * library default → the global default. Each is used only when it is one of
   * the connected Crucible's options (in its Crucible spelling); none is a
   * fallback for another model. The options themselves are the shared ones.
   */
  private async loadDefaultModels(): Promise<void> {
    const candidates: string[] = [this.presetsService.lastChosenAiModel()];
    try {
      const response = await firstValueFrom(this.http.get<{ success: boolean; aiModel: string | null }>(
        `${this.API_BASE}/database/libraries/default-ai-model`,
      ));
      if (response?.aiModel) candidates.push(response.aiModel);
    } catch (error) {
      console.error("Couldn't read the library's default AI model:", error);
    }
    try {
      const response = await firstValueFrom(this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
        `${this.API_BASE}/config/default-ai`,
      ));
      if (response?.defaultAI) candidates.push(`${response.defaultAI.provider}:${response.defaultAI.model}`);
    } catch (error) {
      console.error("Couldn't read the default AI model:", error);
    }
    const stored = candidates.filter(Boolean);
    this.modelOptions.use(stored);
    this.seedCandidates.set(stored);
  }

  /** AI Analyze is on and its model is missing or can't run on the connected server: Add waits for a pick. */
  aiModelBlocked(): boolean {
    if (this.captureMode !== 'video' || !this.settings.aiAnalysis || this.aiLocked) return false;
    return !this.settings.aiModel || this.modelOptions.unavailable(this.settings.aiModel) !== null;
  }

  onAiModelValue(value: string): void {
    this.settings.aiModel = value;
    this.presetsService.rememberAiModel(value);
    this.savedAsDefault = false;
  }

  /**
   * Save the selected AI model as both library-specific and global default
   * This ensures consistency across all dialogs and modals
   */
  async saveAsDefault() {
    if (!this.settings.aiModel || this.modelOptions.unavailable(this.settings.aiModel)) {
      return;
    }
    // Saved in its Crucible spelling.
    this.settings.aiModel = this.modelOptions.canonical(this.settings.aiModel);

    // Saving as default also makes it the remembered last pick, so every picker
    // seeds to it consistently.
    this.presetsService.rememberAiModel(this.settings.aiModel);

    try {
      // Save to library-specific storage
      await this.http.post(
        `${this.API_BASE}/database/libraries/default-ai-model`,
        { aiModel: this.settings.aiModel }
      ).toPromise();
      console.log('Saved default AI model for library:', this.settings.aiModel);

      // Also save to global config storage for consistency
      const [provider, ...modelParts] = this.settings.aiModel.split(':');
      const model = modelParts.join(':');
      await this.http.post(
        `${this.API_BASE}/config/default-ai`,
        { provider, model }
      ).toPromise();
      console.log('Saved default AI model to global config:', this.settings.aiModel);

      // Show success feedback
      this.savedAsDefault = true;
      // Reset after 1 second
      setTimeout(() => {
        this.savedAsDefault = false;
      }, 1000);
    } catch (error) {
      console.error('Failed to save default AI model:', error);
    }
  }

  getUrlCount(): number {
    return this.getUrls().length;
  }

  private getUrls(): string[] {
    return this.urlText
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0 && (url.startsWith('http://') || url.startsWith('https://')));
  }

  onSubmit(): void {
    if (this.captureMode === 'webpage') {
      this.onSubmitWebpage();
      return;
    }

    const urls = this.getUrls();
    if (urls.length === 0) return;

    // Save custom instructions to history if provided
    if (this.settings.customInstructions && this.settings.customInstructions.trim()) {
      this.libraryService.saveCustomInstruction(this.settings.customInstructions.trim()).subscribe({
        error: (error) => console.error('Failed to save instruction to history:', error)
      });
    }

    // A download never waits on Crucible: its steps are left off while it is not ready.
    const settings = this.aiLocked
      ? { ...this.settings, transcribe: false, aiAnalysis: false }
      : { ...this.settings, aiModel: this.modelOptions.canonical(this.settings.aiModel) };
    const configs = urls.map(url => ({
      url,
      name: this.extractNameFromUrl(url),
      settings: { ...settings }
    }));

    this.submitConfig.emit(configs);
    this.close();
  }

  onSubmitWebpage(): void {
    const urls = this.getUrls();
    if (urls.length === 0) return;
    this.captureWebpage.emit(urls);
    this.close();
  }

  close(): void {
    this.closeDialog.emit();
    this.resetForm();
  }

  private resetForm(): void {
    this.urlText = '';
    this.captureMode = 'video';
    // Reset settings but keep the saved default AI model - it will be loaded fresh when dialog reopens
    this.settings = {
      fixAspectRatio: false,
      normalizeAudio: false,
      audioLevel: -16, // Default to -16 LUFS (standard web/podcast level)
      transcribe: false,
      aiAnalysis: false,
      aiModel: '', // Will be set from saved default when dialog reopens
      customInstructions: '',
      outputFormat: 'mp4',
      outputQuality: 'high'
    };
  }

  private extractNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Try to get video ID or title from common platforms
      if (urlObj.hostname.includes('youtube') || urlObj.hostname.includes('youtu.be')) {
        const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
        return `YouTube Video ${videoId}`;
      }
      if (urlObj.hostname.includes('vimeo')) {
        return `Vimeo Video ${urlObj.pathname.split('/').pop()}`;
      }
      const path = urlObj.pathname;
      const filename = path.split('/').pop() || 'Video';
      return filename.replace(/\.[^/.]+$/, '');
    } catch {
      return 'Video';
    }
  }
}
