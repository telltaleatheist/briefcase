# Briefcase — Bug Search Report

**Date:** 2026-07-12
**Scope:** Full-codebase correctness audit — `backend/` (database, library, queue, path, ffmpeg, media, downloader, web-archive, analysis, bridges, components, config, common), `electron/` (main, preload, IPC, services), `frontend-v3/` (services + high-traffic components/pages).
**Method:** Six parallel deep-read audits, one per subsystem. Each finding was traced to real source. Every **CRITICAL** below was additionally re-verified by hand while writing this report. Style/formatting/naming issues were deliberately excluded — only defects that can cause wrong behavior, crashes, hangs, data loss, or corruption.

> **Caveat:** These are static-analysis findings. A handful of "always fails" claims depend on runtime state (which ingestion path ran first, which model is selected). Confirm the specific reproduction before shipping a fix. Line numbers are from the current `main` (HEAD `3529d30`).

---

## Executive summary

| Severity | Count (approx) | Character |
|---|---|---|
| Critical | 4 | Data corruption / total feature failure on common paths |
| High | ~22 | Broken core flows, data loss, security exposure |
| Medium | ~35 | Wrong output, leaks, UX-breaking races |
| Low | ~30 | Edge cases, cosmetic drift, latent traps |

### Fix these first (ranked by blast radius)

1. **Shared SQLite connection is swapped mid-operation** → concurrent queue jobs read/write the *wrong library's* database. Silent cross-library data corruption. (`B-1`)
2. **Late-mounting external volume creates a phantom empty library on the boot disk** → user sees an empty library; later writes land on the shadow copy. Root cause of several data-loss reports. (`B-2`) — *directly relevant: the active library lives on `/Volumes/Callisto`, which mounts late at login.*
3. **Fresh-install analysis config is written in the wrong shape** → every AI analysis throws "No analysis categories configured" until the user manually re-saves categories. (`A-1`)
4. **Cancelling a job never kills the running yt-dlp/ffmpeg/whisper process** → cancelled downloads/encodes run to completion, burning disk + CPU, and can exceed the concurrency limit. Business-critical for a constant-download workflow. (`M-1`)
5. **`file_hash` is computed by two incompatible algorithms** depending on ingestion path → dedup silently fails and files get re-added as duplicates / marked unlinked. (`B-4`)
6. **Shell injection across four command-builders** (Finder reveal, QuickTime open, Reddit mux, component extract) via filenames/URLs derived from untrusted video titles and remote manifests. (`SEC` theme)

---

## Systemic patterns

These recur across subsystems; fixing the pattern once (a shared helper) is better than patching each site.

- **SEC — Shell string interpolation → injection.** Commands built by interpolating paths/URLs into a `sh -c` string. Sites: `electron/ipc/ipc-handlers.ts:139` & `:170-174`; `backend/src/path/path.service.ts:138,141,144`; `backend/src/downloader/downloader.service.ts:1546,1577`; `backend/src/components/component-manager.service.ts:319,332,343`. **Fix pattern:** `execFile`/`spawn`/`execFileSync` with an argv array — never a shell string. Filenames come from YouTube titles and remote GitHub manifests, so this is a live surface, not theoretical.
- **PROC-KILL — Cancellation/abort doesn't actually terminate children.** Cancel only flips a flag or frees a pool slot; the subprocess keeps running (and its partial DB writes persist). Sites: `queue-manager.service.ts:417-446,157-192`; `downloader.service.ts:757-835,836-1078`; POSIX SIGTERM-without-SIGKILL in `ffmpeg-bridge.ts:475`, `whisper-bridge.ts:505`, `ytdlp-bridge.ts:471`, `llama-bridge.ts:335`.
- **NO-TIMEOUT — Child processes / fetches with no hard timeout.** A wedged tool hangs the (serialized) pipeline forever. Sites: `ffprobe-bridge.ts:83-135`, ffmpeg/whisper bridges, Ollama `fetch` in `ai-provider.service.ts:301-320`, llama idle-vs-request timer collision `llama-bridge.ts:61,65,370`.
- **NO-TXN — Multi-step writes without a spanning transaction.** Base row + FTS mirror + denormalized `has_*` flag (or physical rename + N DB updates) run as separate autocommits; a mid-sequence throw leaves the DB inconsistent. Sites: `database.service.ts` insertVideo/insertTranscript/insertAnalysis; controller rename/import flows; `library-migration.service.ts:100-164`.
- **TEMP-COLLIDE — Timestamp-only temp filenames.** `${Date.now()}-${basename}` collides for concurrent same-name operations. Sites: `common/utils/temp-file.util.ts:67`, `downloader.service.ts:1466`, `clip-extractor.service.ts:389`. (`whisper.service.ts` already does it right with `crypto.randomBytes` — copy that.)
- **WS-DUP — WebSocket handler accumulation.** Duplicate `connect()` and discarded unsubscribe functions register the same event callbacks multiple times → duplicate refreshes/notifications, stale-closure leaks. Sites: `websocket.service.ts:160`, `library-page.component.ts:569-637`, plus the double `UpdateService` in `electron/main.ts:193` + `ipc-handlers.ts:55`.
- **FAIL-AS-SUCCESS — Failure states that render as success.** First-run wizard shows "All set" after a failed binary download; corrupt/truncated model downloads recorded as installed; delete→undo reports "Restored" after losing most related rows. Sites: `setup-wizard.component.ts:287-293`, `component-manager.service.ts:482-509`, `database.controller.ts:2648-2701`.

