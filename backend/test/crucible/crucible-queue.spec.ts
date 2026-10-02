/**
 * CRUCIBLE'S QUEUE (1.0.71+, crucible docs/QUEUE.md), against the fake: a
 * load or an asr job that finds the card busy waits in the server's line
 * instead of being refused. The task says where it stands in the line, and a
 * job taken out of the line (expired, the operator, a restart) parks the task:
 * not run, not failed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { AIProviderService } from '../../src/analysis/ai-provider.service';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { queuesWork } from '../../src/crucible/crucible-queue';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleBusyError, CrucibleChatCancelled, CrucibleParkedError } from '../../src/crucible/llm/errors';
import { startFakeCrucible, stockedForBriefcase, type FakeCrucible, type FakeCrucibleOptions } from '../fake-crucible/fake-crucible';
import { harness } from './harness';
import { tempDir } from './helpers';

Logger.overrideLogger(false);

const open: FakeCrucible[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

async function rig(options: FakeCrucibleOptions = {}) {
  const fake = await startFakeCrucible({
    ...stockedForBriefcase(),
    models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 }],
    chatReplies: { '*': 'Cooking' },
    ...options,
  });
  open.push(fake);
  const h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes);
  chat.heartbeatMs = 40;
  return { fake, h, servers, chat };
}

describe('which servers queue', () => {
  it('1.0.71 and later queue work; older ones refuse it busy', () => {
    const at = (version: string) => queuesWork({ server: { version } as never });
    expect(at('1.0.70')).toBe(false);
    expect(at('1.0.71')).toBe(true);
    expect(at('1.0.72')).toBe(true);
    expect(at('1.1.0')).toBe(true);
  });
});

describe('a load in Crucible\'s line, outside a run', () => {
  it('waits its turn (waiting is the default, no queue field sent), and the chat runs', async () => {
    const { fake, chat } = await rig();
    fake.inject({ queueLine: { positions: [2, 1], then: 'start' } });
    const response = await new AIProviderService(chat).generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter');
    expect(response.text).toContain('Cooking');
    expect(fake.requestsTo('/v1/jobs', 'POST')[0].body).toMatchObject({ type: 'load-model' });
    expect(fake.requestsTo('/v1/jobs', 'POST')[0].body).not.toHaveProperty('queue');
    expect(fake.sessions.opened).toHaveLength(0);
    expect(fake.resident()).toBe('qwen3.5-9b');
  });

  it('taken out of the line before it ran is busy, never a failure', async () => {
    for (const reason of ['expired', 'operator', 'server_restart'] as const) {
      const { fake, chat } = await rig();
      fake.inject({ queueLine: { positions: [1], then: { removed: reason } } });
      const err = await chat.chat({ model: 'qwen3.5-9b', prompt: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrucibleBusyError);
      expect((err as CrucibleBusyError).busyLine).toContain(`taken out of Crucible's queue (${reason})`);
      expect(fake.resident()).toBeNull();
    }
  });
});

describe('a run\'s queue session in Crucible\'s line (1.0.76)', () => {
  const reserve = (chat: CrucibleChatService, extra: Record<string, unknown> = {}) =>
    chat.withRun(() => chat.withModel('mac', 'qwen3.5-9b', async () => 'ran'), { parkOnBusy: true, ...extra });

  it('waits its turn, the task told its place, then the run goes on in it', async () => {
    const { fake, chat } = await rig({ resident: 'qwen3.5-9b' });
    fake.inject({ queueLine: { positions: [2, 1], then: 'start', stepMs: 20 } });
    const lines: string[] = [];
    let beats = 0;
    const ran = await reserve(chat, { onWaiting: (line: string) => lines.push(line), onActivity: () => { beats += 1; } });
    expect(ran).toBe('ran');
    expect(fake.requestsTo('/v1/queue/sessions', 'POST')[0].body).toEqual({ act: 'analysis' });
    expect(lines).toEqual(["Waiting in Crucible's queue on mac (2 of 2)", "Waiting in Crucible's queue on mac (1 of 2)", 'Starting on mac...']);
    expect(beats).toBeGreaterThan(0);
    // No load: the model was already there.
    expect(fake.jobs.filter((j) => j.type === 'load-model')).toHaveLength(0);
    expect(fake.sessions.closed).toEqual([{ sessionId: 'ses-1', reason: 'client' }]);
  });

  it('taken out of the line (expired, the operator, a restart) is busy, never a failure: the run parks', async () => {
    const { fake, chat } = await rig({ resident: 'qwen3.5-9b' });
    fake.inject({ queueLine: { positions: [1], then: { removed: 'expired' }, stepMs: 5 } });
    const err = await reserve(chat).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleBusyError);
    expect((err as CrucibleBusyError).busyLine).toContain('Crucible ended the wait for a session (expired)');
  });

  it('a cancel while it waits takes it out of the line: cancelled, and nothing left open', async () => {
    const { fake, chat } = await rig({ resident: 'qwen3.5-9b' });
    fake.inject({ queueLine: { positions: [3, 2, 1], then: 'start', stepMs: 200 } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const err = await chat.withRun(
      () => chat.withModel('mac', 'qwen3.5-9b', async () => 'ran', { signal: controller.signal }),
      { parkOnBusy: true },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleChatCancelled);
    expect(fake.requestsTo('/v1/queue/sessions/ses-1', 'DELETE')).toHaveLength(1);
    expect(fake.openSession()).toBeNull();
  });
});

describe('a transcription in Crucible\'s line', () => {
  async function transcribe(fake: FakeCrucible, h: ReturnType<typeof harness>, onProgress: (percent: number, message: string) => void) {
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
    svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
    const video = path.join(tempDir('queue-video-'), 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(16 * 1024, 3));
    return svc.transcribe({
      server: 'mac', model: 'qwen3-asr-0.6b-mlx', videoFile: video, outputDir: tempDir('queue-out-'), baseName: 'a', localId: 'a', onProgress,
    });
  }

  it('waits its turn (the default), saying its place, then transcribes', async () => {
    const { fake, h } = await rig();
    fake.inject({ queueLine: { positions: [3, 2, 1], then: 'start' } });
    const seen: string[] = [];
    const outcome = await transcribe(fake, h, (_percent, message) => seen.push(message));
    expect(outcome.cues).toBe(3);
    expect(fake.requestsTo('/v1/jobs', 'POST')[0].body).toMatchObject({ type: 'asr' });
    expect(fake.requestsTo('/v1/jobs', 'POST')[0].body).not.toHaveProperty('queue');
    expect(seen).toEqual(expect.arrayContaining([
      'Queued on Crucible on mac (position 3)...',
      'Queued on Crucible on mac (position 1)...',
    ]));
  });

  it('taken out of the line parks the task, never a failure', async () => {
    const { fake, h } = await rig();
    fake.inject({ queueLine: { positions: [1], then: { removed: 'expired' } } });
    const err = await transcribe(fake, h, () => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect((err as Error).message).toContain("took the transcription out of its queue (expired)");
  });
});

describe('the card busy with something Crucible cannot evict (accelerator_busy)', () => {
  it('a load that fails at the front of the line for it is busy, never a failure: the run parks', async () => {
    const { fake, chat } = await rig();
    fake.inject({ failLoadWith: { code: 'accelerator_busy', message: "cannot load 'qwen3.5-9b': 19.5 GiB of the 24.0 GiB card is in use" } });
    const err = await chat.withRun(() => chat.withModel('mac', 'qwen3.5-9b', async () => 'ran'), { parkOnBusy: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleBusyError);
    expect((err as CrucibleBusyError).busyLine).toContain('19.5 GiB of the 24.0 GiB card is in use');
  });

  it('a transcription that fails for it parks the task, never fails it', async () => {
    const { h } = await rig({ asr: { failWith: { code: 'accelerator_busy', message: "cannot load 'qwen3-asr-0.6b': 19.5 GiB of the 24.0 GiB card is in use" } } });
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
    svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
    const video = path.join(tempDir('queue-video-'), 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(16 * 1024, 3));
    const err = await svc.transcribe({
      server: 'mac', model: 'qwen3-asr-0.6b-mlx', videoFile: video, outputDir: tempDir('queue-out-'), baseName: 'a', localId: 'a',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
    expect((err as Error).message).toContain('19.5 GiB of the 24.0 GiB card is in use');
  });
});

describe('first in line, waiting for a process Crucible does not own to free the card (1.0.82)', () => {
  const HOLDER = 'pid 4242 python (19.5 GiB) holds the card';

  it('a load says what it waits for, keeps the run alive, then loads and the chat runs', async () => {
    const { fake, chat } = await rig();
    fake.inject({ queueLine: { positions: [1], then: 'start', waitingFor: HOLDER, stepMs: 10 } });
    const lines: string[] = [];
    let beats = 0;
    const response = await chat.withRun(
      () => new AIProviderService(chat).generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter'),
      { onWaiting: (line) => lines.push(line), onActivity: () => { beats += 1; } },
    );
    expect(response.text).toContain('Cooking');
    expect(lines).toContain(`Waiting for the GPU on mac: ${HOLDER}`);
    expect(lines[lines.length - 1]).toBe('Loading qwen3.5-9b on mac...');
    expect(beats).toBeGreaterThan(0);
  });

  it('a transcription says what it waits for, then transcribes', async () => {
    const { fake, h } = await rig();
    fake.inject({ queueLine: { positions: [1], then: 'start', waitingFor: HOLDER, stepMs: 10 } });
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
    svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
    const video = path.join(tempDir('queue-video-'), 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(16 * 1024, 3));
    const seen: string[] = [];
    const outcome = await svc.transcribe({
      server: 'mac', model: 'qwen3-asr-0.6b-mlx', videoFile: video, outputDir: tempDir('queue-out-'), baseName: 'a', localId: 'a',
      onProgress: (_percent, message) => seen.push(message),
    });
    expect(outcome.cues).toBe(3);
    expect(seen).toContain(`Waiting for the GPU on mac: ${HOLDER}`);
  });

  it('a wait that runs out is removed expired: the task parks', async () => {
    const { fake, h } = await rig();
    fake.inject({ queueLine: { positions: [1], then: { removed: 'expired' }, waitingFor: HOLDER, stepMs: 10 } });
    const ledger = InFlightLedger.inDir(h.dir, () => undefined);
    const svc = new CrucibleTranscriptionService(new CrucibleServersService(h.registry, h.factory), h.probes, h.factory, ledger);
    svc.jobTiming = { doorDelaysMs: [5], streamDelaysMs: [5, 5, 5] };
    const video = path.join(tempDir('queue-video-'), 'clip.mp4');
    fs.writeFileSync(video, Buffer.alloc(16 * 1024, 3));
    const err = await svc.transcribe({
      server: 'mac', model: 'qwen3-asr-0.6b-mlx', videoFile: video, outputDir: tempDir('queue-out-'), baseName: 'a', localId: 'a',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrucibleParkedError);
  });
});
