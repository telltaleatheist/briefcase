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
 * P2 adds the operator side coordination reads and writes: `GET /v1/catalog`,
 * and `POST /v1/tasks {type: "module"}` with `GET /v1/tasks`, `/v1/tasks/{id}`
 * and the task SSE stream. A module is validated the way the server's
 * `validate_module` does it (an unknown key, such as the generated `backends`,
 * is `invalid_module`; a subject this backend's catalog does not list is
 * `unknown_subject`), and a finished module installs what it named, so the
 * next coordination read finds it stocked.
 *
 * P3 adds the LLM side: `GET /v1/models` from a configurable list with ONE
 * resident model, `load-model` jobs (`POST /v1/jobs`, `GET /v1/jobs/{id}`, the
 * job SSE stream with ids, `DELETE /v1/jobs/{id}`) that make a model resident
 * and take a lease on load when asked, leases that need a resident model, and
 * `POST /v1/openai/chat/completions`: residency enforced for local models
 * (`409 model_not_resident`), upstream prefixes forwarded only when that
 * upstream is configured (`409 upstream_unconfigured`), canned replies per
 * model, `X-Crucible-Sampling` on every answer, and a `chatDelayMs` fault a
 * cancel can land in. `chat_queue_full` + `Retry-After` is a `refuse` rule.
 *
 * P5 adds transcription: `POST /v1/uploads` (multipart, the `file` part, the
 * blob kept with its filename and sha256), `asr` jobs validated the way the
 * server does it (exactly `language`, `vad_filter`, `word_timestamps`; a model
 * this backend's engine serves and has installed; `vad_filter: true` refused
 * for mlx-whisper; exactly one input naming an uploaded blob), progress frames
 * with `{stage, processed_s, total_s, cues}` (decoding first, driving no
 * fraction), `done {artifacts: ['transcript.json']}` and the artifact itself.
 * A running asr job can be held mid-file until it is DELETEd (cooperative
 * cancel). `/v1/info` lists asr rows for BOTH engines, as a live mlx-darwin
 * server does, the other engine's uninstalled with an empty revision.
 *
 * P6 adds `POST /v1/decide` (PHASE22): the door's refusals in its order
 * (act, unknown keys, model, upstream, missing mode, too many options,
 * residency, the engine's option cap as `503 decide_not_served`), then one
 * reading per question from `decideProbs` (raw probabilities; an option left
 * out is outside the top-K), renormalised over the labels returned, with
 * `logprobs`, `label_mass` and — in report mode only — `missing_labels`.
 * Load-model takes `params.context` (refused `context_over_limit` above the
 * ceiling), `/v1/capability` carries `work`, `context_ceilings`, the
 * `generate` and `decide` classes and the `?class=&context_tokens=` sizing,
 * and an `ollama/` chat answers `X-Crucible-Context` on 1.0.24+.
 *
 * 1.0.25 ("any Crucible that answers works") makes the SDK read every
 * INFORMATIONAL field as null when a server leaves it out. `omit` (see
 * {@link INFORMATIONAL_FIELDS}) strips named fields from this fake's answers —
 * JSON bodies and SSE frames alike — so a spec can play an older or leaner
 * server and pin what Briefcase does with each absence.
 */
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
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
  /**
   * The operator door's `409 server_busy`: a task post is refused with the
   * holder named (`CrucibleCardHeld`), and `activity` says the card does not
   * accept work. `times` counts the refusals (absent: until cleared).
   */
  cardHeld?: { fact: string; who: string; times?: number };
  /** Another app's task is running: posts are refused `task_busy`, and it lists as running. */
  taskBusy?: { type: string; finishAfterMs?: number };
  /** Every chat completion waits this long before answering (a cancel can land in it). */
  chatDelayMs?: number;
  /** A load-model job fails with this code and message. */
  failLoadWith?: { code: string; message: string };
  /** Load jobs stay `running` until DELETEd (a kill mid-load, for the sweep specs). */
  holdLoads?: boolean;
}

/** One `GET /v1/models` row, in the SDK's camelCase; served snake_case. */
export interface FakeModel {
  id: string;
  paramsB: number;
  installed?: boolean;
  backendSupported?: boolean;
  modalities?: string[];
  contextDefault?: number;
  maxModelLen?: number | null;
  /** Set: not loadable, with this reason. */
  unloadableReason?: string;
  /** The manifest family; default the id up to its first dash. */
  family?: string;
  /** 1.0.24: the base whose weights this alias shares (`weights_of`). */
  weightsOf?: string | null;
}

/** A canned chat reply: fixed content, or computed from the request body. */
export type FakeChatReply =
  | string
  | { content?: string; reasoning?: string; finishReason?: string }
  | ((body: Record<string, unknown>) => string | { content?: string; reasoning?: string; finishReason?: string });

/** A job this fake ran, for a spec to assert on. */
export interface FakeJob {
  jobId: string;
  type: string;
  model: string | null;
  params: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  leaseId: string | null;
  events: Array<{ id: number; event: string; data: Record<string, unknown> }>;
  client: string | null;
  /** The job's inputs as posted: name → blob id (asr). */
  inputs?: Record<string, string>;
  /** The submit's `client_ref`, as the server keeps it. */
  clientRef?: string | null;
  /** Artifacts a done job wrote: name → bytes (asr's `transcript.json`). */
  artifacts?: Record<string, Buffer>;
}

/** One upload the fake received. */
export interface FakeUpload {
  blobId: string;
  filename: string;
  bytes: number;
  sha256: string;
}

/** How an asr job runs on this fake. */
export interface FakeAsrScript {
  /** Milliseconds between frames. Default 5. */
  stepMs?: number;
  /** `stage: decoding` frames before transcription starts. Default 2. */
  decodeFrames?: number;
  /** `stage: transcribing` frames. Default 4. */
  transcribeFrames?: number;
  /** The media's length in seconds, as `total_s`. Default 3600. */
  totalS?: number;
  /** The transcript.json document written on done. Default: {@link defaultFakeTranscript}. */
  transcript?: unknown;
  /** The job fails after the decode frames with this `{code, message}`. */
  failWith?: { code: string; message: string };
  /** Stop after this many transcribe frames, running, until DELETEd (a cancel mid-file). */
  holdAfterFrames?: number;
}

/** A small transcript.json in absolute time, as an mlx-whisper asr job writes it. */
export function defaultFakeTranscript(model = 'mlx-whisper-large-v3'): Record<string, unknown> {
  return {
    model,
    revision: '49e6aa286ad60c14352c404340ded53710378a11',
    language: 'en',
    language_requested: 'auto',
    duration_s: 3600,
    segments: [
      { start: 0.0, end: 4.2, text: ' Welcome back to the show.' },
      { start: 4.2, end: 9.8, text: ' Today we are talking about the news.' },
      { start: 3605.5, end: 3610.25, text: ' Thanks for watching.' },
    ],
  };
}

/** The asr ids a live server lists for each backend (crucible/asrmodels.py). */
const ASR_SIZES = ['base', 'distil-large-v3', 'large-v3', 'large-v3-turbo', 'medium', 'small', 'tiny'];

/** One catalog row, in the SDK's camelCase; served snake_case. */
export interface FakeCatalogRow {
  kind: 'model' | 'voice' | 'rvc' | 'rvc-base' | 'denoise' | 'engine';
  id: string;
  name?: string | null;
  jobType: string;
  installed: boolean;
  expectedBytes?: number | null;
  /** 1.0.24: an alias's base (`shares_weights_of`). */
  sharesWeightsOf?: string | null;
  /** 1.0.24: an alias's own files still to download. */
  missingFiles?: string[] | null;
}

/** A task this fake has run, for a spec to assert on. */
export interface FakeTask {
  taskId: string;
  type: string;
  request: Record<string, unknown>;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  events: Array<{ id: number; event: string; data: Record<string, unknown> }>;
  unmet: Array<{ class: string; reason: string }>;
}

/**
 * Fields to leave out of this fake's answers, by route: `"GET /v1/models"`,
 * `"GET /v1/jobs/:id"`, `"POST /v1/decide"`, … and, for SSE frames,
 * `"job-event:<event>"` / `"task-event:<event>"`. Each path is dotted wire
 * (snake_case) keys: `a.b` descends, `a[]` is every element of array `a`, `[]`
 * alone every element of a root array, and `*` every value of an object.
 */
export type FieldOmissions = Readonly<Record<string, readonly string[]>>;

