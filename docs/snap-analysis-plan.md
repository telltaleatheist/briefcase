# Snap Analysis: Chapters and Flags on Logit Decisions

Design doc, 2026-09-23. Branch `feat/snap-scorer`. Status: **planning**. The snap core is
being ported to TypeScript at `backend/src/scorer/` in parallel; this doc treats that port
as a `decide()` primitive and plans everything built on top of it.

> `docs/` is gitignored (`.gitignore:87`). Commit with `git add -f docs/snap-analysis-plan.md`.

Line numbers below are for this worktree, which matches `main` HEAD (`9cbcb57`).

---

## 1. Summary

**What changes.** Both halves of AI analysis move onto one local "scorer": a Qwen3.5
llama-server that answers multiple-choice questions by reading next-token letter
probabilities (snap). There is no sampling and no decoding, and every question after the
first reuses the primed transcript's KV cache.

| Stage | Today | After |
|---|---|---|
| Chapter boundaries | Embedding valleys (nomic-embed-text), then per-boundary LLM quote placement (`chapter-detection.service.ts`) | ContentStudio `segment.py`: the model writes an outline, snap assigns every sentence to an outline item, and Viterbi with a switch cost finds the boundaries |
| Chapter titles | One LLM call per chapter (`buildChapterAnalysisPrompt`) | The outline labels. The summary call stays, and only its summary is used. |
| Flag candidates | DeBERTa NLI in a resident Python venv (`nli-ranker.service.ts`), threshold 0.2 | One snap choice per sentence over {categories + none}, a two-option second pass on hot sentences, and Viterbi spans |
| Flag judgement | LLM verifier, one call per (window, category), all verified | **Same verifier, same prompt, same cache**, but only the top-ranked spans are verified |
| Storage / UI | `chapters`, `analysis_sections` (verdict, nli_score) | Same tables. One new column (`ranker`), one new verdict value (`candidate`) and a retuned Review threshold. |

**What goes away (eventually).** The NLI Python environment: `common/nli-env.ts`,
`nli-ranker.service.ts`'s worker half, `backend/python/nli-worker/`, the `nli-ranker`
component (~1.2 GB venv + model), and the embedding chapter scorer. Nothing is removed
until the evaluation in §6 passes. Until then, NLI stays the fallback.

**What stays.**
- Whisper segments carry every timestamp. The scorer only picks letters, the outline
  model only writes labels, and times come from the segments that sentences were
  assembled from. No model emits a time, and no phrase matching happens on this path.
- The verifier: `buildFlagVerificationPrompt` (`prompts/analysis-prompts.ts:514`), the
  `flag_verdict_cache`, and the "store every verdict, filter at display time" ruling.
- The metadata stages (tags, description, title from chapters) and per-task model routing
  (`resolveTaskConfig`, `ai-analysis.service.ts:743`).
- AI stays optional. The scorer is a downloadable component like whisper. A user who
  never installs it gets today's pipeline, and a user with no AI at all gets none.

**Goals.**
1. Chapters that match creator chapters, measured at YTSeg F1@±1 ≥ 0.70 and Pk ≤ 0.23.
   ContentStudio measured 0.72 and 0.21-0.23.
2. Flag recall at least equal to the NLI path on the user's confirmed flags, with fewer
   verifier calls and no picket fence.
3. About 9 min of analysis per hour of video on the M1 Ultra, end to end. (See §7: the
   exact ContentStudio layout does not hit this, so a layout change is proposed and has to
   be benchmarked.)
4. One Python-free, CUDA-capable local engine on macOS and Windows.

---

## 2. Background: what snap does, in one paragraph

snap (`/Volumes/Callisto/Projects/snap`, `docs/CONTRACT.md`) renders `system → user(State:
<state>\n\n<question + lettered legend + "Answer with the letter only.">) → assistant
slot` through the model's own chat template. It asks llama-server for one token with
`n_probs: 40`, `samplers: []` and `cache_prompt: true`, then reads the probabilities of
the label tokens `A..Z`. Those probabilities are renormalised, and `label_mass` (their raw
sum) reports whether the model was answering the question at all. Qwen3.5 is a hybrid
model (DeltaNet + full attention every 4th block), so KV reuse needs a **context
checkpoint**. snap therefore primes the shared prefix (system + state) as its own request,
which lands a checkpoint exactly at its end. Each question then prefills only its own
tokens. The contract has three hard limits:
- at most 26 options;
- every label must be a single token;
- a label missing from the top-40 raises `label_not_in_probs`.

ContentStudio's bench worked around the third with `bound_missing=True`.

---

## 3. Shared foundation

### 3.1 Sentence units

There are two splitters.

| | Briefcase `assembleSentences` (`nli-ranker.service.ts:491`) | ContentStudio `sentences()` (`submap.py:32`) |
|---|---|---|
| Split | `/[.!?]+["')\]]*(?=\s\|$)/` over joined segments | `[^.!?]+(?:[.!?]+[\"')\]]*\|$)`, essentially the same |
| Times | first overlapping segment's `start`, last overlapping segment's `end`, so **measured** | start segment's start + character fraction through it, an **interpolated** estimate |
| Short sentences | kept ("Okay." is a unit) | folded into the next sentence if under 4 words |

**Use Briefcase's splitter, and add the fold.** Create a new `assembleUnits(segments)` that
calls `assembleSentences` and then applies these steps:

