/**
 * THE AI PANE'S BACKEND, through Crucible (P3): which models the connected
 * server offers, the one-time copy of Briefcase's old keys onto a Crucible,
 * and the per-task model choice.
 *
 * KEYS (the user's decision of 2026-09-23): keys live on whichever Crucible
 * serves the call, configured through THAT server's settings. Briefcase holds
 * none and never copies one between servers on its own. The copy here is an
 * action the user takes, naming the server; api-keys.json is deleted only when
 * the target is the Crucible on THIS computer and its settings, read back
 * after the write, show the hint of every key the file held.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';
import { LegacyApiKeys } from './legacy-api-keys';
import { CRUCIBLE_PAIRING_HOST } from '../crucible.constants';
import { CrucibleServersService } from '../crucible-servers.service';
import { discoveredRow } from '../discovery';
import type { PairingFileHost } from '../pairing-file';
import { CrucibleProbeService } from '../probe';
import { CrucibleSettingsBridge } from '../settings-bridge.service';
import type {
  AiModelsView,
  AiTaskModels,
  AiTaskName,
  AiUpstreamsView,
  KeyCopyOutcome,
  LegacyKeysView,
} from '../wire/ai-wire';
import { CrucibleChatService } from './crucible-chat.service';
import type { UpstreamName } from './target';
import {
  UPSTREAM_ORDER,
  UPSTREAM_WORDS,
  buildAnalysisOptions,
  optionValues,
  resolveStoredModel,
  type AnalysisOptionFacts,
  type UpstreamListing,
} from './model-options';

export const AI_TASKS: readonly AiTaskName[] = ['chapter', 'flags', 'description', 'tags', 'title'];
const UPSTREAM_LIST_CACHE_MS = 60_000;

export class CrucibleAiInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CrucibleAiInputError';
  }
}

/** `…abcd` matches a key ending in `abcd`. The ellipsis is the server's; any leading mask is ignored. */
export function hintMatches(hint: string | null | undefined, key: string): boolean {
  if (typeof hint !== 'string') return false;
  const tail = hint.replace(/^[^A-Za-z0-9]+/, '');
  return tail.length >= 2 && key.endsWith(tail);
}

@Injectable()
export class CrucibleAiService {
  private readonly logger = new Logger('CrucibleAi');
  private readonly upstreamLists = new Map<string, { at: number; ids: string[] | null; error: string | null }>();

  constructor(
    private readonly servers: CrucibleServersService,
    private readonly probes: CrucibleProbeService,
    private readonly settings: CrucibleSettingsBridge,
    private readonly chat: CrucibleChatService,
    private readonly apiKeys: LegacyApiKeys,
    @Inject(CRUCIBLE_PAIRING_HOST) private readonly pairingHost: PairingFileHost,
  ) {}

  /** The best-ranked running server that answers, or the sentence saying why there is none. */
  async connectedServer(explicit?: string): Promise<{ server: string | null; reach: AiModelsView['reach']; unavailable: string | null }> {
    if (explicit) {
      const answer = await this.probes.reach(explicit);
      return { server: explicit, reach: answer.reach, unavailable: null };
    }
    let ranked: string[];
    try {
      ranked = this.servers.ranked().map((row) => row.name);
    } catch (err) {
      return { server: null, reach: null, unavailable: (err as Error).message };
    }
    const down: string[] = [];
    for (const name of ranked) {
      const answer = await this.probes.reach(name);
      if (answer.reach === 'ready' || answer.reach === 'busy') return { server: name, reach: answer.reach, unavailable: null };
      down.push(`${name}: ${answer.reach}`);
    }
    return { server: null, reach: null, unavailable: `No Crucible server is answering (${down.join('; ')}).` };
  }

  /**
   * THE one source of analysis-model options (model-options.ts): the
   * connected server's own models that can serve the `analysis` class, and
   * the models of each upstream it has configured. `values` are stored
   * choices to resolve against them (a saved default, task models, a job's).
   */
  async models(explicit?: string, values: readonly string[] = []): Promise<AiModelsView> {
    const { server, reach, unavailable } = await this.connectedServer(explicit);
    const asked = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
    if (server === null) {
      return {
        server, local: false, reach, unavailable, upstreams: null, groups: [], analysisDefault: null,
        resolved: asked.map((value) => ({ value, option: null, note: null, unavailable: unavailable ?? 'No Crucible server is answering.' })),
      };
    }
    const { facts, upstreams } = await this.optionFacts(server);
    const built = buildAnalysisOptions(facts);
    const offered = optionValues(built.groups);
    return {
      server,
      local: facts.local,
      reach,
      unavailable: null,
      upstreams,
      groups: built.groups,
      analysisDefault: built.analysisDefault,
      resolved: asked.map((value) => resolveStoredModel(value, facts, offered)),
    };
  }

