/**
 * THE ANALYSIS MODELS A CRUCIBLE OFFERS, as picker options, and what a STORED
 * choice is among them. PURE: the service reads the server, this decides.
 *
 * WHICH MODELS. By capability class, on the server's word:
 *
 *   - The server's own models: the `analysis` class's candidates
 *     (`GET /v1/settings` `local_model_choices.analysis`, the models the
 *     server says can serve the class), each kept only when its
 *     `GET /v1/models` row is `loadable` or `resident`: the two facts a load
 *     acts on. The informational ones (install, backend support, family,
 *     size) never admit or drop a model. A server that states no candidates
 *     (an engine that has not measured its card) has its text models that are
 *     not page readers read as the candidates, under the same load facts.
 *   - Each upstream the server has CONFIGURED (`upstreams.<name>.configured`),
 *     listing what the server's own test of it reports. An upstream the server
 *     does not offer, or has not been given a key or address for, adds nothing.
 *
 * Sizes and the like are shown as the server states them, and as unknown when
 * it does not: never inferred from an id.
 *
 * WHAT A STORED VALUE IS. Values are stored as `provider:model` (target.ts).
 * A value that is exactly an option is that option. Otherwise it is read with
 * the rules the analysis applies at call time, so the picker shows what would
 * actually run:
 *
 *   anthropic/<id>, openai/<id>   the claude:/openai: option of that id
 *   ollama:<tag>                  the server's own copy of that model when it
 *                                 has one (ollama-map.ts), else the ollama:
 *                                 option when the server's Ollama lists it
 *   local:<id>, crucible:<id>, a bare id   the local:<id> option
 *
 * Anything else, or a model the server does not offer, is UNAVAILABLE with the
 * reason. It is never swapped for a different model.
 */
import type { ModelInfo } from '@crucible/client';
import type { AiModelOption, AiOptionGroup, AiOptionGroupKind, AiResolvedValue } from '../wire/ai-wire';
import { isAnalysisModel } from './crucible-chat.service';
import { crucibleChoiceForOllama } from './ollama-map';
import { CrucibleTargetError, crucibleTargetOf, type UpstreamName } from './target';

export const UPSTREAM_ORDER: readonly UpstreamName[] = ['anthropic', 'openai', 'ollama'];

/** Briefcase's stored provider for each upstream (target.ts reads these back). */
export const PROVIDER_OF: Record<UpstreamName, 'claude' | 'openai' | 'ollama'> = { anthropic: 'claude', openai: 'openai', ollama: 'ollama' };
export const UPSTREAM_WORDS: Record<UpstreamName, string> = { anthropic: 'Claude', openai: 'OpenAI', ollama: 'Ollama' };

/** The `/v1/models` facts the options read. */
export type OptionModel = Pick<ModelInfo, 'id' | 'family' | 'paramsB' | 'modalities' | 'backendSupported' | 'installed' | 'contextDefault' | 'maxModelLen' | 'resident' | 'loadable' | 'reason'>
  & Partial<Pick<ModelInfo, 'weightsOf'>>;

/** One upstream's listing through the server: ids, or the server's sentence why not. */
export interface UpstreamListing {
  ids: string[] | null;
  error: string | null;
}

/** Everything the options are built from, read off one server. */
export interface AnalysisOptionFacts {
  server: string;
  /** The server is the Crucible on this computer. */
  local: boolean;
  models: readonly OptionModel[];
  /** `local_model_choices.analysis` ids, in the server's order; null or empty when the server states none. */
  classCandidates: readonly string[] | null;
  /** The `pages` class's selection (page readers are never analysis models); null when unstated. */
  pageReaders: readonly string[] | null;
  /** The `generate` class's context ceilings (ollama-map rule 4); null when unstated. */
  ceilings: ReadonlyMap<string, number> | null;
  /** The `analysis` capability row: what the server picks for the class, and where it runs. */
  analysis: { selected: string; route: 'local' | 'upstream'; enabled: boolean } | null;
  /** `configured` per upstream; null for one the server does not offer. */
  upstreams: Record<UpstreamName, { configured: boolean } | null>;
  /** The configured upstreams' listings. */
  listings: Partial<Record<UpstreamName, UpstreamListing>>;
}

