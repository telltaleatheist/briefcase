/**
 * REGRESSION: an interrupted standalone scorer tool gives back its lease.
 *
 * flag-eval.js stopped with `pkill -INT` exited on Node's default action: no
 * `finally` ran, and its scorer lease ('briefcase' for 'analysis', the 9B)
 * stayed held on the server until the TTL ran out, blocking the card for
 * another user for minutes. The harness (crucible-standalone.ts) now aborts
 * the run, lets it unwind, sweeps its own ledger with the app's quit sweep
 * (bounded), and exits 128+signal; a second signal exits at once.
 */
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { CrucibleRegistryService } from '../../src/crucible/registry.service';
import { getBriefcaseConfigDir } from '../../src/bridges/runtime-paths';
import {
  crucibleServices,
  exitCodeOf,
  releaseOnInterrupt,
  type StandaloneCrucible,
} from '../../src/scorer/live/crucible-standalone';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { tempDir } from './helpers';

Logger.overrideLogger(false);

const savedEnv = { ...process.env };
let fake: FakeCrucible;

beforeEach(async () => {
  process.env = { ...savedEnv, APPDATA: tempDir('standalone-appdata-') };
  fake = await startFakeCrucible({ models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 16384, maxModelLen: 16384 }] });
  new CrucibleRegistryService(getBriefcaseConfigDir()).add({ name: 'mac', url: fake.url, token: fake.token });
});
afterEach(async () => {
  process.env = savedEnv;
  fake.inject({});
  await fake.close();
});

const decideNeverAnswers = () => (fake.faults.connectDelay ??= []).push({ match: { path: '/v1/decide' }, ms: 60_000 });

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The tool's run: a lease on the scorer, then a decide the server never answers (no signal of its own). */
function heldRun(s: StandaloneCrucible, signal: AbortSignal): Promise<unknown> {
  return s.chat.withRun(() => s.scorer.withScorer(
    (h) => h.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] }), signal));
}

function interrupt(s: StandaloneCrucible, extra: { unwindMs?: number; releaseMs?: number; timeoutMs?: number } = {}) {
  const proc = new EventEmitter();
  const exit = jest.fn();
  const lines: string[] = [];
  const it = releaseOnInterrupt({
    ledger: s.ledger,
    runsSettled: (ms) => s.chat.runsSettled(ms),
    clientFor: (name) => s.factory.clientFor(name, { timeoutMs: extra.timeoutMs ?? 1_000 }),
    exit,
    log: (line) => lines.push(line),
    proc: proc as never,
    unwindMs: extra.unwindMs ?? 1_000,
    releaseMs: extra.releaseMs ?? 2_000,
    timing: { confirmForMs: 200, pollEveryMs: 20 },
  });
  return { it, proc, exit, lines };
}

describe('REGRESSION: an interrupted standalone scorer run releases its lease', () => {
  it('SIGINT mid-decide: the run is aborted, the lease released, the process exits 130', async () => {
    decideNeverAnswers();
    const s = crucibleServices('mac');
    const { it: stop, proc, exit } = interrupt(s);
    const run = heldRun(s, stop.signal);
    run.catch(() => undefined);
    await until(() => fake.requestsTo('/v1/decide').length > 0);
    const lease = fake.openLease();
    expect(lease).toMatchObject({ model: 'qwen3.5-9b', client: 'briefcase' });
    expect(s.ledger.read().map((r) => r.id)).toContain(lease!.leaseId);

    proc.emit('SIGINT');
    await until(() => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(130);
    expect(stop.signal.aborted).toBe(true);
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
    expect(fake.leases.released).toContain(lease!.leaseId);
    expect(fake.openLease()).toBeNull();
    expect(s.ledger.read()).toEqual([]);
    stop.dispose();
  });

  it('SIGTERM when the run cannot unwind by itself: the sweep of its own ledger gives the lease back', async () => {
    const s = crucibleServices('mac');
    const { it: stop, exit, lines } = interrupt(s, { unwindMs: 50 });
    // A run that ignores its signal (the worst case): only the sweep can release.
    let held!: () => void;
    const stuck = new Promise<void>((r) => { held = r; });
    const run = s.chat.withRun(() => s.scorer.withScorer(async () => { held(); await new Promise(() => undefined); }));
    run.catch(() => undefined);
    await stuck;
    const lease = fake.openLease();
    expect(lease).not.toBeNull();

    await stop.handle('SIGTERM');
    expect(exit).toHaveBeenCalledWith(143);
    expect(fake.leases.released).toContain(lease!.leaseId);
    expect(fake.openLease()).toBeNull();
    expect(lines.join('\n')).toMatch(/released lease/);
    stop.dispose();
  });

  it('a second signal exits at once, without waiting for the release', async () => {
    decideNeverAnswers();
    const s = crucibleServices('mac');
    const { it: stop, proc, exit } = interrupt(s);
    heldRun(s, stop.signal).catch(() => undefined);
    await until(() => fake.requestsTo('/v1/decide').length > 0);
    fake.inject({ stallMs: 60_000 }); // the release would take its whole deadline
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(exitCodeOf('SIGTERM'));
    fake.inject({});
    await stop.handle('SIGINT');
    stop.dispose();
  });

  it('an unreachable server cannot hang the exit: the release is bounded, and its row is kept', async () => {
    const s = crucibleServices('mac');
    const { it: stop, exit } = interrupt(s, { unwindMs: 100, releaseMs: 400, timeoutMs: 200 });
    let held!: () => void;
    const stuck = new Promise<void>((r) => { held = r; });
    s.chat.withRun(() => s.scorer.withScorer(async () => { held(); await new Promise(() => undefined); })).catch(() => undefined);
    await stuck;
    fake.inject({ stallMs: 60_000 }); // accepts, never answers
    const t0 = Date.now();
    await stop.handle('SIGINT');
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(exit).toHaveBeenCalledWith(130);
    expect(s.ledger.read().filter((r) => r.kind === 'lease')).toHaveLength(1);
    stop.dispose();
  });

  it('a real process: `kill -INT` mid-run releases the lease and exits 130', async () => {
    decideNeverAnswers();
    const child = spawn(process.execPath, [
      require.resolve('ts-node/dist/bin-transpile.js'),
      path.join(__dirname, 'fixtures', 'interrupted-standalone.ts'),
      'mac',
    ], { env: { ...process.env, TS_NODE_PROJECT: path.join(__dirname, '..', '..', 'tsconfig.spec.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    await until(() => /HELD \S+/.test(out) || child.exitCode !== null, 30_000);
    const leaseId = /HELD (\S+)/.exec(out)?.[1];
    expect(leaseId).toBeDefined();
    await until(() => fake.requestsTo('/v1/decide').length > 0);
    expect(fake.openLease()?.leaseId).toBe(leaseId);

    child.kill('SIGINT');
    const code = await exited;
    expect({ code, err: code === 130 ? '' : err }).toEqual({ code: 130, err: '' });
    expect(fake.leases.released).toContain(leaseId);
    expect(fake.openLease()).toBeNull();
  }, 45_000);
});
