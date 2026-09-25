/**
 * One transcription through Crucible's `asr` job, against the fake (P5):
 * upload → submit → SSE progress → transcript.json → SRT + plain text, the
 * ledger around it, resume after a dropped stream, cancel mid-file, a failed
 * job, a busy card, and WhisperService: Crucible is the only transcriber (P7),
 * so an unreachable or busy server is a reason to park, never a fallback.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import {
  CrucibleAsrCancelled,
  CrucibleAsrJobFailed,
  CrucibleAsrUnavailable,
} from '../../src/crucible/asr/crucible-asr-job';
import { CrucibleTranscriptionService, safeUploadName } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleParkedError, isParked } from '../../src/crucible/llm/errors';
import { TranscriptionUnavailableError, WhisperService, isTranscriptionRetryable } from '../../src/media/whisper.service';
import { startFakeCrucible, stockedForBriefcase, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { tempDir } from './helpers';

let fake: FakeCrucible;
let h: Harness;
let ledger: InFlightLedger;
let svc: CrucibleTranscriptionService;
let video: string;
let outDir: string;

/** Qwen3-ASR and its aligner installed, with the asr and align job types. */
const STOCKED = stockedForBriefcase();

async function wire(opts: Parameters<typeof startFakeCrucible>[0] = {}, url?: string): Promise<void> {
  fake = await startFakeCrucible({ ...STOCKED, ...opts });
  h = harness();
  h.registry.add({ name: 'mac', url: url ?? fake.url, token: fake.token });
  ledger = InFlightLedger.inDir(h.dir, () => undefined);
  svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
  svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
  const dir = tempDir('asr-video-');
  video = path.join(dir, 'My Video! (1080p).MP4');
  fs.writeFileSync(video, Buffer.alloc(64 * 1024, 7));
  outDir = tempDir('asr-out-');
}

afterEach(async () => {
  await fake?.close();
});

function request(extra: Partial<Parameters<CrucibleTranscriptionService['transcribe']>[0]> = {}) {
  return { server: 'mac', model: 'qwen3-asr-1.7b', videoFile: video, outputDir: outDir, baseName: 'job-1_audio', localId: 'job-1', ...extra };
}

