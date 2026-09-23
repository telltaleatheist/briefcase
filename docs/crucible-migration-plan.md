# Moving all of Briefcase's AI onto Crucible: the implementation plan

Branch `feat/crucible` (worktree `Briefcase-worktrees/crucible`, based on `feat/snap-scorer`).
Written 2026-09-23 against Crucible 1.0.23 (`b95ac38`), the unreleased `origin/feat/decide-door`
branch of Crucible (`0dfef8e`, `f38db96`), BookForge (`BookForgeApp`, SDK 1.0.22 vendored) and
Foundry. This plan is for the agents who will implement it one phase at a time. Every phase
leaves the app shippable.

Path shorthand: **C** = `/Volumes/Callisto/Projects/crucible`, **BF** =
`/Volumes/Callisto/Projects/BookForgeApp`, **FD** = `/Volumes/Callisto/Projects/foundry`, **BC** =
this worktree. Line numbers refer to this worktree, not the main checkout; they drift, so grep
for them rather than trusting them.

---

## 0. The decisions, in one table

| # | Question | Decision |
|---|---|---|
| 1 | Which process owns Crucible (install, pairing, registry, client, admission)? | **All of it runs in the NestJS backend.** Electron main gets one change: a longer graceful-shutdown window, so the quit sweep has time to run (§2). |
| 2 | What do we vendor from BookForge, and what do we write fresh? | We vendor the two SDK tarballs and the adopt script as-is, plus a generated `briefcase.module.json`. The protocol-level modules (install, pairing, registry, probe, job runner, lease, ledger, sweep) are ported from BF almost line for line. We write fresh the queue admission, the LLM façade, the ASR engine, the snap adapter and all the Angular UI (§3). |
| 3 | Install and first-run | A new **AI engine** step in the setup wizard, modelled on BF's `crucible-doors`. It shows one of four faces: connected / adopt / install / connect-only. There is one Crucible per machine. The never-older gate is ported verbatim. Briefcase never uninstalls or downgrades Crucible (§5). |
| 4 | Machines that can't host Crucible | **Intel Mac** and **Linux without NVIDIA**: `crucible init` refuses with `no viable backend`, so there is no upstream-only mode on these machines. They get AI by connecting to a Crucible on another machine, or they go without. **Windows** always hosts: `llama-windows` falls back to llama.cpp's CPU build and never refuses. The library, downloads and editor never need Crucible (§5.4). |
| 5 | LLM calls | Everything goes through `POST /v1/openai/chat/completions` via SDK `chat()`. A local model is loaded first and held with a lease. `anthropic/…`, `openai/…` and `ollama/…` go straight through with no lane. Cloud calls never get sampling params (§6.1). |
| 6 | API keys | Move into the local Crucible with `PUT /v1/settings`, then delete `api-keys.json` once the stored `key_hint` has been checked (§6.2). |
| 7 | Embeddings | **Drop them.** Chapter-boundary scoring goes lexical-only; it already works that way whenever Ollama is missing. Snap replaces the classic path anyway (§6.4). |
| 8 | NLI | Stays for one more release as the classic flags path. It is deleted in P7, once snap-via-Crucible passes the flag eval (§6.5). |
| 9 | Whisper | Crucible `asr` becomes the primary transcriber. **whisper-cli stays as a fallback** for three cases: `translate`, which Crucible's asr can't do; hosts where Crucible can't serve asr (native-only Windows, Intel Mac); and no Crucible at all. Whether that fallback is permanent is a question for the user (§6.6, §13). |
| 10 | Snap | Build a `SnapBackend` interface now (P6a). The Crucible `/v1/decide` adapter (P6b) is the one piece that waits. It waits on a Crucible release of the decide door, plus three gaps listed in §12 (§6.7). |
| 11 | Queue | One **GPU lane per enabled Crucible server**, plus an **upstream lane** (concurrency 2, no GPU). Transcribe moves off the main pool onto a GPU lane. A 409 parks the task with the busy holder's sentence and frees the slot. The queue prefers tasks that use the model already loaded. A ledger and sweep run at quit and at startup (§7). |
| 12 | Settings | A new **Crucible Servers** pane. The AI pane picks models from the server's catalog and upstreams. The Components pane loses whisper/llama/nli/scorer at P7 and keeps ffmpeg and yt-dlp (§8). |
| 13 | Feature flag | `app-config.json` gets `"aiBackend": { "llm": "auto"|"legacy"|"crucible", "asr": …, "snap": … }`, with env `BRIEFCASE_AI_BACKEND` taking precedence. `auto` means: use Crucible when at least one server is registered, otherwise the legacy path. Once a server is registered, an unreachable Crucible means **park the task, never fall back quietly**. The whole flag is deleted in P7 (§9). |

---

## 1. Facts this plan depends on (checked in source, not just in the maps)

- **Backend process.** Briefcase's NestJS backend is started by `electron/services/backend-service.ts:417` as `spawn(process.execPath, [backendPath])` with `ELECTRON_RUN_AS_NODE=1`. That is Electron 33's Node, **20.18**, which meets the SDK's `node >= 20` requirement. `backend/tsconfig.json` compiles to CommonJS, and both SDK packages ship a CJS build (`exports.require`), so they load in NestJS and in Jest. The backend already calls `app.enableShutdownHooks()` (`backend/src/main.ts:99`). Electron sends SIGTERM and waits **6 s** before SIGKILL (`backend-service.ts:555-575`). On Windows, SIGTERM from Node is a hard kill.
- **No backend means no install.** `crucible init` fails `no viable backend` on an Intel Mac (`C/crucible/backend.py` `detect_backend`: "macOS on x86_64 is not a Crucible backend; Apple Silicon (arm64) only") and on Linux with no nvidia-smi. **Windows never refuses**: `detect_windows` returns `llama-windows` on llama.cpp's CPU build when no NVIDIA card answers (`backend.py:245-270`, Owen: *"a crucible server will run on absolutely anything"*). BF's `hostabilityOf` (`BF/electron/crucible/install.ts:893`) already encodes these answers, so we port it.
- **Upstreams.** Any `anthropic/<id>`, `openai/<id>` or `ollama/<id>` is forwarded as long as that upstream is configured. It does not need a `[routes]` entry (`C/crucible/api.py:2902`, `_forward_to_upstream` at ~3758). An unconfigured upstream answers `409 upstream_unconfigured`. `forward_body` (`C/crucible/upstreams.py:547`):
  - For openai and ollama it sends the OpenAI body with `model` rewritten and `chat_template_kwargs` removed. That means **`thinking` is dropped** for every upstream.
  - For anthropic it builds a Messages body. It passes `temperature/top_p/top_k` through only if we send them, fills `max_tokens` with 4096 when absent, and turns `response_format` json_schema into a forced tool.
  - Ollama is reached at `<url>/v1/chat/completions`, Ollama's OpenAI-compatible route. That route has **no `num_ctx` and no `keep_alive`**.
  - There are no retries: a 429 is passed through with `Retry-After`.
- **The chat door** (`C/sdk/ts/src/client.ts:1109-1215`). SDK `chat()` sends `temperature/top_p/max_tokens/stop/seed/response_format`, and each one only when we set it. `thinking` becomes `chat_template_kwargs.enable_thinking`. It accepts `act` (the `X-Crucible-Act` header, which must name a known capability class or the server answers 400) and `signal`. `responseFormat.type` must be `text`, `json_object` or `json_schema{name,schema}`. The reply is `{id, model, content, finishReason, usage}`: no `reasoning` field, and no way to add extra body fields. A local model must be resident first, or the answer is `409 model_not_resident`.
- **ASR job** (`C/crucible/jobs/asr/__init__.py`):
  - Params: `{language: <whisper code>|"auto", vad_filter: bool, word_timestamps: bool}`. Anything else is refused (`extra="forbid"`), so **there is no translate**.
  - Engines: faster-whisper (cuda-linux) and mlx-whisper (mlx-darwin), both float16. The module file shows **no llama-windows asr**, so asr on Windows needs WSL. There is no CPU fallback.
  - The server windows the audio at 900 s with 15 s overlap and dedups.
  - Output is the artifact `transcript.json`: `{model, revision, language, language_probability, duration_s, segments:[{start,end,text,…,words?:[{start,end,word,…}]}]}`. There is no SRT.
  - A failed window fails the whole job.
  - Models: `faster-whisper-{tiny,base,small,medium,large-v3,distil-large-v3}` and `mlx-whisper-{tiny,base,small,medium,large-v3,large-v3-turbo,distil-large-v3}`.
