/**
 * Live smoke test for the snap engine: run it once the GPU is free, BEFORE
 * flipping analysisEngine to 'snap' anywhere (docs/snap-analysis-plan.md,
 * "Live validation").
 *
 *   (a) engine    start the scorer's own llama-server through ScorerServerService
 *                 (app-config scorerModel / BRIEFCASE_SCORER_LLAMA_SERVER, exactly
 *                 as the app does), or attach to one already running (--engine);
 *   (b) sanity    snap's own live cases: yes/no sentiment, choice routing, score
 *                 ordering (sanity-cases.ts, from snap/tests/fixtures);
 *   (c) chapters  the TS chaptering pipeline on N YTSeg test videos, with the
 *                 cached 9B outlines injected so only assign (+ ad confirmation)
 *                 runs on the scorer; scored exactly like ContentStudio's
 *                 bench.py / bench_snap.py (F1@±1, F1@±3, Pk; switch-cost sweep)
 *                 against its 0.72 / 0.23 at switch cost 20;
 *   (d) timings   per sanity request, per video (assign / ads), ms per sentence
 *                 (ContentStudio: 0.70 s/sentence, 9B BF16 on the M1 Ultra).
 *
 * BUILD (from backend/). `npm run build` emits dist/scorer/live/snap-smoke.js with
 * the rest of the backend. Or compile just this script's import closure, which
 * works even where the full project has type errors (the worktree's missing
 * @types make plain `tsc -p` emit nothing, because of noEmitOnError):
 *   TSC=/Volumes/Callisto/Projects/Briefcase/node_modules/.bin/tsc
 *   $TSC --outDir dist --rootDir src --module commonjs --target ES2021 --strict \
 *        --experimentalDecorators --emitDecoratorMetadata --skipLibCheck --types node \
 *        src/scorer/live/snap-smoke.ts
 *
 * DATA. The YTSeg sample as JSON, once (Node reads no parquet without a new
 * dependency). Already generated on the dev Mac (2026-09-23) at
 * <REF>/bench-cache/ytseg-sample-24.json; its 24 ids equal bench-cache's snapseg-* ids.
 *   python3 -m venv /tmp/ytseg && /tmp/ytseg/bin/pip install pandas pyarrow
 *   /tmp/ytseg/bin/python src/scorer/live/ytseg-sample.py --ref <REF> --n 24
 *
 * RUN
 *   node dist/scorer/live/snap-smoke.js --offline               # no GPU: scoring-port check
 *   node dist/scorer/live/snap-smoke.js                         # starts the scorer itself
 *   node dist/scorer/live/snap-smoke.js --engine http://127.0.0.1:8481   # attach instead
 *   node dist/scorer/live/snap-smoke.js --n 4 --skip-sanity     # quick look
 * The offline check was run on 2026-09-23: pen 20 -> F1@±1 0.720, Pk 0.229, the same
 * as bench_snap.py score on the same cached maps (all four swept costs match).
 *
 * FLAGS
 *   --engine URL        attach to a running llama-server (snap's serve flags:
 *                       -c 65536 --ctx-checkpoints 32 --parallel 1 --jinja); never stopped
 *   --ref DIR           content-studio-chaptering-ref (default: the sibling worktree)
 *   --sample FILE       YTSeg sample JSON (default <REF>/bench-cache/ytseg-sample-<N>.json)
 *   --n N               videos (default 24: bench.py sample(24), seed 7)
 *   --outlines SRC      'snapseg' (default: the items segment.py wrote, the run that
 *                       scored 0.72) or 'outline' (bench.py's older 16-item outlines)
 *   --switch-cost C     Viterbi switch cost for the headline row (default 20)
 *   --no-ads            skip the ad/plug item (segment.py run(plugs=False))
 *   --skip-sanity / --skip-chapters
 *   --offline           no engine at all: score the CACHED Python logp matrices
 *                       (snapseg-<id>.json) with this port's Viterbi + scoring.
 *                       Proves the scoring port reproduces 0.720 / 0.229 at 20.
 *   --json FILE         write every per-video result and the summary
 *
 * Exit code 0 when every sanity case passes and (when chapters ran) F1@±1 at the
 * headline switch cost is within 0.02 of 0.72 (the plan §6.3 port gate); else 1.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

import { runSnapChapters } from '../chapters/snap-chapter.service';
import { boundaries } from '../chapters/segmenter';
import { PLUG } from '../chapters/snap-prompts';
import { SnapUnit } from '../chapters/units';
import { ScorerDecider } from '../scorer-decide';
import { ScorerEngine } from '../scorer-engine';
import { ScorerHandle, ScorerServerService } from '../scorer-server.service';
import { viterbi } from '../scorer-viterbi';
import { ChatMessage, ChoiceAnswer, ScoreAnswer, YesNoAnswer } from '../scorer.types';
import { SANITY_SUITES } from './sanity-cases';

// ------------------------------------------------------------------ reference numbers

/** ContentStudio bench_snap.py on the same 24 videos, 9B BF16, switch cost 20. */
export const REFERENCE = { f1: 0.72, pk: 0.23, secondsPerSentence: 0.7, switchCost: 20 };
export const SWEEP = [10, 20, 30, 40];
const DEFAULT_REF = '/Volumes/Callisto/Projects/Briefcase-worktrees/content-studio-chaptering-ref';

