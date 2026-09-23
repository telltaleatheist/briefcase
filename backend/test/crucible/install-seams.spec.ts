/**
 * The three small seams around the install: the Windows `.cmd` spawn plan,
 * the host's install door, and the local engine's presence read through the
 * real `@crucible/bootstrap` controls over a temp CRUCIBLE_HOME and a
 * scripted runner (nothing is spawned).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { HostEvent, RunResult, Runner, WslOutcome } from '@crucible/bootstrap';
import { crucibleSpawnPlan } from '../../src/crucible/install/host-runner';
import { HostInstallDoor, installOutcomeIsTerminal, type InstallDoorHost } from '../../src/crucible/install/install-door';
import { presenceOf, processLocalControls } from '../../src/crucible/install/engine-presence';
import type { CrucibleInstallDoorEvent } from '../../src/crucible/wire/install-door-wire';
import { tempDir } from './helpers';

describe('crucibleSpawnPlan', () => {
  it('leaves every non-.cmd target, and every target off Windows, untouched', () => {
    expect(crucibleSpawnPlan(['/h/.crucible/server/bin/crucible', 'status', '--json'], 'darwin'))
      .toEqual({ program: '/h/.crucible/server/bin/crucible', args: ['status', '--json'], verbatim: false });
    expect(crucibleSpawnPlan(['wsl.exe', '-l', '-v'], 'win32')).toEqual({ program: 'wsl.exe', args: ['-l', '-v'], verbatim: false });
  });

  it('routes a Windows .cmd through cmd.exe /d /s /c with every token quoted', () => {
    expect(crucibleSpawnPlan(['C:\\Users\\Owen Morgan\\AppData\\Local\\Crucible\\host\\crucible.cmd', 'start', '--json'], 'win32')).toEqual({
      program: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Users\\Owen Morgan\\AppData\\Local\\Crucible\\host\\crucible.cmd" "start" "--json""'],
      verbatim: true,
    });
  });

  it('refuses, never escapes, a quote or a percent sign bound for cmd.exe', () => {
    expect(() => crucibleSpawnPlan(['C:\\%USERNAME%\\crucible.cmd', 'start'], 'win32')).toThrow(/host_runner_bad_path/);
    expect(() => crucibleSpawnPlan(['C:\\x\\crucible.bat', 'a"b'], 'win32')).toThrow(/host_runner_bad_path/);
  });
});

describe('HostInstallDoor', () => {
  const outcome = (state: WslOutcome['state']): WslOutcome => ({ state, code: state === 'done' ? null : 'wsl_missing', sentence: state === 'done' ? null : 'WSL is not installed.', at: '2026-09-23T10:00:00Z', release: '1.0.23', attempts: 1 });

  function doorHost(platform: NodeJS.Platform, installed: boolean, events: HostEvent[], ending: WslOutcome | null): InstallDoorHost & { posted: string[] } {
    const posted: string[] = [];
    return {
      posted,
      runner: () => ({ platform }) as Runner,
      status: async () => ({ running: false, outcome: ending }),
      watch: async (sinks) => {
        for (const event of events) sinks.onEvent(event);
        return { running: false, outcome: ending };
      },
      post: async (release) => { posted.push(release); },
      installed: () => installed,
    };
  }

  it('off Windows there is no move: status is quiet and nothing is watched', async () => {
    const door = new HostInstallDoor(doorHost('darwin', true, [], outcome('failed')));
    expect(await door.status()).toEqual({ running: false, outcome: null });
    await expect(door.start()).rejects.toThrow(/host_not_installed/);
  });

  it('on Windows it relays the move and ends on the OUTCOME, not on a mid-stream frame', async () => {
    const events: HostEvent[] = [
      { id: 1, event: 'step', data: { name: 'wsl-install', index: 1, total: 3 } } as HostEvent,
      { id: 2, event: 'line', data: { stream: 'stdout', text: 'Installing Ubuntu' } } as HostEvent,
      { id: 3, event: 'state', data: { code: 'reboot_required', sentence: 'Windows needs a restart.', action: 'instruct' } } as HostEvent,
    ];
    const door = new HostInstallDoor(doorHost('win32', true, events, outcome('reboot-pending')));
    const seen: CrucibleInstallDoorEvent[] = [];
    door.watch((e) => seen.push(e));
    await new Promise((r) => setTimeout(r, 10));
    expect(seen.map((e) => e.event)).toEqual(['step', 'line', 'state', 'error']);
    expect(seen[1]).toMatchObject({ event: 'line', step: 'wsl-install', text: 'Installing Ubuntu' });
    expect(seen[3]).toMatchObject({ event: 'error', outcome: { state: 'reboot-pending' } });
  });

  it('Try again retries the release the outcome names', async () => {
    const host = doorHost('win32', true, [], outcome('failed'));
    await new HostInstallDoor(host).start();
    expect(host.posted).toEqual(['1.0.23']);
  });

  it('`failed` is not terminal (the tray retries once); done, cannot, reboot-pending and declined are', () => {
    expect(installOutcomeIsTerminal(outcome('failed'))).toBe(false);
    for (const state of ['done', 'cannot', 'reboot-pending', 'declined'] as const) expect(installOutcomeIsTerminal(outcome(state))).toBe(true);
    expect(installOutcomeIsTerminal(null)).toBe(false);
  });
});

describe('the local engine presence, through the real bootstrap controls', () => {
  /** A runner over a temp CRUCIBLE_HOME that answers the installed CLI's `status`/`start --json`. */
  function scriptedRunner(home: string, answers: Record<string, unknown>): Runner & { ran: string[][] } {
    const ran: string[][] = [];
    return {
      ran,
      platform: 'darwin',
      env: { CRUCIBLE_HOME: home },
      homedir: '/nonexistent-home',
      run: async (argv): Promise<RunResult> => {
        ran.push([...argv]);
        const action = argv[argv.length - 2];
        return { code: 0, stdout: JSON.stringify(answers[action]), stderr: '', failure: null };
      },
      stream: async () => { throw new Error('not streamed'); },
      fileExists: (file) => fs.existsSync(file),
      readFile: (file) => fs.readFileSync(file, 'utf-8'),
      realpathNative: (file) => file,
    };
  }

  it('no installation.json in CRUCIBLE_HOME: absent, and nothing is run', async () => {
    const home = tempDir('crucible-home-');
    const runner = scriptedRunner(home, {});
    const controls = await processLocalControls(() => runner);
    const status = await controls.status();
    expect(presenceOf(status)).toMatchObject({ state: 'absent', message: null, offerStart: false });
    expect(runner.ran).toEqual([]);
  });

  it('a stopped engine: offers Start, and Start runs the installed control', async () => {
    const home = tempDir('crucible-home-');
    const cli = path.join(home, 'server', 'bin', 'crucible');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '#!/bin/sh\n');
    fs.writeFileSync(path.join(home, 'installation.json'), JSON.stringify({
      schema_version: 1, platform: 'darwin', release: '1.0.23', home, control: { command: cli, args: ['local'], cwd: home },
    }));
    const doc = (state: string) => ({ schema_version: 1, state, name: 'crucible@here', url: 'http://127.0.0.1:7100', detail: state });
    const runner = scriptedRunner(home, { status: doc('stopped'), start: doc('running') });
    const controls = await processLocalControls(() => runner);
    expect(presenceOf(await controls.status())).toMatchObject({ state: 'stopped', offerStart: true });
    expect((await controls.start()).state).toBe('running');
    expect(runner.ran).toEqual([[cli, 'local', 'status', '--json'], [cli, 'local', 'start', '--json']]);
    // There is no stop anywhere in Briefcase's controls.
    expect(Object.keys(controls)).toEqual(['status', 'start']);
  });

  it('says nothing about a slow-but-alive engine, and names the ones a person must act on', () => {
    const base = { schema_version: 1 as const, name: '', url: '', detail: '' };
    expect(presenceOf({ ...base, state: 'unhealthy' }).message).toBeNull();
    expect(presenceOf({ ...base, state: 'unreachable' })).toMatchObject({ offerStart: true });
    expect(presenceOf({ ...base, state: 'unauthorized' })).toMatchObject({ offerStart: false, message: expect.stringContaining('Crucible Servers') });
    expect(presenceOf({ ...base, state: 'broken' }).offerStart).toBe(false);
  });
});
