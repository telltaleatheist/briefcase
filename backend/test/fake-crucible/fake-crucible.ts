/**
 * A FAKE CRUCIBLE FOR JEST — a real `http.Server` on an ephemeral loopback
 * port, started per spec file, speaking the routes the SDK actually calls in
 * the shapes the SDK actually parses.
 *
 * A TypeScript port of BookForge's `tools/fake-crucible.js`, without its
 * Electron stub (Briefcase's Crucible code runs in NestJS and takes its paths
 * by injection). What was kept, because each one was a bug somewhere once:
 *
 *  - every route answers in the SERVER's spelling (snake_case, `key_hint`,
 *    the `{"error": {code, message, details}}` envelope), because the seam
 *    under test is the SDK reading exactly that;
 *  - auth is enforced: every route but ping and pairing needs the bearer token
 *    AND `X-Crucible-Api: 1`, and a wrong token is a 401 exactly as a real
 *    server answers it — so "bad token" can be told from "nothing there";
 *  - EVERY request is recorded (`fake.requests`) with its method, path,
 *    headers and parsed body, so a spec can assert what crossed and what did
 *    not;
 *  - one lease per server, refused `409 leased` for a second take;
 *  - a key is write-only: settings keeps it and answers with `key_hint`;
 *  - the fault layer: `refuse`, `resetAfterBytes` and `connectDelay` rules,
 *    each `{match: {method?, path?}, times?}`, plus `inject()` for the named
 *    faults the plan lists.
 *
 * Deliberately NOT here yet: uploads, jobs, SSE, chat, tasks and decide. They
 * arrive with the phases that call them (P3–P6); a route no spec drives is a
 * route whose shape nobody has checked against the SDK.
 */
import * as http from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
  at: number;
  fault?: string;
}

export interface FaultMatch {
  method?: string;
  path?: string | RegExp;
}

interface Counted {
  match?: FaultMatch;
  /** How many more times this rule fires; absent means for ever. */
  times?: number;
}

export interface RefuseRule extends Counted {
  status: number;
  code: string;
  message?: string;
  details?: unknown;
  retryAfter?: number;
}

export interface ResetRule extends Counted {
  /** Destroy the socket after this many response bytes (0 = before the status line). */
  afterBytes?: number;
}

export interface DelayRule extends Counted {
  ms: number;
  /** Destroy the socket after the delay instead of answering (default true). */
  thenDestroy?: boolean;
}

export interface FaultLayer {
  refuse?: RefuseRule[];
  resetAfterBytes?: ResetRule[];
  connectDelay?: DelayRule[];
}

/** The named faults from the migration plan (§10) that P1 drives. */
export interface NamedFaults {
  /** Every protected route answers 401 unauthorized, as for a rotated token. */
  unauthorized?: boolean;
  /** The server speaks API version 2: ping says so and protected routes answer 426. */
  apiVersion2?: boolean;
  /** The lane is held: `activity` shows this job, and a job submit would be refused. */
  serverBusy?: { client: string; type: string; progress: number; model?: string | null };
  /** Every route stalls this long before answering nothing (a sleeping machine). */
  stallMs?: number;
}

export interface FakeCrucibleOptions {
  /** What the server calls itself. Default `crucible@fake`. */
  name?: string;
  version?: string;
  backend?: string;
  platform?: string;
  arch?: string;
  /** The bearer token. Default: 43 random url-safe characters, like `crucible init`. */
  token?: string;
  /** `engine` (default) or `orchestrator`, for the one-hop rule. */
  role?: 'engine' | 'orchestrator';
  /** An orchestrator's engine, or null for an orchestrator that manages none. */
  engine?: { url: string; name?: string | null; backend?: string | null } | null;
  /** `open` (default, as `open_pairing = true`) approves at once; `approval` waits for {@link FakeCrucible.decidePairing}. */
  pairing?: 'open' | 'approval';
  /** `pairing_version` on ping; null leaves it off (an engine that predates approval pairing). */
  pairingVersion?: number | null;
  /** Seconds a device code lives. Default 600. */
  pairingExpiresIn?: number;
  /** Initial upstream configuration, e.g. `{anthropic: {key: 'sk-ant-1234'}}`. */
  upstreams?: Record<string, { key?: string; url?: string }>;
  faults?: FaultLayer;
}

