/**
 * P7 REGRESSION: EVERYTHING THAT IS NOT AI WORKS WITH NO CRUCIBLE AT ALL.
 *
 * The user's rule: "If Crucible is down, Briefcase is down [for AI]. ... They
 * can still browse the clip collection, download clips, etc." Three ways to
 * have no Crucible, each driven through the REAL readiness signal, the REAL
 * lanes and the REAL queue (media operations stubbed, as in the queue specs):
 *
 *   no registry        nothing registered or installed, this computer could host one
 *   unreachable        a server is registered and nothing answers
 *   cannot host        nothing registered, and this computer cannot host one (Intel Mac)
 *
 * In each: downloads, imports, ffmpeg processing (normalize, aspect ratio,
 * combined), and clip exports run at the main pool's full width and complete,
 * asking the lanes nothing; AI work is refused by name, or (unreachable)
 * accepted and parked, holding no slot, so a library switch is never blocked;
 * nothing on this path waits for Crucible, the startup sweep included. And
 * statically: the non-AI services' import graph never reaches Crucible or the
 * AI pipeline, so no future edit can make browsing wait on it by accident.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleReadinessService, CrucibleRequiredError } from '../../src/crucible/readiness.service';
import type { CrucibleInstallService } from '../../src/crucible/install/install.service';
import type { CrucibleInstallPlan } from '../../src/crucible/wire/install-wire';
import { CrucibleLanesService } from '../../src/queue/crucible-lanes';
import type { Task } from '../../src/common/interfaces/task.interface';
import { unusedLoopbackUrl } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from '../crucible/harness';
import { analyzeJob, downloadJob, makeRig, transcribeJob, until, type Rig } from '../queue/queue-rig';

type Condition = 'no registry' | 'unreachable' | 'cannot host';

/** The install door for a machine with nothing installed: can it host one? */
function installDoor(hostable: 'yes' | 'no'): CrucibleInstallService {
  return {
    plan: () => ({ hostable, hostableWhy: hostable === 'no' ? 'This Mac has an Intel processor.' : 'Apple silicon', host: { discovered: { present: false, registeredAs: null } } }) as unknown as CrucibleInstallPlan,
    status: () => ({ running: false, last: null, interrupted: false, events: [] }),
    presence: async () => ({ state: 'absent', detail: '', message: null, offerStart: false }),
    startLocal: async () => { throw new Error('nothing to start in this spec'); },
  } as unknown as CrucibleInstallService;
}

interface World {
  h: Harness;
  readiness: CrucibleReadinessService;
  lanes: CrucibleLanesService;
  rig: Rig;
}

async function world(condition: Condition): Promise<World> {
  const h = harness();
  if (condition === 'unreachable') h.registry.add({ name: 'mac', url: await unusedLoopbackUrl(), token: 't' });
  const ledger = InFlightLedger.inDir(h.dir, () => undefined);
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes, ledger);
  const transcription = new CrucibleTranscriptionService(servers, h.probes, h.factory, ledger);
  const lanes = new CrucibleLanesService(servers, h.probes, chat, h.factory, h.registry, transcription, ledger);
  const readiness = new CrucibleReadinessService(servers, h.probes, h.registry, installDoor(condition === 'cannot host' ? 'no' : 'yes'));
  const rig = makeRig(lanes, readiness);
  return { h, readiness, lanes, rig };
}

function nonAiJobs(i: number): Array<{ label: string; job: { url?: string; videoId?: string; videoPath?: string; displayName?: string; tasks: Task[] } }> {
  return [
    { label: 'download + import', job: downloadJob(`https://example.com/clip-${i}`) },
    { label: 'normalize audio', job: { videoId: `n${i}`, tasks: [{ type: 'normalize-audio', options: { level: -16 } } as Task] } },
    { label: 'fix aspect ratio', job: { videoId: `a${i}`, tasks: [{ type: 'fix-aspect-ratio', options: {} } as Task] } },
    { label: 'process video', job: { videoId: `p${i}`, tasks: [{ type: 'process-video', options: { fixAspectRatio: true, normalizeAudio: true } } as Task] } },
  ];
}

