/**
 * TRANSCRIBE ON A CRUCIBLE: the `asr` door, and the venue rule's host (P5).
 *
 * `WhisperService.transcribe` is the one seam every caller goes through (the
 * queue, the simple-transcribe door). It hands the VIDEO itself here, not an
 * extracted WAV: the server reads any container ffmpeg reads and windows it
 * (900 s windows, 15 s overlap), so nothing is chunked or extracted on this
 * side. `transcript.json` comes back, and an SRT and its plain text are
 * written in the job's output directory for the caller to relocate.
 *
 * What the job sends (all three params are required and Crucible defaults
 * none), Qwen3-ASR's (asr-models.ts qwenAsrParams): `language` "en" unless
 * stated (Qwen cannot detect), `vad_filter: false`, and words, which cut its
 * 180 s pieces into cues.
 *
 * Salvaged from the reference branch's `crucible-transcription.service.ts`
 * (bbb7ef6). Its registry and servers seam are NOT used: P1's
 * `CrucibleServersService` is the real one. Added: the venue rule's host,
 * P4's in-flight ledger, and the settings/view door the pane reads.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { UploadResult } from '@crucible/client';
import { CrucibleClientFactory } from '../client-factory';
import { CRUCIBLE_IN_FLIGHT_LEDGER } from '../crucible.constants';
import { CrucibleServersService } from '../crucible-servers.service';
import type { InFlightLedger } from '../in-flight-ledger';
import { CrucibleProbeService } from '../probe';
import type { TranscriptionServerView, TranscriptionView } from '../wire/transcription-wire';
import { QWEN_ALIGNER_MODEL, QWEN_ASR_MODEL, asrOfferOf, qwenAsrParams, qwenUnavailable, type AsrOffer } from './asr-models';
import { classifyAsrRefusal, runAsrJob, type AsrBlobCache, type AsrJobProgress, type RunAsrJobOptions } from './crucible-asr-job';
import { transcriptToSrt } from './crucible-transcript';
import { decideTranscriptionRoute, type TranscriptionRoute, type TranscriptionVenueHost } from './transcription-venue';

/** `/v1/info` is read at most this often per server for the venue rule. */
export const ASR_OFFER_CACHE_MS = 30_000;
/** Uploads remembered for reuse (a parked task's video), oldest dropped first. */
export const ASR_BLOB_CACHE_MAX = 32;

export interface CrucibleTranscriptionRequest {
  readonly server: string;
  readonly model: string;
  /** The media file, sent as it is. */
  readonly videoFile: string;
  /** Where the SRT and TXT are written: the job's temp directory. */
  readonly outputDir: string;
  /** The SRT's and TXT's base name (no extension). */
  readonly baseName: string;
  /** Briefcase's queue job id: the ledger's `localId`, the log prefix and the clientRef's stem. */
  readonly localId: string;
  readonly language?: string | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (percent: number, message: string) => void;
}

export interface CrucibleTranscriptionOutcome {
  readonly srtFile: string;
  /** The cues' text, one per line: the transcript's plain text. */
  readonly txtFile: string;
  readonly jobId: string;
  readonly cues: number;
  readonly model: string;
  readonly revision: string;
  readonly language: string;
}

/** `812.0 KB`, `1.4 GB`: one decimal, binary units. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** `HH:MM:SS`, the app's time format. */
export function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Crucible's progress → the transcribe task's `{percent, message}`.
 *
 *   0–2     WhisperService's own start
 *   3–6     uploading the video (by bytes sent; the message says how many)
 *   7       queued on the server
 *   9       warming (the whisper model loading)
 *   10–14   decoding (drives no fraction on the server; moved by processed_s/total_s when sent)
 *   15–95   transcribing: the SERVER's fraction, never re-derived here
 *   95–100  saving (MediaOperationsService)
 */
