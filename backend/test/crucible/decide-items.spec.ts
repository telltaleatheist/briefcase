/**
 * THE ITEMS FORM (Crucible 1.0.55+), against the fake: a decide of choice
 * questions goes as one items request (one engine call on the Mac), answered
 * exactly as the questions form would answer it; anything else, or an older
 * server, goes as the questions form.
 */
import { Logger } from '@nestjs/common';
import { CrucibleServersService } from '../../src/crucible/crucible-servers.service';
import { CrucibleChatService } from '../../src/crucible/llm/crucible-chat.service';
import { CrucibleScorerService } from '../../src/scorer/crucible-scorer.service';
import type { ChoiceQuestion, DecideRequest } from '../../src/scorer/scorer.types';
import { startFakeCrucible, type FakeCrucible, type FakeCrucibleOptions } from '../fake-crucible/fake-crucible';
import { harness } from './harness';

Logger.overrideLogger(false);

const open: FakeCrucible[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

async function rig(options: FakeCrucibleOptions = {}) {
  const fake = await startFakeCrucible({
    models: [{ id: 'qwen3.5-9b', paramsB: 9, contextDefault: 32768, maxModelLen: 32768 }],
    // A distribution that depends on the question, so a mixed-up answer order shows.
    decideProbs: (q) => Object.fromEntries(q.labels.map((l, i) => [l, q.instructions.includes(`about ${l}`) ? 0.8 : 0.2 / (q.labels.length - 1) + i * 0.001])),
    ...options,
  });
  open.push(fake);
  const h = harness();
  h.registry.add({ name: 'mac', url: fake.url, token: fake.token });
  const servers = new CrucibleServersService(h.registry, h.factory);
  const chat = new CrucibleChatService(servers, h.factory, h.probes);
  chat.heartbeatMs = 40;
  return { fake, chat, scorer: new CrucibleScorerService(chat, servers) };
}

const choice = (name: string, about: string, options = ['cooking', 'travel', 'none']): ChoiceQuestion => ({
  type: 'choice', name, instructions: `Passage from the transcript above: "talk about ${about}"\nWhich section?`,
  options: options.map((o) => ({ name: o, description: o })),
});

const ask: DecideRequest = { state: 'The whole chunk.', questions: [choice('s0', 'travel'), choice('s1', 'cooking'), choice('s2', 'none')], missingLabels: 'floor' };

describe('the items form', () => {
  it('a 1.0.55+ server gets a decide of choice questions as items, and answers match the questions form', async () => {
    const items = await rig({ version: '1.0.74' });
    const byItems = await items.chat.withRun(() => items.scorer.withScorer((sh) => sh.decide(ask)));
    const sent = items.fake.requestsTo('/v1/decide', 'POST').map((r) => r.body as Record<string, unknown>);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      state: 'The whole chunk.',
      options: { cooking: 'cooking', travel: 'travel', none: 'none' },
      items: ask.questions.map((q) => ({ text: q.instructions })),
      missing: 'report',
    });
    expect(sent[0]).not.toHaveProperty('questions');
    expect(byItems.timingMs.engineRequests).toBe(1);
    expect(byItems.tokens.shared).toBe(100);

    const questions = await rig({ version: '1.0.54' });
    const byQuestions = await questions.chat.withRun(() => questions.scorer.withScorer((sh) => sh.decide(ask)));
    expect(questions.fake.requestsTo('/v1/decide', 'POST')[0].body).toHaveProperty('questions');
    for (const q of ask.questions) {
      expect(byItems.answers[q.name]).toMatchObject({ type: 'choice', choice: byQuestions.answers[q.name].type === 'choice' ? (byQuestions.answers[q.name] as { choice: string }).choice : '' });
      expect((byItems.answers[q.name] as { logProbs: number[] }).logProbs).toEqual((byQuestions.answers[q.name] as { logProbs: number[] }).logProbs);
    }
    expect(byItems.answers['s0']).toMatchObject({ choice: 'travel' });
    expect(byItems.answers['s1']).toMatchObject({ choice: 'cooking' });
  });

  it('options that differ go on their own items', async () => {
    const { fake, chat, scorer } = await rig({ version: '1.0.74' });
    await chat.withRun(() => scorer.withScorer((sh) => sh.decide({
      state: 's', questions: [choice('a', 'travel'), choice('b', 'cooking', ['cooking', 'news'])], missingLabels: 'floor',
    })));
    const body = fake.requestsTo('/v1/decide', 'POST')[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty('options');
    expect(body['items']).toEqual([
      expect.objectContaining({ options: { cooking: 'cooking', travel: 'travel', none: 'none' } }),
      expect.objectContaining({ options: { cooking: 'cooking', news: 'news' } }),
    ]);
  });

  it('a lone question, or one that is not a choice, goes as the questions form', async () => {
    const { fake, chat, scorer } = await rig({ version: '1.0.74' });
    await chat.withRun(() => scorer.withScorer(async (sh) => {
      await sh.decide({ state: 's', questions: [choice('a', 'travel')], missingLabels: 'floor' });
      await sh.decide({ state: 's', questions: [choice('a', 'travel'), { type: 'yesno', name: 'ad', instructions: 'An ad?' }], missingLabels: 'floor' });
    }));
    expect(fake.requestsTo('/v1/decide', 'POST').map((r) => 'questions' in (r.body as object))).toEqual([true, true]);
  });
});
