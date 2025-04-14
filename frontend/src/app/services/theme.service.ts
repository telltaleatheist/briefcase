import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private isDarkTheme = new BehaviorSubject<boolean>(false);
  isDarkTheme$ = this.isDarkTheme.asObservable();

  constructor() {
    // Check local storage for saved theme preference or use system preference
    const savedTheme = localStorage.getItem('clippy-theme');
    if (savedTheme) {
      this.setTheme(savedTheme === 'dark');
    } else {
      // Use system preference as default if available
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      this.setTheme(prefersDark);
    }
  }

  toggleTheme() {
    const newIsDark = !this.isDarkTheme.value;
    this.setTheme(newIsDark);
  }

  setTheme(isDark: boolean) {
    this.isDarkTheme.next(isDark);
    this.applyTheme(isDark);
    
    // Save theme preference
    localStorage.setItem('clippy-theme', isDark ? 'dark' : 'light');
  }

  private applyTheme(isDark: boolean) {
    if (isDark) {
      document.body.classList.add('theme-dark');
    } else {
      document.body.classList.remove('theme-dark');
    }
    
    // Optional: Also update the meta theme-color for mobile browsers
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', isDark ? '#303030' : '#f5f5f5');
    }
  }
}