describe('the job flow', () => {
  it('uploads the video itself, submits exactly the three params, follows progress and writes the SRT', async () => {
    await wire();
    const seen: Array<{ percent: number; message: string }> = [];
    const outcome = await svc.transcribe(request({ onProgress: (percent, message) => seen.push({ percent, message }) }));

    // The upload: the video's own bytes, its extension kept for ffmpeg.
    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]).toMatchObject({
      filename: 'My_Video_1080p_.mp4',
      bytes: 64 * 1024,
      sha256: createHash('sha256').update(fs.readFileSync(video)).digest('hex'),
    });
    // The submit: model named, exactly {language, vad_filter, word_timestamps}, vad false on mlx.
    const job = fake.jobs[0];
    expect(job).toMatchObject({ type: 'asr', model: 'qwen3-asr-1.7b', client: 'briefcase', status: 'done' });
    // Qwen: a stated language (it cannot detect), no VAD, and words (they cut its pieces into cues).
    expect(job.params).toEqual({ language: 'en', vad_filter: false, word_timestamps: true });
    expect(job.inputs).toEqual({ 'My_Video_1080p_.mp4': fake.uploads[0].blobId });
    // Unique per submission, so a lost answer can be found by it (and only this submission matches).
    expect((fake.requestsTo('/v1/jobs', 'POST')[0].body as Record<string, unknown>)['client_ref']).toMatch(/^briefcase:transcribe:job-1:[0-9a-f]{8}$/);

    // The SRT, where whisper.cpp would have put it, in its shape: the first piece cut into its two sentences at the aligner's times.
    expect(outcome).toMatchObject({ srtFile: path.join(outDir, 'job-1_audio.srt'), cues: 3, model: 'qwen3-asr-1.7b', language: 'en', jobId: job.jobId });
    expect(fs.readFileSync(outcome.srtFile, 'utf8')).toBe(
      '1\n00:00:00,000 --> 00:00:04,083\nWelcome back to the show.\n\n'
      + '2\n00:00:04,083 --> 00:00:09,800\nToday we are talking about the news.\n\n'
      + '3\n01:00:05,500 --> 01:00:10,250\nThanks for watching.\n\n',
    );
    // The plain text beside it, one cue per line (what transcript search indexes).
    expect(fs.readFileSync(outcome.txtFile, 'utf8')).toBe('Welcome back to the show.\nToday we are talking about the news.\nThanks for watching.');

    // Progress: never backwards; each stage in its band; the decode drives no fraction.
    const percents = seen.map((s) => s.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(seen[0]).toEqual({ percent: 3, message: 'Uploading the video to Crucible on mac...' });
    expect(seen).toContainEqual({ percent: 7, message: 'Queued on Crucible on mac...' });
    expect(seen).toContainEqual({ percent: 9, message: 'Crucible on mac: loading qwen3-asr-1.7b' });
    expect(seen).toContainEqual({ percent: 12, message: 'Reading the audio on mac... 00:30:00 of 01:00:00' });
    expect(seen).toContainEqual({ percent: 14, message: 'Reading the audio on mac... 01:00:00 of 01:00:00' });
    expect(seen).toContainEqual({ percent: 35, message: 'Transcribing on mac... 00:15:00 of 01:00:00' });
    expect(seen.at(-1)).toEqual({ percent: 95, message: 'Transcribing on mac... 01:00:00 of 01:00:00' });

    // The ledger: written at admission, settled at the end.
    expect(ledger.read()).toEqual([]);
  });

  it('REGRESSION: a slow upload keeps reporting (bytes sent, labelled uploading), so the stall watchdog sees it alive', async () => {
    await wire();
    svc.jobTiming = { ...svc.jobTiming, uploadTickMs: 10 };
    fake.faults.connectDelay = [{ match: { method: 'POST', path: '/v1/uploads' }, ms: 120, thenDestroy: false, times: 1 }];
    const seen: Array<{ percent: number; message: string }> = [];
    await svc.transcribe(request({ onProgress: (percent, message) => seen.push({ percent, message }) }));
    const uploading = seen.filter((s) => s.message.startsWith('Uploading the video to Crucible on mac'));
    // Not one line at the start and silence until the server answers: a beat while the bytes go.
    expect(uploading.length).toBeGreaterThanOrEqual(4);
    expect(uploading).toContainEqual({ percent: 6, message: 'Uploading the video to Crucible on mac... 64.0 KB of 64.0 KB' });
    expect(uploading.every((s) => s.percent >= 3 && s.percent <= 6)).toBe(true);
  });

  it('on cuda-linux it is the same id and the same params: one id on every backend', async () => {
    await wire({ backend: 'cuda-linux', platform: 'linux', arch: 'x64' });
    expect(await svc.route()).toEqual({ kind: 'crucible', server: 'mac', model: 'qwen3-asr-1.7b' });
    await svc.transcribe(request());
    expect(fake.jobs[0]).toMatchObject({ model: 'qwen3-asr-1.7b', params: { language: 'en', vad_filter: false, word_timestamps: true } });
  });

  it('a language Qwen does not take is refused by name before anything is uploaded', async () => {
    await wire();
    const err = await svc.transcribe(request({ language: 'nl' })).catch((e) => e);
    expect(err).toMatchObject({ name: 'CrucibleAsrRefused', code: 'crucible_asr_language_unsupported' });
    expect(fake.uploads).toHaveLength(0);
  });

  it('the ledger holds the job while it runs (a hard kill leaves a row the sweep DELETEs)', async () => {
    await wire({ asr: { holdAfterFrames: 1 } });
    const controller = new AbortController();
    const running = svc.transcribe(request({ signal: controller.signal }));
    await until(() => fake.jobs[0]?.events.some((e) => e.event === 'progress' && e.data['stage'] === 'transcribing'));
    expect(ledger.read()).toEqual([expect.objectContaining({ server: 'mac', kind: 'job', id: fake.jobs[0].jobId, jobType: 'asr', model: 'qwen3-asr-1.7b', localId: 'job-1' })]);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(CrucibleAsrCancelled);
    expect(ledger.read()).toEqual([]);
  });

  it('resumes a dropped event stream with Last-Event-ID, missing nothing and repeating nothing', async () => {
    await wire({ asr: { stepMs: 15 } });
    fake.faults.resetAfterBytes = [{ match: { method: 'GET', path: /\/events$/ }, afterBytes: 120, times: 1 }];
    const seen: string[] = [];
    const outcome = await svc.transcribe(request({ onProgress: (_p, message) => seen.push(message) }));
    expect(outcome.cues).toBe(3);
    const streams = fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}/events`, 'GET');
    expect(streams.length).toBeGreaterThanOrEqual(2);
    expect(streams[0].fault).toMatch(/reset/);
    expect(Number(streams[1].headers['last-event-id'])).toBeGreaterThan(0);
    // Every transcribing frame arrived exactly once.
    expect(seen.filter((m) => m.startsWith('Transcribing'))).toEqual([
      'Transcribing on mac... 00:15:00 of 01:00:00',
      'Transcribing on mac... 00:30:00 of 01:00:00',
      'Transcribing on mac... 00:45:00 of 01:00:00',
      'Transcribing on mac... 01:00:00 of 01:00:00',
    ]);
  });

  it('a stream lost past its budget cancels the job and is an infrastructure failure (the queue parks it)', async () => {
    await wire({ asr: { holdAfterFrames: 1 } });
    fake.faults.resetAfterBytes = [{ match: { method: 'GET', path: /\/events$/ }, afterBytes: 0 }];
    await expect(svc.transcribe(request())).rejects.toMatchObject({ name: 'CrucibleAsrUnavailable', code: 'crucible_stream_lost' });
    expect(fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}`, 'DELETE')).toHaveLength(1);
    expect(fake.jobs[0].status).toBe('cancelled');
    expect(ledger.read()).toEqual([]);
  });

  it('cancel mid-file is a DELETE, and the job ends cancelled', async () => {
    await wire({ asr: { holdAfterFrames: 2 } });
    const controller = new AbortController();
    const running = svc.transcribe(request({ signal: controller.signal }));
    await until(() => (fake.jobs[0]?.events.filter((e) => e.event === 'progress' && e.data['stage'] === 'transcribing').length ?? 0) >= 2);
    controller.abort();
    const err = await running.catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrCancelled);
    expect(err.cancelled).toBe(true);
    expect(fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}`, 'DELETE')).toHaveLength(1);
    expect(fake.jobs[0].status).toBe('cancelled');
    expect(fs.existsSync(path.join(outDir, 'job-1_audio.srt'))).toBe(false);
  });

  it('REGRESSION: a submit admitted but whose answer was lost is found by its client_ref, never submitted twice', async () => {
    await wire({ asr: { stepMs: 15 } });
    fake.faults.resetAfterBytes = [{ match: { method: 'POST', path: '/v1/jobs' }, afterBytes: 1, times: 1 }];
    const recorded: string[] = [];
    const record = ledger.record.bind(ledger);
    ledger.record = (row) => { recorded.push(row.id); return record(row); };
    const outcome = await svc.transcribe(request());
    expect(fake.jobs).toHaveLength(1);
    expect(fake.requestsTo('/v1/jobs', 'POST')).toHaveLength(1);
    expect(outcome.jobId).toBe(fake.jobs[0].jobId);
    expect(outcome.cues).toBe(3);
    // Written down once found, and settled at the end.
    expect(recorded).toEqual([fake.jobs[0].jobId]);
    expect(ledger.read()).toEqual([]);
  });

  it('REGRESSION: the lost answer found on the resubmit instead (the lookup failed): the refusal names our own job', async () => {
    await wire({ asr: { stepMs: 15 } });
    fake.faults.resetAfterBytes = [{ match: { method: 'POST', path: '/v1/jobs' }, afterBytes: 1, times: 1 }];
    fake.faults.refuse = [{ match: { method: 'GET', path: '/v1/activity' }, status: 503, code: 'engine_unavailable', times: 1 }];
    const outcome = await svc.transcribe(request());
    expect(fake.jobs).toHaveLength(1);
    expect(fake.requestsTo('/v1/jobs', 'POST')).toHaveLength(2);
    expect(outcome.jobId).toBe(fake.jobs[0].jobId);
    expect(ledger.read()).toEqual([]);
  });

  it('a job the server ran and failed fails with the server’s own message (no fallback)', async () => {
    await wire({ asr: { failWith: { code: 'asr_window_failed', message: 'windows 3 and 4 could not be decoded' } } });
    const err = await svc.transcribe(request()).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrJobFailed);
    expect(err.message).toBe('Crucible on mac could not transcribe this video (asr_window_failed): windows 3 and 4 could not be decoded');
    expect(ledger.read()).toEqual([]);
  });

  it('a 409 server_busy at the submit is a park with the holder’s sentence, and nothing is held', async () => {
    await wire();
    fake.inject({ serverBusy: { client: 'bookforge crucible-client/1.0.6', type: 'tts', progress: 0.4 } });
    const err = await svc.transcribe(request()).catch((e) => e);
    expect(isParked(err)).toBe(true);
    expect((err as CrucibleParkedError).server).toBe('mac');
    expect((err as CrucibleParkedError).reason).toMatch(/bookforge/);
    expect(fake.jobs).toHaveLength(0);
    expect(ledger.read()).toEqual([]);
  });

  it('REGRESSION: a parked task that runs again reuses its upload instead of sending the whole video again', async () => {
    await wire();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
    expect(isParked(await svc.transcribe(request()).catch((e) => e))).toBe(true);
    expect(isParked(await svc.transcribe(request()).catch((e) => e))).toBe(true);
    fake.inject({});
    const outcome = await svc.transcribe(request());
    expect(outcome.cues).toBe(3);
    expect(fake.uploads).toHaveLength(1);
    expect(fake.jobs[0].inputs).toEqual({ 'My_Video_1080p_.mp4': fake.uploads[0].blobId });
    // Consumed by that job: the next transcription of the file uploads afresh, with no refused round trip.
    await svc.transcribe(request({ localId: 'job-2' }));
    expect(fake.uploads).toHaveLength(2);
    expect(fake.requestsTo('/v1/jobs', 'POST')).toHaveLength(4); // two parked, two admitted
    expect(fake.jobs).toHaveLength(2);
  });

  it('REGRESSION: a reused blob the server no longer holds (unknown_blob) is uploaded again once, and the job runs', async () => {
    await wire();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
    expect(isParked(await svc.transcribe(request()).catch((e) => e))).toBe(true);
    fake.inject({});
    fake.forgetBlobs(); // a server restart that cleaned uploads/
    const outcome = await svc.transcribe(request());
    expect(outcome.cues).toBe(3);
    expect(fake.uploads).toHaveLength(2);
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0].inputs).toEqual({ 'My_Video_1080p_.mp4': fake.uploads[1].blobId });
  });

  it('an unreachable server is an infrastructure failure, by name', async () => {
    await wire({}, await unusedLoopbackUrl());
    const err = await svc.transcribe(request()).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrUnavailable);
    expect(err.message).toMatch(/Crucible on mac could not be reached/);
  });

  it('a model the server does not have is refused at the submit as unavailable (the queue parks it)', async () => {
    await wire({ asrInstalled: ['whisper-tiny'] });
    const err = await svc.transcribe(request()).catch((e) => e);
    expect(err).toMatchObject({ name: 'CrucibleAsrUnavailable', code: 'model_not_installed' });
  });

  it('the upload name keeps the extension and makes the stem safe', () => {
    expect(safeUploadName('/a/b/My Video! (1080p).MP4')).toBe('My_Video_1080p_.mp4');
    expect(safeUploadName('/a/.hidden')).toBe('hidden.bin');
    expect(safeUploadName('/a/клип.webm')).toBe('media.webm');
  });
});

describe('the pane’s view', () => {
  it('Qwen3-ASR and its aligner on the selected server, and where a transcription would run', async () => {
    await wire();
    const view = await svc.view();
    expect(view.model).toBe('qwen3-asr-1.7b');
    expect(view.aligner).toBe('qwen3-aligner');
    expect(view.route).toEqual({ kind: 'crucible', server: 'mac', model: 'qwen3-asr-1.7b' });
    expect(view.server).toEqual({
      name: 'mac', reach: 'ready', backend: 'mlx-darwin',
      qwen: { offered: true, installed: true }, aligner: { offered: true, installed: true }, unavailable: null,
    });
  });

  it('a server without asr: the route is none, with the reason (the task would park)', async () => {
    await wire({ installedJobTypes: ['echo', 'llm'] });
    const view = await svc.view();
    expect(view.route).toMatchObject({ kind: 'none', reason: expect.stringMatching(/no transcription engine/) });
    expect(view.server!.unavailable).toMatch(/no transcription engine/);
  });

  it('Qwen or its aligner not downloaded: none, naming which (never another model)', async () => {
    await wire({ catalog: stockedForBriefcase().catalog.map((r) => (r.id === 'qwen3-asr-1.7b' ? { ...r, installed: false } : r)) });
    expect(await svc.route()).toEqual({ kind: 'none', reason: 'Crucible on mac has not downloaded qwen3-asr-1.7b yet.' });
  });
});

// ── WhisperService: the one transcription seam ────────────────────────────

function events() {
  const log: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => { log.push([name, ...args]); };
  return {
    log,
    emitTaskProgress: rec('task'),
    emitTranscriptionProgress: rec('progress'),
    emitTranscriptionStarted: rec('started'),
    emitTranscriptionCompleted: rec('completed'),
    emitTranscriptionFailed: rec('failed'),
  };
}

function whisper(crucible: CrucibleTranscriptionService) {
  const ev = events();
  return { service: new WhisperService(ev as never, crucible), ev };
}

const MAC_ROUTE = { kind: 'crucible' as const, server: 'mac', model: 'qwen3-asr-1.7b' };

describe('WhisperService: Crucible transcribes, and nothing else does', () => {
  it('the SRT and its plain text are relocated to standalone temp files; the job dir is gone', async () => {
    await wire();
    const { service, ev } = whisper(svc);
    const outcome = await service.transcribe(video, { jobId: 'job-1', route: MAC_ROUTE });
    expect(outcome).toMatchObject({ model: 'qwen3-asr-1.7b', language: 'en' });
    expect(path.dirname(outcome.srtPath)).toBe(os.tmpdir());
    expect(path.basename(outcome.srtPath)).toMatch(/^transcribe-[0-9a-f]{16}\.srt$/);
    expect(outcome.txtPath).toBe(outcome.srtPath.replace(/\.srt$/, '.txt'));
    expect(fs.readFileSync(outcome.srtPath, 'utf8')).toMatch(/^1\n00:00:00,000 --> 00:00:04,083\nWelcome back/);
    expect(fs.readFileSync(outcome.txtPath, 'utf8')).toMatch(/^Welcome back to the show\.\nToday/);
    expect(fs.existsSync(outcome.srtPath.replace(/\.srt$/, ''))).toBe(false);
    expect(ev.log.some(([n, jobId, type, pct]) => n === 'task' && jobId === 'job-1' && type === 'transcribe' && pct === 95)).toBe(true);
    fs.unlinkSync(outcome.srtPath);
    fs.unlinkSync(outcome.txtPath);
  });

  it('no route given (a caller with no queue): the venue rule decides', async () => {
    await wire();
    const { service } = whisper(svc);
    const outcome = await service.transcribe(video, { jobId: 'job-2' });
    expect(fake.jobs).toHaveLength(1);
    expect(fs.readFileSync(outcome.srtPath, 'utf8')).toMatch(/Thanks for watching\./);
  });

  it('no route and no server that can take it: a typed error saying why, and nothing runs', async () => {
    await wire({ installedJobTypes: ['echo', 'llm'] });
    const { service } = whisper(svc);
    const err = await service.transcribe(video, { jobId: 'job-3' }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptionUnavailableError);
    expect((err as Error).message).toMatch(/no transcription engine/);
    expect(isTranscriptionRetryable(err)).toBe(true);
    expect(fake.uploads).toHaveLength(0);
  });

  it('a busy card parks (a retry later), never a fallback', async () => {
    await wire();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
    const { service } = whisper(svc);
    const err = await service.transcribe(video, { jobId: 'job-5', route: MAC_ROUTE }).catch((e) => e);
    expect(isParked(err)).toBe(true);
    expect(isTranscriptionRetryable(err)).toBe(true);
  });

  it('an unreachable server is retryable (the queue parks it), by name', async () => {
    await wire({}, await unusedLoopbackUrl());
    const { service } = whisper(svc);
    const err = await service.transcribe(video, { jobId: 'job-6', route: MAC_ROUTE }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrUnavailable);
    expect(isTranscriptionRetryable(err)).toBe(true);
  });

  it('a cancel is a cancel: job.cancel-requested DELETEs the job', async () => {
    await wire({ asr: { holdAfterFrames: 2 } });
    const { service, ev } = whisper(svc);
    const running = service.transcribe(video, { jobId: 'job-7', route: MAC_ROUTE });
    await until(() => (fake.jobs[0]?.events.filter((e) => e.event === 'progress' && e.data['stage'] === 'transcribing').length ?? 0) >= 2);
    service.handleJobCancelRequested({ jobId: 'job-7' });
    await expect(running).rejects.toBeInstanceOf(CrucibleAsrCancelled);
    expect(fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}`, 'DELETE')).toHaveLength(1);
    expect(ev.log.some(([n]) => n === 'failed')).toBe(true);
  });

  it('a failed job fails with the server’s message, and is not retryable', async () => {
    await wire({ asr: { failWith: { code: 'asr_window_failed', message: 'window 2 failed' } } });
    const { service } = whisper(svc);
    const err = await service.transcribe(video, { jobId: 'job-8', route: MAC_ROUTE }).catch((e) => e);
    expect((err as Error).message).toMatch(/window 2 failed/);
    expect(isTranscriptionRetryable(err)).toBe(false);
  });
});

