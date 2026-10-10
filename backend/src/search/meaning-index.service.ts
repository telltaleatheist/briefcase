/**
 * MEANING INDEX: makes and stores meaning-search vectors as part of the
 * pipeline, not at search time (the user, 2026-10-10: "the embed data will be
 * indexed and saved to the sqlite db. we can probably run the verbs as part of
 * the transcribe or analysis pipeline").
 *
 * Whenever the library's transcript index may have new work (a library
 * opened, the background moment indexing finished, a transcript was saved:
 * DatabaseService.onTranscriptsIndexed), one pass embeds every transcript
 * without current vectors, one video at a time, newest first. That is the
 * new transcript right after transcription, and once, the library's older
 * ones (the clips library: ~6,000 transcripts, roughly half an hour of CPU at
 * the model's half-the-cores setting).
 *
 * The embedding model is local (it fits on the CPU), so this runs whether or
 * not Crucible is up. A pass stops at a library switch (each video's vectors
 * are written only to the handle it began on) and after a failure (an
 * offline first run cannot fetch the model; the next notice tries again).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Database } from 'better-sqlite3';

import { DatabaseService } from '../database/database.service';
import { EmbeddingModelService } from './embeddings/embedding-model.service';
import { indexVideoMeaning, pendingMeaningVideos } from './meaning-search';

@Injectable()
export class MeaningIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeaningIndexService.name);
  private unsubscribe: (() => void) | null = null;
  private running = false;
  /** A notice arrived during a pass: run again when it ends. */
  private again = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly model: EmbeddingModelService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.database.onTranscriptsIndexed(() => this.wake());
    this.wake();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private wake(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.again = false;
    // Off the caller's turn: a transcript save must not wait on embedding.
    setImmediate(() => {
      this.pass()
        .catch((error) => this.logger.error(`[Search] Meaning indexing stopped: ${(error as Error).message}`))
        .finally(() => {
          this.running = false;
          if (this.again) this.wake();
        });
    });
  }

  /** Embed every pending transcript of the open library, one video at a time. */
  private async pass(): Promise<void> {
    let db: Database;
    try {
      db = this.database.getDatabase();
    } catch {
      return; // no library open yet; opening one notifies
    }
    let done = 0;
    let chunks = 0;
    const started = Date.now();
    const embed = (texts: string[], task: 'search_query' | 'search_document') => this.model.embed(texts, task);
    for (;;) {
      if (!db.open || this.currentDb() !== db) {
        if (done) this.logger.log(`[Search] Library changed; meaning indexing stopped after ${done} transcripts`);
        return;
      }
      const [videoId] = pendingMeaningVideos(db, 1);
      if (!videoId) break;
      if (done === 0) this.logger.log(`[Search] Indexing transcripts for meaning search`);
      const result = await indexVideoMeaning(db, videoId, embed);
      chunks += result.chunks;
      done++;
      if (done % 100 === 0) this.logger.log(`[Search] Meaning search: ${done} transcripts indexed so far`);
    }
    if (done) this.logger.log(`[Search] Meaning search: indexed ${done} transcripts (${chunks} chunks) in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }

  private currentDb(): Database | null {
    try {
      return this.database.getDatabase();
    } catch {
      return null;
    }
  }
}
