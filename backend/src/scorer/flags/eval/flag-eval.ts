/**
 * Offline eval harness for the snap flag ranker (plan §6.1).
 *
 * For every video in a library that has verifier-confirmed flags
 * (analysis_sections.verdict = 'flag'), it assembles the transcript's sentences
 * exactly as the flag stage does, runs the SnapFlagRanker against a LIVE scorer
 * (or re-ranks saved rating maps offline), and reports:
 *   - recall of verdict='flag' rows: a snap window's fired range overlaps the
 *     row's time range; category-agnostic and category-matched; within the
 *     verify budget and before it (budget + overflow);
 *   - how many verdict='skip' rows the snap windows also hit (precision proxy);
 *   - verify calls (vs the NLI rows the old run stored), pass-1/pass-2 counts;
 *   - runtime: wall and scorer ms, per hour of video;
 *   - picket-fence count (stored ranges from different spans < 5 s apart; must be 0).
 *
 * THE USER'S LIBRARY IS NEVER WRITTEN. The database file (and its -wal) is
 * COPIED to a temp directory and the copy is opened read-only; the copy is
 * deleted afterwards. --no-copy opens the live file with sqlite's
 * `mode=ro&immutable=1` instead (no -shm is created, nothing is written).
 *
 * Usage: see USAGE below (also printed by --help).
 *
 * The live run starts the scorer's own llama-server (ScorerServerService: app-config
 * scorerModel etc.) and stops it at the end. It needs the GPU.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';

import { RankedSentence, assembleSentences } from '../../../analysis/nli-ranker.service';
import { AnalysisCategory, DEFAULT_CATEGORIES } from '../../../analysis/prompts/analysis-prompts';
import { ScorerServerService } from '../../scorer-server.service';
import { FlagOptionPlan } from '../flag-options';
import { FlagLayout, NonePosition } from '../flag-questions';
import {
  DEFAULT_SPAN_PARAMS,
  FlagRatingMap,
  FlagSpanParams,
  SnapFlagWindow,
  picketFenceCount,
  rankFromRatingMap,
} from '../flag-spans';
import { SnapFlagRanker, SnapFlagRankStats } from '../snap-flag-ranker.service';

const USAGE = `Usage (after \`npm run build\` in backend/, or tsc to any outDir):
  node dist/scorer/flags/eval/flag-eval.js [options]
    --db <path>          library.db to read (repeatable). Default: every library
                         in <appData>/briefcase/libraries-config.json.
    --video <id>         only this video (repeatable)
    --limit <n>          at most n videos
    --layout prefix|inline, --none first|last, --batch <n>
    --params '<json>'    FlagSpanParams overrides, e.g. '{"switchCost":1,"tau":-0.5}'
    --categories <file>  JSON AnalysisCategory[] (default: DEFAULT_CATEGORIES)
    --misinfo            eval arm: include misinformation (plan §5.7)
    --out <dir>          write <video>.json (sentences, plan, rating map, stats) + report.json
    --from-maps <dir>    NO SCORER: re-rank the <video>.json files a previous --out wrote
                         (tune λ/τ/floors offline with --params)
    --dry-run            list the eval set and exit (no scorer)
    --no-copy            read the live DB immutably instead of copying it

`;

// --------------------------------------------------------------------------- read-only DB access

interface SectionRow {
  video_id: string;
  start_seconds: number;
  end_seconds: number;
  category: string | null;
  verdict: string | null;
  nli_score: number | null;
}

interface ReadOnlyDb {
  all<T>(sql: string): T[];
  close(): void;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * better-sqlite3 when its native build matches this Node (it is usually built
 * for Electron's ABI, so under plain node it will not load); otherwise the
 * sqlite3 CLI with -readonly -json.
 */
function openReadOnly(file: string, immutable: boolean): ReadOnlyDb {
  const uri = `file:${file}?mode=ro${immutable ? '&immutable=1' : ''}`;
  if (!immutable) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const db = new Database(file, { readonly: true, fileMustExist: true });
      db.pragma('query_only = ON');
      return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
    } catch {
      /* native module built for another ABI: use the CLI */
    }
  }
  const cli = process.env.SQLITE3_BIN || 'sqlite3';
  return {
    all: <T>(sql: string): T[] => {
      const out = execFileSync(cli, ['-readonly', '-json', uri, sql], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 1024,
      });
      return out.trim() ? (JSON.parse(out) as T[]) : [];
    },
    close: () => undefined,
  };
}

