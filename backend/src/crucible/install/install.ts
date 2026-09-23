/**
 * INSTALLING A CRUCIBLE ON THIS COMPUTER: which release, whether this machine
 * can hold one, and driving `@crucible/bootstrap` to do it.
 *
 * Ported from BookForge's electron/crucible/install.ts (releaseToInstall,
 * runningCrucibleVersion, hostabilityOf, crucibleHostFacts,
 * driveCrucibleInstall), with the parts Briefcase does not have removed: there
 * is no WSL-distro setting (Windows installs through the host, which owns the
 * distro) and no config.toml discovery (the pairing file is the one door, as in
 * P1's discovery.ts). Everything that reads the machine or the network is
 * injected, so a spec drives every branch with no GPU, no installer and no
 * GitHub.
 *
 * The rules, from crucible docs/INTEGRATING-AN-APP.md §4 and the user's
 * decisions of 2026-09-23:
 *
 *  - ONE CRUCIBLE PER MACHINE, shared with BookForge and Foundry. The
 *    never-older gate runs before anything is spawned: never install over a
 *    newer running Crucible, never reinstall the same one. No `--force`.
 *  - HOSTABILITY is measured, never asked: Apple silicon yes, Intel Mac no,
 *    Windows yes (its native engine needs no card), Linux only with a readable
 *    NVIDIA card. Where it is no, the only offer is "connect a Crucible on
 *    another computer".
 *  - Install a BARE service (`jobTypes: ['echo']`). What Briefcase needs
 *    arrives later through the module, after the user's AI choices, so nobody
 *    downloads a model they were about to route to Claude.
 *  - Briefcase never uninstalls Crucible. It is shared.
 */
import { spawnSync } from 'child_process';
import type {
  HostEvent,
  InstallOptions,
  InstallResult,
  InstallStep,
  LocalStatus,
  Runner,
} from '@crucible/bootstrap';
import type {
  CrucibleGpuFacts,
  CrucibleHostability,
  CrucibleHostFacts,
  CrucibleHostRefusal,
  CrucibleHostRefusalCode,
  CrucibleInstallPlan,
  CrucibleInstallStep,
  CrucibleReleaseCheck,
  InstallPlatform,
} from '../wire/install-wire';
import type { DiscoveredCrucibleRow } from '../wire/settings-wire';

/** Crucible's own README, the argument behind the sequence. */
export const CRUCIBLE_README = 'https://github.com/telltaleatheist/crucible';

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A refusal from this half of the install story, in the package's
 * `BootstrapRefusal` shape. The code is prefixed onto the message because a
 * log line or a toast shows `err.message` and nothing else.
 */
export class CrucibleInstallError extends Error {
  readonly command: string | null;
  readonly detail: string | null;

  constructor(
    readonly code: CrucibleHostRefusalCode,
    message: string,
    options: { command?: string; detail?: string } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleInstallError';
    this.command = options.command ?? null;
    this.detail = options.detail ?? null;
  }

  toRefusal(): CrucibleHostRefusal {
    return { code: this.code, message: this.message, command: this.command, detail: this.detail };
  }
}

/**
 * ANY failure of the driven install, as the renderer's one refusal shape. A
 * package refusal (`{code, message, command, detail}`) crosses VERBATIM; a
 * `BootstrapStepFailed` arrives as `step_failed` with its tail as the detail.
 * Something that is not a refusal becomes `install_failed` with its own words.
 */
