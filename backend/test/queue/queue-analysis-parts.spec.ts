/**
 * An analysis job that asks for some parts (metadata / chapters / flags) or one
 * chapter's flags: the queue carries exactly what was asked to analyzeVideo,
 * through a park and back, cancels it like any lane task, and refuses an
 * impossible request at the door by name (400), before a job exists.
 */
import { HttpException } from '@nestjs/common';
import type { Task } from '../../src/common/interfaces/task.interface';
import { QueueController } from '../../src/queue/queue.controller';
import { makeRig, StubLanes, until } from './queue-rig';

const LOCAL_9B = 'local:qwen3.5-9b';

afterEach(() => jest.useRealTimers());

function partsJob(options: Record<string, unknown>) {
  return { videoId: 'v1', displayName: 'video v1', tasks: [{ type: 'analyze', options: { aiModel: LOCAL_9B, ...options } } as Task] };
}

const CHAPTER = { parts: ['flags'], range: { start: 3600, end: 4200, label: 'The second hour' } };

describe('an analysis job with parts', () => {
  it("carries exactly what was asked to the analysis, one chapter's range included", async () => {
    const rig = makeRig(new StubLanes());
    const seen: Array<Record<string, unknown>> = [];
    rig.media.analyze = async (_id, options) => {
      seen.push(options);
      return { success: true, data: { sectionsCount: 2 } };
    };
    const a = rig.qm.addJob(partsJob(CHAPTER));
    const b = rig.qm.addJob(partsJob({ parts: ['metadata', 'chapters'] }));
    await until(() => rig.qm.getJob(a)?.status === 'completed' && rig.qm.getJob(b)?.status === 'completed');
    expect(seen).toEqual([
      { aiModel: LOCAL_9B, ...CHAPTER },
      { aiModel: LOCAL_9B, parts: ['metadata', 'chapters'] },
    ]);
    rig.qm.onModuleDestroy();
  });

  it('parks when the card is busy, and runs later with the same parts and range', async () => {
    const lanes = new StubLanes();
    lanes.doorBusy.set('mac', 'leased: foundry, translate');
    const rig = makeRig(lanes);
    rig.qm.onModuleInit();
    const seen: Array<Record<string, unknown>> = [];
    rig.media.analyze = async (_id, options) => {
      seen.push(options);
      return { success: true, data: { sectionsCount: 1 } };
    };
    const id = rig.qm.addJob(partsJob(CHAPTER));
    await until(() => rig.qm.getJob(id)?.parkedReason === 'leased: foundry, translate');
    expect(seen).toHaveLength(0);
    lanes.doorBusy.delete('mac');
    lanes.serversChanged();
    await until(() => rig.qm.getJob(id)?.status === 'completed');
    expect(seen).toEqual([{ aiModel: LOCAL_9B, ...CHAPTER }]);
    rig.qm.onModuleDestroy();
  });

  it('cancels like any lane task: the run is told to stop and the job ends cancelled, never failed', async () => {
    const lanes = new StubLanes();
    const rig = makeRig(lanes);
    rig.media.gated.add('analyze');
    const cancels: string[] = [];
    rig.emitter.on('job.cancel-requested', (e: { jobId: string }) => cancels.push(e.jobId));
    const id = rig.qm.addJob(partsJob(CHAPTER));
    await until(() => rig.media.started('analyze').includes(id));
    expect(rig.qm.cancelJob(id)).toBe(true);
    expect(lanes.signals.get(id)?.aborted).toBe(true);
    expect(cancels).toEqual([id]);
    rig.media.release('analyze', id, { success: false, error: 'Analysis cancelled' });
    await until(() => rig.qm.getJob(id)?.status === 'cancelled');
    expect(rig.events.some((e) => e.name === 'task.failed')).toBe(false);
    rig.qm.onModuleDestroy();
  });
});

describe('the door refuses an impossible request by name', () => {
  const added: unknown[] = [];
  const controller = new QueueController({ addJob: (job: unknown) => (added.push(job), 'job-x') } as never);

  const refusal = async (body: Promise<unknown>) => {
    const err = await body.catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(400);
    return (err as HttpException).message;
  };

  it('no parts, an unknown part, or a range on anything but flags alone', async () => {
    expect(await refusal(controller.addJob(partsJob({ parts: [] })))).toMatch(/at least one part/);
    expect(await refusal(controller.addJob(partsJob({ parts: ['flags', 'everything'] })))).toMatch(/Unknown analysis part: everything/);
    expect(await refusal(controller.addBulkJobs({ jobs: [partsJob({ parts: ['chapters', 'flags'], range: { start: 0, end: 60 } })] }))).toMatch(
      /Only the flag analysis can run on part of a video/,
    );
    expect(added).toHaveLength(0);
  });

  it('a well-formed request is added as it is', async () => {
    await controller.addJob(partsJob(CHAPTER));
    await controller.addJob(partsJob({}));
    expect(added).toHaveLength(2);
  });
});
