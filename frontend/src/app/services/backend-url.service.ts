import { Injectable } from '@angular/core';

/**
 * Service to get the backend URL from Electron
 * Caches the URL so we don't have to make IPC calls every time
 */
@Injectable({
  providedIn: 'root'
})
export class BackendUrlService {
  private backendUrl: string | null = null;
  private backendUrlPromise: Promise<string> | null = null;
  // NOTE: This fallback URL is only used during development or if Electron IPC fails
  // In production, the actual URL is retrieved from Electron using the dynamically assigned port
  private readonly fallbackUrl = 'http://localhost:3000';

  /**
   * Get the backend URL
   * Fetches from Electron on first call, then caches
   * Throws error if backend URL cannot be determined
   */
  async getBackendUrl(): Promise<string> {
    // Return cached value immediately
    if (this.backendUrl) {
      return this.backendUrl;
    }

    // If a request is already in progress, wait for it
    if (this.backendUrlPromise) {
      return this.backendUrlPromise;
    }

    // Create new promise and cache it
    this.backendUrlPromise = this.fetchBackendUrl();

    try {
      this.backendUrl = await this.backendUrlPromise;
      return this.backendUrl;
    } finally {
      this.backendUrlPromise = null;
    }
  }

  private async fetchBackendUrl(): Promise<string> {
    console.log('[BackendUrlService] fetchBackendUrl called');

    // Check if we're in Electron environment
    if ((window as any).electron && typeof (window as any).electron.getBackendUrl === 'function') {
      console.log('[BackendUrlService] Electron IPC available, requesting backend URL...');
      try {
        // Add timeout to prevent hanging forever
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout after 5 seconds')), 5000)
        );

        console.log('[BackendUrlService] Calling electron.getBackendUrl()...');
        const urlPromise = (window as any).electron.getBackendUrl();
        const url = await Promise.race([urlPromise, timeoutPromise]);

        if (url) {
          console.log('[BackendUrlService] ✅ Got backend URL from Electron:', url);
          return url;
        } else {
          console.warn('[BackendUrlService] Electron returned null/undefined, using fallback');
        }
      } catch (error) {
        console.error('[BackendUrlService] ❌ Error getting backend URL from Electron:', error);
        console.warn('[BackendUrlService] Falling back to default URL');
        // Fall through to fallback
      }
    } else {
      console.log('[BackendUrlService] Not in Electron environment or IPC not available');
    }

    // Fallback to default port (for development/testing)
    console.log('[BackendUrlService] Using fallback URL:', this.fallbackUrl);
    return this.fallbackUrl;
  }

  /**
   * Get the full API URL for a given endpoint
   * @param endpoint - The API endpoint (e.g., '/database/libraries')
   */
  async getApiUrl(endpoint: string): Promise<string> {
    const baseUrl = await this.getBackendUrl();
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${baseUrl}/api${cleanEndpoint}`;
  }

  /**
   * Clear the cached URL (useful for testing or if backend restarts on different port)
   */
  clearCache(): void {
    this.backendUrl = null;
  }
}
