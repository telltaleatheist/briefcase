import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SetupDownloadService } from '../../services/setup-download.service';
import { ComponentService } from '../../services/component.service';

/**
 * Bottom-right collapsible download dock. Shows aggregate + per-item progress
 * for component installs driven by SetupDownloadService. Lives in the app shell
 * so it survives navigation. Visual spec adapted from the Minutes dock, themed
 * with the app's CSS variables.
 */
@Component({
  selector: 'app-download-dock',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (dl.visible()) {
      <div class="dock">
        <div class="dock-header-row">
          <button class="dock-head" (click)="expanded.set(!expanded())">
            <span class="dock-icon" [class.spin]="dl.running()" [class.warn]="hasFailures()" [class.ok]="!dl.running() && !hasFailures()">
              {{ dl.running() ? '' : (hasFailures() ? '!' : '✓') }}
            </span>
            <span class="dock-title">{{ title() }}</span>
            <span class="dock-chevron">{{ expanded() ? '▾' : '▸' }}</span>
          </button>
          @if (!dl.running()) {
            <button class="dock-dismiss" title="Dismiss" (click)="dl.dismiss()">✕</button>
          }
        </div>

        @if (dl.running()) {
          <div class="dock-aggregate">
            <div class="dock-bar"><div class="dock-fill" [style.width.%]="dl.aggregatePct()"></div></div>
          </div>
        }

        @if (expanded()) {
          <div class="dock-body">
            @for (id of dl.order(); track id) {
              <div class="dock-item" [attr.data-status]="dl.statusOf(id)">
                <span class="di-name" [title]="nameOf(id)">{{ nameOf(id) }}</span>
                @switch (dl.statusOf(id)) {
                  @case ('downloading') {
                    <div class="di-bar"><div class="di-fill" [style.width.%]="dl.pctOf(id)"></div></div>
                    <span class="di-pct">{{ dl.pctOf(id) }}%</span>
                  }
                  @case ('queued') { <span class="di-pct">Queued</span> }
                  @case ('done') { <span class="di-done">✓</span> }
                  @case ('failed') { <span class="di-failed" [title]="dl.failed()[id]">Failed</span> }
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .dock {
      position: fixed; right: 16px; bottom: 16px; z-index: 9000;
      width: 300px; max-width: calc(100vw - 32px);
      background: var(--bg-elevated, #252525);
      border: 1px solid var(--border-color, #374151);
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.35);
      overflow: hidden; font-size: 0.8125rem;
      color: var(--text-primary, #fff);
    }
    .dock-header-row { display: flex; align-items: center; }
    .dock-head {
      display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0;
      padding: 0.625rem 0.75rem; background: transparent; border: none;
      color: var(--text-primary, #fff); cursor: pointer; text-align: left;
    }
    .dock-head:hover { background: var(--bg-tertiary, #2d2d2d); }
    .dock-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dock-chevron { color: var(--text-secondary, #d1d5db); }
    .dock-dismiss {
      background: transparent; border: none; color: var(--text-secondary, #d1d5db);
      cursor: pointer; padding: 0 0.625rem; font-size: 0.9rem;
    }
    .dock-dismiss:hover { color: var(--text-primary, #fff); }
    .dock-icon { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .dock-icon.ok { color: var(--success, #22c55e); }
    .dock-icon.warn { color: var(--error, #ef4444); font-weight: 700; }
    .dock-icon.spin {
      border: 2px solid var(--bg-tertiary, #2d2d2d);
      border-top-color: var(--accent-orange, #ffa366);
      border-radius: 50%; animation: dockspin 0.8s linear infinite;
    }
    @keyframes dockspin { to { transform: rotate(360deg); } }
    .dock-aggregate { padding: 0 0.75rem 0.5rem; }
    .dock-bar { height: 4px; background: var(--bg-tertiary, #2d2d2d); border-radius: 2px; overflow: hidden; }
    .dock-fill { height: 100%; background: var(--gradient-primary, linear-gradient(135deg,#ff6b35,#ffa366)); transition: width 0.2s ease; }
    .dock-body { border-top: 1px solid var(--border-color, #374151); max-height: 240px; overflow-y: auto; }
    .dock-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.375rem 0.75rem; min-height: 28px; }
    .di-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .di-bar { flex: 0 0 60px; height: 4px; background: var(--bg-tertiary, #2d2d2d); border-radius: 2px; overflow: hidden; }
    .di-fill { height: 100%; background: var(--gradient-primary, linear-gradient(135deg,#ff6b35,#ffa366)); transition: width 0.2s ease; }
    .di-pct { color: var(--text-secondary, #d1d5db); font-variant-numeric: tabular-nums; }
    .di-done { color: var(--success, #22c55e); }
    .di-failed { color: var(--error, #ef4444); font-size: 0.6875rem; }
  `],
})
export class DownloadDockComponent {
  readonly expanded = signal(true);

  readonly title = computed(() => {
    const ids = this.dl.order();
    const done = ids.filter((id) => this.dl.doneIds().has(id)).length;
    const failed = Object.keys(this.dl.failed()).length;
    if (this.dl.running()) return `Downloading ${done}/${ids.length}…`;
    if (failed > 0) return `${done}/${ids.length} done · ${failed} failed`;
    return 'Downloads complete';
  });

  constructor(
    public dl: SetupDownloadService,
    private components: ComponentService,
  ) {}

  hasFailures(): boolean {
    return Object.keys(this.dl.failed()).length > 0;
  }

  nameOf(id: string): string {
    return this.components.components().find((c) => c.id === id)?.name || id;
  }
}
