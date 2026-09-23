/**
 * HOSTABILITY AND THE ONE FACE. Crucible installs on Apple silicon and NVIDIA
 * hosts, and on Windows (BookForge's rule). An Intel Mac and Linux without
 * NVIDIA get "connect a Crucible on another computer" only.
 */
import {
  crucibleHostFacts,
  crucibleInstallPlan,
  hostabilityOf,
  parseNvidiaSmi,
  type HostRunResult,
  type InstallHost,
} from '../../src/crucible/install/install';
import { setupFace } from '../../src/crucible/install/install.service';
import type { DiscoveredCrucibleRow } from '../../src/crucible/wire/settings-wire';
import './helpers';

const nothingHere: DiscoveredCrucibleRow = { present: false, code: 'no_local_config', reason: 'There is no Crucible on this computer.' };
const somethingHere: DiscoveredCrucibleRow = {
  present: true, serverName: 'crucible@here', url: 'http://127.0.0.1:7100', tokenMasked: '****abcd', file: '/h/.crucible/pairing', registeredAs: null,
};

function host(platform: NodeJS.Platform, arch: string, gpu: HostRunResult | null = null, discovered = nothingHere): InstallHost & { gpuAsked: number } {
  const h = {
    platform,
    arch,
    gpuAsked: 0,
    queryGpu: () => {
      h.gpuAsked += 1;
      return gpu ?? { status: 3, stdout: '', stderr: '' };
    },
    discovered: () => discovered,
  };
  return h;
}

const nvidia: HostRunResult = { status: 0, stdout: 'NVIDIA GeForce RTX 3090 Ti, 24564 MiB\n', stderr: '' };

describe('hostabilityOf', () => {
  it('Apple silicon: yes, and no GPU probe is run', () => {
    const h = host('darwin', 'arm64');
    const facts = crucibleHostFacts(h);
    expect(hostabilityOf(facts).hostable).toBe('yes');
    expect(facts.refusals).toEqual([]);
    expect(h.gpuAsked).toBe(0);
  });

  it('an Intel Mac: no, refused not_apple_silicon, and the reason says what to do instead', () => {
    const facts = crucibleHostFacts(host('darwin', 'x64'));
    const verdict = hostabilityOf(facts);
    expect(verdict.hostable).toBe('no');
    expect(verdict.why).toMatch(/another computer/);
    expect(facts.refusals.map((r) => r.code)).toEqual(['not_apple_silicon']);
  });

  it('Windows with an NVIDIA card: yes, with the permission-and-restart sentence', () => {
    const verdict = hostabilityOf(crucibleHostFacts(host('win32', 'x64', nvidia)));
    expect(verdict.hostable).toBe('yes');
    expect(verdict.why).toContain('Windows may ask for permission, and once for a restart.');
  });

  it('Windows without NVIDIA: still yes (the native engine runs on anything), and no card is probed', () => {
    const h = host('win32', 'x64', null);
    expect(hostabilityOf(crucibleHostFacts(h)).hostable).toBe('yes');
    expect(h.gpuAsked).toBe(0);
  });

  it('Linux with a readable NVIDIA card: yes, naming it', () => {
    const facts = crucibleHostFacts(host('linux', 'x64', nvidia));
    expect(facts.gpu).toEqual({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090 Ti', vramBytes: 24564 * 1024 * 1024 });
    expect(hostabilityOf(facts)).toMatchObject({ hostable: 'yes', why: expect.stringContaining('RTX 3090 Ti') });
  });

  it('Linux without nvidia-smi: no, refused no_nvidia_driver', () => {
    const facts = crucibleHostFacts(host('linux', 'x64', { status: 3, stdout: '', stderr: '' }));
    expect(hostabilityOf(facts).hostable).toBe('no');
    expect(facts.refusals.map((r) => r.code)).toEqual(['no_nvidia_driver']);
  });

  it('Linux where nvidia-smi fails or prints nothing readable: no, with the evidence carried', () => {
    const failed = crucibleHostFacts(host('linux', 'x64', { status: 9, stdout: '', stderr: 'NVIDIA-SMI has failed' }));
    expect(hostabilityOf(failed).hostable).toBe('no');
    expect(failed.refusals[0]).toMatchObject({ code: 'no_nvidia_driver', detail: 'NVIDIA-SMI has failed' });
    const garbled = crucibleHostFacts(host('linux', 'x64', { status: 0, stdout: 'nonsense', stderr: '' }));
    expect(hostabilityOf(garbled).hostable).toBe('no');
  });

  it('a platform Crucible has no backend for: no', () => {
    const facts = crucibleHostFacts(host('freebsd', 'x64'));
    expect(hostabilityOf(facts).hostable).toBe('no');
    expect(facts.refusals.map((r) => r.code)).toContain('unsupported_platform');
  });

  it('an unreadable pairing file is a real refusal; no_local_config is not', () => {
    const broken: DiscoveredCrucibleRow = { present: false, code: 'pairing_file_invalid', reason: 'not a connect code' };
    expect(crucibleHostFacts(host('darwin', 'arm64', null, broken)).refusals.map((r) => r.code)).toEqual(['pairing_file_invalid']);
    expect(crucibleHostFacts(host('darwin', 'arm64')).refusals).toEqual([]);
  });

  it('parses nvidia-smi exactly as crucible/backend.py reads it (the first card)', () => {
    expect(parseNvidiaSmi('A100, 81920 MiB\nA100, 81920 MiB\n')).toEqual({ vendor: 'nvidia', name: 'A100', vramBytes: 81920 * 1024 * 1024 });
    expect(parseNvidiaSmi('')).toBeNull();
  });
});

describe('the plan', () => {
  it('is words, never commands, and marks the install step done only when a Crucible is already here', () => {
    const plan = crucibleInstallPlan(host('darwin', 'arm64'));
    expect(plan.hostable).toBe('yes');
    expect(plan.machine).toContain('macOS (arm64)');
    expect(plan.steps.map((s) => s.title)).toEqual(['Installing Crucible', 'Starting Crucible', 'Connecting Briefcase', 'Preparing what Briefcase needs']);
    expect(plan.steps.every((s) => !s.done)).toBe(true);
    expect(crucibleInstallPlan(host('darwin', 'arm64', null, somethingHere)).steps[0].done).toBe(true);
  });

  it('Windows adds the Linux engine step', () => {
    expect(crucibleInstallPlan(host('win32', 'x64')).steps.map((s) => s.title)).toContain('Setting up the Linux engine');
  });
});

describe('setupFace', () => {
  it('connected whenever a server is registered, whatever else is true', () => {
    expect(setupFace(1, nothingHere, 'no')).toBe('connected');
    expect(setupFace(2, somethingHere, 'yes')).toBe('connected');
  });

  it('adopt when a Crucible is on this computer and none is registered (installed by BookForge or Foundry)', () => {
    expect(setupFace(0, somethingHere, 'yes')).toBe('adopt');
    expect(setupFace(0, somethingHere, 'no')).toBe('adopt');
  });

  it('install when nothing is here and it can host one; unknown draws install too', () => {
    expect(setupFace(0, nothingHere, 'yes')).toBe('install');
    expect(setupFace(0, nothingHere, 'unknown')).toBe('install');
  });

  it('connect-only when nothing is here and it cannot', () => {
    expect(setupFace(0, nothingHere, 'no')).toBe('connect-only');
  });
});