describe.each<Condition>(['no registry', 'unreachable', 'cannot host'])('with no Crucible (%s)', (condition) => {
  let w: World;
  beforeEach(async () => {
    w = await world(condition);
  });
  afterEach(() => {
    w.rig.qm.onModuleDestroy();
    w.readiness.onApplicationShutdown();
  });

  it('boot waits on nothing: readiness, lanes and queue start synchronously, before any Crucible answer', async () => {
    const t0 = Date.now();
    // A startup sweep that never finishes must not hold anything non-AI.
    w.lanes.ready = new Promise<void>(() => undefined);
    w.readiness.onApplicationBootstrap();
    w.rig.qm.onModuleInit();
    expect(Date.now() - t0).toBeLessThan(50);
    const id = w.rig.qm.addJob(downloadJob('https://example.com/boot'));
    await until(() => w.rig.qm.getJob(id)?.status === 'completed', 3000, 'a download at boot');
  });

  it('downloads, imports and ffmpeg processing run at the main pool’s full width, complete, and ask the lanes nothing', async () => {
    const place = jest.spyOn(w.lanes, 'place');
    const placeTranscribe = jest.spyOn(w.lanes, 'placeTranscribe');
    w.rig.media.delayMs = 10;
    const ids = Array.from({ length: 5 }, (_, i) => nonAiJobs(i)).flat().map(({ job }) => w.rig.qm.addJob(job));
    await until(() => ids.every((id) => w.rig.qm.getJob(id)?.status === 'completed'), 10_000, 'every non-AI job');
    expect(w.rig.media.maxRunning).toBe(5);
    expect(w.rig.media.started('download')).toHaveLength(5);
    expect(w.rig.media.started('import')).toHaveLength(5);
    expect(w.rig.media.started('normalize-audio')).toHaveLength(5);
    expect(w.rig.media.started('fix-aspect-ratio')).toHaveLength(5);
    expect(w.rig.media.started('process-video')).toHaveLength(5);
    expect(place).not.toHaveBeenCalled();
    expect(placeTranscribe).not.toHaveBeenCalled();
    expect(w.rig.events.some((e) => e.name === 'task.failed')).toBe(false);
  });

  it('a clip export runs in the main pool and completes', async () => {
    const exportClip = jest.fn(async () => ({ success: true, data: { outputPath: '/tmp/clip.mp4' } }));
    (w.rig.qm as unknown as { executeExportClip: unknown }).executeExportClip = exportClip;
    const id = w.rig.qm.addJob({ videoId: 'v1', tasks: [{ type: 'export-clip', options: { videoPath: '/tmp/v1.mp4', startTime: 1, endTime: 5 } } as Task] });
    await until(() => w.rig.qm.getJob(id)?.status === 'completed', 3000, 'the export');
    expect(exportClip).toHaveBeenCalledTimes(1);
  });

  it('AI work is refused by name where it could never run, accepted and parked where a server is merely down; either way it holds no slot', async () => {
    await w.readiness.refresh();
    const expected = condition === 'unreachable' ? 'unreachable' : condition === 'cannot host' ? 'not-configured' : 'not-installed';
    expect(w.readiness.current().state).toBe(expected);
    if (condition === 'unreachable') {
      const analyze = w.rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'));
      const transcribe = w.rig.qm.addJob(transcribeJob('v2'));
      await until(() => [analyze, transcribe].every((id) => w.rig.qm.getJob(id)?.parkedReason !== undefined), 5000, 'both to park');
      expect(w.rig.qm.getJob(analyze)).toMatchObject({ status: 'pending', parkedReason: expect.stringMatching(/mac/) });
      expect(w.rig.qm.getJob(transcribe)).toMatchObject({ status: 'pending', parkedReason: expect.stringMatching(/mac/) });
      expect(w.rig.qm.hasActiveTasks()).toBe(false); // a library switch is not blocked
    } else {
      expect(() => w.rig.qm.addJob(analyzeJob('v1', 'local:qwen3.5-9b'))).toThrow(CrucibleRequiredError);
      expect(() => w.rig.qm.addJob(transcribeJob('v2'))).toThrow(/Transcription needs Crucible/);
      expect(w.rig.qm.getAllJobs()).toHaveLength(0);
    }
    // And a download queued after is untouched by any of it.
    const id = w.rig.qm.addJob(downloadJob('https://example.com/after'));
    await until(() => w.rig.qm.getJob(id)?.status === 'completed', 3000, 'the download after');
  });

  it('a download that asked for a transcript when Crucible could never run is refused whole, by name (the UI strips the AI step first)', async () => {
    await w.readiness.refresh();
    const job = { ...downloadJob('https://example.com/with-transcript'), tasks: [...downloadJob('x').tasks, { type: 'transcribe', options: {} } as Task] };
    if (condition === 'unreachable') {
      const id = w.rig.qm.addJob(job);
      await until(() => w.rig.qm.getJob(id)?.parkedReason !== undefined, 5000, 'the transcript step to park');
      expect(w.rig.media.started('download')).toHaveLength(1);
      expect(w.rig.media.started('import')).toHaveLength(1);
    } else {
      expect(() => w.rig.qm.addJob(job)).toThrow(CrucibleRequiredError);
    }
  });
});

