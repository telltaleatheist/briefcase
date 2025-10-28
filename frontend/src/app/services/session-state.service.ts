import { Injectable } from '@angular/core';

/**
 * Service for managing session-based state that persists during tab navigation
 * but clears when the app closes (like PHP sessions).
 *
 * Use this for temporary work state that should survive tab switching but not app restarts.
 * Use localStorage/settings.service for user preferences that should persist across app restarts.
 */
@Injectable({
  providedIn: 'root'
})
export class SessionStateService {

  /**
   * Save component state to session storage
   */
  saveState<T>(key: string, state: T): void {
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.error(`Error saving session state for ${key}:`, error);
    }
  }

  /**
   * Load component state from session storage
   */
  loadState<T>(key: string): T | null {
    try {
      const data = sessionStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`Error loading session state for ${key}:`, error);
      return null;
    }
  }

  /**
   * Clear specific component state
   */
  clearState(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
      console.error(`Error clearing session state for ${key}:`, error);
    }
  }

  /**
   * Clear all session state (useful for logout or reset)
   */
  clearAllState(): void {
    try {
      sessionStorage.clear();
    } catch (error) {
      console.error('Error clearing all session state:', error);
    }
  }

  /**
   * Check if state exists for a given key
   */
  hasState(key: string): boolean {
    return sessionStorage.getItem(key) !== null;
  }
}
