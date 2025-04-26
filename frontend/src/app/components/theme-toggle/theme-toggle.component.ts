import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-theme-toggle',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule
  ],
  template: `
    <button 
      mat-icon-button 
      (click)="toggleTheme()" 
      aria-label="Toggle theme"
      class="theme-toggle-button"
    >
      <mat-icon class="theme-icon {{ (isDarkTheme$ | async) ? 'dark-mode' : 'light-mode' }}">
        {{ (isDarkTheme$ | async) ? 'dark_mode' : 'light_mode' }}
      </mat-icon>
    </button>
  `,
  styles: [`
    .theme-toggle-button {
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    
    .theme-toggle-button:hover {
      transform: scale(1.1);
    }
    
    .theme-icon {
      transition: color 0.3s ease, transform 0.3s ease;
    }
    
    .theme-icon.dark-mode {
      color: #1de9b6; // Cyberpunk mint for dark mode
      text-shadow: 0 0 10px rgba(64, 255, 208, 0.5);
      animation: pulse-dark 2s infinite alternate;
    }
    
    .theme-icon.light-mode {
      color: #ffd54f; // Warm yellow for light mode
      text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
      animation: pulse-light 2s infinite alternate;
    }
    
    @keyframes pulse-dark {
      from { transform: scale(1); }
      to { transform: scale(1.1); }
    }
    
    @keyframes pulse-light {
      from { transform: scale(1); }
      to { transform: scale(1.05); }
    }
  `]
})
export class ThemeToggleComponent {
  isDarkTheme$ = this.themeService.isDarkTheme$;

  constructor(private themeService: ThemeService) {}

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }
}