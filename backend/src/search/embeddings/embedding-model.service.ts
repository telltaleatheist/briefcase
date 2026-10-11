/**
 * THE EMBEDDING MODEL: nomic-embed-text-v1.5, run inside Briefcase.
 *
 * A small encoder (137M parameters, BERT-class): it turns a piece of text into
 * one vector of its meaning, and texts that mean the same thing land close
 * together. It fits on the CPU, so it runs here and not on Crucible (the user,
 * 2026-10-09: "if it runs on cpu, it stays local"). It powers Scout's
 * expanded transcript search (search by meaning, not spelling).
 *
 * The model's four files are fetched once from Hugging Face at a PINNED
 * revision, each checked against its sha256, into
 * <configDir>/components/nomic-embed-text-v1.5/, and loaded from there with
 * remote fetching off: what runs is exactly what was checked.
 *
 * Vectors follow Nomic's own recipe for shorter vectors (Matryoshka): mean
 * pooling, layer norm, the first DIMENSIONS values, unit length. Text is
 * prefixed with its task: `search_query: ` for what was typed,
 * `search_document: ` for what is searched.
 *
 * It runs on onnxruntime-node with the tokenizer from @huggingface/tokenizers,
 * and nothing else: transformers.js would also bring sharp (an image library
 * whose binaries a production install omits, so it failed to load at all)
 * and a 140 MB browser runtime, for nothing text needs.
 *
 * The model runs on its own thread (embedding-worker.ts): onnxruntime holds
 * the thread it computes on, and on the server's own thread a library
 * backfill kept the backend from ever answering Electron's readiness check.
 */
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';
import { Worker } from 'worker_threads';

import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';

