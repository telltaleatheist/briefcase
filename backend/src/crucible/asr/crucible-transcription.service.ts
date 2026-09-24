/**
 * TRANSCRIBE ON A CRUCIBLE: the `asr` door, and the venue rule's host (P5).
 *
 * `WhisperService.transcribeVideo` is still the one seam every caller goes
 * through (the queue, the analysis pipeline, the simple-transcribe door). On
 * the Crucible route it hands the VIDEO itself here, not an extracted WAV: the
 * server reads any container ffmpeg reads and windows it (900 s windows, 15 s
 * overlap), so nothing is chunked or extracted on this side. `transcript.json`
 * comes back, and an SRT is written in the job's output directory for the
 * caller to relocate exactly as it relocates whisper.cpp's.
 *
 * What the job sends (all three params are required and Crucible defaults
 * none): `language` ("auto": Briefcase has no language setting and never
 * passed `-l` to whisper.cpp either), `vad_filter` per engine (asr-models.ts),
 * `word_timestamps: false` (nothing in Briefcase reads words yet).
 *
 * Salvaged from the reference branch's `crucible-transcription.service.ts`
 * (bbb7ef6). Its registry and servers seam are NOT used: P1's
 * `CrucibleServersService` is the real one. Added: the venue rule's host,
 * P4's in-flight ledger, and the settings/view door the pane reads.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';
import { CrucibleClientFactory } from '../client-factory';
import { CRUCIBLE_IN_FLIGHT_LEDGER } from '../crucible.constants';
import { CrucibleServersService } from '../crucible-servers.service';
import type { InFlightLedger } from '../in-flight-ledger';
import { resolveAiVia, type AiVia } from '../llm/ai-via';
import { CrucibleProbeService } from '../probe';
import type { TranscriptionServerView, TranscriptionView } from '../wire/transcription-wire';
import { asrOfferOf, crucibleAsrLanguage, vadFilterFor, type AsrOffer } from './asr-models';
import { classifyAsrRefusal, runAsrJob, type AsrJobProgress, type RunAsrJobOptions } from './crucible-asr-job';
import { transcriptToSrt } from './crucible-transcript';
import {
  parseTranscriptionSettingInput,
  readTranscriptionSetting,
  writeTranscriptionSetting,
  type TranscriptionSettingRead,
} from './transcription-setting';
import { decideTranscriptionRoute, type TranscriptionAsk, type TranscriptionRoute, type TranscriptionVenueHost } from './transcription-venue';

/** `/v1/info` is read at most this often per server for the venue rule. */
export const ASR_OFFER_CACHE_MS = 30_000;

export interface CrucibleTranscriptionRequest {
  readonly server: string;
  readonly model: string;
  /** The media file, sent as it is. */
  readonly videoFile: string;
  /** Where the SRT is written: the job's temp directory, as whisper.cpp's output directory. */
  readonly outputDir: string;
  /** The SRT's base name (no extension), as whisper.cpp would name it. */
  readonly baseName: string;
  /** Briefcase's queue job id: the ledger's `localId`, the log prefix and the clientRef. */
  readonly localId: string;
  readonly language?: string | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (percent: number, message: string) => void;
}

export interface CrucibleTranscriptionOutcome {
  readonly srtFile: string;
  readonly jobId: string;
  readonly cues: number;
  readonly model: string;
  readonly revision: string;
  readonly language: string;
}

