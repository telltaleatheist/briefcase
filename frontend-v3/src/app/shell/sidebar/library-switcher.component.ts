import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Library switcher button at the top of the sidebar (account-switcher style).
 * Phase 1: emits `manage`, which the shell routes to the existing Library
 * Manager modal via LibraryService.requestLibraryManager().
 */
@Component({
  selector: 'app-library-switcher',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button type="button" class="switcher" (click)="manage.emit()" title="Switch or manage libraries">
      <span class="logo">🎬</span>
      <span class="name">{{ libraryName() || 'No library' }}</span>
      <span class="chevron">▾</span>
    </button>
  `,
  styles: [`
    :host { display: block; margin-bottom: 10px; }

    .switcher {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      background: var(--bg-card);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
      text-align: left;
      transition: border-color 120ms ease;

      &:hover { border-color: var(--primary-orange); }
      &:focus-visible { outline: 2px solid var(--primary-orange); outline-offset: 1px; }
    }

    .logo {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: var(--gradient-primary);
      font-size: 12px;
      flex: none;
    }

    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chevron {
      color: var(--text-tertiary);
      font-size: 10px;
      flex: none;
    }
  `]
})
export class LibrarySwitcherComponent {
  libraryName = input('');
  manage = output<void>();
}
