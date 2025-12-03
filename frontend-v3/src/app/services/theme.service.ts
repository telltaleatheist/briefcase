import { Injectable, signal, effect } from '@angular/core';

export type Theme = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly THEME_KEY = 'creamsicle-theme';

  currentTheme = signal<Theme>('dark'); // Default to dark mode
  isDarkMode = signal<boolean>(true);

  constructor() {
    // Sync isDarkMode with currentTheme
    effect(() => {
      this.isDarkMode.set(this.currentTheme() === 'dark');
    }, { allowSignalWrites: true });
  }

  initializeTheme(): void {
    const savedTheme = this.getSavedTheme();
    // Default to dark mode on first install (no saved preference)
    const theme = savedTheme || 'dark';

    this.setTheme(theme);

    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!this.getSavedTheme()) {
        this.setTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  toggleTheme(): void {
    const currentTheme = this.currentTheme();
    const newTheme: Theme = currentTheme === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
    this.saveTheme(newTheme);
  }

  setTheme(theme: Theme): void {
    this.currentTheme.set(theme);
    // Set on both html and body to ensure CSS variables work everywhere
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
  }

  private getSavedTheme(): Theme | null {
    const saved = localStorage.getItem(this.THEME_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  }

  private saveTheme(theme: Theme): void {
    localStorage.setItem(this.THEME_KEY, theme);
  }
}
