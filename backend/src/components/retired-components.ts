/**
 * One-time retirement of the components P7 removed.
 *
 * Builds before P7 installed whisper-cli, the llama runtime (llama-server and
 * its dylibs), whisper and llama GGUF models, the NLI flag-ranking Python
 * environment, and the scorer's own GGUF. This build uses none of them (AI runs
 * on Crucible), but an upgraded machine still has them on disk: often 20+ GB.
 *
 * WHAT IS REMOVED, AND HOW IT IS FOUND. Only paths the component manager itself
 * wrote, found the way it wrote them:
 *   - install records in components/installed.json whose id is a retired binary
 *     (`whisper`, `llama`) or whose kind is a retired model/env kind;
 *   - the fixed paths the old code used: components/<retired id>/, the old
 *     whisper catalog's filenames in models/whisper/, the scorer catalog's
 *     filenames in models/, and nli/ (only when it looks like the NLI env).
 * There are no globs. A path is only ever a target when it sits strictly inside
 * the Briefcase config dir, and never when it is, contains or sits inside a
 * component this build still uses (ffmpeg-tools, yt-dlp). A symlink is removed
 * as a link and never followed, and an old record that points anywhere else (a
 * hand-edited dir, an external volume) is left alone.
 *
 * WHEN. ComponentManagerService runs it once, in the background after boot,
 * never awaited by boot. It records completion in components/retired.json under
 * {@link RETIREMENT_ID}; a run with any failure is not recorded and is simply
 * tried again at the next launch (every step is idempotent).
 *
 * Plain functions over the filesystem (no Nest DI), so the dry-run script and
 * the tests call exactly what the service calls.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Bump to run a new retirement; the old id's record stays as history. */
export const RETIREMENT_ID = 'p7-crucible';

export const RETIREMENT_MARKER_FILE = 'retired.json';

/** Binary component ids P7 retired (the live binaries-v1 manifest still lists them). */
export const RETIRED_BINARY_IDS: readonly string[] = ['whisper', 'llama'];

/** Install-record kinds that only retired components used. */
export const RETIRED_RECORD_KINDS: readonly string[] = ['whisper-model', 'llama-model', 'python-env'];

/** The components this build still runs. Never touched. */
export const KEPT_COMPONENT_IDS: readonly string[] = ['ffmpeg-tools', 'yt-dlp'];

/** The old whisper catalog (config/model-catalog.ts WHISPER_MODELS), in <configDir>/models/whisper. */
export const RETIRED_WHISPER_MODEL_FILES: readonly string[] = [
  'ggml-tiny.bin',
  'ggml-base.bin',
  'ggml-small.bin',
  'ggml-medium.bin',
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3.bin',
];

/** The old scorer catalog (config/model-catalog.ts SCORER_MODELS), in <configDir>/models. */
export const RETIRED_SCORER_MODEL_FILES: readonly string[] = [
  'Qwen3.5-9B-BF16.gguf',
  'mmproj-Qwen3.5-9B-F16.gguf',
];

/** The old NLI component id (common/nli-env.ts NLI_COMPONENT_ID). */
export const RETIRED_NLI_COMPONENT_ID = 'nli-ranker';

export interface RetirementTarget {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  bytes: number;
  /** Which retired component it belonged to, in words. */
  reason: string;
}

export interface RetirementPlan {
  configDir: string;
  targets: RetirementTarget[];
  /** installed.json record ids to drop once their files are gone. */
  recordIds: string[];
  /** Directories the old code created, removed afterwards only if empty. */
  emptyDirs: string[];
  /** Things seen and deliberately left alone, with why. */
  skipped: Array<{ path: string; why: string }>;
  totalBytes: number;
}

export interface RetirementResult {
  removed: RetirementTarget[];
  bytesFreed: number;
  droppedRecords: string[];
  errors: Array<{ path: string; error: string }>;
}

interface Record_ {
  id?: string;
  kind?: string;
  dir?: string;
  entry?: string;
}

