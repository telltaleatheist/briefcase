/**
 * THE LOCAL ENGINE'S PRESENCE, as its own control reports it, and what that
 * means for a person.
 *
 * Ported from BookForge's electron/crucible/engine-presence.ts. A local
 * Crucible is an OS service no app owns (INTEGRATING-AN-APP.md §4.4): an app
 * calls `startLocal()` when it is stopped and NEVER stops it on quit, because
 * another app may be mid-run. There is no stop here at all.
 *
 * The bootstrap's `localStatus()`/`startLocal()` read
 * `<CRUCIBLE_HOME>/installation.json` and run the installed CLI's
 * `status --json` / `start --json`, through the runner, so a spec drives them
 * with a scripted runner and a temp CRUCIBLE_HOME.
 */
import type { LocalStatus, Runner } from '@crucible/bootstrap';
import type { CrucibleEnginePresence } from '../wire/install-wire';

/** The two local controls, injectable. */
export interface LocalControls {
  status(): Promise<LocalStatus>;
  start(): Promise<LocalStatus>;
}

/** The real controls, over a runner (Briefcase's, which can spawn the Windows host's `.cmd`). */
export async function processLocalControls(runner: () => Runner, home?: string): Promise<LocalControls> {
  const bootstrap = await import('@crucible/bootstrap');
  const options = home === undefined ? {} : { home };
  return {
    status: () => bootstrap.localStatus(options, runner()),
    start: () => bootstrap.startLocal(options, runner()),
  };
}

/**
 * What each of the SDK's eight states means for a person. `null` message means
 * say nothing: `running` and `absent` are ordinary, and `unhealthy` means ping
 * ANSWERED and a later call was slow, which nothing here repairs (BookForge's
 * correction of 2026-09-17, reported by Foundry).
 */
export function presenceOf(observed: LocalStatus): CrucibleEnginePresence {
  const base = { state: observed.state, detail: observed.detail };
  switch (observed.state) {
    case 'running':
    case 'absent':
    case 'unhealthy':
      return { ...base, message: null, offerStart: false };
    case 'stopped':
      return { ...base, message: 'Crucible is stopped on this computer.', offerStart: true };
    case 'unreachable':
      return { ...base, message: 'Crucible is installed but is not answering.', offerStart: true };
    case 'unauthorized':
      return {
        ...base,
        message: 'Briefcase is not authorised to use the Crucible on this computer. Connect it again in Settings › Crucible Servers.',
        offerStart: false,
      };
    case 'wrong_service':
      return { ...base, message: 'Something else is answering on the port the local Crucible uses.', offerStart: false };
    case 'broken':
      return { ...base, message: 'The Crucible installation on this computer is incomplete and cannot start. Install it again to repair it.', offerStart: false };
  }
}
