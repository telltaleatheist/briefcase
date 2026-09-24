import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ComponentService, ComponentStatus } from '../../services/component.service';
import { SetupDownloadService } from '../../services/setup-download.service';
import { CrucibleService } from '../../services/crucible.service';
import { CrucibleDoorsComponent } from '../crucible-doors/crucible-doors.component';
import { CrucibleUpstreamsComponent } from '../crucible-upstreams/crucible-upstreams.component';
import type { AiModelsView } from '@crucible-wire/ai-wire';
import { firstValueFrom } from 'rxjs';

type Step = 'welcome' | 'tools' | 'engine' | 'ai' | 'review' | 'finishing';

/**
 * Minutes-style paginated setup wizard for download-on-demand tools (ffmpeg,
 * yt-dlp). Selections are queued through SetupDownloadService, which also
 * drives the bottom-right download dock.
 *
 * The `engine` step (Crucible, migration plan §5.1) comes before the AI step:
 * it finds the Crucible on this computer, adopts one another app installed,
 * installs one where this computer can hold it, or connects one elsewhere.
 * All AI (transcription included) runs on Crucible; skipping the step is Next,
 * and only AI actions wait for it. In first-run mode the wizard holds
 * Crucible's coordination while it is open, so nothing is downloaded before the
 * user has chosen, and releases it when it closes.
 */
