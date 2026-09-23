/**
 * WHICH CRUCIBLE SERVERS THE QUEUE MAY USE, AND IN WHAT ORDER.
 *
 * Ported from BookForge's electron/crucible/routing.ts. The registry owns
 * which servers exist; this owns preference, as a second file, so re-ranking
 * never rewrites a token and removing a server never loses a rank it might get
 * back:
 *
 *   <Briefcase config dir>/crucible-routing.json
 *   { "order": ["3090 Ti", "mac"], "disabled": ["mac"] }
 *
 * `disabled` is the per-server Running/Paused switch. BookForge's third key,
 * `newJobsWaitFor`, is not carried: Briefcase's queue (P4) always takes the
 * first enabled, reachable server in rank order. A record that carries it is
 * read without complaint and written back without it.
 *
 * The rules, each from crucible docs/PHASE7-LANES.md §4.2.2:
 *  - rank is the list's order; there is no rank number;
 *  - a newly added server lands at the BOTTOM (a server the order does not
 *    name yet ranks after every server it does);
 *  - an order that names a server the registry no longer has is REPORTED
 *    (`unknown`), never silently pruned;
 *  - a corrupt record is refused, never replaced.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleRoutingError } from './errors';
import type { RankedServerRow, RoutingView } from './wire/settings-wire';

export const ROUTING_FILE = 'crucible-routing.json';

export interface RoutingRecord {
  order: string[];
  disabled: string[];
}

export class Routing {
  constructor(readonly file: string) {}

  read(): RoutingRecord {
    if (!fs.existsSync(this.file)) return { order: [], disabled: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch (err) {
      throw new CrucibleRoutingError(
        'corrupt_routing',
        `${this.file} is not valid JSON (${(err as Error).message}). It records which Crucible servers `
          + 'the queue may use and in what order, so nothing here will replace it. Repair or delete it by hand.',
      );
    }
    const record = parsed as Partial<RoutingRecord> | null;
    for (const key of ['order', 'disabled'] as const) {
      const value = record?.[key];
      if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || name === '')) {
        throw new CrucibleRoutingError('corrupt_routing', `${this.file}: "${key}" must be an array of server names. Repair or delete it by hand.`);
      }
    }
    return { order: [...(record!.order as string[])], disabled: [...(record!.disabled as string[])] };
  }

  private write(record: RoutingRecord): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, this.file);
  }

  /** The record resolved against the servers that exist, best first. */
  view(known: readonly string[]): RoutingView {
    const record = this.read();
    const knownSet = new Set(known);
    const disabled = new Set(record.disabled);
    const ranked: RankedServerRow[] = [];
    const seen = new Set<string>();
    for (const name of [...record.order, ...known]) {
      if (!knownSet.has(name) || seen.has(name)) continue;
      seen.add(name);
      ranked.push({ name, enabled: !disabled.has(name) });
    }
    const mentioned = new Set([...record.order, ...record.disabled]);
    return { ranked, unknown: [...mentioned].filter((name) => !knownSet.has(name)) };
  }

  /**
   * Re-rank. `next` is the whole visible list, best first. A drag reorders a
   * list; it does not add or drop a row, so an order that omits a known server
   * or names an unknown one is refused. Names kept for removed servers stay at
   * the end.
   */
  setOrder(next: readonly string[], known: readonly string[]): RoutingView {
    const seen = new Set<string>();
    for (const name of next) {
      if (seen.has(name)) throw new CrucibleRoutingError('duplicate_in_order', `"${name}" appears twice in the new order.`);
      seen.add(name);
      if (!known.includes(name)) throw this.unknown(name, known);
    }
    const missing = known.filter((name) => !seen.has(name));
    if (missing.length > 0) {
      throw new CrucibleRoutingError(
        'incomplete_order',
        `The new order does not name ${missing.join(', ')}. A re-rank carries the whole list.`,
      );
    }
    const record = this.read();
    const kept = record.order.filter((name) => !known.includes(name) && !seen.has(name));
    this.write({ ...record, order: [...next, ...kept] });
    return this.view(known);
  }

  /** Running (true) or Paused (false). */
  setEnabled(name: string, enabled: boolean, known: readonly string[]): RoutingView {
    if (!known.includes(name)) throw this.unknown(name, known);
    const record = this.read();
    const disabled = record.disabled.filter((entry) => entry !== name);
    if (!enabled) disabled.push(name);
    this.write({ ...record, disabled });
    return this.view(known);
  }

  /** Drop a name the record mentions that no server answers to. Refuses a known name. */
  forget(name: string, known: readonly string[]): RoutingView {
    if (known.includes(name)) {
      throw new CrucibleRoutingError(
        'server_is_known',
        `"${name}" is one of this machine's Crucible servers. Pause it, or remove it from the list.`,
      );
    }
    const record = this.read();
    this.write({
      order: record.order.filter((entry) => entry !== name),
      disabled: record.disabled.filter((entry) => entry !== name),
    });
    return this.view(known);
  }

  /** The servers the queue may use, best first. Refuses by name when there are none. */
  ranked(known: readonly string[]): RankedServerRow[] {
    const { ranked } = this.view(known);
    const enabled = ranked.filter((row) => row.enabled);
    if (enabled.length === 0) {
      throw new CrucibleRoutingError(
        'no_enabled_server',
        ranked.length === 0
          ? 'No Crucible server is connected. Add one in Settings › Crucible Servers.'
          : `Every Crucible server is paused (${ranked.map((row) => row.name).join(', ')}). `
            + 'Set one to Running in Settings › Crucible Servers.',
      );
    }
    return enabled;
  }

  private unknown(name: string, known: readonly string[]): CrucibleRoutingError {
    return new CrucibleRoutingError(
      'unknown_server',
      `"${name}" is not one of this machine's Crucible servers (${known.length === 0 ? 'there are none' : `known: ${known.join(', ')}`}).`,
    );
  }
}
