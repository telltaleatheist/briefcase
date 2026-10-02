/**
 * REGRESSION: quitting the app gives back the SCORER's lease, even one the
 * server grants while the quit is already under way.
 *
 * The quit path (graceful-shutdown.ts → app.close()) aborts every lane run
 * (QueueManagerService.onModuleDestroy → job.cancel-requested → the analysis
 * run's signal, which the scorer carries) and then sweeps the in-flight ledger
 * (CrucibleLanesService.beforeApplicationShutdown). The sweep read the ledger
 * once, at once, and nothing waited for the aborted runs to unwind: a scorer
 * lease the server granted after that read (a lease request already in
 * flight when the quit began) was released only by the run's own `finally`,
 * which the process exit right after app.close() did not wait for. The card
 * stayed held until the TTL ran out. Now the quit sweep first lets the
 * aborted runs unwind (bounded, inside the same deadline), then sweeps.
 */
import { CRUCIBLE_CLIENT_NAME } from '../../src/crucible/client-factory';
import { Logger } from '@nestjs/common';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { InFlightLedger } from '../../src/crucible/in-flight-ledger';
import { CrucibleTranscriptionService } from '../../src/crucible/asr/crucible-transcription.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleLanesService } from '../../src/queue/crucible-lanes';
import { CrucibleScorerService, SCORER_LOAD_CONTEXT } from '../../src/scorer/crucible-scorer.service';
import { startFakeCrucible, type FakeCrucible } from '../fake-crucible/fake-crucible';
import { harness } from '../crucible/harness';
import { tempDir } from '../crucible/helpers';
import { until } from './queue-rig';

Logger.overrideLogger(false);

const savedEnv = { ...process.env };
let fake: FakeCrucible;

beforeEach(async () => {
  process.env = { ...savedEnv, APPDATA: tempDir('quit-appdata-') };
  fake = await startFakeCrucible({
    models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: SCORER_LOAD_CONTEXT, maxModelLen: SCORER_LOAD_CONTEXT }],
    resident: 'qwen3.5-9b',
  });
});
afterEach(async () => {
  process.env = savedEnv;
  await fake.close();
});

function wire() {
  const h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  const ledger = InFlightLedger.inDir(h.dir, () => undefined);
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes, ledger);
  const transcription = new CrucibleTranscriptionService(servers, h.probes, h.factory, ledger);
  const lanes = new CrucibleLanesService(servers, h.probes, chat, h.factory, h.registry, transcription, ledger);
  lanes.sweepTiming = { confirmForMs: 200, pollEveryMs: 20 };
  const scorer = new CrucibleScorerService(chat, servers);
  return { chat, lanes, scorer, ledger };
}

describe('REGRESSION: the quit path closes the scorer\'s session', () => {
  it('a scorer mid-decide at quit: aborted, and its session closed before the quit returns', async () => {
    const { chat, lanes, scorer, ledger } = wire();
    (fake.faults.connectDelay ??= []).push({ match: { path: '/v1/decide' }, ms: 60_000 });
    const analysis = new AbortController();
    const run = chat.withRun(() => scorer.withScorer((h) => h.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] }, { signal: analysis.signal }), analysis.signal));
    run.catch(() => undefined);
    await until(() => fake.requestsTo('/v1/decide').length > 0);
    expect(fake.openSession()).toMatchObject({ client: CRUCIBLE_CLIENT_NAME });
    expect(fake.resident()).toBe('qwen3.5-9b');

    analysis.abort(); // onModuleDestroy's job.cancel-requested
    await lanes.beforeApplicationShutdown();
    // process.exit follows app.close() at once: whatever is open now stays open until it idles out.
    expect(fake.openSession()).toBeNull();
    expect(ledger.read()).toEqual([]);
  });

  it('a scorer session that opens AFTER the quit began is closed before the quit returns', async () => {
    const { chat, lanes, scorer, ledger } = wire();
    // The session open is in flight when the quit begins; the server opens it a moment later.
    (fake.faults.connectDelay ??= []).push({ match: { method: 'POST', path: '/v1/queue/sessions' }, ms: 300, thenDestroy: false, times: 1 });
    const analysis = new AbortController();
    const run = chat.withRun(() => scorer.withScorer((h) => h.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] }, { signal: analysis.signal }), analysis.signal));
    run.catch(() => undefined);
    await until(() => fake.requestsTo('/v1/queue/sessions', 'POST').length > 0);

    analysis.abort();
    await lanes.beforeApplicationShutdown();
    expect(fake.sessions.opened).toHaveLength(1);
    expect(fake.sessions.closed.map((x) => x.sessionId)).toEqual(fake.sessions.opened.map((x) => x.sessionId));
    expect(fake.openSession()).toBeNull();
    expect(ledger.read()).toEqual([]);
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });
});
