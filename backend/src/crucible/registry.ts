/**
 * THE CRUCIBLE SERVER REGISTRY: every inference server this machine knows.
 *
 * Ported from BookForge's electron/crucible/servers.ts. One kind of server: a
 * name, a URL and a token, whether it answers on 127.0.0.1 or across the
 * tailnet. Nothing here asks which.
 *
 *   <Briefcase config dir>/crucible-servers.json
 *   { "servers": [ { "name", "url", "token", "added" } ] }
 *
 * The config dir is `getBriefcaseConfigDir()`, on the internal disk beside
 * app-config.json, never on a library volume that may mount late.
 *
 * Written temp-then-rename, mode 0600: a half-written registry is the one
 * shape that would lose every server at once, and the file holds bearer
 * tokens. {@link ServerRegistry.list} cannot return a token; it returns a
 * different type carrying `tokenMasked`. Only {@link ServerRegistry.get}, which
 * exists to authenticate a call, hands one out, and only to the client factory.
 *
 * No fallbacks: an unknown name is refused, not answered with a default; a
 * duplicate name or address is refused, not replaced; a URL without a scheme
 * is refused, not prefixed with a guessed `http://`; a corrupt file is refused,
 * never overwritten.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleRegistryError } from './errors';
import type { CrucibleServerRow } from './wire/settings-wire';

export const REGISTRY_FILE = 'crucible-servers.json';

/** One server as recorded on disk, token and all. */
export interface CrucibleServerEntry {
  name: string;
  /** Base URL WITHOUT `/v1`; the SDK appends the version prefix itself. */
  url: string;
  token: string;
  /** ISO 8601. */
  added: string;
}

/** A server resolved for use. The only type that carries a token out of this module. */
export interface ResolvedServer {
  name: string;
  url: string;
  token: string;
}

interface RegistryFile {
  servers: CrucibleServerEntry[];
}

export const MAX_SERVER_NAME_LENGTH = 48;

/** `****abcd`: enough to tell two tokens apart, not enough to use one. */
export function maskToken(token: string): string {
  return `****${token.slice(-4)}`;
}

/**
 * A URL reduced to what decides whether two rows are one engine: scheme, host
 * and port, lower-cased, default port explicit, path dropped. `localhost` and
 * `127.0.0.1` are deliberately NOT folded together; they can genuinely differ.
 */