- **Module declarations** live in `C/modules/<app>.toml`. `python scripts/gen-modules.py` writes `modules/<app>.module.json`, and `--check` is what CI runs. The app vendors that JSON **byte for byte and never edits it** (see the gen-modules.py docstring). BF and FD both do this.
- **The decide door exists, but only on a branch and not yet released.** `origin/feat/decide-door` (`docs/PHASE22-DECIDE.md`) adds `POST /v1/decide` and SDK `decide()`. It differs from Briefcase's scorer in several ways that matter:
  - `questions` and `options` are **objects keyed by name**. Briefcase chose arrays on purpose, because JS reorders integer-like keys.
  - There is **no `missing_labels: "floor"` policy**. The server refuses with `502 label_not_in_probs` instead. Briefcase uses `'floor'` in chapters (`scorer/chapters/snap-chapter.service.ts:178,201`) and in flags (`scorer/flags/snap-flag-ranker.service.ts:273`).
  - The server chooses K = labels + 4. The caller can't set `nProbs`.
  - **mlx-lm caps top_logprobs at 11**, so the Mac serves at most 7 labels. Briefcase's chapter assign uses 26 options and flag pass 1 uses 11.
  - There is no tokenize route, which Briefcase uses for chunk planning (`snap-analysis.service.ts:141`).
  - Answers carry `probabilities` and `label_mass`, not per-option log-probs.
  - Model-not-resident gives a 409, chat admission gives a 503, and the act header applies, all the same way as chat.
- **Briefcase's queue** (`backend/src/queue/queue-manager.service.ts`):
  - It runs in-process and is **not persisted**.
  - `MAX_MAIN_CONCURRENT=5` (:79) and `MAX_AI_CONCURRENT=1` (:80). Only `analyze` and `analyze-webpage` go to the AI pool (:665, :691); `transcribe` runs in the main pool.
  - `AI_TASK_TIMEOUT_MS` is 90 min (:69).
  - The library pin is `canStartJobLibrary` (:606-628).
  - The download task's `translate` option goes to whisper `--translate` (`common/interfaces/task.interface.ts:31`, `bridges/whisper-bridge.ts:348`).
- **Where generateText is called** (this worktree):
  - `analysis/chapter-detection.service.ts:565`
  - `analysis/ai-analysis.service.ts:1645` (chapter)
  - `analysis/ai-analysis.service.ts:1750` (flags discovery)
  - `analysis/ai-analysis.service.ts:2267` (flag verify)
  - `analysis/ai-analysis.service.ts:2871` (description)
  - `analysis/ai-analysis.service.ts:3065` (tags)
  - `analysis/ai-analysis.service.ts:3121` (title)
  - `analysis/ai-analysis.service.ts:3230` (title from webpage)
  - `library/library.controller.ts:2190` (insights)
  - `analysis/ai-provider.service.ts:671` (test connection)
  - The dispatch itself is `ai-provider.service.ts:190-222`.
- **The scorer seam** (`scorer/scorer-server.service.ts:62-67,194`): `ScorerHandle = {decide, generate, decider()}`. `decider()` leaks llama-server specifics to its callers: `decider.model`, and `decider.engine.tokenize` (`snap-analysis.service.ts:134-143`, `snap-chapter.service.ts:277`).
- **Transcription seam.** `media/whisper.service.ts:258` calls `whisperManager.transcribe(...)`, which produces an SRT file. Everything downstream reads SRT.

---

## 2. Which process owns what

| Concern | Owner | Why |
|---|---|---|
| Registry (`crucible-servers.json`, `crucible-routing.json`) | **NestJS** | The queue and every AI caller live in NestJS. A registry in Electron main would add an IPC round-trip to every AI call and put the token in two processes. |
| Pairing file, auto-connect, device-code connect, connect code | **NestJS** | These only write the registry. The UI reaches them through the existing HTTP API, with no new IPC. |
| Probe / engine-resolve | **NestJS** | The queue scheduler needs reachability in-process. |
| Client factory (`crucibleClientFor`) | **NestJS** | The only place a token meets the SDK. |
| Queue admission, lanes, lease, ledger, sweep | **NestJS** | `QueueManagerService` already lives here. |
| Install (bootstrap `install()`, `startLocal()`, the Windows host runner) | **NestJS** | Bootstrap is plain Node (download, verify, spawn) and runs fine under `ELECTRON_RUN_AS_NODE`. Windows elevation is PowerShell `Start-Process -Verb RunAs`, and the UAC prompt appears no matter which process asks. Progress goes to the UI over the existing Socket.IO gateway. Putting it in NestJS keeps the registry write that follows an install in the same process as the registry. |
| Graceful-shutdown window | **Electron main** | `backend-service.ts` raises SIGTERM→SIGKILL from 6 s to 12 s. The NestJS `beforeApplicationShutdown` hook runs the sweep with an **8 s** deadline. On Windows SIGTERM is a hard kill, so the **startup sweep** is what guarantees cleanup there, just as BF does for crashes. |
| Opening links (Crucible README, logs) | Electron main (`shell.openExternal`) | This already exists. |

**Risk accepted:** an install is a child of the backend, so if the backend crashes mid-install, bootstrap's child goes with it. Bootstrap's install is idempotent and resumable: its steps check sha256 and the service install is re-entrant. The wizard reads the state again on the next launch and shows the right face. Two things mitigate this: `InstallService` writes `crucible-install-state.json` (the step it reached, and the release), and it never runs two installs at once, because one lock is held for the life of the process.

Everything goes in `getBriefcaseConfigDir()` (`bridges/runtime-paths`), next to `app-config.json`. That directory is on the internal disk, **not** the external library volume, so a late-mounting `/Volumes/Callisto` doesn't matter.

---

## 3. What to vendor, what to port, what to rewrite

### 3.1 Vendor, byte for byte

| Artifact | Where it goes in BC | How |
|---|---|---|
| `crucible-client-<ver>.tgz`, `crucible-bootstrap-<ver>.tgz` from the GitHub release | `backend/vendor/` | `backend/package.json` gets `"@crucible/client": "file:vendor/crucible-client-<ver>.tgz"` and the same for bootstrap, plus the `//crucible-client` / `//crucible-bootstrap` prose keys BF uses. Pin to **1.0.23**, or later if the decide door has been cut by then. |
| `tools/adopt-crucible-release.mjs` | `tools/adopt-crucible-release.mjs` at the BC root | Copy BF's version, because it is the newer of the two that have drifted. Its package.json discovery must learn `backend/package.json`. That is the only edit. It is `.mjs` because BC's root package.json has no `type` field. |
| `briefcase.module.json` | `shared/crucible/briefcase.module.json` | It is generated in the Crucible repo (§3.4). Never edit it by hand. |

The backend's packaged `node_modules` must include `@crucible/*`. Check the electron-builder `files` / `extraResources` globs for `backend/node_modules` in P1, and add a packaging smoke test.

### 3.2 Port from BF, protocol logic nearly verbatim

Swap `app.getPath('userData')` for `getBriefcaseConfigDir()`, swap `ipcMain` for Nest providers and controllers, and change the client name to `'briefcase'`.

| BF source (`BF/electron/crucible/`) | BC destination (`backend/src/crucible/`) |
|---|---|
| `servers.ts` (registry, `crucibleClientFor`, masked listing, temp-then-rename writes) | `registry.service.ts`, `client-factory.ts` |
| `routing.ts` (order, disabled, newJobsWaitFor) | `routing.service.ts` |
| `pairing-file.ts`, `discovery.ts` | `pairing-file.ts`, `discovery.ts` |
| `auto-connect.ts` | `auto-connect.service.ts` |
| `connect.ts`, `connect-code.ts` | `connect.service.ts` |
| `probe.ts`, `engine-resolve.ts` | `probe.ts`, `engine-resolve.ts` |
| `install.ts` (channel latest, `runningCrucibleVersion`, `releaseToInstall`, `hostabilityOf`, `driveCrucibleInstall`), `install-door.ts`, `host-runner.ts`, `engine-presence.ts` | `install/install.service.ts`, `install/install-door.ts`, `install/host-runner.ts`, `install/engine-presence.ts` |
| `coordinate.ts`, `module-setup.ts`, `first-run-models.ts` | `coordinate.service.ts`, `module-setup.ts` |
| `catalog.ts`, `engine-settings.ts` | `catalog.service.ts`, `engine-settings.service.ts` |
| `job.ts` (`runCrucibleJob`), `stream-reconnect.ts`, `stream-stall.ts`, `transport-failure.ts` | `job/run-job.ts`, `job/stream-reconnect.ts`, `job/stream-stall.ts`, `job/transport-failure.ts` |
| `lease.ts` | `lease.ts` |
| `in-flight-ledger.ts`, `in-flight-sweep.ts` | `in-flight-ledger.ts`, `in-flight-sweep.ts` |
| `venue-decision.ts` | `venue-decision.ts` |
| `shared/crucible/{connect,install,install-door,catalog,settings,engine-controls,coordinate}-wire.ts` | `shared/crucible/*-wire.ts`. Root `shared/` is already imported by both the backend and the frontend. |
| `shared/queue/{wait-for,slot-sets,state-switch,rate-window}.ts` | `shared/queue/` (trim to what §7 uses) |

### 3.3 Rewrite for Briefcase

- **Queue admission.** BF's `queue-engine.ts` is 3.5k lines built for narration rows. Briefcase gets a small `backend/src/queue/crucible-lanes.ts` inside the existing `QueueManagerService` (§7).
- **LLM façade.** `backend/src/crucible/llm/crucible-llm.service.ts`. BF's `text-acts.ts` is book-specific, so we don't reuse it.
- **ASR engine.** `backend/src/media/transcription/crucible-asr.engine.ts`, which converts `transcript.json` to SRT.
- **Snap adapter.** `backend/src/scorer/backends/crucible-snap.backend.ts`.
- **Angular UI.** BF runs Angular 21 with signals and its own design system; BC runs Angular 17. Port the **behaviour and the words** (`crucible-words.ts`), not the components. Components to build:
  - `crucible-doors`
  - `crucible-servers-pane`
  - `crucible-install-progress`
  - the lanes strip in `queue-tab`
