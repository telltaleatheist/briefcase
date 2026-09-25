/**
 * WHERE ONE TRANSCRIPTION RUNS: one rule, one place (P5; P7 made it the only
 * transcriber).
 *
 * The answer is a ROUTE:
 *
 *   crucible  {server, model}: the task takes that server's GPU lane, and the
 *             asr submit is its reservation (a 409 there parks it).
 *   none      the server can't take it now; `reason` says why. A queued task
 *             PARKS on it and is asked again; a caller with no queue surfaces
 *             it. It is never transcribed some other way.
 *
 * The rule: the SELECTED Crucible server (Settings › Crucible Servers), and
 * only it, with Qwen3-ASR-0.6B (asr-models.ts: the MLX build on a Mac), and
 * only Qwen. When it answers
 * (ready or busy: busy is the door's question, and parks) and has Qwen and its
 * aligner downloaded → crucible. Otherwise none, with its reason: never
 * another server, never another model.
 */
import type { ServerReach } from '../wire/settings-wire';
import { qwenUnavailable, type AsrOffer } from './asr-models';

export type TranscriptionRoute =
  | { kind: 'crucible'; server: string; model: string }
  | { kind: 'none'; reason: string };

export interface TranscriptionVenueHost {
  /** The selected server. Throws (routing's own sentence) when there is none. */
  selected(): string;
  reach(server: string): Promise<{ reach: ServerReach; message?: string }>;
  /** `/v1/info` read for asr. Throws when it cannot be read. */
  asrOffer(server: string): Promise<AsrOffer>;
}

export async function decideTranscriptionRoute(host: TranscriptionVenueHost): Promise<TranscriptionRoute> {
  let server: string;
  try {
    server = host.selected();
  } catch (err) {
    return { kind: 'none', reason: `${(err as Error).message} Transcription runs on Crucible.` };
  }
  const reach = await host.reach(server);
  if (reach.reach !== 'ready' && reach.reach !== 'busy') {
    return {
      kind: 'none',
      reason: reach.reach === 'unreachable'
        ? `Crucible on ${server} isn't answering.`
        : `Crucible on ${server} can't be used (${reach.message ?? reach.reach.replace(/_/g, ' ')}).`,
    };
  }
  let offer: AsrOffer;
  try {
    offer = await host.asrOffer(server);
  } catch (err) {
    return { kind: 'none', reason: `Crucible on ${server} couldn't say what it offers (${(err as Error)?.message ?? err}).` };
  }
  const why = qwenUnavailable(server, offer);
  return why === null ? { kind: 'crucible', server, model: offer.model } : { kind: 'none', reason: why };
}
