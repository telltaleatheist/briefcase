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
import { CrucibleBusyError, CrucibleParkedError } from '../../src/crucible/llm/errors';
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

describe('a load in Crucible\'s line', () => {
  it('is submitted with the queue; the task says its place, then that the model is loading, and the chat runs', async () => {
    const { fake, chat } = await rig();
    fake.inject({ queueLine: { positions: [2, 1], then: 'start' } });
    const lines: string[] = [];
    let beats = 0;
    const response = await chat.withRun(
      () => new AIProviderService(chat).generateText('prompt', { provider: 'local', model: 'qwen3.5-9b' }, 'chapter'),
      { onWaiting: (line) => lines.push(line), onActivity: () => { beats += 1; } },
    );
    expect(response.text).toContain('Cooking');
    expect(fake.requestsTo('/v1/jobs', 'POST')[0].body).toMatchObject({ type: 'load-model', queue: {} });
    expect(lines).toEqual([
      "Waiting in Crucible's queue on mac (2 of 2)",
      "Waiting in Crucible's queue on mac (1 of 2)",
      'Loading qwen3.5-9b on mac...',
    ]);
    expect(beats).toBeGreaterThan(0);
    expect(fake.resident()).toBe('qwen3.5-9b');
  });

  it('taken out of the line before it ran is busy, never a failure: a queue run parks on it', async () => {
    for (const reason of ['expired', 'operator', 'server_restart'] as const) {
      const { fake, chat } = await rig();
      fake.inject({ queueLine: { positions: [1], then: { removed: reason } } });
      const err = await chat.withRun(
        () => chat.withModel('mac', 'qwen3.5-9b', async () => 'never'),
        { parkOnBusy: true },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrucibleBusyError);
      expect((err as CrucibleBusyError).busyLine).toContain(`taken out of Crucible's queue (${reason})`);
      expect(fake.resident()).toBeNull();
    }
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

  it('is submitted with the queue and says its place while it waits, then transcribes', async () => {
    const { fake, h } = await rig();
    fake.inject({ queueLine: { positions: [3, 2, 1], then: 'start' } });
    const seen: string[] = [];
    const outcome = await transcribe(fake, h, (_percent, message) => seen.push(message));
    expect(outcome.cues).toBe(3);
    expect(fake.requestsTo('/v1/jobs', 'POST')[0].body).toMatchObject({ type: 'asr', queue: {} });
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
