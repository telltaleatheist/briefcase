/**
 * A WINDOW ONTO ONE SERVER'S OWN SETTINGS: routes, upstream keys and the local
 * model per class.
 *
 * Keys and upstreams live on whichever Crucible serves the call, configured
 * through that server's settings, as BookForge's engine-settings does. Briefcase
 * holds no key and never copies one between servers (the user's decision of
 * 2026-09-23). This proxies `GET /v1/settings`, `PUT /v1/settings` and
 * `POST /v1/settings/upstreams/:name/test` for the pane, and nothing more.
 *
 * NO BODY IS EVER LOGGED: a PUT carries a key on its way in. What comes back
 * carries only `keyHint`, which is the server's own `…abcd`.
 */
import { Injectable } from '@nestjs/common';
import type { SettingsDocument, SettingsPatch } from '@crucible/client';
import { CrucibleClientFactory } from './client-factory';
import type { CrucibleSettingsView, UpstreamName, UpstreamTestAnswer } from './wire/settings-wire';

export const UPSTREAM_NAMES: readonly UpstreamName[] = ['anthropic', 'openai', 'ollama'];

export class CrucibleSettingsInputError extends Error {
  readonly code = 'invalid_settings';
  constructor(message: string) {
    super(message);
    this.name = 'CrucibleSettingsInputError';
  }
}

export function isUpstreamName(value: string): value is UpstreamName {
  return (UPSTREAM_NAMES as readonly string[]).includes(value);
}

function viewOf(doc: SettingsDocument): CrucibleSettingsView {
  const routes: CrucibleSettingsView['routes'] = {};
  for (const [name, setting] of Object.entries(doc.routes)) routes[name] = { route: setting.route, model: setting.model };
  const { anthropic, openai, ollama } = doc.upstreams;
  return {
    routes,
    // A null card is an upstream this server does not offer: carried as null for the pane to leave out.
    upstreams: {
      anthropic: anthropic === null ? null : { configured: anthropic.configured, keyHint: anthropic.keyHint ?? null },
      openai: openai === null ? null : { configured: openai.configured, keyHint: openai.keyHint ?? null },
      ollama: ollama === null ? null : { configured: ollama.configured, url: ollama.url ?? null },
    },
    localModels: doc.localModels === null ? null : { ...doc.localModels },
    localModelChoices: doc.localModelChoices === null
      ? null
      : Object.fromEntries(Object.entries(doc.localModelChoices).map(([cls, rows]) => [cls, rows.map((r) => ({ id: r.id, installed: r.installed, fits: r.fits }))])),
    backendKind: doc.backendKind,
  };
}

/** The patch the pane may send, checked for shape. Unknown keys are refused, not dropped. */
export function patchOf(body: unknown): SettingsPatch {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CrucibleSettingsInputError('A settings change is an object.');
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!['upstreams', 'routes', 'localModels'].includes(key)) {
      throw new CrucibleSettingsInputError(`"${key}" is not a setting Briefcase changes.`);
    }
  }
  const patch: { upstreams?: Record<string, { key?: string; url?: string } | null>; routes?: Record<string, string>; localModels?: Record<string, string | null> } = {};
  if (input['upstreams'] !== undefined) {
    const ups = input['upstreams'] as Record<string, unknown>;
    if (typeof ups !== 'object' || ups === null) throw new CrucibleSettingsInputError('"upstreams" is an object.');
    patch.upstreams = {};
    for (const [name, value] of Object.entries(ups)) {
      if (!isUpstreamName(name)) throw new CrucibleSettingsInputError(`"${name}" is not an upstream (anthropic, openai, ollama).`);
      if (value === null) { patch.upstreams[name] = null; continue; }
      const v = value as Record<string, unknown>;
      const entry: { key?: string; url?: string } = {};
      if (typeof v['key'] === 'string') entry.key = v['key'];
      if (typeof v['url'] === 'string') entry.url = v['url'];
      patch.upstreams[name] = entry;
    }
  }
  if (input['routes'] !== undefined) {
    const routes = input['routes'] as Record<string, unknown>;
    if (typeof routes !== 'object' || routes === null) throw new CrucibleSettingsInputError('"routes" is an object.');
    patch.routes = {};
    for (const [cls, value] of Object.entries(routes)) {
      if (typeof value !== 'string') throw new CrucibleSettingsInputError(`routes.${cls} is a model id or "local".`);
      patch.routes[cls] = value;
    }
  }
  if (input['localModels'] !== undefined) {
    const local = input['localModels'] as Record<string, unknown>;
    if (typeof local !== 'object' || local === null) throw new CrucibleSettingsInputError('"localModels" is an object.');
    patch.localModels = {};
    for (const [cls, value] of Object.entries(local)) {
      if (value !== null && typeof value !== 'string') throw new CrucibleSettingsInputError(`localModels.${cls} is a model id or null.`);
      patch.localModels[cls] = value as string | null;
    }
  }
  return patch as SettingsPatch;
}

@Injectable()
export class CrucibleSettingsBridge {
  constructor(private readonly factory: CrucibleClientFactory) {}

  async get(server: string): Promise<CrucibleSettingsView> {
    const client = await this.factory.clientFor(server);
    return viewOf(await client.settings());
  }

  async put(server: string, body: unknown): Promise<CrucibleSettingsView> {
    const patch = patchOf(body);
    const client = await this.factory.clientFor(server);
    return viewOf(await client.putSettings(patch));
  }

  async testUpstream(server: string, upstream: string, body: unknown): Promise<UpstreamTestAnswer> {
    if (!isUpstreamName(upstream)) throw new CrucibleSettingsInputError(`"${upstream}" is not an upstream (anthropic, openai, ollama).`);
    const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const probe: { key?: string; url?: string } = {};
    if (typeof input['key'] === 'string' && input['key'] !== '') probe.key = input['key'];
    if (typeof input['url'] === 'string' && input['url'] !== '') probe.url = input['url'];
    const client = await this.factory.clientFor(server);
    const result = await client.testUpstream(upstream, Object.keys(probe).length === 0 ? undefined : probe);
    return result.ok ? { ok: true, models: [...result.models] } : { ok: false, code: result.code, message: result.message };
  }
}