1. **Fold** sentences under 4 words into the following sentence (ContentStudio's
   `min_words=4`). The merged unit takes the first sentence's `start` and the second's
   `end`, so both times are still segment times. This removes 10-20 % of units ("Yeah.",
   "Right.") that carry no subject. Without the fold they fragment Viterbi runs and cost a
   question each.
2. **Cap run-ons.** Whisper sometimes emits minutes of unpunctuated text. A unit over 60
   words or 30 s is split at segment boundaries into roughly 30-word pieces. Each piece
   uses its own segments' times.

Leave `assembleSentences` itself unchanged. It is what the NLI thresholds were calibrated
against, and NLI remains the fallback.

**Timing note.** When a sentence starts mid-segment, its `start` is the segment's start,
so it can be early by up to one segment (2-8 s). For a chapter marker, early is the right
direction to err: the viewer lands just before the new subject. Nothing interpolates.

### 3.2 One primed state for chapters and flags

In snap's layout the options live in the question, so the shared prefix is just `system
+ "State:\n" + transcript`. It is **identical for chapter-assign and flag questions**. The
scorer therefore primes each transcript chunk once, then runs all of these against that
checkpoint:
- the chapter assign questions;
- the flag pass-1 and pass-2 questions;
- the plug confirmations.

The state text is the units joined with `\n`, exactly as `segment.py:106`
(`text = "\n".join(sents)`) does.

The outline is a *generation* request with a different prompt
(`"Here is a transcript of a video.\n\n" + text + …`), so it does not share the
checkpoint. It re-reads the chunk, at about 10 s per 7k tokens. That cost is acceptable,
and keeping the measured outline prompt verbatim matters more than saving it.

**Proposed optimisation (must be benchmarked, §7):** move the legends into the prefix.
The prime becomes `transcript + "Sections:\nA. …\nZ. …\n\nCategories:\nA. …"`, and each
question shrinks to about 100 tokens (the sentence, the previous sentence and one line of
question). That cuts per-question prefill by roughly 4-5×. Both legends sit in the one
prefix, so the state is still shared. This departs from snap's contract layout, so the TS
port needs a `decideWithPrefix(prefix, questions)` entry point alongside `decide()`.

### 3.3 Long videos: chunk with overlap

A 64k context holds about 4 h of speech at 150 wpm, but less for fast talkers. Four other
constraints tighten it:
- The outline caps at **25 items** (26 letters minus the plug). A 3-hour stream has 40+
  subjects.
- Attention cost per question grows with context. On a 96k-token book, questions cost
  100-142 ms against 38-43 ms on a small state (snap README, 3090 Ti).
- The measured regime is ≤ ~7-12k tokens: YTSeg videos of 60-320 sentences, and
  ContentStudio's ~7k-token transcripts.
- Outline quality on a 40k-token read is unmeasured.

**Plan (`planChunks(units)`):**
- A transcript of ≤ 16k tokens (roughly 60-75 min) is one chunk. That covers most videos,
  and they run exactly as measured.
- A longer transcript is split into equal cores of ≤ 12k tokens. Each core carries
  **2k tokens (~8-10 min) of overlap context** on each side. The state is overlap + core +
  overlap.
- Every unit is **owned** by exactly one core. Flags are scored only in the owning chunk,
  and the overlap is context only.
- Chapters: each chunk runs its own outline, assign and Viterbi over overlap + core, and
  the seam goes at the middle of the overlap. If the chapter covering the seam in chunk *k*
  and the one in chunk *k+1* both cover ≥ 80 % of the overlap units, they are one chapter.
  It keeps the label from the chunk that holds more of its units. Otherwise the boundary
  nearest the seam wins.
- Token counts come from llama-server's `/tokenize`, not a character heuristic.

### 3.4 Scorer lifecycle

A **separate llama-server instance**, owned by a new `ScorerServerService`
(`backend/src/bridges/scorer-server.ts`). It is not `LlamaManager`, which hard-codes
`-c 8192` (`llama-bridge.ts:200`) and serves chat.

```
llama-server -m <models/scorer/Qwen3.5-9B-*.gguf> --alias briefcase-scorer
  -c 65536 --ctx-checkpoints 32 --parallel 1 -fa on -ngl <computed> --no-webui
  --host 127.0.0.1 --port <free port>
```

These are the same flags ContentStudio's `ladder.py:17-19` runs. `-ngl` reuses
`LlamaManager`'s VRAM-aware computation (`llama-manager.ts:147`).

- **Start lazily**, at the first analysis that needs it. Health-poll `/health`, and fail
  within 180 s into the fallback path with a user-facing warning, the same way
  `userFacingUnavailableMessage` works today.
- **Keep it alive across a queue batch.** Stop it after 10 idle minutes and on
  `OnApplicationShutdown`.
- **Memory handoff.** All scorer stages of a video finish before any LLM stage starts
  (chapter summaries, verification, metadata). If the verifier is local (ollama/local) and
  the machine has < 48 GB unified memory or < 24 GB VRAM, stop the scorer before
  verification. Otherwise leave it resident for the next queued video.
- **Cancellation.** Register with `activeRuns` like the NLI worker (`nliRanker.stop()` in
  the `finally` at `ai-analysis.service.ts:1448`). Abort the in-flight `/completion` with
  the run's `AbortSignal`. llama-server cancels a task when its client disconnects; verify
  this in the port. Leave the server itself running.
- **Proof at startup** (snap's `/v1/health` build): the chat template is answer-ready, all
  26 letters are single tokens, and the model name is logged.
- **`label_not_in_probs`.** With 26 options, low letters can fall outside the top 40.
  Request `n_probs: 100`. Bound any still-missing label at the smallest returned
  probability, as `bench.py`'s `bound_missing` did, and log the count.

---

## 4. Chapters: port of `segment.py`

Source: `content-studio-chaptering-ref/segment.py`. Results: F1@±1 0.72 and Pk 0.21-0.23
on 24 YTSeg videos, with a switch cost of 20 best (`bench_snap.py` sweeps 10/20/30/40).
Two things measured worse: asking about boundaries directly (`bench.py` pair / window /
pick variants), and a yes/no "statement is true" phrasing, which collapsed to 142/144 yes.

### 4.1 Outline (generation)

The prompt is verbatim from `segment.py:40-43`. `max_items` = 25
(`MAX_ITEMS = MAX_OPTIONS - 1`):

```text
Here is a transcript of a video.