export function installRefusalOf(err: unknown): CrucibleHostRefusal {
  if (err instanceof CrucibleInstallError) return err.toRefusal();
  const carried = err as { code?: unknown; message?: unknown; command?: unknown; detail?: unknown } | null;
  if (carried !== null && typeof carried === 'object' && typeof carried.code === 'string' && typeof carried.message === 'string') {
    const message = carried.message.startsWith(`${carried.code}:`) ? carried.message : `${carried.code}: ${carried.message}`;
    return {
      code: carried.code,
      message,
      command: typeof carried.command === 'string' ? carried.command : null,
      detail: typeof carried.detail === 'string' ? carried.detail : null,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'install_failed', message: `install_failed: ${message}`, command: null, detail: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHICH Crucible gets installed: the channel's latest, and never an older one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two facts the never-older gate compares, each from its own source. An
 * interface so a spec can put a channel at 1.0.22 in front of an engine at
 * 1.0.23 and watch nothing spawn.
 */
export interface CrucibleReleaseSources {
  /** What the release channel calls latest (`releases/latest`). Refuses `release_channel_unreadable`. */
  latest(): Promise<string>;
  /**
   * The version of the Crucible answering on THIS machine, or null when none
   * is installed. An engine that is configured here and will not answer is an
   * ERROR, not null: installing over "it would not say what it is" is exactly
   * what the gate exists to stop.
   */
  running(): Promise<string | null>;
  /** Order two releases, negative when `a` is older. The package's comparator. */
  compare(a: string, b: string): number;
}

/**
 * WHICH RELEASE TO INSTALL, or the refusal that says not to
 * (crucible docs/INSTALL-UNINSTALL.md §6.5.3). Runs BEFORE anything is spawned:
 *
 *   nothing running   → the channel's latest
 *   channel newer     → the channel's latest (the upgrade path)
 *   channel the same  → `crucible_already_latest`
 *   channel older     → `install_older_than_running`
 */
export async function releaseToInstall(sources: CrucibleReleaseSources): Promise<string> {
  const latest = await sources.latest();
  const running = await sources.running();
  if (running === null) return latest;
  if (sources.compare(latest, running) < 0) {
    throw new CrucibleInstallError(
      'install_older_than_running',
      `the release channel's latest is ${latest} and Crucible ${running} is running on this computer; `
        + 'refusing to install an older engine over it. There is one Crucible per computer, shared with '
        + 'BookForge and Foundry, and Briefcase never takes it backwards.',
    );
  }
  if (sources.compare(latest, running) === 0) {
    throw new CrucibleInstallError(
      'crucible_already_latest',
      `Crucible ${running} is running on this computer and is the release channel's latest. There is nothing to install.`,
    );
  }
  return latest;
}

/** The gate's answer as a value, for a screen asking "is there an update". Never throws. */
export async function checkRelease(sources: CrucibleReleaseSources): Promise<CrucibleReleaseCheck> {
  let latest: string;
  let running: string | null;
  try {
    latest = await sources.latest();
    running = await sources.running();
  } catch (err) {
    return { action: 'unknown', refusal: installRefusalOf(err) };
  }
  try {
    const release = await releaseToInstall({ latest: async () => latest, running: async () => running, compare: sources.compare });
    return running === null ? { action: 'install', latest: release, running: null } : { action: 'upgrade', latest: release, running };
  } catch (err) {
    if (err instanceof CrucibleInstallError && running !== null
      && (err.code === 'crucible_already_latest' || err.code === 'install_older_than_running')) {
      return { action: 'none', code: err.code, latest, running, message: err.message };
    }
    return { action: 'unknown', refusal: installRefusalOf(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The machine, measured
// ─────────────────────────────────────────────────────────────────────────────

/** One spawn's answer, in the shape `spawnSync` gives it. */
export interface HostRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Machine reads, injectable. */
export interface InstallHost {
  platform: NodeJS.Platform;
  arch: string;
  /** `nvidia-smi --query-gpu=name,memory.total`. Only asked on Linux. */
  queryGpu(): HostRunResult;
  /** The Crucible already on this computer (its pairing file), or the named reason there is none. */
  discovered(): DiscoveredCrucibleRow;
}

/**
 * WHERE nvidia-smi IS, after PATH: the WSL2 driver location, as the package's
 * `WSL_NVIDIA_SMI` and `crucible/backend.py` look for it. Exit 3 means "none
 * anywhere", told apart from nvidia-smi's own non-zero exits.
 */
const NVIDIA_SMI_SCRIPT =
  'if command -v nvidia-smi >/dev/null 2>&1; then '
  + 'exec nvidia-smi --query-gpu=name,memory.total --format=csv,noheader; fi; '
  + 'if [ -x /usr/lib/wsl/lib/nvidia-smi ]; then '
  + 'exec /usr/lib/wsl/lib/nvidia-smi --query-gpu=name,memory.total --format=csv,noheader; fi; '
  + 'exit 3';

/** The real machine. `discovered` is the P1 pairing-file reader, passed in. */
export function processInstallHost(discovered: () => DiscoveredCrucibleRow): InstallHost {
  return {
    platform: process.platform,
    arch: process.arch,
    queryGpu: () => {
      const result = spawnSync('bash', ['-c', NVIDIA_SMI_SCRIPT], { windowsHide: true, timeout: 30_000, encoding: 'utf-8' });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        ...(result.error ? { error: result.error } : {}),
      };
    },
    discovered,
  };
}

/** `name, 24576 MiB`: the first GPU, exactly as `crucible/backend.py` reads it. */
export function parseNvidiaSmi(stdout: string): CrucibleGpuFacts | null {
  const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return null;
  const comma = first.lastIndexOf(',');
  if (comma < 0) return null;
  const name = first.slice(0, comma).trim();
  const mib = Number.parseInt(first.slice(comma + 1).replace(/MiB/i, '').trim(), 10);
  if (name.length === 0 || !Number.isFinite(mib)) return null;
  return { vendor: 'nvidia', name, vramBytes: mib * 1024 * 1024 };
}

export function installPlatformOf(platform: NodeJS.Platform): InstallPlatform {
  switch (platform) {
    case 'win32': return 'win32';
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    default: return 'other';
  }
}

/** What this app can measure about the machine. Spawns only the Linux nvidia-smi probe. */
export function crucibleHostFacts(host: InstallHost): CrucibleHostFacts {
  const platform = installPlatformOf(host.platform);
  const refusals: CrucibleHostRefusal[] = [];
  const refuse = (code: CrucibleHostRefusalCode, message: string, options: { command?: string; detail?: string } = {}): void => {
    refusals.push({ code, message, command: options.command ?? null, detail: options.detail ?? null });
  };
  const discovered = host.discovered();
  // `no_local_config` is the ordinary state of a machine with no Crucible yet,
  // which is why this screen exists. Anything else (an unreadable pairing file)
  // is a real refusal with a fix.
  if (!discovered.present && discovered.code !== 'no_local_config') refuse(discovered.code, discovered.reason);

  let gpu: CrucibleGpuFacts | null = null;
  if (platform === 'other') {
    refuse('unsupported_platform', `there is no Crucible backend for ${host.platform}: cuda-linux, mlx-darwin and llama-windows are supported.`);
  } else if (platform === 'darwin') {
    if (host.arch !== 'arm64') {
      refuse('not_apple_silicon', `mlx-darwin is Apple silicon only and this Mac is ${host.arch}. There is no Crucible backend for an Intel Mac.`);
    }
    // Apple silicon is not sized here: `detectHost()` owns that number.
  } else if (platform === 'linux') {
    const queried = host.queryGpu();
    if (queried.error !== undefined) {
      refuse('no_nvidia_driver', `the NVIDIA probe could not be run: ${queried.error.message}`, { detail: queried.error.message });
    } else if (queried.status === 3) {
      refuse('no_nvidia_driver', 'no nvidia-smi on this machine, on PATH or at /usr/lib/wsl/lib. A cuda-linux Crucible needs the driver to see the card.');
    } else if (queried.status !== 0) {
      refuse('no_nvidia_driver', `nvidia-smi exited ${queried.status ?? 'without a code'}, so this machine's card could not be read.`,
        { detail: (queried.stderr || queried.stdout).trim() });
    } else {
      gpu = parseNvidiaSmi(queried.stdout);
      if (gpu === null) refuse('no_nvidia_driver', 'nvidia-smi answered and printed nothing that reads as a card.', { detail: queried.stdout.trim() });
    }
  }
  // win32: the native engine needs no card and no WSL probe.
  return { platform, platformName: host.platform, arch: host.arch, gpu, discovered, refusals };
}

/**
 * COULD A CRUCIBLE LIVE HERE, and why. BookForge's rule, which the user
 * adopted for Briefcase (2026-09-23): Apple silicon and NVIDIA hosts install;
 * an Intel Mac and Linux without NVIDIA connect to another computer instead;
 * Windows always installs (its native engine runs on anything, and the faster
 * Linux engine follows by itself where WSL2 can host it).
 */
export function hostabilityOf(facts: CrucibleHostFacts): { hostable: CrucibleHostability; why: string } {
  if (facts.platform === 'other') {
    return {
      hostable: 'no',
      why: `Crucible runs on Apple silicon Macs, Windows, and Linux with an NVIDIA card, and ${facts.platformName} is none of them. `
        + 'Connect Briefcase to a Crucible on another computer instead.',
    };
  }
  if (facts.platform === 'darwin') {
    if (facts.arch !== 'arm64') {
      return {
        hostable: 'no',
        why: 'Crucible needs an Apple silicon Mac, and this one has an Intel processor. It can use a Crucible '
          + 'running on another computer instead.',
      };
    }
    return { hostable: 'yes', why: 'Apple silicon: Crucible runs its models on this Mac\'s own unified memory.' };
  }
  if (facts.platform === 'win32') {
    return {
      hostable: 'yes',
      why: 'Windows: the engine starts here within seconds, and the faster Linux engine is set up straight '
        + 'afterwards on its own. Windows may ask for permission, and once for a restart.',
    };
  }
  if (facts.gpu !== null) {
    return { hostable: 'yes', why: `${facts.gpu.name}, ${(facts.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB, is visible to this computer.` };
  }
  return {
    hostable: 'no',
    why: 'Crucible on Linux needs an NVIDIA card, and none was readable on this computer. It can use a Crucible '
      + 'running on another computer instead.',
  };
}

/** One sentence about this machine, from what was measured and nothing else. */
export function describeMachine(facts: CrucibleHostFacts): string {
  const osName = facts.platform === 'darwin' ? 'macOS' : facts.platform === 'win32' ? 'Windows' : facts.platform === 'linux' ? 'Linux' : facts.platformName;
  const parts: string[] = [`${osName} (${facts.arch})`];
  if (facts.gpu !== null) parts.push(`${facts.gpu.name}, ${(facts.gpu.vramBytes / 1024 ** 3).toFixed(1)} GB`);
  else if (facts.platform === 'darwin' && facts.arch === 'arm64') parts.push('Apple silicon');
  parts.push(facts.discovered.present ? `a Crucible is already here (${facts.discovered.serverName})` : 'no Crucible here yet');
  return `${parts.join(' · ')}.`;
}

/**
 * THE SEQUENCE AS A PERSON READS IT, before it runs. Words, not commands:
 * nobody is ever shown a command to type (BookForge PHASE19 ruling).
 */
function stepsFor(facts: CrucibleHostFacts): CrucibleInstallStep[] {
  if (facts.platform === 'other') return [];
  const installed = facts.discovered.present;
  const steps: CrucibleInstallStep[] = [
    {
      title: 'Installing Crucible',
      detail: facts.platform === 'win32'
        ? 'The engine, its desktop controls and its login startup. Windows raises its own permission prompt.'
        : 'The engine and the service that starts it when you log in.',
      done: installed,
    },
    { title: 'Starting Crucible', detail: 'Briefcase waits until the engine answers.', done: false },
  ];
  if (facts.platform === 'win32') {
    steps.push({
      title: 'Setting up the Linux engine',
      detail: 'The faster engine, set up automatically. Windows may ask once for a restart; a computer that cannot '
        + 'run it says so in one sentence and stays on the Windows engine.',
      done: false,
    });
  }
  steps.push(
    { title: 'Connecting Briefcase', detail: 'Briefcase adds it to Settings › Crucible Servers.', done: false },
    {
      title: 'Preparing what Briefcase needs',
      detail: 'Text analysis and transcription, installed once you finish setup. Several gigabytes on a first setup; '
        + 'it keeps going while you work.',
      done: false,
    },
  );
  return steps;
}

/** Everything the install face draws. Composing it installs nothing. */
export function crucibleInstallPlan(host: InstallHost): CrucibleInstallPlan {
  const facts = crucibleHostFacts(host);
  const verdict = hostabilityOf(facts);
  return {
    platform: facts.platform,
    host: facts,
    machine: describeMachine(facts),
    hostable: verdict.hostable,
    hostableWhy: verdict.why,
    steps: stepsFor(facts),
    readme: CRUCIBLE_README,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The driven install
// ─────────────────────────────────────────────────────────────────────────────

/** The part of `@crucible/bootstrap` this app drives. Injected so a spec never installs anything. */
export interface BootstrapSurface {
  install(options: InstallOptions, runner: Runner): Promise<InstallResult>;
  startLocal(options: { home?: string }, runner: Runner): Promise<LocalStatus>;
}

/** The real package, loaded on first use rather than at app start. */
export async function loadBootstrap(): Promise<BootstrapSurface> {
  const bootstrap = await import('@crucible/bootstrap');
  return {
    install: (options, runner) => bootstrap.install(options, runner),
    startLocal: (options, runner) => bootstrap.startLocal(options, runner),
  };
}

/**
 * The options Briefcase hands the package: a BARE service (`['echo']`), and
 * where to send the output. No release: the gate fills it from the channel.
 */
export function briefcaseInstallOptions(
  onLine: InstallOptions['onLine'],
  handlers: { onStep?: (step: InstallStep) => void; onHostEvent?: (event: HostEvent) => void; home?: string } = {},
): InstallOptions {
  return {
    jobTypes: ['echo'],
    onLine,
    ...(handlers.onStep === undefined ? {} : { onStep: handlers.onStep }),
    ...(handlers.onHostEvent === undefined ? {} : { onHostEvent: handlers.onHostEvent }),
    ...(handlers.home === undefined ? {} : { home: handlers.home }),
  };
}

/**
 * RUN CRUCIBLE'S OWN INSTALLER, then make sure the engine is up.
 *
 * The gate is FIRST, before the package does anything, so a refused install
 * is one where nothing was spawned. `options.release` is overwritten with the
 * gate's answer: the channel owns which release, not the caller.
 *
 * macOS/Linux: `install()` can return before launchd/systemd has a healthy
 * engine, so `startLocal()` waits for it, and its name and URL must be the
 * installed server's. Windows: `install()` runs `install.ps1` and then watches
 * the move the tray starts, to a terminal outcome; `autoConnectLocal` makes
 * the identity check on whatever engine is left standing.
 */
export async function driveCrucibleInstall(
  options: InstallOptions,
  deps: { bootstrap: BootstrapSurface; runner: Runner; sources: CrucibleReleaseSources; onRelease?: (release: string) => void },
): Promise<InstallResult> {
  const release = await releaseToInstall(deps.sources);
  deps.onRelease?.(release);
  const installed = await deps.bootstrap.install({ ...options, release }, deps.runner);
  if (deps.runner.platform === 'win32') {
    const backend = installed.backend as string;
    if (backend !== 'llama-windows' && backend !== 'cuda-linux' && backend !== 'mlx-darwin') {
      throw new CrucibleInstallError('install_failed', `the installed engine reported an unsupported backend: ${backend}`);
    }
    return installed;
  }
  const step: InstallStep = { name: 'local-readiness', argv: [], status: 'running', detail: 'Waiting for Crucible to start' };
  options.onStep?.(step);
  const status = await deps.bootstrap.startLocal(options.home === undefined ? {} : { home: options.home }, deps.runner);
  if (status.state !== 'running') throw new CrucibleInstallError('install_failed', status.detail || `the engine is ${status.state}`);
  if (status.name !== installed.server.name || status.url !== installed.server.url) {
    throw new CrucibleInstallError(
      'install_failed',
      `the engine answering (${status.name} at ${status.url}) is not the one just installed `
        + `(${installed.server.name} at ${installed.server.url}).`,
    );
  }
  const done: InstallStep = { ...step, status: 'ok', detail: 'Crucible is running' };
  options.onStep?.(done);
  return { ...installed, steps: [...installed.steps, done] };
}