// ---------- layout ----------

export function retirementLayout(configDir: string) {
  const componentsDir = path.join(configDir, 'components');
  const modelsDir = path.join(configDir, 'models');
  return {
    componentsDir,
    installedPath: path.join(componentsDir, 'installed.json'),
    markerPath: path.join(componentsDir, RETIREMENT_MARKER_FILE),
    modelsDir,
    whisperModelsDir: path.join(modelsDir, 'whisper'),
    nliDir: path.join(configDir, 'nli'),
  };
}

// ---------- marker ----------

export function retirementDone(configDir: string, id: string = RETIREMENT_ID): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(retirementLayout(configDir).markerPath, 'utf8'));
    return Boolean(raw?.retirements?.[id]?.completedAt);
  } catch {
    return false;
  }
}

function recordRetirement(configDir: string, result: RetirementResult, now: Date): void {
  const { componentsDir, markerPath } = retirementLayout(configDir);
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(markerPath, 'utf8')) ?? {};
  } catch {
    raw = {};
  }
  raw.retirements = raw.retirements ?? {};
  raw.retirements[RETIREMENT_ID] = {
    completedAt: now.toISOString(),
    bytesFreed: result.bytesFreed,
    removed: result.removed.map((t) => ({ path: t.path, bytes: t.bytes, reason: t.reason })),
    droppedRecords: result.droppedRecords,
  };
  fs.mkdirSync(componentsDir, { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify(raw, null, 2), 'utf8');
}

// ---------- safety ----------

/** True when `child` is strictly inside `parent` (not equal, not outside). */
function isStrictlyInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

// ---------- sizing ----------

async function sizeOf(p: string): Promise<number> {
  const st = await fs.promises.lstat(p);
  if (!st.isDirectory()) return st.isSymbolicLink() ? 0 : st.size;
  let total = 0;
  const entries = await fs.promises.readdir(p);
  for (const name of entries) total += await sizeOf(path.join(p, name));
  return total;
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p);
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
    throw e;
  }
}

function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- plan ----------

function readRecords(installedPath: string): Record<string, Record_> {
  if (!fs.existsSync(installedPath)) return {};
  // A corrupt installed.json throws: the caller treats that as "try again later",
  // never as "no records".
  const parsed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  return parsed?.components && typeof parsed.components === 'object' ? parsed.components : {};
}

/**
 * Everything the retirement would remove, with sizes. Reads only; the dry run
 * is exactly this.
 */