{text}

List the sections of this video in the order they happen. A new section starts wherever the video moves to a different subject, story, clip, ad or aside. Write one short, specific label per line (at most {max_items} lines), with no numbering and nothing else.
```

The request is `/v1/chat/completions` with `temperature 0`, `max_tokens 1000` and
`chat_template_kwargs: {enable_thinking: false}`. The temperature is sent only to the
local server; the Claude/OpenAI paths go through `ai-provider.service.ts`, which sends no
sampling parameters.

Parsing (`segment.py:50-58`):
1. Strip `" -*•\t"` from each line.
2. Drop empty lines, and dedupe case-insensitively.
3. Cap at 25 items.
4. If fewer than 2 items remain, throw.

Two defensive additions that don't change behaviour on the measured model:
- also strip leading `\d+[.)]\s*` and markdown `**`;
- clip labels to 120 chars.

A throw falls back to the embedding chapter detector for that video.

**Which engine writes the outline?** The trade-offs:

| Option | For | Against |
|---|---|---|
| Scorer model (same llama-server) | Measured: F1 0.72 is with 9B BF16 outlines. Local, free and deterministic, with no extra model load. | If the ladder picks a 2B/4B scorer, outline quality is unknown. `ladder.py` reuses **9B outlines** for every scorer size. |
| User's configured LLM (`resolveTaskConfig(aiConfig, 'chapter', …)`) | Likely better labels on a 27B/Claude, which become the user-visible titles | Unmeasured for segmentation. Label specificity drives assignment, and a cloud model may write different-granularity labels. Costs a model load. |

**Recommendation.** Write the outline with the scorer model when it is 9B-class, which is
the measured configuration. If the scorer is smaller than 9B, route the outline to the
user's configured `chapter` model. The existing `taskModels.chapter` override still wins
when it is set explicitly, so a Claude user can opt in. Bench both on YTSeg before
flipping any default.

### 4.2 Assign (snap choice per unit)

Options are `{"section k": item}` for k = 1..n, plus the plug item (§4.4). The question is
verbatim from `segment.py:71-74`:

```text
Sentence from the transcript above: "{clip(sents[i], 300)}"
(The sentence just before it: "{clip(prev, 200)}")
Which section of the video is this sentence part of?
```

`prev` is `"(start of the video)"` for i = 0. For a chunk other than the first, it is the
real previous unit from the overlap. `clip` truncates with `…`. The result is
`L[i][j] = log(max(p_j, 1e-12))`.

`BATCH = 64` in `segment.py` is an artifact of snap's HTTP API: each `decide` request
primes once. The TS port primes once per chunk and streams every unit's question against
that checkpoint, with no batching. Progress ticks per 64 units, so the queue bar moves.

### 4.3 Viterbi (any order, flat switch cost)

This is a direct port of `segment.py:123-144`. Any item may follow any other, which
handles returning to a subject after an aside. Every switch costs `switch_pen` = **20**.
The complexity is O(n·m): each step compares against the single best previous state
minus the penalty.

```ts
// dp_i[j] = L[i][j] + max(dp_{i-1}[j], max_k dp_{i-1}[k] - pen)
```

`runs(path, j)` and `boundaries(path)` come across verbatim (`segment.py:147-161`). Do not
use `bench.py`'s `monotone_segment`. Monotone ordering was the alternative that
`segment.py` superseded.

### 4.4 Ad/plug item: confirm and re-run

The fixed item is verbatim from `segment.py:23`:

```text
An ad, sponsor read or self-promotion (Patreon, merch, a book, asking viewers to subscribe or support)
```

It is appended to every outline as the 26th letter. `confirm_plugs` (`segment.py:87-103`)
repeats these steps until no stretch is left unchecked:
1. Run Viterbi.
2. For each run of the plug item not yet checked, ask a yes/no question about the passage
   (`clip(" ".join(sents[a:b]), 700)`), with this statement:

```text
Passage from the transcript above: "{passage}"
In this passage the speaker is advertising or promoting something: a sponsor, their own Patreon, merch, a book, or asking viewers to subscribe, follow or support them.
```

3. If p < 0.5, set that stretch's plug column to −1e9 and re-run.

**Caveat worth measuring.** This is a `yesno`, which is the question type that collapsed to
acquiescence in the boundary experiments. The port keeps it verbatim, since it is part of
the measured F1. The eval (§6.3) logs the plug-verdict distribution. If it is
nearly all yes, replace it with a two-option choice: "Promotion: the speaker advertises a
sponsor or their own products, or asks viewers to subscribe or support" against
"Content: the passage is part of the video's actual subject".

### 4.5 Boundaries to chapters

- Chapter starts are `[0] + boundaries(path)`. Chapter *c* starts at `units[b_c].start`,
  except that the first chapter starts at `0`: chapters cover the whole timeline
  (`database.service.ts:633`). It ends at the next chapter's start, or at the last
  segment's end.
- **Title** is `items[path[b_c]]`, the outline label. The plug item displays as
  "Sponsor / self-promotion". A subject the video returns to after an aside keeps its
  label, and the second occurrence gets " (continued)".
- **Summary**: keep the existing per-chapter LLM call (`analyzeChapterWithRetry`,
  `ai-analysis.service.ts:1510`), and **discard its title**. Tags, description and
  suggested title are all generated from chapter summaries
  (`generate*FromChapters`, called at `:1360-1380`), so dropping summaries would degrade them.
  Without a configured LLM, the summary is `''` and the metadata steps are skipped.
- **No `splitLongChapters`** (`:1467`) on this path. Forced splits manufacture chapters
  at arbitrary times, which `chapter-detection.service.ts`'s header documents as a failure.
  Viterbi owns granularity through `switch_pen`.

**Storage and UI: no change.** The pipeline emits the same `Chapter` objects
(`ai-analysis.service.ts:101`) with `HH:MM:SS` times via `formatDisplayTime` (`:3167`).
`media-operations.service.ts:780-803` and `analysis.service.ts:1253` write them to
`chapters` unchanged. Record the engine in `analyses.ai_model`, for example
`snap:qwen3.5-9b-bf16 + ollama:qwen3.8:27b`, so a library can tell which rows came from
which pipeline.

---

## 5. Flags on the snap scorer

### 5.1 Pass 1: one choice per unit

Against the primed chunk state, each unit gets this question:

```text
Sentence from the transcript above: "{clip(cur, 300)}"
(The sentence just before it: "{clip(prev, 200)}")
Which of these does the speaker do in this sentence?
```

Options are each enabled category plus a final `none`. Keys are the category names; snap
renders the legend as `"{key}: {text}"`. The option text must be a **short, discriminating
act description**, derived from `HYPOTHESES` (`nli-ranker.service.ts:177`). Never use the
`DEFAULT_CATEGORIES` descriptions (`analysis-prompts.ts:27`): those are LLM instructions
("flag even if quoted", "NOTE: do NOT flag…"), and a scorer reads an instruction as
content. Proposed text:

| key | option text |
|---|---|
| political-demonization | Calls political opponents communists, Marxists, or enemies of the country |
| hate | Shows hostility or mockery toward a group because of race, religion, ethnicity, sexuality, or identity |
| dehumanization | Describes people as vermin, disease, zombies, or less than human, or calls opponents' politics a mental illness |
| conspiracy | Presents a conspiracy theory (stolen election, deep state, a hidden plot) as true |
| violence | Calls for, threatens, or glorifies violence |
| political-violence | Defends or downplays a political attack, riot, or insurrection |
| extremism | Defends oppression, supremacy, ethnic cleansing, or authoritarian rule |
| christian-nationalism | Says Christianity or the church should run government, or that God is directing the nation or its leaders |
| false-prophecy | Claims God spoke to them or someone they cite, or announces a prophecy or revelation |
| prosperity-gospel | Asks followers for money as a religious duty, or promises blessing in return for giving |
| none | None of these: ordinary talk about something else |

The multi-hypothesis categories (`dehumanization`, `christian-nationalism`) collapse
their alternatives into one line, because a choice option can hold a disjunction. The
`none` option is **topic-phrased, not stance-phrased**. Putting "reporting or criticising
it" into `none` would pull the stance judgement into a model that cannot reason, and it
would cut the recall the verifier depends on. Pass 1 is a candidate generator.

A category the user created, with no tuned text, uses the first sentence of its
description clipped to 140 chars, and the log says so (as `buildPlan` does today). More
than 25 enabled categories is refused with a warning, since that is 26 letters with
`none`.

These strings move out of `nli-ranker.service.ts` into a new
`backend/src/analysis/flag-categories.ts`, together with `HYPOTHESES` and `PROPOSITIONS`.
Both rankers then share one source, and removing NLI later does not delete them.

**Output:** a full probability vector `P_i` over {cats, none} per unit, stored in memory
and dumped to the debug log for eval.

### 5.2 Hotness and pass 2 (multi-category competition)

`hot_i = 1 − P_i(none)`.

A softmax over categories makes them compete. A sentence that is both hateful and
dehumanizing splits its mass 0.45/0.45, and neither looks strong. NLI avoided this with
`multi_label` (`docs/nli-flag-ranking.md` §4). Pass 2 restores independent per-category
evidence cheaply, only where it matters:

- For every unit with `hot_i ≥ 0.2`, and every category with `P_i(c) ≥ 0.05` (at most the
  top 3), ask a **two-option choice**:

```text
Sentence from the transcript above: "{cur}"
(The sentence just before it: "{prev}")
Does this sentence fit the description below?
Description: {option text for c}
A. Fits: the speaker {does this} in this sentence
B. Does not fit: the sentence is about something else
```

The result is `q_{i,c} = P(A)`. The format is a two-option choice with both sides stated
positively, which is the form that fixed acquiescence in ContentStudio. It is not
`yesno`.

Estimated volume: 10-20 % of units are hot, with about 2 categories each. That is roughly
150-300 short questions per hour.

### 5.3 Spans: Viterbi over {none, cats}, then category-blind merge

Run Viterbi over the states {none, c1…ck}, globally across chunks, as follows:

- **Emissions.** `none: log P_i(none)`. Every category state gets the *pooled* emission
  `log(hot_i) − τ`. Pooling is deliberate. With per-category emissions, four categories
  at 0.15 each lose to `none` at 0.4 even though the sentence is 60 % hot, which is the
  dilution pass 2 exists to fix.
- **Costs.** `none ↔ cat` costs λ. `cat ↔ cat'` is free. With these costs the chain
  decides *on/off*, and category identity cannot split a span. This is a two-state
  Viterbi written as the (k+1)-state one.