/** Copy a DB (and its -wal, so committed-but-uncheckpointed rows are seen) into a private temp dir. */
function copyDatabase(file: string): { copy: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-flag-eval-'));
  const copy = path.join(dir, 'library.db');
  fs.copyFileSync(file, copy);
  if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
  return { copy, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function defaultLibraryDbs(): string[] {
  const appData =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'briefcase')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'briefcase')
        : path.join(os.homedir(), '.config', 'briefcase');
  const configFile = path.join(appData, 'libraries-config.json');
  const found: string[] = [];
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    for (const lib of config.libraries || []) if (lib.databasePath) found.push(lib.databasePath);
  } catch {
    /* fall through to the per-library default layout */
  }
  const libsDir = path.join(appData, 'libraries');
  if (fs.existsSync(libsDir)) {
    for (const id of fs.readdirSync(libsDir)) {
      const db = path.join(libsDir, id, 'library.db');
      if (fs.existsSync(db) && !found.includes(db)) found.push(db);
    }
  }
  return found.filter((f) => fs.existsSync(f));
}

// --------------------------------------------------------------------------- transcript

/** Same parse as AnalysisService.parseSrtToSegments (private there). */
export function parseSrt(srt: string): Array<{ start: number; end: number; text: string }> {
  const segments: Array<{ start: number; end: number; text: string }> = [];
  const blocks = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n').filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const m = lines[1].match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!m) continue;
    const t = (h: string, mi: string, s: string, ms: string) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
    segments.push({ start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: lines.slice(2).join(' ') });
  }
  return segments;
}

// --------------------------------------------------------------------------- metrics