export const EMBEDDING_MODEL_ID = 'nomic-embed-text-v1.5';
const REPO = 'nomic-ai/nomic-embed-text-v1.5';
const REVISION = 'e9b6763023c676ca8431644204f50c2b100d9aab';
/** The files the model loads, pinned by checksum (verified 2026-10-10 at REVISION). */
const FILES: ReadonlyArray<{ path: string; sha256: string; bytes: number }> = [
  { path: 'config.json', sha256: '9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b', bytes: 2538 },
  { path: 'tokenizer.json', sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66', bytes: 711396 },
  { path: 'tokenizer_config.json', sha256: 'd7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc', bytes: 1191 },
  { path: 'onnx/model_quantized.onnx', sha256: 'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27', bytes: 137296292 },
];

/**
 * The onnxruntime-node release the backend pins (package.json; a spec keeps
 * them equal). 1.23.0 is the newest with a runtime for every platform Briefcase
 * ships, Intel Macs included (1.24 dropped darwin/x64).
 */
export const ONNX_RUNTIME_VERSION = '1.23.0';

/** Length of a stored vector (Nomic's Matryoshka sizes: 768, 512, 256, 128, 64). */
export const DIMENSIONS = 256;
/** Texts embedded per model call. */
const BATCH = 16;

export type EmbedTask = 'search_query' | 'search_document';

/** The progress of the one-time download, for whoever is waiting on it. */
export type InstallProgress = (doneBytes: number, totalBytes: number) => void;

/** The loaded model: text in, one mean-pooled vector (768 values) per text out. */
type Pool = (texts: string[]) => Promise<Float32Array[]>;

@Injectable()
export class EmbeddingModelService {
  private readonly logger = new Logger(EmbeddingModelService.name);
  private readonly root = path.join(getBriefcaseConfigDir(), 'components');
  private readonly dir = path.join(this.root, EMBEDDING_MODEL_ID);
  private model: Promise<Pool> | null = null;
  /** One embedding at a time: the model uses every CPU core already. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Whether every file is in place (sizes only; checksums were checked when they were written). */
  isInstalled(): boolean {
    return FILES.every((f) => {
      try {
        return fs.statSync(path.join(this.dir, f.path)).size === f.bytes;
      } catch {
        return false;
      }
    });
  }

  /** Fetch whatever files are missing, each checked against its checksum before it is kept. */
  async install(onProgress?: InstallProgress): Promise<void> {
    const total = FILES.reduce((s, f) => s + f.bytes, 0);
    let done = 0;
    for (const f of FILES) {
      const dest = path.join(this.dir, f.path);
      if (fs.existsSync(dest) && fs.statSync(dest).size === f.bytes) {
        done += f.bytes;
        onProgress?.(done, total);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = `${dest}.part`;
      const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${f.path}`;
      this.logger.log(`[Embeddings] Downloading ${f.path} (${(f.bytes / 1e6).toFixed(1)} MB)`);
      const response = await axios.get(url, { responseType: 'stream', timeout: 60_000, maxRedirects: 5 });
      const hash = crypto.createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(part);
        response.data.on('data', (chunk: Buffer) => {
          hash.update(chunk);
          done += chunk.length;
          onProgress?.(done, total);
        });
        response.data.on('error', reject);
        out.on('error', reject);
        out.on('finish', () => resolve());
        response.data.pipe(out);
      });
      const sha = hash.digest('hex');
      if (sha !== f.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error(`the embedding model file ${f.path} did not match its checksum (got ${sha.slice(0, 12)}…); nothing was kept`);
      }
      fs.renameSync(part, dest);
    }
  }

  /** Unit-length vectors of DIMENSIONS values, one per text, in order. Installs the model first if needed. */
  embed(texts: string[], task: EmbedTask, onInstallProgress?: InstallProgress): Promise<Float32Array[]> {
    const run = this.queue.then(async () => {
      const pool = await this.load(onInstallProgress);
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const rows = await pool(texts.slice(i, i + BATCH).map((t) => `${task}: ${t.trim() || '(silence)'}`));
        for (const row of rows) out.push(matryoshka(Array.from(row)));
      }
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private load(onInstallProgress?: InstallProgress): Promise<Pool> {
    if (!this.model) {
      this.model = (async () => {
        if (!this.isInstalled()) await this.install(onInstallProgress);
        const t0 = Date.now();
        const worker = new Worker(path.join(__dirname, 'embedding-worker.js'));
        worker.unref();
        let nextId = 0;
        const waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();
        worker.on('message', (msg: { id: number; ok: boolean; vectors?: Float32Array[]; error?: string }) => {
          const w = waiting.get(msg.id);
          if (!w) return;
          waiting.delete(msg.id);
          if (msg.ok) w.resolve(msg.vectors ?? []);
          else w.reject(new Error(msg.error ?? 'the embedding model failed'));
        });
        // A dead worker fails whatever waits on it, and the next use starts a new one.
        const fail = (error: Error) => {
          for (const w of waiting.values()) w.reject(error);
          waiting.clear();
          this.model = null;
        };
        worker.on('error', fail);
        worker.on('exit', (code) => fail(new Error(`the embedding model's thread stopped (exit ${code})`)));
        const ask = (msg: Record<string, unknown>) =>
          new Promise<Float32Array[]>((resolve, reject) => {
            const id = nextId++;
            waiting.set(id, { resolve, reject });
            worker.postMessage({ ...msg, id });
          });
        // Half the cores: the library backfill runs in the background and the machine must stay responsive.
        await ask({ dir: this.dir, threads: Math.max(1, Math.floor(os.cpus().length / 2)) });
        this.logger.log(`[Embeddings] ${EMBEDDING_MODEL_ID} loaded on its own thread in ${Date.now() - t0} ms`);
        return (texts: string[]) => ask({ texts });
      })();
      this.model.catch(() => {
        this.model = null;
      });
    }
    return this.model;
  }
}

/** Nomic's recipe for a shorter vector: layer norm, keep the first DIMENSIONS values, unit length. */
export function matryoshka(row: number[]): Float32Array {
  const n = row.length;
  const mean = row.reduce((s, x) => s + x, 0) / n;
  const variance = row.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance + 1e-5);
  const out = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let j = 0; j < DIMENSIONS; j++) {
    out[j] = (row[j] - mean) / sd;
    norm += out[j] * out[j];
  }
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < DIMENSIONS; j++) out[j] /= norm;
  return out;
}
