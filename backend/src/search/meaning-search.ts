/**
 * MEANING SEARCH in one video's transcript: Scout's "expanded" search.
 *
 * Close-match search (close-match.ts) finds the words; this finds what was
 * MEANT, when the words differ ("the part where she says the protesters are
 * from the devil"). The transcript is cut into CHUNKS of about 10-20 s of
 * speech (single segments can be one-word fragments, too short to mean
 * anything), each turned into a vector by the embedding model
 * (embeddings/embedding-model.service.ts) and kept in the library. Vectors
 * are made in the pipeline: when a transcript is saved, and for transcripts
 * from before, by a background pass (meaning-index.service.ts). A search only
 * embeds what was typed (and indexes its video first if the pass has not
 * reached it yet, with the same function).
 *
 * A video's vectors are dropped with its moment index when its transcript
 * changes (removeVideoMoments) and with the video (ON DELETE CASCADE).
 */
import type { Database } from 'better-sqlite3';

import { DIMENSIONS, EMBEDDING_MODEL_ID, ONNX_RUNTIME_VERSION } from './embeddings/embedding-model.service';
import { meaningChanged, meaningGeneration, type Moment } from './transcript-moments';

/**
 * What the stored vectors were made with: a change re-embeds. The runtime is
 * part of it: onnxruntime versions compute the quantized model slightly
 * differently (1.23 vs 1.30: cosine 0.97-0.99), so vectors from two runtimes
 * should not be compared.
 */
export const MEANING_MODEL_KEY = `${EMBEDDING_MODEL_ID}/${DIMENSIONS}/ort-${ONNX_RUNTIME_VERSION}/i8`;

/** A chunk ends once it holds this much speech and this many words, or reaches the cap. */
const CHUNK_MIN_SECONDS = 10;
const CHUNK_MIN_WORDS = 12;
const CHUNK_MAX_SECONDS = 20;

/**
 * A chunk is a meaning match when it scores at least MIN_SIMILARITY AND
 * stands out from the rest of the video for the same query: at least
 * MIN_STANDOUT standard deviations above the video's mean. Measured on a
 * 4-hour show (2026-10-10, onnxruntime 1.23): strong real matches stood out
 * 5.5-6.1; unrelated queries (cookies, knitting, a cat, astronauts) topped
 * out at 2.9-3.6 while scoring up to 0.62 on similarity alone, so similarity
 * alone let them through. Weak descriptive matches (about 3) cannot be told
 * from noise by this model and are left to the word search.
 */
export const MIN_SIMILARITY = 0.6;
export const MIN_STANDOUT = 4;
/** Fewer chunks than this are too few to measure standing out: similarity alone decides. */
export const MIN_CHUNKS_FOR_STANDOUT = 20;
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

/**
 * A stored vector: its largest magnitude (float32), then each value as a signed
 * byte of it. 260 bytes instead of 1,024 for 256 floats: a whole library's
 * vectors are ~55 MB rather than ~230 MB (the clips library: ~210k chunks),
 * and similarities move in the third decimal.
 */
export function toBlob(v: Float32Array): Buffer {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const out = Buffer.alloc(4 + v.length);
  out.writeFloatLE(max, 0);
  for (let j = 0; j < v.length; j++) out.writeInt8(max ? Math.round((v[j] / max) * 127) : 0, 4 + j);
  return out;
}

export function fromBlob(b: Buffer): Float32Array {
  const max = b.readFloatLE(0);
  const v = new Float32Array(b.length - 4);
  for (let j = 0; j < v.length; j++) v[j] = (b.readInt8(4 + j) / 127) * max;
  return v;
}

/** Embed and store a video's chunks if they are missing or were made with another model. */
export async function indexVideoMeaning(db: Database, videoId: string, embed: Embed): Promise<{ chunks: number; embeddedNow: boolean }> {
  const state = db.prepare('SELECT model FROM transcript_meaning_state WHERE video_id = ?').get(videoId) as { model: string } | undefined;
  if (state?.model === MEANING_MODEL_KEY) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM transcript_meaning_chunks WHERE video_id = ?').get(videoId) as { n: number }).n;
    return { chunks: n, embeddedNow: false };
  }
  const segments = db.prepare('SELECT idx, start_s AS start, end_s AS end, text FROM transcript_segments WHERE video_id = ? ORDER BY idx').all(videoId) as Array<{ idx: number; start: number; end: number; text: string }>;
  const chunks = meaningChunks(segments);
  const vectors = chunks.length ? await embed(chunks.map((c) => c.text), 'search_document') : [];
  // The library may have been closed (switched) while embedding: write nothing to it.
  if (!db.open) return { chunks: 0, embeddedNow: false };
  db.transaction(() => {
    db.prepare('DELETE FROM transcript_meaning_chunks WHERE video_id = ?').run(videoId);
    const insert = db.prepare('INSERT INTO transcript_meaning_chunks (video_id, first_idx, last_idx, start_s, vec) VALUES (?, ?, ?, ?, ?)');
    chunks.forEach((c, i) => insert.run(videoId, c.first, c.last, c.start, toBlob(vectors[i])));
    db.prepare('INSERT OR REPLACE INTO transcript_meaning_state (video_id, model) VALUES (?, ?)').run(videoId, MEANING_MODEL_KEY);
  })();
  meaningChanged(db);
  return { chunks: chunks.length, embeddedNow: true };
}