- **Starting values** (to be tuned in §6): λ = 3 and τ = 0. At λ = 3, one unit at
  hot ≈ 0.95 can open a span, and a single cold unit inside a hot run does not break it.
- **Post-merge**, reusing today's constants (`nli-ranker.service.ts:383-387`): two spans
  separated by ≤ 1 unit or ≤ 5 s join, category-blind. The result is paragraph spans, never
  a picket fence.
- **Span categories.** `s_c(span) = max_{i∈span} q_{i,c}`, using pass 2. If there is no
  pass-2 value, fall back to `P_i(c)/hot_i`. Keep categories with `s_c ≥ 0.5`, and keep
  at least the top one.

### 5.4 Ranking with a co-fire boost

`strength(span) = Σ_c log(1 − s_c)`. More negative is stronger. This is the noisy-OR
complement in log space, exactly as `rankWindows` sorts (`nli-ranker.service.ts:1308`),
and it avoids the float saturation that comment describes. Two categories at 0.9 outrank
one at 0.97, which is the boost the user asked for. Ties break on `Σ hot_i` over the span,
then on time.

### 5.5 Top-N to the existing verifier

Map each snap span to the verifier's existing unit. For each (span, category), build a
`FlagCandidate` with `spanFrom/spanTo` = the span, `score` = `s_c`, `proposition` =
`PROPOSITIONS[c]` and `source: 'sentence'`. Feed these to **`buildWindows`**
(`nli-ranker.service.ts:633`, pure and exported). That reuses the ±2-unit context
expansion, the 25 s context cap, the merge rules and the noisy-OR window score unchanged.

