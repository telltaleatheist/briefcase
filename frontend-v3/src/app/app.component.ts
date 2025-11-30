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

  ngOnInit() {
    this.themeService.initializeTheme();
  }
}
