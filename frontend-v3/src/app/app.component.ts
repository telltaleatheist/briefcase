import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { NavigationComponent } from './core/navigation/navigation.component';
import { ThemeService } from './services/theme.service';
import { NavigationService } from './services/navigation.service';
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
  imports: [RouterOutlet, NavigationComponent, OnboardingComponent, QuitConfirmComponent, DownloadDockComponent, SetupWizardComponent],
  template: `
    <!-- Show onboarding if needed -->
    @if (showOnboarding()) {
      <app-onboarding (completed)="onOnboardingComplete()" />
    } @else {
      <div class="app-container" [attr.data-theme]="themeService.currentTheme()">
        @if (navService.navVisible()) {
          <app-navigation />
        }
        <main class="main-content" [class.nav-hidden]="!navService.navVisible()">
          <router-outlet />
        </main>
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
  `,
  styles: [`
    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    .main-content {
      flex: 1;
      margin-top: 60px;
      height: calc(100vh - 60px);
      overflow: hidden;
      transition: margin-top 0.3s ease, height 0.3s ease;
    }

    .main-content.nav-hidden {
      margin-top: 0;
      height: 100vh;
    }
  `]
})
export class AppComponent implements OnInit {
  themeService = inject(ThemeService);
  navService = inject(NavigationService);
  private libraryService = inject(LibraryService);
  // Inject QueueService to ensure it initializes eagerly and restores queue
  private queueService = inject(QueueService);
  private componentService = inject(ComponentService);

  // Onboarding state
  showOnboarding = signal(false);
  private onboardingChecked = false;

  // Download-on-demand setup state
  showComponentSetup = signal(false);
  private componentsChecked = false;

  async ngOnInit() {
    this.themeService.initializeTheme();

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
    this.componentsChecked = true;
    this.componentService.listComponents().subscribe((components) => {
      if (this.componentService.hasMissingEssential(components)) {
        this.showComponentSetup.set(true);
      }
    });
  }

  onComponentSetupDone() {
    this.showComponentSetup.set(false);
  }

  private async checkOnboarding() {
    if (this.onboardingChecked) return;
    this.onboardingChecked = true;

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
