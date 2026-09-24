/**
 * One transcription through Crucible's `asr` job, against the fake (P5):
 * upload → submit → SSE progress → transcript.json → SRT, the ledger around
 * it, resume after a dropped stream, cancel mid-file, a failed job, a busy
 * card, and WhisperService's engine choice: the fallback to whisper-cli on an
 * unreachable server, never on a cancel, and the whisper-cli path unchanged.
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
import { WhisperService } from '../../src/media/whisper.service';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { tempDir } from './helpers';

let fake: FakeCrucible;
let h: Harness;
let ledger: InFlightLedger;
let svc: CrucibleTranscriptionService;
let video: string;
let outDir: string;

const STOCKED = { installedJobTypes: ['echo', 'llm', 'asr'], asrInstalled: ['mlx-whisper-large-v3', 'mlx-whisper-large-v3-turbo'] };

async function wire(opts: Parameters<typeof startFakeCrucible>[0] = {}, url?: string): Promise<void> {
  fake = await startFakeCrucible({ ...STOCKED, ...opts });
  h = harness();
  h.registry.add({ name: 'mac', url: url ?? fake.url, token: fake.token });
  ledger = InFlightLedger.inDir(h.dir, () => undefined);
  svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
  svc.configDir = () => h.dir;
  svc.aiVia = () => 'crucible';
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
  return { server: 'mac', model: 'mlx-whisper-large-v3', videoFile: video, outputDir: outDir, baseName: 'job-1_audio', localId: 'job-1', ...extra };
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
    expect(job).toMatchObject({ type: 'asr', model: 'mlx-whisper-large-v3', client: 'briefcase', status: 'done' });
    expect(job.params).toEqual({ language: 'auto', vad_filter: false, word_timestamps: false });
    expect(job.inputs).toEqual({ 'My_Video_1080p_.mp4': fake.uploads[0].blobId });
    // Unique per submission, so a lost answer can be found by it (and only this submission matches).
    expect((fake.requestsTo('/v1/jobs', 'POST')[0].body as Record<string, unknown>)['client_ref']).toMatch(/^briefcase:transcribe:job-1:[0-9a-f]{8}$/);

    // The SRT, where whisper.cpp would have put it, in its shape.
    expect(outcome).toMatchObject({ srtFile: path.join(outDir, 'job-1_audio.srt'), cues: 3, model: 'mlx-whisper-large-v3', language: 'en', jobId: job.jobId });
    expect(fs.readFileSync(outcome.srtFile, 'utf8')).toBe(
      '1\n00:00:00,000 --> 00:00:04,200\nWelcome back to the show.\n\n'
      + '2\n00:00:04,200 --> 00:00:09,800\nToday we are talking about the news.\n\n'
      + '3\n01:00:05,500 --> 01:00:10,250\nThanks for watching.\n\n',
    );

    // Progress: never backwards; each stage in its band; the decode drives no fraction.
    const percents = seen.map((s) => s.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(seen[0]).toEqual({ percent: 5, message: 'Sending the video to Crucible on mac...' });
    expect(seen).toContainEqual({ percent: 7, message: 'Queued on Crucible on mac...' });
    expect(seen).toContainEqual({ percent: 9, message: 'Crucible on mac: loading mlx-whisper-large-v3' });
    expect(seen).toContainEqual({ percent: 12, message: 'Reading the audio on mac... 00:30:00 of 01:00:00' });
    expect(seen).toContainEqual({ percent: 14, message: 'Reading the audio on mac... 01:00:00 of 01:00:00' });
    expect(seen).toContainEqual({ percent: 35, message: 'Transcribing on mac... 00:15:00 of 01:00:00' });
    expect(seen.at(-1)).toEqual({ percent: 95, message: 'Transcribing on mac... 01:00:00 of 01:00:00' });

    // The ledger: written at admission, settled at the end.
    expect(ledger.read()).toEqual([]);
  });

  it('on cuda-linux the job names faster-whisper and sends vad_filter true', async () => {
    await wire({ backend: 'cuda-linux', platform: 'linux', arch: 'x64', asrInstalled: ['faster-whisper-large-v3'] });
    expect(await svc.route()).toEqual({ kind: 'crucible', server: 'mac', model: 'faster-whisper-large-v3' });
    await svc.transcribe(request({ model: 'faster-whisper-large-v3' }));
    expect(fake.jobs[0].params).toEqual({ language: 'auto', vad_filter: true, word_timestamps: false });
  });

  it('the ledger holds the job while it runs (a hard kill leaves a row the sweep DELETEs)', async () => {
    await wire({ asr: { holdAfterFrames: 1 } });
    const controller = new AbortController();
    const running = svc.transcribe(request({ signal: controller.signal }));
    await until(() => fake.jobs[0]?.events.some((e) => e.event === 'progress' && e.data['stage'] === 'transcribing'));
    expect(ledger.read()).toEqual([expect.objectContaining({ server: 'mac', kind: 'job', id: fake.jobs[0].jobId, jobType: 'asr', model: 'mlx-whisper-large-v3', localId: 'job-1' })]);
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

  it('a stream lost past its budget cancels the job and is an infrastructure failure (the caller falls back)', async () => {
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

  it('an unreachable server is an infrastructure failure, by name', async () => {
    await wire({}, await unusedLoopbackUrl());
    const err = await svc.transcribe(request()).catch((e) => e);
    expect(err).toBeInstanceOf(CrucibleAsrUnavailable);
    expect(err.message).toMatch(/Crucible on mac could not be reached/);
  });

  it('a model the server does not have is refused at the submit as unavailable (the caller falls back)', async () => {
    await wire({ asrInstalled: ['mlx-whisper-small'] });
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
  it('lists this backend’s asr models, the recommendation, and where a transcription would run', async () => {
    await wire();
    const view = await svc.view();
    expect(view.route).toEqual({ kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3' });
    expect(view.whisperCliInUse).toBe(false);
    expect(view.servers[0]).toMatchObject({ name: 'mac', backend: 'mlx-darwin', offersAsr: true, recommended: 'mlx-whisper-large-v3', unavailable: null });
    expect(view.servers[0].models.every((m) => m.id.startsWith('mlx-whisper-'))).toBe(true);
  });

  it('a server without asr: whisper-cli is in use, with the reason', async () => {
    await wire({ installedJobTypes: ['echo', 'llm'] });
    const view = await svc.view();
    expect(view.whisperCliInUse).toBe(true);
    expect(view.route).toMatchObject({ kind: 'cli', warning: expect.stringMatching(/no transcription engine/) });
    expect(view.servers[0].unavailable).toMatch(/no transcription engine/);
  });

  it('saving the setting writes app-config.json and the next route reads it', async () => {
    await wire();
    svc.saveSetting({ venue: 'whisper-cli', server: null, model: null });
    expect(await svc.route()).toMatchObject({ kind: 'cli', warning: null });
    expect(() => svc.saveSetting({ venue: 'nope' })).toThrow(/venue is/);
  });
});

// ── WhisperService: the engine choice ─────────────────────────────────────

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

function whisper(crucible?: CrucibleTranscriptionService) {
  const ev = events();
  const service = new WhisperService(ev as never, crucible);
  const cliSrt = path.join(tempDir('cli-'), 'cli.srt');
  fs.writeFileSync(cliSrt, '1\n00:00:00,000 --> 00:00:01,000\ncli\n\n');
  const cli = jest.spyOn(service as any, 'transcribeWithCli').mockResolvedValue(cliSrt);
  return { service, cli, cliSrt, ev };
}

describe('WhisperService picks the engine', () => {
  it('the Crucible route: the SRT is relocated to a standalone temp file, as the whisper-cli path does', async () => {
    await wire();
    const { service, cli, ev } = whisper(svc);
    const outcome = await service.transcribe(video, { jobId: 'job-1', model: 'base', route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'defer' } });
    expect(cli).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ engine: 'crucible', model: 'mlx-whisper-large-v3', language: 'en', warnings: [] });
    expect(path.dirname(outcome.srtPath)).toBe(os.tmpdir());
    expect(path.basename(outcome.srtPath)).toMatch(/^whisper-[0-9a-f]{16}\.srt$/);
    expect(fs.readFileSync(outcome.srtPath, 'utf8')).toMatch(/^1\n00:00:00,000 --> 00:00:04,200\nWelcome back/);
    expect(fs.existsSync(outcome.srtPath.replace(/\.srt$/, ''))).toBe(false); // the job dir is gone
    expect(ev.log.some(([n, jobId, type, pct]) => n === 'task' && jobId === 'job-1' && type === 'transcribe' && pct === 95)).toBe(true);
    fs.unlinkSync(outcome.srtPath);
  });

  it('no route given: the venue rule decides (Crucible here), and the legacy transcribeVideo returns the path', async () => {
    await wire();
    const { service, cli } = whisper(svc);
    const srt = await service.transcribeVideo(video, 'job-2', 'base');
    expect(cli).not.toHaveBeenCalled();
    expect(fake.jobs).toHaveLength(1);
    expect(fs.readFileSync(srt!, 'utf8')).toMatch(/Thanks for watching\./);
  });

  it('unreachable with fallback inline: whisper-cli runs with the SAME arguments, and the task gets a warning', async () => {
    await wire({}, await unusedLoopbackUrl());
    const { service, cli, cliSrt } = whisper(svc);
    const outcome = await service.transcribe(video, { jobId: 'job-3', model: 'small', translate: false, route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'inline' } });
    expect(cli).toHaveBeenCalledWith(video, 'job-3', 'small', false);
    expect(outcome).toMatchObject({ srtPath: cliSrt, engine: 'whisper-cli' });
    expect(outcome.warnings).toEqual([expect.stringMatching(/^Transcribed with the offline transcriber \(whisper\) because crucible on mac could not be reached/)]);
  });

  it('a busy card with fallback inline (no queue to park in) falls back too; with fallback defer it parks', async () => {
    await wire();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
    const inline = whisper(svc);
    const outcome = await inline.service.transcribe(video, { jobId: 'job-4', route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'inline' } });
    expect(outcome.engine).toBe('whisper-cli');
    const deferred = whisper(svc);
    const err = await deferred.service.transcribe(video, { jobId: 'job-5', route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'defer' } }).catch((e) => e);
    expect(isParked(err)).toBe(true);
    expect(deferred.cli).not.toHaveBeenCalled();
  });

  it('unreachable with fallback defer: thrown for the queue to re-route, whisper-cli not run here', async () => {
    await wire({}, await unusedLoopbackUrl());
    const { service, cli } = whisper(svc);
    await expect(service.transcribe(video, { jobId: 'job-6', route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'defer' } }))
      .rejects.toBeInstanceOf(CrucibleAsrUnavailable);
    expect(cli).not.toHaveBeenCalled();
  });

  it('a cancel NEVER falls back: job.cancel-requested DELETEs the job and whisper-cli is not run', async () => {
    await wire({ asr: { holdAfterFrames: 2 } });
    const { service, cli, ev } = whisper(svc);
    const running = service.transcribe(video, { jobId: 'job-7', route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'inline' } });
    await until(() => (fake.jobs[0]?.events.filter((e) => e.event === 'progress' && e.data['stage'] === 'transcribing').length ?? 0) >= 2);
    service.handleJobCancelRequested({ jobId: 'job-7' });
    await expect(running).rejects.toBeInstanceOf(CrucibleAsrCancelled);
    expect(cli).not.toHaveBeenCalled();
    expect(fake.requestsTo(`/v1/jobs/${fake.jobs[0].jobId}`, 'DELETE')).toHaveLength(1);
    expect(ev.log.some(([n]) => n === 'failed')).toBe(true);
  });

  it('a failed job does not fall back either: the task fails with the server’s message', async () => {
    await wire({ asr: { failWith: { code: 'asr_window_failed', message: 'window 2 failed' } } });
    const { service, cli } = whisper(svc);
    await expect(service.transcribe(video, { jobId: 'job-8', route: { kind: 'crucible', server: 'mac', model: 'mlx-whisper-large-v3', fallback: 'inline' } }))
      .rejects.toThrow(/window 2 failed/);
    expect(cli).not.toHaveBeenCalled();
  });

  it('REGRESSION: the whisper-cli route (and no Crucible at all) is the pre-P5 path, called with the same arguments', async () => {
    await wire();
    const withRoute = whisper(svc);
    const a = await withRoute.service.transcribe(video, { jobId: 'job-9', model: 'base', translate: true, route: { kind: 'cli' } });
    expect(withRoute.cli).toHaveBeenCalledWith(video, 'job-9', 'base', true);
    expect(a).toEqual({ srtPath: withRoute.cliSrt, engine: 'whisper-cli', model: 'base', language: null, warnings: [] });

    const noCrucible = whisper(undefined);
    expect(await noCrucible.service.transcribeVideo(video, 'job-10', 'tiny', false)).toBe(noCrucible.cliSrt);
    expect(noCrucible.cli).toHaveBeenCalledWith(video, 'job-10', 'tiny', false);

    // translate through the venue rule: whisper-cli, never Crucible.
    const translate = whisper(svc);
    await translate.service.transcribe(video, { jobId: 'job-11', translate: true });
    expect(translate.cli).toHaveBeenCalledWith(video, 'job-11', undefined, true);
    expect(fake.jobs).toHaveLength(0);
    expect(fake.uploads).toHaveLength(0);
  });

  it('REGRESSION: whisper-cli failing still resolves transcribeVideo with null, as before', async () => {
    const { service, cli } = whisper(undefined);
    cli.mockResolvedValue(null);
    expect(await service.transcribeVideo(video, 'job-12')).toBeNull();
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