export function asrProgressToTask(server: string, p: AsrJobProgress): { percent: number; message: string } {
  const where = (processed: number | null, total: number | null): string =>
    processed !== null && total !== null && total > 0 ? ` ${hms(processed)} of ${hms(total)}` : '';
  switch (p.kind) {
    case 'uploading': {
      if (p.sentBytes === null || p.totalBytes <= 0 || p.sentBytes <= 0) {
        return { percent: 3, message: `Uploading the video to Crucible on ${server}...` };
      }
      const share = Math.min(1, p.sentBytes / p.totalBytes);
      return { percent: 3 + Math.round(share * 3), message: `Uploading the video to Crucible on ${server}... ${formatBytes(p.sentBytes)} of ${formatBytes(p.totalBytes)}` };
    }
    case 'queued':
      return { percent: 7, message: `Queued on Crucible on ${server}${p.position !== null && p.position > 0 ? ` (position ${p.position})` : ''}...` };
    case 'warming':
      return { percent: 9, message: `Crucible on ${server}: ${p.message ?? 'loading the model...'}` };
    case 'decoding': {
      const share = p.processedS !== null && p.totalS !== null && p.totalS > 0 ? Math.min(1, Math.max(0, p.processedS / p.totalS)) : 0;
      return { percent: 10 + Math.round(share * 4), message: `Reading the audio on ${server}...${where(p.processedS, p.totalS)}` };
    }
    case 'transcribing': {
      const fraction = Math.min(1, Math.max(0, Number.isFinite(p.fraction) ? p.fraction : 0));
      return { percent: 15 + Math.round(fraction * 80), message: `Transcribing on ${server}...${where(p.processedS, p.totalS)}` };
    }
  }
}

@Injectable()
export class CrucibleTranscriptionService {
  private readonly logger = new Logger('CrucibleTranscription');
  private readonly offers = new Map<string, { at: number; offer: AsrOffer }>();
  /**
   * Uploads not yet consumed by a job, per server and file (path, size and
   * mtime: a changed file is a new key). A task parked at the submit (the lane
   * busy) keeps its upload here, so its next run names the same blob instead
   * of sending the whole video again.
   */
  private readonly blobs = new Map<string, UploadResult>();