- **Test harness.** BF's `tools/fake-crucible.js` stubs `electron`. BC gets a TypeScript port under `backend/test/fake-crucible/` for Jest (§10).

### 3.4 Getting `briefcase.module.json`

Briefcase asks for this by landing a PR in the Crucible repo, because the generator refuses anything it can't resolve. That makes it a **Crucible-repo change and not a Briefcase edit**:

1. Add `C/modules/briefcase.toml`:
   ```toml
   [module]
   name = "briefcase"

   [[job_types]]
   type = "llm"

   [[job_types]]
   type = "asr"

   # Chapters, flags, description, tags, titles: one class. The SERVER resolves it per machine.
   [[needs]]
   class = "analysis"

   # The transcriber. Backend-scoped the way bookforge.toml does it (faster-whisper has no Metal backend).
   [[subjects]]
   kind = "model"
   id = "faster-whisper-large-v3"      # cuda-linux

   [[subjects]]
   kind = "model"
   id = "mlx-whisper-large-v3-turbo"   # mlx-darwin: video transcripts favour speed; not aligned against
   ```
   The whisper choice is the user's to confirm (§13 Q5). A `decide` class is added once PHASE22 §7.2 is ruled on.
2. Run `python scripts/gen-modules.py` and commit `modules/briefcase.module.json`. `--check` and `tests/test_modules.py` then guard it.
3. After the next Crucible cut, run `node tools/adopt-crucible-release.mjs <ver>` in BC, and copy `modules/briefcase.module.json` into `shared/crucible/`.
4. `backend/test/crucible/module-file.spec.ts` (a port of BF `test-crucible-module-file.js`) checks three things: the vendored file parses, its `name === "briefcase"`, and its `version` matches the content hash.

Until step 2 lands, the module is only needed by `coordinate` (P2). P1 does not need it.

---

## 4. Server registry and pairing (the core of P1)

- `crucible-servers.json`: `[{name, url, token, added}]`. It is written temp-then-rename. The API always masks the token (`tokenHint` = last 4 characters).
- `crucible-routing.json`: `{order: string[], disabled: string[]}`. Disabled servers are Paused; the rest are Running.
- **Auto-connect** runs at boot, is **never awaited by `onModuleInit`**, and is non-blocking.
  1. If the registry is empty, read the SDK pairing file: `~/.crucible/pairing`, or `%LOCALAPPDATA%\Crucible\pairing`, or `$CRUCIBLE_HOME`.
  2. Probe it: `/v1/info` must answer with an `apiVersion === 1` name.
  3. Adopt it as the `local` row.
  
  This is what makes one Crucible per machine shared with BookForge and Foundry: whichever app installed it, Briefcase adopts it.
- **Adding a server**:
  - device-code pairing: `startPairing` then `pollPairing`, which `open_pairing` auto-approves;
  - pasting a connect code or `crucible://name@host:port/#token` line: `parsePairing`;
  - picking a discovered server.
  
  All of these go through `ConnectService` and end in a probe, then a registry write.
