/**
 * P7: THE ONE READINESS SIGNAL, over the real registry, probe and servers
 * against the fake, with the install door scripted: every state and its
 * door, the gate every AI door asks, bringing Crucible up (once per outage,
 * never after "Not now"), and the answer pushed on `crucible.readiness`.
 */
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleReadinessService, CrucibleRequiredError, crucibleTasksIn, isCrucibleRequired } from '../../src/crucible/readiness.service';
import type { CrucibleInstallService } from '../../src/crucible/install/install.service';
import type { CrucibleEnginePresence, CrucibleEngineStartOutcome, CrucibleInstallPlan } from '../../src/crucible/wire/install-wire';
import type { CrucibleReadinessView } from '../../src/crucible/wire/readiness-wire';
import { startFakeCrucible, unusedLoopbackUrl, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness, type Harness } from './harness';
import { busyLineOf } from '../../src/crucible/probe';
import { busyLineFor, busyLineForJob, claimBusyLine } from '../../src/queue/crucible-lanes';
import type { Activity } from '@crucible/client';

/** The install door, scripted: hostability, what is on this computer, its engine's presence, and Start. */
class StubInstall {
  hostable: 'yes' | 'no' = 'yes';
  here: { present: boolean; registeredAs: string | null } = { present: false, registeredAs: null };
  presenceValue: CrucibleEnginePresence = { state: 'stopped', detail: '', message: 'Crucible is stopped on this computer.', offerStart: true };
  installing = false;
  starts = 0;
  startResult: () => Promise<CrucibleEngineStartOutcome> = async () => ({ started: true, detail: 'running', connectedAs: null });

  plan(): CrucibleInstallPlan {
    return {
      hostable: this.hostable,
      hostableWhy: this.hostable === 'no' ? 'This Mac has an Intel processor; Crucible runs on Apple silicon or NVIDIA.' : 'Apple silicon',
      host: { discovered: this.here },
    } as unknown as CrucibleInstallPlan;
  }
  status() {
    return { running: this.installing, last: null, interrupted: false, events: this.installing ? [{ kind: 'step', step: 'downloading the runtime', index: 1, total: 4, status: 'running', detail: '' }] : [] };
  }
  async presence() { return this.presenceValue; }
  async startLocal() {
    this.starts++;
    return this.startResult();
  }
}

let fake: FakeCrucible | null = null;
let h: Harness;
let install: StubInstall;
let readiness: CrucibleReadinessService;
let pushed: CrucibleReadinessView[];

function wire(): void {
  install = new StubInstall();
  pushed = [];
  readiness = new CrucibleReadinessService(
    new CrucibleServersService(h.registry, h.factory),
    h.probes,
    h.registry,
    install as unknown as CrucibleInstallService,
    { emitCrucibleReadiness: (v: CrucibleReadinessView) => pushed.push(v) } as never,
  );
}