Then refactor `runRankedFlagStage` (`ai-analysis.service.ts:1938`) to take its windows
from a `FlagRanker` interface, implemented by NLI or snap, rather than calling
`nliRanker.rankWindows` itself. Everything after that stays unchanged:
- the descending-order walk;
- the question hash and `flag_verdict_cache`;
- `buildFlagVerificationPrompt`;
- the no-sampling rule for cloud calls.

It gains one input, a **verify budget**:
- verify every (window, category) with `s_c ≥ 0.5`, in strength order;
- cap at `max(20, 60 × hours)` calls, which is about 3 min/h on the 27B at ~3 s/call
  (NLI made 134 calls on the 60-min reference video);
- cache hits don't count against the cap.

**Long spans.** A span over 40 s (`WINDOW_MAX_MERGED_SECONDS`) is verified as ≤ 40 s
sub-passages, because 60 s passages measurably diluted the second category. Adjacent
sub-passages that both come back `flag` are **stored as one section** covering the union.
The 40 s cap limits what the verifier reads, not what the user sees.

### 5.6 Storage mapping

| Field | Snap path |
|---|---|
| `verdict` | `'flag'` / `'skip'` for verified pairs. **New `'candidate'`** for spans above the capture floor that the budget did not reach. They are stored, never discarded, per the 2026-08-25 ruling. |
| `nli_score` (column kept) | the row's category `s_c`. Keep the physical column name: renaming it needs a table rebuild on every library DB (some live on `/Volumes/Callisto`) and buys nothing. Rename the TS field to `rankerScore` over time. |
| **new `ranker TEXT`** | `'nli'`, `'snap-v1'`, or NULL for legacy rows. Migration 26 in `database.service.ts` follows the pattern of migration 24 (`:1809`). Backfill `'nli'` where `nli_score IS NOT NULL`. |
| `description`, times | Unchanged: `buildWindowSections` / `buildSkipSections` (`:1765`, `:1828`); times from `units[from].start` / `units[to].end` |

**Frontend (`frontend-v3/src/app/models/flag-filter.ts`):**
- `NEAR_MISS_SCORE` (`:80`, 0.9, set for NLI's bimodal distribution) becomes
  `NEAR_MISS_SCORE: Record<ranker, number>`. NLI keeps 0.9. The snap value is chosen on
  the regression set so the Review tier is about as large, relative to Confirmed, as NLI's
  measured tiers (13/79, 16/37, 2/32, 6/20).
- `passesFlagFilter` (`:120`): `'candidate'` rows show at **All** only.
- `isGhosted` (`:142`): candidate rows get a distinct caption, "not verified (below the
  verification budget)".
- `FlagFilterable` gains `ranker`.
- Plumbing: `video-editor.model.ts:48`, `video-player.component.ts:1312/1330`,
  `insertAnalysisSection` (`database.service.ts:3918`) and its callers
  (`media-operations.service.ts:759`, `analysis.service.ts:1175`).