---

## Backend — database / library / queue / path

### Critical

**B-1 — Singleton DB connection swapped mid-operation → cross-library corruption.**
`queue/queue-manager.service.ts:669-676` (confirmed) calls `switchLibrary(job.libraryId)`, which mutates the single `DatabaseService.db` handle. The main pool runs up to 5 concurrent tasks. When two in-flight jobs target different libraries, task A's reads/writes (during an `await`) land in library B's DB after B switched the connection. `transferVideos` (`library-manager.service.ts:743-957`) and `relinkByHash` (`relinking.service.ts:119-232`) flip the connection per-item, so any concurrent request hits whichever DB is momentarily loaded. **Fix:** serialize library-scoped work, or capture a per-operation connection/identity and refuse to run if the active library changed.

**B-2 — Late-mounting external volume → phantom library on the boot disk.**
`database/database.service.ts:299-305` (confirmed): `if (!existsSync(parentDir)) mkdirSync(parentDir,{recursive:true})` then `new Database(dbPath)`. If `/Volumes/Callisto` hasn't mounted, this *recreates the library tree on the boot disk under the mount point* and opens a fresh empty DB there; the real volume then mounts beside it (`/Volumes/Callisto-1`). User sees an empty library; subsequent writes hit the phantom copy. The guard `isLibraryPathAvailable` (`library-manager.service.ts:590`) exists but is only wired to the startup path. **Fix:** stat a sentinel *inside* the library (not just the folder) before auto-creating parents; throw when the expected external root is absent.

### High

**B-3 — Every non-startup DB entry point bypasses the mount guard.** `database.controller.ts:3954` (importFiles), `:4216` (uploadFiles); `library-migration.service.ts:40`; `library-manager.service.ts:432/407/343/573` (switch/open/create/init). Same phantom-dir mkdir as B-2, on the import/migration/switch hot paths. **Fix:** route all through the availability guard.

**B-4 — `file_hash` computed by two incompatible algorithms.** `database.service.ts:2638-2650` (`hashFile` = SHA-256 of first 1 MB) vs `file-scanner.service.ts:1008-1046` (`quickHashFile` = SHA-256 of size + begin/mid/end samples). `scanClipsFolder` writes/looks up with the former; `importVideos`/`checkDuplicates` with the latter. They never match for the same file → moved imports get marked unlinked *and* re-added as duplicates; re-imports of scan-added videos evade dedup. **Fix:** one hashing function everywhere `file_hash` is written or compared.

**B-5 — `updateVideoPath` silently nulls `upload_date` when the arg is omitted.** `database.service.ts:2838-2845` runs `upload_date = ?` with `uploadDate || null`. Callers `database.controller.ts:2889/4096/4114` pass no date (relink), and `file-scanner.service.ts:180` passes `undefined` when a moved file's name has no parseable date. A routine scan/relink permanently erases a good upload date — load-bearing for date-organized libraries. **Fix:** COALESCE / conditional SQL so the date only updates when provided; pass the existing date at call sites.

**B-6 — Command injection in `openFileLocation`.** `path/path.service.ts:138,141,144` interpolate filenames into `open -R "…"` / `explorer /select,"…"` / `xdg-open "…"` through a shell. A file named `x$(rm -rf ~).mp4` executes on Finder-reveal. **Fix:** `execFile`/`spawn` with argv. (Part of the SEC theme.)

**B-7 — Nested migration abort-throw swallowed by outer catch → boots on broken schema.** `database.service.ts` inner throws at `:897`/`:1448`/`:1471` are downgraded to `logger.warn/error` at `:905`/`:1478` (no re-throw). The `video_tab_items` rebuild (`:1408-1441`, `DROP TABLE` at `:1431`) is not wrapped in a transaction. A failed/destructive migration is reduced to a log line; a crash mid-rebuild loses the table with no rollback. **Fix:** re-throw non-benign errors; wrap the rebuild in `db.transaction`.

