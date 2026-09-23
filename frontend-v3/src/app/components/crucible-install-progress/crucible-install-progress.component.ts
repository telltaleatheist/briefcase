import { ChangeDetectionStrategy, Component, Input, computed, signal } from '@angular/core';
import type { CrucibleInstallProgress } from '@crucible-wire/install-wire';
import { installHeadline, installStepWord } from '../crucible-doors/crucible-words';

/**
 * A running (or finished) Crucible install, drawn from its progress events.
 *
 * BookForge's crucible-install-progress, reduced to what Briefcase needs: the
 * headline step, a byte bar while something downloads, the Windows state
 * sentence verbatim, the refusal verbatim (code, message, command, evidence),
 * and the raw lines behind a disclosure for anyone who wants them.
 */
@Component({
  selector: 'app-crucible-install-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cip">
      <div class="cip-head">
        @if (running()) { <span class="cip-spinner" aria-hidden="true"></span> }
        <span class="cip-headline">{{ headline() }}</span>
      </div>

      @if (steps().length) {
        <ol class="cip-steps">
          @for (s of steps(); track s.step) {
            <li [class.ok]="s.status === 'ok'" [class.skipped]="s.status === 'skipped'">
              <span class="cip-mark" aria-hidden="true"></span>{{ word(s.step) }}
            </li>
          }
        </ol>
      }

      @if (bytes(); as b) {
        <div class="cip-bar" [attr.title]="b.file">
          <div class="cip-bar-fill" [style.width.%]="b.pct"></div>
        </div>
      }

      @if (failure(); as f) {
        <div class="cip-refusal" role="alert">
          <p><span class="cip-code">{{ f.code }}</span> {{ f.message }}</p>
          @if (f.command) { <pre class="cip-cmd">{{ f.command }}</pre> }
          @if (f.detail) { <p class="cip-detail">{{ f.detail }}</p> }
        </div>
      }

      @if (lines().length) {
        <button type="button" class="cip-toggle" (click)="open.set(!open())">
          {{ open() ? 'Hide details' : 'Show details' }}
        </button>
        @if (open()) {
          <pre class="cip-lines">{{ lines().join('\\n') }}</pre>
        }
      }
    </div>
  `,
  styles: [`
    .cip { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; font-size: 13px; }
    .cip-head { display: flex; align-items: center; gap: 8px; color: var(--text-primary); }
    .cip-headline { font-weight: 500; }
    .cip-spinner {
      width: 14px; height: 14px; border-radius: 50%; flex: none;
      border: 2px solid var(--bg-tertiary); border-top-color: var(--accent-orange);
      animation: cip-spin 0.8s linear infinite;
    }
    @keyframes cip-spin { to { transform: rotate(360deg); } }
    .cip-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; color: var(--text-secondary); }
    .cip-steps li { display: flex; align-items: center; gap: 8px; }
    .cip-mark { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--text-tertiary); flex: none; }
    .cip-steps li.ok .cip-mark { background: var(--success); border-color: var(--success); }
    .cip-steps li.skipped { opacity: 0.6; }
    .cip-bar { height: 6px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .cip-bar-fill { height: 100%; background: var(--accent-orange); transition: width 0.2s ease; }
    .cip-refusal p { margin: 0; color: var(--warning); line-height: 1.45; }
    .cip-code { font-family: var(--font-mono, monospace); font-size: 12px; }
    .cip-cmd, .cip-lines {
      margin: 4px 0 0; padding: 8px 10px; border-radius: 8px; max-height: 180px; overflow: auto;
      background: var(--bg-secondary); border: 1px solid var(--border-color);
      font-family: var(--font-mono, monospace); font-size: 11.5px; white-space: pre-wrap; color: var(--text-secondary);
    }
    .cip-detail { font-size: 12px; color: var(--text-tertiary) !important; }
    .cip-toggle {
      align-self: flex-start; background: none; border: none; padding: 0; cursor: pointer;
      color: var(--accent-orange); font-size: 12.5px; font-weight: 600;
    }
  `],
})
export class CrucibleInstallProgressComponent {
  private readonly all = signal<readonly CrucibleInstallProgress[]>([]);
  readonly open = signal(false);

  @Input({ required: true }) set events(value: readonly CrucibleInstallProgress[]) {
    this.all.set(value);
  }

  /** True while the install is running (the host says so; events alone cannot). */
  @Input() set active(value: boolean) {
    this.activeSignal.set(value);
  }
  private readonly activeSignal = signal(false);

  readonly running = computed(() => this.activeSignal());
  readonly headline = computed(() => installHeadline(this.all()));

  /** Each step once, at its latest status, in the order they began. */
  readonly steps = computed(() => {
    const byName = new Map<string, { step: string; status: string }>();
    for (const e of this.all()) if (e.kind === 'step') byName.set(e.step, { step: e.step, status: e.status });
    return [...byName.values()];
  });

  readonly bytes = computed(() => {
    const events = this.all();
    const last = events[events.length - 1];
    if (last === undefined || last.kind !== 'progress' || last.total === null) return null;
    return { file: last.file, pct: Math.min(100, Math.round((last.done / Math.max(1, last.total)) * 100)) };
  });

  readonly failure = computed(() => {
    const last = this.all()[this.all().length - 1];
    return last?.kind === 'failed' ? last.refusal : null;
  });

  readonly lines = computed(() => this.all().flatMap((e) => (e.kind === 'line' ? [`[${e.step}] ${e.text}`] : [])).slice(-200));

  word(step: string): string {
    return installStepWord(step);
  }
}
