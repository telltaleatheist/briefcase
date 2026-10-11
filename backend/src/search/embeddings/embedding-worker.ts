/**
 * The embedding model's own thread (embedding-model.service.ts starts it).
 *
 * Running the model takes the CPU for ~1 s per 256 chunks, and onnxruntime-node
 * holds the calling thread while it computes. On the backend's main thread a
 * library backfill starved everything else: on 2026-10-10 the backend never
 * answered Electron's readiness check while indexing ran at startup. Here it
 * runs beside the server, which only posts texts and receives vectors.
 *
 * Messages in: { id, dir, threads } once (load), then { id, texts }.
 * Messages out: { id, ok: true, vectors: Float32Array[] (768-value means) } or
 * { id, ok: false, error }.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parentPort } from 'worker_threads';

/** Longest input in tokens (a chunk of speech is far shorter; the model takes 8192). */
const MAX_TOKENS = 512;

/**
 * Most padded tokens (texts x longest text) in one model run. Under Electron's
 * V8, freeing a large ONNX output crashes the process (SIGTRAP), and a crash
 * in a worker takes the backend with it. Measured 2026-10-10 on Electron 33:
 * 40 runs at up to 3,200 tokens (9 MB of output) were fine; 16 x 336 tokens
 * (15 MB) crashed, reached by an ASR loop transcript ("I'm I'm I'm ...") where
 * normal speech chunks are ~100 tokens. 2,048 tokens keeps each output ~6 MB.
 */
const MAX_BATCH_TOKENS = 2048;

type Pool = (texts: string[]) => Promise<Float32Array[]>;
let pool: Promise<Pool> | null = null;

async function load(dir: string, threads: number): Promise<Pool> {
  const ort = await import('onnxruntime-node');
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const tokenizer = new Tokenizer(read('tokenizer.json'), read('tokenizer_config.json'));
  const session = await ort.InferenceSession.create(path.join(dir, 'onnx/model_quantized.onnx'), { intraOpNumThreads: threads });
  const wantsTypes = session.inputNames.includes('token_type_ids');

  /** One model run over texts whose padded size is within MAX_BATCH_TOKENS (or a single text). */
  const runBatch = async (encoded: number[][]): Promise<Float32Array[]> => {
    const length = Math.max(...encoded.map((ids) => ids.length));
    const ids = new BigInt64Array(encoded.length * length);
    const mask = new BigInt64Array(encoded.length * length);
    encoded.forEach((row, r) => row.forEach((id, k) => {
      ids[r * length + k] = BigInt(id);
      mask[r * length + k] = 1n;
    }));
    const dims = [encoded.length, length];
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor('int64', ids, dims),
      attention_mask: new ort.Tensor('int64', mask, dims),
    };
    if (wantsTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(encoded.length * length), dims);
    const result = await session.run(feeds);
    const hidden = result[session.outputNames[0]];
    const width = hidden.dims[2];
    const data = hidden.data as Float32Array;
    // Mean pooling over each text's real tokens (padding left out).
    return encoded.map((row, r) => {
      const v = new Float32Array(width);
      for (let k = 0; k < row.length; k++) {
        const base = (r * length + k) * width;
        for (let j = 0; j < width; j++) v[j] += data[base + j];
      }
      for (let j = 0; j < width; j++) v[j] /= row.length;
      return v;
    });
  };

  return async (texts: string[]) => {
    const encoded = texts.map((t) => tokenizer.encode(t).ids.slice(0, MAX_TOKENS));
    // Consecutive groups whose padded size stays within the budget; order is kept.
    const out: Float32Array[] = [];
    let group: number[][] = [];
    let longest = 0;
    for (const ids of encoded) {
      const next = Math.max(longest, ids.length);
      if (group.length > 0 && (group.length + 1) * next > MAX_BATCH_TOKENS) {
        out.push(...(await runBatch(group)));
        group = [];
        longest = 0;
      }
      group.push(ids);
      longest = Math.max(longest, ids.length);
    }
    if (group.length > 0) out.push(...(await runBatch(group)));
    return out;
  };
}

parentPort?.on('message', async (msg: { id: number; dir?: string; threads?: number; texts?: string[] }) => {
  try {
    if (msg.dir !== undefined) {
      pool = load(msg.dir, msg.threads ?? 1);
      await pool;
      parentPort!.postMessage({ id: msg.id, ok: true, vectors: [] });
      return;
    }
    if (!pool) throw new Error('the embedding model was not loaded');
    const vectors = await (await pool)(msg.texts ?? []);
    parentPort!.postMessage({ id: msg.id, ok: true, vectors }, vectors.map((v) => v.buffer as ArrayBuffer));
  } catch (error) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: (error as Error).message });
  }
});