@Component({
  selector: 'app-setup-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, CrucibleDoorsComponent, CrucibleUpstreamsComponent],
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
          <span class="step-count">{{ step() === 'finishing' ? 'Finishing up' : 'Step ' + (stepIndex() + 1) + ' of ' + numbered() }}</span>
          <div class="step-dots">
            @for (i of dotIndexes(); track i) {
              <span class="step-dot" [class.active]="i === stepIndex()" [class.done]="i < stepIndex()"></span>
            }
          </div>
        </div>

        <div class="setup-card-body">
          @switch (step()) {
            @case ('welcome') {
              <div class="step-head">
                <h3>Welcome to Briefcase</h3>
                <p class="sub">Briefcase downloads the tools it needs on demand, and runs its AI on Crucible. You can change all of this later from Settings.</p>
              </div>
            }

            @case ('tools') {
              <div class="step-head">
                <h3>Required tools</h3>
                <p class="sub">These power downloading and transcoding. Required tools are selected automatically.</p>
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

            @case ('engine') {
              <div class="step-head">
                <h3>AI engine</h3>
                <p class="sub">Briefcase's AI features (transcription, chapters, flags, titles) run on Crucible, a shared engine that also serves BookForge and Foundry. It can run on this computer or on another one you connect. You can skip this: your library, downloads and the editor work without it.</p>
              </div>
              <app-crucible-doors mode="probing" />
            }

            @case ('ai') {
              @if (crucibleAi()?.server; as server) {
                <div class="step-head">
                  <h3>Cloud models and Ollama</h3>
                  <p class="sub">AI runs through Crucible on {{ server }}. A Claude or OpenAI key, or an Ollama address, is saved on that server, not in Briefcase. Local models come from its catalog, and Crucible prepares them when you finish. All of this is optional.</p>
                </div>
                <app-crucible-upstreams [server]="server" />
              } @else {
                <div class="step-head">
                  <h3>AI needs Crucible</h3>
                  <p class="sub">Briefcase's AI features (transcription, chapters, flags, titles) run on Crucible. Set it up on this computer or connect one on another, or skip this: your library, downloads and the editor work without it.</p>
                </div>
                <app-crucible-doors mode="probing" (changed)="loadAiStep()" />
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
                @if (essentialFailed()) {
                  <div class="done-check error">!</div>
                  <h3>Something went wrong</h3>
                  <p class="finishing-sub">An essential tool couldn't be downloaded, so Briefcase can't start yet. Check your internet connection and try again.</p>
                  <button class="btn btn-secondary" (click)="retryEssentials()">Retry</button>
                } @else if (dl.running()) {
                  <div class="engine-spinner"></div>
                  @if (essentialPending()) {
                    <h3>Setting things up…</h3>
                    <p class="finishing-sub">Installing the essential tools Briefcase needs to run.</p>
                  } @else {
                    <div class="done-check">✓</div>
                    <h3>You're ready to go</h3>
                    <p class="finishing-sub">Essential tools are installed. The rest keeps downloading in the background, so feel free to keep working.</p>
                  }
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
            <button class="btn btn-primary" [disabled]="essentialPending() || essentialFailed()" (click)="finish()">
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
  private crucible = inject(CrucibleService);
  dl = inject(SetupDownloadService);

  private readonly allSteps: Step[] = ['welcome', 'tools', 'engine', 'ai', 'review', 'finishing'];
  readonly steps = computed<Step[]>(() => this.allSteps);
  /** The numbered steps (all but `finishing`). */
  readonly numbered = computed(() => this.steps().length - 1);
  readonly dotIndexes = computed(() => Array.from({ length: this.numbered() }, (_, i) => i));

  readonly step = signal<Step>('welcome');
  readonly all = signal<ComponentStatus[]>([]);
  /** The AI step's face: the connected server's upstreams, or the Crucible doors. */
  readonly crucibleAi = signal<AiModelsView | null>(null);

  readonly stepIndex = computed(() => Math.min(this.steps().indexOf(this.step()), this.numbered() - 1));
  readonly requiredTools = computed(() => this.all().filter((c) => c.kind === 'binary' && c.required && c.supported));
  readonly optionalTools = computed(() =>
    this.all().filter((c) => c.kind === 'binary' && !c.required && c.supported),
  );
  readonly reviewItems = computed(() => this.all().filter((c) => this.dl.isSelected(c.id) && !c.installed));
  readonly totalBytes = computed(() => this.reviewItems().reduce((s, c) => s + (c.sizeBytes || 0), 0));

  /**
   * True while an essential tool (ffmpeg/ffprobe, yt-dlp) is still queued or
   * downloading. We block "Open Briefcase" only on these; anything else may keep
   * downloading in the background once the essentials are in place.
   */
  readonly essentialPending = computed(() =>
    this.dl.order().some(
      (id) =>
        this.componentService.isEssential(id) &&
        (this.dl.statusOf(id) === 'queued' || this.dl.statusOf(id) === 'downloading'),
    ),
  );

  /**
   * True when an essential tool failed to download. Briefcase can't run without
   * these, so a failure must block "Open Briefcase" and surface an error +
   * retry — never fall through to the success screen (FC-2).
   */
  readonly essentialFailed = computed(() =>
    this.dl.order().some(
      (id) => this.componentService.isEssential(id) && this.dl.statusOf(id) === 'failed',
    ),
  );

  async ngOnInit() {
    // First run: hold Crucible's coordination until the user has chosen, so no
    // model download starts under an open wizard. Released in finish().
    if (this.mode === 'setup') this.crucible.holdFirstRun().subscribe({ error: () => undefined });
    this.componentService.listComponents().subscribe((components) => {
      this.all.set(components);
      // Pre-select required, not-yet-installed tools.
      const presel = components.filter((c) => c.required && c.supported && !c.installed).map((c) => c.id);
      this.dl.select(presel);
    });
  }

  isChecked(c: ComponentStatus): boolean {
    return c.installed || this.dl.isSelected(c.id);
  }

  toggle(c: ComponentStatus): void {
    if (c.installed || (c.required && c.kind === 'binary')) return;
    this.dl.toggle(c.id);
  }

  next(): void {
    this.advance(1);
  }

  back(): void {
    this.advance(-1);
  }

  private advance(by: 1 | -1): void {
    const order = this.steps();
    const i = order.indexOf(this.step());
    this.step.set(order[Math.min(Math.max(i + by, 0), order.length - 1)]);
    if (this.step() === 'ai') void this.loadAiStep();
  }

  /** Which server the keys would go to. Read on entering the AI step. */
  async loadAiStep(): Promise<void> {
    try {
      this.crucibleAi.set(await firstValueFrom(this.crucible.aiModels()));
    } catch {
      this.crucibleAi.set(null);
    }
  }

  startDownload(): void {
    const ids = this.reviewItems().map((c) => c.id);
    if (ids.length) this.dl.enqueue(ids);
    this.step.set('finishing');
  }

  /** Re-attempt any essential downloads that failed, from the finishing screen. */
  retryEssentials(): void {
    const failedEssentials = this.dl
      .order()
      .filter((id) => this.componentService.isEssential(id) && this.dl.statusOf(id) === 'failed');
    if (failedEssentials.length === 0) return;
    // Clear the failed flag so the queue drain picks them back up.
    this.dl.failed.update((f) => {
      const next = { ...f };
      failedEssentials.forEach((id) => delete next[id]);
      return next;
    });
    this.dl.enqueue(failedEssentials);
  }

  finish(): void {
    this.releaseCrucible();
    this.completed.emit();
  }

  /** Release the first-run hold: Crucible prepares what Briefcase needs in the background. */
  private releaseCrucible(): void {
    if (this.mode === 'setup') this.crucible.finishFirstRun().subscribe({ error: () => undefined });
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }
}
