/**
 * ONE CRUCIBLE `asr` JOB, END TO END: upload → submit → follow events → fetch
 * `transcript.json` (migration plan §6.6, P5).
 *
 * Salvaged from the reference branch's `crucible-job.ts` (bbb7ef6, itself cut
 * down from BookForge's electron/crucible/job.ts). Kept: uploads streamed from
 * disk (`fs.openAsBlob`, never read whole); a submit whose answer never came
 * (CrucibleUnreachable: refused before connecting, OR admitted and the answer
 * lost) is looked up by its `client_ref` before it is sent again, so a lost
 * answer never becomes a second job on the card; cancel is a `DELETE`, not a
 * hang-up (abandoning the stream leaves the job running and holding the
 * lane); a dropped event stream is re-opened above the last event seen
 * (`Last-Event-ID`) on a stated budget, and past it the job is DELETEd (this
 * side owns the hold it created).
 *
 * Changed for Briefcase: every way it ends is one of FOUR outcomes the queue
 * acts on differently, instead of the reference's "refused by name":
 *
 *   CrucibleParkedError       the card is busy (409 server_busy / leased at the
 *                             submit): the queue PARKS the task (P4's rule).
 *   CrucibleAsrUnavailable    Crucible could not take or finish the work for an
 *                             infrastructure reason (unreachable, no asr, the
 *                             model not offered, the token refused, the stream
 *                             lost past its budget): the queue PARKS the
 *                             task until Crucible answers (P7: no other
 *                             transcriber).
 *   CrucibleAsrCancelled      ours or the server's cancel. Never retried.
 *   CrucibleAsrJobFailed      the server admitted the job, ran it, and it
 *                             failed (a bad window, a decode error): the task
 *                             fails with the server's own message.
 *
 * And P4's in-flight ledger: the job is written down the moment it is
 * admitted and settled when it ends, so a hard kill mid-transcription leaves a
 * row the startup sweep DELETEs.
 */
