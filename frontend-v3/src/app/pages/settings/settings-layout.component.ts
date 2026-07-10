import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

interface PaneLink {
  path: string;
  label: string;
  glyph: string;
}

/**
 * Settings shell — a secondary sidebar of panes plus a routed content area.
 * Each pane is its own lazy child route (see app.routes.ts). This is the
 * single Settings destination that consolidates the old settings page,
 * manager tab, library-manager modal, AI wizard, and Models & Tools.
 */
@Component({
  selector: 'app-settings-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './settings-layout.component.html',
  styleUrls: ['./settings-layout.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SettingsLayoutComponent {
  readonly panes: PaneLink[] = [
    { path: 'general', label: 'General', glyph: '🎛' },
    { path: 'libraries', label: 'Libraries', glyph: '📚' },
    { path: 'downloads', label: 'Downloads', glyph: '⬇️' },
    { path: 'transcription', label: 'Transcription', glyph: '🎤' },
    { path: 'ai', label: 'AI', glyph: '✦' },
    { path: 'components', label: 'Components', glyph: '📦' },
  ];
}