export interface VideoMetrics {
  videoId: string;
  durationSeconds: number;
  sentences: number;
  flagRows: number;
  skipRows: number;
  nliRows: number;
  recallAnyInBudget: number;
  recallCategoryInBudget: number;
  recallAnyAll: number;
  recallCategoryAll: number;
  skipRowsHit: number;
  verifyCalls: number;
  overflowCalls: number;
  pass1Questions: number;
  pass2Questions: number;
  wallMs: number;
  scorerMs: number;
  picketFence: number;
  missed: Array<{ start: number; end: number; category: string | null }>;
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

export function scoreVideo(
  videoId: string,
  sentences: RankedSentence[],
  rows: SectionRow[],
  windows: SnapFlagWindow[],
  overflow: SnapFlagWindow[],
  stats: Pick<SnapFlagRankStats, 'pass1Questions' | 'pass2Questions' | 'wallMs' | 'scorerMs'>,
): VideoMetrics {
  const range = (w: SnapFlagWindow) => ({ start: sentences[w.firedFrom].start, end: sentences[w.firedTo].end });
  const hits = (ws: SnapFlagWindow[], row: SectionRow, matchCategory: boolean) =>
    ws.some((w) => {
      const r = range(w);
      if (!overlaps(r.start, r.end, row.start_seconds, row.end_seconds)) return false;
      return !matchCategory || w.categories.some((c) => c.category === row.category);
    });
  const flags = rows.filter((r) => r.verdict === 'flag');
  const skips = rows.filter((r) => r.verdict === 'skip');
  const all = [...windows, ...overflow];
  const rate = (n: number) => (flags.length ? n / flags.length : 1);
  const count = (ws: SnapFlagWindow[], cat: boolean) => flags.filter((r) => hits(ws, r, cat)).length;

  // Picket fence on what would be STORED: fired ranges, sub-passages of one span unioned.
  const bySpan = new Map<string, { start: number; end: number }>();
  for (const w of windows) {
    const key = w.spanIds.join(',');
    const r = range(w);
    const prev = bySpan.get(key);
    bySpan.set(key, prev ? { start: Math.min(prev.start, r.start), end: Math.max(prev.end, r.end) } : r);
  }

  return {
    videoId,
    durationSeconds: sentences.length ? sentences[sentences.length - 1].end : 0,
    sentences: sentences.length,
    flagRows: flags.length,
    skipRows: skips.length,
    nliRows: rows.filter((r) => r.nli_score !== null && r.nli_score !== undefined).length,
    recallAnyInBudget: rate(count(windows, false)),
    recallCategoryInBudget: rate(count(windows, true)),
    recallAnyAll: rate(count(all, false)),
    recallCategoryAll: rate(count(all, true)),
    skipRowsHit: skips.filter((r) => hits(windows, r, true)).length,
    verifyCalls: windows.reduce((n, w) => n + w.categories.length, 0),
    overflowCalls: overflow.reduce((n, w) => n + w.categories.length, 0),
    pass1Questions: stats.pass1Questions,
    pass2Questions: stats.pass2Questions,
    wallMs: stats.wallMs,
    scorerMs: stats.scorerMs,
    picketFence: picketFenceCount([...bySpan.values()]),
    missed: flags
      .filter((r) => !hits(all, r, false))
      .map((r) => ({ start: r.start_seconds, end: r.end_seconds, category: r.category })),
  };
}

// --------------------------------------------------------------------------- CLI

interface Args {
  dbs: string[];
  videos: string[];
  limit: number;
  layout: FlagLayout;
  none: NonePosition;
  batch?: number;
  params: Partial<FlagSpanParams>;
  categories: AnalysisCategory[];
  misinfo: boolean;
  out?: string;
  fromMaps?: string;
  dryRun: boolean;
  copy: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dbs: [],
    videos: [],
    limit: Infinity,
    layout: 'prefix',
    none: 'last',
    params: {},
    categories: DEFAULT_CATEGORIES,
    misinfo: false,
    dryRun: false,
    copy: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${argv[i - 1]} needs a value`);
      return x;
    };
    switch (argv[i]) {
      case '--db': a.dbs.push(v()); break;
      case '--video': a.videos.push(v()); break;
      case '--limit': a.limit = Number(v()); break;
      case '--layout': a.layout = v() as FlagLayout; break;
      case '--none': a.none = v() as NonePosition; break;
      case '--batch': a.batch = Number(v()); break;
      case '--params': a.params = JSON.parse(v()); break;
      case '--categories': a.categories = JSON.parse(fs.readFileSync(v(), 'utf8')); break;
      case '--misinfo': a.misinfo = true; break;
      case '--out': a.out = v(); break;
      case '--from-maps': a.fromMaps = v(); break;
      case '--dry-run': a.dryRun = true; break;
      case '--no-copy': a.copy = false; break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (a.layout !== 'prefix' && a.layout !== 'inline') throw new Error('--layout must be prefix or inline');
  if (a.none !== 'first' && a.none !== 'last') throw new Error('--none must be first or last');
  return a;
}

interface SavedVideo {
  videoId: string;
  db: string;
  sentences: RankedSentence[];
  rows: SectionRow[];
  plan: FlagOptionPlan[];
  ratingMap: FlagRatingMap;
  stats: SnapFlagRankStats;
}

function summarise(all: VideoMetrics[]): Record<string, number> {
  const sum = (f: (m: VideoMetrics) => number) => all.reduce((n, m) => n + f(m), 0);
  const flags = sum((m) => m.flagRows);
  const hours = sum((m) => m.durationSeconds) / 3600;
  const w = (f: (m: VideoMetrics) => number) => (flags ? sum((m) => f(m) * m.flagRows) / flags : 1);
  return {
    videos: all.length,
    hours: +hours.toFixed(2),
    flagRows: flags,
    recallAnyInBudget: +w((m) => m.recallAnyInBudget).toFixed(4),
    recallCategoryInBudget: +w((m) => m.recallCategoryInBudget).toFixed(4),
    recallAnyAll: +w((m) => m.recallAnyAll).toFixed(4),
    recallCategoryAll: +w((m) => m.recallCategoryAll).toFixed(4),
    verifyCalls: sum((m) => m.verifyCalls),
    nliRows: sum((m) => m.nliRows),
    overflowCalls: sum((m) => m.overflowCalls),
    pass1Questions: sum((m) => m.pass1Questions),
    pass2Questions: sum((m) => m.pass2Questions),
    scorerSecondsPerHour: hours ? +(sum((m) => m.scorerMs) / 1000 / hours).toFixed(1) : 0,
    wallSecondsPerHour: hours ? +(sum((m) => m.wallMs) / 1000 / hours).toFixed(1) : 0,
    picketFence: sum((m) => m.picketFence),
  };
}

function printVideo(m: VideoMetrics): void {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  console.log(
    `${m.videoId}  ${(m.durationSeconds / 60).toFixed(1)}min  flags ${m.flagRows}  ` +
      `recall ${pct(m.recallAnyInBudget)} (cat ${pct(m.recallCategoryInBudget)}; all ${pct(m.recallAnyAll)})  ` +
      `verify ${m.verifyCalls} (+${m.overflowCalls} over budget; NLI rows ${m.nliRows})  ` +
      `q ${m.pass1Questions}+${m.pass2Questions}  ${(m.wallMs / 1000).toFixed(1)}s  fence ${m.picketFence}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const params: FlagSpanParams = { ...DEFAULT_SPAN_PARAMS, ...args.params };
  if (args.out) fs.mkdirSync(args.out, { recursive: true });
  const results: VideoMetrics[] = [];

