import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Theme, ThemeService } from '../../../services/theme.service';
import { LoggerService } from '../../../services/logger.service';
import { UiButtonComponent } from '../../../ui';

/** Settings → General: appearance + diagnostics. */
@Component({
  selector: 'app-general-pane',
  standalone: true,
  imports: [UiButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./panes-shared.scss'],
  template: `
    <h2 class="pane-title">General</h2>
    <p class="pane-lede">App-wide preferences.</p>

    <div class="pane-section">
      <p class="section-label">Appearance</p>
      <div class="radio-row" role="radiogroup" aria-label="Theme">
        <label>
          <input
            type="radio"
            name="theme"
            value="dark"
            [checked]="theme.currentTheme() === 'dark'"
            (change)="selectTheme('dark')" />
          Dark
        </label>
        <label>
          <input
            type="radio"
            name="theme"
            value="light"
            [checked]="theme.currentTheme() === 'light'"
            (change)="selectTheme('light')" />
          Light
        </label>
      </div>
      <p class="hint">Also toggleable from the toolbar.</p>
    </div>

    <div class="pane-section">
      <p class="section-label">Diagnostics</p>
      <div class="actions-row">
        <ui-button variant="secondary" (pressed)="downloadLogs()">Download logs</ui-button>
      </div>
      <p class="hint">Saves the app's recent logs to a file — useful when reporting a problem.</p>
    </div>
  `
})
export class GeneralPaneComponent {
  theme = inject(ThemeService);
  private logger = inject(LoggerService);

  selectTheme(theme: Theme): void {
    this.theme.selectTheme(theme);
  }

  downloadLogs(): void {
    this.logger.downloadLogs();
  }
}