/**
 * Every field `@crucible/client` 1.0.25 reads as INFORMATIONAL (null when
 * absent) on the routes Briefcase calls — what a leaner or older server may
 * leave out without the SDK refusing it. Load-bearing fields (ids, states,
 * decide answers, resident/loadable/modalities, capability enabled/selected,
 * chat content) are never here. Some are load-bearing to one of Briefcase's
 * paths ("informational to the read, load-bearing to YOUR path"): `host.backend`
 * / `backend_kind` (the module is filtered to them), chat
 * `usage.prompt_tokens` (countTokens) and a model's context (analysis sizing)
 * are refused by name there; decide `logprobs` is read from `probabilities`.
 * Keep any back with {@link informationalExcept}.
 */
export const INFORMATIONAL_FIELDS: FieldOmissions = {
  'GET /v1/info': ['server.version', 'host.platform', 'host.arch', 'host.backend', 'host.gpu',
    'capabilities[].models[].revision', 'capabilities[].models[].source', 'capabilities[].models[].vram_bytes'],
  'GET /v1/activity': ['server.version', 'server.api_version', 'server.backend', 'server.uptime_s',
    'resident.since', 'resident.memory_bytes_estimate', 'chat', 'slots.accelerated.busy', 'slots.accelerated.of',
    'slots.accelerated.queue_depth', 'running[].progress', 'running[].created', 'queued[].progress', 'queued[].created',
    'lease.since', 'lease.expires_at'],
  'GET /v1/models': ['[].family', '[].params_b', '[].revision', '[].fingerprint', '[].backend_supported', '[].installed',
    '[].reason', '[].memory_bytes_estimate', '[].context_default', '[].max_model_len'],
  'GET /v1/capability': ['backend_kind', 'total_bytes', 'desktop_allowance_bytes', 'classes[].reason',
    'classes[].shortfall_bytes', 'classes[].work', 'classes[].context_ceilings'],
  'GET /v1/settings': ['local_models', 'local_model_choices', 'desktop_allowance_bytes', 'backend_kind'],
  'POST /v1/uploads': ['bytes', 'sha256'],
  'GET /v1/jobs/:id': ['progress', 'created'],
  'GET /v1/tasks/:id': ['request', 'created', 'started', 'finished'],
  'POST /v1/decide': ['model', 'engine', 'timing_ms', 'tokens', 'answers.*.confidence', 'answers.*.logprobs'],
  'POST /v1/openai/chat/completions': ['id', 'model', 'usage'],
  'job-event:queued': ['position'],
  'job-event:warming': ['message'],
  'job-event:progress': ['fraction', 'message'],
  'task-event:step': ['name', 'index', 'total'],
  'task-event:progress': ['bytes_total', 'file'],
  'task-event:skipped': ['reason'],
};

/** {@link INFORMATIONAL_FIELDS} less the paths in `keep` (route → paths still sent). */
export function informationalExcept(keep: FieldOmissions): FieldOmissions {
  const out: Record<string, readonly string[]> = {};
  for (const [route, paths] of Object.entries(INFORMATIONAL_FIELDS)) {
    const kept = new Set(keep[route] ?? []);
    out[route] = paths.filter((p) => !kept.has(p));
  }
  return out;
}

/** Delete one dotted path (see {@link FieldOmissions}) from a parsed document, in place. */
function omitPath(doc: unknown, segments: readonly string[]): void {
  if (segments.length === 0 || doc === null || typeof doc !== 'object') return;
  const [head, ...rest] = segments;
  if (head === '[]') {
    if (Array.isArray(doc)) for (const item of doc) omitPath(item, rest);
    return;
  }
  if (head === '*') {
    for (const value of Object.values(doc as Record<string, unknown>)) omitPath(value, rest);
    return;
  }
  const isArray = head.endsWith('[]');
  const key = isArray ? head.slice(0, -2) : head;
  const record = doc as Record<string, unknown>;
  if (!(key in record)) return;
  if (rest.length === 0 && !isArray) {
    delete record[key];
    return;
  }
  const next = record[key];
  if (isArray) {
    if (Array.isArray(next)) for (const item of next) omitPath(item, rest);
  } else {
    omitPath(next, rest);
  }
}

function omitAll(doc: unknown, paths: readonly string[] | undefined): unknown {
  if (paths === undefined || paths.length === 0) return doc;
  for (const p of paths) omitPath(doc, p.split('.'));
  return doc;
}

/** The {@link FieldOmissions} key for a request: its method and path, ids as `:id`. */
function routeKey(method: string, path: string): string {
  const generic = path
    .replace(/^\/v1\/jobs\/[^/]+$/, '/v1/jobs/:id')
    .replace(/^\/v1\/tasks\/[^/]+$/, '/v1/tasks/:id');
  return `${method} ${generic}`;
}

export interface FakeCrucibleOptions {
  /** Fields left out of every answer (1.0.25's informational fields, say): see {@link FieldOmissions}. */
  omit?: FieldOmissions;
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
  /**
   * The job types whose environments are installed: `info.capabilities`.
   * Default `['echo']`, a bare service as `install({jobTypes: ['echo']})` leaves it.
   */
  installedJobTypes?: string[];
  /** This backend's catalog. Default: the analysis model and the mlx whisper, neither installed. */
  catalog?: FakeCatalogRow[];
  /** A class the capability record switches off, with the engine's reason. */
  disabledClasses?: Record<string, string>;
  /** A module task fails at this step, with this code, instead of finishing. */
  failModuleWith?: { code: string; message: string };
  /** What `GET /v1/models` lists. Default: `qwen3.5-9b`, installed. */
  models?: FakeModel[];
  /** The model resident at start. Default none. */
  resident?: string | null;
  /** How long a load-model job takes. Default 20 ms. */
  loadMs?: number;
  /** What an upstream test lists, per upstream. Default `<upstream>-model-a`, `<upstream>-model-b`. */
  upstreamModels?: Record<string, string[]>;
  /** Canned chat replies by model string (`qwen3.5-9b`, `anthropic/claude-x`); `*` for any. */
  chatReplies?: Record<string, FakeChatReply>;
  /**
   * The asr models this backend's engine has INSTALLED. Default: the catalog's
   * installed asr rows. Every other size of this backend's engine, and every
   * size of the other engine, is listed uninstalled.
   */
  asrInstalled?: string[];
  /** How asr jobs run. */
  asr?: FakeAsrScript;
  /**
   * P6: how `/v1/decide` reads a question. Returns each option's RAW
   * next-token probability (full vocabulary), keyed by option name (a level,
   * or `Yes`/`No`); an option left out is outside the engine's top-K. Default:
   * the first option 0.6, the rest sharing 0.35.
   */
  decideProbs?: FakeDecideProbs;
  /** P6: the most options this engine's top-K can read; more is `503 decide_not_served`. Default 26. */
  decideMaxOptions?: number;
  /** P6: what the `decide` capability class selected. Default `qwen3.5-9b`. */
  decideSelected?: string;
  /** P6: each candidate's context ceiling for `?class=generate`, by model id. Default 131072 each. */
  contextCeilings?: Record<string, number>;
}

/** One decide question as the fake reads it. */
export interface FakeDecideQuestion {
  name: string;
  type: 'choice' | 'score' | 'yesno';
  instructions: string;
  /** Option names (choice), levels (score), or `['Yes', 'No']`. */
  labels: string[];
  /** A choice's option descriptions, in option order. */
  descriptions?: string[];
}

export type FakeDecideProbs = (question: FakeDecideQuestion, state: unknown) => Record<string, number>;

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
  /** Every task posted to this fake (module tasks), oldest first. */
  readonly tasks: FakeTask[];
  /** The catalog as it stands (a finished module marks rows installed). */
  readonly catalog: FakeCatalogRow[];
  /** The installed job types as they stand. */
  readonly installedJobTypes: string[];
  /** Every job posted, oldest first. */
  readonly jobs: FakeJob[];
  /** The model on the card now, or null. */
  resident(): string | null;
  /** Put a model on the card (or none), as another client's load would. Drops any lease on the old one. */
  setResident(model: string | null): void;
  /** Expire the open lease, as a missed heartbeat would. */
  expireLease(): void;
  /** The lease open now, if any. */
  openLease(): { leaseId: string; model: string; client: string | null; act: string } | null;
  /** Hold the card with another client's lease on `model` (which becomes resident). */
  leaseAsOther(model: string, client: string): void;
  /** Bodies of every chat completion posted, in order. */
  chatBodies(): Array<Record<string, unknown>>;
  /** Every upload received, oldest first. */
  readonly uploads: FakeUpload[];
  /** Blobs still in `uploads/` (not yet consumed by a job). */
  heldBlobs(): string[];
  /** Drop every unconsumed blob, as a server restart that cleaned `uploads/` would. */
  forgetBlobs(): void;
  /** Change how the next asr jobs run. */
  setAsr(script: FakeAsrScript): void;
  /** P6: change how `/v1/decide` reads questions. */
  setDecideProbs(fn: FakeDecideProbs | undefined): void;
  /** P6: bodies of every `/v1/decide` posted, in order. */
  decideBodies(): Array<Record<string, unknown>>;
  /** P6: the context the resident model was loaded at (null: its default). */
  residentContext(): number | null;
  /** Change which fields the next answers leave out (`{}`: none). */
  setOmit(omit: FieldOmissions): void;
  close(): Promise<void>;
}