/** The chunks of one video's transcript closest in meaning to `query`, best first. */
export async function searchMeaning(db: Database, videoId: string, query: string, embed: Embed): Promise<MeaningSearchResult> {
  const q = query.trim();
  if (!q) return { hits: [], chunks: 0, embeddedNow: false };
  const { chunks, embeddedNow } = await indexVideoMeaning(db, videoId, embed);
  const [qv] = await embed([q], 'search_query');
  const rows = db.prepare('SELECT first_idx AS first, last_idx AS last, start_s AS start, vec FROM transcript_meaning_chunks WHERE video_id = ?').all(videoId) as Array<{ first: number; last: number; start: number; vec: Buffer }>;
  const scored = rows.map((r) => {
    const v = fromBlob(r.vec);
    let dot = 0;
    let norm = 0;
    for (let j = 0; j < v.length; j++) {
      dot += v[j] * qv[j];
      norm += v[j] * v[j];
    }
    return { first: r.first, last: r.last, start: r.start, score: dot / (Math.sqrt(norm) || 1) };
  });
  const mean = scored.reduce((a, h) => a + h.score, 0) / (scored.length || 1);
  const sd = Math.sqrt(scored.reduce((a, h) => a + (h.score - mean) ** 2, 0) / (scored.length || 1));
  const standsOut = (score: number) => scored.length < MIN_CHUNKS_FOR_STANDOUT || (sd > 0 && (score - mean) / sd >= MIN_STANDOUT);
  const hits = scored
    .filter((h) => h.score >= MIN_SIMILARITY && standsOut(h.score))
    .map((h) => ({ ...h, score: Math.round(h.score * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MEANING_HITS);
  return { hits, chunks, embeddedNow };
}

/**
 * Videos whose transcript has no meaning vectors yet, or vectors from another
 * model or runtime: the transcripts the moment index has read (their segments
 * exist), newest first, at most `limit`.
 */
export function pendingMeaningVideos(db: Database, limit: number): string[] {
  return (db.prepare(`
    SELECT s.video_id AS id FROM transcript_index_state s
    JOIN videos v ON v.id = s.video_id
    LEFT JOIN transcript_meaning_state m ON m.video_id = s.video_id
    WHERE m.video_id IS NULL OR m.model != ?
    ORDER BY v.added_at DESC
    LIMIT ?
  `).all(MEANING_MODEL_KEY, limit) as Array<{ id: string }>).map((r) => r.id);
}

// =============================================================================
// ACROSS THE LIBRARY
// =============================================================================

/**
 * Every current vector of a library, decoded once into flat arrays (the clips
 * library: ~210k chunks, ~55 MB) and kept until meaning rows change, so a
 * library search scans memory instead of reading and decoding every row.
 */
interface VectorTable {
  generation: number;
  count: number;
  videoIds: string[];
  first: Int32Array;
  last: Int32Array;
  start: Float64Array;
  /** Per row: scale / 127 / the dequantized vector's length, so a dot product with the bytes is the cosine. */
  factor: Float32Array;
  bytes: Int8Array;
}

const tables = new WeakMap<Database, VectorTable>();

function vectorTable(db: Database): VectorTable {
  const generation = meaningGeneration(db);
  const cached = tables.get(db);
  if (cached && cached.generation === generation) return cached;
  const rows = db.prepare(`
    SELECT c.video_id AS videoId, c.first_idx AS first, c.last_idx AS last, c.start_s AS start, c.vec
    FROM transcript_meaning_chunks c JOIN transcript_meaning_state m ON m.video_id = c.video_id AND m.model = ?
  `).all(MEANING_MODEL_KEY) as Array<{ videoId: string; first: number; last: number; start: number; vec: Buffer }>;
  const n = rows.length;
  const table: VectorTable = {
    generation,
    count: n,
    videoIds: new Array<string>(n),
    first: new Int32Array(n),
    last: new Int32Array(n),
    start: new Float64Array(n),
    factor: new Float32Array(n),
    bytes: new Int8Array(n * DIMENSIONS),
  };
  rows.forEach((r, i) => {
    table.videoIds[i] = r.videoId;
    table.first[i] = r.first;
    table.last[i] = r.last;
    table.start[i] = r.start;
    let norm = 0;
    for (let j = 0; j < DIMENSIONS; j++) {
      const b = r.vec.readInt8(4 + j);
      table.bytes[i * DIMENSIONS + j] = b;
      norm += b * b;
    }
    // cos = (scale/127 * sum(q*b)) / (scale/127 * sqrt(sum(b*b))) = sum(q*b) / sqrt(sum(b*b))
    table.factor[i] = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  });
  tables.set(db, table);
  return table;
}

/** The most chunks a library meaning search returns, across all videos. */
export const MAX_LIBRARY_MEANING_HITS = 200;

export interface LibraryMeaningResult {
  /** Per video, its meaning moments in time order, videos best first. */
  videos: Array<{ videoId: string; score: number; moments: Moment[] }>;
  /** Chunks searched (the library's indexed transcripts). */
  chunks: number;
}

/**
 * The chunks of the whole library closest in meaning to an embedded query
 * (`qv`, unit length): those at MIN_SIMILARITY or more that stand out from the
 * whole library for the same query (MIN_STANDOUT), grouped by video. Only
 * transcripts already indexed are searched; nothing is embedded here.
 */
export function searchLibraryMeaning(db: Database, qv: Float32Array, maxMomentsPerVideo = 25): LibraryMeaningResult {
  const t = vectorTable(db);
  if (t.count === 0) return { videos: [], chunks: 0 };
  const scores = new Float32Array(t.count);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < t.count; i++) {
    let dot = 0;
    const base = i * DIMENSIONS;
    for (let j = 0; j < DIMENSIONS; j++) dot += qv[j] * t.bytes[base + j];
    const score = dot * t.factor[i];
    scores[i] = score;
    sum += score;
    sumSq += score * score;
  }
  const mean = sum / t.count;
  const sd = Math.sqrt(Math.max(0, sumSq / t.count - mean * mean));
  const floor = Math.max(MIN_SIMILARITY, t.count >= MIN_CHUNKS_FOR_STANDOUT && sd > 0 ? mean + MIN_STANDOUT * sd : MIN_SIMILARITY);
  const picked: number[] = [];
  for (let i = 0; i < t.count; i++) if (scores[i] >= floor) picked.push(i);
  picked.sort((a, b) => scores[b] - scores[a]);
  picked.length = Math.min(picked.length, MAX_LIBRARY_MEANING_HITS);

  const textOf = db.prepare(`SELECT group_concat(text, ' ') AS text FROM (SELECT text FROM transcript_segments WHERE video_id = ? AND idx BETWEEN ? AND ? ORDER BY idx)`);
  const endOf = db.prepare('SELECT end_s AS end FROM transcript_segments WHERE video_id = ? AND idx = ?');
  const byVideo = new Map<string, { videoId: string; score: number; moments: Moment[] }>();
  for (const i of picked) {
    const videoId = t.videoIds[i];
    let entry = byVideo.get(videoId);
    if (!entry) byVideo.set(videoId, (entry = { videoId, score: scores[i], moments: [] }));
    if (entry.moments.length >= maxMomentsPerVideo) continue;
    const text = (textOf.get(videoId, t.first[i], t.last[i]) as { text: string | null }).text ?? '';
    const end = (endOf.get(videoId, t.last[i]) as { end: number } | undefined)?.end ?? t.start[i];
    entry.moments.push({ start: t.start[i], end, text, highlights: [], score: Math.round(scores[i] * 1000) / 1000, meaning: true });
  }
  const videos = [...byVideo.values()];
  for (const v of videos) v.moments.sort((a, b) => a.start - b.start);
  return { videos, chunks: t.count };
}

/** Transcripts with current meaning vectors, of those the moment index holds. */
export function meaningIndexCounts(db: Database): { indexed: number; total: number } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM transcript_index_state s JOIN videos v ON v.id = s.video_id').get() as { n: number }).n;
  const indexed = (db.prepare('SELECT COUNT(*) AS n FROM transcript_meaning_state WHERE model = ?').get(MEANING_MODEL_KEY) as { n: number }).n;
  return { indexed, total };
}
