/** decideVenue: the selected server only, wait vs fail, never "who is free now", never another server. */
import { decideVenue, type VenueHost } from '../../src/crucible/venue-decision';
import { crucibleTargetOf } from '../../src/crucible/llm/target';
import type { ServerReach } from '../../src/crucible/wire/settings-wire';

function host(selected: [string, ServerReach, boolean] | string): VenueHost & { reached: string[] } {
  const reached: string[] = [];
  return {
    reached,
    selected: () => {
      if (typeof selected === 'string') throw new Error(selected);
      return selected[0];
    },
    reach: async (name) => {
      reached.push(name);
      return { reach: (selected as [string, ServerReach, boolean])[1] };
    },
    canServe: async () => (selected as [string, ServerReach, boolean])[2],
  };
}

const LOCAL = crucibleTargetOf('local', 'qwen3.5-9b');
const CLAUDE = crucibleTargetOf('claude', 'claude-sonnet-5');

describe('decideVenue', () => {
  it('takes the selected server when it answers; busy is still the venue (the task waits for it there)', async () => {
    const h = host(['pc', 'busy', true]);
    expect(await decideVenue(LOCAL, h)).toEqual({ kind: 'venue', server: 'pc' });
    expect(h.reached).toEqual(['pc']);
  });

  it('a local model it has not installed still goes to it, so its refusal names the fix', async () => {
    expect(await decideVenue(LOCAL, host(['mac', 'ready', false]))).toEqual({ kind: 'venue', server: 'mac' });
  });

  it('an upstream the selected server has not set up is a wait with the settings pointer', async () => {
    const answer = await decideVenue(CLAUDE, host(['mac', 'ready', false]));
    expect(answer).toEqual({ kind: 'wait', reason: 'Claude is not set up on mac. Add it in Settings › AI Analysis.' });
  });

  it('the selected server not answering is a wait naming it (never another server)', async () => {
    expect(await decideVenue(LOCAL, host(['mac', 'unreachable', true]))).toEqual({ kind: 'wait', reason: "Crucible on mac isn't answering." });
  });

  it('nothing selected is a wait in routing’s own words', async () => {
    expect(await decideVenue(LOCAL, host('No Crucible server is selected. Select one in Settings › Crucible Servers.')))
      .toEqual({ kind: 'wait', reason: 'No Crucible server is selected. Select one in Settings › Crucible Servers.' });
  });

  it('the selected server refusing this computer is a failure, not a wait', async () => {
    expect(await decideVenue(LOCAL, host(['mac', 'bad_token', true])))
      .toMatchObject({ kind: 'fail', reason: expect.stringMatching(/The selected Crucible server won't take work from this computer/) });
  });
});