beforeEach(() => {
  h = harness();
  wire();
});
afterEach(async () => {
  readiness.onApplicationShutdown();
  await fake?.close();
  fake = null;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('the states, and the one door each offers', () => {
  it('ready: an enabled server answers; the gates pass', async () => {
    fake = await startFakeCrucible();
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const view = await readiness.refresh();
    expect(view).toMatchObject({ state: 'ready', server: 'mac', action: null, busy: null, aiWaiting: 0 });
    expect(() => readiness.assertCanQueue('AI analysis')).not.toThrow();
    expect(() => readiness.assertReadyNow('Library insights')).not.toThrow();
  });

  it('ready but busy: another client holding the card is said, and work still queues (it parks until free)', async () => {
    fake = await startFakeCrucible();
    fake.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    const view = await readiness.refresh();
    expect(view.state).toBe('ready');
    expect(view.busy).toMatch(/bookforge/);
    expect(() => readiness.assertCanQueue('AI analysis')).not.toThrow();
  });

  it('unreachable (a remote server down): connect; queued work is accepted and parks, an immediate call is refused', async () => {
    h.registry.add({ name: 'pc', url: await unusedLoopbackUrl(), token: 't' });
    const view = await readiness.refresh();
    expect(view).toMatchObject({ state: 'unreachable', action: 'connect' });
    expect(view.reason).toMatch(/pc/);
    expect(() => readiness.assertCanQueue('AI analysis')).not.toThrow();
    expect(() => readiness.assertReadyNow('Library insights')).toThrow(CrucibleRequiredError);
  });

  it('unreachable, and it is the Crucible on this computer, stopped: start', async () => {
    h.registry.add({ name: 'local', url: await unusedLoopbackUrl(), token: 't' });
    install.here = { present: true, registeredAs: 'local' };
    const view = await readiness.refresh();
    expect(view).toMatchObject({ state: 'unreachable', action: 'start', reason: 'Crucible is stopped on this computer.' });
  });

  it('installed here but not registered: start (which adopts it)', async () => {
    install.here = { present: true, registeredAs: null };
    expect(await readiness.refresh()).toMatchObject({ state: 'unreachable', action: 'start' });
  });

  it('not installed, and this computer can host one: install; AI work is refused at the door, by name', async () => {
    const view = await readiness.refresh();
    expect(view).toMatchObject({ state: 'not-installed', action: 'install' });
    let err: unknown;
    try {
      readiness.assertCanQueue('Transcription');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CrucibleRequiredError);
    expect(isCrucibleRequired(err)).toBe(true);
    expect((err as CrucibleRequiredError).getStatus()).toBe(409);
    expect((err as CrucibleRequiredError).getResponse()).toMatchObject({ code: 'crucible_required', message: expect.stringMatching(/^Transcription needs Crucible\. Crucible is not installed/), readiness: { state: 'not-installed' } });
  });

  it('not configured: this computer cannot host one (an Intel Mac): connect, with why', async () => {
    install.hostable = 'no';
    const view = await readiness.refresh();
    expect(view).toMatchObject({ state: 'not-configured', action: 'connect' });
    expect(view.reason).toMatch(/Intel processor.*Connect to a Crucible on another computer/);
  });

  it('not configured: every registered server is paused', async () => {
    fake = await startFakeCrucible();
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    new CrucibleServersService(h.registry, h.factory).pause('mac');
    expect(await readiness.refresh()).toMatchObject({ state: 'not-configured', action: 'connect', reason: expect.stringMatching(/paused/) });
  });

  it('starting while an install runs, with its latest step', async () => {
    install.installing = true;
    expect(await readiness.refresh()).toMatchObject({ state: 'starting', progress: 'Installing Crucible: downloading the runtime' });
    expect(() => readiness.assertCanQueue('AI analysis')).not.toThrow();
  });

  it('before the first derivation it answers from the registry alone, and reads no network', () => {
    expect(readiness.current()).toMatchObject({ state: 'not-configured', action: null, reason: 'Checking for Crucible...' });
  });
});

describe('bringing it up', () => {
  it('AI work waiting and the Crucible here stopped: started automatically, once per outage, with progress; ready after', async () => {
    fake = await startFakeCrucible();
    const url = fake.url;
    h.registry.add({ name: 'local', url: await unusedLoopbackUrl(), token: fake.token });
    install.here = { present: true, registeredAs: 'local' };
    await readiness.refresh();
    expect(readiness.current().action).toBe('start');
    install.startResult = async () => {
      // The engine came up where the registry points.
      h.registry.remove('local');
      h.registry.add({ name: 'local', url, token: fake!.token });
      return { started: true, detail: 'running', connectedAs: null };
    };
    readiness.noteAiWaiting(2);
    expect(readiness.current()).toMatchObject({ state: 'starting', progress: 'Starting Crucible on this computer...' });
    await until(() => readiness.current().state === 'ready');
    expect(install.starts).toBe(1);
    expect(pushed.map((v) => v.state)).toEqual(expect.arrayContaining(['unreachable', 'starting', 'ready']));
    // More waiting work does not start it again.
    readiness.noteAiWaiting(3);
    expect(install.starts).toBe(1);
  });

  it('a start that fails says why, and is not tried again on its own this outage', async () => {
    install.here = { present: true, registeredAs: null };
    install.startResult = async () => ({ started: false, detail: 'launchctl: service not found', connectedAs: null });
    await readiness.refresh();
    readiness.noteAiWaiting(1);
    await until(() => readiness.current().state !== 'starting' && install.starts === 1);
    await until(() => /could not be started.*service not found/.test(readiness.current().reason));
    readiness.noteAiWaiting(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(install.starts).toBe(1);
  });

  it('"Not now": nothing starts on its own for the rest of the session, queueing is refused, an explicit Start still works', async () => {
    install.here = { present: true, registeredAs: null };
    await readiness.refresh();
    expect(readiness.decline()).toMatchObject({ declined: true });
    readiness.noteAiWaiting(4);
    await new Promise((r) => setTimeout(r, 20));
    expect(install.starts).toBe(0);
    expect(() => readiness.assertCanQueue('AI analysis')).toThrow(CrucibleRequiredError);
    expect((await readiness.refresh()).declined).toBe(true);
    await readiness.start();
    await until(() => install.starts === 1);
  });

  it('a queued-work count is shown only while it matters (not when ready)', async () => {
    await readiness.refresh();
    readiness.noteAiWaiting(3);
    expect(readiness.current().aiWaiting).toBe(3);
  });
});

describe('pushing the answer', () => {
  it('on Socket.IO and to in-process listeners, only when it changes; a registry change re-derives on its own', async () => {
    const heard: string[] = [];
    readiness.onChange((v) => heard.push(v.state));
    readiness.onApplicationBootstrap();
    await until(() => pushed.length === 1);
    expect(pushed[0].state).toBe('not-installed');
    await readiness.refresh();
    expect(pushed).toHaveLength(1);
    fake = await startFakeCrucible();
    h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
    await until(() => readiness.current().state === 'ready');
    expect(heard).toEqual(['not-installed', 'ready']);
  });
});

describe('an engine claim is busy, whoever holds it but us', () => {
  const activity = (claim: string | null, acceptsWork = true): Activity => ({
    running: [], queued: [], claim: claim === null ? null : { heldBy: claim }, streaming: null, lease: null, resident: null,
    slots: { accelerated: { acceptsWork } },
  } as unknown as Activity);

  it("the settlement clearing the card reads busy to the probe (readiness) and to admission (both lanes' preflights)", () => {
    const settling = activity('the settlement clearing the card');
    expect(busyLineOf(settling)).toBe('busy: the card is held by the settlement clearing the card');
    expect(claimBusyLine(settling)).toBe('Crucible is busy: the card is held by the settlement clearing the card');
    expect(busyLineFor(settling, new Set(), { model: 'qwen3.5-9b', route: 'local', upstream: null, bareModel: 'qwen3.5-9b' })).toMatch(/settlement clearing the card/);
    expect(busyLineForJob(settling, new Set())).toMatch(/settlement clearing the card/);
  });

  it('no claim, or our own: not busy', () => {
    expect(busyLineOf(activity(null))).toBeNull();
    expect(claimBusyLine(activity('briefcase crucible-client/1.0.24'))).toBeNull();
    expect(busyLineForJob(activity(null), new Set())).toBeNull();
  });
});

describe('which tasks need Crucible', () => {
  it('transcribe, analyze and analyze-webpage; nothing else', () => {
    expect(crucibleTasksIn([
      { type: 'get-info' }, { type: 'download' }, { type: 'import' }, { type: 'fix-aspect-ratio' }, { type: 'normalize-audio' },
      { type: 'process-video' }, { type: 'export-clip' }, { type: 'transcribe' }, { type: 'analyze' }, { type: 'analyze-webpage' },
    ])).toEqual(['transcribe', 'analyze', 'analyze-webpage']);
  });
});