**B-8 — `library-migration` marks a partial conversion complete.** `library-migration.service.ts:47-64`: `copyFileSync(old,new)` runs before `await convertPathsToRelative(new)`. A throw/crash in between leaves `new` with absolute paths; the next run sees it exists, logs "already migrated," never converts → paths don't resolve. **Fix:** convert into a temp file and atomically rename on success.

### Medium (condensed)

| ID | File:line | Bug |
|---|---|---|
| B-9 | `database.service.ts:305` | `initializeDatabase` never closes the previous handle → fd/WAL-lock leak on every library switch (amplified by `transferVideos`). |
| B-10 | `database.service.ts` ~2715 / ~3418 / ~3485 | insertVideo/Transcript/Analysis: base insert + FTS mirror + `has_*` flag are separate autocommits → index/flag drift on partial failure. (NO-TXN) |
| B-11 | `database.controller.ts:1336-1352` | HTTP Range broken: `bytes=-500` → `start=NaN` → 500; end past EOF not clamped → client stall; `start>size` no `416`. |
| B-12 | `database.controller.ts:2554-2701` | Delete+undo restores only `{video,transcript,tags}`; analysis/sections/markers/chapters/mute/relationships lost but reports "Restored". |
| B-13 | `database.controller.ts:4083-4163`, `:3596-3644` | Import dedup is check-then-insert across an `await` → concurrent imports of one file insert twice. Needs unique index or in-txn check. |
| B-14 | `database.controller.ts:1783/1968/1622` | Rename = `fs.rename` + 3-4 separate DB writes, no spanning txn → filename/current_path disagree on partial failure. (NO-TXN) |
| B-15 | `library-migration.service.ts:100-164` | Bulk path rewrite not transactional → half-relative/half-absolute DB on crash. |
| B-16 | `relinking.service.ts:414`, `library-manager.service.ts:179` | Live-DB backup copies only main file (no WAL checkpoint / `-wal`/`-shm`) → backup misses committed rows. |
| B-17 | `relinking.service.ts:296/304/148` | Filename-fallback relink keyed on basename only, no size/hash check → row relinked to wrong same-named clip. |
| B-18 | `ignore.service.ts:109-113` | Re-reads ignore file per scanned file; read failure (volume unmounted) returns `[]` → `.DS_Store`/`*.db`/`._*` imported as media. |
| B-19 | `file-scanner.service.ts:474-535,551-610` | `populateMissing*` test *relative* `current_path` against CWD → `existsSync` false for every video → backfill silently no-ops. |
| B-20 | `queue-manager.service.ts:431,157-192` | Cancel/watchdog frees the pool slot without killing the process → concurrency exceeded (2 analyses on the 1-slot pool) + partial writes persist. (PROC-KILL) |
| B-21 | `migration.service.ts:274-296` | Legacy re-import inserts sections with fresh UUIDs, no dedup, marker written only after full loop → partial-fail re-run duplicates sections. |

### Low (condensed)

`getAllVideos` OFFSET-without-LIMIT SQLite syntax error (`database.service.ts:3345`) · `addVideoToTab` catches a UNIQUE error but no unique index exists → duplicate tab items (`:5417`) · `getAllVideosHierarchical` hardcodes child `has_transcript/has_analysis = 0` (`:3388`) · thumbnail unlinked before delete txn → rollback leaves live video with no thumb (`:3154/:3198`) · `INSERT OR REPLACE` on videos PK could cascade-delete children (`:2716`, latent) · dotless filename → ext = last char (`:2708/:959`) · unvalidated `parseInt` query params flow into LIMIT/slice (`database.controller.ts:549/504/1409`) · `deleteAnalysisSection` returns success on no-match & skips fallback on throw (`:845`) · `clip-extractor` colliding `processId` (`:389`) and dropped `scale` when combined with `stripBlackBars` (`:323-353`) · `relink.service.ts:274` empty-title `''.includes('')` → 0.9 confidence auto-relink · `startsWith` prefix matching without separator boundary (multiple files) · `library.service.ts:157-172` read-outside-lock lost update (legacy).

---

## Backend — AI analysis / bridges / components / config

### Critical

