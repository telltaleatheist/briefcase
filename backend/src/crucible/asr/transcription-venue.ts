/**
 * WHERE ONE TRANSCRIPTION RUNS: one rule, one place (P5; P7 made it the only
 * transcriber).
 *
 * The answer is a ROUTE:
 *
 *   crucible  {server, model}: the task takes that server's GPU lane, and the
 *             asr submit is its reservation (a 409 there parks it).
 *   none      no server can take it now; `reason` says why. A queued task
 *             PARKS on it and is asked again; a caller with no queue surfaces
 *             it. It is never transcribed some other way.
 *
 * The order of the rules:
 *   1. no registered server            → none
 *   2. the named server, or every enabled server best first: the first that
 *      answers (ready or busy: busy is the door's question, and parks) and
 *      offers asr with an installed model → crucible, with the setting's model
 *      when that server has it installed, else its most accurate installed one.
 *   3. none, naming each server's reason.
 */
import type { RankedServerRow, ServerReach } from '../wire/settings-wire';
import type { AsrOffer } from './asr-models';
import type { TranscriptionSetting } from './transcription-setting';

export type TranscriptionRoute =
  | { kind: 'crucible'; server: string; model: string }
  | { kind: 'none'; reason: string };

export interface TranscriptionVenueHost {
  setting(): TranscriptionSetting;
  /** Every registered server, best first, with its Running/Paused switch. */
  registered(): RankedServerRow[];
  reach(server: string): Promise<{ reach: ServerReach; message?: string }>;
  /** `/v1/info` read for asr. Throws when it cannot be read. */
  asrOffer(server: string): Promise<AsrOffer>;
}

export async function decideTranscriptionRoute(host: TranscriptionVenueHost): Promise<TranscriptionRoute> {
  const setting = host.setting();

  let registered: RankedServerRow[];
  try {
    registered = host.registered();
  } catch {
    registered = [];
  }
  if (registered.length === 0) {
    return { kind: 'none', reason: 'No Crucible server is connected. Transcription runs on Crucible: connect one in Settings › Crucible Servers.' };
  }

  let candidates: RankedServerRow[];
  const reasons: string[] = [];
  if (setting.server !== null) {
    const named = registered.find((row) => row.name === setting.server);
    if (named === undefined) {
      return { kind: 'none', reason: `The Crucible server "${setting.server}" chosen in Settings › Transcription isn't connected any more.` };
    }
    candidates = [named];
  } else {
    candidates = registered;
  }

  for (const row of candidates) {
    if (!row.enabled) {
      reasons.push(`${row.name} is paused`);
      continue;
    }
    const reach = await host.reach(row.name);
    if (reach.reach !== 'ready' && reach.reach !== 'busy') {
      reasons.push(reach.reach === 'unreachable'
        ? `Crucible on ${row.name} isn't answering`
        : `Crucible on ${row.name} can't be used (${reach.message ?? reach.reach.replace(/_/g, ' ')})`);
      continue;
    }
    let offer: AsrOffer;
    try {
      offer = await host.asrOffer(row.name);
    } catch (err) {
      reasons.push(`Crucible on ${row.name} couldn't say what it offers (${(err as Error)?.message ?? err})`);
      continue;
    }
    if (!offer.offersAsr) {
      reasons.push(`Crucible on ${row.name} has no transcription engine`);
      continue;
    }
    const installed = new Set(offer.choice.models.filter((m) => m.installed).map((m) => m.id));
    const model = setting.model !== null && installed.has(setting.model) ? setting.model : offer.choice.recommended;
    if (model === null) {
      reasons.push(`Crucible on ${row.name} has no transcription model downloaded${offer.choice.betterNotInstalled ? ` (${offer.choice.betterNotInstalled} can be pulled)` : ''}`);
      continue;
    }
    return { kind: 'crucible', server: row.name, model };
  }

  const why = reasons.join('; ');
  return { kind: 'none', reason: `${why.charAt(0).toUpperCase()}${why.slice(1)}.` };
}