  /** Everything the options are built from, read off one server. A read that fails reads as unstated. */
  private async optionFacts(server: string): Promise<{ facts: AnalysisOptionFacts; upstreams: AiUpstreamsView }> {
    const view = await this.settings.get(server);
    let models: AnalysisOptionFacts['models'] = [];
    try {
      models = await this.chat.modelsOn(server, true);
    } catch (err) {
      this.logger.warn(`[${server}] model list failed: ${(err as Error).message}`);
    }
    let pageReaders: string[] | null = null;
    let ceilings: Map<string, number> | null = null;
    try {
      const classFacts = await this.chat.classFactsOn(server);
      pageReaders = classFacts.readers;
      ceilings = classFacts.ceilings;
    } catch {
      // unstated
    }
    let analysis: AnalysisOptionFacts['analysis'] = null;
    try {
      const client = await this.servers.clientFor(server);
      const record = await client.capability({ timeoutMs: 5_000 });
      const row = record.classes.find((r) => r.capability === 'analysis');
      if (row) analysis = { selected: row.selected, route: row.route, enabled: row.enabled };
    } catch {
      analysis = null;
    }
    const listings: Partial<Record<UpstreamName, UpstreamListing>> = {};
    for (const upstream of UPSTREAM_ORDER) {
      if (view.upstreams[upstream]?.configured === true) listings[upstream] = await this.upstreamIds(server, upstream);
    }
    const candidates = view.localModelChoices?.['analysis'];
    const facts: AnalysisOptionFacts = {
      server,
      local: this.localServer() === server,
      models,
      classCandidates: candidates === undefined || candidates === null ? null : candidates.map((c) => c.id),
      pageReaders,
      ceilings,
      analysis,
      upstreams: {
        anthropic: view.upstreams.anthropic === null ? null : { configured: view.upstreams.anthropic.configured },
        openai: view.upstreams.openai === null ? null : { configured: view.upstreams.openai.configured },
        ollama: view.upstreams.ollama === null ? null : { configured: view.upstreams.ollama.configured },
      },
      listings,
    };
    return { facts, upstreams: view.upstreams };
  }

  private async upstreamIds(server: string, upstream: UpstreamName): Promise<UpstreamListing> {
    const key = `${server}\n${upstream}`;
    const cached = this.upstreamLists.get(key);
    if (cached !== undefined && Date.now() - cached.at < UPSTREAM_LIST_CACHE_MS) return cached;
    let entry: { at: number; ids: string[] | null; error: string | null };
    try {
      const answer = await this.settings.testUpstream(server, upstream, {});
      entry = answer.ok ? { at: Date.now(), ids: answer.models, error: null } : { at: Date.now(), ids: null, error: answer.message };
    } catch (err) {
      entry = { at: Date.now(), ids: null, error: (err as Error).message };
    }
    this.upstreamLists.set(key, entry);
    return entry;
  }

  /** Drop cached upstream lists and settings (after a settings save). */
  forget(server?: string): void {
    for (const key of [...this.upstreamLists.keys()]) if (server === undefined || key.startsWith(`${server}\n`)) this.upstreamLists.delete(key);
    this.chat.forgetCaches(server);
  }

  // ── the one-time key copy ────────────────────────────────────────────

  /** The registered server that is the Crucible on this computer, or null. */
  localServer(): string | null {
    const row = discoveredRow(this.servers.list(), this.pairingHost);
    return row.present ? row.registeredAs : null;
  }

  legacyKeys(): LegacyKeysView {
    const keys = this.apiKeys.keysForCopy();
    return { claude: keys.claude !== undefined, openai: keys.openai !== undefined, localServer: this.localServer() };
  }