/** The default catalog of a fresh mlx-darwin engine. */
export function defaultFakeCatalog(): FakeCatalogRow[] {
  return [
    { kind: 'model', id: 'qwen3.5-9b', name: 'Qwen3.5 9B', jobType: 'llm', installed: false, expectedBytes: null },
    { kind: 'model', id: 'mlx-whisper-large-v3', name: 'Whisper large-v3 (MLX)', jobType: 'asr', installed: false, expectedBytes: null },
    { kind: 'model', id: 'mlx-whisper-large-v3-turbo', name: 'Whisper large-v3 turbo (MLX)', jobType: 'asr', installed: false, expectedBytes: null },
  ];
}

/** Every job type and subject a catalog/info pair needs for Briefcase's module to read as stocked on mlx-darwin. */
export function stockedForBriefcase(): { installedJobTypes: string[]; catalog: FakeCatalogRow[] } {
  return {
    installedJobTypes: ['echo', 'llm', 'asr'],
    catalog: defaultFakeCatalog().map((row) => ({ ...row, installed: row.id !== 'mlx-whisper-large-v3-turbo' })),
  };
}

const UPSTREAM_NAMES = ['anthropic', 'openai', 'ollama'] as const;
const LLM_CLASSES = ['clean', 'translate', 'simplify', 'analysis'] as const;
const PUBLIC_PATHS = new Set(['/v1/ping', '/v1/pairing/start', '/v1/pairing/poll']);

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Numeric version compare for the fake's own gates. */
function compareFakeVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The fake's token count for a chat: 10 for the template, plus one per
 * whitespace-separated word of every message (a stand-in tokenizer a spec can
 * compute by hand).
 */