// ------------------------------------------------------------------ scoring (port of bench.py)

/** bench.py f1(pred, gold, tol) -> [recall, precision, f1]. */
export function f1(pred: number[], gold: number[], tol: number): [number, number, number] {
  const hitG = gold.filter((g) => pred.some((p) => Math.abs(g - p) <= tol)).length;
  const hitP = pred.filter((p) => gold.some((g) => Math.abs(g - p) <= tol)).length;
  const r = gold.length ? hitG / gold.length : 0;
  const pr = pred.length ? hitP / pred.length : 0;
  return [r, pr, r + pr ? (2 * r * pr) / (r + pr) : 0];
}

/** bench.py pk(pred, gold, n): Beeferman's Pk with k = max(2, round(n / (|gold| + 1) / 2)). */
export function pk(pred: number[], gold: number[], n: number): number {
  const segIds = (bounds: number[]) => {
    const bs = new Set(bounds);
    const ids: number[] = [];
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (bs.has(i)) c++;
      ids.push(c);
    }
    return ids;
  };
  const g = segIds(gold);
  const h = segIds(pred);
  const k = Math.max(2, pyRound(n / (gold.length + 1) / 2));
  let errs = 0;
  for (let i = 0; i < n - k; i++) if ((g[i] === g[i + k]) !== (h[i] === h[i + k])) errs++;
  return errs / Math.max(1, n - k);
}

/** Python 3 round(): half to even. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export interface YtsegVideo {
  id: string;
  cat?: string;
  sents: string[];
  labels: number[];
}

/** bench_snap.py: gold = [i for i, l in enumerate(labels) if l and i > 0]. */
export function goldOf(v: YtsegVideo): number[] {
  return v.labels.flatMap((l, i) => (l && i > 0 ? [i] : []));
}

export interface VideoScore {
  id: string;
  sentences: number;
  gold: number;
  byPen: Record<number, { f1_1: number; f1_3: number; pk: number; count: number }>;
  timings?: { assignMs: number; adsMs: number; totalMs: number; msPerSentence: number };
  plugVerdicts?: Array<{ start: number; end: number; p: number }>;
}

/** Score one video's log-prob matrix (plug rejections already applied) at every swept switch cost. */
export function scoreMatrix(v: YtsegVideo, L: number[][], pens: number[] = SWEEP): VideoScore['byPen'] {
  const gold = goldOf(v);
  const out: VideoScore['byPen'] = {};
  for (const pen of pens) {
    const b = boundaries(viterbi(L, pen));
    out[pen] = {
      f1_1: f1(b, gold, 1)[2],
      f1_3: f1(b, gold, 3)[2],
      pk: pk(b, gold, v.sents.length),
      count: gold.length ? b.length / gold.length : 0,
    };
  }
  return out;
}

export function summarise(scores: VideoScore[], pens: number[] = SWEEP) {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const rows: Record<number, { f1_1: number; f1_3: number; pk: number; count: number }> = {};
  for (const pen of pens) {
    rows[pen] = {
      f1_1: mean(scores.map((s) => s.byPen[pen].f1_1)),
      f1_3: mean(scores.map((s) => s.byPen[pen].f1_3)),
      pk: mean(scores.map((s) => s.byPen[pen].pk)),
      count: mean(scores.map((s) => s.byPen[pen].count)),
    };
  }
  return rows;
}

// ------------------------------------------------------------------ args

