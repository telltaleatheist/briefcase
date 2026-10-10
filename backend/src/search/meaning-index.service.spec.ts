import { beforeAll, describe, expect, it } from '@jest/globals';
import { Logger } from '@nestjs/common';
import Database = require('better-sqlite3');

import type { DatabaseService } from '../database/database.service';
import { DIMENSIONS, type EmbeddingModelService } from './embeddings/embedding-model.service';
import { MeaningIndexService } from './meaning-index.service';
import { pendingMeaningVideos } from './meaning-search';
import { ensureMomentSchema, indexVideoMoments } from './transcript-moments';

const srt = (lines: string[]) => lines.map((t, i) => `${i + 1}\n00:00:${String(i * 5).padStart(2, '0')},000 --> 00:00:${String(i * 5 + 5).padStart(2, '0')},000\n${t}\n`).join('\n');

function library() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE videos (id TEXT PRIMARY KEY, added_at TEXT)');
  ensureMomentSchema(db);
  const add = (id: string, at: string) => {
    db.prepare('INSERT INTO videos (id, added_at) VALUES (?, ?)').run(id, at);
    indexVideoMoments(db, id, srt(['One two three four five six seven.', 'Eight nine ten eleven twelve thirteen.']), 'x');
  };
  return { db, add };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('MeaningIndexService', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('indexes every transcript without vectors when told, newest first, and again for one saved later', async () => {
    const { db, add } = library();
    add('old', '2026-01-01');
    add('new', '2026-10-01');
    let listener: () => void = () => undefined;
    const database = { getDatabase: () => db, onTranscriptsIndexed: (fn: () => void) => ((listener = fn), () => undefined) } as unknown as DatabaseService;
    const order: string[][] = [];
    const model = {
      embed: async (texts: string[]) => {
        order.push(texts);
        return texts.map(() => Object.assign(new Float32Array(DIMENSIONS), { 0: 1 }));
      },
    } as unknown as EmbeddingModelService;

    const service = new MeaningIndexService(database, model);
    service.onModuleInit();
    await settle();
    expect(pendingMeaningVideos(db, 10)).toEqual([]);
    expect(order).toHaveLength(2);

    add('later', '2026-10-05');
    listener();
    await settle();
    expect(pendingMeaningVideos(db, 10)).toEqual([]);
    expect(order).toHaveLength(3);
  });

  it('does nothing until a library is open', async () => {
    const database = { getDatabase: () => { throw new Error('Database not initialized'); }, onTranscriptsIndexed: () => () => undefined } as unknown as DatabaseService;
    const model = { embed: async () => { throw new Error('must not be called'); } } as unknown as EmbeddingModelService;
    const service = new MeaningIndexService(database, model);
    service.onModuleInit();
    await settle();
  });
});