  /** Replaceable by a spec. */
  now: () => number = Date.now;
  /** Only a spec shortens these. */
  jobTiming: Pick<RunAsrJobOptions, 'doorDelaysMs' | 'streamDelaysMs' | 'uploadTickMs'> = {};

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly probes: CrucibleProbeService,
    private readonly factory: CrucibleClientFactory,
    @Optional() @Inject(CRUCIBLE_IN_FLIGHT_LEDGER) private readonly ledger?: InFlightLedger,
  ) {}

  // ── the venue rule ─────────────────────────────────────────────────────

  private host(): TranscriptionVenueHost {
    return {
      selected: () => this.servers.selected(),
      reach: async (server) => {
        const answer = await this.probes.reach(server);
        return { reach: answer.reach, message: answer.probe.outcome === 'ok' ? undefined : answer.probe.message };
      },
      asrOffer: (server) => this.asrOffer(server),
    };
  }

  /** Where a transcription runs right now. Never throws: a venue that cannot be decided is `none`, with why. */
  async route(): Promise<TranscriptionRoute> {
    try {
      return await decideTranscriptionRoute(this.host());
    } catch (err) {
      const why = (err as Error)?.message ?? String(err);
      this.logger.warn(`The transcription venue could not be decided (${why}).`);
      return { kind: 'none', reason: `Where to transcribe could not be decided (${why}).` };
    }
  }

  /** `/v1/info` read for asr, cached {@link ASR_OFFER_CACHE_MS}. */
  async asrOffer(server: string, fresh = false): Promise<AsrOffer> {
    const cached = this.offers.get(server);
    if (!fresh && cached !== undefined && this.now() - cached.at < ASR_OFFER_CACHE_MS) return cached.offer;
    const client = await this.factory.clientFor(server, { timeoutMs: 5_000 });
    const offer = asrOfferOf(await client.info({ timeoutMs: 5_000 }));
    this.offers.set(server, { at: this.now(), offer });
    return offer;
  }

  forget(server?: string): void {
    if (server === undefined) this.offers.clear();
    else this.offers.delete(server);
  }

  // ── the pane's view ────────────────────────────────────────────────────

  async view(): Promise<TranscriptionView> {
    let selected: string | null = null;
    try {
      selected = this.servers.routing().selected;
    } catch {
      selected = null;
    }
    let server: TranscriptionServerView | null = null;
    let model = QWEN_ASR_MODEL;
    if (selected !== null) {
      const view: TranscriptionServerView = {
        name: selected, reach: null, backend: null, qwen: null, aligner: null, unavailable: null,
      };
      try {
        const answer = await this.probes.reach(selected);
        view.reach = answer.reach;
        if (answer.reach !== 'ready' && answer.reach !== 'busy') {
          view.unavailable = answer.probe.outcome === 'ok' ? `Crucible on ${selected} isn't answering.` : answer.probe.message;
        } else {
          const offer = await this.asrOffer(selected, true);
          view.backend = offer.backend;
          model = offer.model;
          view.qwen = offer.qwen;
          view.aligner = offer.aligner;
          view.unavailable = qwenUnavailable(selected, offer);
        }
      } catch (err) {
        view.unavailable = `Crucible on ${selected} couldn't be read (${(err as Error)?.message ?? err}).`;
      }
      server = view;
    }
    return { model, aligner: QWEN_ALIGNER_MODEL, server, route: await this.route() };
  }

  // ── the job ────────────────────────────────────────────────────────────

  /**
   * One transcription on `server` with `model`. Resolves with the SRT written;
   * rejects with the runner's outcomes (crucible-asr-job.ts): parked, unavailable,
   * cancelled, or failed.
   */
  async transcribe(request: CrucibleTranscriptionRequest): Promise<CrucibleTranscriptionOutcome> {
    const { server, model, localId } = request;
    const log = (line: string): void => this.logger.log(`[${localId}] ${line}`);
    const params = qwenAsrParams(request.language);
    let client;
    try {
      client = await this.factory.clientFor(server);
    } catch (err) {
      // Resolving the engine behind the address is the first thing that can meet a dead server.
      throw classifyAsrRefusal(err, server, 'the transcription');
    }
    let last = 0;
    log(`transcribing ${path.basename(request.videoFile)} on ${server} with ${model} (language ${params.language}, vad_filter ${params.vad_filter}, word_timestamps ${params.word_timestamps})`);

    const outcome = await runAsrJob({
      client,
      server,
      model,
      params,
      file: request.videoFile,
      filename: safeUploadName(request.videoFile),
      // Unique per submission: a lost submit answer is found again by it.
      clientRef: `briefcase:transcribe:${localId}:${randomBytes(4).toString('hex')}`,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onLog: log,
      onProgress: (p) => {
        const mapped = asrProgressToTask(server, p);
        // Never backwards: the queue's bar must not bounce.
        const percent = Math.max(last, mapped.percent);
        last = percent;
        request.onProgress?.(percent, mapped.message);
      },
      blobCache: this.blobCacheFor(server, request.videoFile),
      ...(this.ledger === undefined ? {} : {
        ledger: {
          record: (jobId: string) => this.ledger!.record({ server, kind: 'job', id: jobId, jobType: 'asr', model, localId }),
          settle: (jobId: string) => this.ledger!.settle(server, 'job', jobId),
        },
      }),
      ...this.jobTiming,
    });

    const { srt, cues, transcript, plainText } = transcriptToSrt(outcome.transcript);
    fs.mkdirSync(request.outputDir, { recursive: true });
    const srtFile = path.join(request.outputDir, `${request.baseName}.srt`);
    const txtFile = path.join(request.outputDir, `${request.baseName}.txt`);
    const temp = `${srtFile}.${process.pid}.part`;
    fs.writeFileSync(temp, srt, 'utf-8');
    fs.renameSync(temp, srtFile);
    fs.writeFileSync(txtFile, plainText, 'utf-8');
    log(`${server} transcribed it: ${cues} cue(s)${transcript.durationS !== null ? `, ${hms(transcript.durationS)}` : ''}, language ${transcript.language}, ${transcript.model}${transcript.revision ? `@${transcript.revision.slice(0, 12)}` : ''}`);
    return { srtFile, txtFile, jobId: outcome.jobId, cues, model: transcript.model, revision: transcript.revision, language: transcript.language };
  }

  private blobCacheFor(server: string, file: string): AsrBlobCache | undefined {
    let key: string;
    try {
      const stat = fs.statSync(file);
      key = [server, path.resolve(file), stat.size, stat.mtimeMs].join('\0');
    } catch {
      return undefined; // runAsrJob names the missing file
    }
    return {
      get: () => this.blobs.get(key) ?? null,
      set: (upload) => {
        this.blobs.delete(key);
        this.blobs.set(key, upload);
        while (this.blobs.size > ASR_BLOB_CACHE_MAX) this.blobs.delete(this.blobs.keys().next().value!);
      },
      drop: () => { this.blobs.delete(key); },
    };
  }
}

/**
 * The file's name on the server. The EXTENSION is what ffmpeg reads the
 * container off, so it is kept exactly; the stem is reduced to safe characters
 * (the server stores it as a file name, and a title can hold anything).
 */
export function safeUploadName(file: string): string {
  const ext = path.extname(file).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = path.basename(file, path.extname(file)).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 80);
  return `${stem || 'media'}${ext || '.bin'}`;
}