export async function planRetirement(configDir: string): Promise<RetirementPlan> {
  const L = retirementLayout(configDir);
  const records = readRecords(L.installedPath);

  // Kept components' dirs: from their records, and their default location.
  const keptDirs = new Set<string>();
  for (const id of KEPT_COMPONENT_IDS) {
    keptDirs.add(path.resolve(path.join(L.componentsDir, id)));
    const dir = records[id]?.dir;
    if (typeof dir === 'string' && dir) keptDirs.add(path.resolve(dir));
  }

  const plan: RetirementPlan = {
    configDir,
    targets: [],
    recordIds: [],
    emptyDirs: [L.whisperModelsDir, L.modelsDir],
    skipped: [],
    totalBytes: 0,
  };
  const seen = new Set<string>();

  const consider = async (
    candidate: string,
    reason: string,
    expect: 'file' | 'dir',
    allowedParent: string,
  ): Promise<void> => {
    const abs = path.resolve(candidate);
    if (seen.has(abs)) return;
    if (!isStrictlyInside(abs, allowedParent) || !isStrictlyInside(abs, configDir)) {
      plan.skipped.push({ path: abs, why: `outside ${allowedParent}` });
      return;
    }
    for (const kept of keptDirs) {
      if (samePath(abs, kept) || isStrictlyInside(kept, abs) || isStrictlyInside(abs, kept)) {
        plan.skipped.push({ path: abs, why: `overlaps a component still in use (${kept})` });
        return;
      }
    }
    const st = await lstatOrNull(abs);
    if (!st) return;
    seen.add(abs);
    if (st.isSymbolicLink()) {
      plan.targets.push({ path: abs, type: 'symlink', bytes: 0, reason: `${reason} (a link; only the link is removed)` });
      return;
    }
    if (expect === 'file' && !st.isFile()) {
      plan.skipped.push({ path: abs, why: 'expected a file' });
      return;
    }
    if (expect === 'dir' && !st.isDirectory()) {
      plan.skipped.push({ path: abs, why: 'expected a directory' });
      return;
    }
    plan.targets.push({ path: abs, type: st.isDirectory() ? 'dir' : 'file', bytes: await sizeOf(abs), reason });
  };

  // 1. Retired binaries: whisper-cli, llama-server (+ their dylibs). A record's
  // dir is honoured only when it is the manager's own components/<id>.
  for (const id of RETIRED_BINARY_IDS) {
    const own = path.join(L.componentsDir, id);
    const rec = records[id];
    if (rec?.dir && !samePath(rec.dir, own)) {
      plan.skipped.push({ path: path.resolve(rec.dir), why: `record for ${id} points outside components/${id}` });
    }
    await consider(own, id === 'whisper' ? 'whisper-cli binaries' : 'llama runtime binaries', 'dir', L.componentsDir);
    if (rec) plan.recordIds.push(id);
  }

  // 2. Recorded models / envs (whisper models, llama and scorer GGUFs).
  for (const [id, rec] of Object.entries(records)) {
    if (RETIRED_BINARY_IDS.includes(id) || KEPT_COMPONENT_IDS.includes(id)) continue;
    if (!rec?.kind || !RETIRED_RECORD_KINDS.includes(rec.kind)) continue;
    if (rec.kind === 'python-env') {
      // The NLI env never had a file record; its dir is handled in step 4.
      plan.recordIds.push(id);
      continue;
    }
    if (typeof rec.dir !== 'string' || typeof rec.entry !== 'string' || !rec.entry) {
      plan.skipped.push({ path: String(rec.dir ?? id), why: `record ${id} has no dir/entry` });
      continue;
    }
    const allowed = rec.kind === 'whisper-model' ? L.whisperModelsDir : L.modelsDir;
    if (!samePath(rec.dir, allowed)) {
      plan.skipped.push({ path: path.resolve(rec.dir, rec.entry), why: `record ${id} is not in ${allowed}` });
      continue;
    }
    const reason = rec.kind === 'whisper-model' ? `whisper model (${id})` : `llama model (${id})`;
    await consider(path.join(rec.dir, rec.entry), reason, 'file', allowed);
    plan.recordIds.push(id);
  }

  // 3. Catalog files at their fixed paths, recorded or not (a hand-placed scorer
  // GGUF has no record).
  for (const f of RETIRED_WHISPER_MODEL_FILES) {
    await consider(path.join(L.whisperModelsDir, f), 'whisper model', 'file', L.whisperModelsDir);
  }
  for (const f of RETIRED_SCORER_MODEL_FILES) {
    await consider(path.join(L.modelsDir, f), 'scorer model', 'file', L.modelsDir);
  }

  // 4. The NLI Python env (venv, HF cache, worker.py), only when it looks like one.
  const nliStat = await lstatOrNull(L.nliDir);
  if (nliStat) {
    const looksLikeOurs =
      nliStat.isSymbolicLink() ||
      ['install.json', 'venv', 'worker.py'].some((n) => fs.existsSync(path.join(L.nliDir, n)));
    if (looksLikeOurs) {
      await consider(L.nliDir, 'NLI flag-ranking Python environment', 'dir', configDir);
    } else {
      plan.skipped.push({ path: L.nliDir, why: 'does not look like the NLI environment' });
    }
  }
  if (records[RETIRED_NLI_COMPONENT_ID] && !plan.recordIds.includes(RETIRED_NLI_COMPONENT_ID)) {
    plan.recordIds.push(RETIRED_NLI_COMPONENT_ID);
  }

  plan.totalBytes = plan.targets.reduce((n, t) => n + t.bytes, 0);
  return plan;
}

