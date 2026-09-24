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
 * The rule: the SELECTED Crucible server (Settings › Crucible Servers), and
 * only it. When it answers (ready or busy: busy is the door's question, and
 * parks) and offers asr with an installed model → crucible, with the setting's
 * model when it has it installed, else its most accurate installed one.
 * Otherwise none, with its reason. Never another server.
 */
import type { ServerReach } from '../wire/settings-wire';
import type { AsrOffer } from './asr-models';
import type { TranscriptionSetting } from './transcription-setting';

export type TranscriptionRoute =
  | { kind: 'crucible'; server: string; model: string }
  | { kind: 'none'; reason: string };

export interface TranscriptionVenueHost {
  setting(): TranscriptionSetting;
  /** The selected server. Throws (routing's own sentence) when there is none. */
  selected(): string;
  reach(server: string): Promise<{ reach: ServerReach; message?: string }>;
  /** `/v1/info` read for asr. Throws when it cannot be read. */
  asrOffer(server: string): Promise<AsrOffer>;
}

export async function decideTranscriptionRoute(host: TranscriptionVenueHost): Promise<TranscriptionRoute> {
  const setting = host.setting();
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
  if (!offer.offersAsr) return { kind: 'none', reason: `Crucible on ${server} has no transcription engine.` };
  const installed = new Set(offer.choice.models.filter((m) => m.installed).map((m) => m.id));
  const model = setting.model !== null && installed.has(setting.model) ? setting.model : offer.choice.recommended;
  if (model === null) {
    return { kind: 'none', reason: `Crucible on ${server} has no transcription model downloaded${offer.choice.betterNotInstalled ? ` (${offer.choice.betterNotInstalled} can be pulled)` : ''}.` };
  }
  return { kind: 'crucible', server, model };
}
