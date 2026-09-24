/**
 * IS CRUCIBLE THERE FOR AI WORK: the one readiness signal (P7).
 *
 * Briefcase has no AI of its own any more (the user's rule, 2026-09-23: "If
 * Crucible is down, Briefcase is down" for everything that needs it). This is
 * the single answer to "can an AI action run now, and if not, what repairs
 * it", derived in the backend from the server registry, the probe and the
 * local engine's presence, and pushed on Socket.IO `crucible.readiness`.
 *
 * Shared with the renderer through `@crucible-wire`. Type-only; no token.
 */

/**
 *   ready           an enabled server answers: AI actions run.
 *   starting        Briefcase is starting (or installing) the Crucible on this
 *                   computer; AI actions wait for it.
 *   unreachable     a server is registered (or installed here) and none answers.
 *   not-installed   nothing is registered, nothing is installed here, and this
 *                   computer can host a Crucible: offer the install doors.
 *   not-configured  nothing is registered and this computer cannot host one
 *                   (Intel Mac, Linux without NVIDIA), or every server is
 *                   paused: offer "connect a Crucible server".
 */
export type CrucibleReadinessState = 'ready' | 'starting' | 'unreachable' | 'not-installed' | 'not-configured';

/**
 * The one door that repairs a state that is not `ready`, here:
 *   start    the Crucible on this computer is installed and stopped: start it;
 *   install  nothing is installed and this computer can host one;
 *   connect  connect (or resume) a Crucible server in Settings › Crucible Servers.
 * Null when ready, or while starting.
 */
export type CrucibleReadinessAction = 'start' | 'install' | 'connect' | null;

export interface CrucibleReadinessView {
  state: CrucibleReadinessState;
  /** One sentence for a person: why AI actions are (not) available. */
  reason: string;
  action: CrucibleReadinessAction;
  /** The server that answers, when ready. */
  server: string | null;
  /**
   * When ready but the card is someone else's right now (a job, a lease, an
   * engine claim such as Crucible's settlement clearing the card): the
   * holder's sentence. AI work still queues; it waits (parks) for the card.
   */
  busy: string | null;
  /** While starting: the latest line of the start or install. */
  progress: string | null;
  /**
   * The user said "Not now" to bringing Crucible up, this session (the
   * backend's lifetime). Nothing prompts again until the app restarts; gated
   * actions still show the reason and their Start / Connect affordance.
   */
  declined: boolean;
  /** Queued AI tasks parked because Crucible is not there: the moment to ask. */
  aiWaiting: number;
  /** ISO time this answer was derived. */
  at: string;
}

/** Socket.IO event carrying a {@link CrucibleReadinessView} whenever it changes. */
export const CRUCIBLE_READINESS_EVENT = 'crucible.readiness';

/**
 * THE TYPED REFUSAL of an action that needs Crucible while it is not ready:
 * HTTP 409 with this body, from the queue's add/start doors and every direct
 * AI endpoint.
 */
export interface CrucibleRequiredRefusal {
  code: 'crucible_required';
  message: string;
  readiness: CrucibleReadinessView;
}

export const CRUCIBLE_REQUIRED_CODE = 'crucible_required';

/** The queue task types that need Crucible. Everything else never touches it. */
export const CRUCIBLE_TASK_TYPES: readonly string[] = ['transcribe', 'analyze', 'analyze-webpage'];