  // ---- offline: re-rank saved maps, no scorer.
  if (args.fromMaps) {
    for (const f of fs.readdirSync(args.fromMaps).filter((x) => x.endsWith('.json') && x !== 'report.json')) {
      const saved: SavedVideo = JSON.parse(fs.readFileSync(path.join(args.fromMaps, f), 'utf8'));
      if (args.videos.length && !args.videos.includes(saved.videoId)) continue;
      const r = rankFromRatingMap(saved.ratingMap, saved.sentences, saved.plan, params);
      const m = scoreVideo(saved.videoId, saved.sentences, saved.rows, r.windows, r.overflow, saved.stats);
      printVideo(m);
      results.push(m);
    }
    finish(results, args, params);
    return;
  }

  const dbs = args.dbs.length ? args.dbs : defaultLibraryDbs();
  if (!dbs.length) throw new Error('no library databases found; pass --db <path>');
  Logger.overrideLogger(['error', 'warn']);
  const server = new ScorerServerService();
  const ranker = new SnapFlagRanker(server);

  try {
    for (const dbFile of dbs) {
      const { copy, cleanup } = args.copy ? copyDatabase(dbFile) : { copy: dbFile, cleanup: () => undefined };
      const db = openReadOnly(copy, !args.copy);
      try {
        const rows = db.all<SectionRow>(
          `SELECT video_id, start_seconds, end_seconds, category, verdict, nli_score FROM analysis_sections ` +
            `WHERE (source = 'ai' OR source IS NULL) AND video_id IN ` +
            `(SELECT video_id FROM analysis_sections WHERE verdict = 'flag') ORDER BY video_id, start_seconds`,
        );
        const byVideo = new Map<string, SectionRow[]>();
        for (const r of rows) byVideo.set(r.video_id, [...(byVideo.get(r.video_id) ?? []), r]);
        let ids = [...byVideo.keys()];
        if (args.videos.length) ids = ids.filter((id) => args.videos.includes(id));
        ids = ids.slice(0, args.limit);
        console.log(`# ${dbFile}: ${ids.length} video(s) with verifier-confirmed flags`);

        for (const videoId of ids) {
          const t = db.all<{ srt_format: string | null }>(
            `SELECT srt_format FROM transcripts WHERE video_id = ${sqlQuote(videoId)}`,
          )[0];
          const sentences = t?.srt_format ? assembleSentences(parseSrt(t.srt_format)) : [];
          const vrows = byVideo.get(videoId) ?? [];
          if (!sentences.length) {
            console.log(`${videoId}  (no transcript; skipped)`);
            continue;
          }
          if (args.dryRun) {
            console.log(
              `${videoId}  ${sentences.length} sentences, ${(sentences[sentences.length - 1].end / 60).toFixed(1)} min, ` +
                `${vrows.filter((r) => r.verdict === 'flag').length} flag / ${vrows.filter((r) => r.verdict === 'skip').length} skip rows`,
            );
            continue;
          }
          const res = await ranker.rank(sentences, args.categories, {
            layout: args.layout,
            nonePosition: args.none,
            includeMisinformation: args.misinfo,
            params,
            batchSize: args.batch,
          });
          const m = scoreVideo(videoId, sentences, vrows, res.windows, res.overflow, res.stats);
          printVideo(m);
          results.push(m);
          if (args.out) {
            const saved: SavedVideo = {
              videoId,
              db: dbFile,
              sentences,
              rows: vrows,
              plan: res.plan,
              ratingMap: res.ratingMap,
              stats: res.stats,
            };
            fs.writeFileSync(path.join(args.out, `${videoId}.json`), JSON.stringify(saved));
          }
        }
      } finally {
        db.close();
        cleanup();
      }
    }
  } finally {
    await server.stop();
  }
  if (!args.dryRun) finish(results, args, params);
}

function finish(results: VideoMetrics[], args: Args, params: FlagSpanParams): void {
  const summary = summarise(results);
  console.log('\n# summary', JSON.stringify(summary, null, 2));
  if (args.out) {
    fs.writeFileSync(
      path.join(args.out, 'report.json'),
      JSON.stringify({ summary, params, layout: args.layout, none: args.none, videos: results }, null, 2),
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
}