async function until(check: () => boolean | undefined, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('REGRESSION: a cancel during a door retry is a cancel, never an unreachable (which would fall back)', () => {
  function stubClient(overrides: Record<string, unknown>) {
    return overrides as unknown as import('@crucible/client').CrucibleClient;
  }
  function tmpVideo(): string {
    const dir = tempDir('asr-cancel-');
    const file = path.join(dir, 'v.mp4');
    fs.writeFileSync(file, Buffer.alloc(1024, 1));
    return file;
  }

  it('the upload: cancelled while waiting to retry, the retry failing again', async () => {
    const { runAsrJob } = await import('../../src/crucible/asr/crucible-asr-job');
    const { CrucibleUnreachable } = await import('@crucible/client');
    let uploads = 0;
    const controller = new AbortController();
    const client = stubClient({
      upload: async () => { uploads += 1; throw new CrucibleUnreachable('', 'connection refused'); },
      submit: jest.fn(),
    });
    setTimeout(() => controller.abort(), 20);
    const err = await runAsrJob({
      client, server: 'mac', model: 'm', params: { language: 'auto', vad_filter: false, word_timestamps: false } as never,
      file: tmpVideo(), filename: 'v.mp4', signal: controller.signal, doorDelaysMs: [5_000, 5_000],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrCancelled);
    expect(uploads).toBe(1);
    expect((client as unknown as { submit: jest.Mock }).submit).not.toHaveBeenCalled();
  });

  it('the submit: cancelled while waiting to retry', async () => {
    const { runAsrJob } = await import('../../src/crucible/asr/crucible-asr-job');
    const { CrucibleUnreachable } = await import('@crucible/client');
    let submits = 0;
    const controller = new AbortController();
    const client = stubClient({
      upload: async () => ({ blobId: 'b1' }),
      submit: async () => { submits += 1; throw new CrucibleUnreachable('', 'connection refused'); },
    });
    setTimeout(() => controller.abort(), 20);
    const err = await runAsrJob({
      client, server: 'mac', model: 'm', params: { language: 'auto', vad_filter: false, word_timestamps: false } as never,
      file: tmpVideo(), filename: 'v.mp4', signal: controller.signal, doorDelaysMs: [5_000, 5_000],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrCancelled);
    expect(submits).toBe(1);
  });
});

describe('REGRESSION: a non-network event-stream error DELETEs the admitted job before the caller falls back', () => {
  it('a protocol error on the stream cancels the job and settles the ledger', async () => {
    const { runAsrJob } = await import('../../src/crucible/asr/crucible-asr-job');
    const { CrucibleProtocolError } = await import('@crucible/client');
    const dir = tempDir('asr-proto-');
    const file = path.join(dir, 'v.mp4');
    fs.writeFileSync(file, Buffer.alloc(1024, 1));
    const cancel = jest.fn(async () => ({ status: 'cancelled' }));
    const settled: string[] = [];
    const client = {
      upload: async () => ({ blobId: 'b1' }),
      submit: async () => 'job-7',
      cancel,
      // eslint-disable-next-line require-yield
      events: async function* () { throw new (CrucibleProtocolError as unknown as new (m: string) => Error)('event ids went backwards'); },
    } as unknown as import('@crucible/client').CrucibleClient;
    const err = await runAsrJob({
      client, server: 'mac', model: 'm', params: { language: 'auto', vad_filter: false, word_timestamps: false } as never,
      file, filename: 'v.mp4', ledger: { record: () => undefined, settle: (id: string) => { settled.push(id); } } as never,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledWith('job-7');
    expect(settled).toEqual(['job-7']);
  });
});
