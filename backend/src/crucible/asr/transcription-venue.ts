/**
 * WHERE ONE TRANSCRIPTION RUNS: one rule, one place (P5).
 *
 * The user's decisions (2026-09-23): transcription goes through Crucible's
 * `asr` job on the Mac and the PC; whisper-cli stays ONLY as the fallback until
 * Crucible transcription is verified on both (it goes in P7); translation is
 * not a Briefcase requirement, so a task that asks for it is routed to
 * whisper-cli, which is the only engine with a translate task.
 *
 * The answer is a ROUTE:
 *
 *   crucible  {server, model}: the task takes that server's GPU lane, and the
 *             asr submit is its reservation (a 409 there parks it).
 *   cli       whisper-cli in the main pool. `warning` is set when Crucible was
 *             expected and could not be used (no server answering, no asr
 *             engine, no installed asr model): the task says so when it
 *             finishes, as the snap and NLI fallbacks do. A choice (the
 *             setting, translate, no Crucible at all) carries no warning.
 *
 * The order of the rules:
 *   1. translate                       → cli (reason: translate)
 *   2. setting venue 'whisper-cli'     → cli
 *   3. venue 'auto' under aiVia direct → cli (the direct road is the legacy road)
 *   4. no registered server            → cli; a warning only if the setting says 'crucible'
 *   5. the named server, or every enabled server best first: the first that
 *      answers (ready or busy: busy is the door's question, and parks) and
 *      offers asr with an installed model → crucible, with the setting's model
 *      when that server has it installed, else its most accurate installed one.
 *   6. none                            → cli, with a warning naming each reason.
 */
import type { AiVia } from '../llm/ai-via';
import type { RankedServerRow, ServerReach } from '../wire/settings-wire';
import type { AsrOffer } from './asr-models';
import type { TranscriptionSetting } from './transcription-setting';

export type TranscriptionRoute =
  | { kind: 'crucible'; server: string; model: string }
  | { kind: 'cli'; reason: string; warning: string | null };

export interface TranscriptionVenueHost {
  setting(): TranscriptionSetting;
  aiVia(): AiVia;
  /** Every registered server, best first, with its Running/Paused switch. */
  registered(): RankedServerRow[];
  reach(server: string): Promise<{ reach: ServerReach; message?: string }>;
  /** `/v1/info` read for asr. Throws when it cannot be read. */
  asrOffer(server: string): Promise<AsrOffer>;
}

export interface TranscriptionAsk {
  translate?: boolean;
}

const FALLBACK = 'Transcribed with the offline transcriber (whisper) because';

export async function decideTranscriptionRoute(ask: TranscriptionAsk, host: TranscriptionVenueHost): Promise<TranscriptionRoute> {
  if (ask.translate === true) {
    return { kind: 'cli', reason: 'Translating to English uses the offline transcriber (whisper); Crucible transcribes in the spoken language only.', warning: null };
  }
  const setting = host.setting();
  if (setting.venue === 'whisper-cli') {
    return { kind: 'cli', reason: 'Transcription is set to the offline transcriber (whisper).', warning: null };
  }
  if (setting.venue === 'auto' && host.aiVia() === 'direct') {
    return { kind: 'cli', reason: 'AI runs directly from Briefcase, so transcription uses the offline transcriber (whisper).', warning: null };
  }

  let registered: RankedServerRow[];
  try {
    registered = host.registered();
  } catch {
    registered = [];
  }
  const explicitCrucible = setting.venue === 'crucible';
  if (registered.length === 0) {
    return {
      kind: 'cli',
      reason: 'No Crucible server is connected.',
      warning: explicitCrucible ? `${FALLBACK} no Crucible server is connected.` : null,
    };
  }

  let candidates: RankedServerRow[];
  const reasons: string[] = [];
  if (setting.server !== null) {
    const named = registered.find((row) => row.name === setting.server);
    if (named === undefined) {
      const reason = `the Crucible server "${setting.server}" chosen in Settings › Transcription isn't connected any more`;
      return { kind: 'cli', reason: `${reason}.`, warning: `${FALLBACK} ${reason}.` };
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
  return { kind: 'cli', reason: `${why}.`, warning: `${FALLBACK} ${why}.` };
}