**A-1 — Fresh-install analysis config written in the wrong shape → every analysis fails.** (confirmed) `analysis.service.ts:1760-1764` seeds `analysis-categories.json` with `JSON.stringify(DEFAULT_CATEGORIES)` — a **bare array** (`prompts/analysis-prompts.ts:27` = `AnalysisCategory[]`). `loadCategories()` at `:112-119` reads `parsed.categories` and throws "No analysis categories configured" when absent. On first run — or after `POST /config/analysis-categories/reset` deletes the file (`config.controller.ts:257`) — every analysis aborts until the user manually re-saves categories (the only writer of the correct `{categories:[…]}` shape). `analysis.controller.ts:575/602/632` also write the bare-array shape. **Fix:** write/seed `{ categories: DEFAULT_CATEGORIES }` everywhere via one shared helper.

### High

**A-2 — o1 models rejected by `max_tokens`.** `config.controller.ts:441-450` whitelists `o1`/`o1-mini`/`o1-preview`, but `ai-provider.service.ts:238` sends `max_tokens: 4096`; o1-family requires `max_completion_tokens` → HTTP 400 on every call. Same failure class as the known "no temperature to Claude/OpenAI" rule. **Fix:** use `max_completion_tokens` or drop o1 from the whitelist.

**A-3 — `activeJobs` double-decrement → negative → concurrency invariant broken.** `analysis.service.ts:470-477` (catch decrements then rethrows) + `:284-307` (caller's `.catch` decrements again). Each failed job leaks −1; once negative, `MAX_CONCURRENT_JOBS=1` is defeated and whisper + LLM run concurrently, contending for GPU/RAM. **Fix:** decrement in exactly one place.

**A-4 — llama `stopServer` kill race.** `llama-bridge.ts:335-342`: the 5s SIGKILL fallback checks `this.serverProcess`, nulled synchronously at `:342`, so a wedged server is never force-killed (orphan holds port 8081); and because `startServer` calls `stopServer` then respawns after 1s (`:172-176`), the stale timer fires ~4s into the *new* server and SIGKILLs it. **Fix:** capture a local `const proc = this.serverProcess` and act on it.

**A-5 — Concurrent same-id download corruption.** `component-manager.service.ts:247-252` and `model-manager.service.ts:283-285` only reject a *different* in-flight id; a double-click starts a second stream writing the same file → interleaved bytes. `model-manager` also clears `activeDownload` before a 5s retry sleep (`:472`). **Fix:** reject whenever any download is active.

**A-6 — Corrupt download accepted as success.** `component-manager.service.ts:482-509`, `model-manager.service.ts:291-334`: resume sends `Range: bytes=N-` + `flags:'a'` but never checks for HTTP 206 — a 200 full-body reply gets *appended* to the partial file. Cogito GGUFs and whisper medium/large have empty `sha256` (`model-catalog.ts:197-211`), and there's no final size-vs-`artifact.bytes` assertion, so a truncated/corrupt model is recorded installed. **Fix:** require 206 on resume (else restart at 0); assert final size when known. (FAIL-AS-SUCCESS)

**A-7 — Rename drops text after any dot in the title.** `common/utils/filename-date.util.ts:361-364`: `getExtension()` takes everything after the last dot with no validation; `updateTitle('… Video.mp4','Top 10.5 Moments')` → `… Top 10.mp4`. Silent data loss on titles containing dots. **Fix:** only treat a trailing `\.[A-Za-z0-9]{1,5}$` (no spaces) as an extension.

### Medium (condensed)

| ID | File:line | Bug |
|---|---|---|
| A-8 | `analysis.service.ts:1242` | `description: chapter.description` but `Chapter` has `summary` → every AI chapter summary persisted as NULL. |
| A-9 | `ai-provider.service.ts:301-320` | Ollama `/api/generate` fetch has no timeout → wedged Ollama blocks the serialized pipeline forever. (NO-TIMEOUT) |
| A-10 | `simple-transcribe.controller.ts:103` | `transcribeVideo(path,jobId)` drops the `model` arg → uses default model but records the *requested* model → wrong-quality transcript + falsified metadata. |
| A-11 | `llama-bridge.ts:250-262` | Ready markers matched against a single chunk, not `startupBuffer` → line split across reads → 120s hang then false failure. |
| A-12 | `bridges/gpu-info.ts:56-60` | Windows WMI `AdapterRAM` is uint32 (~4GB cap); big GPUs report wrapped/negative → treated as absent → CPU-only `-ngl 0`. |
| A-13 | `common/utils/temp-file.util.ts:267-286` | `cleanupTempFiles` deletes by `includes(sourceFileName)`; substring match hits other jobs, empty name matches everything → clobbers concurrent downloads. |
| A-14 | `component-manager.service.ts:319,332,343` | `execSync` tar/xattr with interpolated manifest `file`/`id` (remote) → shell injection. (SEC) |
| A-15 | `filename-date.util.ts:369-372` | `formatUploadDate` returns *today* when yt-dlp date is malformed → silently mis-dates downloads. |
| A-16 | `bridges/ffprobe-bridge.ts:83-135` | No timeout on ffprobe child; corrupt input hangs the promise forever, wedging import/metadata. (NO-TIMEOUT) |
| A-17 | `llama-bridge.ts:61,65,370` | Idle timer (5m) == request timeout (5m), reset only at generation start → idle timer can tear down the server mid-request. |

### Low (condensed)

`extractJsonFromResponse` brace-counting ignores braces inside string values → truncates valid JSON (`ai-analysis.service.ts:193`) · title cleanup `split('.')[0]` mangles "$3.5 million" (`:1712/1811`) · non-Cogito GGUF gets `-ngl 0` on CUDA (`llama-manager.ts:168`) · ytdlp stdout progress split per-chunk drops updates (`ytdlp-bridge.ts:220`) · POSIX abort SIGTERM-only, no SIGKILL escalation (`ffmpeg-bridge.ts:475`, `whisper-bridge.ts:505`) (PROC-KILL) · missing `content-length` → progress stuck / `"Infinityh"` ETA (`component-manager.service.ts:500`) · timestamp-only temp names collide (`temp-file.util.ts:67`) (TEMP-COLLIDE) · `isValidDateFormat` accepts 2025-02-30 (`filename-date.util.ts:197`).

**Rule checks (both currently upheld):** cloud providers send no temperature/sampling params (`ai-provider.service.ts`); zero-successful-chapters throws (`ai-analysis.service.ts:727-734`). A-2 is the same *class* of param-mismatch failure via `max_tokens`.

---

## Backend — media pipeline (ffmpeg / downloader / whisper / web-archive)

### High

**M-1 — Cancelling a job never kills the child process.** `queue-manager.service.ts:417-446` (`cancelJob` only adds to `cancelledJobs` and flips status) + `:704-710` (result discarded after the fact). It never calls `downloaderService.cancelDownload` / whisper cancel / ffmpeg abort. A cancelled yt-dlp/ffmpeg/whisper runs to completion (full file downloaded, full CPU spent); only the DB result is dropped. `downloader.controller.ts` exposes no cancel endpoint, so `cancelDownload` (`downloader.service.ts:1153`) is dead. **Fix:** in `cancelJob`, invoke the active task's process-abort by pool/type. (PROC-KILL — see also B-20.)

**M-2 — Downloader fallback loops swallow the cancel and spawn fresh processes.** `downloader.service.ts:757-835` (YouTube client loop) & `:836-1078` (non-YouTube chain): the abort throw is caught, recorded as `lastError`, and the loop `continue`s to the next client/extractor, each spawning a *new* process. `run()` also resets `this.aborted=false` (`yt-dlp-manager.ts:163`). Even after M-1 is fixed, cancel isn't honored between attempts. **Fix:** check a persistent cancelled flag before each attempt; stop resetting `aborted` inside `run()`.

### Medium (condensed)

| ID | File:line | Bug |
|---|---|---|
| M-3 | `downloader.service.ts:1546,1577` | Reddit HLS→ffmpeg/mux via `execSync` string: default 1 MB `maxBuffer` → `ENOBUFS` on long muxes fails a successful download; `"`/`$`/backtick in the folder path breaks quoting; injection surface. (SEC) |
| M-4 | `downloader.service.ts:1890` | Reddit image `path.extname(imageUrl)` keeps the `?query` → filename like `Title.jpg?width=640…` → breaks extension-based image detection (`:1088`). |
| M-5 | `ffmpeg.service.ts:417-437` | Normalize/compress branch references `[0:a]` unconditionally → filtergraph aborts on videos with no audio; a valid silent video fails to re-encode. |
| M-6 | `common/utils/temp-file.util.ts:67`, `downloader.service.ts:1466` | Timestamp-only temp names collide for concurrent same-name ops → overwritten/corrupt output. (TEMP-COLLIDE) |

### Low (condensed)

Whisper extract progress handler not scoped by `processId` → cross-talk (`whisper.service.ts:143`) · `lastReportedProgress` map never pruned → slow leak (`ffmpeg.service.ts:27`) · image-download redirects not drained / no depth cap → socket leak + infinite recursion (`downloader.service.ts:1908,2090`) · POSIX abort SIGTERMs yt-dlp only, orphaning its ffmpeg merge child (`ytdlp-bridge.ts:471`) (PROC-KILL).

**Verified clean:** ytdlp-bridge drains stdout + stderr (no pipe deadlock); `atomicReplaceFile`/`copyFromTemp` backup-restore is safe; the "no silent fallback" guards in `generateWaveform`/`getVolumeLevel`/`detectAudioStart` correctly throw; `determineOutputFile` refuses to guess under concurrent same-folder downloads.

---

## Electron — main process / IPC / preload

### High

**E-1 — Shell injection / broken open for filenames with quotes.** `ipc/ipc-handlers.ts:139` (`open -a "QuickTime Player" "${filePath}"`) and `:170-174` (`open-files`, `map(p => "${p}").join(' ')`) run through `exec`. `"` is legal in macOS filenames (yt-dlp titles), so a name with `"`/`$()`/backticks breaks quoting or executes shell. **Fix:** `execFile('open', ['-a','QuickTime Player', filePath])` / `shell.openPath`. (SEC)

### Medium (condensed)

| ID | File:line | Bug |
|---|---|---|
| E-2 | `preload.ts` (no `openExternal`) vs `electron.service.ts:198` | `window.electron.openExternal` undefined → every AI-wizard external link throws; `window.open` fallback has no `setWindowOpenHandler` → opens remote content in-app / CSP-blocked. |
| E-3 | `window-service.ts:627-629` | `setTimeout(() => editorWindow.webContents.send(...),500)` unguarded; closing the editor within 500ms throws "Object destroyed" → `uncaughtException` → `gracefulExit(1)` force-quits the whole app. |
| E-4 | `main.ts:193` + `ipc-handlers.ts:55` | Two `UpdateService` instances → autoUpdater listeners registered twice → duplicate update events; split responsibilities. (WS-DUP) |

### Low (condensed)

`get-app-version` invoked in preload but never handled → version always "unknown" (`preload.ts:87`) · backend-error window `process.exit(0)` bypasses `gracefulExit`/shutdown → may orphan backend (`window-service.ts:481`) · dead exposed methods `get-binary-paths` + `*-path-config` have no handlers (`preload.ts:88,104-121`) · no `unhandledRejection` handler → fire-and-forget IIFEs (e.g. `main.ts:224`) can terminate without cleanup · web-capture leaks a `session.fromPartition` per capture (`web-capture-service.ts:89`) · `copy-files-to-clipboard` uses single-URL `public.file-url` for multiple files, unencoded (`ipc-handlers.ts:119`).

**Note (hardening, not a bug):** `nodeIntegration:true` on main/editor windows (`window-service.ts:75,182,597`) is unnecessary and risky (mitigated by `contextIsolation:true`); no `setWindowOpenHandler`/`will-navigate` guard exists (compounds E-2).

---

## Frontend — services (Angular / RxJS)

### High

**FS-1 — Duplicate WebSocket connection registers every handler twice.** `websocket.service.ts:160-316`: `connect()` guards only on `socket?.connected`. `QueueService` ctor (`queue.service.ts:959`) and `LibraryPage.ngOnInit` (`library-page.component.ts:541`) both fire at startup while the socket is mid-handshake (`connected===false`), so `connect()` runs twice; socket.io v4 returns the *same* cached Socket, binding every `task.completed`/`task.failed`/`video-added`/`component.download.*` handler twice → duplicate notifications, double refreshes, potential double `video-added` inserts. **Fix:** guard on `if (this.socket) return` (existence), or `removeAllListeners()` before re-creating. (WS-DUP)

### Medium / Low (condensed)

| ID | File:line | Bug |
|---|---|---|
| FS-2 | `export-queue.service.ts:142-162` | End-of-run summary reads cumulative `completedCount()/failedCount()` (completed jobs never auto-cleared) → toast reports totals across batches ("2 exported" when 1 ran). |
| FS-3 | `notification.service.ts:180-182` | `getUnreadCount()` returns a fresh `BehaviorSubject().asObservable()` → emits once, never updates. (Currently no callers — latent.) |
| FS-4 | `notification.service.ts:165-201` | mark/delete/add mutate in place then re-emit the *same* array ref → OnPush `@Input` consumers don't re-render. |
| FS-5 | `queue.service.ts:811,912` | `job.backendJobId = undefined` mutates the old ref after `updateJobState` replaced the job in the signal → stale `backendJobId` persisted. (Harmless today.) |
| FS-6 | `tabs.service.ts:54-64` | `refreshTabbedVideoIds()` fires at call time while `tabs.set()` fires on subscription → two states can momentarily disagree / double-fetch. |

**Verified clean:** `runtime-url.ts` dynamic-port URL building; `analysis-queue`/`processing-queue`/`video-manager`/`library-filter`/`transcript-search`/`database-library` update immutably; `QueueService.restoreFromBackend()` serializes refreshes and deliberately doesn't touch job state on a backend hiccup.

---

## Frontend — components / pages

### High

**FC-1 — Date field-name mismatch overwrites real dates.** `video-info-page.component.ts:355-356` reads camelCase `video.uploadDate`/`downloadDate`, but the backend returns snake_case (`upload_date`/`download_date`; sibling lines 348/357 use the dual fallback). So uploadDate always shows "Not set" and downloadDate always shows *today*; the date editor seeds from these, and Save PATCHes today over the real download date and `null` over the real upload date. **Fix:** `video.upload_date ?? video.uploadDate`, etc.

**FC-2 — First-run wizard shows "All set" after a failed binary download.** `setup-wizard.component.ts:287-293`: `essentialPending()` checks only `queued|downloading`. A `failed` ffmpeg/yt-dlp download flips it false → green "You're ready to go" with Open enabled → user lands in an app where every download/transcode fails, no error shown. **Fix:** treat a failed essential as blocking + offer retry. (FAIL-AS-SUCCESS)

**FC-3 — Cross-collection drag loses items on partial failure.** `tabs-tab.component.ts:455-460`: awaits `removeVideoFromTab` for each video *first*, then `addVideosToTab`. If the add fails, videos are already gone from the source and never reach the target — dropped from both. Business-critical (run-of-show). **Fix:** add to target first, remove from source only after success.

**FC-4 — Editor tab state bleed (mute sections).** `video-player.component.ts:3050-3067`/`:3074+`: `saveCurrentTabState`/`restoreTabState` never persist/restore `muteSections` (the field exists on `EditorTab` but is never written/read). Switching back to a loaded tab keeps the *previous* tab's mute sections → auto-mute mutes the wrong ranges and resize/delete calls the API with the other video's `videoId`. **Fix:** include `muteSections` in save/restore + window-transfer payload.

**FC-5 — Async/teardown race across editor tabs.** `video-player.component.ts:2844` (also 2815, 2763): `loadWaveformFromServer`/`generateQuickClientWaveform` call `waveformData.set(...)` on completion with no active-video check → switching tabs mid-load lets tab A's waveform overwrite tab B's and get persisted into B. **Fix:** bail if `videoId() !== videoId`, or cancel in-flight loads on switch.

**FC-6 — Library-page WebSocket callback accumulation.** `library-page.component.ts:569-637` registers 7 `websocketService.on*()` handlers and discards their unsubscribe fns; `ngOnDestroy` (`:1589`) only calls `disconnect()`, which nulls the socket but never clears the singleton's callback arrays. The component is destroyed/recreated on `/settings` round-trips → after N trips, each task completion fires N reloads + N toasts, with stale closures pinning dead instances. **Fix:** store and call the unsubscribe fns in `ngOnDestroy`. (WS-DUP)

**FC-7 — Cascade has no `ngOnDestroy`; leaks on teardown mid-drag.** `cascade.component.ts:1825` (16ms auto-scroll `setInterval`), `:1749-1750` (document mousemove/mouseup), torn down only in `onDragSelectEnd`. Route change mid-marquee-drag leaves the interval scrolling + setting signals on a dead component forever, plus two permanent document listeners. **Fix:** add `ngOnDestroy` calling `stopAutoScroll()` + removing the listeners.

**FC-8 — Queue-config modal submits an empty AI model.** `queue-item-config-modal.component.ts:533-540` (+ `toggleTask` 446-463): enabling AI Analyze seeds `config.aiModel` but not the `selectedAIModel` signal the dropdown binds; `onSave` then overwrites `aiTask.config.aiModel` with the empty signal. Apply is only disabled on zero tasks → a task with empty `aiModel` submits and breaks analysis. **Fix:** seed `selectedAIModel`; don't overwrite with empty; block Apply when ai-analyze has no model.

### Medium (condensed)

| ID | File:line | Bug |
|---|---|---|
| FC-9 | `cascade.component.ts:931-944` | `getSelectedVideos` resolves against expanded weeks only → bulk delete/analyze silently skips selected videos in collapsed weeks (count badge still includes them). |
| FC-10 | `cascade.component.ts:72-82` | `weeks` setter forces `expanded:true` on every parent emission → progress-driven refreshes re-expand what the user collapsed. |
| FC-11 | `video-player.component.ts:473` + `models/video-editor.model.ts:208` | Default `volume: 3.5` while model documents `0-1` → every video opens at 350% gain (clipping), UI shows "350%". |
| FC-12 | `video-player.component.ts:2800` | Waveform-progress `setInterval` is a local var, not cleared on destroy → closing editor mid-generation leaves a 1s HTTP poll running forever. |
| FC-13 | `video-player.component.ts:192,241-265` | Single-letter shortcuts (`f/l/j/a/r/m`) don't exclude meta/ctrl + `preventDefault()` → Cmd+R/Cmd+A/Cmd+F swallowed. |
| FC-14 | `video-player.component.ts:1630` | `increasePlaybackSpeed` while paused calls `startPlayback()` without setting `isPlaying` → video scrubs while UI shows paused. |
| FC-15 | `video-player.component.ts:2639/2545` | `isRestoringTab` cleared only in `onVideoDurationChange`; on a media error (the `(error)` output isn't even bound) the flag sticks → playhead frozen for all later tabs. |
| FC-16 | `tabs-tab.component.ts:398-418` | `removeVideosFromCurrentTab` removes a video from *every* tab containing it → in all-collections view a multi-collection video is stripped from all. |
| FC-17 | `tabs-tab.component.ts:138,357` | Renders `H:MM:SS` with unpadded hours → violates the project `HH:MM:SS` convention. |
| FC-18 | `video-timeline.component.ts:826,840` | Zoom/pan computed from committed state while `scheduleUpdate` defers to rAF keeping only the last value → multiple wheel deltas per frame collapse to one step. |
| FC-19 | `video-timeline.component.ts:577,706` | `seek.emit` from a `runOutsideAngular` mousemove without `ngZone.run` → playhead doesn't follow scrub until an unrelated tick. |
| FC-20 | `video-info-page.component.ts:713/734/754` | `cdr.detectChanges()` in HTTP callbacks + a 2s `setTimeout`, no teardown guard → `ViewDestroyedError` on navigate-away. |
| FC-21 | `bulk-export-dialog.component.ts:418-449` | Opened without `disableClose`; ESC/backdrop destroys it mid-export while the loop keeps POSTing → completion UI never shows, result reports `exported:false` despite created clips. |
| FC-22 | `export-dialog.component.ts:451-457` | `__full_video__` sentinel `endSeconds: MAX_SAFE_INTEGER` not special-cased in `getSelectedDuration()` → "Export N Clips" badge shows trillions of hours. |
| FC-23 | `onboarding.component.ts:139/164/189` | All library-success paths call `completeOnboarding()` directly → the `ai-setup` step is unreachable dead code. |
| FC-24 | `cascade.component.ts:1505` | ArrowUp with no highlight seeds `length-1` then −1 → lands on second-to-last, not last. |

### Low (condensed)

Modal `selectedAIModel` persists across reopens (`queue-item-config-modal.ts:69`) · `modelsChanged$` re-inits the open modal, discarding edits (`:77-98`) · re-encode checkbox has both `[(ngModel)]` + `[checked]` (`export-dialog.html:201`) · uncleared export-tour `setTimeout` (`export-dialog.ts:189`) · bulk-export progress increments before the await → shows 100% early / "clip N of N" off by one (`bulk-export-dialog.ts:434`) · ai-setup-wizard tour `setTimeout` not cleared (`:200`) · done-step hardcodes "Cogito 8B - Ready to use" regardless of installed model (`ai-setup-wizard.html:561`) · cascade `document:keydown` HostListener fires in every mounted instance (`:1295`) · cascade mutates `video.name`/`suggestedTitle` in place on `@Input`-owned objects (`:979,1034`) · cascade fixed-`index*56` scroll math drifts with taller rows (`:1550`) · relationship menu document-click listener leaks if destroyed while open (`video-info-page.ts:1069`) · `formatDuration` doesn't floor seconds → "2m 5.632s" (`:971`) · within-collection reorder unreachable — CDK path gated on unset `draggable` + `(itemsReordered)` unbound → run order can't be changed (`tabs-tab.html:45-54`) · library-page uncleared 500ms nav `setTimeout` calls `addVideoToAnalysisQueue` after destroy (`:645`) · `customMarkers` signal never populated → custom-markers export branch always empty (`video-player.ts:2094`).

**Verified clean:** `download-dock`, `settings-layout`, ai-setup-wizard WebSocket cleanup, video-timeline document-listener teardown, trim-handle clamping math.

---

## Method & confidence

- Findings came from six independent deep-read passes plus by-hand re-verification of all four criticals (B-1 connection swap at `queue-manager.service.ts:668-676`; B-2 mkdir at `database.service.ts:299-305`; A-1 seeder vs `loadCategories` at `analysis.service.ts:1751-1764` / `:112-119` with `DEFAULT_CATEGORIES` confirmed a bare array at `analysis-prompts.ts:27`).
- Counts are approximate because several findings overlap under the systemic themes (SEC, PROC-KILL, NO-TXN, TEMP-COLLIDE, WS-DUP, FAIL-AS-SUCCESS).
- Nothing here has been changed — this is a report only. Recommend confirming each fix's reproduction (especially runtime-dependent "always fails" claims) before editing.
