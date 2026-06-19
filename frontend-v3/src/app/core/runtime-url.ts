/**
 * Runtime resolution of the backend's base URL.
 *
 * Briefcase serves the Angular app, the REST API (`/api`) and the Socket.IO
 * endpoint (`/socket.io`) from a single NestJS server. Crucially, the page is
 * always loaded over HTTP from that same server:
 *   - Packaged Electron loads the renderer from `http://localhost:<backendPort>`
 *     (see window-service.ts — frontendPort === backendPort).
 *   - A LAN browser (phone, tablet) loads it from `http://<host>.local:<port>`.
 *
 * In both cases the page's own origin IS the backend, so deriving every API and
 * socket URL from `window.location.origin` makes the same build work in the
 * desktop app and in a remote browser with no per-device configuration.
 *
 * The `localhost:3000` fallback only applies to a non-HTTP origin (a `file://`
 * renderer), and the `:4200` special-case keeps the standalone Angular dev
 * server (`ng serve`) talking to the backend on its default port.
 */
export function getBackendOrigin(): string {
  const loc = typeof window !== 'undefined' ? window.location : null;

  if (loc && /^https?:$/.test(loc.protocol)) {
    // Standalone Angular dev server runs on :4200 while the backend stays on
    // :3000 — keep pointing API/socket traffic at 3000 in that one case.
    if (loc.port === '4200') {
      return `${loc.protocol}//${loc.hostname}:3000`;
    }
    return loc.origin;
  }

  // file:// renderer or non-browser context: assume the default backend port.
  return 'http://localhost:3000';
}

/** Backend REST API base, e.g. `http://owens-mac-studio.local:3000/api`. */
export function getApiBase(): string {
  return `${getBackendOrigin()}/api`;
}