export interface FakeCrucible {
  readonly url: string;
  readonly token: string;
  readonly name: string;
  readonly requests: RecordedRequest[];
  readonly faults: FaultLayer;
  readonly leases: { taken: Array<{ leaseId: string; model: string; act: unknown; ttlSeconds: unknown }>; released: string[] };
  readonly settingsPuts: unknown[];
  /** Pairing requests this server has seen, with their device codes. */
  readonly pairings: Array<{ id: string; userCode: string; clientName: string; status: 'pending' | 'approved' | 'denied' | 'expired' }>;
  /** Arm (or with `{}` clear) the named faults. */
  inject(named: NamedFaults): void;
  /** Approve or deny a pending pairing request on a server with approval pairing. */
  decidePairing(id: string, allow: boolean): void;
  /** Expire every pending pairing request. */
  expirePairings(): void;
  /** Requests whose path starts with `prefix` (and, when given, whose method matches). */
  requestsTo(prefix: string, method?: string): RecordedRequest[];
  close(): Promise<void>;
}

const UPSTREAM_NAMES = ['anthropic', 'openai', 'ollama'] as const;
const LLM_CLASSES = ['clean', 'translate', 'simplify', 'analysis'] as const;
const PUBLIC_PATHS = new Set(['/v1/ping', '/v1/pairing/start', '/v1/pairing/poll']);

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function refusal(res: http.ServerResponse, status: number, code: string, message: string, details: unknown = null, headers: Record<string, string> = {}): void {
  send(res, status, { error: { code, message, details } }, headers);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function faultMatches(rule: Counted, method: string, pathname: string): boolean {
  const m = rule.match;
  if (m === undefined) return true;
  if (m.method !== undefined && m.method !== method) return false;
  if (m.path === undefined) return true;
  if (m.path instanceof RegExp) return m.path.test(pathname);
  return pathname.startsWith(m.path);
}

function takeFault<T extends Counted>(list: T[] | undefined, method: string, pathname: string): T | null {
  if (!Array.isArray(list)) return null;
  for (const rule of list) {
    if (rule.times !== undefined && rule.times <= 0) continue;
    if (!faultMatches(rule, method, pathname)) continue;
    if (rule.times !== undefined) rule.times -= 1;
    return rule;
  }
  return null;
}

/** Wrap `res.write`/`res.end` so the socket dies after exactly `afterBytes` bytes reached it. */
function armReset(res: http.ServerResponse, afterBytes: number): void {
  if (afterBytes <= 0) {
    res.socket?.destroy();
    return;
  }
  let written = 0;
  let dead = false;
  const write = res.write.bind(res) as (chunk: Buffer) => boolean;
  const end = res.end.bind(res) as () => http.ServerResponse;
  const kill = (): void => {
    dead = true;
    res.socket?.destroy();
  };
  (res as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown): boolean => {
    if (dead) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (written + buf.length < afterBytes) {
      written += buf.length;
      return write(buf);
    }
    const room = Math.max(0, afterBytes - written);
    if (room > 0) write(buf.subarray(0, room));
    written = afterBytes;
    kill();
    return false;
  };
  (res as unknown as { end: (chunk?: unknown) => http.ServerResponse }).end = (chunk?: unknown): http.ServerResponse => {
    if (dead) return res;
    if (chunk !== undefined && typeof chunk !== 'function') {
      (res as unknown as { write: (c: unknown) => boolean }).write(chunk);
      if (dead) return res;
    }
    return end();
  };
}

export async function startFakeCrucible(options: FakeCrucibleOptions = {}): Promise<FakeCrucible> {
  const name = options.name ?? 'crucible@fake';
  const token = options.token ?? randomBytes(32).toString('base64url');
  const role = options.role ?? 'engine';
  const backend = options.backend ?? 'mlx-darwin';
  const startedAt = Date.now();
  const requests: RecordedRequest[] = [];
  const faults: FaultLayer = options.faults ?? {};
  let named: NamedFaults = {};
  const leases = { taken: [] as FakeCrucible['leases']['taken'], released: [] as string[] };
  let openLease: { leaseId: string; model: string; client: string | null; act: string } | null = null;
  let nextLease = 1;
  const settingsPuts: unknown[] = [];
  const upstreams: Record<string, { key?: string; url?: string }> = JSON.parse(JSON.stringify(options.upstreams ?? {}));
  const routes: Record<string, string> = {};
  const pairingRows = new Map<string, { id: string; deviceCode: string; userCode: string; clientName: string; status: 'pending' | 'approved' | 'denied' | 'expired'; expiresAt: number }>();
  const pairings: FakeCrucible['pairings'] = [];

  const apiVersion = (): number => (named.apiVersion2 ? 2 : 1);

  const configured = (upstream: string): boolean => {
    const u = upstreams[upstream];
    if (u === undefined) return false;
    return upstream === 'ollama' ? typeof u.url === 'string' && u.url !== '' : typeof u.key === 'string' && u.key !== '';
  };

  const infoDoc = (): unknown => ({
    server: { name, version: options.version ?? '1.0.23', api_version: apiVersion() },
    role,
    ...(role === 'engine'
      ? { managed_by: null }
      : {
          engine: options.engine === undefined || options.engine === null
            ? null
            : { name: options.engine.name ?? null, url: options.engine.url, backend: options.engine.backend ?? null, owner: 'host' },
        }),
    host: {
      platform: options.platform ?? 'darwin',
      arch: options.arch ?? 'arm64',
      backend: role === 'orchestrator' ? 'orchestrator' : backend,
      gpu: { vendor: 'apple', name: 'Fake M1 Ultra', vram_bytes: 68719476736 },
    },
    job_types: role === 'orchestrator' ? [] : ['asr', 'echo', 'load-model', 'unload-model'],
    capabilities: [],
  });

  const activityDoc = (): unknown => {
    const busy = named.serverBusy;
    const job = busy === undefined ? null : {
      job_id: 'job-held',
      type: busy.type,
      model: busy.model ?? null,
      status: 'running',
      position: null,
      progress: busy.progress,
      message: null,
      created: '2026-09-23T01:00:00Z',
      started: '2026-09-23T01:00:01Z',
      client: busy.client,
    };
    return {
      server: { name, version: options.version ?? '1.0.23', api_version: apiVersion(), backend, uptime_s: Math.round((Date.now() - startedAt) / 1000) },
      resident: null,
      stopping: null,
      warming: null,
      claim: null,
      streaming: null,
      lease: null,
      chat: { in_flight: 0, max_in_flight: null, max_in_flight_basis: null, rows: [] },
      slots: { accelerated: { busy: job === null ? 0 : 1, of: 1, queue_depth: 0, accepts_work: job === null } },
      running: job === null ? [] : [job],
      queued: [],
    };
  };

  const settingsDoc = (): unknown => {
    const routeDoc: Record<string, unknown> = {};
    for (const c of LLM_CLASSES) {
      const value = routes[c];
      routeDoc[c] = value === undefined ? { route: 'local', model: 'qwen3.5-9b' } : { route: 'upstream', model: value };
    }
    const upstreamDoc: Record<string, unknown> = {};
    for (const up of UPSTREAM_NAMES) {
      const u = upstreams[up];
      upstreamDoc[up] = up === 'ollama'
        ? { configured: configured(up), url: u?.url ?? null }
        : { configured: configured(up), key_hint: configured(up) ? `…${String(u?.key).slice(-4)}` : null };
    }
    const localModels: Record<string, string | null> = {};
    const choices: Record<string, unknown[]> = {};
    for (const c of LLM_CLASSES) {
      localModels[c] = 'qwen3.5-9b';
      choices[c] = [{ id: 'qwen3.5-9b', memory_bytes_estimate: 20950548480, fits: true, installed: true }];
    }
    return {
      routes: routeDoc,
      upstreams: upstreamDoc,
      local_models: localModels,
      local_model_choices: choices,
      desktop_allowance_bytes: 3221225472,
      backend_kind: backend,
    };
  };

  const capabilityDoc = (): unknown => ({
    backend_kind: backend,
    total_bytes: 68719476736,
    desktop_allowance_bytes: 3221225472,
    classes: [
      ...LLM_CLASSES.map((c) => ({
        capability: c,
        enabled: true,
        selected: routes[c] ?? 'qwen3.5-9b',
        reason: routes[c] ? `routed to ${routes[c].split('/')[0]}` : 'qwen3.5-9b fits',
        shortfall_bytes: 0,
        route: routes[c] ? 'upstream' : 'local',
      })),
      { capability: 'asr', enabled: true, selected: 'mlx-whisper-large-v3-turbo', reason: 'installed', shortfall_bytes: 0, route: 'local' },
    ],
  });

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) refusal(res, 500, 'fake_crashed', String((err as Error)?.stack ?? err));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const record: RecordedRequest = { method, path, headers: req.headers, at: Date.now() };
    requests.push(record);

    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    if (raw.length > 0) {
      try {
        record.body = JSON.parse(raw.toString('utf-8'));
      } catch {
        record.body = raw.toString('utf-8');
      }
    }
    const body = (record.body ?? {}) as Record<string, unknown>;

    // ── the fault layer, before any route ────────────────────────────────
    if (named.stallMs !== undefined) {
      record.fault = `stall ${named.stallMs} ms`;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, named.stallMs);
        req.on('close', () => { clearTimeout(t); resolve(); });
        res.on('close', () => { clearTimeout(t); resolve(); });
      });
      res.socket?.destroy();
      return;
    }
    const reset = takeFault(faults.resetAfterBytes, method, path);
    if (reset) {
      record.fault = `reset after ${reset.afterBytes ?? 0} byte(s)`;
      armReset(res, reset.afterBytes ?? 0);
      if ((reset.afterBytes ?? 0) <= 0) return;
    }
    const delay = takeFault(faults.connectDelay, method, path);
    if (delay) {
      record.fault = `no answer for ${delay.ms} ms`;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay.ms);
        res.on('close', () => { clearTimeout(t); resolve(); });
      });
      if (res.writableEnded || res.destroyed) return;
      if (delay.thenDestroy !== false) {
        res.socket?.destroy();
        return;
      }
    }
    const refuseRule = takeFault(faults.refuse, method, path);
    if (refuseRule) {
      record.fault = `${refuseRule.status} ${refuseRule.code}`;
      refusal(res, refuseRule.status, refuseRule.code, refuseRule.message ?? refuseRule.code, refuseRule.details ?? null,
        refuseRule.retryAfter === undefined ? {} : { 'Retry-After': String(refuseRule.retryAfter) });
      return;
    }

    // ── public routes ────────────────────────────────────────────────────
    if (path === '/v1/ping' && method === 'GET') {
      send(res, 200, {
        crucible: true,
        name,
        api_version: apiVersion(),
        ...(options.pairingVersion === null ? {} : { pairing_version: options.pairingVersion ?? 1 }),
      });
      return;
    }
    if (path === '/v1/pairing/start' && method === 'POST') {
      const id = `pair-${pairingRows.size + 1}`;
      const row = {
        id,
        deviceCode: randomBytes(16).toString('hex'),
        userCode: `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`,
        clientName: String(body['client_name'] ?? ''),
        status: (options.pairing === 'approval' ? 'pending' : 'approved') as 'pending' | 'approved',
        expiresAt: Date.now() + (options.pairingExpiresIn ?? 600) * 1000,
      };
      pairingRows.set(id, row);
      pairings.push({ id, userCode: row.userCode, clientName: row.clientName, status: row.status });
      send(res, 200, {
        name,
        id,
        device_code: row.deviceCode,
        user_code: row.userCode,
        expires_in: options.pairingExpiresIn ?? 600,
        interval: 1,
        approval_required: options.pairing === 'approval',
      });
      return;
    }
    if (path === '/v1/pairing/poll' && method === 'POST') {
      const row = pairingRows.get(String(body['id']));
      if (row === undefined || row.deviceCode !== body['device_code']) {
        refusal(res, 404, 'unknown_pairing', 'no such pairing request');
        return;
      }
      if (row.status === 'pending' && Date.now() >= row.expiresAt) row.status = 'expired';
      const shown = pairings.find((p) => p.id === row.id);
      if (shown) shown.status = row.status;
      if (row.status === 'approved') {
        send(res, 200, { status: 'approved', name, token });
        return;
      }
      send(res, 200, { status: row.status });
      return;
    }

    // ── everything else is protected ─────────────────────────────────────
    if (!PUBLIC_PATHS.has(path)) {
      const auth = req.headers['authorization'];
      if (named.unauthorized || auth !== `Bearer ${token}`) {
        refusal(res, 401, 'unauthorized', 'missing or invalid bearer token');
        return;
      }
      if (req.headers['x-crucible-api'] !== String(apiVersion())) {
        refusal(res, 426, 'api_version_mismatch', `this server speaks API version ${apiVersion()}`,
          { server_api_version: apiVersion(), client_api_version: Number(req.headers['x-crucible-api']) || null });
        return;
      }
    }

    if (path === '/v1/info' && method === 'GET') {
      send(res, 200, infoDoc());
      return;
    }
    if (path === '/v1/health' && method === 'GET') {
      send(res, 200, {
        status: named.serverBusy ? 'busy' : 'ok',
        queue_depth: 0,
        resident_models: [],
        resident_kind: null,
        stopping: null,
      });
      return;
    }
    if (path === '/v1/activity' && method === 'GET') {
      send(res, 200, activityDoc());
      return;
    }
    if (path === '/v1/capability' && method === 'GET') {
      send(res, 200, capabilityDoc());
      return;
    }
    if (path === '/v1/settings' && method === 'GET') {
      send(res, 200, settingsDoc());
      return;
    }
    if (path === '/v1/settings' && method === 'PUT') {
      settingsPuts.push(body);
      const ups = (body['upstreams'] ?? {}) as Record<string, { key?: string; url?: string } | null>;
      for (const up of Object.keys(ups)) {
        const value = ups[up];
        if (value === null) delete upstreams[up];
        else upstreams[up] = { ...(upstreams[up] ?? {}), ...value };
      }
      const rts = (body['routes'] ?? {}) as Record<string, string>;
      for (const cls of Object.keys(rts)) {
        if (!(LLM_CLASSES as readonly string[]).includes(cls)) {
          refusal(res, 400, 'route_not_routable', `the "${cls}" class is not routable`, { field: `routes.${cls}` });
          return;
        }
        const value = rts[cls];
        if (value === 'local') { delete routes[cls]; continue; }
        const upstream = String(value).split('/')[0];
        if (!configured(upstream)) {
          refusal(res, 400, 'route_upstream_unconfigured', `${upstream} has no key`, { field: `upstreams.${upstream}.key` });
          return;
        }
        routes[cls] = value;
      }
      send(res, 200, settingsDoc());
      return;
    }
    const test = /^\/v1\/settings\/upstreams\/([^/]+)\/test$/.exec(path);
    if (test && method === 'POST') {
      const upstream = decodeURIComponent(test[1]);
      const probed = (typeof body['key'] === 'string' && body['key'] !== '') || (typeof body['url'] === 'string' && body['url'] !== '');
      if (!probed && !configured(upstream)) {
        refusal(res, 400, 'upstream_unconfigured', `${upstream} has nothing configured and the test carried nothing`);
        return;
      }
      send(res, 200, { models: [`${upstream}-model-a`, `${upstream}-model-b`] });
      return;
    }
    if (path === '/v1/models' && method === 'GET') {
      send(res, 200, [{
        id: 'qwen3.5-9b', family: 'qwen3.5', params_b: 9, revision: 'abc1234', fingerprint: 'qwen3.5-9b@abc1234',
        modalities: ['text'], backend_supported: true, installed: true, resident: false, loadable: true, reason: null,
        memory_bytes_estimate: 20950548480, context_default: 32768, max_model_len: 262144,
      }]);
      return;
    }

    // ── leases: one per server ───────────────────────────────────────────
    const take = /^\/v1\/models\/([^/]+)\/lease$/.exec(path);
    if (take && method === 'POST') {
      const model = decodeURIComponent(take[1]);
      if (openLease !== null) {
        refusal(res, 409, 'leased', `'${openLease.model}' is leased by '${openLease.client}' for '${openLease.act}'`, {
          lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
          since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
        });
        return;
      }
      const leaseId = `lease-${nextLease++}`;
      const client = (req.headers['x-crucible-client'] as string | undefined) ?? null;
      openLease = { leaseId, model, client, act: String(body['act'] ?? '') };
      leases.taken.push({ leaseId, model, act: body['act'], ttlSeconds: body['ttl_seconds'] });
      send(res, 201, {
        lease_id: leaseId, subject: model, kind: 'llm', client, act: body['act'] ?? null,
        since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
      });
      return;
    }
    const beat = /^\/v1\/leases\/([^/]+)\/heartbeat$/.exec(path);
    if (beat && method === 'POST') {
      const leaseId = decodeURIComponent(beat[1]);
      if (openLease === null || openLease.leaseId !== leaseId) {
        refusal(res, 404, 'unknown_lease', `lease ${leaseId} is no longer open`, { lease_id: leaseId });
        return;
      }
      send(res, 200, { expires_at: '2026-09-23T01:04:00+00:00' });
      return;
    }
    const give = /^\/v1\/leases\/([^/]+)$/.exec(path);
    if (give && method === 'DELETE') {
      const leaseId = decodeURIComponent(give[1]);
      leases.released.push(leaseId);
      if (openLease === null || openLease.leaseId !== leaseId) {
        refusal(res, 404, 'unknown_lease', `lease ${leaseId} is no longer open`, { lease_id: leaseId });
        return;
      }
      openLease = null;
      res.writeHead(204);
      res.end();
      return;
    }

    refusal(res, 404, 'not_found', `${method} ${path}`);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    name,
    requests,
    faults,
    leases,
    settingsPuts,
    pairings,
    inject(next: NamedFaults): void {
      named = { ...next };
    },
    decidePairing(id: string, allow: boolean): void {
      const row = pairingRows.get(id);
      if (row === undefined) throw new Error(`fake-crucible: no pairing request ${id}`);
      row.status = allow ? 'approved' : 'denied';
      const shown = pairings.find((p) => p.id === id);
      if (shown) shown.status = row.status;
    },
    expirePairings(): void {
      for (const row of pairingRows.values()) {
        if (row.status === 'pending') row.status = 'expired';
      }
      for (const shown of pairings) if (shown.status === 'pending') shown.status = 'expired';
    },
    requestsTo(prefix: string, m?: string): RecordedRequest[] {
      return requests.filter((r) => r.path.startsWith(prefix) && (m === undefined || r.method === m));
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** Something that answers HTTP and is not a Crucible — a router's admin page, say. */
export async function startNotCrucible(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Router admin</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** A loopback port with nothing listening on it. */
export async function unusedLoopbackUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
