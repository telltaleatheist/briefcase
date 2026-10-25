import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { HttpException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CrucibleBusyError, CrucibleChatCancelled } from '../crucible/llm/errors';

/**
 * Ask end to end on a real library database: threads, a question answered
 * through a scripted chat, its markers proposed then applied into
 * custom_markers under a set, and the answer written to the library the
 * question was asked in. The model is a fake CrucibleChatService.
 *
 * Needs a better-sqlite3 built for this Node (see ranker-migration.spec.ts);
 * without one the suite skips. It runs under Electron's Node:
 *   ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron node_modules/jest/bin/jest.js src/video-chat
 */
let Database: any = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  Database = null;
}
const suite = Database ? describe : describe.skip;

const SRT = [
  '1\n00:00:00,000 --> 00:00:04,000\nWelcome back to the show, everybody.',
  '2\n00:00:04,000 --> 00:00:09,000\nToday we start with the budget fight in Congress.',
  '3\n00:10:00,000 --> 00:10:06,000\nThen Trump posted about the ruling late last night.',
  '4\n00:10:06,000 --> 00:10:12,000\nHe called the judges a disgrace to the country.',
].join('\n\n');

const trumpCall = `<tool_use>\n${JSON.stringify({ name: 'add_marker', arguments: { title: 'Trump on the ruling', first_words: 'Then Trump posted about the ruling', last_words: 'a disgrace to the country', note: 'He attacks the judges.' } })}\n</tool_use>`;