/** `HH:MM:SS`, the app's time format. */
export function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Crucible's progress → the transcribe task's `{percent, message}`.
 *
 *   0–5     WhisperService's own start
 *   5       uploading the video
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
    case 'uploading':
      return { percent: 5, message: `Sending the video to Crucible on ${server}...` };
    case 'queued':
      return { percent: 7, message: `Queued on Crucible on ${server}${p.position !== null && p.position > 0 ? ` (position ${p.position})` : ''}...` };
    case 'warming':
      return { percent: 9, message: `Crucible on ${server}: ${p.message}` };
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

  /** Replaceable by a spec. */
  now: () => number = Date.now;
  configDir: () => string = () => getBriefcaseConfigDir();
  aiVia: () => AiVia = () => resolveAiVia({ configDir: this.configDir() }).via;
  /** Only a spec shortens these. */
  jobTiming: Pick<RunAsrJobOptions, 'doorDelaysMs' | 'streamDelaysMs'> = {};

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly probes: CrucibleProbeService,
    private readonly factory: CrucibleClientFactory,
    @Optional() @Inject(CRUCIBLE_IN_FLIGHT_LEDGER) private readonly ledger?: InFlightLedger,
  ) {}

  // ── the setting ────────────────────────────────────────────────────────

  setting(): TranscriptionSettingRead {
    return readTranscriptionSetting(this.configDir());
  }

  saveSetting(input: unknown): TranscriptionSettingRead {
    const setting = parseTranscriptionSettingInput(input);
    const saved = writeTranscriptionSetting(this.configDir(), setting);
    this.logger.log(`Transcription set to ${setting.venue}${setting.server ? ` on ${setting.server}` : ''}${setting.model ? ` with ${setting.model}` : ''}`);
    return saved;
  }

  // ── the venue rule ─────────────────────────────────────────────────────

  private host(): TranscriptionVenueHost {
    return {
      setting: () => this.setting().setting,
      aiVia: () => this.aiVia(),
      registered: () => this.servers.routing().ranked,
      reach: async (server) => {
        const answer = await this.probes.reach(server);
        return { reach: answer.reach, message: answer.probe.outcome === 'ok' ? undefined : answer.probe.message };
      },
      asrOffer: (server) => this.asrOffer(server),
    };
  }

  /** Where a transcription runs right now. Never throws: anything unknown is the whisper-cli route with a warning. */
  async route(ask: TranscriptionAsk = {}): Promise<TranscriptionRoute> {
    try {
      return await decideTranscriptionRoute(ask, this.host());
    } catch (err) {
      const why = (err as Error)?.message ?? String(err);
      this.logger.warn(`The transcription venue could not be decided (${why}); using the offline transcriber.`);
      return { kind: 'cli', reason: why, warning: `Transcribed with the offline transcriber (whisper) because the Crucible venue could not be decided (${why}).` };
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
    const read = this.setting();
    let rows: Array<{ name: string; enabled: boolean }> = [];
    try {
      rows = this.servers.routing().ranked;
    } catch {
      rows = [];
    }
    const servers: TranscriptionServerView[] = [];
    for (const row of rows) {
      const view: TranscriptionServerView = {
        name: row.name, enabled: row.enabled, reach: null, backend: null, offersAsr: false,
        models: [], recommended: null, betterNotInstalled: null, unavailable: null,
      };
      try {
        const answer = await this.probes.reach(row.name);
        view.reach = answer.reach;
        if (answer.reach !== 'ready' && answer.reach !== 'busy') {
          view.unavailable = answer.probe.outcome === 'ok' ? `Crucible on ${row.name} isn't answering.` : answer.probe.message;
        } else {
          const offer = await this.asrOffer(row.name, true);
          view.backend = offer.backend;
          view.offersAsr = offer.offersAsr;
          view.models = offer.choice.models.map((m) => ({ id: m.id, installed: m.installed, rank: m.rank }));
          view.recommended = offer.choice.recommended;
          view.betterNotInstalled = offer.choice.betterNotInstalled;
          if (!offer.offersAsr) view.unavailable = `Crucible on ${row.name} has no transcription engine.`;
          else if (offer.choice.recommended === null) view.unavailable = `Crucible on ${row.name} has no transcription model downloaded yet.`;
        }
      } catch (err) {
        view.unavailable = `Crucible on ${row.name} couldn't be read (${(err as Error)?.message ?? err}).`;
      }
      servers.push(view);
    }
    const route = await this.route({});
    return {
      setting: read.setting,
      explicit: read.explicit,
      ignored: read.ignored ?? null,
      aiVia: this.aiVia(),
      servers,
      route,
      whisperCliInUse: route.kind === 'cli',
    };
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
    const vad = vadFilterFor(model);
    const language = crucibleAsrLanguage(request.language);
    let client;
    try {
      client = await this.factory.clientFor(server);
    } catch (err) {
      // Resolving the engine behind the address is the first thing that can meet a dead server.
      throw classifyAsrRefusal(err, server, 'the transcription');
    }
    let last = 0;
    log(`transcribing ${path.basename(request.videoFile)} on ${server} with ${model} (language ${language}, vad_filter ${vad}, word_timestamps false)`);

    const outcome = await runAsrJob({
      client,
      server,
      model,
      params: { language, vad_filter: vad, word_timestamps: false },
      file: request.videoFile,
      filename: safeUploadName(request.videoFile),
      clientRef: `briefcase:transcribe:${localId}`,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      onLog: log,
      onProgress: (p) => {
        const mapped = asrProgressToTask(server, p);
        // Never backwards: the queue's bar must not bounce.
        const percent = Math.max(last, mapped.percent);
        last = percent;
        request.onProgress?.(percent, mapped.message);
      },
      ...(this.ledger === undefined ? {} : {
        ledger: {
          record: (jobId: string) => this.ledger!.record({ server, kind: 'job', id: jobId, jobType: 'asr', model, localId }),
          settle: (jobId: string) => this.ledger!.settle(server, 'job', jobId),
        },
      }),
      ...this.jobTiming,
    });

    const { srt, cues, transcript } = transcriptToSrt(outcome.transcript);
    fs.mkdirSync(request.outputDir, { recursive: true });
    const srtFile = path.join(request.outputDir, `${request.baseName}.srt`);
    const temp = `${srtFile}.${process.pid}.part`;
    fs.writeFileSync(temp, srt, 'utf-8');
    fs.renameSync(temp, srtFile);
    log(`${server} transcribed it: ${cues} cue(s)${transcript.durationS !== null ? `, ${hms(transcript.durationS)}` : ''}, language ${transcript.language}, ${transcript.model}${transcript.revision ? `@${transcript.revision.slice(0, 12)}` : ''}`);
    return { srtFile, jobId: outcome.jobId, cues, model: transcript.model, revision: transcript.revision, language: transcript.language };
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
