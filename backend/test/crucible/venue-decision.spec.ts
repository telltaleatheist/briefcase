/** decideVenue: rank order among enabled servers, wait vs fail, never "who is free now". */
import { decideVenue, type VenueHost } from '../../src/crucible/venue-decision';
import { crucibleTargetOf } from '../../src/crucible/llm/target';
import type { ServerReach } from '../../src/crucible/wire/settings-wire';

function host(rows: Array<[string, ServerReach, boolean]>, enabledError?: string): VenueHost & { reached: string[] } {
  const reached: string[] = [];
  return {
    reached,
    enabled: () => {
      if (enabledError) throw new Error(enabledError);
      return rows.map(([name]) => ({ name, enabled: true }));
    },
    reach: async (name) => {
      reached.push(name);
      return { reach: rows.find((r) => r[0] === name)![1] };
    },
    canServe: async (name) => rows.find((r) => r[0] === name)![2],
  };
}

const LOCAL = crucibleTargetOf('local', 'qwen3.5-9b');
const CLAUDE = crucibleTargetOf('claude', 'claude-sonnet-5');

describe('decideVenue', () => {
  it('takes the first enabled server, in rank order, that answers and can serve; a busy server is still a venue', async () => {
    const h = host([['mac', 'unreachable', true], ['pc', 'busy', true], ['laptop', 'ready', true]]);
    expect(await decideVenue(LOCAL, h)).toEqual({ kind: 'venue', server: 'pc', because: 'can serve it' });
    expect(h.reached).toEqual(['mac', 'pc']);
  });

  it('a local model nobody has installed goes to the first that answers, so its refusal names the fix', async () => {
    expect(await decideVenue(LOCAL, host([['mac', 'ready', false], ['pc', 'ready', false]])))
      .toEqual({ kind: 'venue', server: 'mac', because: 'first that answered' });
  });

  it('an upstream no running server has configured is a wait with the settings pointer', async () => {
    const answer = await decideVenue(CLAUDE, host([['mac', 'ready', false]]));
    expect(answer).toEqual({ kind: 'wait', reason: expect.stringMatching(/No running Crucible server has Claude configured.*Settings › Crucible Servers/) });
  });

  it('nothing answering is a wait naming the servers', async () => {
    expect(await decideVenue(LOCAL, host([['mac', 'unreachable', true]]))).toEqual({ kind: 'wait', reason: "Crucible on mac isn't answering." });
  });

  it('every server paused (or none) is a wait in routing’s own words', async () => {
    expect(await decideVenue(LOCAL, host([], 'Every Crucible server is paused (mac).'))).toEqual({ kind: 'wait', reason: 'Every Crucible server is paused (mac).' });
  });

  it('every enabled server refusing this computer is a failure, not a wait', async () => {
    expect(await decideVenue(LOCAL, host([['mac', 'bad_token', true], ['pc', 'version_mismatch', true]])))
      .toMatchObject({ kind: 'fail', reason: expect.stringMatching(/No Crucible server will take work/) });
    // One asleep and one misconfigured is still a wait.
    expect((await decideVenue(LOCAL, host([['mac', 'bad_token', true], ['pc', 'unreachable', true]]))).kind).toBe('wait');
  });
});