  async copyKeys(server: string): Promise<KeyCopyOutcome> {
    if (!this.servers.list().some((row) => row.name === server)) {
      throw new CrucibleAiInputError('unknown_server', `"${server}" is not one of this computer's Crucible servers.`);
    }
    const keys = this.apiKeys.keysForCopy();
    const pairs = ([['anthropic', keys.claude], ['openai', keys.openai]] as const)
      .filter((pair): pair is readonly ['anthropic' | 'openai', string] => typeof pair[1] === 'string' && pair[1] !== '');
    if (pairs.length === 0) throw new CrucibleAiInputError('nothing_to_copy', 'Briefcase has no Claude or OpenAI key of its own to copy.');

    const before = await this.settings.get(server);
    const outcome: KeyCopyOutcome = { server, copied: [], alreadyThere: [], skipped: [], deletedLocalFile: false, keptBecause: null };
    const patch: { upstreams: Record<string, { key: string }> } = { upstreams: {} };
    for (const [upstream, key] of pairs) {
      const current = before.upstreams[upstream];
      if (current === null) {
        outcome.skipped.push({ upstream, reason: `"${server}" does not offer ${UPSTREAM_WORDS[upstream]}, so the key was not copied there.` });
      } else if (current.configured && hintMatches(current.keyHint, key)) {
        outcome.alreadyThere.push(upstream);
      } else if (current.configured) {
        outcome.skipped.push({
          upstream,
          reason: `"${server}" already has a different ${UPSTREAM_WORDS[upstream]} key (${current.keyHint ?? 'set'}), so it was left as it is.`,
        });
      } else {
        patch.upstreams[upstream] = { key };
      }
    }
    if (Object.keys(patch.upstreams).length > 0) {
      // NEVER LOGGED: the patch carries keys.
      await this.settings.put(server, patch);
    }

    // Read back: a key counts as moved only when the server shows its hint.
    const after = await this.settings.get(server);
    for (const upstream of Object.keys(patch.upstreams) as Array<'anthropic' | 'openai'>) {
      const key = pairs.find(([u]) => u === upstream)![1];
      const card = after.upstreams[upstream];
      if (card !== null && card.configured && hintMatches(card.keyHint, key)) outcome.copied.push(upstream);
      else outcome.skipped.push({ upstream, reason: `"${server}" did not confirm the ${UPSTREAM_WORDS[upstream]} key after saving it.` });
    }
    this.forget(server);

    const confirmedAll = pairs.every(([u]) => outcome.copied.includes(u) || outcome.alreadyThere.includes(u));
    const local = this.localServer();
    if (!confirmedAll) {
      outcome.keptBecause = 'Not every key is confirmed on the server, so Briefcase kept its own copy.';
    } else if (local !== server) {
      outcome.keptBecause = `"${server}" is not the Crucible on this computer, so Briefcase kept its own copy.`;
    } else {
      this.apiKeys.forgetKeysAndDeleteFile();
      outcome.deletedLocalFile = true;
    }
    this.logger.log(
      `Key copy to "${server}": copied [${outcome.copied.join(', ')}], already there [${outcome.alreadyThere.join(', ')}], `
        + `skipped [${outcome.skipped.map((s) => s.upstream).join(', ')}], file ${outcome.deletedLocalFile ? 'deleted' : 'kept'}`,
    );
    return outcome;
  }

  // ── per-task models (app-config taskModels) ─────────────────────────

  private appConfigFile(): string {
    return path.join(getBriefcaseConfigDir(), 'app-config.json');
  }

  taskModels(): AiTaskModels {
    try {
      const raw = JSON.parse(fs.readFileSync(this.appConfigFile(), 'utf8'))?.taskModels;
      const out: AiTaskModels = {};
      if (raw && typeof raw === 'object') {
        for (const task of AI_TASKS) if (typeof raw[task] === 'string' && raw[task].trim()) out[task] = raw[task].trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Set (a `provider:model` string) or clear (null / '') one task's model. Other tasks and keys are kept. */
  setTaskModels(changes: Record<string, unknown>): AiTaskModels {
    const file = this.appConfigFile();
    let config: Record<string, unknown> = {};
    if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const current = (config['taskModels'] && typeof config['taskModels'] === 'object' ? config['taskModels'] : {}) as Record<string, unknown>;
    for (const [task, value] of Object.entries(changes)) {
      if (!(AI_TASKS as readonly string[]).includes(task)) throw new CrucibleAiInputError('invalid_task', `"${task}" is not a task with its own model (${AI_TASKS.join(', ')}).`);
      if (value === null || value === '') delete current[task];
      else if (typeof value === 'string' && /^[a-z]+:.+/.test(value.trim())) current[task] = value.trim();
      else throw new CrucibleAiInputError('invalid_model', `The model for ${task} must look like "provider:model".`);
    }
    config['taskModels'] = current;
    config['lastUpdated'] = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return this.taskModels();
  }
}