describe('statically: the non-AI services have no import path into Crucible or the AI pipeline', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const NON_AI = [
    'downloader/downloader.service.ts',
    'downloader/downloader.controller.ts',
    'ffmpeg/ffmpeg.service.ts',
    'ffmpeg/ffmpeg.controller.ts',
    'ffmpeg/simple-process.controller.ts',
    'media/media-processing.service.ts',
    'library/clip-extractor.service.ts',
    'library/library.service.ts',
    'database/database.service.ts',
    'database/tabs.controller.ts',
    'database/file-scanner.service.ts',
    'database/library-manager.service.ts',
    'database/thumbnail.service.ts',
    'database/waveform.service.ts',
    'database/relinking.service.ts',
    'web-archive/web-archive.service.ts',
    'path/path.service.ts',
    'components/component-manager.service.ts',
  ];
  const AI = /[\\/]src[\\/](crucible|scorer)[\\/]|[\\/]analysis[\\/](ai-|analysis\.service)|[\\/]media[\\/]whisper\.service/;

  function resolve(from: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate)) return candidate;
    return null;
  }

  /** Every source file `file` loads at run time (type-only imports load nothing). */
  function closure(file: string): Set<string> {
    const seen = new Set<string>();
    const stack = [file];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?['"]([^'"]+)['"]/gm)) {
        if (m[2]) continue;
        const next = resolve(f, m[3]);
        if (next) stack.push(next);
      }
    }
    return seen;
  }

  it.each(NON_AI)('%s', (rel) => {
    const reached = [...closure(path.join(SRC, rel))].filter((f) => AI.test(f)).map((f) => path.relative(SRC, f));
    expect(reached).toEqual([]);
  });
});

describe('the legacy AI runtimes are gone for good', () => {
  const ROOT = path.resolve(__dirname, '../..');
  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? sources(p) : /\.ts$/.test(e.name) ? [p] : [];
    });
  }

  it('no source imports a removed runtime or a direct provider SDK', () => {
    const banned = /from ['"](@anthropic-ai\/sdk|openai|[^'"]*(llama-manager|llama-bridge|whisper-bridge|whisper-manager|ollama\.service|ollama-capabilities|nli-ranker\.service|nli-env|chapter-detection\.service|scorer-server\.service|scorer-engine|scorer-config|model-manager\.service|api-keys\.service|ai-via))['"]/;
    const hits = sources(path.join(ROOT, 'src')).filter((f) => banned.test(fs.readFileSync(f, 'utf8')));
    expect(hits.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the backend no longer depends on the Anthropic or OpenAI SDKs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).not.toEqual(expect.arrayContaining(['@anthropic-ai/sdk']));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('openai');
    expect(fs.existsSync(path.join(ROOT, 'python', 'nli-worker'))).toBe(false);
  });
});
