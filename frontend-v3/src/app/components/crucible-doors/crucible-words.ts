/**
 * The words Briefcase uses about Crucible's install and coordination, in one
 * place so every screen says the same thing (BookForge's crucible-words.ts,
 * trimmed to what Briefcase draws). Pure functions; a spec covers them.
 *
 * Rules: name the holder on a wait, never say "maybe", never tell the user to
 * open Crucible's own page for a normal workflow.
 */
import type { CrucibleCoordinationHolder, CrucibleCoordinationState, CrucibleUnmetClass } from '@crucible-wire/coordinate-wire';
import type { CrucibleInstallProgress } from '@crucible-wire/install-wire';
import type { ServerFacts } from '@crucible-wire/settings-wire';
import type { LaneView } from '../../models/queue-lanes.model';

const CLASS_WORDS: Record<string, string> = {
  analysis: 'video analysis',
  clean: 'text cleanup',
  translate: 'translation',
  simplify: 'simplifying',
  pages: 'page reading',
};

export function classWord(name: string): string {
  return CLASS_WORDS[name] ?? name;
}

export function unmetLine(unmet: readonly CrucibleUnmetClass[]): string | null {
  if (unmet.length === 0) return null;
  return `Not on this server: ${unmet.map((u) => (u.reason === null ? classWord(u.class) : `${classWord(u.class)} (${u.reason})`)).join('; ')}.`;
}

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** A module step, with whatever of its place and name the server stated. */
function stepWords(step: { readonly name: string | null; readonly index: number | null; readonly total: number | null }): string {
  const place = step.index === null ? 'a step' : step.total === null ? `step ${step.index}` : `step ${step.index} of ${step.total}`;
  return step.name === null ? place : `${place}, ${step.name}`;
}

/** Who holds the card: the server's name for them, else the fact it held (a job, a lease, ...). */
function holderWords(holder: CrucibleCoordinationHolder): string {
  return holder.who ?? `held by ${holder.fact}`;
}

/**
 * A reachable server's self-description for its row: `Crucible 1.0.25 ·
 * mlx-darwin · Apple M2 Ultra (192 GB)`. What the server did not state is left
 * out, except the version, which reads "version unknown".
 */
export function serverFactsLine(facts: Pick<ServerFacts, 'version' | 'backend' | 'gpu' | 'engineUrl'>): string {
  const parts = [facts.version === null ? 'Crucible, version unknown' : `Crucible ${facts.version}`];
  if (facts.backend !== null) parts.push(facts.backend);
  const gpu = facts.gpu;
  const size = gpu?.vramBytes == null ? null : `${Math.round(gpu.vramBytes / 1024 ** 3)} GB`;
  const name = gpu?.name ?? null;
  if (name !== null) parts.push(size === null ? name : `${name} (${size})`);
  else if (size !== null) parts.push(size);
  if (facts.engineUrl) parts.push(`engine at ${facts.engineUrl}`);
  return parts.join(' · ');
}

/** One sentence for a server's coordination state. */
export function coordinationLine(state: CrucibleCoordinationState): string {
  switch (state.phase) {
    case 'deferred':
      return `${state.server}: what Briefcase needs is prepared when you finish setup.`;
    case 'checking':
      return `${state.server}: checking what it has.`;
    case 'stocked':
      return `${state.server} has everything Briefcase needs.`;
    case 'preparing': {
      const p = state.progress;
      if (p.state === 'done') return `${state.server} is ready for Briefcase.`;
      if (p.state === 'failed') return `${state.server}: preparing stopped. ${p.error?.code ?? 'failed'}: ${p.error?.message ?? ''}`.trim();
      if (p.state === 'cancelled') return `${state.server}: preparing was cancelled.`;
      const step = p.step === null ? 'starting' : stepWords(p.step);
      const bytes = p.bytes === null ? '' : p.bytes.total === null
        ? ` (${gb(p.bytes.done)})`
        : ` (${Math.round((p.bytes.done / Math.max(1, p.bytes.total)) * 100)}% of ${gb(p.bytes.total)})`;
      const whose = state.followed ? 'finishing another app\'s setup first' : 'preparing what Briefcase needs';
      return `${state.server}: ${whose}, ${step}${bytes}. This keeps going while you work.`;
    }
    case 'waiting':
      return state.stopped
        ? `${state.server} stayed busy (${holderWords(state.holder)}). Briefcase will ask again the next time it connects.`
        : `${state.server} is busy: ${holderWords(state.holder)}. Briefcase will prepare it when the card is free.`;
    case 'refused':
      return `${state.server} refused Briefcase's request. ${state.message}`;
    case 'unreachable':
      return state.message;
  }
}

/** Is this state still moving (worth a spinner)? */
export function coordinationBusy(state: CrucibleCoordinationState): boolean {
  return state.phase === 'checking' || (state.phase === 'preparing' && state.progress.state === 'running') || (state.phase === 'waiting' && !state.stopped);
}

/** Readable names for the package's install steps. Unknown steps show their own name. */
const STEP_WORDS: Record<string, string> = {
  'host-facts': 'Checking this computer',
  server: 'Installing Crucible',
  init: 'Setting up Crucible',
  service: 'Registering the login service',
  'local-readiness': 'Starting Crucible',
  capability: 'Measuring this computer',
  linger: 'Keeping Crucible running',
};

export function installStepWord(step: string): string {
  return STEP_WORDS[step] ?? step;
}

/** The current headline of a running install, from its events. */
export function installHeadline(events: readonly CrucibleInstallProgress[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.kind === 'done') return `Crucible ${e.release} is installed and running.`;
    if (e.kind === 'failed') return 'The install stopped.';
    if (e.kind === 'state') return e.sentence;
    if (e.kind === 'step') return `${installStepWord(e.step)}${e.detail ? `: ${e.detail}` : ''}`;
  }
  return 'Starting the install.';
}

// ── Queue lanes (§7.6) ──────────────────────────────────────────────────────

/** One short phrase for a lane's state; the holder sentence is kept verbatim. */
export function laneStateLine(lane: Pick<LaneView, 'state' | 'detail'>): string {
  switch (lane.state) {
    case 'ready': return 'Ready';
    case 'busy': return lane.detail ? `Busy: ${lane.detail}` : 'Busy';
    case 'unreachable': return 'Not answering';
    case 'unavailable': return lane.detail ? `Unavailable: ${lane.detail}` : 'Unavailable';
  }
}

/** A lane state that means something is wrong, not merely occupied. */
export function laneIsProblem(lane: Pick<LaneView, 'state'>): boolean {
  return lane.state === 'unreachable' || lane.state === 'unavailable';
}

/** The Cloud lane's occupancy, e.g. "1 of 2 running". */
export function laneOccupancy(lane: Pick<LaneView, 'running' | 'width'>): string {
  return `${lane.running.length} of ${lane.width} running`;
}

export function laneWaiting(waiting: number): string | null {
  return waiting > 0 ? `${waiting} waiting` : null;
}

