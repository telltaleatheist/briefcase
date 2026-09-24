/**
 * WHICH CRUCIBLE SERVER BRIEFCASE USES: exactly one, the one the user selected.
 *
 * The registry owns which servers exist; this owns the choice, as a second
 * file, so switching never rewrites a token:
 *
 *   <Briefcase config dir>/crucible-routing.json
 *   { "selected": "crucible@owens-mac-studio" }
 *
 * Every GPU and cloud job goes to the selected server. There is no ranking and
 * no hand-off: a busy server makes work wait for it, and an unreachable one
 * makes work wait with its reason. Work moves to another server only when the
 * user selects that server.
 *
 * The rules:
 *  - the first server added is selected when it is added; later ones are not;
 *  - no choice ever recorded (no file) and exactly one server registered:
 *    that one. Removing the selected server records "none", so the user
 *    chooses again: the remaining server is never picked for them;
 *  - a record written before selection existed (`{order, disabled}`, the
 *    ranked list) reads as its first running server; it is rewritten only
 *    when the user next selects;
 *  - a selected server the registry no longer has is REPORTED (`missing`),
 *    never swapped for another;
 *  - a corrupt record is refused, never replaced.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CrucibleRoutingError } from './errors';
import type { RoutingView } from './wire/settings-wire';

export const ROUTING_FILE = 'crucible-routing.json';

export interface RoutingRecord {
  selected: string | null;
}

export class Routing {
  constructor(readonly file: string) {}

  /** The recorded choice; `recorded` is false when no choice was ever written. */
  read(): RoutingRecord & { recorded: boolean } {
    if (!fs.existsSync(this.file)) return { selected: null, recorded: false };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch (err) {
      throw this.corrupt(`is not valid JSON (${(err as Error).message})`);
    }
    const record = parsed as Record<string, unknown> | null;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw this.corrupt('is not an object');
    if ('selected' in record) {
      const selected = record.selected;
      if (selected !== null && (typeof selected !== 'string' || selected === '')) throw this.corrupt('has a "selected" that is neither a server name nor null');
      return { selected: selected as string | null, recorded: true };
    }
    // The ranked record from before selection: its first running server.
    const order = record.order;
    const disabled = record.disabled ?? [];
    const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((name) => typeof name === 'string' && name !== '');
    if (!isNames(order) || !isNames(disabled)) throw this.corrupt('is neither {selected} nor the older {order, disabled}');
    const paused = new Set(disabled);
    return { selected: order.find((name) => !paused.has(name)) ?? null, recorded: false };
  }

  private write(record: RoutingRecord): void {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, this.file);
  }

  /** The choice resolved against the servers that exist. */
  view(known: readonly string[]): RoutingView {
    const record = this.read();
    let selected: string | null = null;
    let missing: string | null = null;
    if (record.selected !== null) {
      if (known.includes(record.selected)) selected = record.selected;
      else missing = record.selected;
    } else if (!record.recorded && known.length === 1) {
      selected = known[0]!;
    }
    return { servers: known.map((name) => ({ name, selected: name === selected })), selected, missing };
  }

  /** The user's choice. Refuses a name that is not registered. */
  select(name: string, known: readonly string[]): RoutingView {
    if (!known.includes(name)) {
      throw new CrucibleRoutingError(
        'unknown_server',
        `"${name}" is not one of this machine's Crucible servers (${known.length === 0 ? 'there are none' : `known: ${known.join(', ')}`}).`,
      );
    }
    this.write({ selected: name });
    return this.view(known);
  }

  /** A server was just added (`known` includes it): it is selected only when nothing was. */
  added(name: string, known: readonly string[]): void {
    const before = this.view(known.filter((entry) => entry !== name));
    if (before.selected === null && before.missing === null) this.write({ selected: name });
    else if (before.selected !== null && this.read().selected === null) this.write({ selected: before.selected });
  }

  /** A server was just removed: when it was the selection, nothing is selected (never another server). */
  removed(name: string): void {
    if (this.read().selected === name) this.write({ selected: null });
  }

  /** The server all work goes to. Refuses by name when there is none. */
  selectedServer(known: readonly string[]): string {
    const view = this.view(known);
    if (view.selected !== null) return view.selected;
    throw new CrucibleRoutingError(
      'no_selected_server',
      known.length === 0
        ? 'No Crucible server is connected. Add one in Settings › Crucible Servers.'
        : view.missing !== null
          ? `The selected Crucible server "${view.missing}" isn't connected any more. Select a server in Settings › Crucible Servers.`
          : 'No Crucible server is selected. Select one in Settings › Crucible Servers.',
    );
  }

  private corrupt(what: string): CrucibleRoutingError {
    return new CrucibleRoutingError(
      'corrupt_routing',
      `${this.file} ${what}. It records which Crucible server Briefcase uses, so nothing here will replace it. Repair or delete it by hand.`,
    );
  }
}