export interface AnalysisOptions {
  groups: AiOptionGroup[];
  /** The server's analysis pick as an option value, or null. */
  analysisDefault: string | null;
}

/** Chat models from a provider's model list; embeddings, audio and image models are not pickable. */
export function isPickableUpstreamModel(upstream: UpstreamName, id: string): boolean {
  const lower = id.toLowerCase();
  if (upstream === 'anthropic') return lower.includes('claude');
  if (upstream === 'openai') {
    if (!/^(gpt-|o\d|chatgpt)/.test(lower)) return false;
    return !/(audio|realtime|transcribe|tts|image|embedding|search|instruct|moderation)/.test(lower);
  }
  return !/embed/.test(lower);
}

/** A Crucible model string as Briefcase's stored `provider:model`. */
export function optionValueOf(crucibleModel: string): string {
  const m = /^(anthropic|openai|ollama)\/(.+)$/.exec(crucibleModel);
  if (m) return `${PROVIDER_OF[m[1] as UpstreamName]}:${m[2]}`;
  return `local:${crucibleModel}`;
}

/** The heading a group is drawn under. The server is named when it is not this computer's. */
export function groupLabel(kind: AiOptionGroupKind, server: string, local: boolean): string {
  if (kind === 'server') return local ? 'On this Crucible' : `On ${server}`;
  return `${UPSTREAM_WORDS[kind]} via Crucible${local ? '' : ` on ${server}`}`;
}

/** A model can be loaded here, or already is: the facts a load acts on. */
export function canRun(model: Pick<OptionModel, 'loadable' | 'resident'>): boolean {
  return model.loadable === true || model.resident === true;
}

/** The server's text models that are not page readers: the candidates when it names none. */
function textModels(facts: AnalysisOptionFacts): string[] {
  return facts.models.filter((m) => isAnalysisModel({ ...m, classes: null }, facts.pageReaders)).map((m) => m.id);
}

/** The options, grouped as the server presents them. */
export function buildAnalysisOptions(facts: AnalysisOptionFacts): AnalysisOptions {
  const analysisDefault = facts.analysis?.enabled && facts.analysis.selected ? optionValueOf(facts.analysis.selected) : null;
  const byId = new Map(facts.models.map((m) => [m.id, m]));
  const candidates = facts.classCandidates !== null && facts.classCandidates.length > 0 ? facts.classCandidates : textModels(facts);

  const serverOptions: AiModelOption[] = [];
  for (const id of new Set(candidates)) {
    const model = byId.get(id);
    if (model === undefined || !canRun(model)) continue;
    const value = `local:${id}`;
    const serverChoice = value === analysisDefault;
    serverOptions.push({ value, label: id, group: 'server', sizeB: model.paramsB, resident: model.resident, serverChoice });
  }
  const groups: AiOptionGroup[] = [];
  if (serverOptions.length > 0) groups.push({ kind: 'server', label: groupLabel('server', facts.server, facts.local), options: serverOptions, error: null });

  for (const upstream of UPSTREAM_ORDER) {
    if (facts.upstreams[upstream]?.configured !== true) continue;
    const listing = facts.listings[upstream] ?? { ids: null, error: `${facts.server} did not list its ${UPSTREAM_WORDS[upstream]} models.` };
    const options: AiModelOption[] = [];
    for (const id of new Set(listing.ids ?? [])) {
      if (!isPickableUpstreamModel(upstream, id)) continue;
      const value = `${PROVIDER_OF[upstream]}:${id}`;
      const serverChoice = value === analysisDefault;
      options.push({ value, label: id, group: upstream, sizeB: null, resident: null, serverChoice });
    }
    groups.push({ kind: upstream, label: groupLabel(upstream, facts.server, facts.local), options, error: listing.error });
  }
  return { groups, analysisDefault };
}

