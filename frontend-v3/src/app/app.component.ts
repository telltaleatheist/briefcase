import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { NavigationComponent } from './core/navigation/navigation.component';
import { ThemeService } from './services/theme.service';
import { NavigationService } from './services/navigation.service';
import { QueueService } from './services/queue.service';
import { LibraryService } from './services/library.service';
import { OnboardingComponent } from './components/onboarding/onboarding.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, NavigationComponent, OnboardingComponent],
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
    }
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

  // Onboarding state
  showOnboarding = signal(false);
  private onboardingChecked = false;

  async ngOnInit() {
    this.themeService.initializeTheme();

    // Check if onboarding is needed
    await this.checkOnboarding();
  }

  private async checkOnboarding() {
    if (this.onboardingChecked) return;
    this.onboardingChecked = true;

    // Check if onboarding was completed
    const onboardingComplete = localStorage.getItem('clipchimp-onboarding-complete') === 'true';

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
  }
}