import * as fs from 'fs';
import {
  CrucibleAuthError,
  CrucibleBusy,
  CrucibleLeased,
  CrucibleNotACrucible,
  CrucibleProtocolError,
  CrucibleRefused,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';
import type { CrucibleClient, JobEvent, UploadResult } from '@crucible/client';
import { EngineResolveError } from '../engine-resolve';
import { CrucibleRegistryError } from '../errors';
import { CrucibleParkedError } from '../llm/errors';
import { crucibleUnavailableCause } from '../transport-failure';

/** Crucible could not take or finish the job for an infrastructure reason. The queue parks the task. */
export class CrucibleAsrUnavailable extends Error {
  constructor(readonly code: string, readonly server: string, message: string) {
    super(message);
    this.name = 'CrucibleAsrUnavailable';
  }
}

/** The server ran the job and it failed. Not retried: time was spent and the server said why. */
export class CrucibleAsrJobFailed extends Error {
  constructor(readonly server: string, readonly jobId: string, readonly code: string, readonly serverMessage: string) {
    super(`Crucible on ${server} could not transcribe this video (${code}): ${serverMessage}`);
    this.name = 'CrucibleAsrJobFailed';
  }
}

/** The job was cancelled (ours, or somebody's DELETE on the server). Carries the structural cancel marker. */
export class CrucibleAsrCancelled extends Error {
  readonly code = 'cancelled';
  readonly cancelled = true;
  constructor(readonly server: string, readonly jobId: string | null, message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAsrUnavailable(err: unknown): err is CrucibleAsrUnavailable {
  return err instanceof CrucibleAsrUnavailable;
}

/**
 * An SDK error at the door (upload, submit) as one of the outcomes above.
 * Anything that is not the SDK's comes back unchanged.
 */
export function classifyAsrRefusal(err: unknown, server: string, verb: string): unknown {
  const at = `Crucible on ${server}`;
  if (err instanceof CrucibleBusy) return new CrucibleParkedError(server, err.busyLine);
  if (err instanceof CrucibleLeased) return new CrucibleParkedError(server, err.leasedLine);
  const down = crucibleUnavailableCause(err);
  if (down !== null) return new CrucibleAsrUnavailable('crucible_unreachable', server, `${at} could not be reached for ${verb} (${down}).`);
  if (err instanceof CrucibleAuthError) {
    return new CrucibleAsrUnavailable(err.code, server, `${at} refused this computer's token (${err.serverMessage}). Pair it again in Settings › Crucible Servers.`);
  }
  if (err instanceof CrucibleVersionError) {
    return new CrucibleAsrUnavailable(err.code, server, `${at} speaks a different API version (${err.serverMessage}).`);
  }
  if (err instanceof CrucibleNotACrucible) return new CrucibleAsrUnavailable('crucible_not_a_crucible', server, `${at} is not a Crucible.`);
  if (err instanceof CrucibleProtocolError) {
    return new CrucibleAsrUnavailable('crucible_protocol', server, `${at} answered ${verb} with something API v1 does not describe: ${err.detail}.`);
  }
  if (err instanceof CrucibleRefused) {
    return new CrucibleAsrUnavailable(err.code, server, `${at} refused ${verb} (${err.code}): ${err.serverMessage}`);
  }
  // The server was removed since the task was placed, or its address leads to no engine.
  if (err instanceof CrucibleRegistryError || err instanceof EngineResolveError) {
    return new CrucibleAsrUnavailable(err.code, server, `${at} can't be used (${err.message}).`);
  }
  return err;
}

/** Retry budgets. Before admission a dead server should fall back soon; a running job is worth waiting for. */
export const DOOR_DELAYS_MS: readonly number[] = [1_000, 3_000];
export const STREAM_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000, 45_000];
/**
 * An upload in flight reports this often. A big video to a remote server can
 * take longer than the lane's stall watchdog (15 min; 10 inline) allows a
 * task to be silent, and the server says nothing until the last byte lands.
 */
export const UPLOAD_TICK_MS = 5_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Progress as the server reported it, already sorted by stage. */
export type AsrJobProgress =
  /** `sentBytes` is null when this runtime can't count them (the beat still comes). */
  | { readonly kind: 'uploading'; readonly sentBytes: number | null; readonly totalBytes: number }
  | { readonly kind: 'queued'; readonly position: number | null }
  /** `message`: the engine's readiness line, or null when the frame carried none. */
  | { readonly kind: 'warming'; readonly message: string | null }
  | { readonly kind: 'decoding'; readonly processedS: number | null; readonly totalS: number | null; readonly message: string | null }
  /** `fraction`: the server's own, or where it last put it when a frame states none (0 before any). */
  | { readonly kind: 'transcribing'; readonly fraction: number; readonly processedS: number | null; readonly totalS: number | null; readonly message: string | null };

/** The asr params, exactly the three the server takes (it refuses anything else). */
export interface AsrParams {
  readonly language: string;
  readonly vad_filter: boolean;
  readonly word_timestamps: boolean;
}

/**
 * Where an upload is kept between runs of one task, so a task parked after
 * its upload (the lane busy at the submit) sends the video once, not once per
 * park. A job consumes the blob it names, so it is dropped at admission.
 */
export interface AsrBlobCache {
  /** The SDK's own upload answer: `blobId` is load-bearing; `sha256`/`bytes` are informational (null when unstated). */
  get(): Pick<UploadResult, 'blobId' | 'sha256'> | null;
  set(upload: UploadResult): void;
  drop(): void;
}

/** The server no longer has the blob we named: never held (a restart cleaned uploads/), or already taken by a job. */
function isStaleBlob(err: unknown): boolean {
  return err instanceof CrucibleRefused && (err.code === 'unknown_blob' || err.code === 'blob_consumed');
}

export interface AsrJobLedger {
  record(jobId: string): void;
  settle(jobId: string): void;
}

export interface RunAsrJobOptions {
  readonly client: CrucibleClient;
  /** The registry name, for every sentence and the ledger. */
  readonly server: string;
  readonly model: string;
  readonly params: AsrParams;
  /** The media file. Any container ffmpeg reads; the server windows it. */
  readonly file: string;
  /** Its name on the server. The extension is load-bearing: ffmpeg reads the container off it. */
  readonly filename: string;
  /**
   * Names this submission on the server. Make it unique per call: a submit
   * whose answer was lost is found again by it (`GET /v1/activity`, then each
   * candidate's `client_ref`), and so is our own job named by a refusal.
   */
  readonly clientRef?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AsrJobProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly ledger?: AsrJobLedger;
  /** An earlier run's upload of this file on this server, reused when the server still has it. */
  readonly blobCache?: AsrBlobCache;
  /** Only a spec overrides these. */
  readonly doorDelaysMs?: readonly number[];
  readonly streamDelaysMs?: readonly number[];
  /** How often an upload in flight reports (bytes sent, or at least that it is alive). */
  readonly uploadTickMs?: number;
}

export interface AsrJobOutcome {
  readonly jobId: string;
  /** `transcript.json`, JSON-parsed. */
  readonly transcript: unknown;
}

/** `fs.openAsBlob` typed as the optional it is on older runtimes. */
const openAsBlob: ((p: string) => Promise<Blob>) | undefined =
  (fs as unknown as { openAsBlob?: (p: string) => Promise<Blob> }).openAsBlob;

/**
 * The file as a blob-like whose stream counts the bytes read from it as the
 * request body pulls them (under backpressure, so: roughly bytes sent). A
 * plain object and not a Blob subclass on purpose: FormData re-wraps a Blob
 * (subclass or not) in a fresh File, which reads the file itself and bypasses
 * any override, while a blob-LIKE is wrapped by delegation. Null when this
 * runtime's FormData refuses one: the upload then goes as the plain blob and
 * the progress beat carries no byte count.
 */
function countingBlob(blob: Blob, filename: string, onBytes: (n: number) => void): Blob | null {
  const like = {
    size: blob.size,
    type: blob.type,
    name: filename,
    lastModified: Date.now(),
    [Symbol.toStringTag]: 'File',
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
    slice: (start?: number, end?: number, type?: string) => blob.slice(start, end, type),
    stream: (): ReadableStream<Uint8Array> => {
      const reader = (blob.stream() as ReadableStream<Uint8Array>).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          onBytes(value.byteLength);
          controller.enqueue(value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    },
  };
  try {
    new FormData().append('probe', like as unknown as Blob, filename);
    return like as unknown as Blob;
  } catch {
    return null;
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A warming line without the engine's log tail (Crucible appends it after an em dash); null when the frame carried none. */
export function warmingHeadline(message: string | null): string | null {
  if (message === null) return null;
  const cut = message.indexOf(' — ');
  return cut < 0 ? message : message.slice(0, cut);
}

/** The job a submit refusal names: the lane's holder (`server_busy`), or the job that took our blob (`blob_consumed`). */
function jobNamedBy(err: unknown): string | null {
  if (err instanceof CrucibleBusy) return err.jobId;
  if (err instanceof CrucibleRefused && err.code === 'blob_consumed') {
    const details = err.details as { job_id?: unknown } | null;
    return typeof details?.job_id === 'string' ? details.job_id : null;
  }
  return null;
}

async function isOurs(client: CrucibleClient, jobId: string, clientRef: string): Promise<boolean> {
  try {
    return (await client.job(jobId)).clientRef === clientRef;
  } catch {
    return false;
  }
}

/**
 * An admitted asr job carrying `clientRef`, or null. Crucible has no lookup by
 * client_ref, so the lane's running and queued jobs are read from
 * `/v1/activity` and each asr one's own record is asked. Any failure is "not
 * found": the resend's refusal gets a second look (jobNamedBy).
 */
export async function findByClientRef(client: CrucibleClient, clientRef: string): Promise<string | null> {
  try {
    const activity = await client.activity();
    for (const job of [...activity.running, ...activity.queued]) {
      if (job.type === 'asr' && await isOurs(client, job.jobId, clientRef)) return job.jobId;
    }
  } catch {
    // Not found is the safe reading: the resend is still checked.
  }
  return null;
}

export async function runAsrJob(options: RunAsrJobOptions): Promise<AsrJobOutcome> {
  const { client, server, signal } = options;
  const log = options.onLog ?? ((): void => undefined);
  const doorDelays = options.doorDelaysMs ?? DOOR_DELAYS_MS;
  const streamDelays = options.streamDelaysMs ?? STREAM_DELAYS_MS;
  const cancelledBeforeSubmit = (): CrucibleAsrCancelled =>
    new CrucibleAsrCancelled(server, null, 'The transcription was cancelled before it reached Crucible.');

  if (signal?.aborted) throw cancelledBeforeSubmit();
  let size: number;
  try {
    size = fs.statSync(options.file).size;
  } catch {
    throw new Error(`Video file not found: ${options.file}`);
  }
  if (size === 0) throw new Error(`The video file is empty: ${options.file}`);
  if (openAsBlob === undefined) {
    throw new CrucibleAsrUnavailable('crucible_runtime_too_old', server,
      `uploading to Crucible needs fs.openAsBlob (Node 19.8+), which this runtime (${process.versions.node}) lacks.`);
  }

  // ── Upload. A re-upload is harmless (a second blob), so weather is retried. ──
  const upload = async (): Promise<string> => {
    let uploaded: UploadResult | undefined;
    for (let attempt = 0; uploaded === undefined; attempt++) {
      // Reported at once, then every tick until the server answers: bytes sent
      // when they can be counted, and a beat for the stall watchdog either way.
      let sent = 0;
      const blob = await openAsBlob(options.file);
      const counted = countingBlob(blob, options.filename, (n) => { sent += n; });
      const report = (): void => options.onProgress?.({ kind: 'uploading', sentBytes: counted === null ? null : Math.min(sent, size), totalBytes: size });
      report();
      const ticker = setInterval(report, options.uploadTickMs ?? UPLOAD_TICK_MS);
      ticker.unref?.();
      try {
        uploaded = await client.upload(counted ?? blob, { filename: options.filename });
        report();
      } catch (err) {
        // A cancel during the retry wait wakes the sleep early; the attempt that
        // follows must not turn it into "unreachable", which would fall back.
        if (signal?.aborted) throw cancelledBeforeSubmit();
        const classified = classifyAsrRefusal(err, server, 'the upload');
        if (classified instanceof CrucibleAsrUnavailable && classified.code === 'crucible_unreachable'
          && attempt < doorDelays.length && !signal?.aborted) {
          log(`upload to ${server} failed (${classified.message}); trying again in ${doorDelays[attempt]! / 1000}s`);
          await sleep(doorDelays[attempt]!, signal);
          if (signal?.aborted) throw cancelledBeforeSubmit();
          continue;
        }
        throw classified;
      } finally {
        clearInterval(ticker);
      }
    }
    options.blobCache?.set(uploaded);
    return uploaded.blobId;
  };

  // A parked task's earlier upload, when there is one: the server is asked for
  // it by name at the submit, and a refusal saying it is gone uploads once more.
  const cached = options.blobCache?.get() ?? null;
  let reusing = cached !== null;
  let blobId: string;
  if (cached !== null) {
    blobId = cached.blobId;
    log(`reusing the earlier upload of this video on ${server} (blob ${cached.blobId}, sha256 ${cached.sha256?.slice(0, 12) ?? 'not stated'})`);
  } else {
    blobId = await upload();
  }
  if (signal?.aborted) throw cancelledBeforeSubmit();

  // ── Submit: THE RESERVATION. ──
  // A submit that got no answer may still have been admitted (the answer, not
  // the request, was lost). Before it is sent again the job is looked for by
  // its client_ref, and a refusal on the resend that names a job (the lane
  // busy with it, or our blob consumed by it) is checked the same way: finding
  // our own job means adopting it, never a second job on the card.
  const clientRef = options.clientRef;
  let unanswered = false;
  let jobId: string | undefined;
  for (let attempt = 0; jobId === undefined; attempt++) {
    try {
      jobId = await client.submit({
        type: 'asr',
        model: options.model,
        params: { ...options.params },
        inputs: { [options.filename]: { blobId } },
        ...(clientRef === undefined ? {} : { clientRef }),
      });
    } catch (err) {
      if (signal?.aborted) throw cancelledBeforeSubmit();
      if (unanswered && clientRef !== undefined) {
        const named = jobNamedBy(err);
        if (named !== null && await isOurs(client, named, clientRef)) {
          log(`${server} named asr job ${named} as ours (${clientRef}); the earlier unanswered submit was admitted`);
          jobId = named;
          break;
        }
      }
      if (reusing && isStaleBlob(err)) {
        reusing = false;
        options.blobCache?.drop();
        log(`${server} no longer holds the earlier upload (${(err as CrucibleRefused).code}); uploading the video again`);
        blobId = await upload();
        if (signal?.aborted) throw cancelledBeforeSubmit();
        attempt -= 1; // the re-upload is not a door retry
        continue;
      }
      if (err instanceof CrucibleUnreachable) {
        unanswered = true;
        if (clientRef !== undefined) {
          const found = await findByClientRef(client, clientRef);
          if (found !== null) {
            log(`${server} had admitted the unanswered asr submit as job ${found} (${clientRef}); following it`);
            jobId = found;
            break;
          }
        }
        if (attempt < doorDelays.length) {
          log(`${server} did not answer the asr submit (${err.message}); asking again in ${doorDelays[attempt]! / 1000}s`);
          await sleep(doorDelays[attempt]!, signal);
          if (signal?.aborted) throw cancelledBeforeSubmit();
          continue;
        }
      }
      throw classifyAsrRefusal(err, server, 'the asr job');
    }
  }
  const admitted = jobId;
  // The job took the blob (an upload is moved into the job that names it).
  options.blobCache?.drop();
  options.ledger?.record(admitted);
  log(`${server} admitted asr job ${admitted} (${options.model})`);

  // ── Cancel is a DELETE. ──
  let cancelAsked = false;
  let cancelAccepted = false;
  const cancel = async (why: string): Promise<void> => {
    if (cancelAsked) return;
    cancelAsked = true;
    log(`cancelling asr job ${admitted} on ${server} (${why})`);
    try {
      const result = await client.cancel(admitted);
      cancelAccepted = true;
      log(`asr job ${admitted} on ${server} is ${result.status}`);
    } catch (err) {
      log(`the cancel of asr job ${admitted} on ${server} was not accepted: ${(err as Error)?.message ?? err}`);
    }
  };
  const onAbort = (): void => { void cancel('cancel requested'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // ── Follow the events, re-opening above the last one on weather. ──
  let terminal: JobEvent | null = null;
  let lastEventId = 0;
  let lastFraction = 0;
  let failures = 0;
  try {
    while (terminal === null) {
      try {
        const resume = lastEventId > 0 ? { lastEventId } : {};
        for await (const event of client.events(admitted, resume)) {
          failures = 0;
          if (event.id > lastEventId) lastEventId = event.id;
          if (event.event === 'queued') {
            options.onProgress?.({ kind: 'queued', position: event.data.position });
          } else if (event.event === 'warming') {
            options.onProgress?.({ kind: 'warming', message: warmingHeadline(event.data.message) });
          } else if (event.event === 'progress') {
            const extra = event.data.extra ?? {};
            const processedS = numOrNull(extra['processed_s']);
            const totalS = numOrNull(extra['total_s']);
            if (extra['stage'] === 'decoding') {
              options.onProgress?.({ kind: 'decoding', processedS, totalS, message: event.data.message });
            } else {
              // A frame that states no fraction leaves it where the server last put it.
              if (event.data.fraction !== null) lastFraction = event.data.fraction;
              options.onProgress?.({ kind: 'transcribing', fraction: lastFraction, processedS, totalS, message: event.data.message });
            }
          } else if (event.event === 'done' || event.event === 'failed' || event.event === 'cancelled') {
            terminal = event;
          }
        }
        if (terminal === null) throw new CrucibleUnreachable('', `the event stream for ${admitted} ended with no terminal event`);
      } catch (err) {
        const wire = crucibleUnavailableCause(err);
        if (cancelAsked) {
          throw new CrucibleAsrCancelled(server, admitted, `The transcription was cancelled (Crucible job ${admitted} on ${server}).`);
        }
        if (wire === null) {
          // Not weather (a protocol or auth error on the stream): the job is
          // still admitted and holding the card. DELETE it before the task
          // parks, or a retry and the orphan transcribe the same video at once.
          await cancel(`the event stream failed: ${(err as Error)?.message ?? err}`);
          throw classifyAsrRefusal(err, server, `the events of asr job ${admitted}`);
        }
        if (failures >= streamDelays.length) {
          await cancel('event stream lost past its budget');
          throw new CrucibleAsrUnavailable('crucible_stream_lost', server,
            `Lost the connection to Crucible on ${server} while it transcribed (${wire}); the job was cancelled rather than left holding the card.`);
        }
        const wait = streamDelays[failures]!;
        failures += 1;
        log(`the event stream for ${admitted} on ${server} dropped (${wire}); re-opening after event ${lastEventId} in ${wait / 1000}s`);
        await sleep(wait, signal);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // A job that reached a terminal event, or whose DELETE the server took, holds nothing.
    if (terminal !== null || cancelAccepted) options.ledger?.settle(admitted);
  }

  const ended = terminal as JobEvent;
  if (ended.event === 'cancelled') {
    throw new CrucibleAsrCancelled(server, admitted, cancelAsked
      ? `The transcription was cancelled (Crucible job ${admitted} on ${server}).`
      : `Crucible on ${server} cancelled the transcription (job ${admitted}).`);
  }
  if (ended.event === 'failed') {
    throw new CrucibleAsrJobFailed(server, admitted, ended.data.error.code, ended.data.error.message);
  }

  // ── Fetch transcript.json, retrying weather on the long budget. ──
  let bytes: Uint8Array | undefined;
  for (let attempt = 0; bytes === undefined; attempt++) {
    try {
      bytes = await client.artifact(admitted, 'transcript.json');
    } catch (err) {
      const wire = crucibleUnavailableCause(err);
      if (wire !== null && attempt < streamDelays.length) {
        log(`fetching transcript.json of ${admitted} failed (${wire}); trying again in ${streamDelays[attempt]! / 1000}s`);
        await sleep(streamDelays[attempt]!);
        continue;
      }
      const classified = classifyAsrRefusal(err, server, `fetching transcript.json of job ${admitted}`);
      throw classified;
    }
  }
  let transcript: unknown;
  try {
    transcript = JSON.parse(Buffer.from(bytes).toString('utf-8'));
  } catch (err) {
    throw new CrucibleAsrJobFailed(server, admitted, 'crucible_asr_transcript_unreadable', `transcript.json is not JSON (${(err as Error).message})`);
  }
  log(`asr job ${admitted} on ${server} done`);
  return { jobId: admitted, transcript };
}
