/**
 * ONE CRUCIBLE `asr` JOB, END TO END: upload → submit → follow events → fetch
 * `transcript.json` (migration plan §6.6, P5).
 *
 * Salvaged from the reference branch's `crucible-job.ts` (bbb7ef6, itself cut
 * down from BookForge's electron/crucible/job.ts). Kept: uploads streamed from
 * disk (`fs.openAsBlob`, never read whole); a submit retried ONLY when no
 * connection was ever made (a lost answer may have been admitted, and a second
 * submit would be a second job on the card); cancel is a `DELETE`, not a
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
 *                             lost past its budget): the caller FALLS BACK to
 *                             whisper-cli with a warning.
 *   CrucibleAsrCancelled      ours or the server's cancel. Never a fallback.
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
import type { CrucibleClient, JobEvent } from '@crucible/client';
import { EngineResolveError } from '../engine-resolve';
import { CrucibleRegistryError } from '../errors';
import { CrucibleParkedError } from '../llm/errors';
import { crucibleUnavailableCause } from '../transport-failure';

/** Crucible could not take or finish the job for an infrastructure reason. The caller falls back. */
export class CrucibleAsrUnavailable extends Error {
  constructor(readonly code: string, readonly server: string, message: string) {
    super(message);
    this.name = 'CrucibleAsrUnavailable';
  }
}

/** The server ran the job and it failed. Not a fallback: time was spent and the server said why. */
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
  | { readonly kind: 'uploading' }
  | { readonly kind: 'queued'; readonly position: number | null }
  | { readonly kind: 'warming'; readonly message: string }
  | { readonly kind: 'decoding'; readonly processedS: number | null; readonly totalS: number | null; readonly message: string }
  | { readonly kind: 'transcribing'; readonly fraction: number; readonly processedS: number | null; readonly totalS: number | null; readonly message: string };

/** The asr params, exactly the three the server takes (it refuses anything else). */
export interface AsrParams {
  readonly language: string;
  readonly vad_filter: boolean;
  readonly word_timestamps: boolean;
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
  readonly clientRef?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AsrJobProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly ledger?: AsrJobLedger;
  /** Only a spec overrides these. */
  readonly doorDelaysMs?: readonly number[];
  readonly streamDelaysMs?: readonly number[];
}

export interface AsrJobOutcome {
  readonly jobId: string;
  /** `transcript.json`, JSON-parsed. */
  readonly transcript: unknown;
}

/** `fs.openAsBlob` typed as the optional it is on older runtimes. */
const openAsBlob: ((p: string) => Promise<Blob>) | undefined =
  (fs as unknown as { openAsBlob?: (p: string) => Promise<Blob> }).openAsBlob;

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A warming line without the engine's log tail (Crucible appends it after an em dash). */
export function warmingHeadline(message: string): string {
  const cut = message.indexOf(' — ');
  return cut < 0 ? message : message.slice(0, cut);
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
  options.onProgress?.({ kind: 'uploading' });
  let blobId: string | undefined;
  for (let attempt = 0; blobId === undefined; attempt++) {
    try {
      blobId = (await client.upload(await openAsBlob(options.file), { filename: options.filename })).blobId;
    } catch (err) {
      const classified = classifyAsrRefusal(err, server, 'the upload');
      if (classified instanceof CrucibleAsrUnavailable && classified.code === 'crucible_unreachable'
        && attempt < doorDelays.length && !signal?.aborted) {
        log(`upload to ${server} failed (${classified.message}); trying again in ${doorDelays[attempt]! / 1000}s`);
        await sleep(doorDelays[attempt]!, signal);
        continue;
      }
      throw classified;
    }
  }
  if (signal?.aborted) throw cancelledBeforeSubmit();

  // ── Submit: THE RESERVATION. Retried only when no connection was ever made. ──
  let jobId: string | undefined;
  for (let attempt = 0; jobId === undefined; attempt++) {
    try {
      jobId = await client.submit({
        type: 'asr',
        model: options.model,
        params: { ...options.params },
        inputs: { [options.filename]: { blobId } },
        ...(options.clientRef === undefined ? {} : { clientRef: options.clientRef }),
      });
    } catch (err) {
      if (err instanceof CrucibleUnreachable && attempt < doorDelays.length && !signal?.aborted) {
        log(`${server} did not answer the asr submit (${err.message}); asking again in ${doorDelays[attempt]! / 1000}s`);
        await sleep(doorDelays[attempt]!, signal);
        continue;
      }
      throw classifyAsrRefusal(err, server, 'the asr job');
    }
  }
  const admitted = jobId;
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
              options.onProgress?.({ kind: 'transcribing', fraction: event.data.fraction, processedS, totalS, message: event.data.message });
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
        if (wire === null) throw classifyAsrRefusal(err, server, `the events of asr job ${admitted}`);
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