interface Args {
  engine?: string;
  ref: string;
  sample?: string;
  n: number;
  outlines: 'snapseg' | 'outline';
  switchCost: number;
  ads: boolean;
  sanity: boolean;
  chapters: boolean;
  offline: boolean;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { ref: DEFAULT_REF, n: 24, outlines: 'snapseg', switchCost: REFERENCE.switchCost, ads: true, sanity: true, chapters: true, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--engine') a.engine = val();
    else if (k === '--ref') a.ref = val();
    else if (k === '--sample') a.sample = val();
    else if (k === '--n') a.n = Number(val());
    else if (k === '--outlines') {
      const v = val();
      if (v !== 'snapseg' && v !== 'outline') throw new Error('--outlines is snapseg or outline');
      a.outlines = v;
    } else if (k === '--switch-cost') a.switchCost = Number(val());
    else if (k === '--no-ads') a.ads = false;
    else if (k === '--skip-sanity') a.sanity = false;
    else if (k === '--skip-chapters') a.chapters = false;
    else if (k === '--offline') a.offline = true;
    else if (k === '--json') a.json = val();
    else if (k === '--help' || k === '-h') {
      const src = fs.readFileSync(__filename, 'utf8');
      console.log(/\/\*\*([\s\S]*?)\*\//.exec(src)?.[1].replace(/^ \* ?/gm, '') ?? 'see the header of snap-smoke.ts');
      process.exit(0);
    } else throw new Error(`unknown argument ${k} (--help)`);
  }
  if (!Number.isInteger(a.n) || a.n < 1) throw new Error('--n must be a positive integer');
  if (!Number.isFinite(a.switchCost) || a.switchCost <= 0) throw new Error('--switch-cost must be > 0');
  return a;
}

// ------------------------------------------------------------------ data

function loadSample(a: Args): YtsegVideo[] {
  const file = a.sample ?? path.join(a.ref, 'bench-cache', `ytseg-sample-${a.n}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `YTSeg sample not found: ${file}\nMake it once with:\n` +
        `  python3 -m venv /tmp/ytseg && /tmp/ytseg/bin/pip install pandas pyarrow\n` +
        `  /tmp/ytseg/bin/python src/scorer/live/ytseg-sample.py --ref ${a.ref} --n ${a.n}`,
    );
  }
  const vids = JSON.parse(fs.readFileSync(file, 'utf8')) as YtsegVideo[];
  return vids.slice(0, a.n);
}

/** The cached 9B outline items for a video, without the plug (the pipeline appends it). */
function loadOutline(a: Args, id: string): string[] {
  const file = path.join(a.ref, 'bench-cache', `${a.outlines}-${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`no cached outline for ${id}: ${file}`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items: string[] = (a.outlines === 'snapseg' ? d.items : d.p?.items) ?? [];
  return items.filter((x) => x !== PLUG);
}

/** YTSeg sentences as units: one per sentence, no fold (bench.py feeds sentences as-is); "time" = index. */
function unitsOf(v: YtsegVideo): SnapUnit[] {
  return v.sents.map((text, i) => ({ index: i, start: i, end: i + 1, text, sentenceFrom: i, sentenceTo: i }));
}

// ------------------------------------------------------------------ (b) sanity

interface SanityOutcome {
  suite: string;
  id: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function runSanity(handle: ScorerHandle): Promise<SanityOutcome[]> {
  const out: SanityOutcome[] = [];
  for (const suite of SANITY_SUITES) {
    console.log(`\n## sanity: ${suite.name} (${suite.file})`);
    const scores: Record<string, number> = {};
    for (const r of suite.requests) {
      const t = Date.now();
      let ok = true;
      const notes: string[] = [];
      try {
        const res = await handle.decide({ state: r.state, questions: r.questions });
        for (const q of r.questions) {
          const ans = res.answers[q.name];
          if (ans.type === 'score') scores[r.id] = (ans as ScoreAnswer).score;
        }
        for (const e of r.expect) {
          const ans = res.answers[e.q];
          let pass: boolean;
          let seen: string;
          if (e.check === 'p_gt' || e.check === 'p_lt') {
            const p = (ans as YesNoAnswer).p;
            pass = e.check === 'p_gt' ? p > Number(e.value) : p < Number(e.value);
            seen = `p=${p.toFixed(3)}`;
          } else if (e.check === 'choice_is') {
            const c = (ans as ChoiceAnswer).choice;
            pass = c === e.value;
            seen = `choice=${c}`;
          } else {
            const c = (ans as ChoiceAnswer).confidence;
            pass = c > Number(e.value);
            seen = `confidence=${c.toFixed(3)}`;
          }
          ok = ok && pass;
          notes.push(`${e.check} ${e.value}: ${seen}${pass ? '' : ' FAIL'}`);
        }
        const mass = Object.values(res.answers).map((x) => x.labelMass.toFixed(2));
        notes.push(`labelMass ${mass.join(',')}`);
      } catch (err) {
        ok = false;
        notes.push(`ERROR ${(err as Error).message}`);
      }
      const ms = Date.now() - t;
      out.push({ suite: suite.name, id: r.id, ok, detail: notes.join('; '), ms });
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.id.padEnd(12)} ${String(ms).padStart(6)} ms  ${notes.join('; ')}`);
    }
    for (const x of suite.across) {
      const vals = x.requests.map((id) => scores[id]);
      const ok = vals.every((v, i) => v !== undefined && (i === 0 || v > vals[i - 1]));
      out.push({ suite: suite.name, id: `across:${x.check}`, ok, detail: vals.map((v) => v?.toFixed(3)).join(' < '), ms: 0 });
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${x.check} over ${x.requests.join(', ')}: ${vals.map((v) => v?.toFixed(3)).join(' < ')}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ (c) chapters

async function runChapters(a: Args, vids: YtsegVideo[], handle: ScorerHandle | null): Promise<VideoScore[]> {
  const scores: VideoScore[] = [];
  console.log(
    `\n## chapters: ${vids.length} YTSeg videos, ${a.outlines} outlines injected, ` +
      `${a.offline ? 'OFFLINE (cached Python logp)' : `live assign, switch cost ${a.switchCost}, ads ${a.ads ? 'on' : 'off'}`}`,
  );
  for (const [k, v] of vids.entries()) {
    let L: number[][];
    let timings: VideoScore['timings'];
    let plugVerdicts: VideoScore['plugVerdicts'];
    let headline: number[] | null = null;
    if (a.offline) {
      // bench_snap.py scores snapseg logp as stored: confirm_plugs mutated it in place,
      // so rejected ad stretches already carry -1e9 in the plug column.
      L = JSON.parse(fs.readFileSync(path.join(a.ref, 'bench-cache', `snapseg-${v.id}.json`), 'utf8')).logp;
    } else {
      const items = loadOutline(a, v.id);
      const units = unitsOf(v);
      const n = units.length;
      const res = await runSnapChapters(
        { decide: (r, o) => handle!.decide(r, o), generate: (m, o) => handle!.generate(m, o) },
        units,
        {
          switchCost: a.switchCost,
          detectAds: a.ads,
          writeOutline: async () => items.join('\n'),
          // One chunk, as bench.py ran every video (60-320 sentences, far below 16k tokens).
          chunkPlan: [{ start: 0, end: n, coreStart: 0, coreEnd: n }],
        },
      );
      const chunk = res.chunks[0];
      // Re-apply this run's plug rejections to the raw matrix, as segment.py's
      // in-place confirm_plugs leaves it, so the sweep matches bench_snap.py.
      L = chunk.logProbs.map((row) => row.slice());
      const plug = a.ads ? chunk.items.length - 1 : -1;
      for (const pv of chunk.plugVerdicts) if (pv.p < 0.5 && plug >= 0) for (let i = pv.start; i < pv.end; i++) L[i][plug] = -1e9;
      headline = boundaries(chunk.path);
      timings = {
        assignMs: res.timings.assignMs,
        adsMs: res.timings.adsMs,
        totalMs: res.timings.totalMs,
        msPerSentence: res.timings.totalMs / Math.max(1, n),
      };
      plugVerdicts = chunk.plugVerdicts;
    }
    const byPen = scoreMatrix(v, L, [...new Set([...SWEEP, a.switchCost])]);
    if (headline) {
      // The pipeline's own path (plug confirmation run at the headline cost) must
      // agree with re-running Viterbi on the confirmed matrix.
      const again = boundaries(viterbi(L, a.switchCost));
      if (again.join(',') !== headline.join(',')) console.log(`  note: ${v.id} path differs from the re-run Viterbi`);
    }
    const s: VideoScore = { id: v.id, sentences: v.sents.length, gold: goldOf(v).length, byPen, timings, plugVerdicts };
    scores.push(s);
    const h = byPen[a.switchCost];
    console.log(
      `  [${k + 1}/${vids.length}] ${v.id} ${String(v.sents.length).padStart(3)} sents  ` +
        `F1@±1 ${h?.f1_1.toFixed(3)}  F1@±3 ${h?.f1_3.toFixed(3)}  Pk ${h?.pk.toFixed(3)}  count ${h?.count.toFixed(2)}` +
        (timings ? `  ${(timings.totalMs / 1000).toFixed(1)}s (${(timings.msPerSentence / 1000).toFixed(2)} s/sent)` : '') +
        (plugVerdicts?.length ? `  ads ${plugVerdicts.map((p) => `${p.start}-${p.end}:${p.p.toFixed(2)}`).join(' ')}` : ''),
    );
  }
  return scores;
}

// ------------------------------------------------------------------ engine

/** A handle on an already-running llama-server (never stopped by this script). */
async function attach(url: string): Promise<ScorerHandle> {
  const engine = new ScorerEngine(url);
  await engine.health();
  const decider = await ScorerDecider.create(engine);
  return {
    decide: (req, o) => decider.decide(req, o),
    generate: (messages: ChatMessage[] | string, o) =>
      engine.generate(typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages, o),
    decider: async () => decider,
  };
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const report: Record<string, unknown> = { args: a, startedAt: new Date().toISOString() };
  let sanity: SanityOutcome[] = [];
  let chapterScores: VideoScore[] = [];
  const vids = a.chapters ? loadSample(a) : [];

  const work = async (handle: ScorerHandle | null) => {
    if (handle) {
      const d = await handle.decider();
      report.model = d.model;
      report.startupMs = Date.now() - t0;
      console.log(`# engine ready: ${d.model} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (a.sanity) sanity = await runSanity(handle);
    }
    if (a.chapters) chapterScores = await runChapters(a, vids, handle);
  };

  if (a.offline) {
    a.sanity = false;
    await work(null);
  } else if (a.engine) {
    await work(await attach(a.engine));
  } else {
    const server = new ScorerServerService();
    const avail = server.availability();
    if (!avail.available) throw new Error(`scorer unavailable: ${avail.reason}`);
    console.log(`# starting the scorer (${avail.binarySource} llama-server); an 18 GB model can take minutes`);
    try {
      await server.withScorer((h) => work(h));
    } finally {
      await server.stop();
    }
  }

  // ---- summary
  let ok = true;
  if (sanity.length) {
    const failed = sanity.filter((s) => !s.ok);
    ok = ok && failed.length === 0;
    console.log(`\n# sanity: ${sanity.length - failed.length}/${sanity.length} passed` + (failed.length ? ` (FAILED: ${failed.map((f) => f.id).join(', ')})` : ''));
  }
  if (chapterScores.length) {
    const rows = summarise(chapterScores);
    console.log(`\n# chapters over ${chapterScores.length} videos (reference: ContentStudio F1@±1 ${REFERENCE.f1} / Pk ${REFERENCE.pk} at ${REFERENCE.switchCost})`);
    for (const pen of SWEEP) {
      const r = rows[pen];
      console.log(
        `  pen ${String(pen).padStart(3)}: F1@±1 ${r.f1_1.toFixed(3)}  F1@±3 ${r.f1_3.toFixed(3)}  Pk ${r.pk.toFixed(3)}  count ${r.count.toFixed(2)}` +
          (pen === REFERENCE.switchCost ? `   (Δ F1 ${(r.f1_1 - REFERENCE.f1).toFixed(3)}, Δ Pk ${(r.pk - REFERENCE.pk).toFixed(3)})` : ''),
      );
    }
    const head = summarise(chapterScores, [a.switchCost])[a.switchCost];
    const gate = Math.abs(head.f1_1 - REFERENCE.f1) <= 0.02 || head.f1_1 > REFERENCE.f1;
    ok = ok && gate;
    console.log(`  port gate (plan §6.3, F1@±1 within 0.02 of ${REFERENCE.f1} at ${a.switchCost}): ${gate ? 'PASS' : 'FAIL'}`);
    const timed = chapterScores.filter((s) => s.timings);
    if (timed.length) {
      const ms = timed.reduce((n, s) => n + s.timings!.totalMs, 0);
      const ns = timed.reduce((n, s) => n + s.sentences, 0);
      console.log(
        `  time ${(ms / 1000).toFixed(0)} s for ${ns} sentences: ${(ms / ns / 1000).toFixed(2)} s/sentence ` +
          `(ContentStudio ${REFERENCE.secondsPerSentence.toFixed(2)}; assign ${(timed.reduce((n, s) => n + s.timings!.assignMs, 0) / 1000).toFixed(0)} s, ` +
          `ads ${(timed.reduce((n, s) => n + s.timings!.adsMs, 0) / 1000).toFixed(0)} s)`,
      );
    }
    report.chapters = { summary: rows, videos: chapterScores };
  }
  if (sanity.length) report.sanity = sanity;
  report.totalMs = Date.now() - t0;
  console.log(`\n# total ${(Number(report.totalMs) / 1000).toFixed(1)} s — ${ok ? 'PASS' : 'FAIL'}`);
  if (a.json) fs.writeFileSync(a.json, JSON.stringify(report, null, 2));
  return ok ? 0 : 1;
}

if (require.main === module) {
  Logger.overrideLogger(['error', 'warn']);
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.stack || err.message : err);
      process.exit(1);
    },
  );
}
