/**
 * What the Settings › Crucible Servers pane draws. Owned by the backend,
 * imported by the renderer (see connect-wire.ts for why it lives here).
 *
 * Nothing here carries a token: a row has `tokenMasked` (`****abcd`) and a
 * settings document has `keyHint`, and that is all the renderer ever holds.
 */

/** One registered server, as the row draws it. Local and remote are one kind. */
export interface CrucibleServerRow {
  name: string;
  url: string;
  tokenMasked: string;
  /** ISO 8601. */
  added: string;
}

/** One server's place in the order. Rank is the index; there is no number. */
export interface RankedServerRow {
  name: string;
  /** Running (true) or Paused (false). A paused server is given no new work. */
  enabled: boolean;
}

export interface RoutingView {
  /** Every registered server, best first. */
  ranked: RankedServerRow[];
  /** Names the routing record mentions that no server answers to. Reported, never pruned. */
  unknown: string[];
}

/** The Crucible on this computer, as an offer to add, or the named reason there is none. */
export type DiscoveredCrucibleRow =
  | {
      present: true;
      /** What the server calls itself, from its pairing file. */
      serverName: string;
      url: string;
      tokenMasked: string;
      /** The pairing file it was read from. */
      file: string;
      /** The registry row already at that address, or null when the offer is open. */
      registeredAs: string | null;
    }
  | { present: false; code: string; reason: string };

/** `GET /crucible/servers`: everything the pane draws before it probes anything. */
export interface CrucibleServersView {
  servers: CrucibleServerRow[];
  routing: RoutingView;
  discovered: DiscoveredCrucibleRow;
}

/**
 * What a reachable server says about itself: `/v1/info` plus `/v1/activity`.
 * Mirrors the SDK's ServerInfo (this file may not import it): the descriptive
 * fields are null where the server did not state them, and are shown as
 * unknown or left out, never guessed.
 */
export interface ServerFacts {
  serverName: string;
  version: string | null;
  apiVersion: number;
  platform: string | null;
  arch: string | null;
  backend: string | null;
  gpu: { vendor: string | null; name: string | null; vramBytes: number | null } | null;
  jobTypes: string[];
  /** The card's holder, in one sentence, or null when the lane accepts work. */
  busyLine: string | null;
  /** The resident model id, or null. */
  resident: string | null;
  /** True when the server STATES a version older than Briefcase's floor (`MIN_CRUCIBLE`); false when it states none. */
  needsUpdate: boolean;
  /** Set when the registered address is an orchestrator and this is its engine. */
  engineUrl: string | null;
  /**
   * What this server does for Briefcase, per capability class: `analysis`
   * (chat) and `asr` (transcription). Null when the server has not decided
   * its capabilities yet (`crucible capability --write` not run).
   */
  capabilities: CapabilityFact[] | null;
}

/** One capability class's verdict on one server. A disabled class is an answer, not an error. */
export interface CapabilityFact {
  capability: 'analysis' | 'asr';
  enabled: boolean;
  /** The model that serves it (an upstream id when routed), or '' when none does. */
  selected: string;
  route: 'local' | 'upstream';
  /** Why, in the server's own words; null when it gave none. */
  reason: string | null;
}

/**
 * A probe's answer. Every failure is a named outcome, because each has its own
 * fix: nothing there, something that is not a Crucible, a Crucible that
 * refused the token, a Crucible on another API version, or a named refusal.
 */
export type CrucibleProbeResult =
  | { outcome: 'ok'; facts: ServerFacts }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'not_a_crucible'; message: string }
  | { outcome: 'wrong_token'; message: string }
  | { outcome: 'version_mismatch'; message: string }
  | { outcome: 'refused'; message: string };

/** The one word a row's reach chip shows. */
export type ServerReach = 'ready' | 'busy' | 'unreachable' | 'bad_token' | 'not_crucible' | 'version_mismatch' | 'refused';

export interface CrucibleProbeAnswer {
  server: string;
  reach: ServerReach;
  probe: CrucibleProbeResult;
  /** When this answer was taken (epoch ms); a cached one is up to 10 s old. */
  at: number;
}

/** The engine's settings document, as the renderer may see it. Keys never; hints only. */
export interface CrucibleSettingsView {
  routes: Record<string, { route: 'local' | 'upstream'; model: string | null }>;
  /** One card per upstream; null for one this server does not offer (the pane leaves it out). */
  upstreams: {
    anthropic: { configured: boolean; keyHint: string | null } | null;
    openai: { configured: boolean; keyHint: string | null } | null;
    ollama: { configured: boolean; url: string | null } | null;
  };
  /** Class → explicit local model (null = the engine's own choice); the whole map null when the server did not state it. */
  localModels: Record<string, string | null> | null;
  /**
   * Class → the models the server says can serve it, in its order (an
   * uninstalled one included); the whole map null when the server did not
   * state it. Each row's `installed`/`fits` are null where unstated.
   */
  localModelChoices: Record<string, Array<{ id: string; installed: boolean | null; fits: boolean | null }>> | null;
  /** Null when the server did not state it. */
  backendKind: string | null;
}

export type UpstreamName = 'anthropic' | 'openai' | 'ollama';

export type UpstreamTestAnswer =
  | { ok: true; models: string[] }
  | { ok: false; code: string; message: string };

/** The Socket.IO event the registry and routing record announce on. */
export const CRUCIBLE_SERVERS_CHANGED = 'crucible.servers-changed';

export interface CrucibleServersChangedPayload {
  /** What changed, for a log line; the pane re-reads the whole view either way. */
  reason: 'added' | 'removed' | 'order' | 'paused' | 'resumed' | 'forgotten';
  server: string | null;
}