suite('VideoChatService on a library database', () => {
  let dir = '';
  beforeAll(() => Logger.overrideLogger(false));
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setup(replies: Array<string | Error | ((req: any) => string)> = [], chatExtras: Record<string, unknown> = {}) {
    const { DatabaseService } = await import('../database/database.service');
    const { VideoChatService } = await import('./video-chat.service');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-ask-'));
    const database = new DatabaseService({ setLibraryPath: () => undefined } as any);
    const libraryPath = path.join(dir, 'library.db');
    database.initializeDatabase(libraryPath);
    database.insertVideo({ id: 'v1', filename: 'budget night.mp4', fileHash: 'h1', currentPath: path.join(dir, 'v1.mp4') });
    database.insertVideo({ id: 'v2', filename: 'silent.mp4', fileHash: 'h2', currentPath: path.join(dir, 'v2.mp4') });
    database.insertTranscript({ videoId: 'v1', plainText: '', srtFormat: SRT });
    const requests: any[] = [];
    const chat = {
      async chat(req: any) {
        requests.push(req);
        const next = replies[requests.length - 1];
        if (next === undefined) throw new Error(`no reply ${requests.length}`);
        if (next instanceof Error) throw next;
        return { text: typeof next === 'function' ? next(req) : next, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, finishReason: 'stop' };
      },
      ...chatExtras,
    };
    const phases: string[] = [];
    const service = new VideoChatService(
      database,
      chat as any,
      { assertReadyNow: () => undefined } as any,
      { emitVideoChatStatus: (p: { phase: string }) => phases.push(p.phase) } as any,
    );
    return { database, service, requests, phases, libraryPath };
  }

  const refusal = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      return { status: (error as HttpException).getStatus(), ...((error as HttpException).getResponse() as { code: string; message: string }) };
    }
    throw new Error('expected a refusal');
  };

  it('threads: created, named by the first question, listed newest first, read back, deleted', async () => {
    const { service } = await setup(['An answer.', 'Another.']);
    const a = service.createThread('v1', 'claude:claude-sonnet-4-5');
    expect(a).toMatchObject({ videoId: 'v1', title: '', model: 'claude:claude-sonnet-4-5' });
    const b = service.createThread('v1', null);
    await service.ask(b.id, 'What is this video about, in one long sentence that goes on and on and on?', 'claude:claude-sonnet-4-5');
    await new Promise((r) => setTimeout(r, 5));
    await service.ask(a.id, 'Budget?', 'claude:claude-sonnet-4-5');
    expect(service.listThreads('v1').map((t) => t.id)).toEqual([a.id, b.id]);
    expect(service.getThread(b.id).thread.title).toBe('What is this video about, in one long sentence that goes on…');
    expect(service.listThreads('v2')).toEqual([]);
    expect(service.deleteThread(a.id)).toEqual({ ok: true });
    expect(service.listThreads('v1').map((t) => t.id)).toEqual([b.id]);
    expect((await refusal(Promise.resolve().then(() => service.getThread(a.id)))).code).toBe('thread_not_found');
  });

  it('a question: the answer, its markers proposed, and the trace replayed in the next question', async () => {
    const { service, requests, phases } = await setup([`Yes, there is. ${trumpCall}`, 'Yes: "Trump on the ruling".', 'It was late last night.']);
    const thread = service.createThread('v1', null);
    const sent = await service.ask(thread.id, 'Is there a section about Trump?', 'claude:claude-sonnet-4-5');
    expect(sent.userMessage).toMatchObject({ role: 'user', content: 'Is there a section about Trump?', markers: [] });
    expect(sent.assistantMessage).toMatchObject({ role: 'assistant', content: 'Yes, there is.\n\nYes: "Trump on the ruling".', model: 'claude:claude-sonnet-4-5' });
    expect(sent.assistantMessage.markers).toEqual([
      expect.objectContaining({ title: 'Trump on the ruling', note: 'He attacks the judges.', startSeconds: 600, endSeconds: 612, status: 'proposed', customMarkerId: null, messageId: sent.assistantMessage.id }),
    ]);
    expect(phases).toEqual(['thinking', 'placing-markers', 'thinking', 'done']);
    // The model string crosses as the stored choice; no response_format, no temperature decision here (target.ts makes it).
    expect(requests[0]).toMatchObject({ provider: 'claude', model: 'claude-sonnet-4-5' });
    expect(requests[0].responseFormat).toBeUndefined();
    expect(requests[0].messages[0].content).not.toMatch(/\d{2}:\d{2}:\d{2}/);

    await service.ask(thread.id, 'When was that posted?', 'claude:claude-sonnet-4-5');
    const third = requests[2].messages.map((m: any) => [m.role, m.content]);
    expect(third.slice(1)).toEqual([
      ['user', 'Is there a section about Trump?'],
      ['assistant', `Yes, there is. ${trumpCall}`],
      ['user', '<tool_result>\nplaced "Trump on the ruling" at 00:10:00–00:10:12\n</tool_result>'],
      ['assistant', 'Yes: "Trump on the ruling".'],
      ['user', 'When was that posted?'],
    ]);
    expect(service.getThread(thread.id).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('a failure keeps the question, refuses by code, and the unanswered question is not replayed', async () => {
    const { service, requests, phases } = await setup([new CrucibleBusyError('mac', 'another app holds the card'), 'Fine now.']);
    const thread = service.createThread('v1', null);
    const busy = await refusal(service.ask(thread.id, 'First?', 'claude:claude-sonnet-4-5'));
    expect(busy).toMatchObject({ status: 503, code: 'crucible_busy' });
    expect(phases).toEqual(['thinking', 'error']);
    expect(service.getThread(thread.id).messages.map((m) => [m.role, m.content])).toEqual([['user', 'First?']]);
    await service.ask(thread.id, 'Second?', 'claude:claude-sonnet-4-5');
    expect(requests[1].messages.slice(1).map((m: any) => m.content)).toEqual(['Second?']);
  });

  it('no transcript: 422 no_transcript, the question kept', async () => {
    const { service } = await setup();
    const thread = service.createThread('v2', null);
    expect(await refusal(service.ask(thread.id, 'Anything?', 'claude:claude-sonnet-4-5'))).toMatchObject({ status: 422, code: 'no_transcript' });
    expect(service.getThread(thread.id).messages).toHaveLength(1);
  });

  it('a transcript larger than a local model\'s context: 422 transcript_too_long naming the model, nothing sent', async () => {
    const local = { target: { model: 'qwen3.5-9b', route: 'local', upstream: null, bareModel: 'qwen3.5-9b' }, server: null, mappedFrom: null };
    const { service, requests } = await setup([], {
      effectiveTarget: async () => local,
      venueFor: async () => 'mac',
      otherRunsOn: () => [],
      withRun: (fn: () => Promise<unknown>) => fn(),
      statedLocalContext: async () => ({ tokens: 2048 }),
      // A server that states no maximum: the context it loads at is the limit.
      maxLocalContext: async () => null,
    });
    const thread = service.createThread('v1', null);
    const tooLong = await refusal(service.ask(thread.id, 'Summarise?', 'local:qwen3.5-9b'));
    expect(tooLong).toMatchObject({ status: 422, code: 'transcript_too_long' });
    expect(tooLong.message).toContain('local:qwen3.5-9b');
    expect(tooLong.message).toContain('(2,048)');
    expect(requests).toHaveLength(0);
  });

  /** A local model in a run of its own: what withModel was asked to load it at, and what each chat carried. */
  function localModel(stated: number, max: number | null, extras: Record<string, unknown> = {}) {
    const local = { target: { model: 'qwen3.8-27b-8bit', route: 'local', upstream: null, bareModel: 'qwen3.8-27b-8bit' }, server: null, mappedFrom: null };
    const held: Array<{ loadContext?: number }> = [];
    const askedMax: string[] = [];
    return {
      held,
      askedMax,
      extras: {
        effectiveTarget: async () => local,
        venueFor: async () => 'mac',
        otherRunsOn: () => [],
        withRun: (fn: () => Promise<unknown>) => fn(),
        withModel: (_server: unknown, _model: string, fn: () => Promise<unknown>, options: { loadContext?: number }) => {
          held.push({ loadContext: options.loadContext });
          return fn();
        },
        statedLocalContext: async () => ({ tokens: stated }),
        maxLocalContext: async (_server: string, model: string) => { askedMax.push(model); return max; },
        modelsOn: async () => [{ id: 'qwen3.8-27b-8bit', resident: false, maxModelLen: stated }],
        ...extras,
      },
    };
  }

  it('a need that fits the context the model loads at: no reload, its maximum not even asked', async () => {
    const model = localModel(32768, 131072);
    const { service, requests, phases } = await setup(['There.'], model.extras);
    const thread = service.createThread('v1', null);
    await service.ask(thread.id, 'Budget?', 'local:qwen3.8-27b-8bit');
    expect(model.held).toEqual([{ loadContext: undefined }]);
    expect(requests[0].loadContext).toBeUndefined();
    expect(model.askedMax).toEqual([]);
    expect(phases).toEqual(['loading-model', 'thinking', 'done']);
  });

  it('a need over the loaded context but under the model\'s maximum: loaded bigger in the run, with room for follow-ups', async () => {
    const model = localModel(2048, 131072);
    const { service, requests, phases } = await setup(['There.'], model.extras);
    const thread = service.createThread('v1', null);
    await service.ask(thread.id, 'Budget?', 'local:qwen3.8-27b-8bit');
    const loadContext = model.held[0].loadContext!;
    // The need here is about 6-7K tokens (a short transcript, the reserves): +8K, in steps of 4096.
    expect(loadContext).toBe(16384);
    expect(requests[0].loadContext).toBe(loadContext);
    expect(model.askedMax).toEqual(['qwen3.8-27b-8bit']);
    expect(phases[0]).toBe('loading-model');
  });

  it('a need over the model\'s maximum: 422 naming that maximum, suggesting a cloud model or a new conversation, nothing loaded', async () => {
    const model = localModel(2048, 4096);
    const { service, requests } = await setup([], model.extras);
    const thread = service.createThread('v1', null);
    const tooLong = await refusal(service.ask(thread.id, 'Summarise?', 'local:qwen3.8-27b-8bit'));
    expect(tooLong).toMatchObject({ status: 422, code: 'transcript_too_long' });
    expect(tooLong.message).toMatch(/more than local:qwen3\.8-27b-8bit can take at most \(4,096\)\. Pick a cloud model, or start a new conversation\./);
    expect(model.held).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('a model already resident at a context that holds the need: used as it is, no reload', async () => {
    const model = localModel(2048, 131072, { modelsOn: async () => [{ id: 'qwen3.8-27b-8bit', resident: true, maxModelLen: 49152 }] });
    const { service, requests } = await setup(['There.'], model.extras);
    const thread = service.createThread('v1', null);
    await service.ask(thread.id, 'Budget?', 'local:qwen3.8-27b-8bit');
    expect(model.held).toEqual([{ loadContext: 49152 }]);
    expect(requests[0].loadContext).toBe(49152);
  });

  it('chatLoadContext: the need plus a quarter (at least 8K), in steps of 4096, never past the maximum', async () => {
    const { chatLoadContext } = await import('./video-chat.service');
    expect(chatLoadContext(37513, 131072)).toBe(49152);
    expect(chatLoadContext(6000, 131072)).toBe(16384);
    expect(chatLoadContext(120000, 131072)).toBe(131072);
  });

  it('Stop: the answer in flight is aborted, its request refused 499 cancelled, and the thread is as it was before the question', async () => {
    let seen: AbortSignal | undefined;
    const { service } = await setup(['Fine.'], {
      async chat(req: { signal?: AbortSignal }) {
        seen = req.signal;
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new CrucibleChatCancelled()), { once: true });
        });
      },
    });
    const thread = service.createThread('v1', 'claude:claude-sonnet-4-5');
    const before = service.getThread(thread.id).thread;
    const asked = refusal(service.ask(thread.id, 'What about the budget?', 'claude:claude-sonnet-4-5'));
    await new Promise((r) => setTimeout(r, 5));
    expect(service.getThread(thread.id).messages).toHaveLength(1);
    expect(await service.cancel(thread.id)).toEqual({ ok: true });
    expect(seen?.aborted).toBe(true);
    expect(await asked).toMatchObject({ status: 499, code: 'cancelled' });
    expect(service.getThread(thread.id)).toEqual({ thread: before, messages: [] });
    // Nothing in flight: a no-op.
    expect(await service.cancel(thread.id)).toEqual({ ok: true });
  });

  it('Stop releases the thread: the next question is answered, with nothing of the stopped one replayed', async () => {
    let calls = 0;
    const sent: any[] = [];
    const { service } = await setup([], {
      async chat(req: any) {
        sent.push(req);
        if ((calls += 1) === 1) {
          return new Promise((_resolve, reject) => {
            req.signal?.addEventListener('abort', () => reject(new CrucibleChatCancelled()), { once: true });
          });
        }
        return { text: 'Answered.', usage: null, finishReason: 'stop' };
      },
    });
    const thread = service.createThread('v1', null);
    const stopped = refusal(service.ask(thread.id, 'First?', 'claude:claude-sonnet-4-5'));
    await new Promise((r) => setTimeout(r, 5));
    await service.cancel(thread.id);
    await stopped;
    await service.ask(thread.id, 'Second?', 'claude:claude-sonnet-4-5');
    expect(sent[1].messages.slice(1).map((m: any) => m.content)).toEqual(['Second?']);
    expect(service.getThread(thread.id).messages.map((m) => m.content)).toEqual(['Second?', 'Answered.']);
    expect(service.getThread(thread.id).thread.title).toBe('Second?');
  });

  it('a local model on a server another Briefcase run holds with a different model: 503 crucible_busy, nothing loaded', async () => {
    const local = { target: { model: 'qwen3.5-9b', route: 'local', upstream: null, bareModel: 'qwen3.5-9b' }, server: null, mappedFrom: null };
    let ran = false;
    const { service } = await setup([], {
      effectiveTarget: async () => local,
      venueFor: async () => 'mac',
      otherRunsOn: () => [{ model: 'qwen3.6-27b' }],
      withRun: async () => { ran = true; },
    });
    const thread = service.createThread('v1', null);
    const busy = await refusal(service.ask(thread.id, 'Where is the budget?', 'local:qwen3.5-9b'));
    expect(busy).toMatchObject({ status: 503, code: 'crucible_busy' });
    expect(busy.message).toContain('qwen3.6-27b');
    expect(ran).toBe(false);
  });

  it('one answer at a time per thread: a second send while answering is 409 thread_busy', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = await setup([], {
      async chat() {
        await gate;
        return { text: 'Done.', usage: null, finishReason: 'stop' };
      },
    });
    const thread = service.createThread('v1', null);
    const first = service.ask(thread.id, 'One?', 'claude:claude-sonnet-4-5');
    expect(await refusal(service.ask(thread.id, 'Two?', 'claude:claude-sonnet-4-5'))).toMatchObject({ status: 409, code: 'thread_busy' });
    release();
    await expect(first).resolves.toMatchObject({ assistantMessage: { content: 'Done.' } });
  });

  it('a library switched mid-answer: the answer is written to the library it was asked in', async () => {
    let switchTo: () => void = () => undefined;
    const { service, database, libraryPath } = await setup([() => { switchTo(); return 'Answered.'; }]);
    const other = path.join(dir, 'other.db');
    switchTo = () => database.initializeDatabase(other);
    const thread = service.createThread('v1', null);
    await service.ask(thread.id, 'Hello?', 'claude:claude-sonnet-4-5');
    expect(database.getCurrentDbPath()).toBe(other);
    const count = (file: string) => {
      const db = new Database(file, { readonly: true });
      try {
        return db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'assistant'").get().n;
      } finally {
        db.close();
      }
    };
    expect(count(libraryPath)).toBe(1);
    expect(count(other)).toBe(0);
  });

  it('apply: proposals become custom markers in the named set, marked applied; dismissing and its limits', async () => {
    const { service, database } = await setup([`${trumpCall}`, 'There.']);
    const thread = service.createThread('v1', null);
    const { assistantMessage } = await service.ask(thread.id, 'Trump?', 'claude:claude-sonnet-4-5');
    const markerId = assistantMessage.markers[0].id;

    expect(service.setMarkerStatus(markerId, 'dismissed').status).toBe('dismissed');
    expect(service.setMarkerStatus(markerId, 'proposed').status).toBe('proposed');

    const applied = service.apply(thread.id, [markerId], '  Trump moments ');
    expect(applied.markers).toEqual([expect.objectContaining({ id: markerId, status: 'applied', customMarkerId: expect.any(String) })]);
    expect(applied.customMarkers).toEqual([
      expect.objectContaining({
        id: applied.markers[0].customMarkerId, video_id: 'v1', start_seconds: 600, end_seconds: 612,
        timestamp_text: '00:10:00 - 00:10:12', title: 'Trump on the ruling', description: 'He attacks the judges.',
        category: 'custom', marker_set: 'Trump moments',
      }),
    ]);
    // Applying again keeps the one custom marker.
    expect(service.apply(thread.id, [markerId], 'Again').markers[0].customMarkerId).toBe(applied.markers[0].customMarkerId);
    expect(database.getCustomMarkers('v1')).toHaveLength(1);

    expect(await refusal(Promise.resolve().then(() => service.setMarkerStatus(markerId, 'dismissed')))).toMatchObject({ status: 409, code: 'marker_applied' });
    expect(await refusal(Promise.resolve().then(() => service.apply(thread.id, ['nope'], 'Set')))).toMatchObject({ status: 404, code: 'marker_not_found' });
    expect(await refusal(Promise.resolve().then(() => service.apply(thread.id, [markerId], ' ')))).toMatchObject({ status: 400 });

    // Deleting the conversation leaves the applied custom marker.
    service.deleteThread(thread.id);
    expect(database.getCustomMarkers('v1')).toHaveLength(1);
  });

  it('migration 31: a library from before marker_set gets the column on open; hand-made markers have none', async () => {
    const { database, libraryPath } = await setup();
    database.closeDatabase();
    const raw = new Database(libraryPath);
    raw.exec('ALTER TABLE custom_markers DROP COLUMN marker_set');
    raw.close();
    database.initializeDatabase(libraryPath);
    database.insertCustomMarker({ id: 'm1', videoId: 'v1', startSeconds: 1, endSeconds: 2, title: 'By hand' });
    expect(database.getCustomMarkers('v1')).toEqual([expect.objectContaining({ id: 'm1', marker_set: null })]);
  });
});
