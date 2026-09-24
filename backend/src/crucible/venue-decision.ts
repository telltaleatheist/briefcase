/**
 * WHERE A QUEUED AI TASK RUNS: one rule, one place.
 *
 *   The SELECTED server (Settings › Crucible Servers), and only it. Work never
 *   moves to another server on its own: not when the selected one is busy, and
 *   not when it is down. It moves only when the user selects another server.
 *
 * "Who is free right now" is NOT asked here: that is the door's question (a
 * 409 parks the task until the server frees).
 *
 * Three answers, and the queue does something different with each:
 *
 *   venue   admit to that server's lane (a local model) or the cloud lane.
 *   wait    park the task with this sentence: nothing selected, the server not
 *           answering, the upstream not set up on it. A task with no venue is
 *           never failed.
 *   fail    the selected server refused this computer outright (a bad token,
 *           not a Crucible, a newer protocol): a misconfiguration somebody has
 *           to repair, and waiting would hide it.
 *
 * A local model the server has not installed still goes to it, so the refusal
 * the user sees is the server's own sentence ("isn't downloaded on mac")
 * rather than a guess.
 */
import type { CrucibleTarget, UpstreamName } from './llm/target';
import type { ServerReach } from './wire/settings-wire';

export type VenueAnswer =
  | { kind: 'venue'; server: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string };

export interface VenueHost {
  /** The selected server. Throws (routing's own sentence) when there is none. */
  selected(): string;
  reach(server: string): Promise<{ reach: ServerReach; message?: string }>;
  canServe(server: string, target: CrucibleTarget): Promise<boolean>;
}

const UPSTREAM_LABEL: Record<UpstreamName, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'Ollama' };
const MISCONFIGURED: ReadonlySet<ServerReach> = new Set<ServerReach>(['bad_token', 'not_crucible', 'version_mismatch']);

export async function decideVenue(target: CrucibleTarget, host: VenueHost): Promise<VenueAnswer> {
  let server: string;
  try {
    server = host.selected();
  } catch (err) {
    return { kind: 'wait', reason: (err as Error).message };
  }
  const answer = await host.reach(server);
  if (answer.reach !== 'ready' && answer.reach !== 'busy') {
    const said = answer.message ? `${server}: ${answer.message}` : `${server} (${answer.reach.replace(/_/g, ' ')})`;
    if (MISCONFIGURED.has(answer.reach)) return { kind: 'fail', reason: `The selected Crucible server won't take work from this computer: ${said}` };
    if (answer.reach === 'unreachable') return { kind: 'wait', reason: `Crucible on ${server} isn't answering.` };
    return { kind: 'wait', reason: `Waiting for Crucible on ${said}.` };
  }
  if (target.route === 'upstream' && !await host.canServe(server, target)) {
    return { kind: 'wait', reason: `${UPSTREAM_LABEL[target.upstream!]} is not set up on ${server}. Add it in Settings › AI Analysis.` };
  }
  return { kind: 'venue', server };
}
