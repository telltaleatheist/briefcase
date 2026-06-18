import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ComponentService, ComponentStatus } from '../../services/component.service';
import { SetupDownloadService } from '../../services/setup-download.service';
import { AiSetupService, SystemInfo } from '../../services/ai-setup.service';

type Step = 'welcome' | 'tools' | 'models' | 'review' | 'finishing';

/**
 * Minutes-style paginated setup wizard for download-on-demand components
 * (binaries + whisper models). Selections are queued through SetupDownloadService,
 * which also drives the bottom-right download dock. The existing AI-provider
 * wizard (app-ai-setup-wizard) remains separate for engine/API-key config.
 */
@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="setup-overlay">
      <div class="setup-card">
        <div class="setup-card-head">
          <h2>{{ mode === 'config' ? 'Manage components' : 'Set up Briefcase' }}</h2>
          @if (mode === 'config') {
            <button class="ghost-icon" (click)="closed.emit()" title="Close">✕</button>
          }
        </div>

        <div class="steps-indicator">
          <span class="step-count">{{ step() === 'finishing' ? 'Finishing up' : 'Step ' + (stepIndex() + 1) + ' of ' + NUMBERED }}</span>
          <div class="step-dots">
            @for (i of dotIndexes; track i) {
              <span class="step-dot" [class.active]="i === stepIndex()" [class.done]="i < stepIndex()"></span>
            }
          </div>
        </div>

        <div class="setup-card-body">
          @switch (step()) {
            @case ('welcome') {
              <div class="step-head">
                <h3>Welcome to Briefcase</h3>
                <p class="sub">Briefcase downloads the tools and models it needs on demand. Pick what to install — you can add more later from Settings.</p>
              </div>
              @if (system(); as sys) {
                <div class="system-info">
                  <span class="chip">{{ sys.platform }}</span>
                  <span class="chip">{{ sys.totalMemoryGB }} GB RAM</span>
                  <span class="chip">{{ sys.cpuCores }} cores</span>
                  @if (sys.gpu) { <span class="chip chip-accent">{{ sys.gpu.name }}</span> }
                </div>
              }
            }

            @case ('tools') {
              <div class="step-head">
                <h3>Required tools</h3>
                <p class="sub">These power downloading, transcoding, and transcription. Required tools are selected automatically.</p>
              </div>
              <div class="select-list">
                @for (c of requiredTools(); track c.id) {
                  <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: true }"></ng-container>
                }
                @if (optionalTools().length) {
                  <div class="group-label">Optional</div>
                  @for (c of optionalTools(); track c.id) {
                    <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: false }"></ng-container>
                  }
                }
              </div>
            }

            @case ('models') {
              <div class="step-head">
                <h3>Transcription model</h3>
                <p class="sub">Whisper models power speech-to-text. Larger models are more accurate but slower and bigger.</p>
              </div>
              @if (models().length) {
                <div class="select-list">
                  @for (c of models(); track c.id) {
                    <ng-container *ngTemplateOutlet="card; context: { $implicit: c, locked: false }"></ng-container>
                  }
                </div>
              } @else {
                <p class="sub">No downloadable models are listed in the manifest yet.</p>
              }
            }

            @case ('review') {
              <div class="step-head">
                <h3>Review & download</h3>
                <p class="sub">Everything you picked. Downloads run in the background — you can keep using the app.</p>
              </div>
              <div class="review-list">
                @for (c of reviewItems(); track c.id) {
                  <div class="review-row">
                    <span>{{ c.name }} @if (c.required) { <span class="badge badge-rec">Required</span> }</span>
                    <span class="select-size">{{ fmtSize(c.sizeBytes) }}</span>
                  </div>
                }
                <div class="review-total">
                  <span>Total download</span>
                  <span>{{ fmtSize(totalBytes()) }}</span>
                </div>
              </div>
              @if (reviewItems().length === 0) {
                <p class="sub">Nothing selected — everything needed is already installed.</p>
              }
            }

            @case ('finishing') {
              <div class="finishing">
                @if (dl.running()) {
                  <div class="engine-spinner"></div>
                  <h3>Setting things up…</h3>
                  <p class="finishing-sub">Downloading the components Briefcase needs. This can run in the background.</p>
                  <div class="finish-bar"><div class="finish-bar-fill" [style.width.%]="dl.aggregatePct()"></div></div>
                } @else {
                  <div class="done-check">✓</div>
                  <h3>All set</h3>
                  <p class="finishing-sub">Your components are installed and ready.</p>
                }
              </div>
            }
          }
        </div>

        <div class="setup-card-foot">
          @if (step() !== 'welcome' && step() !== 'finishing') {
            <button class="btn btn-secondary" (click)="back()">Back</button>
          }
          <span class="spacer"></span>
          @if (step() === 'finishing') {
            <button class="btn btn-primary" [disabled]="dl.running()" (click)="finish()">
              {{ mode === 'config' ? 'Done' : 'Open Briefcase' }}
            </button>
          } @else if (step() === 'review') {
            <button class="btn btn-primary" (click)="startDownload()">
              {{ reviewItems().length ? 'Download' : 'Continue' }}
            </button>
          } @else {
            <button class="btn btn-primary" (click)="next()">Next</button>
          }
        </div>
      </div>
    </div>

    <!-- select card template -->
    <ng-template #card let-c let-locked="locked">
      <label class="select-card"
             [class.checked]="isChecked(c)"
             [class.installed]="c.installed">
        <input type="checkbox" [checked]="isChecked(c)" [disabled]="locked || c.installed" (change)="toggle(c)">
        <div class="select-info">
          <div class="select-name">{{ c.name }}
            @if (locked) { <span class="badge badge-rec">Required</span> }
          </div>
          @if (c.description) { <div class="select-desc">{{ c.description }}</div> }
        </div>
        <div class="select-meta">
          @if (c.installed) { <span class="badge badge-ok">Installed</span> }
          @else { <span class="select-size">{{ fmtSize(c.sizeBytes) }}</span> }
        </div>
      </label>
    </ng-template>
  `,
  styleUrls: ['./setup-wizard.component.scss'],
})
export class SetupWizardComponent implements OnInit {
  @Input() mode: 'setup' | 'config' = 'setup';
  @Output() closed = new EventEmitter<void>();
  @Output() completed = new EventEmitter<void>();

  private componentService = inject(ComponentService);
  private aiSetup = inject(AiSetupService);
  dl = inject(SetupDownloadService);

  readonly NUMBERED = 4; // welcome, tools, models, review
  readonly dotIndexes = [0, 1, 2, 3];

  readonly step = signal<Step>('welcome');
  readonly all = signal<ComponentStatus[]>([]);
  readonly system = signal<SystemInfo | null>(null);

  private order: Step[] = ['welcome', 'tools', 'models', 'review', 'finishing'];

  readonly stepIndex = computed(() => Math.min(this.order.indexOf(this.step()), this.NUMBERED - 1));
  readonly requiredTools = computed(() => this.all().filter((c) => c.kind === 'binary' && c.required && c.supported));
  readonly optionalTools = computed(() => this.all().filter((c) => c.kind === 'binary' && !c.required && c.supported));
  readonly models = computed(() => this.all().filter((c) => c.kind === 'whisper-model' && c.supported));
  readonly reviewItems = computed(() => this.all().filter((c) => this.dl.isSelected(c.id) && !c.installed));
  readonly totalBytes = computed(() => this.reviewItems().reduce((s, c) => s + (c.sizeBytes || 0), 0));

  async ngOnInit() {
    this.componentService.listComponents().subscribe((components) => {
      this.all.set(components);
      // Pre-select required, not-yet-installed tools.
      const presel = components.filter((c) => c.required && c.supported && !c.installed).map((c) => c.id);
      // Pre-select a default whisper model (base) if none installed.
      const models = components.filter((c) => c.kind === 'whisper-model');
      if (models.length && !models.some((m) => m.installed)) {
        const base = models.find((m) => /base/i.test(m.id) || /base/i.test(m.name)) || models[0];
        if (base) presel.push(base.id);
      }
      this.dl.select(presel);
    });
    this.aiSetup.getSystemInfo().subscribe((s) => this.system.set(s));
  }

  isChecked(c: ComponentStatus): boolean {
    return c.installed || this.dl.isSelected(c.id);
  }

  toggle(c: ComponentStatus): void {
    if (c.installed || (c.required && c.kind === 'binary')) return;
    this.dl.toggle(c.id);
  }

  next(): void {
    const i = this.order.indexOf(this.step());
    this.step.set(this.order[Math.min(i + 1, this.order.length - 1)]);
  }

  back(): void {
    const i = this.order.indexOf(this.step());
    this.step.set(this.order[Math.max(i - 1, 0)]);
  }

  startDownload(): void {
    const ids = this.reviewItems().map((c) => c.id);
    if (ids.length) this.dl.enqueue(ids);
    this.step.set('finishing');
  }

  finish(): void {
    this.completed.emit();
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
}
