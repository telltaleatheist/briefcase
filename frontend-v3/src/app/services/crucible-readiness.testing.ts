import type { CrucibleReadinessView } from '@crucible-wire/readiness-wire';

/** A readiness view for specs: not running, startable here, nothing waiting, unless patched. */
export function readinessView(patch: Partial<CrucibleReadinessView> = {}): CrucibleReadinessView {
  return {
    state: 'unreachable',
    reason: 'The Crucible on this computer is not running.',
    action: 'start',
    server: null,
    progress: null,
    declined: false,
    aiWaiting: 0,
    at: '2026-09-23T00:00:00Z',
    ...patch,
  };
}