### 5.7 Misinformation

NLI excludes misinformation because entailment degenerates it to "makes a factual
assertion" (169/205 candidates, 19/20 false positives; `MISINFORMATION_EXCLUSION`, `:289`).
Snap is not entailment. A 9B model does carry some world knowledge ("vaccines cause
autism" is recognisably false), but it answers from a first impression, and truth is the
one judgement a first impression is worst at.

**Recommendation: keep it excluded in v1, which is parity with NLI, and run it as an eval
arm.** In the arm, add `misinformation: "States as fact something that is widely known to
be false (debunked medical, scientific, or historical claims)"` to pass 1. Then measure:
- precision against legacy discovery-path misinformation rows;
- how much mass it steals from real categories, the failure NLI saw.

Ship it only if precision holds. It must never go straight to Confirmed without the
verifier. The discovery fallback (`BRIEFCASE_FLAGS_DISCOVERY=1`, `:358`) stays as the
misinformation path until then.

---

## 6. Evaluation

Everything runs offline against cached scorer outputs: the logp matrices and probability
vectors are dumped per video, so tuning λ/τ/`switch_pen` never re-runs the GPU. This is
the `bench-cache/` pattern.

### 6.1 Flag regression set (the user's libraries)

- **Source:** `analysis_sections` rows with `source='ai'` in every library DB
  (`~/Library/Application Support/briefcase/libraries/*/library.db`), plus the transcript
  from `transcripts`.
  - `verdict='flag' AND nli_score IS NOT NULL` are verifier-confirmed NLI flags: silver
    positives.
  - `verdict='skip'` rows are rejected candidates: topical, but not asserted.
  - Legacy NULL rows are discovery-path flags: weak positives.
- **Gold:** the hand audits of the two reference videos (watters 12 min, hank 60 min;
  `final-score.txt`, 10/10 and 11/11) are the only human labels. Every tuning decision
  must hold on them.
- **`flag_verdict_cache` is not a label source.** It stores a hash, category, model and
  verdict, not the passage text (`database.service.ts:622`). Its value here is cost: a snap
  window whose passage text matches an NLI window's is a free cache hit.
- **Metrics per video, snap vs NLI:**
  - Recall of confirmed flags: a snap span overlaps the row's time range. Measure it
    category-agnostic and category-matched, at the pass-1/Viterbi stage (before any
    budget) and after verification.
  - Precision proxy: snap-confirmed spans that overlap no NLI candidate at all. Hand-review
    a sample of 30.
  - Verifier calls, total runtime per hour, and scorer-only runtime per hour.
  - **Picket-fence count:** section pairs < 5 s apart. It must be 0.
  - Span length distribution.
- **Pass criteria:** recall of confirmed flags ≥ NLI's, full recall on both hand audits,
  fewer verifier calls, and ≤ 9 min/h end to end.

### 6.2 Option-order bias

Snap reads letter probabilities, and letter priors are real.
- Run pass 1 on 200 units under the canonical order, the reversed order and one random
  rotation. Report total-variation distance per unit and flips of the argmax or of
  hotness across 0.5.
- Put `none` first versus last.
- Rotate the chapter outline order on 5 YTSeg videos. Outline order is chronological, so
  a bias toward early letters would look like "prefer the start of the video".
- Content-free probe: ask pass 1 with the sentence replaced by `"(no sentence)"` to get
  the letter prior.

If the bias moves results, apply contextual calibration: divide by the content-free prior
and renormalise. That costs one question per chunk. Averaging two orders would double the
cost.

### 6.3 Chapters

- **Port the YTSeg bench**: the same 24 videos (`bench.py sample(24)`, `SEED = 7`),
  F1@±1, F1@±3, Pk, and the `switch_pen` sweep. Easiest route: a dev-only endpoint that
  takes `sents[]` and returns `{items, logp, path}`, so `bench_snap.py` scores the TS
  pipeline unchanged. **Pass:** F1@±1 within 0.02 of Python's 0.72 on the same model.
  That proves the port; model and layout changes are then measured against it.
- **Owen's videos**: `owen_outline.py` compares against creator chapters at ±15/30/60 s.
  Use yt-dlp's `chapters` field from the video's info JSON where the library has one, and
  the user's own channel.
- **Log the plug verdict distribution** (§4.4).
- **Existing AI chapters in the libraries are not ground truth.** They came from the
  embedding pipeline, so compare against them only for sanity (count per hour).

### 6.4 Layout and size ablation (the ladder)

A 2×N grid:
- **layout:** snap-contract (options in the question) vs legend-in-prefix;
- **scorer:** 9B BF16, 9B Q8_0, and whatever the pending 0.8B/2B/4B ladder recommends.

Measure chapter F1/Pk, flag recall, and wall time per hour for each cell. Outlines stay on
9B for every cell, as in `ladder.py`.

---

## 7. Runtime budget (estimates, to be replaced by §6.4)

There is exactly one measured anchor: **0.70 s per 26-option question per sentence**, 9B
BF16 on the M1 Ultra, with priming at about 10 s per 7k tokens. A 60-min video is about
750 units after the fold (the hank video has 801 sentences). The rest is extrapolated
linearly by question tokens:
- a 26-option legend is about 500 tokens per question;
- an 11-option legend is about 330;
- legend-in-prefix is about 100 tokens plus a fixed restore/checkpoint overhead.

| Per hour of video, 9B BF16 | Snap-contract layout | Legend-in-prefix |
|---|---|---|
| Outline (read + generate) | ~35 s | ~35 s |
| Prime (1-2 chunks) | ~20 s | ~25 s |
| Chapter assign (750 × 26 options) | ~525 s | ~150 s |
| Flag pass 1 (750 × 11 options) | ~345 s | ~130 s |
| Flag pass 2 (~250 × 2 options) | ~60 s | ~40 s |
| Plug confirms | ~5 s | ~5 s |
| **Scorer subtotal** | **~16 min** | **~6.5 min** |
| Verify (≤ 60 calls × ~3 s, 27B) | ~3 min | ~3 min |
| Chapter summaries (existing) | ~2 min | ~2 min |
| **Total** | **~21 min** | **~11.5 min** |

The exact ContentStudio layout is about 2× over the 9 min/h target. Three levers:
- **legend-in-prefix** (§3.2), the biggest;
- **a smaller scorer**, pending the ladder;
- **Q8_0**: prefill on Metal is compute-bound, so the gain from Q8 is uncertain; measure it.

Whether each lever preserves accuracy is exactly what §6.4 measures. Nothing in this table
is a promise.

---

## 8. Rollout

### 8.1 Settings and fallback order

Add to `app-config.json`, read like `taskModels`:

```json
"analysisEngine": { "chapters": "snap" | "classic", "flags": "snap" | "nli" },
"scorerModel": "scorer-qwen3.5-9b-bf16"
```

The defaults are `classic` / `nli` until §6 passes. After that they flip to `snap`
wherever the scorer is installed. The fallback chain runs per stage, and each step down
is warned on the job the same way `userFacingUnavailableMessage` does today:

- **chapters:** snap, then the embedding detector (`chapter-detection.service.ts`)
- **flags:** snap, then NLI, then chapter discovery

The inspector's process-config panel gets no new control in v1; the setting is
config-file-only until the default flips. The one UI change is the Settings → Components
entry.

### 8.2 Binaries: llama.cpp b10964+ via `binaries-v1`

Qwen3.5 needs b10964 or later. The manifest ships **b7482**
(`scripts/package-llama-extra.js:24`), and Windows gets `bin-win-cpu-x64`
(`package-llama-extra.js:27`).

- **macOS arm64:** rebuild `utilities/bin/llama-server-arm64` and the dylib set
  (`package-binaries.js:166-176`) at b10964+. Re-sign and notarize through the existing
  `afterSign` hook.
- **macOS x64:** bump `LLAMA_VERSION` in `package-llama-extra.js`.
- **Windows x64:** add a **CUDA** artifact (`llama-<tag>-bin-win-cuda-12.4-x64.zip` plus
  its `cudart-…` runtime zip, ~0.5 GB together) and keep the CPU zip as the fallback. The
  manifest has one artifact per (platform, arch) (`component.types.ts`). Add the CUDA
  build as a separate component id, `llama-cuda`. The component manager selects it when
  `gpu-info.ts` detects an NVIDIA GPU with ≥ 8 GB, and `runtime-paths.ts` prefers it.
- **Linux:** still no manifest artifacts. The scorer is unsupported there and the
  pipeline falls back cleanly.
- Republish `binaries-v1/manifest.json` with `scripts/publish-binaries.js`. The live
  manifest wins over `assets/manifest.json`, so editing only the local file does nothing.
- One binary serves both `LlamaManager` and the scorer. Check the chat path still starts
  on the new tag; `COGITO_MODELS` is empty, so nothing uses it today.

### 8.3 Scorer model: component catalog

Models are never bundled. Add `SCORER_MODELS` and `scorerModelComponents()` to
`backend/src/config/model-catalog.ts`, next to `WHISPER_MODELS`. Downloads come straight
from Hugging Face with a pinned `sha256` and byte count. Details:
- **New kind `'scorer-model'`** in `ComponentKind`. It installs to `<configDir>/models/scorer/`
  so `ModelManagerService` and `LlamaManager` never list it as a chat model.
- **Wire it into** `ComponentManagerService.getAllComponents()` (`:99`).
- **Mirror:** the official `Qwen/…-GGUF` repo if it publishes the needed quants. Otherwise
  `unsloth/Qwen3.5-9B-GGUF`, which is what snap uses (`README.md`, Setup).

| Entry | Size | For |
|---|---|---|
| Qwen3.5-9B BF16 | ~18 GB | ≥ 48 GB unified memory. This is the measured configuration. |
| Qwen3.5-9B Q8_0 | ~9.5 GB | 24-32 GB machines, 12-24 GB CUDA cards |
| Smaller rung (4B/2B) | TBD | only if the ladder clears it |

### 8.4 First-run wizard and settings

- **`setup-wizard.component.ts`:** the AI step gets an "Analysis engine (local, recommended
  for chapters and flags)" group next to "Flag detection" (`:74`). It is **not
  pre-selected**, because AI stays optional. It recommends a size from RAM/VRAM, and
  selecting it also queues the llama binary. That is the same coupling the local-model
  toggle has (`:372`).
