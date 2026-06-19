import { Injectable } from '@angular/core';
import { getBackendOrigin, getApiBase } from '../core/runtime-url';

/**
 * Thin async adapter over the synchronous URL helpers in core/runtime-url.ts.
 *
 * Briefcase always serves the renderer over HTTP from the same NestJS server
 * that hosts `/api` and `/socket.io`, so the page's own origin IS the backend —
 * in the desktop app (loopback) and in a LAN browser alike. Discovering the URL
 * therefore needs no Electron IPC round-trip; `getBackendOrigin()` answers it
 * synchronously.
 *
 * This service exists only so the many Observable/Promise-based call sites can
 * keep their existing `await getApiUrl(...)` shape. New code should import
 * `getApiBase()` / `getBackendOrigin()` from core/runtime-url directly.
 */
@Injectable({ providedIn: 'root' })
export class BackendUrlService {
  /** Backend origin, e.g. `http://owens-mac-studio.local:3000`. */
  async getBackendUrl(): Promise<string> {
    return getBackendOrigin();
  }

  /** Full API URL for an endpoint, e.g. `getApiUrl('/database')`. */
  async getApiUrl(endpoint: string): Promise<string> {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${getApiBase()}${cleanEndpoint}`;
  }

  /** Retained for API compatibility; the origin is resolved synchronously. */
  clearCache(): void {
    // no-op
  }
}