// ---------- execute ----------

/** Remove what the plan lists, drop the stale records, then prune empty dirs. */
export async function executeRetirement(plan: RetirementPlan): Promise<RetirementResult> {
  const L = retirementLayout(plan.configDir);
  const result: RetirementResult = { removed: [], bytesFreed: 0, droppedRecords: [], errors: [] };

  for (const t of plan.targets) {
    try {
      if (t.type === 'dir') {
        await fs.promises.rm(t.path, { recursive: true, force: true });
      } else {
        // A file or a symlink: unlink never follows the link.
        await fs.promises.unlink(t.path).catch((e: any) => {
          if (e?.code !== 'ENOENT') throw e;
        });
      }
      result.removed.push(t);
      result.bytesFreed += t.bytes;
    } catch (e: any) {
      result.errors.push({ path: t.path, error: e?.message ?? String(e) });
    }
  }

  // Drop a record only when its files are gone. Synchronous read-modify-write,
  // so it cannot interleave with an install recording itself.
  if (plan.recordIds.length > 0) {
    try {
      const raw = JSON.parse(fs.readFileSync(L.installedPath, 'utf8'));
      const comps = raw?.components ?? {};
      for (const id of plan.recordIds) {
        if (!comps[id]) continue;
        const rec = comps[id] as Record_;
        const owned =
          rec.kind === 'binary'
            ? path.join(L.componentsDir, id)
            : rec.kind === 'python-env'
              ? L.nliDir
              : rec.dir && rec.entry
                ? path.resolve(rec.dir, rec.entry)
                : null;
        if (owned && existsNoFollow(owned)) continue;
        delete comps[id];
        result.droppedRecords.push(id);
      }
      if (result.droppedRecords.length > 0) {
        fs.writeFileSync(L.installedPath, JSON.stringify(raw, null, 2), 'utf8');
      }
    } catch (e: any) {
      result.errors.push({ path: L.installedPath, error: e?.message ?? String(e) });
    }
  }

  for (const dir of plan.emptyDirs) {
    try {
      const st = await lstatOrNull(dir);
      if (st?.isDirectory() && (await fs.promises.readdir(dir)).length === 0) {
        await fs.promises.rmdir(dir);
      }
    } catch {
      // A dir that is not empty or not ours is simply left.
    }
  }
  return result;
}

/**
 * Plan, execute and record once. Never throws: a failure is logged and the run
 * is retried at the next launch.
 */
export async function retireOnce(
  configDir: string,
  log: { log: (m: string) => void; warn: (m: string) => void },
  now: () => Date = () => new Date(),
): Promise<RetirementResult | null> {
  try {
    if (retirementDone(configDir)) return null;
    const plan = await planRetirement(configDir);
    for (const s of plan.skipped) log.warn(`[retire] left alone: ${s.path} (${s.why})`);
    const result = await executeRetirement(plan);
    for (const t of result.removed) log.log(`[retire] removed ${t.reason}: ${t.path} (${formatBytes(t.bytes)})`);
    if (result.errors.length > 0) {
      for (const e of result.errors) log.warn(`[retire] could not remove ${e.path}: ${e.error}`);
      log.warn(`[retire] incomplete (${result.errors.length} failed); will try again next launch`);
      return result;
    }
    recordRetirement(configDir, result, now());
    log.log(
      result.removed.length > 0
        ? `[retire] retired components removed: ${result.removed.length} item(s), ${formatBytes(result.bytesFreed)} freed`
        : '[retire] no retired components on disk',
    );
    return result;
  } catch (e: any) {
    log.warn(`[retire] skipped this launch: ${e?.message ?? e}`);
    return null;
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