- **`components-pane.component.html`:** a "Analysis engine" section. The "Flag detection"
  section (`:119`) stays until NLI is removed.

### 8.5 Removing NLI (after eval passes, one release later)

Delete:
- `backend/src/common/nli-env.ts`;
- the worker/lifecycle half of `nli-ranker.service.ts`. Keep `assembleSentences` and
  `buildWindows`, moved to `analysis/flag-windows.ts`;
- `backend/python/nli-worker/`;
- `nliEnvComponents()`;
- the wizard and settings entries;
- `docs/nli-flag-ranking.md`, archived with a pointer here.

Existing `ranker='nli'` rows keep rendering with their own Review threshold. Offer a
one-click "remove the flag-ranking environment (1.2 GB)" in Components.

---

## 9. Phased task list

**Phase 0: bench harness (Python, no app changes).**
- Run the §6.4 grid with ContentStudio's scripts plus a legend-in-prefix variant of
  `assign`.
- Record the flag pass-1 probability vectors on the hank and watters videos.
- Pick the layout, the scorer size, and the starting λ/τ.

**Phase 1: scorer runtime.**
- `backend/src/scorer/`: `decide()` (in progress), `decideWithPrefix()`, `n_probs: 100`,
  bounded missing labels.
- `backend/src/bridges/scorer-server.ts`: `ScorerServerService` for spawn, health, idle
  stop, cancellation and the memory handoff; registered in `bridges.module.ts`.
