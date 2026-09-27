/**
 * A job's two chains side by side (the user, 2026-09-27: "fix aspect ratio and
 * normalize audio volume can run concurrently with transcribe and ai analyze"):
 * the file chain on the main pool and the AI chain on a lane run at once once
 * everything before them is done; within a chain the order holds; a barrier
 * task (download, import) still waits for everything before it; and a failure
 * or a cancel on one chain is the job's.
 */
import type { Task } from '../../src/common/interfaces/task.interface';
import { makeRig, StubLanes, until, type Rig } from './queue-rig';

const LOCAL_9B = 'qwen3.5-9b';

afterEach(() => jest.useRealTimers());

function processedJob(extra: Task[] = []) {
  return {
    videoId: 'v1',
    displayName: 'video v1',
    tasks: [
      { type: 'fix-aspect-ratio', options: {} } as Task,
      { type: 'normalize-audio', options: {} } as Task,
      { type: 'transcribe', options: {} } as Task,
      { type: 'analyze', options: { aiModel: LOCAL_9B } } as Task,
      ...extra,
    ],
  };
}

function rigWithGates(...ops: string[]): Rig {
  const rig = makeRig(new StubLanes());
  for (const op of ops) rig.media.gated.add(op);
  rig.qm.onModuleInit();
  return rig;
}

