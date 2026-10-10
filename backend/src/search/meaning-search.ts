/**
 * MEANING SEARCH in one video's transcript: Scout's "expanded" search.
 *
 * Close-match search (close-match.ts) finds the words; this finds what was
 * MEANT, when the words differ ("the part where she says the protesters are
 * from the devil"). The transcript is cut into CHUNKS of about 10-20 s of
 * speech (single segments can be one-word fragments, too short to mean
 * anything), each turned into a vector by the embedding model
 * (embeddings/embedding-model.service.ts) once and kept in the library, so
 * the next search on that video only embeds what was typed.
 *
 * A video's vectors are dropped with its moment index when its transcript
 * changes (removeVideoMoments) and with the video (ON DELETE CASCADE).
 */
import type { Database } from 'better-sqlite3';

import { DIMENSIONS, EMBEDDING_MODEL_ID } from './embeddings/embedding-model.service';

/** What the stored vectors were made with: a change re-embeds. */
export const MEANING_MODEL_KEY = `${EMBEDDING_MODEL_ID}/${DIMENSIONS}`;

/** A chunk ends once it holds this much speech and this many words, or reaches the cap. */
const CHUNK_MIN_SECONDS = 10;
const CHUNK_MIN_WORDS = 12;
const CHUNK_MAX_SECONDS = 20;

/** Below this similarity a chunk is not about what was typed. On the clips library (2026-10-10) real matches scored 0.63-0.86 and an unrelated query ("recipe for chocolate chip cookies") at most 0.56. */
export const MIN_SIMILARITY = 0.6;
/** The most meaning hits returned. */
export const MAX_MEANING_HITS = 20;

export interface MeaningChunk {
  first: number;
  last: number;
  start: number;
  text: string;
}

/** Consecutive segments grouped into chunks long enough to carry a meaning. */
export function meaningChunks(segments: ReadonlyArray<{ idx: number; start: number; end: number; text: string }>): MeaningChunk[] {
  const out: MeaningChunk[] = [];
  let cur: { first: number; last: number; start: number; end: number; texts: string[]; words: number } | null = null;
  const flush = () => {
    if (cur) out.push({ first: cur.first, last: cur.last, start: cur.start, text: cur.texts.join(' ') });
    cur = null;
  };
  for (const s of segments) {
    if (cur && s.end - cur.start > CHUNK_MAX_SECONDS) flush();
    if (!cur) cur = { first: s.idx, last: s.idx, start: s.start, end: s.end, texts: [], words: 0 };
    cur.last = s.idx;
    cur.end = s.end;
    cur.texts.push(s.text);
    cur.words += s.text.split(/\s+/).filter(Boolean).length;
    if (cur.end - cur.start >= CHUNK_MIN_SECONDS && cur.words >= CHUNK_MIN_WORDS) flush();
  }
  flush();
  return out;
}

export interface MeaningHit {
  /** Segment indices (transcript_segments.idx) the chunk spans. */
  first: number;
  last: number;
  start: number;
  /** Cosine similarity to what was typed. */
  score: number;
}

export interface MeaningSearchResult {
  hits: MeaningHit[];
  /** The chunks searched, and whether they were embedded by this search (first use on the video). */
  chunks: number;
  embeddedNow: boolean;
}

export type Embed = (texts: string[], task: 'search_query' | 'search_document') => Promise<Float32Array[]>;

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
/** A copy: a Buffer read from SQLite need not be 4-byte aligned for a Float32Array view. */
const fromBlob = (b: Buffer) => new Float32Array(Uint8Array.from(b).buffer);

/** Embed and store a video's chunks if they are missing or were made with another model. */
async function ensureVideoVectors(db: Database, videoId: string, embed: Embed): Promise<{ chunks: number; embeddedNow: boolean }> {
  const state = db.prepare('SELECT model FROM transcript_meaning_state WHERE video_id = ?').get(videoId) as { model: string } | undefined;
  if (state?.model === MEANING_MODEL_KEY) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM transcript_meaning_chunks WHERE video_id = ?').get(videoId) as { n: number }).n;
    return { chunks: n, embeddedNow: false };
  }
  const segments = db.prepare('SELECT idx, start_s AS start, end_s AS end, text FROM transcript_segments WHERE video_id = ? ORDER BY idx').all(videoId) as Array<{ idx: number; start: number; end: number; text: string }>;
  const chunks = meaningChunks(segments);
  const vectors = chunks.length ? await embed(chunks.map((c) => c.text), 'search_document') : [];
  db.transaction(() => {
    db.prepare('DELETE FROM transcript_meaning_chunks WHERE video_id = ?').run(videoId);
    const insert = db.prepare('INSERT INTO transcript_meaning_chunks (video_id, first_idx, last_idx, start_s, vec) VALUES (?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => insert.run(videoId, c.first, c.last, c.start, toBlob(vectors[i])));
    db.prepare('INSERT OR REPLACE INTO transcript_meaning_state (video_id, model) VALUES (?, ?)').run(videoId, MEANING_MODEL_KEY);
  })();
  return { chunks: chunks.length, embeddedNow: true };
}

/** The chunks of one video's transcript closest in meaning to `query`, best first. */
export async function searchMeaning(db: Database, videoId: string, query: string, embed: Embed): Promise<MeaningSearchResult> {
  const q = query.trim();
  if (!q) return { hits: [], chunks: 0, embeddedNow: false };
  const { chunks, embeddedNow } = await ensureVideoVectors(db, videoId, embed);
  const [qv] = await embed([q], 'search_query');
  const rows = db.prepare('SELECT first_idx AS first, last_idx AS last, start_s AS start, vec FROM transcript_meaning_chunks WHERE video_id = ?').all(videoId) as Array<{ first: number; last: number; start: number; vec: Buffer }>;
  const hits = rows
    .map((r) => {
      const v = fromBlob(r.vec);
      let dot = 0;
      for (let j = 0; j < v.length; j++) dot += v[j] * qv[j];
      return { first: r.first, last: r.last, start: r.start, score: Math.round(dot * 1000) / 1000 };
    })
    .filter((h) => h.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEANING_HITS);
  return { hits, chunks, embeddedNow };
}
