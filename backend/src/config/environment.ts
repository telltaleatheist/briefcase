import { OriginPolicy, corsOriginFor } from '../common/app-origin';

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
 * Which web origins are the app (common/app-origin.ts): the backend's own
 * loopback origin, the Angular dev server outside production, and in LAN mode
 * private-range hosts on our port. CORS, the Socket.IO handshake and the write
 * guard all read this one policy.
 */
const originPolicy: OriginPolicy = {
  port: String(port),
  lan: lanMode,
  devServer: process.env.NODE_ENV !== 'production',
};

export const environment = {
  production: process.env.NODE_ENV === 'production',
  port: port,
  apiPrefix: 'api',

  // Whether LAN exposure is enabled, and the resulting bind host.
  lanMode,
  host: process.env.BACKEND_HOST || (lanMode ? '0.0.0.0' : '127.0.0.1'),

  originPolicy,

  // CORS configuration: only the app's own origins (see originPolicy); LAN mode
  // also drops credentialed CORS.
  cors: {
    origins: corsOriginFor(originPolicy),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // The app uses no cookie/session auth, so credentialed CORS is unnecessary;
    // it stays on only on the loopback-only path, as before.
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