export function originKey(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** How two names are compared for "the same server": case-insensitive. Lookups stay exact. */
export function serverNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The name, trimmed, or a refusal saying what is wrong with it. Called at the
 * one moment a name enters the system. The name is shown everywhere (the pane,
 * a queue row's "waiting for", the log), so it has to fit on one line and be
 * one string, and P4's lane ids hang off it as `gpu:<name>`, which is why a
 * colon is refused.
 */
export function validateServerName(raw: string): string {
  const name = raw.trim();
  if (name === '') throw new CrucibleRegistryError('invalid_name', 'A server needs a name.');
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    throw new CrucibleRegistryError(
      'invalid_name',
      `"${name}" is ${name.length} characters, and a server name may be at most ${MAX_SERVER_NAME_LENGTH}.`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    throw new CrucibleRegistryError('invalid_name', 'A server name may not contain control characters. Type the name rather than pasting it.');
  }
  if (name.includes(':')) {
    throw new CrucibleRegistryError('invalid_name', `"${name}" contains a colon, which the queue uses to name a server's lane (gpu:<server>).`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new CrucibleRegistryError('invalid_name', `"${name}" contains a slash. A server name is a name, not a path.`);
  }
  if (/ {2,}/.test(name)) {
    throw new CrucibleRegistryError('invalid_name', `"${name}" has two spaces in a row, which nobody can see. Use single spaces.`);
  }
  return name;
}

function rowOf(entry: CrucibleServerEntry): CrucibleServerRow {
  return { name: entry.name, url: entry.url, tokenMasked: maskToken(entry.token), added: entry.added };
}

/** The registry over one file. The Nest service binds it to the config dir; a spec binds it to a temp dir. */
export class ServerRegistry {
  constructor(readonly file: string) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /**
   * A missing file is an EMPTY registry, which is the honest reading of "no
   * server has been added yet". A file that does not parse is refused.
   */
  private read(): RegistryFile {
    if (!fs.existsSync(this.file)) return { servers: [] };
    const raw = fs.readFileSync(this.file, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CrucibleRegistryError(
        'corrupt_registry',
        `${this.file} is not valid JSON (${(err as Error).message}). It holds the token for every `
          + 'Crucible server, so nothing here will replace it. Repair or delete the file by hand.',
      );
    }
    const servers = (parsed as { servers?: unknown } | null)?.servers;
    if (!Array.isArray(servers)) {
      throw new CrucibleRegistryError(
        'corrupt_registry',
        `${this.file} has no "servers" array. Repair or delete the file by hand.`,
      );
    }
    for (const entry of servers) {
      const row = entry as Partial<CrucibleServerEntry> | null;
      for (const key of ['name', 'url', 'token', 'added'] as const) {
        if (typeof row?.[key] === 'string' && row[key] !== '') continue;
        throw new CrucibleRegistryError(
          'corrupt_registry',
          `${this.file} holds an entry with no "${key}". Every server needs a name, a url, a token `
            + 'and an added timestamp. Repair or delete the file by hand.',
        );
      }
    }
    return { servers: servers as CrucibleServerEntry[] };
  }

  /** Write beside the file and rename onto it, 0600 where the platform honours it. */
  private write(registry: RegistryFile): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  /** Every server, tokens masked. The row type cannot carry one. */
  list(): CrucibleServerRow[] {
    return this.read().servers.map(rowOf);
  }

  names(): string[] {
    return this.read().servers.map((entry) => entry.name);
  }

  /** One server WITH its token, by exact name, or a refusal naming what is registered. */
  get(name: string): ResolvedServer {
    const { servers } = this.read();
    const found = servers.find((entry) => entry.name === name);
    if (!found) {
      throw new CrucibleRegistryError(
        'unknown_server',
        `No Crucible server named "${name}" is registered `
          + `(${servers.length === 0 ? 'there are none' : `known: ${servers.map((s) => s.name).join(', ')}`}).`,
      );
    }
    return { name: found.name, url: found.url, token: found.token };
  }

  /**
   * Record a server. Refuses a bad name, a duplicate name (case-insensitive),
   * a second row on the same ADDRESS (two rows over one card would be two GPU
   * lanes the queue admits to at once), a URL with no scheme or with the `/v1`
   * the SDK appends, and an empty token.
   */
  add(server: { name: string; url: string; token: string }): CrucibleServerRow {
    const name = validateServerName(server.name);
    const url = server.url.trim();
    const token = server.token.trim();
    if (!/^https?:\/\//.test(url)) {
      throw new CrucibleRegistryError('invalid_url', `"${url}" has no http:// or https:// scheme.`);
    }
    if (/\/v1\/?$/.test(url)) {
      throw new CrucibleRegistryError('invalid_url', `"${url}" ends in /v1, which the Crucible client adds itself. Record the base URL.`);
    }
    if (token === '') {
      throw new CrucibleRegistryError('empty_token', `No token for "${name}". A Crucible has no anonymous mode.`);
    }
    const registry = this.read();
    const incoming = originKey(url);
    const sameAddress = registry.servers.find((entry) => originKey(entry.url) === incoming);
    if (sameAddress !== undefined) {
      throw new CrucibleRegistryError(
        'duplicate_server',
        `"${sameAddress.name}" is already registered at that address (${sameAddress.url}). One engine gets one row.`,
      );
    }
    const collision = registry.servers.find((entry) => serverNameKey(entry.name) === serverNameKey(name));
    if (collision !== undefined) {
      throw new CrucibleRegistryError(
        'duplicate_server',
        `A Crucible server named "${collision.name}" is already registered`
          + `${collision.name === name ? '' : ` (names are compared without case, so "${name}" would be the same row)`}.`
          + ' Remove it first, or give this one another name.',
      );
    }
    const entry: CrucibleServerEntry = { name, url: url.replace(/\/+$/, ''), token, added: new Date().toISOString() };
    registry.servers.push(entry);
    this.write(registry);
    return rowOf(entry);
  }

  /** Forget a server. Refuses a name that is not registered. */
  remove(name: string): CrucibleServerRow {
    const registry = this.read();
    const index = registry.servers.findIndex((entry) => entry.name === name);
    if (index < 0) {
      throw new CrucibleRegistryError(
        'unknown_server',
        `No Crucible server named "${name}" is registered `
          + `(${registry.servers.length === 0 ? 'there are none' : `known: ${registry.servers.map((s) => s.name).join(', ')}`}).`,
      );
    }
    const [removed] = registry.servers.splice(index, 1);
    this.write(registry);
    return rowOf(removed as CrucibleServerEntry);
  }
}
