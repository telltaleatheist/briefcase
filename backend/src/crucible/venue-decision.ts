/**
 * WHERE A QUEUED AI TASK RUNS: one rule, one place (migration plan §7.2 step 1,
 * BookForge electron/crucible/venue-decision.ts).
 *
 *   The first ENABLED server, in rank order, that answers and can serve the
 *   target: a local model it has installed, or an upstream it has configured.
 *
 * A paused server is never a candidate. "Who is free right now" is NOT asked
 * here: that is the door's question (a 409 parks the task), and re-ranking on
 * it would move work off the server the user preferred.
 *
 * Three answers, and the queue does something different with each:
 *
 *   venue   admit to that server's lane (a local model) or the cloud lane.
 *   wait    park the task with this sentence. Nothing reachable, nothing
 *           running, no server with that upstream: each is a wait, never a
 *           failure (§7.2: "a task with no venue is never failed").
 *   fail    every enabled server refused this computer outright (a bad token,
 *           not a Crucible, a newer protocol): a misconfiguration somebody has
 *           to repair, and waiting would hide it (§11).
 *
 * A local model no reachable server has installed goes to the first reachable
 * server anyway, so the refusal the user sees is that server's own sentence
 * ("isn't downloaded on mac") rather than a guess (P3's venueFor rule).
 */
import type { CrucibleTarget, UpstreamName } from './llm/target';
import type { RankedServerRow, ServerReach } from './wire/settings-wire';

export type VenueAnswer =
  | { kind: 'venue'; server: string; because: 'can serve it' | 'first that answered' }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string };

export interface VenueHost {
  /** Enabled servers, best first. Throws (routing's own sentence) when there are none. */
  enabled(): RankedServerRow[];
  reach(server: string): Promise<{ reach: ServerReach; message?: string }>;
  canServe(server: string, target: CrucibleTarget): Promise<boolean>;
}

const UPSTREAM_LABEL: Record<UpstreamName, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'Ollama' };
const MISCONFIGURED: ReadonlySet<ServerReach> = new Set<ServerReach>(['bad_token', 'not_crucible', 'version_mismatch']);

export async function decideVenue(target: CrucibleTarget, host: VenueHost): Promise<VenueAnswer> {
  let enabled: RankedServerRow[];
  try {
    enabled = host.enabled();
  } catch (err) {
    return { kind: 'wait', reason: (err as Error).message };
  }
  const reachable: string[] = [];
  const tried: string[] = [];
  const silent: string[] = [];
  let misconfigured = 0;
  for (const row of enabled) {
    const answer = await host.reach(row.name);
    if (answer.reach !== 'ready' && answer.reach !== 'busy') {
      if (MISCONFIGURED.has(answer.reach)) misconfigured += 1;
      if (answer.reach === 'unreachable') silent.push(row.name);
      tried.push(answer.message ? `${row.name}: ${answer.message}` : `${row.name} (${answer.reach.replace(/_/g, ' ')})`);
      continue;
    }
    reachable.push(row.name);
    if (await host.canServe(row.name, target)) return { kind: 'venue', server: row.name, because: 'can serve it' };
  }
  if (target.route === 'upstream') {
    const label = UPSTREAM_LABEL[target.upstream!];
    if (reachable.length > 0) {
      return { kind: 'wait', reason: `No running Crucible server has ${label} configured. Add it in Settings › Crucible Servers.` };
    }
  } else if (reachable.length > 0) {
    return { kind: 'venue', server: reachable[0]!, because: 'first that answered' };
  }
  if (misconfigured > 0 && misconfigured === enabled.length) {
    return { kind: 'fail', reason: `No Crucible server will take work from this computer: ${tried.join('; ')}` };
  }
  if (silent.length === tried.length) {
    return { kind: 'wait', reason: `Crucible on ${silent.join(', ')} isn't answering.` };
  }
  return { kind: 'wait', reason: `Waiting for a Crucible server: ${tried.join('; ')}.` };
}
