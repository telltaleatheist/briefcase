/**
 * A standalone scorer tool in miniature, for standalone-interrupt.spec.ts: the
 * harness flag-eval.ts and snap-smoke.ts use, a lease on the scorer model, and
 * a decide the server never answers. The spec sends it SIGINT.
 */
import { Logger } from '@nestjs/common';
import { crucibleServices, exitStandalone, interruptible } from '../../../src/scorer/live/crucible-standalone';

Logger.overrideLogger(false);

async function main(): Promise<number> {
  const services = crucibleServices(process.argv[2] ?? 'mac');
  const interrupt = interruptible(services);
  await services.chat.withRun(() => services.scorer.withScorer(async (h) => {
    console.log(`HELD ${services.chat.heldInRun().map((x) => x.leaseId).join(',')}`);
    // No signal of its own: the run's (the interrupt's) must still stop it.
    await h.decide({ state: 's', questions: [{ type: 'yesno', name: 'a', instructions: 'x' }] });
  }, interrupt.signal));
  return 0;
}

exitStandalone(main());