/** Every option value in the groups. */
export function optionValues(groups: readonly AiOptionGroup[]): Set<string> {
  return new Set(groups.flatMap((g) => g.options.map((o) => o.value)));
}

/** Why a local model is not an option. */
function localUnavailable(id: string, facts: AnalysisOptionFacts): string {
  const model = facts.models.find((m) => m.id === id);
  if (model === undefined) return `${facts.server} has no model called ${id}. Pick one it offers.`;
  if (!canRun(model)) return model.reason ? `${id} can't run on ${facts.server}: ${model.reason}` : `${id} can't be loaded on ${facts.server}.`;
  return `${facts.server} does not offer ${id} for analysis. Pick one it offers.`;
}

/** Why an upstream model is not an option. */
function upstreamUnavailable(upstream: UpstreamName, id: string, facts: AnalysisOptionFacts): string {
  const words = UPSTREAM_WORDS[upstream];
  const card = facts.upstreams[upstream];
  if (card === null) return `${facts.server} does not offer ${words}. Pick another model, or connect a Crucible that does.`;
  if (!card.configured) return `${words} is not set up on ${facts.server}. Add it in Settings › AI Analysis, or pick another model.`;
  const listing = facts.listings[upstream];
  if (listing?.error) return `${facts.server} could not list its ${words} models: ${listing.error}`;
  return `${facts.server}'s ${words} does not list ${id}. Pick one it lists.`;
}

/** What one stored value is among the options (see the header). */
export function resolveStoredModel(stored: string, facts: AnalysisOptionFacts, options: ReadonlySet<string>): AiResolvedValue {
  const value = (stored ?? '').trim();
  const as = (option: string | null, note: string | null, unavailable: string | null): AiResolvedValue => ({ value: stored, option, note, unavailable });
  if (value === '') return as(null, null, null);
  if (options.has(value)) return as(value, null, null);

  let target;
  try {
    target = crucibleTargetOf(undefined, value);
  } catch (err) {
    const message = err instanceof CrucibleTargetError ? err.message : (err as Error).message;
    return as(null, null, `${value} is not a model Briefcase can run through Crucible. ${message}`);
  }

  if (target.upstream === 'ollama') {
    const tag = target.bareModel;
    let own: string | null = null;
    try {
      own = crucibleChoiceForOllama(tag, facts.models, { pageReaders: facts.pageReaders, ceilings: facts.ceilings })?.id ?? null;
    } catch {
      own = null;
    }
    if (own !== null) {
      const local = `local:${own}`;
      if (options.has(local)) return as(local, `Saved as ${tag} (Ollama). It runs as ${own}, ${facts.server}'s own copy of that model.`, null);
      return as(null, null, `${tag} (Ollama) runs as ${own} on ${facts.server}, and ${localUnavailable(own, facts)}`);
    }
    const viaOllama = `ollama:${tag}`;
    if (options.has(viaOllama)) return as(viaOllama, null, null);
    if (facts.upstreams.ollama?.configured !== true) {
      return as(null, null, `${facts.server} has no model of its own for ${tag}, and Ollama is not set up on it. Pick one of its models.`);
    }
    return as(null, null, upstreamUnavailable('ollama', tag, facts));
  }

  if (target.upstream !== null) {
    const canonical = `${PROVIDER_OF[target.upstream]}:${target.bareModel}`;
    if (options.has(canonical)) return as(canonical, `Saved as ${value}.`, null);
    return as(null, null, upstreamUnavailable(target.upstream, target.bareModel, facts));
  }

  const canonical = `local:${target.bareModel}`;
  if (options.has(canonical)) return as(canonical, value === canonical ? null : `Saved as ${value}.`, null);
  return as(null, null, localUnavailable(target.bareModel, facts));
}