export function promptTokensOf(body: Record<string, unknown>): number {
  const messages = Array.isArray(body['messages']) ? body['messages'] as Array<Record<string, unknown>> : [];
  let words = 0;
  for (const m of messages) {
    const text = typeof m['content'] === 'string' ? m['content'] : '';
    words += text.split(/\s+/).filter(Boolean).length;
  }
  return 10 + words;
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
  const installedJobTypes: string[] = [...(options.installedJobTypes ?? ['echo'])];
  const catalog: FakeCatalogRow[] = (options.catalog ?? defaultFakeCatalog()).map((row) => ({ ...row }));
  const tasks: FakeTask[] = [];
  const taskListeners = new Map<string, Set<() => void>>();
  let nextTask = 1;
  const disabledClasses = options.disabledClasses ?? {};
  let omit: FieldOmissions = options.omit ?? {};
  const models: FakeModel[] = (options.models ?? [{ id: 'qwen3.5-9b', paramsB: 9, installed: true }]).map((m) => ({ ...m }));
  let resident: string | null = options.resident ?? null;
  /** The context the resident model was loaded with (`params.context`); null: its default. */
  let residentCtx: number | null = null;
  let decideProbs: FakeDecideProbs | undefined = options.decideProbs;
  const jobs: FakeJob[] = [];
  const jobListeners = new Map<string, Set<() => void>>();
  let nextJob = 1;
  const uploads: FakeUpload[] = [];
  const blobs = new Map<string, { filename: string; data: Buffer }>();
  const consumedBlobs = new Map<string, string>();
  let asrScript: FakeAsrScript = { ...(options.asr ?? {}) };
  const asrEngine = backend === 'cuda-linux' ? 'faster-whisper' : 'mlx-whisper';
  const asrInstalled = (): Set<string> => new Set(options.asrInstalled
    ?? catalog.filter((row) => row.jobType === 'asr' && row.installed).map((row) => row.id));
  const asrRows = (): Array<Record<string, unknown>> => {
    const installed = asrInstalled();
    const rows: Array<Record<string, unknown>> = [];
    for (const engine of ['faster-whisper', 'mlx-whisper']) {
      for (const size of ASR_SIZES) {
        if (engine === 'faster-whisper' && size === 'large-v3-turbo') continue;
        const id = `${engine}-${size}`;
        const served = engine === asrEngine;
        rows.push({
          id, revision: served ? 'f'.repeat(40) : '', source: served ? `hf:fake/${id}` : '',
          installed: served && installed.has(id), resident: false, vram_bytes: served ? 1_000_000_000 : 0,
        });
      }
    }
    return rows;
  };

  const apiVersion = (): number => (named.apiVersion2 ? 2 : 1);

  const configured = (upstream: string): boolean => {
    const u = upstreams[upstream];
    if (u === undefined) return false;
    return upstream === 'ollama' ? typeof u.url === 'string' && u.url !== '' : typeof u.key === 'string' && u.key !== '';
  };

  const infoDoc = (): unknown => ({
    server: { name, version: options.version ?? '1.0.24', api_version: apiVersion() },
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
    job_types: role === 'orchestrator' ? [] : [...installedJobTypes, 'load-model', 'unload-model'],
    capabilities: role === 'orchestrator' ? [] : installedJobTypes.map((jobType) => ({ job_type: jobType, models: jobType === 'asr' ? asrRows() : [] })),
  });

  const activityDoc = (): unknown => {
    const busy = named.serverBusy;
    // P4: this fake's own jobs still on the lane, as the sweep and the
    // preflight read them (a load in progress, a job nobody cancelled).
    const ownJob = (j: FakeJob): Record<string, unknown> => ({
      job_id: j.jobId, type: j.type, model: j.model, status: j.status, position: j.status === 'queued' ? 0 : null,
      progress: 0, message: null, created: '2026-09-23T01:00:00Z', started: j.status === 'running' ? '2026-09-23T01:00:01Z' : null,
      client: j.client,
    });
    const ownRunning = jobs.filter((j) => j.status === 'running').map(ownJob);
    const ownQueued = jobs.filter((j) => j.status === 'queued').map(ownJob);
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
      server: { name, version: options.version ?? '1.0.24', api_version: apiVersion(), backend, uptime_s: Math.round((Date.now() - startedAt) / 1000) },
      resident: resident === null ? null : {
        kind: 'llm', id: resident, since: '2026-09-23T01:00:00Z', memory_bytes_estimate: null,
        held_by: openLease === null ? null : {
          fact: 'a lease', who: openLease.client ?? 'unknown',
          details: { lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act, since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00' },
        },
        unclaimed_since: openLease === null ? '2026-09-23T01:00:00Z' : null,
      },
      stopping: null,
      warming: null,
      claim: null,
      streaming: null,
      lease: openLease === null ? null : {
        lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
        since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
      },
      chat: { in_flight: 0, max_in_flight: null, max_in_flight_basis: null, rows: [] },
      slots: {
        accelerated: {
          busy: job === null && ownRunning.length === 0 ? 0 : 1, of: 1, queue_depth: ownQueued.length,
          accepts_work: job === null && ownRunning.length === 0 && openLease === null && (named.cardHeld === undefined || named.cardHeld.times === 0),
        },
      },
      running: [...(job === null ? [] : [job]), ...ownRunning],
      queued: ownQueued,
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

  const work = (tokens: number, concurrency: number, from: 'default' | 'request' = 'default'): Record<string, unknown> =>
    ({ tokens, concurrency, source: 'fake', from });
  const ceilings = (concurrency: number): unknown[] => models
    .filter((m) => m.backendSupported !== false && (m.modalities ?? ['text']).includes('text') && m.weightsOf == null && !/^dots/.test(m.id))
    .map((m) => {
      const tokens = options.contextCeilings?.[m.id] ?? 131072;
      return { model: m.id, tokens, bound_by: 'served', served_context: tokens, memory_context: null, concurrency };
    });
  const capabilityDoc = (query: URLSearchParams = new URLSearchParams()): { status: number; body: unknown } => {
    const sizedClass = query.get('class');
    const sizedTokens = query.get('context_tokens');
    const sizedConcurrency = query.get('concurrency');
    if ((sizedTokens !== null || sizedConcurrency !== null) && sizedClass === null) {
      return { status: 400, body: { error: { code: 'capability_class_required', message: 'a size needs ?class=', details: null } } };
    }
    if (sizedClass !== null && sizedClass !== 'generate' && (sizedTokens !== null || sizedConcurrency !== null)) {
      return { status: 400, body: { error: { code: 'capability_not_client_sized', message: `${sizedClass} is not client-sized`, details: null } } };
    }
    const genTokens = sizedTokens === null ? 8192 : Number(sizedTokens);
    const genConcurrency = sizedConcurrency === null ? 1 : Number(sizedConcurrency);
    const genCeilings = ceilings(genConcurrency);
    if (sizedTokens !== null && genCeilings.every((c) => (c as { tokens: number }).tokens < genTokens)) {
      return { status: 400, body: { error: { code: 'context_over_limit', message: `${genTokens} tokens is over every ceiling`, details: null } } };
    }
    const rows: unknown[] = [
      ...LLM_CLASSES.map((c) => (disabledClasses[c] !== undefined ? {
        capability: c,
        enabled: false,
        selected: '',
        reason: disabledClasses[c],
        shortfall_bytes: 1,
        route: 'local',
        work: work(4096, 4),
        context_ceilings: null,
      } : {
        capability: c,
        enabled: true,
        selected: routes[c] ?? 'qwen3.5-9b',
        reason: routes[c] ? `routed to ${routes[c].split('/')[0]}` : 'qwen3.5-9b fits',
        shortfall_bytes: 0,
        route: routes[c] ? 'upstream' : 'local',
        work: work(4096, 4),
        context_ceilings: null,
      })),
      disabledClasses['generate'] !== undefined
        ? { capability: 'generate', enabled: false, selected: '', reason: disabledClasses['generate'], shortfall_bytes: 1, route: 'local', work: work(genTokens, genConcurrency, sizedTokens === null ? 'default' : 'request'), context_ceilings: genCeilings }
        : { capability: 'generate', enabled: true, selected: 'qwen3.5-9b', reason: 'qwen3.5-9b fits', shortfall_bytes: 0, route: 'local', work: work(genTokens, genConcurrency, sizedTokens === null ? 'default' : 'request'), context_ceilings: genCeilings },
      disabledClasses['decide'] !== undefined
        ? { capability: 'decide', enabled: false, selected: '', reason: disabledClasses['decide'], shortfall_bytes: 1, route: 'local', work: work(8192, 2), context_ceilings: null }
        : { capability: 'decide', enabled: true, selected: options.decideSelected ?? 'qwen3.5-9b', reason: 'fits', shortfall_bytes: 0, route: 'local', work: work(8192, 2), context_ceilings: null },
      { capability: 'asr', enabled: true, selected: 'mlx-whisper-large-v3-turbo', reason: 'installed', shortfall_bytes: 0, route: 'local', work: null, context_ceilings: null },
    ];
    if (options.models?.some((m) => /^dots/.test(m.id))) {
      rows.push({ capability: 'pages', enabled: true, selected: options.models.find((m) => /^dots/.test(m.id))!.id, reason: 'fits', shortfall_bytes: 0, route: 'local', work: work(32768, 12), context_ceilings: null });
    }
    return {
      status: 200,
      body: {
        backend_kind: backend,
        total_bytes: 68719476736,
        desktop_allowance_bytes: 3221225472,
        classes: rows,
      },
    };
  };

  // ── tasks ────────────────────────────────────────────────────────────
  const foreignTask: FakeTask = {
    taskId: 'task-foreign', type: 'module', request: { type: 'module', module: { name: 'bookforge' } },
    state: 'running', events: [{ id: 1, event: 'started', data: { type: 'module' } }], unmet: [],
  };
  let foreignFinishTimer: NodeJS.Timeout | null = null;

  const listedTasks = (): FakeTask[] => (named.taskBusy !== undefined ? [foreignTask, ...tasks] : [...tasks]);
  const findTask = (id: string): FakeTask | undefined => listedTasks().find((task) => task.taskId === id);

  const taskStatusDoc = (task: FakeTask): unknown => ({
    task_id: task.taskId,
    type: task.type,
    request: task.request,
    state: task.state,
    error: task.state === 'failed'
      ? { code: String(task.events.at(-1)?.data['code'] ?? 'failed'), message: String(task.events.at(-1)?.data['message'] ?? '') }
      : null,
    created: '2026-09-23T01:00:00Z',
    started: '2026-09-23T01:00:00Z',
    finished: task.state === 'running' ? null : '2026-09-23T01:05:00Z',
    unmet: task.unmet,
  });

  const pushTaskEvent = (task: FakeTask, event: string, data: Record<string, unknown>): void => {
    task.events.push({ id: task.events.length + 1, event, data });
    for (const wake of taskListeners.get(task.taskId) ?? []) wake();
  };

  function streamTask(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const task = findTask(id);
    if (task === undefined) {
      refusal(res, 404, 'unknown_task', `no task ${id}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let sent = Number(req.headers['last-event-id'] ?? 0) || 0;
    const flush = (): void => {
      while (sent < task.events.length) {
        const ev = task.events[sent];
        sent += 1;
        res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        if (ev.event === 'done' || ev.event === 'failed' || ev.event === 'cancelled') {
          taskListeners.get(task.taskId)?.delete(flush);
          res.end();
          return;
        }
      }
    };
    if (!taskListeners.has(task.taskId)) taskListeners.set(task.taskId, new Set());
    taskListeners.get(task.taskId)?.add(flush);
    res.on('close', () => taskListeners.get(task.taskId)?.delete(flush));
    flush();
  }

  /** The server's `validate_module`, the parts a client can get wrong. */
  function validateModule(module: unknown): { code: string; message: string } | null {
    if (module === null || typeof module !== 'object') return { code: 'invalid_module', message: 'module must be an object' };
    const m = module as Record<string, unknown>;
    const jobTypes = Array.isArray(m['job_types']) ? m['job_types'] as Record<string, unknown>[] : [];
    const subjects = Array.isArray(m['subjects']) ? m['subjects'] as Record<string, unknown>[] : [];
    for (const [index, entry] of jobTypes.entries()) {
      const extra = Object.keys(entry).filter((k) => k !== 'type' && k !== 'narrator_engine');
      if (extra.length > 0) return { code: 'invalid_module', message: `job_types[${index}]: unknown key(s) ${JSON.stringify(extra)}` };
    }
    for (const [index, entry] of subjects.entries()) {
      const extra = Object.keys(entry).filter((k) => k !== 'kind' && k !== 'id');
      if (extra.length > 0) return { code: 'invalid_module', message: `subjects[${index}]: unknown key(s) ${JSON.stringify(extra)}` };
      if (!catalog.some((row) => row.kind === entry['kind'] && row.id === entry['id'])) {
        return { code: 'unknown_subject', message: `subjects[${index}]: this server has no ${String(entry['kind'])} called '${String(entry['id'])}' for ${backend}` };
      }
    }
    return null;
  }

  function postTask(res: http.ServerResponse, body: Record<string, unknown>): void {
    const held = named.cardHeld;
    if (held !== undefined && (held.times === undefined || held.times > 0)) {
      if (held.times !== undefined) held.times -= 1;
      refusal(res, 409, 'server_busy', `the card is held by ${held.fact}`, { fact: held.fact, who: held.who });
      return;
    }
    if (named.taskBusy !== undefined && foreignTask.state === 'running') {
      refusal(res, 409, 'task_busy', `task ${foreignTask.taskId} is running`, { task_id: foreignTask.taskId, type: named.taskBusy.type });
      return;
    }
    if (body['type'] !== 'module') {
      refusal(res, 400, 'invalid_task', `this fake runs module tasks only, not ${String(body['type'])}`);
      return;
    }
    const invalid = validateModule(body['module']);
    if (invalid !== null) {
      refusal(res, 400, invalid.code, invalid.message);
      return;
    }
    const module = body['module'] as { job_types: Array<{ type: string }>; needs: Array<{ class: string }>; subjects: Array<{ kind: string; id: string }> };
    const task: FakeTask = { taskId: `task-${nextTask++}`, type: 'module', request: body, state: 'running', events: [], unmet: [] };
    tasks.push(task);
    send(res, 201, { task_id: task.taskId });
    runModule(task, module);
  }

  /** Walk the module a few milliseconds apart, the way the server streams it. */
  function runModule(task: FakeTask, module: { job_types: Array<{ type: string }>; needs: Array<{ class: string }>; subjects: Array<{ kind: string; id: string }> }): void {
    const steps: Array<() => void> = [];
    const total = module.job_types.length + module.needs.length + module.subjects.length + 1;
    let index = 0;
    steps.push(() => pushTaskEvent(task, 'started', { type: 'module' }));
    for (const entry of module.job_types) {
      steps.push(() => {
        index += 1;
        pushTaskEvent(task, 'step', { name: `install ${entry.type}`, index, total });
        if (installedJobTypes.includes(entry.type)) {
          pushTaskEvent(task, 'skipped', { reason: `${entry.type} is installed` });
          return;
        }
        pushTaskEvent(task, 'progress', { line: `Installing the ${entry.type} environment` });
        installedJobTypes.push(entry.type);
      });
    }
    for (const need of module.needs) {
      steps.push(() => {
        index += 1;
        pushTaskEvent(task, 'step', { name: `resolve ${need.class}`, index, total });
        if (disabledClasses[need.class] !== undefined) {
          task.unmet.push({ class: need.class, reason: disabledClasses[need.class] });
          return;
        }
        const selected = routes[need.class] ?? 'qwen3.5-9b';
        const row = catalog.find((r) => r.id === selected);
        if (row !== undefined && !row.installed) {
          pushTaskEvent(task, 'progress', { bytes_done: 512, bytes_total: 1024, file: `${selected}/model.safetensors` });
          row.installed = true;
        }
      });
    }
    for (const subject of module.subjects) {
      steps.push(() => {
        index += 1;
        pushTaskEvent(task, 'step', { name: `pull ${subject.id}`, index, total });
        const row = catalog.find((r) => r.kind === subject.kind && r.id === subject.id);
        if (row === undefined || row.installed) {
          pushTaskEvent(task, 'skipped', { reason: `${subject.id} is installed` });
          return;
        }
        pushTaskEvent(task, 'progress', { bytes_done: 1024, bytes_total: 1024, file: `${subject.id}/weights.npz` });
        row.installed = true;
      });
    }
    steps.push(() => {
      if (options.failModuleWith !== undefined) {
        task.state = 'failed';
        pushTaskEvent(task, 'failed', { code: options.failModuleWith.code, message: options.failModuleWith.message });
        return;
      }
      index += 1;
      pushTaskEvent(task, 'step', { name: 'reload', index, total, job_types: [...installedJobTypes] });
      task.state = 'done';
      pushTaskEvent(task, 'done', {});
    });
    let at = 0;
    const tick = (): void => {
      if (task.state === 'cancelled') return;
      const next = steps[at];
      at += 1;
      if (next === undefined) return;
      next();
      setTimeout(tick, 5).unref?.();
    };
    setTimeout(tick, 5).unref?.();
  }

  // ── jobs ─────────────────────────────────────────────────────────────
  const jobStatusDoc = (job: FakeJob): unknown => ({
    job_id: job.jobId,
    type: job.type,
    model: job.model,
    status: job.status,
    progress: job.status === 'done' ? 1 : 0,
    position: job.status === 'queued' ? 0 : null,
    error: job.status === 'failed'
      ? { code: String((job.events.at(-1)?.data['error'] as Record<string, unknown> | undefined)?.['code'] ?? 'failed'),
          message: String((job.events.at(-1)?.data['error'] as Record<string, unknown> | undefined)?.['message'] ?? '') }
      : null,
    artifacts: Object.keys(job.artifacts ?? {}),
    created: '2026-09-23T01:00:00Z',
    started: job.status === 'queued' ? null : '2026-09-23T01:00:01Z',
    finished: job.status === 'done' || job.status === 'failed' || job.status === 'cancelled' ? '2026-09-23T01:00:02Z' : null,
    lease_id: job.leaseId,
    client_ref: job.clientRef ?? null,
    interrupted_at: null,
    chunks_done: [],
    chunks_total: null,
    chunk_at: null,
  });

  const pushJobEvent = (job: FakeJob, event: string, data: Record<string, unknown>): void => {
    job.events.push({ id: job.events.length + 1, event, data });
    for (const wake of jobListeners.get(job.jobId) ?? []) wake();
  };

  function streamJob(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
    const job = jobs.find((j) => j.jobId === id);
    if (job === undefined) {
      refusal(res, 404, 'unknown_job', `no job ${id}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let sent = Number(req.headers['last-event-id'] ?? 0) || 0;
    const flush = (): void => {
      while (sent < job.events.length) {
        const ev = job.events[sent];
        sent += 1;
        res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        if (ev.event === 'done' || ev.event === 'failed' || ev.event === 'cancelled') {
          jobListeners.get(job.jobId)?.delete(flush);
          res.end();
          return;
        }
      }
    };
    if (!jobListeners.has(job.jobId)) jobListeners.set(job.jobId, new Set());
    jobListeners.get(job.jobId)?.add(flush);
    res.on('close', () => jobListeners.get(job.jobId)?.delete(flush));
    flush();
  }

  function busyDetails(busy: { client: string; type: string; progress: number; model?: string | null }): Record<string, unknown> {
    return {
      holder: busy.client, job_id: 'job-held', type: busy.type, model: busy.model ?? null,
      status: 'running', since: '2026-09-23T01:00:01Z', progress: busy.progress, message: null,
    };
  }

  function postJob(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>): void {
    const type = String(body['type'] ?? '');
    if (named.serverBusy !== undefined) {
      const busy = named.serverBusy;
      refusal(res, 409, 'server_busy', `the lane is busy with ${busy.client}'s ${busy.type}`, busyDetails(busy));
      return;
    }
    if (type === 'asr') {
      postAsr(req, res, body);
      return;
    }
    if (type !== 'load-model' && type !== 'unload-model') {
      refusal(res, 400, 'unknown_job_type', `this fake runs load-model, unload-model and asr jobs, not ${type}`);
      return;
    }
    const model = typeof body['model'] === 'string' ? body['model'] : null;
    const info = models.find((m) => m.id === model);
    if (type === 'load-model') {
      if (info === undefined) {
        refusal(res, 404, 'unknown_model', `no model '${String(model)}'`);
        return;
      }
      if (info.installed === false) {
        refusal(res, 409, 'model_not_installed', `'${info.id}' is not installed`);
        return;
      }
      if (openLease !== null && openLease.model !== model) {
        refusal(res, 409, 'leased', `'${openLease.model}' is leased by '${openLease.client}' for '${openLease.act}'`, {
          lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
          since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
        });
        return;
      }
      const wanted = ((body['params'] ?? {}) as Record<string, unknown>)['context'];
      if (wanted !== undefined) {
        const ceiling = options.contextCeilings?.[info.id] ?? 131072;
        if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 2048) {
          refusal(res, 400, 'invalid_params', `context must be a whole number >= 2048, got ${JSON.stringify(wanted)}`);
          return;
        }
        if (wanted > ceiling) {
          refusal(res, 400, 'context_over_limit', `${info.id} serves at most ${ceiling} tokens here; ${wanted} was asked`, { ceiling, asked: wanted });
          return;
        }
      }
    }
    const params = (body['params'] ?? {}) as Record<string, unknown>;
    const client = (req.headers['x-crucible-client'] as string | undefined) ?? null;
    const job: FakeJob = {
      jobId: `job-${nextJob++}`, type, model, params, status: 'queued', leaseId: null, events: [], client,
      clientRef: typeof body['client_ref'] === 'string' ? body['client_ref'] : null,
    };
    jobs.push(job);
    send(res, 202, { job_id: job.jobId });
    pushJobEvent(job, 'queued', { position: 0 });
    const finish = (): void => {
      if (job.status === 'cancelled') return;
      if (type === 'load-model' && named.failLoadWith !== undefined) {
        job.status = 'failed';
        pushJobEvent(job, 'failed', { error: { code: named.failLoadWith.code, message: named.failLoadWith.message } });
        return;
      }
      if (type === 'unload-model') {
        resident = null;
        residentCtx = null;
        job.status = 'done';
        pushJobEvent(job, 'done', { resident: null });
        return;
      }
      resident = model;
      residentCtx = typeof params['context'] === 'number' ? params['context'] : null;
      const lease = params['lease'] as { act?: string; ttl_seconds?: number } | undefined;
      if (lease !== undefined) {
        const leaseId = `lease-${nextLease++}`;
        openLease = { leaseId, model: model!, client, act: String(lease.act ?? '') };
        leases.taken.push({ leaseId, model: model!, act: lease.act, ttlSeconds: lease.ttl_seconds });
        job.leaseId = leaseId;
      }
      job.status = 'done';
      pushJobEvent(job, 'done', { resident: model, ...(job.leaseId ? { lease_id: job.leaseId } : {}) });
    };
    setTimeout(() => {
      if (job.status === 'cancelled') return;
      job.status = 'running';
      pushJobEvent(job, 'warming', { message: `loading ${String(model)}` });
      if (named.holdLoads && type === 'load-model') return;
      setTimeout(finish, Math.max(1, (options.loadMs ?? 20) / 2)).unref?.();
    }, Math.max(1, (options.loadMs ?? 20) / 2)).unref?.();
  }

  // ── asr (P5) ─────────────────────────────────────────────────────────
  function postAsr(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>): void {
    if (!installedJobTypes.includes('asr')) {
      refusal(res, 400, 'job_type_disabled', 'asr is not installed on this server');
      return;
    }
    const model = typeof body['model'] === 'string' ? body['model'] : null;
    if (model === null) {
      refusal(res, 400, 'model_required', 'asr names its model; there is no default');
      return;
    }
    const row = asrRows().find((r) => r['id'] === model);
    if (row === undefined || !String(model).startsWith(`${asrEngine}-`)) {
      refusal(res, 404, 'unknown_model', `no asr model '${model}' on ${backend}`);
      return;
    }
    if (row['installed'] !== true) {
      refusal(res, 409, 'model_not_installed', `'${model}' is not installed`);
      return;
    }
    const params = (body['params'] ?? {}) as Record<string, unknown>;
    const keys = Object.keys(params).sort();
    if (keys.join(',') !== 'language,vad_filter,word_timestamps') {
      refusal(res, 400, 'invalid_params', `asr params are exactly language, vad_filter, word_timestamps; got ${keys.join(', ') || 'none'}`);
      return;
    }
    if (typeof params['language'] !== 'string' || typeof params['vad_filter'] !== 'boolean' || typeof params['word_timestamps'] !== 'boolean') {
      refusal(res, 400, 'invalid_params', 'asr params have the wrong types');
      return;
    }
    if (asrEngine === 'mlx-whisper' && params['vad_filter'] === true) {
      refusal(res, 400, 'vad_unsupported_by_engine', `${model} has no voice-activity filter; send vad_filter false`);
      return;
    }
    const inputs = (body['inputs'] ?? {}) as Record<string, { blob_id?: string }>;
    const names = Object.keys(inputs);
    if (names.length !== 1 || typeof inputs[names[0]]?.blob_id !== 'string') {
      refusal(res, 400, 'invalid_inputs', 'asr takes exactly one input naming an uploaded blob');
      return;
    }
    // As the real server: an upload is MOVED into the job that names it, so a
    // blob is consumed once (409 blob_consumed naming the job), and one this
    // server never had (or lost) is 400 unknown_blob.
    const blobId = inputs[names[0]].blob_id!;
    const takenBy = consumedBlobs.get(blobId);
    if (takenBy !== undefined) {
      refusal(res, 409, 'blob_consumed', `blob '${blobId}' was consumed by job ${takenBy}. Upload them again for this job`, { blob_id: blobId, job_id: takenBy });
      return;
    }
    if (!blobs.has(blobId)) {
      refusal(res, 400, 'unknown_blob', `input '${names[0]}' names blob '${blobId}', which this server does not hold`);
      return;
    }
    const client = (req.headers['x-crucible-client'] as string | undefined) ?? null;
    const job: FakeJob = {
      jobId: `job-${nextJob++}`, type: 'asr', model, params, status: 'queued', leaseId: null, events: [], client,
      inputs: { [names[0]]: blobId },
      clientRef: typeof body['client_ref'] === 'string' ? body['client_ref'] : null,
    };
    blobs.delete(blobId);
    consumedBlobs.set(blobId, job.jobId);
    jobs.push(job);
    send(res, 202, { job_id: job.jobId });
    pushJobEvent(job, 'queued', { position: 0 });
    runAsr(job, { ...asrScript });
  }

  function runAsr(job: FakeJob, script: FakeAsrScript): void {
    const stepMs = script.stepMs ?? 5;
    const totalS = script.totalS ?? 3600;
    const decodeFrames = script.decodeFrames ?? 2;
    const transcribeFrames = script.transcribeFrames ?? 4;
    const steps: Array<() => boolean | void> = [];
    steps.push(() => {
      job.status = 'running';
      pushJobEvent(job, 'warming', { message: `loading ${String(job.model)} — mlx: weights mapped` });
    });
    for (let i = 1; i <= decodeFrames; i++) {
      steps.push(() => pushJobEvent(job, 'progress', {
        fraction: 0, message: 'decoding audio', stage: 'decoding', processed_s: Math.round((totalS * i) / decodeFrames), total_s: totalS, cues: 0,
      }));
    }
    if (script.failWith !== undefined) {
      steps.push(() => {
        job.status = 'failed';
        pushJobEvent(job, 'failed', { error: { ...script.failWith! } });
        return true;
      });
    } else {
      for (let i = 1; i <= transcribeFrames; i++) {
        steps.push(() => {
          pushJobEvent(job, 'progress', {
            fraction: i / transcribeFrames, message: `transcribing window ${i}`, stage: 'transcribing',
            processed_s: Math.round((totalS * i) / transcribeFrames), total_s: totalS, cues: i * 10,
          });
          // Held mid-file: nothing more until a DELETE wakes it (and it ends cancelled).
          if (script.holdAfterFrames !== undefined && i >= script.holdAfterFrames) return 'hold' as never;
        });
      }
      steps.push(() => {
        const doc = script.transcript ?? defaultFakeTranscript(String(job.model));
        job.artifacts = { 'transcript.json': Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf-8') };
        job.status = 'done';
        pushJobEvent(job, 'done', { artifacts: ['transcript.json'] });
        return true;
      });
    }
    let at = 0;
    const tick = (): void => {
      if (job.status === 'cancelled') return;
      const step = steps[at];
      at += 1;
      if (step === undefined) return;
      const outcome = step() as unknown;
      if (outcome === true) return;
      if (outcome === 'hold') return; // running, held mid-file, until a DELETE cancels it
      setTimeout(tick, stepMs).unref?.();
    };
    setTimeout(tick, stepMs).unref?.();
  }

  /** Parse a multipart body's `file` part: its filename and its bytes. */
  function multipartFile(req: http.IncomingMessage, raw: Buffer): { filename: string; data: Buffer } | null {
    const type = String(req.headers['content-type'] ?? '');
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
    if (!type.startsWith('multipart/form-data') || m === null) return null;
    const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
    let at = raw.indexOf(boundary);
    while (at >= 0) {
      const headStart = at + boundary.length + 2;
      const headEnd = raw.indexOf('\r\n\r\n', headStart);
      if (headEnd < 0) return null;
      const head = raw.subarray(headStart, headEnd).toString('utf-8');
      const next = raw.indexOf(boundary, headEnd);
      if (next < 0) return null;
      if (/name="file"/.test(head)) {
        const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? '';
        return { filename, data: raw.subarray(headEnd + 4, next - 2) };
      }
      at = next;
    }
    return null;
  }

  // ── chat ─────────────────────────────────────────────────────────────
  async function chat(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const model = String(body['model'] ?? '');
    const upstreamMatch = /^(anthropic|openai|ollama)\/(.+)$/.exec(model);
    if (upstreamMatch) {
      if (!configured(upstreamMatch[1])) {
        refusal(res, 409, 'upstream_unconfigured', `the ${upstreamMatch[1]} upstream is not configured on this server`, { upstream: upstreamMatch[1] });
        return;
      }
    } else if (resident !== model) {
      refusal(res, 409, 'model_not_resident', `'${model}' is not resident${resident ? `; '${resident}' is` : '; nothing is'}`, { resident });
      return;
    }
    if (named.chatDelayMs !== undefined) {
      const aborted = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), named.chatDelayMs);
        res.on('close', () => { clearTimeout(t); resolve(true); });
      });
      if (aborted || res.destroyed) return;
    }
    const canned = options.chatReplies?.[model] ?? options.chatReplies?.['*'] ?? '{"ok":true}';
    const reply = typeof canned === 'function' ? canned(body) : canned;
    const shaped = typeof reply === 'string' ? { content: reply } : reply;
    const sources: Record<string, string> = {};
    for (const key of ['temperature', 'top_p', 'top_k', 'max_tokens', 'seed']) {
      sources[key] = key in body ? 'request' : upstreamMatch ? 'engine' : 'manifest';
    }
    if (upstreamMatch?.[1] === 'anthropic' && !('max_tokens' in body)) sources['max_tokens'] = 'upstream default 4096';
    const kwargs = body['chat_template_kwargs'] as Record<string, unknown> | undefined;
    sources['thinking'] = kwargs && 'enable_thinking' in kwargs ? (upstreamMatch ? 'dropped' : 'request') : upstreamMatch ? 'engine' : 'manifest';
    const message: Record<string, unknown> = { role: 'assistant', content: shaped.content ?? '' };
    if (shaped.reasoning !== undefined) message['reasoning'] = shaped.reasoning;
    // 1.0.24: an ollama/ chat carries `context_tokens` to Ollama as options.num_ctx
    // and says what it sent; absent, the tag's own context. Older servers know nothing of it.
    const extraHeaders: Record<string, string> = {};
    const newer = compareFakeVersions(options.version ?? '1.0.24', '1.0.24') >= 0;
    if (upstreamMatch?.[1] === 'ollama' && newer) {
      const ctx = body['context_tokens'];
      extraHeaders['X-Crucible-Context'] = JSON.stringify(typeof ctx === 'number'
        ? { num_ctx: ctx, source: 'request' }
        : { num_ctx: 40960, source: 'modelfile' });
    }
    send(res, 200, {
      id: `chatcmpl-${randomBytes(4).toString('hex')}`,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message, finish_reason: shaped.finishReason ?? 'stop' }],
      usage: { prompt_tokens: promptTokensOf(body), completion_tokens: 7, total_tokens: promptTokensOf(body) + 7 },
    }, { 'X-Crucible-Sampling': JSON.stringify(sources), ...extraHeaders });
  }


  /** Crucible's own act vocabulary, as the server derives it from its classes. */
  const ACTS = new Set([...LLM_CLASSES, 'generate', 'decide', 'pages', 'asr', 'tts', 'align', 'rvc', 'denoise', 'echo']);

  /** `POST /v1/decide` (PHASE22 §2.2/§2.4): the door's refusals, then one reading per question. */
  async function decide(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const act = req.headers['x-crucible-act'];
    if (typeof act === 'string' && !ACTS.has(act)) {
      refusal(res, 400, 'unknown_act', `'${act}' is not a capability class`, { known: [...ACTS] });
      return;
    }
    const known = new Set(['model', 'state', 'images', 'questions', 'missing']);
    const extra = Object.keys(body).filter((k) => !known.has(k));
    if (extra.length) {
      refusal(res, 400, 'invalid_request', `unknown field(s): ${extra.join(', ')}`, { fields: extra });
      return;
    }
    const model = typeof body['model'] === 'string' ? body['model'] : '';
    if (!model) {
      refusal(res, 400, 'invalid_request', 'model is required', { field: 'model' });
      return;
    }
    if (/^(anthropic|openai|ollama)\//.test(model)) {
      refusal(res, 400, 'decide_needs_logprobs', `${model} is an upstream; no upstream returns a distribution`);
      return;
    }
    const missing = body['missing'] ?? 'refuse';
    if (missing !== 'refuse' && missing !== 'report') {
      refusal(res, 400, 'invalid_request', `missing must be 'refuse' or 'report', got ${JSON.stringify(missing)}`, { field: 'missing' });
      return;
    }
    const questionsBody = body['questions'];
    if (questionsBody === null || typeof questionsBody !== 'object' || Array.isArray(questionsBody) || Object.keys(questionsBody).length === 0) {
      refusal(res, 400, 'invalid_request', 'questions must be a non-empty object', { field: 'questions' });
      return;
    }
    const questions: FakeDecideQuestion[] = [];
    for (const [name, raw] of Object.entries(questionsBody as Record<string, Record<string, unknown>>)) {
      const type = raw['type'];
      const instructions = String(raw['instructions'] ?? '');
      if (type === 'choice') {
        const opts = raw['options'] as Record<string, string>;
        const labels = Object.keys(opts ?? {});
        if (labels.length > 26) {
          refusal(res, 400, 'too_many_options', `question '${name}' has ${labels.length} options; the letters are A..Z`, { question: name });
          return;
        }
        if (labels.length < 2) {
          refusal(res, 400, 'invalid_request', `question '${name}' needs 2-26 options`, { field: `questions.${name}.options` });
          return;
        }
        questions.push({ name, type, instructions, labels, descriptions: Object.values(opts) });
      } else if (type === 'score') {
        questions.push({ name, type, instructions, labels: [...(raw['levels'] as string[])] });
      } else if (type === 'yesno') {
        questions.push({ name, type, instructions, labels: ['Yes', 'No'] });
      } else {
        refusal(res, 400, 'invalid_request', `question '${name}' has an unknown type`, { field: `questions.${name}.type` });
        return;
      }
    }
    if (resident !== model) {
      refusal(res, 409, 'model_not_resident', `'${model}' is not resident${resident ? `; '${resident}' is` : '; nothing is'}`, { resident });
      return;
    }
    const cap = options.decideMaxOptions ?? 26;
    const over = questions.find((q) => q.labels.length > cap);
    if (over !== undefined) {
      refusal(res, 503, 'decide_not_served', `the engine reads at most ${cap} options; question '${over.name}' has ${over.labels.length}`,
        { engine: 'mlx-lm', max_options: cap, question: over.name });
      return;
    }
    if (named.chatDelayMs !== undefined) {
      const aborted = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), named.chatDelayMs);
        res.on('close', () => { clearTimeout(t); resolve(true); });
      });
      if (aborted || res.destroyed) return;
    }
    const report = missing === 'report';
    const answers: Record<string, unknown> = {};
    const perQuestion: Record<string, unknown> = {};
    const tokensPer: Record<string, number> = {};
    const round = (x: number): number => Math.round(x * 1e6) / 1e6;
    for (const q of questions) {
      const raw = decideProbs ? decideProbs(q, body['state'])
        : Object.fromEntries(q.labels.map((l, i) => [l, i === 0 ? 0.6 : 0.35 / (q.labels.length - 1)]));
      const returned = q.labels.filter((l) => typeof raw[l] === 'number' && raw[l] > 0);
      const absent = q.labels.filter((l) => !returned.includes(l));
      if (returned.length === 0 || (!report && absent.length > 0)) {
        const letter = returned.length === 0 ? null : String.fromCharCode(65 + q.labels.indexOf(absent[0]));
        refusal(res, 502, 'label_not_in_probs', `question '${q.name}': label ${letter ?? '(all)'} is not among the top tokens`, { question: q.name, letter });
        return;
      }
      const mass = returned.reduce((sum, l) => sum + raw[l], 0);
      const probs: Record<string, number | null> = {};
      const logprobs: Record<string, number | null> = {};
      for (const l of q.labels) {
        const p = returned.includes(l) ? raw[l] / mass : null;
        probs[l] = p === null ? null : round(p);
        logprobs[l] = p === null || p === 0 ? null : round(Math.log(p));
      }
      let best = returned[0];
      for (const l of returned) if ((probs[l] ?? 0) > (probs[best] ?? 0)) best = l;
      const common: Record<string, unknown> = { label_mass: round(mass), ...(report ? { missing_labels: absent } : {}) };
      if (q.type === 'yesno') {
        const p = probs['Yes'] ?? 0;
        answers[q.name] = { type: 'yesno', p, logprob: p > 0 ? round(Math.log(p)) : null, ...common };
      } else if (q.type === 'choice') {
        answers[q.name] = { type: 'choice', choice: best, probabilities: probs, logprobs, confidence: probs[best], ...common };
      } else {
        const score = q.labels.reduce((sum, l, i) => sum + (i + 1) * (probs[l] ?? 0), 0);
        answers[q.name] = { type: 'score', score: round(score), level: best, probabilities: probs, logprobs, confidence: probs[best], ...common };
      }
      perQuestion[q.name] = { wall_ms: 12.5, prompt_tokens: 140, cached_tokens: null };
      tokensPer[q.name] = 140;
    }
    send(res, 200, {
      model: { id: model, revision: 'abc1234', fingerprint: `${model}@abc1234` },
      engine: backend === 'cuda-linux' ? 'vllm' : 'mlx-lm',
      answers,
      timing_ms: { total: 12.5 * questions.length, per_question: perQuestion, prime: questions.length > 1 ? { wall_ms: 30, prompt_tokens: 100, cached_tokens: null } : null },
      tokens: { per_question: tokensPer, images: Array.isArray(body['images']) ? body['images'].length : 0 },
    });
  }

  /**
   * Strip `omit`'s fields from this response: a 2xx JSON body as it is
   * ended, and each SSE frame as it is written. Refusals are never touched.
   */
  function applyOmissions(res: http.ServerResponse, method: string, path: string): void {
    const route = routeKey(method, path);
    const eventKind = /^\/v1\/jobs\/[^/]+\/events$/.test(path) ? 'job-event' : /^\/v1\/tasks\/[^/]+\/events$/.test(path) ? 'task-event' : null;
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      const paths = omit[route];
      // send() passes its headers to writeHead, so the body itself says whether it is JSON.
      if (paths !== undefined && res.statusCode >= 200 && res.statusCode < 300 && typeof chunk === 'string') {
        let doc: unknown;
        try { doc = JSON.parse(chunk); } catch { doc = undefined; }
        if (doc !== undefined) chunk = JSON.stringify(omitAll(doc, paths));
      }
      return end(chunk, ...rest);
    }) as typeof res.end;
    if (eventKind === null) return;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === 'string') {
        const frame = /^(id: [^\n]*\nevent: ([^\n]*)\ndata: )(.*)(\n\n)$/s.exec(chunk);
        const paths = frame === null ? undefined : omit[`${eventKind}:${frame[2]}`];
        if (frame !== null && paths !== undefined) chunk = `${frame[1]}${JSON.stringify(omitAll(JSON.parse(frame[3]), paths))}${frame[4]}`;
      }
      return write(chunk, ...rest);
    }) as typeof res.write;
  }

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
    if (raw.length > 0 && path === '/v1/uploads') {
      record.body = { multipartBytes: raw.length };
    } else if (raw.length > 0) {
      try {
        record.body = JSON.parse(raw.toString('utf-8'));
      } catch {
        record.body = raw.toString('utf-8');
      }
    }
    const body = (record.body ?? {}) as Record<string, unknown>;
    applyOmissions(res, method, path);

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
      const doc = capabilityDoc(url.searchParams);
      send(res, doc.status, doc.body);
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
      send(res, 200, { models: options.upstreamModels?.[upstream] ?? [`${upstream}-model-a`, `${upstream}-model-b`] });
      return;
    }
    // ── the operator side: catalog and tasks (P2 coordination) ───────────
    if (path === '/v1/catalog' && method === 'GET') {
      send(res, 200, {
        rows: catalog.map((row) => ({
          kind: row.kind, id: row.id, name: row.name ?? null, job_type: row.jobType, installed: row.installed,
          installed_bytes: row.installed ? 1024 : null, expected_bytes: row.expectedBytes ?? null, floors: [],
          license: null, source: `hf:fake/${row.id}`, resident: false,
          shares_weights_of: row.sharesWeightsOf ?? null, missing_files: row.missingFiles ?? null,
        })),
      });
      return;
    }
    if (path === '/v1/tasks' && method === 'GET') {
      send(res, 200, { tasks: [...listedTasks()].reverse().map(taskStatusDoc) });
      return;
    }
    if (path === '/v1/tasks' && method === 'POST') {
      postTask(res, body);
      return;
    }
    const taskEvents = /^\/v1\/tasks\/([^/]+)\/events$/.exec(path);
    if (taskEvents && method === 'GET') {
      streamTask(req, res, decodeURIComponent(taskEvents[1]));
      return;
    }
    const taskDoc = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (taskDoc && method === 'GET') {
      const task = findTask(decodeURIComponent(taskDoc[1]));
      if (task === undefined) {
        refusal(res, 404, 'unknown_task', `no task ${taskDoc[1]}`);
        return;
      }
      send(res, 200, taskStatusDoc(task));
      return;
    }
    if (taskDoc && method === 'DELETE') {
      const task = findTask(decodeURIComponent(taskDoc[1]));
      if (task === undefined || task.state !== 'running') {
        refusal(res, 409, 'task_not_running', `task ${taskDoc[1]} is not running`);
        return;
      }
      pushTaskEvent(task, 'cancelled', {});
      task.state = 'cancelled';
      send(res, 200, { task_id: task.taskId, status: 'cancelling' });
      return;
    }
    if (path === '/v1/models' && method === 'GET') {
      send(res, 200, models.map((m) => {
        const supported = m.backendSupported !== false;
        const installed = m.installed !== false;
        const reason = !supported ? `not served on ${backend}` : !installed ? 'weights are not installed' : m.unloadableReason ?? null;
        return {
          id: m.id, family: m.family ?? m.id.split('-')[0], params_b: m.paramsB,
          revision: supported ? 'abc1234' : null, fingerprint: supported ? `${m.id}@abc1234` : null,
          modalities: m.modalities ?? ['text'], backend_supported: supported, installed, resident: resident === m.id,
          loadable: reason === null, reason,
          memory_bytes_estimate: supported ? 20950548480 : null,
          context_default: m.contextDefault ?? 32768,
          max_model_len: !supported ? null
            : resident === m.id && residentCtx !== null ? residentCtx
              : (m.maxModelLen === undefined ? 262144 : m.maxModelLen),
          weights_of: m.weightsOf ?? null,
        };
      }));
      return;
    }

    // ── uploads (P5) ─────────────────────────────────────────────────────
    if (path === '/v1/uploads' && method === 'POST') {
      const file = multipartFile(req, raw);
      if (file === null) {
        refusal(res, 400, 'invalid_upload', 'the upload is multipart/form-data with a file part');
        return;
      }
      const blobId = `blob-${uploads.length + 1}`;
      const sha256 = createHash('sha256').update(file.data).digest('hex');
      blobs.set(blobId, file);
      uploads.push({ blobId, filename: file.filename, bytes: file.data.length, sha256 });
      record.body = { filename: file.filename, bytes: file.data.length };
      send(res, 201, { blob_id: blobId, bytes: file.data.length, sha256 });
      return;
    }
    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
    if (artifact && method === 'GET') {
      const job = jobs.find((j) => j.jobId === decodeURIComponent(artifact[1]));
      const bytes = job?.artifacts?.[decodeURIComponent(artifact[2])];
      if (bytes === undefined) {
        refusal(res, 404, 'unknown_artifact', `no artifact ${artifact[2]} on job ${artifact[1]}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(bytes);
      return;
    }

    // ── jobs: load-model (P3), asr (P5) ──────────────────────────────────
    if (path === '/v1/jobs' && method === 'POST') {
      postJob(req, res, body);
      return;
    }
    const jobEvents = /^\/v1\/jobs\/([^/]+)\/events$/.exec(path);
    if (jobEvents && method === 'GET') {
      streamJob(req, res, decodeURIComponent(jobEvents[1]));
      return;
    }
    const jobDoc = /^\/v1\/jobs\/([^/]+)$/.exec(path);
    if (jobDoc && method === 'GET') {
      const job = jobs.find((j) => j.jobId === decodeURIComponent(jobDoc[1]));
      if (job === undefined) {
        refusal(res, 404, 'unknown_job', `no job ${jobDoc[1]}`);
        return;
      }
      send(res, 200, jobStatusDoc(job));
      return;
    }
    if (jobDoc && method === 'DELETE') {
      const job = jobs.find((j) => j.jobId === decodeURIComponent(jobDoc[1]));
      if (job === undefined) {
        refusal(res, 404, 'unknown_job', `no job ${jobDoc[1]}`);
        return;
      }
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        refusal(res, 409, 'job_not_cancellable', `job ${job.jobId} is ${job.status}`);
        return;
      }
      const wasQueued = job.status === 'queued';
      job.status = 'cancelled';
      pushJobEvent(job, 'cancelled', { status: 'cancelled' });
      send(res, 200, { job_id: job.jobId, status: wasQueued ? 'cancelled' : 'cancelling' });
      return;
    }

    // ── chat (P3) ────────────────────────────────────────────────────────
    if (path === '/v1/openai/chat/completions' && method === 'POST') {
      await chat(req, res, body);
      return;
    }
    // ── decide (P6, PHASE22) ─────────────────────────────────────────────
    if (path === '/v1/decide' && method === 'POST') {
      await decide(req, res, body);
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
      if (resident !== model) {
        refusal(res, 409, 'not_resident', `'${model}' is not resident${resident ? `; '${resident}' is` : ''}`, { resident });
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
      if (foreignFinishTimer !== null) clearTimeout(foreignFinishTimer);
      foreignFinishTimer = null;
      if (next.taskBusy !== undefined) {
        foreignTask.state = 'running';
        foreignTask.events = [{ id: 1, event: 'started', data: { type: 'module' } }];
        if (next.taskBusy.finishAfterMs !== undefined) {
          foreignFinishTimer = setTimeout(() => {
            foreignTask.state = 'done';
            pushTaskEvent(foreignTask, 'done', {});
          }, next.taskBusy.finishAfterMs);
          foreignFinishTimer.unref?.();
        }
      }
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
    tasks,
    catalog,
    installedJobTypes,
    jobs,
    resident: () => resident,
    setResident(model: string | null): void {
      resident = model;
      residentCtx = null;
      if (openLease !== null && openLease.model !== model) openLease = null;
    },
    expireLease(): void {
      openLease = null;
    },
    openLease: () => (openLease === null ? null : { ...openLease }),
    leaseAsOther(model: string, client: string): void {
      resident = model;
      openLease = { leaseId: `lease-${nextLease++}`, model, client, act: 'translate' };
    },
    chatBodies(): Array<Record<string, unknown>> {
      return requests.filter((r) => r.path === '/v1/openai/chat/completions' && r.method === 'POST').map((r) => r.body as Record<string, unknown>);
    },
    uploads,
    heldBlobs: () => [...blobs.keys()],
    forgetBlobs(): void {
      blobs.clear();
    },
    setAsr(script: FakeAsrScript): void {
      asrScript = { ...script };
    },
    setDecideProbs(fn: FakeDecideProbs | undefined): void {
      decideProbs = fn;
    },
    decideBodies(): Array<Record<string, unknown>> {
      return requests.filter((r) => r.path === '/v1/decide' && r.method === 'POST').map((r) => r.body as Record<string, unknown>);
    },
    residentContext: () => residentCtx,
    setOmit: (next: FieldOmissions) => { omit = next; },
    requestsTo(prefix: string, m?: string): RecordedRequest[] {
      return requests.filter((r) => r.path.startsWith(prefix) && (m === undefined || r.method === m));
    },
    close(): Promise<void> {
      if (foreignFinishTimer !== null) clearTimeout(foreignFinishTimer);
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
