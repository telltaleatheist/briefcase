/**
 * WHICH WEB ORIGINS ARE BRIEFCASE ITSELF.
 *
 * The backend has no authentication. On loopback it is unreachable from other
 * machines, but every web page open in a browser on this Mac can still send it
 * requests: before this rule, CORS reflected any Origin, so any site could read
 * the library and drive the API. One predicate now answers "is this origin the
 * app", and CORS (HTTP and Socket.IO), the WebSocket handshake, and the write
 * guard (appOriginWriteGuard below, and the Crucible doors' guard) all use it.
 *
 * The app's origins:
 *   - the backend's own served origin on loopback: http://localhost:<port>,
 *     http://127.0.0.1:<port>, http://[::1]:<port>. The Electron renderer and
 *     every popout window load from there (window-service.ts: frontendPort is
 *     the backend's port), and so does the tray's "open in browser".
 *   - the Angular dev server (`ng serve`, http://localhost:4200) when the
 *     backend is not a production build, since runtime-url.ts points it at us.
 *   - LAN mode (BRIEFCASE_LAN=1) only, exactly the rule that mode already had: a
 *     private-range (RFC 1918 or 127.x) host on the backend's own port. For the
 *     server-side checks, also a same-origin request (Origin equals the Host the
 *     request was sent to), which is how a phone that loaded the app from
 *     http://<mac>.local:<port> talks back to it.
 *
 * Not the app: any other host or port, `null` (file://, sandboxed frames, data:
 * URLs; the packaged app never loads from file://), and anything unparsable.
 * A request with no Origin at all (Node, curl, the Electron main process, a
 * same-origin GET) is not a browser page acting cross-site and is let through.
 */
import { IncomingMessage } from 'http';

export const DEV_SERVER_PORT = '4200';

export interface OriginPolicy {
  /** The backend's own port. */
  port: string;
  /** BRIEFCASE_LAN=1: private-range hosts on our port are the app too. */
  lan: boolean;
  /** Not a production build: the Angular dev server's origin is the app too. */
  devServer: boolean;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PRIVATE_LAN = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * True when `origin` is one of the app's own origins. `requestHost` (the Host
 * header) enables the LAN same-origin rule; CORS never needs it, because a
 * same-origin request is not subject to CORS.
 */
export function isAppOrigin(origin: string, policy: OriginPolicy, requestHost?: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');

  if (isLoopbackHost(host) && port === policy.port) return true;
  if (policy.devServer && !policy.lan && isLoopbackHost(host) && port === DEV_SERVER_PORT) return true;
  if (policy.lan) {
    if (port === policy.port && PRIVATE_LAN.test(host)) return true;
    if (requestHost && url.host.toLowerCase() === requestHost.toLowerCase()) return true;
  }
  return false;
}

/** For the `cors` package (Nest enableCors and Socket.IO): allow no-Origin and app origins. */
export function corsOriginFor(policy: OriginPolicy) {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void => {
    callback(null, origin === undefined || isAppOrigin(origin, policy));
  };
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * May a request that changes state go ahead? Safe methods always may (CORS
 * already keeps a foreign page from reading the answer); otherwise it needs no
 * Origin or an app origin. This is the part CORS cannot do: a plain form POST
 * needs no preflight, so without it the request would still run.
 */
export function writeAllowed(
  method: string,
  origin: string | string[] | undefined,
  policy: OriginPolicy,
  requestHost?: string | string[],
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  const value = firstHeader(origin);
  if (value === undefined) return true;
  return isAppOrigin(value, policy, firstHeader(requestHost));
}

/**
 * The WebSocket handshake: browsers send Origin on it but CORS does not apply
 * to WebSockets, so Socket.IO's `cors` option never checked it.
 */
export function socketHandshakeAllowed(req: IncomingMessage, policy: OriginPolicy): boolean {
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return true;
  return isAppOrigin(origin, policy, firstHeader(req.headers.host));
}

/**
 * Express middleware: refuse (403) a state-changing request from a web page
 * that is not the app. Installed for the whole API in main.ts.
 */
export function appOriginWriteGuard(policy: OriginPolicy) {
  return (
    req: { method: string; headers: Record<string, string | string[] | undefined> },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ): void => {
    if (writeAllowed(req.method, req.headers['origin'], policy, req.headers['host'])) {
      next();
      return;
    }
    res.status(403).json({
      statusCode: 403,
      message: 'Briefcase only accepts changes from Briefcase itself.',
    });
  };
}
