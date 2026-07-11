import { Component, OnInit, Renderer2, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { firstValueFrom, retry } from 'rxjs';
import { ThemeService } from './services/theme.service';
import { QueueService } from './services/queue.service';
import { LibraryService } from './services/library.service';
import { OnboardingComponent } from './components/onboarding/onboarding.component';
import { QuitConfirmComponent } from './components/quit-confirm/quit-confirm.component';
import { DownloadDockComponent } from './components/download-dock/download-dock.component';
import { SetupWizardComponent } from './components/setup-wizard/setup-wizard.component';
import { ComponentService } from './services/component.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, OnboardingComponent, QuitConfirmComponent, DownloadDockComponent, SetupWizardComponent],
  template: `
    <!-- Show onboarding if needed -->
    @if (showOnboarding()) {
      <app-onboarding (completed)="onOnboardingComplete()" />
    } @else {
      <!-- The shell (sidebar/toolbar/content/inspector) is the '' route -->
      <div class="app-container" [attr.data-theme]="themeService.currentTheme()">
        <router-outlet />
      </div>

      <!-- Auto-opened on launch when required download-on-demand components are missing -->
      @if (showComponentSetup()) {
        <app-setup-wizard mode="setup"
          (completed)="onComponentSetupDone()"
          (closed)="onComponentSetupDone()" />
      }
    }

    <!-- Chrome-style "press again to quit" toast (driven by the Electron main process) -->
    <app-quit-confirm />

    <!-- Download-on-demand progress dock (controls its own visibility) -->
    <app-download-dock />

    <!-- Honest surface when the first-run component check itself failed (e.g. the
         backend was unreachable). We must never silently skip setup — a
         binary-less install would look fine until the first download/transcode
         fails — so tell the user and offer a retry. -->
    @if (componentCheckError(); as err) {
      <div class="component-check-error" role="alert">
        <span class="cce-text">{{ err }}</span>
        <button type="button" class="cce-retry" (click)="retryComponentCheck()">Retry</button>
      </div>
    }
  `,
  styles: [`
    .app-container {
      height: 100vh;
      overflow: hidden;
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease, color 0.3s ease;
    }
    .component-check-error {
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 640px;
      padding: 12px 16px;
      border-radius: 8px;
      background: var(--danger, #b3261e);
      color: #fff;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      font-size: 13px;
      line-height: 1.4;
    }
    .cce-text {
      flex: 1;
    }
    .cce-retry {
      flex: none;
      padding: 6px 12px;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 6px;
      background: transparent;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
    }
    .cce-retry:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  `]
})
export class AppComponent implements OnInit {
  themeService = inject(ThemeService);
  private libraryService = inject(LibraryService);
  private renderer = inject(Renderer2);
  private document = inject(DOCUMENT);
  // Inject QueueService to ensure it initializes eagerly and restores queue
  private queueService = inject(QueueService);
  private componentService = inject(ComponentService);

  // Onboarding state
  showOnboarding = signal(false);
  private onboardingChecked = false;

  // Download-on-demand setup state
  showComponentSetup = signal(false);
  // Honest error surface when the component check couldn't reach the backend.
  componentCheckError = signal<string | null>(null);
  private componentsChecked = false;

  /**
   * True only inside the desktop (Electron) shell. A LAN browser client (phone,
   * tablet) has no `window.electron`, no native folder picker, and no business
   * managing binary/model downloads — those are desktop-only concerns.
   */
  private get isElectron(): boolean {
    return !!(window as any).electron;
  }

  async ngOnInit() {
    this.themeService.initializeTheme();

    // macOS Electron uses titleBarStyle: 'hiddenInset' — flag the body so the
    // shell toolbar reserves traffic-light space (--traffic-light-inset) and
    // becomes the window drag region.
    if (this.isElectron && navigator.platform.toUpperCase().includes('MAC')) {
      this.renderer.addClass(this.document.body, 'is-electron-mac');
    }

    // Check if onboarding is needed
    await this.checkOnboarding();

    // If we're not gating on onboarding, check for missing required components
    if (!this.showOnboarding()) {
      this.checkComponents();
    }
  }

  /**
   * Auto-open the setup wizard only when an essential component (ffmpeg/ffprobe
   * or yt-dlp) is missing. Models and the whisper/llama engines are allowed to
   * download in the background while the library loads — their dropdowns refresh
   * on completion.
   */
  private checkComponents() {
    if (this.componentsChecked) return;
    // Binaries/models are installed and managed on the desktop. A browser client
    // can't download them anywhere useful, so never pop the setup wizard there.
    if (!this.isElectron) return;
    this.componentsChecked = true;
    this.runComponentCheck();
  }

  /**
   * Fetch the component list and decide whether to auto-open the setup wizard.
   *
   * A fetch FAILURE must never be mistaken for "nothing missing": the backend may
   * still be finishing boot, so retry a few times, and if it still fails surface
   * an honest, retryable error instead of silently skipping first-run setup. With
   * no media binaries bundled, that silent skip would leave the app looking fine
   * until the first download/transcode fails.
   */
  private runComponentCheck() {
    this.componentCheckError.set(null);
    this.componentService
      .fetchComponents()
      .pipe(retry({ count: 4, delay: 1500 }))
      .subscribe({
        next: (components) => {
          if (this.componentService.hasMissingEssential(components)) {
            this.showComponentSetup.set(true);
          }
        },
        error: (err) => {
          console.error('Failed to check required components:', err);
          this.componentCheckError.set(
            "Couldn't check which components are installed — Briefcase may be missing tools it needs to download and process video. Check your connection and retry.",
          );
        },
      });
  }

  retryComponentCheck() {
    this.runComponentCheck();
  }

  onComponentSetupDone() {
    this.showComponentSetup.set(false);
  }

  private async checkOnboarding() {
    if (this.onboardingChecked) return;
    this.onboardingChecked = true;

    // Web client (phone/tablet browser): the onboarding flow creates/links a
    // library via the native folder picker, which doesn't exist outside Electron.
    // Skip it entirely and let the library page connect to whatever library the
    // desktop already has active (GET /api/database/libraries/active).
    if (!this.isElectron) {
      this.showOnboarding.set(false);
      return;
    }

    // Check if onboarding was completed
    const onboardingComplete = localStorage.getItem('briefcase-onboarding-complete') === 'true';

    if (onboardingComplete) {
      // Even if onboarding is complete, check if there's a library
      // This handles the case where the user deleted all libraries
      const hasLibrary = this.libraryService.currentLibrary() !== null;
      if (!hasLibrary) {
        // Try to load libraries and check again
        try {
          const response = await firstValueFrom(this.libraryService.getLibraries());
          if (response.success && response.data.length === 0) {
            // No libraries exist, show onboarding
            this.showOnboarding.set(true);
          }
        } catch (err) {
          console.error('Failed to check libraries:', err);
        }
      }
    } else {
      // First run, show onboarding
      this.showOnboarding.set(true);
    }
  }

  onOnboardingComplete() {
    this.showOnboarding.set(false);
    // After onboarding, check whether required components still need downloading.
    this.checkComponents();
  }
}