describe("a job's file and AI chains", () => {
  it('transcribe starts while fix-aspect-ratio is still running, and each chain keeps its own order', async () => {
    const rig = rigWithGates('fix-aspect-ratio', 'normalize-audio', 'transcribe', 'analyze');
    const id = rig.qm.addJob(processedJob());

    await until(() => rig.media.gates.has(`fix-aspect-ratio:${id}`) && rig.media.gates.has(`transcribe:${id}`), 3000, 'both chains running');
    expect(rig.qm.getJob(id)?.runningTasks).toEqual([0, 2]);
    // Within each chain, the second waits for the first.
    expect(rig.media.started('normalize-audio')).toEqual([]);
    expect(rig.media.started('analyze')).toEqual([]);

    // The AI chain runs ahead: transcribe done, analyze starts, the file chain still on its first task.
    rig.media.release('transcribe', id);
    await until(() => rig.media.gates.has(`analyze:${id}`), 3000, 'analyze started');
    expect(rig.qm.getJob(id)?.currentTaskIndex).toBe(0);
    expect(rig.qm.getJob(id)?.completedTasks).toEqual([2]);

    rig.media.release('fix-aspect-ratio', id);
    await until(() => rig.media.gates.has(`normalize-audio:${id}`), 3000, 'normalize started');
    rig.media.release('analyze', id);
    await until(() => (rig.qm.getJob(id)?.completedTasks ?? []).includes(3), 3000, 'analyze done');
    expect(rig.qm.getJob(id)?.status).toBe('processing');

    rig.media.release('normalize-audio', id);
    await until(() => rig.qm.getJob(id)?.status === 'completed', 3000, 'job completed');
    expect(rig.qm.getJob(id)?.currentTaskIndex).toBe(4);
    expect(rig.qm.getJob(id)?.completedTasks).toEqual([]);
    rig.qm.onModuleDestroy();
  });

  it('a download and import finish before either chain starts, and a later file task waits only for its own chain', async () => {
    const rig = rigWithGates('transcribe', 'normalize-audio', 'process-video');
    const id = rig.qm.addJob({
      url: 'https://example.com/a',
      displayName: 'a',
      tasks: [
        { type: 'download', options: {} } as Task,
        { type: 'import', options: {} } as Task,
        { type: 'normalize-audio', options: {} } as Task,
        { type: 'transcribe', options: {} } as Task,
        // Not a real job shape, but the rule: a later file task after the AI
        // chain still runs in its chain's order, alongside the transcription.
        { type: 'process-video', options: {} } as Task,
      ],
    });
    await until(() => rig.media.gates.has(`normalize-audio:${id}`) && rig.media.gates.has(`transcribe:${id}`), 3000, 'both chains');
    // Neither chain started before the download and the import were done.
    expect(rig.media.calls.map((c) => c.op).slice(0, 2)).toEqual(['download', 'import']);
    // process-video is on the file chain: it waits for normalize, not for transcribe.
    rig.media.release('normalize-audio', id);
    await until(() => rig.media.gates.has(`process-video:${id}`), 3000, 'process-video started');
    expect(rig.media.gates.has(`transcribe:${id}`)).toBe(true);
    rig.media.release('process-video', id);
    rig.media.release('transcribe', id);
    await until(() => rig.qm.getJob(id)?.status === 'completed', 3000, 'job completed');
    rig.qm.onModuleDestroy();
  });

  it('a failed file task fails the job, and the running transcription finishes but nothing after it starts', async () => {
    const rig = rigWithGates('fix-aspect-ratio', 'transcribe', 'analyze');
    const id = rig.qm.addJob(processedJob());
    await until(() => rig.media.gates.has(`fix-aspect-ratio:${id}`) && rig.media.gates.has(`transcribe:${id}`), 3000, 'both chains');

    rig.media.release('fix-aspect-ratio', id, { success: false, error: 'ffmpeg exited 1' });
    await until(() => rig.qm.getJob(id)?.status === 'failed', 3000, 'job failed');
    expect(rig.qm.getJob(id)?.error).toBe('ffmpeg exited 1');

    rig.media.release('transcribe', id);
    await until(() => rig.events.some((e) => e.name === 'task.completed' && e.data['type'] === 'transcribe'), 3000, 'transcribe completed');
    expect(rig.qm.getJob(id)?.status).toBe('failed');
    expect(rig.media.started('analyze')).toEqual([]);
    expect(rig.media.started('normalize-audio')).toEqual([]);
    rig.qm.onModuleDestroy();
  });

  it('a cancel stops both chains and neither reports a failure', async () => {
    const rig = rigWithGates('fix-aspect-ratio', 'transcribe');
    const id = rig.qm.addJob(processedJob());
    await until(() => rig.media.gates.has(`fix-aspect-ratio:${id}`) && rig.media.gates.has(`transcribe:${id}`), 3000, 'both chains');

    const aborts: string[] = [];
    rig.emitter.on('job.cancel-requested', (e: { type: string }) => aborts.push(e.type));
    expect(rig.qm.cancelJob(id)).toBe(true);
    expect(aborts.sort()).toEqual(['fix-aspect-ratio', 'transcribe']);

    // The stubs don't die on abort: the ops come back as the real ones would, rejected.
    rig.media.release('fix-aspect-ratio', id, { success: false, error: 'aborted' });
    rig.media.release('transcribe', id, { success: false, error: 'aborted' });
    await until(() => (rig.qm.getJob(id)?.runningTasks ?? []).length === 0, 3000, 'both settled');
    expect(rig.qm.getJob(id)?.status).toBe('cancelled');
    expect(rig.events.filter((e) => e.name === 'task.failed')).toEqual([]);
    rig.qm.onModuleDestroy();
  });

  it('a job with only one chain runs strictly in order, as before', async () => {
    const rig = rigWithGates('fix-aspect-ratio', 'normalize-audio');
    const id = rig.qm.addJob({
      videoId: 'v1',
      displayName: 'v1',
      tasks: [{ type: 'fix-aspect-ratio', options: {} } as Task, { type: 'normalize-audio', options: {} } as Task],
    });
    await until(() => rig.media.gates.has(`fix-aspect-ratio:${id}`), 3000, 'fix started');
    expect(rig.media.started('normalize-audio')).toEqual([]);
    rig.media.release('fix-aspect-ratio', id);
    await until(() => rig.media.gates.has(`normalize-audio:${id}`), 3000, 'normalize started');
    rig.media.release('normalize-audio', id);
    await until(() => rig.qm.getJob(id)?.status === 'completed', 3000, 'job completed');
    rig.qm.onModuleDestroy();
  });
});
