import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NavigationComponent } from './core/navigation/navigation.component';
import { ThemeService } from './services/theme.service';
import { NavigationService } from './services/navigation.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, NavigationComponent],
  template: `
    <div class="app-container" [attr.data-theme]="themeService.currentTheme()">
      @if (navService.navVisible()) {
        <app-navigation />
      }
      <main class="main-content" [class.nav-hidden]="!navService.navVisible()">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    .app-container {
      display: flex;
      min-height: 100vh;
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    .main-content {
      flex: 1;
      margin-left: 280px;
      transition: margin-left 0.3s ease;
    }

    .main-content.nav-hidden {
      margin-left: 0;
    }

    @media (max-width: 768px) {
      .main-content {
        margin-left: 0;
      }
    }
  `]
})
export class AppComponent implements OnInit {
  themeService = inject(ThemeService);
  navService = inject(NavigationService);

  ngOnInit() {
    this.themeService.initializeTheme();
  }
}
