import { coordinationBusy, coordinationLine, installHeadline, laneIsProblem, laneOccupancy, laneStateLine, laneWaiting, unmetLine } from './crucible-words';
import type { CrucibleCoordinationState, CrucibleModuleProgress } from '@crucible-wire/coordinate-wire';

// Plain describe/it/expect only, so this runs under Karma/Jasmine (ng test) and Jest alike.
const progress = (over: Partial<CrucibleModuleProgress>): CrucibleModuleProgress => ({
  server: 'mac', taskId: 't1', state: 'running', step: null, line: null, bytes: null, skipped: null, jobTypes: null, error: null, unmet: null, ...over,
});

describe('coordinationLine', () => {
  it('names the holder on a wait, verbatim', () => {
    const state: CrucibleCoordinationState = {
      server: 'mac', phase: 'waiting', missing: [], unmet: [], holder: { fact: 'a lease', who: 'bookforge, tts 62% done' }, attempts: 1, stopped: false,
    };
    expect(coordinationLine(state)).toContain('bookforge, tts 62% done');
    expect(coordinationBusy(state)).toBe(true);
  });

  it('says a held first run prepares on finish, and does nothing meanwhile', () => {
    const state: CrucibleCoordinationState = { server: 'mac', phase: 'deferred', reason: 'first-run' };
    expect(coordinationLine(state)).toContain('when you finish setup');
    expect(coordinationBusy(state)).toBe(false);
  });

  it('draws a download with its share of the total, and says it keeps going', () => {
    const state: CrucibleCoordinationState = {
      server: 'mac', phase: 'preparing', missing: [], unmet: [], followed: false,
      progress: progress({ step: { name: 'pull mlx-whisper-large-v3', index: 3, total: 4 }, bytes: { done: 512 * 1024 ** 2, total: 1024 ** 3, file: 'w.npz' } }),
    };
    const line = coordinationLine(state);
    expect(line).toContain('step 3 of 4');
    expect(line).toContain('50% of 1.0 GB');
    expect(line).toContain('keeps going while you work');
  });

  it('says whose task it is when following another app', () => {
    const state: CrucibleCoordinationState = { server: 'mac', phase: 'preparing', missing: [], unmet: [], followed: true, progress: progress({}) };
    expect(coordinationLine(state)).toContain("another app's setup");
  });

  it('a failed task carries its code', () => {
    const state: CrucibleCoordinationState = {
      server: 'mac', phase: 'preparing', missing: [], unmet: [], followed: false,
      progress: progress({ state: 'failed', error: { code: 'env_install_failed', message: 'pip exited 1' } }),
    };
    expect(coordinationLine(state)).toContain('env_install_failed: pip exited 1');
  });

  it('an unmet class is a fact about the machine, in its own words', () => {
    expect(unmetLine([{ class: 'analysis', reason: 'needs 20 GB, this Mac has 16' }])).toBe('Not on this server: video analysis (needs 20 GB, this Mac has 16).');
    expect(unmetLine([])).toBeNull();
  });
});

describe('installHeadline', () => {
  it('follows the latest step, and ends on done or failed', () => {
    expect(installHeadline([])).toBe('Starting the install.');
    expect(installHeadline([{ kind: 'step', step: 'local-readiness', index: null, total: null, status: 'running', detail: 'Waiting for Crucible to start' }]))
      .toBe('Starting Crucible: Waiting for Crucible to start');
    expect(installHeadline([{ kind: 'done', server: { name: 'c', url: 'u', configPath: 'p' }, release: '1.0.23', backend: 'mlx-darwin', connectedAs: 'c' }]))
      .toBe('Crucible 1.0.23 is installed and running.');
  });
});

describe('lane words', () => {
  it('names the state, keeping the holder sentence verbatim', () => {
    expect(laneStateLine({ state: 'ready', detail: null })).toBe('Ready');
    expect(laneStateLine({ state: 'busy', detail: 'bookforge, tts 62% done' })).toBe('Busy: bookforge, tts 62% done');
    expect(laneStateLine({ state: 'unreachable', detail: 'connection refused' })).toBe('Not answering');
    expect(laneStateLine({ state: 'paused', detail: null })).toBe('Paused');
    expect(laneStateLine({ state: 'unavailable', detail: 'no GPU' })).toBe('Unavailable: no GPU');
  });

  it('only unreachable and unavailable read as problems', () => {
    expect(laneIsProblem({ state: 'unreachable' })).toBe(true);
    expect(laneIsProblem({ state: 'unavailable' })).toBe(true);
    expect(laneIsProblem({ state: 'busy' })).toBe(false);
    expect(laneIsProblem({ state: 'paused' })).toBe(false);
  });

  it('counts occupancy and waiting', () => {
    expect(laneOccupancy({ running: [{ jobId: 'j', title: 't', model: 'm', lane: 'cloud' }], width: 2 })).toBe('1 of 2 running');
    expect(laneWaiting(0)).toBeNull();
    expect(laneWaiting(3)).toBe('3 waiting');
  });
});
