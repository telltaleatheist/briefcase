import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private isDarkTheme = new BehaviorSubject<boolean>(true);
  isDarkTheme$ = this.isDarkTheme.asObservable();

  constructor() {
    const savedTheme = localStorage.getItem('clippy-theme');
    if (savedTheme) {
      // If there's a saved theme, use it
      this.setDarkMode(savedTheme === 'dark');
    } else {
      // Default to dark mode
      this.setDarkMode(true);
    }
  }
  
  toggleTheme() {
    const newIsDark = !this.isDarkTheme.value;
    this.setDarkMode(newIsDark);
  }

  setDarkMode(isDark: boolean) {
    this.isDarkTheme.next(isDark);
    this.applyTheme(isDark);
    
    // Save theme preference
    localStorage.setItem('clippy-theme', isDark ? 'dark' : 'light');
  }

  private applyTheme(isDark: boolean) {
    if (isDark) {
      document.body.classList.add('dark-theme');
      document.body.setAttribute('data-theme', 'dark');
    } else {
      document.body.classList.remove('dark-theme');
      document.body.setAttribute('data-theme', 'light');
    }

    // Optional: Also update the meta theme-color for mobile browsers
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', isDark ? '#0f0f0f' : '#ffffff');
    }
  }
}