- Unit tests: template proof, label tokens, a fake engine for `label_not_in_probs`.

**Phase 2: shared units and chunks.**
- `backend/src/analysis/snap/units.ts`: `assembleUnits` (fold + run-on cap over
  `assembleSentences`) and `planChunks` (tokenize, 16k/12k/2k).
- Specs: times stay segment times, and every unit has exactly one owner.

**Phase 3: chapters.**
- `backend/src/analysis/snap/segmenter.ts`: `outline`, `assign`, `viterbi`, `runs`,
  `boundaries`, `confirmPlugs`, seam stitching, and `toChapters()`. The prompt strings are
  verbatim constants with a `SEGMENT_PROMPT_VERSION`.
- `ai-analysis.service.ts`:
  - Pass 1 branch at `:1140-1160`: snap segmenter, else `detectBoundaries`;
  - `analyzeChaptersPass2` (`:2210`): accept preset titles, run summary-only, skip
    `splitLongChapters` on the snap path;
  - the progress bands (`:1216-1223`) gain a scorer band.
- A dev endpoint for `bench_snap.py`. **Gate:** YTSeg F1@±1 within 0.02 of 0.72.

**Phase 4: flags.**
- `backend/src/analysis/flag-categories.ts`: moved `HYPOTHESES`/`PROPOSITIONS` and the new
  `SNAP_OPTIONS`.
- `backend/src/analysis/snap/flag-scorer.ts`: pass 1, pass 2, span Viterbi, ranking, and
  `FlagCandidate[]` into `buildWindows`.
- `ai-analysis.service.ts`:
  - a `FlagRanker` interface;
  - `runRankedFlagStage` (`:1938`) takes windows plus a verify budget, stores
    `'candidate'` rows and merges adjacent accepted sub-passages;
  - path selection (`:2380`) runs snap, then NLI, then discovery.
- `database.service.ts`: migration 26 (`ranker`), the `'candidate'` verdict type
  (`:87-97`, `:3918-3960`).
- `media-operations.service.ts:759` and `analysis.service.ts:1175`: pass `ranker`.
- Frontend: `flag-filter.ts` (per-ranker near-miss threshold, `'candidate'`),
  `video-editor.model.ts:48`, `video-player.component.ts:1312/1330`.

**Phase 5: evaluation (§6).**
- A regression script over the library DBs: read-only, opening copies, never the live
  files.
- Bias probes, and tuning of λ/τ/`NEAR_MISS_SCORE['snap-v1']`.
- A written report, then the go/no-go call.

**Phase 6: distribution.**
- The llama b10964+ artifacts including Windows CUDA; `package-binaries.js`,
  `package-llama-extra.js`, `publish-binaries.js`; manifest republish.
- `model-catalog.ts` `SCORER_MODELS`, the `'scorer-model'` kind, the component manager,
  the wizard and the components pane.

**Phase 7: default flip, then NLI removal a release later (§8.5).**

---

## 10. Open questions for the user

1. **Scorer size.** The 0.8B/2B/4B ladder is running. If 4B matches 9B on assignment, do
   you want 4B as the default scorer (faster; outlines then come from your configured LLM)
   or 9B everywhere (one model, measured end to end)?
2. **BF16 (18 GB) vs Q8_0 (9.5 GB).** Only BF16 has been measured for chaptering. Should
   the wizard offer both and pick by memory? Or offer Q8 only, to halve the download, if
   §6.4 shows no loss?
3. **Misinformation.** Keep it excluded in v1 (the recommendation) and run it as an eval
   arm, or do you want it in pass 1 from the start, verifier-gated?
4. **NLI removal.** Remove the Python env one release after the flip (recommended), or
   keep it as a permanent fallback for machines that can't run the scorer (Linux, < 16 GB)?
5. **Outline engine for cloud users.** If your configured model is Claude, should outlines
   (the visible chapter titles) come from Claude, or stay on the local scorer for
   consistency with the benchmark?
6. **Verify budget.** Is ~60 verifier calls per hour (~3 min on the 27B) the right cap,
   given that everything above it is stored as an unverified candidate visible at **All**?
7. **Layout departure.** If legend-in-prefix is what gets under 9 min/h at equal accuracy,
   are you comfortable with the TS scorer departing from snap's contract layout for this
   pipeline? snap itself is unchanged.
