// Build CORS origins dynamically based on actual running port
const port = process.env.PORT || 3000;

// LAN exposure is OPT-IN. By default the backend binds to loopback (127.0.0.1)
// and is only reachable from this machine. Set BRIEFCASE_LAN=1 to bind all
// interfaces so other devices on the local network can reach it.
//
// SECURITY TODO(owner): LAN mode currently has NO authentication — anyone who
// can reach the port can call every endpoint. Before recommending LAN mode on
// an untrusted network, decide on an auth story (token / PIN / mTLS). This is a
// deliberate future decision, not an oversight.
const lanMode = process.env.BRIEFCASE_LAN === '1' || process.env.BRIEFCASE_LAN === 'true';

/**
 * CORS origin policy.
 *
 * Loopback-only bind (default): the server is not reachable off-box, so
 * reflecting any origin is safe and keeps local dev/tooling frictionless.
 *
 * LAN mode: the server is reachable by other hosts, so we must NOT reflect
 * arbitrary origins (a malicious site the owner visits could otherwise script
 * requests against it). Allow only same-host origins on the server's own port:
 * loopback and RFC-1918 private-range hosts. No-origin requests (curl, the
 * native Electron shell, same-origin navigations) are always allowed.
 */
function lanCorsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) {
    callback(null, true);
    return;
  }
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const isPrivateLan = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if ((isLoopback || isPrivateLan) && url.port === String(port)) {
      callback(null, true);
      return;
    }
  } catch {
    // Malformed Origin header — deny (fail closed).
  }
  callback(null, false);
}

export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: port,
  apiPrefix: 'api',

  // Whether LAN exposure is enabled, and the resulting bind host.
  lanMode,
  host: process.env.BACKEND_HOST || (lanMode ? '0.0.0.0' : '127.0.0.1'),

  // CORS configuration.
  // - Default (loopback): reflect any origin (not reachable off-box).
  // - LAN mode: restrict to same-host origins AND drop credentialed CORS.
  cors: {
    origins: lanMode ? lanCorsOrigin : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // credentials:true + origin reflection is the dangerous combo. The app uses
    // no cookie/session auth, so credentialed CORS is unnecessary; only enable
    // it on the safe loopback-only path.
    credentials: !lanMode,
  },

  socket: {
    path: '/socket.io',
    credentials: !lanMode,
  },

  batchProcessing: {
    defaultMaxConcurrentDownloads: 2,
    enabled: true
  },
};