- **Probe** runs `ping`, then `info`. It tells apart four results: `nothing-there`, `not-crucible`, `bad-token`, and `ok{version, apiVersion, backend}`. Results are cached for 10 s for the queue's `reach()`. The UI's **Test** button bypasses the cache.
- REST, added in `backend/src/crucible/crucible.controller.ts`:
  - `GET /crucible/servers`
  - `POST /crucible/servers` (add: `{connectCode}`, `{pairingLine}` or `{url}` → device-code flow)
  - `POST /crucible/servers/:name/test`
  - `DELETE /crucible/servers/:name`
  - `PUT /crucible/routing` (`{order, disabled}`)
  - `GET /crucible/local` (the local-machine face: installed? running? version? hostable?)
  - `POST /crucible/local/start`
  - `GET /crucible/connect-code` (this machine's code, for pasting elsewhere)
  - Socket.IO event `crucible.servers-changed`.

---

## 5. Install and first-run (P2)

### 5.1 The wizard step

`frontend-v3/src/app/components/setup-wizard/setup-wizard.component.ts` today has these steps: `welcome | tools | models | ai | review | finishing`. Change it to:

- `welcome | tools | engine | ai | review | finishing`.
- **`models` (Whisper downloads) is removed.** The transcriber comes from the module in Crucible. If the user turns Crucible down, or Crucible can't serve asr here, a single "Download the offline transcriber (whisper, ~1.5 GB)" card toggle appears inside `engine`. This is the fallback from §6.6.
- **`engine`** mounts `<app-crucible-doors mode="probing">`, which calls `GET /crucible/local` and shows **exactly one face**:
  - **connected**: a registry row answers. Show its name and version, with a "Use a different server" link.
  - **adopt**: a pairing file exists but there is no registry row. Show one button: "Use the Crucible already on this computer". This covers "installed by BookForge or Foundry".
  - **install**: nothing is installed and `hostabilityOf` says yes. Show what will happen in one sentence from `describeMachine()`, and an **Install Crucible** button. Progress is `crucible-install-progress`, fed by Socket.IO `crucible.install-progress`, which carries BF's `InstallStep` events.
  - **connect-only**: `hostabilityOf` says no (Intel Mac, Linux without NVIDIA). The UI says why in one sentence and offers "Connect to Crucible on another computer" (connect code / pairing line) or "Skip, and use Briefcase without AI".
  
  **Skip** is always available. AI is optional.
- **`ai`** keeps the provider choice, but it now writes into Crucible:
  - "Use this computer's GPU": the server's `analysis` class.
  - "Claude" or "ChatGPT": a key field, which does `POST /crucible/settings/upstreams/:name/test` and then `PUT`.
  - "Ollama already on this computer": the upstream URL `http://127.0.0.1:11434`.
  - If no server is connected, this step only says "AI features need Crucible", with a link back.
  - Every choice uses the card-toggle style: the whole card is clickable, the border turns orange when selected, and there are no emoji.
- **After install**:
  1. `autoConnectLocal(true)`.
  2. `coordinate()`. This compares `briefcase.module.json` against `/v1/info` + `/v1/catalog` + `/v1/capability` and POSTs `{type:"module"}` to `/v1/tasks` **only if something is missing**. Models download on first use and are never bundled.
  3. The coordinate task's progress shows in the wizard's `finishing` step and then carries on in the queue tab's header. The wizard does not block on model downloads.

The first-run gate is BF's `first-run-models.ts` logic: coordinate is held back until the wizard finishes, so the user decides the providers before any multi-GB pull starts.

### 5.2 The never-older gate and one Crucible per machine

Port `releaseToInstall` exactly (`BF/electron/crucible/install.ts:204`). It has three possible answers:

| Situation | Result |
|---|---|
| Nothing running | Install the channel's latest. |
| The channel is newer | Install the channel's latest (this is the upgrade path). |
| Same version, or the channel is older | Refuse: `crucible_already_latest` or `install_older_than_running`. The UI shows the connect/adopt face instead. |

There is no `--force`. Briefcase **never uninstalls** Crucible, because it is shared. The servers pane has "Forget this server" and nothing more. A newer channel release is offered in the servers pane as "Update Crucible", which runs the same install path. The pane marks a server whose version is below Briefcase's floor (§11 version skew) as "needs update".

### 5.3 Boot tolerance

- Nothing Crucible-related runs inside `onModuleInit` await chains. `CrucibleModule` starts its auto-connect and probe as fire-and-forget promises that log their result.
- The library, downloads, editor and Tabs/Collections have no import path to `CrucibleModule` at request time. Only `AIProviderService`, `WhisperService`, the snap backend and the queue's lane code inject it, and all of them do so as `@Optional()`.
- The startup sweep (§7.6) is awaited **only before the GPU and upstream lanes start**. The main pool (downloads, imports, processing) starts at once.

### 5.4 Machines that can't host Crucible

Upstream-only mode **doesn't exist**, because `init` refuses before any server can run. So:

- **Intel Mac:** the connect-only face. Claude or OpenAI still work through a *remote* Crucible. Without one, AI analysis is unavailable, and transcription uses the whisper-cli fallback. Whether to keep a direct-cloud path for this case is **§13 Q1**.
- **Linux without NVIDIA:** the same, and there are no Linux manifest artifacts yet anyway.
- **Windows without NVIDIA:** installs. It serves `llm` on the CPU build (slowly) and upstreams at normal speed, but no asr unless WSL with CUDA appears. So the whisper-cli fallback transcribes there.
- **Windows with NVIDIA but no WSL:** `llama-windows` gets the GPU for `llm`, with no asr. Bootstrap tries WSL on its own (PHASE19) and may ask for UAC and a restart. The wizard's install face gives BF's sentence word for word: "Windows may ask for permission, and once for a restart."

---

## 6. Call-site migration

### 6.1 The LLM table

A new `CrucibleLlmService.complete(prompt, target, task, overrides)` replaces the body of `AIProviderService.generateText`. The signature and the `AIResponse` shape stay the same, so the call sites below don't change in P3. Only `config.provider` and `config.model` change meaning, as described under **Target resolution** below.

| Call site | Task | Today | Through Crucible |
|---|---|---|---|
| `chapter-detection.service.ts:565` | `boundary` | ollama `qwen3.5:4b`, `format:'json'`, temp 0 | `responseFormat {type:'json_object'}`, temp 0 (only when not a cloud model), `act:'analysis'` |
| `ai-analysis.service.ts:1645` | `chapter` | per-task model, temp 0.15 | same prompt; temp 0.15 when not cloud |
| `ai-analysis.service.ts:1750` | `flags` discovery | JSON Schema via `format` (Ollama only) | `responseFormat {type:'json_schema', json_schema:{name:'flags', schema}}` for local and ollama; for cloud, **no schema in P3** (the prompt-parsed behaviour stays as today; see below) |
| `ai-analysis.service.ts:2267` | `flags` verify | schema | same as the row above |
| `ai-analysis.service.ts:2871` | `description` | temp 0.4 | temp 0.4 when not cloud |
| `ai-analysis.service.ts:3065` | `tags` | schema, 0.15 | schema as for flags |
| `ai-analysis.service.ts:3121`, `:3230` | `title`, title-from-webpage | 0.4 | 0.4 when not cloud |
| `library/library.controller.ts:2190` | insights | **passes no apiKey (bug)** | fixed as a side effect, because keys live in Crucible |
| `ai-provider.service.ts:671` | test connection | a real generation | `probe()` + `testUpstream()` for cloud; for local, `models()` shows the catalog. **No billed call.** |

**Target resolution** (`backend/src/crucible/llm/target.ts`): today `provider:model` becomes one of the following.

| Today's provider | Crucible model string | Venue | Lane |
|---|---|---|---|
| `claude:<id>` | `anthropic/<id>` | upstream | none |
| `openai:<id>` | `openai/<id>` | upstream | none |
| `ollama:<id>` | `ollama/<id>` | upstream | none |
| `crucible:analysis` (the new default) | the server's analysis choice | local model or routed upstream | local: GPU lane |
| `crucible:<model-id>` | that model | local model | GPU lane |
| `local:*` | **refused**, with the message "the built-in llama runtime was removed; pick a model" | none | none |

- **`crucible:analysis`** reads `GET /v1/capability`'s `analysis` row. If it is routed to an upstream, the model is `via`. If it is local, it is the model id, which is loaded and leased.
- **`crucible:<model-id>`** is an explicit local catalog id. It is loaded and leased.

`task-models` in `app-config.json` gets a one-time migration: `claude:` becomes `anthropic/`, and so on. `local:` becomes `crucible:analysis`. `boundary`'s auto-route to `ollama:qwen3.5:4b` becomes `crucible:analysis`.

**How parameters map:**

| Parameter | local Crucible model | `ollama/*` | `anthropic/*` | `openai/*` |
|---|---|---|---|---|
| temperature | per-task value (`model-utils.ts:78`) | per-task value (**pinned**, as today) | **never sent** | **never sent** |
| topP / seed | not sent | not sent | never | never |
| maxTokens | not sent (manifest default) | not sent | not sent: Crucible fills 4096, the same as today | **not sent**. `max_tokens` gets a 400 on o-series and gpt-5; today's code already uses `max_completion_tokens` for this reason. |
| thinking (`think`) | `thinking:false` for boundary, flags and tags (structured); omitted otherwise | **cannot be expressed**: Crucible drops `chat_template_kwargs` for upstreams. We accept that and ask Crucible (§12 A4). | dropped (fine) | dropped (fine) |
| num_ctx | n/a: the manifest's context window, which Crucible sizes | **cannot be expressed** on Ollama's `/v1` route. We ask Crucible (§12 A4). Meanwhile the servers pane warns: "Ollama's own context default applies; set `OLLAMA_CONTEXT_LENGTH`". | n/a | n/a |
| format `'json'` | `json_object` | `json_object` | forced-tool via json_schema only; `json_object` is dropped on anthropic, so don't send it | `json_object` |
| JSON Schema | `json_schema` | `json_schema` | P3 sends none. A follow-up can turn it on after testing, because the forced tool is more reliable. | P3 sends none. OpenAI `strict:true` rejects schemas that aren't closed, so it would need a per-schema audit. |
| keep_alive / release on cancel | the lease is released; Crucible settles | nothing to do: Ollama's own keep-alive applies | n/a | n/a |
| signal (cancel) | SDK `chat({signal})` aborts the HTTP request, then the lease is released | the same | the same | the same |
| timeout | per call: 120 s + 5 ms per prompt char, the scorer's measured rule | 10 min, the same as today | 10 min | 10 min |

**Reply handling:**

- `finishReason === 'length'` is logged as a degradation. For JSON tasks it is treated as a parse failure and goes through the existing retry path in `json-utils.ts`.
- There is **no `reasoning` field** in SDK replies. If a thinking model returns empty `content`, the task fails with the message "the model spent its budget thinking; turn thinking off or raise max tokens". Structured tasks send `thinking:false`, which avoids this on local models. Today's "use the thinking text" fallback for Ollama is lost; §12 A4 covers that.
- Token usage and cost: `usage.prompt_tokens` and `completion_tokens` feed the existing `calculateCost` for upstream models.

**Zero-successful-chapters must throw.** Nothing changes here. It is ai-analysis logic, and P3's acceptance tests it again explicitly against the fake: every chapter call gets 500 → the analysis fails and does not complete empty.

### 6.2 API keys → Crucible settings

- `backend/src/crucible/settings-bridge.service.ts` proxies `GET /v1/settings`, `PUT /v1/settings` and `POST /v1/settings/upstreams/:name/test` for the UI. It never logs a body.
- **Migration.** This runs once, the first time a *local* server is registered and reachable, and only when `api-keys.json` or the legacy electron-store copy exists:
  1. `PUT /v1/settings {upstreams:{anthropic:{key}, openai:{key}}}`.
  2. `GET` and check that each `key_hint` equals the last 4 characters of the key.
  3. Only then **delete** `api-keys.json` and the electron-store copy.
  4. Record `keysMigratedTo: "<server name>"` in `app-config.json`.
  
  If the write fails, keep the file and try again at the next boot. **Never** push keys to a remote server automatically. For a remote server, the pane offers "Copy my Claude key to <server>" as an explicit action. Ollama gets `upstreams.ollama.url` from the existing `ollamaEndpoint` setting.
- `config/api-keys.service.ts` and `api-keys.controller.ts` stay until P7 for the legacy path, then go.

### 6.3 Ollama

Ollama becomes an ordinary upstream of Crucible:

- `OllamaService` model listing becomes `testUpstream('ollama')`, which returns ids.
- **Pull is dropped.** Crucible has no pull route for an upstream. We link to Ollama instead, or recommend a Crucible catalog model.
- **preload/unload are dropped.** On Windows (`llama-windows`), Crucible can serve GGUFs straight out of Ollama's store (`C/crucible/ollamastore.py`), and that's the better path.
- `analysis/ollama.service.ts`, `ollama-capabilities.ts` and the `analysis/models|pull-model|check-model` endpoints are deleted in P7.

### 6.4 Embeddings: dropped

Crucible has no embeddings route. `chapter-detection.service.ts` step 2 (`/api/embed`, `nomic-embed-text`, :15-75, :434) already falls back to lexical scoring whenever the embed call fails. In P3, when `aiBackend.llm` resolves to Crucible, the embed call is skipped outright and the pipeline uses the lexical scorer. The step is deleted in P7. We are **not** asking Crucible for an embeddings route: the classic chapter pipeline is on its way out in favour of snap. The quality risk is covered by P3 acceptance (below).

### 6.5 NLI

`analysis/nli-ranker.service.ts` and `common/nli-env.ts` (a Python worker with its own env) are not AI through Crucible, and they don't fit it. They stay as the classic flags path through P6, and they're deleted in P7 **after** snap-via-Crucible passes the flag eval (`scorer/flags/eval/flag-eval.ts`). If the snap adapter is still waiting in P7, NLI stays and P7 is split (see §9).

### 6.6 Whisper → Crucible `asr`

- **The seam.** A new `TranscriptionEngine` interface in `backend/src/media/transcription/`:
  ```ts
  transcribe(audioPath, {language, translate, wordTimestamps, signal, onProgress}) → {srtPath, language}
  ```
  There are two implementations:
  - `WhisperCliEngine`, wrapping `whisper-manager.ts`, which is what we have today;
  - `CrucibleAsrEngine`.
  
  `media/whisper.service.ts:258` calls the selected engine. SRT stays the currency, so nothing downstream changes (transcript search, snap-transcript, editor, analysis).
- **`CrucibleAsrEngine` in steps:**
  1. Extract **16 kHz mono FLAC** with the existing ffmpeg bridge. An hour of it is about 30 MB, against about 115 MB for WAV, and that matters for LAN servers.
  2. `upload` the audio.
  3. `asr({model, filename:'audio.flac', language: lang ?? 'auto', vadFilter: true, wordTimestamps: false})`.
  4. `runCrucibleJob`, which follows SSE `progress` (`extra.stage/processed_s/total_s`) into Socket.IO `task.progress`.
  5. Fetch `transcript.json` and convert it to SRT: `segments[].start/end/text`, times as `HH:MM:SS,mmm`.
  6. Cancel is `DELETE /v1/jobs/{id}`.
  
  `word_timestamps` stays false until something in Briefcase uses words.
- **Model.** The transcription pane shows the server's asr catalog (`GET /v1/catalog` filtered to `asr`). The default comes from the module: `mlx-whisper-large-v3-turbo` or `faster-whisper-large-v3`.
- **Parity is unproven, so whisper-cli stays as a fallback.** The comparison:

  | | whisper-cli (today) | Crucible asr |
  |---|---|---|
  | Engine | whisper.cpp, Metal/CUDA/CPU | mlx-whisper (Mac), faster-whisper (CUDA) |
  | Speed | measured before | mlx-whisper turbo and faster-whisper are both faster on GPU (BF's measurements), but **Briefcase hasn't measured them on its own videos** |
  | Output | SRT | segments JSON (+ words) |
  | `--translate` | yes | **no** |
  | CPU | yes | no |
  | Windows without WSL | yes | no |
  | Intel Mac | yes | no |
  
  **Decision for P5:** Crucible asr is primary wherever the selected server serves `asr` (`/v1/capability` asr row available). Fall back to whisper-cli when:
  - the task asks for `translate`, or
  - there is no registered server, or
  - the chosen server has no asr (llama-windows-only, Intel-Mac remote-less).
  
  A registered but **unreachable** server **parks** the task and does not fall back, because silently switching engines is exactly what Crucible's own docs warn about. P5 acceptance includes a side-by-side run: 10 library videos, word-error-rate proxy (the diff ratio against a hand-checked transcript for 3 of them) and wall time. Whether whisper-cli ever gets deleted is §13 Q2. We also ask Crucible for `task: "translate"` (§12 A5).

### 6.7 Snap: the scorer → Crucible `/v1/decide`

- **P6a: the interface, which doesn't wait on Crucible.** In `backend/src/scorer/backends/snap-backend.ts`, replace `ScorerHandle.decider()` leakage with:
  ```ts
  interface SnapBackend {
    readonly model: string;              // provenance string stored with results
    readonly contextTokens: number;      // for chunk planning
    countTokens?(text, signal): Promise<number>; // absent → chars/4 (already supported, snap-chapter.service.ts:42,250)
    decide(req: DecideRequest, o?): Promise<DecideResponse>;   // Briefcase's existing array-shaped types
    generate(messages, o): Promise<GenerateResult>;
    readonly caps: { maxOptions: number; floorsMissingLabels: boolean; nProbs: number | null };
  }
  withSnapBackend<T>(fn: (b: SnapBackend) => Promise<T>, signal?): Promise<T>
  ```
  `LocalScorerBackend` wraps today's `ScorerServerService`, so there is no behaviour change. `snap-analysis.service.ts`, `snap-chapter.service.ts` and `snap-flag-ranker.service.ts` use only this interface. **When `caps.maxOptions < 26`, callers split the question**: chapter assign shrinks its outline window (`MAX_ITEMS`), and flags turn off categories past the cap, with a warning. Or they choose classic for that stage (see gating below).
- **P6b: `CrucibleSnapBackend`, the one piece that waits.**
  - `withSnapBackend` loads the model and takes a lease, using the same code as §6.1.
  - `decide` maps Briefcase's arrays to Crucible's objects. **Every question name and option name is prefixed** (`q0…`, `o0…`), then mapped back. JS `JSON.stringify` moves integer-like keys to the front, which would silently reorder letters. Tests assert letter order survives option names `"1".."12"`.
  - `logProbs = ln(probabilities[opt])` in option order.
  - `rawLogProbs = ln(probabilities[opt] × label_mass)`. That holds because `label_mass` is the sum of the raw label probabilities.
  - `generate` goes through the chat door on the same resident model.
  - `countTokens` is absent (chars/4).
  - `contextTokens` comes from the catalog row's context length.
  - `caps` comes from the server: vLLM and llama-server allow 26; mlx-lm allows ≤ 7 labels (cap 11 minus the margin of 4).
  - `floorsMissingLabels` is false until Crucible adds it.
- **Error mapping.** `409 model_not_resident` / `leased` → park. `503 chat_queue_full` → honour Retry-After. `502 label_not_in_probs` → **with no floor, count the unit as skipped and record it in `missingLabels`**, the same place the floor count went.
- **Gating.** `analysisEngine: snap` uses `CrucibleSnapBackend` only when all of these hold:
  1. the server answers `POST /v1/decide`. A 404 means "not served", so fall back to `LocalScorerBackend` until P7, then to classic.
  2. `caps.maxOptions ≥ 26`, or the stage can split.
  3. the flag and chapter evals pass (§9 P6).
  
  **On the user's Mac Studio this means snap-via-Crucible falls back to classic until Crucible serves more than 11 logprobs on mlx** (§12 A2, §13 Q3).
- **P7** deletes `scorer-server.service.ts`, `scorer-engine.ts`, `scorer-decide.ts`, `scorer-prompt.ts`, `scorer-labels.ts` (move any label constants the chapter and flag code still import into `scorer/backends/`), the scorer model-catalog entries (`config/model-catalog.ts:81,93`), and the scorer's llama-server lifecycle. **Keep `scorer-viterbi.ts`**: the chapter path runs Viterbi over the answers whichever backend produced them.

### 6.8 LlamaManager, llama-bridge and the `local` provider

These are already dead (`COGITO_MODELS` is empty).

- **P3:** `generateWithLocal` (`ai-provider.service.ts:~642`) throws the "removed" message.
- **P7:** delete `bridges/llama-manager.ts` and `bridges/llama-bridge.ts`, the `llama` binaries-v1 component entry, `'local'` from the `aiProvider` unions (`common/interfaces/task.interface.ts:88,100`, `frontend-v3/src/app/models/task.model.ts`), and every `LlamaManager` injection.

### 6.9 Listing and pulling models

- `GET analysis/models` and `config.controller`'s OpenAI/Claude lists (`config/config.controller.ts:~421,473`) become **`GET /crucible/models?server=<name>`**. That returns:
  - `catalog` (local models with `pulled`, `size`, `backendSupported`, `fits`), from `GET /v1/catalog`;
  - `upstreams` (`{anthropic: ids[], openai: ids[], ollama: ids[]}`), from `testUpstream`, run for configured upstreams only and cached for 60 s in memory;
  - `analysisDefault`, from `/v1/capability`.
- **Pull:** `POST /crucible/models/pull {server, kind, id}` calls `submitTask({type:'pull', …})`. Task SSE is relayed to Socket.IO `crucible.task-progress`. **Remove:** `DELETE /v1/catalog/{kind}/{id}`.

---

## 7. The queue

### 7.1 Lanes

`QueueManagerService` keeps `mainPool` (5). The AI pool (1) is replaced by **lanes** in `backend/src/queue/crucible-lanes.ts`:

| Lane | Count | Takes | Concurrency |
|---|---|---|---|
| `gpu:<server>` | one per **enabled** registered server | `transcribe` (Crucible asr), `analyze` / `analyze-webpage` whose target resolves to a **local** model on that server | 1 |
| `upstream` | one | `analyze` / `analyze-webpage` whose target is `anthropic/*`, `openai/*`, `ollama/*` (or a class routed to one) | 2 (rate limits pass through as 429 + Retry-After) |
| `legacy-ai` | one, only while `aiBackend` resolves to legacy | today's AI pool behaviour, unchanged | 1 |
| `main` | the existing 5 | everything else, **plus** whisper-cli fallback transcribes, capped at **2 of the 5** (today up to 5 whisper processes can run at once) | 5 |

The `analyze` task is still one queue task. Inside it, the transcript is already done by the `transcribe` task, and the analysis holds **one lease** on one model for its whole run. That makes a video atomic on the card, as BF's `gpuHoldOf` does.

### 7.2 Admission

For each task, the scheduler loop (`processQueue`, :574) does the following:

1. **Venue.** For a local model, `venue-decision.ts` picks the first server that is enabled, reachable and ranked highest, and that can serve the task's job type or model (asr → `capability.asr`; a model id → `catalog.pulled || pullable`). For upstreams, the venue is the first enabled server with that upstream configured. If no venue is found, the task stays **pending with a reason line**: "Waiting for a Crucible server" or "No server has Claude configured — Settings › Crucible Servers". A task with no venue is never failed.
2. **Reach.** Poll `GET /v1/activity` on the venue (cached for 2 s). If the lane is held by another client, stay pending with that holder's sentence, taken from `activity` (BF's `busyLineOf`).
3. **Reserve.** For local LLM, send a `load-model` job, then `lease(model)`, then start a heartbeat every 30 s against the 120 s TTL. The task owns the lease until it settles. For asr, reserve means submitting the job.
4. **409 `server_busy` / `leased` at submit.** **Park**: free the lane slot, set `job.parkedReason = busyLine`, and set `job.status='pending'`. Ask again after 5 s with backoff up to 60 s, re-asking at once on `crucible.servers-changed` or when the lane frees. **Never fail on busy.** A parked task does not count as in-flight for `canStartJobLibrary`, so parking never blocks a library switch.
5. **503 `chat_queue_full`** inside a running analysis. Sleep for `Retry-After` and retry the same call. The lease is kept.

### 7.3 Grouping by model to avoid thrash

Crucible holds one resident model. The lane picker's `pickNext(lane)` prefers pending tasks whose resolved model equals the venue's current `resident_model` (from `activity`). It falls back to FIFO when a task has been waiting more than 10 min, so nothing starves.

Within one analysis, the snap stage and the LLM stages default to **the same model** (the `analysis` class). That avoids the "unload the scorer before a local flag verifier loads" swap the snap branch had to add (commit `9cd4adb`). If the user picks different models per task, the analysis takes them in a fixed order (snap → chapter LLM → flags verify → description/tags/title), grouped so each model loads once per video. A cross-video, stage-major batch is future work.

### 7.4 In-flight ledger, quit and startup sweep

- `crucible-in-flight.json` (the port of `in-flight-ledger.ts`) is written **synchronously before** every submit or lease: `{server, kind:'job'|'lease'|'load', id, model?, taskId, at}`. The row is removed when the task settles.
- **Quit:** `beforeApplicationShutdown` calls `sweepCrucibleInFlight({deadlineMs: 8000})`. It sends `DELETE` for jobs, releases leases, and unloads a model only if Briefcase loaded it and `activity` shows no other client's lease. Electron's SIGKILL window goes up to 12 s (§2).
- **Startup:** the same sweep runs over whatever the ledger holds, and it is **awaited before the GPU and upstream lanes start**. The main pool doesn't wait.
- The queue is not persisted today. Crucible-bound tasks that were running at quit are lost, as they are today. The sweep only guarantees the *card* is clean. Persisting the queue is out of scope.

### 7.5 Watchdog, cancel and progress

- **Watchdog.** The 90-min wall-clock AI timeout (:69) becomes a **stall** watchdog for Crucible-backed tasks: 15 min without a progress event, an SSE event or a completed chat call → fail as stalled. That is BF's `stream-stall` with Briefcase's number. The 90-min cap stays only on `legacy-ai`.
- **Cancel.** `cancelJob` → `job.cancel-requested` (unchanged) → the analysis's `AbortSignal`:
  1. it aborts the open chat or decide fetch;
  2. it sends `DELETE` for the open job;
  3. it releases the lease;
  4. the ledger row is removed.
  
  Previous analysis results stay intact. That's the rule from commit `0378d02`, and it's re-tested.
- **Progress.** Crucible SSE `progress` becomes the existing `task.progress`. asr maps `processed_s/total_s`; chat stages keep today's per-chapter progress.

### 7.6 Queue UI

`frontend-v3/src/app/components/queue-tab/` keeps its rows and gains a header strip, `queue-lanes.component.ts`, drawn from `SYSTEM_STATUS`, which is extended with `lanes[]`:

- "GPU · N Crucible servers": one chip per server, showing name, state (`ready | busy: <holder sentence> | unreachable | paused`), the resident model, and a **Running/Paused** switch that writes `routing.disabled`.
- "Cloud": the upstream lane's occupancy.
- Parked rows show their `parkedReason` in the row's secondary line, in grey, not red.
- `frontend-v3/src/app/services/queue.service.ts` and `models/task.model.ts` gain `parkedReason`, `venue` and `lane`.

---

## 8. The settings UI

- **New pane, `pages/settings/panes/crucible-pane.component.ts` ("Crucible Servers")**:
  - a list of registry rows with version, backend, reach, resident model and a masked token;
  - actions: **Test**, **Running/Paused** (a card toggle), **Remove** ("Forget"), drag-to-rank, which writes `routing.order`;
  - **Add server**: connect code / pairing line / discovered;
  - "This computer's connect code" (copy);
  - `crucible-doors` for the local face (install/adopt/start/update).
  
  It also takes over upstream keys: Claude key, OpenAI key and Ollama URL for the selected server, each with **Test** then **Save**. Only `key_hint` is ever shown.
- **The AI pane (`ai-pane.component.*`).** The per-task model choice (boundary/chapter/flags/description/tags/title) is one grouped `<select>` bound with **`ngModel`** (the known `[value]` bug from `model-picker-select-binding`). Its options are:
  - "Crucible's choice (analysis)";
  - the local catalog, each with a "Download" badge if not yet pulled;
  - Claude models, OpenAI models and Ollama models, from the upstreams.
  
  The analysis engine (classic/snap) moves here from hand-edited `app-config.json`. Snap shows "unavailable on this server: <reason>" when §6.7's gate fails.
- **Components pane (`components-pane.component.*`).** It keeps ffmpeg-tools and yt-dlp. **P7 removes** whisper (binary and models), llama, nli-ranker and the scorer section (commit `e93b109`), *unless* §13 Q2 keeps whisper-cli, in which case "Offline transcriber (whisper)" stays as one optional row.
- **Transcription pane.** "GPU mode" goes away for the Crucible engine. The pane shows the server's asr model choice and a note that translate uses the offline transcriber.
- **process-config inspector (`shell/inspector/process-config/`)** and `queue-item-config-modal`: the AI and whisper dropdowns take the same model list source, bound with `ngModel`.
- **`ai-setup-wizard`** becomes a thin wrapper that opens Settings › Crucible Servers. It's deleted in P7.
- Visual rules: card toggles with an orange border, and **no emoji**. User-facing strings live in `frontend-v3/src/app/shared/crucible-words.ts`, ported from BF where they apply.

---

## 9. The phases

Each phase is a sequence of commits on `feat/crucible` that ends with `npm run build:all` green, `cd backend && npx jest` green, and the app launched with the checks below. The flags live in `app-config.json` `aiBackend` (§0 #13).

### P1: SDK, registry, pairing, probe, the servers pane

**Files:**
- `backend/vendor/crucible-{client,bootstrap}-1.0.23.tgz`, `backend/package.json`, `tools/adopt-crucible-release.mjs`.
- `backend/src/crucible/{crucible.module,crucible.controller,registry.service,routing.service,client-factory,pairing-file,discovery,auto-connect.service,connect.service,probe,engine-resolve,errors}.ts`.
- `shared/crucible/{connect,settings}-wire.ts`.
- `backend/src/app.module.ts` (import `CrucibleModule`).
- `frontend-v3/src/app/pages/settings/panes/crucible-pane.component.*`, `frontend-v3/src/app/services/crucible.service.ts`, the settings layout nav entry.
- `backend/src/crucible/settings-bridge.service.ts` (GET/PUT/test only; no key migration yet).

**Tests:**
- `backend/test/fake-crucible/` (§10).
- `crucible/registry.spec.ts`: atomic write, masking, rank and pause.
- `pairing-file.spec.ts`: all three OS paths, `$CRUCIBLE_HOME`.
- `auto-connect.spec.ts`: adopts only when the registry is empty; refuses non-Crucible or bad token.
- `probe.spec.ts`: the four outcomes.
- `connect.spec.ts`: the device-code flow against the fake.
- `sdk-seam.spec.ts`: the SDK loads under CJS/Jest, and the vendored version equals the `package.json` pin (a port of `test-crucible-install-seam`).

**Acceptance:**
- On the Mac Studio with Crucible 1.0.23 running, launching Briefcase shows `local` in Settings › Crucible Servers within 5 s, with version `1.0.23` and backend `mlx-darwin`. Test turns green.
- Pausing, re-ranking and removing all survive a restart.
- Adding the PC by connect code works.
- With Crucible stopped, the app boots and the downloads, library, editor and Collections all work. The pane shows "unreachable". There are no unhandled rejections in the backend log.
- A packaged DMG contains `@crucible/client` in the backend's node_modules.

### P2: install and first-run

**Files:**
- `backend/src/crucible/install/{install.service,install-door,host-runner,engine-presence}.ts`, `coordinate.service.ts`, `module-setup.ts`.
- `shared/crucible/{install,install-door,coordinate}-wire.ts`, `shared/crucible/briefcase.module.json` (after §3.4 lands; until then coordinate is off and logs "no module file").
- `frontend-v3/src/app/components/crucible-doors/`, `crucible-install-progress/`, `components/setup-wizard/setup-wizard.component.ts` (the `engine` step; `models` removed).
- `electron/services/backend-service.ts` (12 s shutdown window).

**Tests:**
- `release-to-install.spec.ts`: all four rows of §5.2.
- `hostability.spec.ts`: darwin arm64 / x64, win32 with and without nvidia, linux with and without.
- `install.service.spec.ts`: the bootstrap module is injected as a fake; checks progress events, the one-at-a-time lock, the state file and resume.
- `coordinate.spec.ts`: posts the module only when something is missing; held until the wizard finishes.
- `module-file.spec.ts`.

**Acceptance:**
- On a machine *without* Crucible (a clean macOS arm64 VM or user account), the wizard's engine step installs Crucible, the service comes up, the `local` row appears, and coordinate starts `llm` + `asr` env installs with visible progress.
- On the Mac Studio, where Crucible is already installed, the wizard shows **adopt** and never installs.
- On an Intel Mac build (`package:mac-x64`, run on any x64 Mac or under Rosetta with `arch -x86_64`), the wizard shows **connect-only**.
- Skip works everywhere, and the app is fully usable without AI.
- Quitting during an install and relaunching shows the right face.

### P3: every LLM call through Crucible

**Files:**
- `backend/src/crucible/llm/{crucible-llm.service,target,params}.ts`, `backend/src/crucible/lease.ts`.
- `analysis/ai-provider.service.ts` (dispatch → `CrucibleLlmService` when `aiBackend.llm` resolves to crucible; `local` refused).
- `analysis/model-utils.ts` (temperature table unchanged; a helper `isCloudModel()`).
- `analysis/chapter-detection.service.ts` (skip embed under Crucible).
- `config/config.controller.ts` + `analysis/analysis.controller.ts` (model lists → `/crucible/models`).
- The task-models migration in `config/shared-config.service.ts`.
- `settings-bridge.service.ts` (key migration, §6.2).
- `frontend-v3/.../ai-pane.component.*`, `process-config`, `queue-item-config-modal` (the model list source), `models/video-processing.model.ts`.

**Minimal admission for P3** (this is replaced in P4): the AI pool stays at 1. Inside the task, `withLease(model)` loads and leases. A 409 busy is retried every 10 s for up to 30 min while holding the pool slot, with the holder's sentence shown as task progress text.

**Tests:**
- `crucible-llm.service.spec.ts` against the fake, with the **captured request body** asserted for each row of §6.1's parameter table. Above all: **no `temperature`, `top_p` or `max_tokens` in any `anthropic/` or `openai/` body**; `temperature` present for `ollama/` and local; `response_format` shapes; the act header `analysis`.
- The `model_not_resident` → load → retry path.
- `upstream_unconfigured` → a clear error.
- 429 passthrough.
- Cancel aborts the fetch and releases the lease.
- `ai-analysis-engine.spec.ts` extended so that zero successful chapters throws.
- `key-migration.spec.ts`: writes, checks the hint, deletes; keeps the file on failure; never writes to a remote server.

**Acceptance:**
- The same 3 reference videos analysed four ways: through Crucible local `qwen3.5-9b` (or the Mac's analysis class), through `anthropic/<current sonnet>`, through `openai/<current>`, and through `ollama/qwen3.5:4b`. Every one yields chapters, flags, description, tags and title. Results are stored and visible on the timeline.
- Chapter counts are within ±30 % of the legacy path on the same model family. The lexical-only boundary is the known risk, and it's recorded in the PR.
- Setting `aiBackend.llm=legacy` restores today's behaviour.
- `api-keys.json` is gone after migration, and Claude still works.

### P4: queue admission, lanes and the sweep

**Files:**
- `backend/src/queue/crucible-lanes.ts`, `backend/src/crucible/{venue-decision,in-flight-ledger,in-flight-sweep}.ts`.
- `queue/queue-manager.service.ts`: lanes replace the AI pool; park/unpark; `pickNext` by resident model; the stall watchdog; the sweep awaited before lanes start; `canStartJobLibrary` ignores parked tasks.
- `queue/queue.controller.ts`, `common/websocket.service.ts` + `websocket.types.ts` (`SYSTEM_STATUS.lanes`).
- `frontend-v3/.../queue-tab/*`, the new `queue-lanes.component.ts`, `services/queue.service.ts`, `models/task.model.ts`.

**Tests:**
- `crucible-lanes.spec.ts` with fake timers: one lane per enabled server; a paused server takes nothing; venue by rank; 409 → parked → unparked when the fake frees; a parked task does not pin the library; upstream tasks run 2-wide alongside a busy GPU lane.
- The same-model preference and its 10-min starvation guard.
- `in-flight-sweep.spec.ts`: the ledger is written before submit (a crash between the ledger write and submit leaves only a harmless row); the quit sweep hits its deadline; the startup sweep cancels and releases; it never unloads a model another client leases.
- A **download regression**: 20 queued URL downloads with Crucible unreachable finish at the same main-pool concurrency (5), and their transcribe/analyze tasks park with a reason.

**Acceptance:**
- With BookForge narrating on the Mac's Crucible, a Briefcase analysis parks with BookForge's holder sentence and starts by itself when the narration ends.
- Pausing the local server moves new work to the PC.
- Killing the backend mid-analysis (`kill -9`) and relaunching leaves no Briefcase lease in `crucible api activity`.
- The queue UI shows the lanes and the Running/Paused switch.
- Nothing regresses in download or process-video throughput.

### P5: ASR

**Files:**
- `backend/src/media/transcription/{transcription-engine,whisper-cli.engine,crucible-asr.engine,transcript-to-srt}.ts`.
- `media/whisper.service.ts` (engine selection per §6.6).
- `media/media-operations.service.ts`, `media/media-processing.service.ts`, `analysis/analysis.service.ts`, `analysis/simple-transcribe.controller.ts` (callers keep their signatures; any that bypass `WhisperService` are routed through it).
- `queue/crucible-lanes.ts` (`transcribe` → a GPU lane when the Crucible engine is chosen; whisper-cli fallback capped at 2 in main).
- `frontend-v3/.../transcription-pane.component.ts`.

**Tests:**
- `transcript-to-srt.spec.ts`: overlaps, empty segments, times past 10 h, HH:MM:SS,mmm.
- `crucible-asr.engine.spec.ts` against the fake: upload bytes, params exactly `{language, vad_filter, word_timestamps}`, SSE progress mapping, the artifact fetch, cancel → DELETE, a failed job → the task fails with the server's message.
- Selection: translate → cli; no server → cli; server without asr → cli; unreachable registered server → park.

**Acceptance:**
- The 10-video side-by-side from §6.6 is recorded in the PR: time and diff ratio. Crucible asr is **no worse in quality and no slower in wall time per video** on the Mac Studio. Otherwise asr stays behind `aiBackend.asr=legacy` by default and the numbers go to the user.
- The transcript search and the editor work on Crucible-made transcripts.
- A translate download still produces an English transcript.

### P6: snap via Crucible

**P6a (can land any time after P3; doesn't wait on Crucible):**
- **Files:** `backend/src/scorer/backends/{snap-backend,local-scorer.backend}.ts`; refactor `snap-analysis.service.ts`, `chapters/snap-chapter.service.ts` and `flags/snap-flag-ranker.service.ts` onto `SnapBackend`, handling `caps.maxOptions`.
- **Tests:** the existing scorer specs pass unchanged through `LocalScorerBackend`; a new `caps.spec.ts` covers the option-splitting and disabling behaviour.

**P6b (waits for a Crucible release that carries the decide door):**
- **Files:** repin the SDK (adopt script); `backend/src/scorer/backends/crucible-snap.backend.ts`; the gate in `scorer/analysis-engine.ts`; the AI pane's snap availability line.
- **Tests:**
  - `crucible-snap.backend.spec.ts` against the fake's `/v1/decide`: key prefixing keeps letter order for names `"1".."12"`; logProbs and rawLogProbs derivation; `label_not_in_probs` → a skipped unit counted in `missingLabels`; 409/503 handling; a 404 decide → "not served".
  - The flag eval harness (`scorer/flags/eval/flag-eval.ts`) gets a `--backend crucible` switch.
- **Acceptance:** on the PC (vLLM, qwen3.5-9b), the flag eval and chapter eval match or beat `LocalScorerBackend` on the same fixtures (record precision/recall and chapter boundary F1 in the PR). On the Mac, the gate chooses classic with a visible reason until §12 A2 is resolved.

### P7: remove the legacy runtimes

This goes in two parts, because snap may still be waiting.

- **P7a (after P5 acceptance)**, delete:
  - `bridges/llama-manager.ts`, `bridges/llama-bridge.ts`;
  - `analysis/ollama.service.ts`, `analysis/ollama-capabilities.ts`;
  - the Anthropic and OpenAI SDK usage in `ai-provider.service.ts` (and `@anthropic-ai/sdk` / `openai` from `backend/package.json` if nothing else uses them);
  - `config/api-keys.*`;
  - the embed step in `chapter-detection.service.ts`;
  - `'local'` from every provider union;
  - the `aiBackend.llm` flag;
  - the llama binaries-v1 component;
  - `components/ai-setup-wizard/`;
  - the Ollama install step anywhere in the setup wizard.
  
  Whisper-cli is removed only if §13 Q2 says so.
- **P7b (after P6b acceptance)**, delete the scorer's llama-server lifecycle (§6.7 list), `analysis/nli-ranker.service.ts`, `common/nli-env.ts`, the nli-ranker python-env component (`config/model-catalog.ts:~280`, `components/component-manager.service.ts:~468`), the scorer model-catalog entries, the scorer section in the Components pane, and the `aiBackend.snap` flag.
- **Tests:** `npx jest` green with the deleted specs removed. Add a grep test (`legacy-runtime-gone.spec.ts`) asserting that no source file imports `llama-manager`, `ollama.service`, `@anthropic-ai/sdk` or `nli-ranker`.
- **Acceptance:** a fresh install on a clean arm64 Mac downloads *no* AI binaries from the binaries-v1 manifest. Everything AI arrives through Crucible's module. The DMG is no larger than before.

---

## 10. The test harness: `backend/test/fake-crucible/`

This is a TypeScript port of `BF/tools/fake-crucible.js`: a real `http.Server` on an ephemeral port, started per test file, with no Electron stub. It speaks the routes **in the shapes the SDK parses**:

- **Public:** `GET /v1/ping`; `/v1/info` (with configurable `version`, `api_version`, `backend`); `/v1/capability`; `/v1/activity`; `/v1/catalog`; `POST /v1/pairing/start|poll`.
- **Settings:** `GET/PUT /v1/settings` (keys stored and hinted), `POST /v1/settings/upstreams/:name/test`.
- **Models:** `GET /v1/models`; `POST /v1/models/:id/lease|heartbeat|release` (TTL honoured with an injectable clock).
- **Uploads:** `POST /v1/uploads` (multipart parse; records the bytes and filename).
- **Jobs:** `POST /v1/jobs` (`load-model`, `unload-model`, `asr`), `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events` (SSE with ids and `Last-Event-ID` resume), `GET /v1/jobs/:id/artifacts/:name` (a canned `transcript.json`), `DELETE /v1/jobs/:id`.
- **Chat:** `POST /v1/openai/chat/completions`. It enforces residency for local models, echoes captured bodies for upstream prefixes, and can return canned content per model.
- **Tasks:** `POST /v1/tasks` (`module`, `pull`) + SSE.
- **Decide:** `POST /v1/decide` (P6b; the PHASE22 wire shape).

**Fault injection** is a `fake.inject({...})` API, covering:

- `serverBusy`, carrying the holder sentence;
- `leased`;
- `chatQueueFull`, carrying the retry-after;
- `unauthorized`;
- `modelNotResident`;
- `upstreamUnconfigured`;
- `status429`;
- `dropConnectionAfterBytes`;
- `stallSseForMs`;
- `labelNotInProbs`;
- `decideNotFound`;
- `apiVersion2`.

`fake.requests` records every request (method, path, headers, parsed body), so specs can assert things like "no temperature to anthropic".

Jest runs these as ordinary specs (`backend/test/crucible/*.spec.ts`, plus co-located specs). Add an npm script `test:crucible`.

**Live checks** (not in CI): `backend/test/crucible/live.smoke.ts` points at `CRUCIBLE_URL`/`CRUCIBLE_TOKEN`, then does ping, one tiny upstream chat if one is configured, one local load+chat+release on the smallest catalog model, and one 30-second asr. Run it by hand at each phase's acceptance.

---

## 11. Risks and how the plan handles them

| Risk | What could happen | How the plan handles it |
|---|---|---|
| **Switching libraries mid-flight** (one `DatabaseService.db`) | A task running on Crucible takes minutes to hours, which is a wider window than today | `canStartJobLibrary` is unchanged for running tasks. **Parked tasks don't count as in-flight**, so a park never blocks a switch, and a parked task re-checks the library when it unparks. Crucible jobs never touch the DB; results are written only at finalize, inside the task, under the existing guard. `transferVideos` and `relinkByHash` are still unguarded (a known issue) and this plan doesn't widen that. |
| **Cancel** | An aborted chat fetch may not stop the engine at once (mlx-lm can finish its current generation) | Release the lease, remove the ledger row, and treat cancel as done on the client side. Crucible's `_chat_over` settles the card. The task never waits on the engine. Previous analysis results are kept (the `0378d02` rule). An asr cancel is a real `DELETE`. |
| **Crucible down** | AI tasks fail in bulk | They **park, they don't fail**, with "Crucible on <name> isn't answering". The lane chip goes red. Downloads, library, editor and Collections are unaffected by construction (§5.3). A **misconfiguration** fails at once with a pointer to settings: bad token, unconfigured upstream, or a `local:` target. |
| **Crucible down at boot** (a late volume, a service not yet up) | Boot is slow or fails | Nothing awaits Crucible at boot. The probe retries on the queue's `reach()` schedule. Crucible's home is on the internal disk, and the library volume is irrelevant to it. |
| **Windows/WSL** | UAC, a restart, no asr without WSL, SIGTERM being a hard kill | We use BF's host runner and its sentences. The whisper-cli fallback covers asr. The startup sweep covers the missing quit hook. The first acceptance run on the PC is a required step in P2. |
| **Version skew** | Server newer than SDK: additive, fine. Server older than a route we need (decide, a future translate). A server on API 2. | Probe refuses `apiVersion !== 1` with "Crucible <v> speaks a newer protocol; update Briefcase". Features are **detected**, never inferred from the version string (404 on `/v1/decide` → not served). `MIN_CRUCIBLE = '1.0.23'` in `probe.ts` marks older servers "needs update" in the pane and routes nothing to them. SDK repins use the adopt script only. |
| **Another app's lease** (BookForge narrating for hours) | Briefcase's AI waits a long time | This is by design: the task parks with the holder's sentence. The user can pause the busy server or rank another above it. A Crucible-side lane reservation (which BF also still needs) is not assumed. |
| **Thrash between models** | Load and unload per video | The same-model preference (§7.3), and one default model for snap and the LLM stages. |
| **Quality regression** | From losing embeddings (classic chapters), from Ollama's context default, or from asr engine differences | Acceptance gates with recorded numbers in P3, P5 and P6. Every area has a flag back to legacy until P7. |
| **Keys** | Deleting the old file before the new one is confirmed | The hint check comes before deletion. Nothing is pushed to a remote server without being asked. The file is kept on any failure. |
| **The download pipeline** | A regression in a business-critical path | P4 includes a main-pool throughput regression spec. Whisper-cli transcribes are capped at 2, and the rest of the pool is unchanged. No Crucible code is on the download → import path. |

---

## 12. What Briefcase needs from Crucible (send these to the Crucible repo, in priority order)

- **A1: Release the decide door** (`feat/decide-door`), with SDK `decide()`. P6b is blocked on this.
- **A2: More than 11 logprobs on mlx-darwin.** Either Crucible's own mlx logprobs path, or a documented option-splitting contract. This is PHASE22 §7.4. Briefcase asks 26-option questions (chapter assign) and 11-option ones (flag pass 1), so without this, snap on the user's Mac Studio stays classic.
- **A3: `missing_labels: "floor"` on `/v1/decide`**, and per-option raw logprobs in the answer. Briefcase's Viterbi needs a finite log P for every option. Today the door refuses the whole request with `label_not_in_probs`. A caller-set `top_k` ceiling (up to the engine's cap) would also help.
- **A4: Ollama upstream parity.** Translate `thinking` and `num_ctx` for the `ollama` upstream, by routing to Ollama's native `/api/chat` or by passing `options`. Also surface the `reasoning` text on replies (the SDK `ChatResponse` has no field for it). Without this, `ollama/*` runs at Ollama's default context and with the model's default thinking.
- **A5: `task: "translate"` on the `asr` job.** Whisper supports it, and Briefcase's downloads use it. This is the main thing keeping whisper-cli around.
- **A6: The `briefcase` module** (§3.4). This is our own PR to `modules/briefcase.toml`.
- **A7 (nice to have): a `tokenize` or `count_tokens` route** for the resident model, for exact snap chunk planning. chars/4 works meanwhile.

---

## 13. Decisions from the user (2026-09-23), replacing the open questions

1. **Intel Mac and non-NVIDIA Linux: no local Crucible, by design.** Crucible installs only on Apple Silicon (darwin) or NVIDIA hosts, and that's expected. On those machines Briefcase skips the install and has the user connect to a Crucible on another computer that they choose. There is no direct cloud path: all AI goes through Crucible.
2. **Server model: exactly BookForge's.** Briefcase finds the local Crucible automatically. If none is installed, it walks the user through the install. Settings and setup both let the user connect a different Crucible server, remote or LAN. Keys and upstreams live on whichever Crucible serves the call, configured through that server's settings as BookForge does (engine-settings). Briefcase doesn't copy keys between servers.
3. **Whisper stays local.** whisper-cli remains Briefcase's transcriber. **P5 (ASR through Crucible) is dropped from the critical path.** It may come later as an option, but nothing depends on it. Translation is not a Briefcase requirement: videos are transcribed in their spoken language, and if anything ever needs translating, it goes through a separate text-translation step on Crucible (typically Qwen 27B). The existing `--translate` transcribe option can stay as it is; nothing is built around it.
4. **Decide-route limits get fixed in Crucible.** The user is raising the candidate cap on the Mac and adding a lenient mode for missing labels on the decide-door branch (see §12 A2 and the floor policy). Briefcase targets the full option counts: 26 for chapter assign and 11 for flag pass 1. Classic analysis stays the fallback until that lands.
5. **Still open, with defaults applied:**
   - Transcriber model: moot while whisper stays local.
   - Embeddings: the classic chapter path goes lexical-only under Crucible, as a stopgap until snap chapters take over.
