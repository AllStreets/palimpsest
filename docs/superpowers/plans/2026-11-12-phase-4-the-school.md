# Phase 4: The School Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 1 (2026-11-12).** Written before any builder check. It pre-empts the four classes the Phase 2 and Phase 3 checks found: every interface a task consumes is either named with its file as it stands today or produced by an earlier task here; every model call and every minute of training is charged and capped (Task 1 adds the spend kinds, Task 4 the lease, Task 7 the training charge); every test that would pass before its change is marked as a pin; the large pieces (the trainer, the nets, the arenas, the LoRA, the campus) are split so a reviewer can reject one and approve its neighbour.

**Goal:** Open the university: the city breeds agents on arenas built from his own repos with Beagle's engine, fine-tunes small local coders with LoRA on MLX from verified past work and graduates only those that beat their base on a sealed set, trains five small nets and a master net from what actually happened, shows every one of them with held-out scores and confidence intervals, and asks his permission, kind by kind and repo by repo, to act on its own once the master agrees with him often enough, dropping any grant the moment a revert says it was wrong.

**Architecture:** A school layer under `engine/school/` owns everything new. Beagle (`AllStreets/beagle`) is imported as a library through one loader (`engine/school/beagle.ts`) that points Beagle's store under the Palimpsest home and replaces Beagle's model driver with one that goes through Palimpsest's own `Provider.complete()`, leases and credits, so no Beagle call can bypass the caps, the sandbox or the night cap. Arenas are built from connected repos (planted bugs and real past issues), verified by running each repo's own suite under the tool profile, and registered with Beagle as ordinary arenas whose tools run through the command broker. Training (the nets, the LoRA) runs in a native arm64 Python venv in `trainer/` with `mlx` and `mlx-lm`, as a warm subprocess under its own sandbox profile, only when the training gate holds (on AC power, idle, inside the window, cool, with disk, with no local job waiting); it yields to real work and resumes from checkpoints. The nets are small MLPs trained in MLX and exported as JSON weights; the engine runs their forward pass in TypeScript (`shared/nets.ts`), so a prediction never needs Python. The master's predictions are registered before he decides, resolved against what he then did, and the autonomy gate reads only those prospective pairs; every path that cannot prove the gate holds refuses. Graduates are served by `mlx_lm.server` through a new `mlx:` backend. The UI adds the school screen, the autonomy section in Settings and on the district page, brief items to grant and revoke, and in the city the university campus on its own plot with the observatory where the master net lives.

**Tech Stack:** Node 22.13+, TypeScript, tsx, `node:test`, `node:sqlite`, three.js 0.187, Vite 8, Playwright, Tauri 2, `gh`, `git`, `sandbox-exec`, `pmset`, `ioreg`, the `claude` CLI 2.1.319+ (his own install), Ollama 0.40+ on `127.0.0.1:11434`, Beagle at a pinned commit, Python 3.12 arm64 (uv's `cpython-3.12-macos-aarch64-none`), `mlx` 0.32.4, `mlx-lm` 0.32.2, numpy.

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 4 in section 13; sections 2 goals 6 and 7, 4, 5, 6.1, 6.2, 6.4, 7.2, 7.3, 8, 9.1 to 9.4, 11, 12 and 17 apply). The Phase 2 plan (`2026-11-10-phase-2-market.md`, "Phase 2 ruling n", "Phase 2 test safety rule n") and the Phase 3 plan (`2026-11-11-phase-3-analysis-and-brief.md`, "Phase 3 ruling n") fix the conventions this plan continues.

**Starting head.** Both tracks start from the head where `phase-3-screens` and `phase-3-city` have merged, which contains Phase 2's final review fix `b1bb756` (`home()` throws under a test whose home is unset or real). A task that finds `engine/home.ts` without `onRealDataHome()` stops and asks the controller. The city track additionally needs Phase 3 Task 14's `towerPiece()` in `app/src/city/scene.ts`.

**What was found on this Mac (2026-11-12), read-only:**
- Beagle is cloned at `~/Downloads/beagle` (clean, head `4edbd39`, public repo). Since the 2026-11-08 audit it fixed two of the six findings: breeding outside geotag (`aae774c`: `validate(x, tools)` takes the arena's tools) and the sandbox (`6b58364`: fix-test grading runs under `sandbox-exec`, custom graders in a worker). Still open at `4edbd39`: the self-check prompt is geotag's (`src/runner.ts:88`, "is that really where this happened"), parent against child is compared only in the browser's scales (`app/src/holdroom.ts`), never in the engine, fossils are geotag only (`src/fossil.ts` imports geotag's grader), and there is no LoRA. For use as a library it also lacks: a package entry (no `exports`), a lazy home (`src/paths.ts` reads `BEAGLE_HOME` once at import), a designer model option (`DESIGNER` is fixed to `claude:claude-opus-5-5`), an abort for races and breeding, and the `mlx:` prefix (`validate()` and `complete()` accept only `claude:` and `ollama:`). Beagle's sources are TypeScript with `.ts` import specifiers run under `--experimental-strip-types`.
- MLX is **not** importable from any system Python (`/usr/bin/python3` 3.9.6, `/opt/homebrew/bin/python3` 3.14.5, Anaconda 3.8.8 x86). It **is** installed in Beagle's own venv: `~/Downloads/beagle/trainer/.venv` (CPython 3.12.7 arm64 from uv, `mlx` 0.32.4, `mlx_lm` 0.32.2, whose `server.py` parses tool calls). uv itself is the x86 build under Anaconda but installs the arm64 interpreter, as Beagle's `trainer/README.md` shows. No MLX language model is in the Hugging Face cache (`~/.cache/huggingface/hub` holds two unrelated transformers models).
- Hardware: Apple M5 Pro, 64 GB, on AC power at 100% when checked.
- His real Palimpsest ledger holds 20 `repo.analyzed`, 7 `repo.connected`, 1 `repo.disconnected` and 1 `run.ended`: no bids, inspections, brief actions or merges yet. **Every net starts with no labels.** Earned autonomy at 50 decisions per kind is months away on his real data; the plan is written so the school is honest about that, not so it looks busy.
- Understudy's database (`~/Library/Application Support/Understudy/understudy.db`) holds 37 taste statements (the bible), 400 readings, 1,724 images and **0 answered calibration pairs and 0 verdicts**. The Taste net has no labels from Understudy today.

## Decisions for Connor

Twelve calls, one line each, with the recommendation the plan is written to. Answer in plain text; a yes to all changes nothing below.

1. **Beagle import:** a pinned git dependency on `AllStreets/beagle` at the commit where Task 2's library fixes merge, vendored under `vendor/beagle/` only if tsx refuses TypeScript inside `node_modules`. Recommend yes.
2. **Who fixes Beagle:** Task 2 makes the seven small library fixes by hand as one PR on Beagle for you to merge; fossils beyond geotag and LoRA in Beagle stay as Beagle README-versus-reality jobs for the city. Recommend yes.
3. **When the Mac trains:** only on AC power, not in Low Power Mode, after 15 idle minutes, between 01:00 and 06:00, thermals nominal, 20 GB free, no local job waiting; "Train now" in Settings skips the window and the idle check but never AC power. Recommend yes.
4. **The LoRA base model:** download `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` (about 4.3 GB) once, only when you click "Download" in Settings. Recommend yes.
5. **LoRA training data:** city merges that passed inspection and survived 30 days, plus your own merged PRs on connected repos that were never reverted, never any sealed-set item; it never leaves this Mac. Recommend yes (market merges alone would leave the school idle for months).
6. **Understudy:** let the engine read Understudy's database read-only for its taste statements and answered pairs, for the Taste net only. Recommend yes.
7. **The school's Claude spend:** voyages race local models only; the designer runs on `claude:sonnet` at most 30 credits a day (3% of a five-hour window) inside every existing cap, the night cap included, else `ollama:qwen3-coder:30b`. Recommend yes.
8. **Kinds of work:** six kinds: `propose:harness`, `propose:readme-gap`, `merge:low`, `merge:normal`, `merge:high`, `merge:ui`. Recommend yes.
9. **The agreement window:** 95% over the last 50 decisions of a kind, pooled across repos, counting only predictions recorded before you decided, an abstention counting as a disagreement; a repo is asked about only once it has 10 decisions of that kind with none of its last 10 against the master. Recommend yes.
10. **Acting under a grant:** the master must predict approve at 0.9 or more on that item and the window must still hold at that moment, else the grant is suspended and asked again; a revert drops the grant and the next ask waits until the window holds again with the revert counted. Recommend yes.
11. **The appraiser in the award:** shown beside every bid from the day it beats the pass-rate baseline on held-out data; it enters the award only after that, as the mean of the firm's calibrated confidence and the appraiser's pass chance. Recommend yes.
12. **Where the university stands:** on the next free plot of the district spiral, taken the first time Phase 4's engine starts, so nothing already standing moves. Recommend yes.

## Global Constraints

- Engine API on `127.0.0.1:4770` only, with the Host and Origin checks and the `x-palimpsest: 1` header on every write; UI dev server on `4771`. Ollama only at `127.0.0.1:11434`, only from the engine. `mlx_lm.server` only on a loopback port the engine picks, only from the engine; the engine port, `11434` and every live run's proxy and broker ports stay denied to it.
- Data directory `~/Library/Application Support/Palimpsest`, overridable with `PALIMPSEST_HOME`; every test sets it to a temp dir, and `home()` throws under a test whose home is unset or real. Everything the school writes lives under `paths().school` (`<home>/school`: `beagle/`, `arenas/`, `nets/`, `lora/`, `graduates/`, `logs/`).
- `redact()` (`engine/market/jobs.ts`) and `scrub()` (`engine/market/api.ts`) on everything that leaves the engine: every net view, voyage, genome instruction, arena task brief, graduate card, prediction reason, autonomy row, brief item, ledger row and event; the UI cleans again with `cleanText()`. Training data files never leave `paths().school` and are never served by the API.
- The market is off by default (`Repo.market false`). The school is off by default too: no arena is built, no voyage sails and nothing trains until he turns `school.enabled` on in Settings; the nets' nightly retrain is part of the school switch. No autonomy grant exists until he grants one, per kind and per repo.
- Nothing trains on his Claude plan. Every Claude call the school makes (the designer, any `claude:` genome he allows to race) goes through `Provider.complete()` under an `acquire(model, 'school', …)` lease and `charge({ kind: 'school' })`, so it counts in the day cap, the night cap, the hard stop, `citySpent`, the treasury and the report, and it also stops at `school.claudeCreditsPerDay`. Local training and local inference are charged as `kind 'train'` and `kind 'school'` local credits (Phase 2 ruling 1) so the treasury shows their minutes.
- The training gate (ruling 6) is re-read every 30 s while anything trains or races; when it fails the trainer is stopped within 30 s and resumes from its last checkpoint. A gate input that cannot be read fails the gate.
- Earned autonomy is fail-closed: an action under a grant happens only when every check in ruling 18 answers yes at that moment; any error, missing net, stale net, unreadable ledger row or abstention means no action and a recorded reason. A revert of an autonomous merge revokes its grant before any other autonomous action on that repo is considered.
- Never without asking: unchanged. An autonomous merge is a PR merge through `gh pr merge --merge --match-head-commit <run.headSha>` on a repo whose grant he gave; never `--admin`, never a force, never a branch delete beyond the city's own `palimpsest/*` branch.
- No loops: the school never creates jobs. A graduate or bred agent bids like any agent. Auto-accepted proposals come only from audits and harness detection, which never run after a city merge (Phase 3 ruling 6). `docs/SELF_RECURSION_GUARDRAILS.md` gains the school and autonomy arrows (Task 17).
- Ledger: every voyage, generation, arena build, training start, pause and end, net version, master prediction, decision, ask, grant, decline, suspension, revocation and autonomous action is recorded append-only with kinds from `LEDGER_KINDS`, replays and is compared by `verifyReplay()`.
- Tests never touch port 4770, the real data home, the keychain, his real `~/.claude`, `~/.codex` or `~/.gemini`, Beagle's real home, Understudy's real database or the Hugging Face network (test safety rules below).
- The ui-test guard from home is 850 draw calls and 12M triangles; the campus must fit inside it with every Phase 2 and Phase 3 ornament standing.
- No em dashes, `--` or emojis in UI copy, README, report pages or commit text. No AI look: sentence case, hairline rules, ledgers not cards, no badges, scores shown as numbers with their interval, never as stars or bars of glow.
- Every visible change: build, screenshot at full size and zoomed crops, critique, iterate (three rounds for 3D, two for screens); rounds and what is still weak go in the commit body.
- README media only from the sample dataset, never his repos or session content.
- Commit trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UGpw98HC7NNMT1jveHzgfa`.

## Test safety rules (Phase 2 rules 1 to 10 hold; these are added)

11. No test spawns the real Python, `mlx_lm.lora`, `mlx_lm.server` or `trainer/school.py`: every spawn goes through `getSpawner()` and tests install fakes. The trainer's own tests are `npm run test:trainer` (Python `unittest` on synthetic data under a temp dir with `HF_HUB_OFFLINE=1`), never part of `npm test`, and are skipped with a message when `trainer/.venv` is absent.
12. No test reads Understudy's real database: the reader opens only `PALIMPSEST_UNDERSTUDY_DB` under a test, refuses the default path the way `home()` does, and tests point it at a fixture they build.
13. No test imports Beagle with `BEAGLE_HOME` unset or at Beagle's real home (`~/Library/Application Support/Beagle`): `loadBeagle()` sets it to `paths().school/beagle` (which `home()` already confines) and throws if it resolves anywhere else; every test replaces Beagle's driver with a fake and sets `BEAGLE_BACKOFF_MS=0`.
14. No test runs `pmset`, `ioreg`, `df` or `sysctl` for real: the gate's probes go through `getRunner()` and tests answer them.
15. No test or route downloads a model: every trainer environment carries `HF_HUB_OFFLINE=1` except the one download action (Task 23), which tests run against a fake spawner.
16. No test runs `gh pr merge`: it goes through `getRunner()` like every `gh` call (Phase 2 rule 4), and `githubWriteRefused()` refuses it on the real home under a test.

## Phase 4 rulings on spec gaps

1. **Beagle as a library** (spec 9, 12). Palimpsest depends on `"beagle": "github:AllStreets/beagle#<sha>"` at the commit where Task 2 merged. Only `engine/school/beagle.ts` imports it, by dynamic `import()` of its package entries, with the types Palimpsest uses declared in `engine/school/beagle-api.ts` (so `tsc` never checks Beagle's sources). `loadBeagle()` sets `BEAGLE_HOME` to `paths().school/beagle`, calls Beagle's `setDriver(schoolDriver)` and refuses to return Beagle if its home resolves outside `paths().school`. Palimpsest uses: `race()`, `sealedScore()`, `startVoyage()`, `finishVoyage()`, `breed()`, `compareToParents()`, `summarize()`, `bootstrap()`, `rng()`, `validate()`, `registerArena()`, `unregisterArena()`, `splitOf()` and the `Arena`, `ToolSpec`, `Genome`, `RaceResult`, `Score` types. If `node --import tsx` cannot load TypeScript from `node_modules`, `tools/vendor-beagle.ts` copies `src/` at the pinned sha into `vendor/beagle/` with its MIT licence and the loader imports from there; the choice is recorded in `CREDITS.md`.
2. **The Beagle fixes** (spec 9.1; Decision 2). In Beagle's repo, one PR: (a) `package.json` `exports` for `./race`, `./designer`, `./genome`, `./stats`, `./runner`, `./arenas`, `./models`, `./store`; (b) `paths` and `store.open()` read `BEAGLE_HOME` on each call and reopen when it changes; (c) `breed(…, { designer?: string })` with `DESIGNER` as the default; (d) `Arena.selfCheck?(answer, input): string` with a generic default ("Check your answer against the task as it was given. Reply with your final answer.") replacing the geotag sentence in `runner.ts`; (e) `compareToParents(voyageId, generation): Array<{ child; parent; diff: number; lo: number; hi: number; tasks: number }>`: the paired bootstrap of per-task score differences on the tasks both raced, seeded; (f) `race()` and `breed()` take `signal?: AbortSignal`; an abort leaves runs not yet graded unscored and returns `complete: false, reason: 'aborted'`; (g) `mlx:` joins the model prefixes in `validate()` and `complete()`. Beagle's own `npm test` passes with each.
3. **The spend kinds.** `'school'` (model calls made for voyages and graduation evaluation, Claude or local) and `'train'` (MLX training and its evaluation passes, local) join `SPEND_KINDS` (`budget.ts`), `CALL_KINDS` (`spend.ts`), the report's call kinds (`report.ts` line 221) and `charge()`'s kind union. Rows carry `firm_id NULL` (the city pays), `run_id` the voyage, net version or LoRA id. Local credits follow Phase 2 ruling 1 with `modelGB` from the base model's size on disk.
4. **The school lease.** `acquire(model, 'school', estimate, { waitUntil })` queues like a plan lease on its own pool, `SCHOOL_POOL = { claude: 1, local: 1 }`, behind the same `gate()` (pauses, the hard stop, the stop file, the night cap), and additionally refuses a Claude lease once `schoolClaudeSpent(today) + estimate > settings.school.claudeCreditsPerDay`. A local school lease also requires `workCount('local') === 0`: real work always beats the school.
5. **`Provider.complete()`.** One turn, no tools, an optional JSON schema: `complete(i: CompleteInput): Promise<CompleteResult>` on every backend. Claude reuses the existing no-tool `call()` path in `claude.ts` (empty strict MCP config, `CALL_DENY`, the CLI profile, `--max-turns 1`); Ollama and the Anthropic API reuse `jsonCall()`'s transport without the JSON wrapper when no schema is given; the fake answers from its script. This is the only interface change to `Provider` in Phase 4 besides the `mlx` backend.
6. **The training gate** (Decision 3). `gateNow(kind: 'light' | 'heavy', now): { ok: true } | { ok: false; reason: string }`. Both kinds need: `school.enabled`; the stop file absent; `pmset -g batt` says `AC Power`; `pmset -g` shows `lowpowermode 0`; the local time inside `school.window` (default `{ from: '01:00', to: '06:00' }`) unless a "Train now" is live; no local run live and none queued (`workCount('local') === 0` and no `awarded` job whose winning bid is local). `heavy` (LoRA, voyages, arena builds) adds: HID idle at least `school.idleMinutes` (default 15, from `ioreg -c IOHIDSystem` `HIDIdleTime`) unless "Train now"; `pmset -g therm` reports no `CPU_Speed_Limit` under 100; `df -k <home>` at least 20 GB free. Any probe that fails or does not parse fails the gate with that reason. "Train now" lasts 3 hours and never skips AC power, thermals or disk.
7. **The trainer.** `trainer/` in this repo: `requirements.txt` pins `mlx==0.32.4`, `mlx-lm==0.32.2`, `numpy`; `npm run trainer:setup` runs `uv venv --python cpython-3.12-macos-aarch64-none trainer/.venv` and `uv pip install -r trainer/requirements.txt`, then checks `platform.machine() == 'arm64'`. The engine finds `trainer/.venv/bin/python` (or `PALIMPSEST_PYTHON`). `trainer/school.py` is one warm subprocess speaking JSON lines on stdin and stdout (`train_net`, `predict_net` for parity checks, `lora_train`, `lora_eval_ready`, `ping`), started under the trainer profile: allow by default, deny all network (`HF_HUB_OFFLINE=1` as well), deny `file-write*` outside `paths().school` and its own tmp, deny reads of `SECRET_PATHS`. Training a LoRA runs `python -m mlx_lm.lora` as a child of `school.py` under the same profile with `--save-every 50` and `--resume-adapter-file` on resume. The gate loss path sends SIGTERM, waits 10 s, then SIGKILL; up to 50 steps are lost and the run records how many.
8. **The nets** (spec 9.3). Each net is a one-hidden-layer MLP (16 GELU units, AdamW lr 1e-2, weight decay 1e-2, at most 300 epochs, early stop on an inner split of the training rows' newest 15%, seed 1), features standardised with the training rows' mean and standard deviation, exported as JSON `{ net, version, features: string[], norm: { mean: number[]; std: number[] }, layers: Array<{ W: number[][]; b: number[] }>, out: 'sigmoid' | 'linear' }`. Units, labels and features (each feature list fixed in `shared/net-features.ts`, unknowns as 0 with a matching `has_*` mask feature):
   - **Appraiser:** one row per awarded bid whose run ended. Label `pass` (the run's inspection passed and the job did not fail its inspection) and `cost` (log1p of the run's credits rows). Features: tier, scope globs, acceptance lines, source, repo language, checks present (test, build, typecheck, lint), the bid's price over value, confidence, plan length, workflow shape, model family, capability era, the firm's pass rate and Brier as of the award (`reputation(firmId, log before at)`). Two heads: `appraiser-pass` (sigmoid) and `appraiser-cost` (linear). Unawarded bids have no label and are never rows (stated on the school screen).
   - **Router:** the same rows without the bid's own price, confidence and plan; predicts `pass` for a (job, agent) pair so it can rank agents who did not bid.
   - **Durability:** one row per merged city job with at least 30 days since merge or a `merge.reverted` or `merge.followup` (ruling 9) before that. Label `survived`. Features: diff files and lines (`run.diff`), tier, model family, checks that passed, `preexisting` count, design checked, review concerns count, whether he added commits (`hisChanges`).
   - **Triage:** one row per item id in each `brief.opened.items`. Label `acted`: 1 when a `brief.action` other than `dismiss` for that id falls on the same brief day, else 0. Features: item kind, tier, hours since the item's `at`, weekday, whether it was the first open, the item's position in its section, the repo's share of his past accepts.
   - **Taste:** one row per inspection with `design` not null whose job reached `merged` or `closed` by him in PR mode, plus one row per answered Understudy pair (ruling 10). Label `approved`. Features: the judge's `after`, `before`, `after - before`, `diffOnly`, shots count; for a pair, the local vision judge's scores of its two shots.
   - **Master:** one row per resolved decision (ruling 14). Label `approved`. Features: the five nets' outputs for the item (each with a `has_` mask), the work kind (one-hot over the six kinds), the repo's approval share in its last 20 decisions.
9. **Follow-up fixes.** `watchReverts()` also records `merge.followup { jobId, runId, repo, floorId, mergeSha, fixSha, files, at }` once per floor when, within 14 days after a city merge and by ancestry after it, a commit not made by the city (no `Palimpsest-Job:` trailer, head branch not `palimpsest/*`) touches a file the merge touched and its subject matches `/\bfix(es|ed)?\b/i`. It is a durability label only: it never halts and never scars.
10. **Understudy** (Decision 6). `engine/school/understudy.ts` opens `~/Library/Application Support/Understudy/understudy.db` read-only (`node:sqlite` with `readOnly: true`), only when `school.understudy` is on, reads `statements` (not removed) and `pairs` with a `pick`, and never writes or copies its images out of `paths().school`. The statements are appended to the design judge's bar (`engine/guild/design-bar.md` is unchanged; the judge input gains them) only when the switch is on. A pair is scored once by the local vision judge (`ollama:qwen2.5vl:7b`) under a local school lease and cached by pair id.
11. **Evaluation** (spec 9.2: no claim without a number). Rows are ordered by `at`; the newest 20% (at least 10) are held out and never seen in training or early stopping. A net reports nothing (`status: 'thin'`, "n of 40 labels") until it has 30 training rows and 10 held out. Metrics on the held-out rows: Brier for sigmoid heads, mean absolute error for the cost head, and for the master agreement at 0.5; each with a seeded 95% interval from Beagle's `bootstrap()` over per-row values (10,000 resamples, seed 1). Each net is compared with a baseline (the training rows' base rate; for the appraiser, the firm's pass rate as of the award, which is what Phase 2 shows today): `vsBaseline = { diff, lo, hi }` from `bootstrap()` over per-row differences. A net is `trusted` only when `hi < 0` for Brier or error (it beats the baseline with the whole interval). Only trusted nets feed anything but the school screen.
12. **Retraining.** Nightly under the light gate, one `retrain` pass trains every net with new labels since its last version, in the order appraiser, router, durability, triage, taste, master (the master last, on the others' fresh outputs). Each version is stored at `paths().school/nets/<net>/v<n>.json` with its metrics, recorded as `net.trained`. A version is promoted to current only if it is trusted or the current one is not; a promoted version that later scores worse is kept but not current. Feature lists change only with a new version number and a migration note.
13. **Distillation** (spec 9.3), only where the targets mean the same thing: Triage on items that are proposals takes the master's `P(approve)` as a soft label with weight 0.3 when it has fewer than 100 own rows; Taste on UI merges does the same. The master never learns from its own predictions; it learns from the small nets' outputs as features. Held-out rows are always real labels; a distilled net's card says "taught by the master on n rows".
14. **Decisions and kinds** (Decisions 8 and 9). A decision is his: a proposal accepted (`job.changed` from `proposed` to `open`) or dismissed (to `withdrawn` with `withdrawnBy 'him'`); a PR-mode city PR merged (`job.changed` to `merged` with a run in `waiting`; `hisChanges` and `mergedWithChanges` count as approve) or closed (`job.changed` to `closed`); and a revert (`merge.reverted`) which supersedes any earlier approve of that job as a decline. Push-mode merges are not his decisions. `workKind(job, inspection)`: `propose:harness` (source `harness`), `propose:readme-gap` (source `proposal`), `merge:ui` (an inspection with `design` not null), else `merge:<tier>`. The item key is `<kind>:<jobId>`.
15. **Prospective predictions.** When a decision becomes pending (a job posted `proposed`; `pr.opened` recorded in `ship.ts`), `registerPrediction(job, run | null)` records `master.predicted { key, kind, repo, jobId, p, version, inputs, at }` once per key, where `p` is null (an abstention) when the master is missing, thin, untrusted, its version is older than 8 days, or any input could not be computed. A decision resolved records `decision.resolved { key, kind, repo, jobId, approved, by, predictionId, agreed, at }`; `agreed` is null when there is no prediction recorded strictly before the decision, and such a decision never enters any window. `agreed` is false for an abstention.
16. **Agreement** (Decision 9). `agreement(kind, repo?)` reads the last 50 `decision.resolved` rows of that kind (pooled, or that repo's) whose `agreed` is not null, the latest resolution per key; `rate` is the agreeing share with its 95% interval; `eligible` needs exactly 50 rows and `rate >= 0.95`. The repo test: at least 10 of that repo's rows of that kind and none of its last 10 with `agreed false`.
17. **Asks and grants.** The school tick asks once per (kind, repo) when the kind is eligible, the repo passes its test, the repo has a test and a build command (spec 17), is connected, not halted, its market is on, and there is no open ask, grant or decline younger than 30 days for that pair. An ask is `autonomy.asked` and a brief item `autonomy:<kind>:<repo>` with actions `grant`, `decline`, `why`. Only his action grants (`autonomy.granted { kind, repo, by: 'him', rate, lo, version, at }`); declining records `autonomy.declined` and silences the pair for 30 days. He revokes from Settings, the district page or a brief item at any time (`autonomy.revoked { by: 'him' }`).
18. **Acting under a grant** (Decision 10). `mayAct(kind, repo, jobId, now): { ok: true; p: number } | { ok: false; reason: string }` answers yes only when all hold at that moment, read fresh from the store: an active grant for the pair; no revocation or suspension after it; the stop file absent; the repo connected, market on, not halted, with test and build; `agreement(kind)` still eligible and the repo test still passing (else `autonomy.suspended` and a fresh ask); the master current and trusted; a `master.predicted` row for this key with `p >= 0.9`; for a merge, the run's inspection `passed` and `pushable`, the PR open, and its head sha equal to `run.headSha`. Any throw is caught and answered `{ ok: false, reason: 'could not check: …' }`. Actions: `propose:*` accepts the proposal through `acceptProposed()`; `merge:*` runs `mergePR(repo, number, headSha)`. Each records `autonomy.acted { kind, repo, jobId, p, at }` before the action and its result after.
19. **Revocation by revert** (spec 9.4). A `merge.reverted` whose job has an `autonomy.acted` row revokes that (kind, repo) grant (`autonomy.revoked { by: 'revert', jobId }`) in the same handler that records the revert, before the repo halts; the revert also enters the window as a decision with `agreed false` (the master had predicted approve). The pair can be asked again only by ruling 17, so after a revert the window must hold again with the revert in it.
20. **Arenas from his repos** (spec 9.2). For a connected repo with a test command, `buildArena(repo, kind)` makes one of:
    - **Planted bugs:** at the repo's default branch head, up to 120 candidate one-line mutants on source lines (not tests) from six operators (flip a comparison, off by one on an integer literal, swap `&&` and `||`, drop a `!`, swap `true` and `false`, return the first argument), each kept only if the repo's own test command passes at the head and fails with the mutant; at most 60 kept, split by Beagle's `splitOf(id)` (60% breeding, 25% race, 15% sealed).
    - **Past issues:** merged PRs (from `mergedPRs()`, founding history included) that changed both source and test files; the task is the merge's first parent with the PR's test files applied, kept only if those tests fail there and pass at the merge; at most 40, split the same way.
    Both run the suite under the tool profile in a per-task APFS clone (`cp -c`) of an arena base clone whose dependencies were installed once under the install egress; every grading run has no network. Building is heavy-gated and charged as local `school` credits by wall time.
21. **Arena answers and grading.** The answer is Beagle's fix-test shape, `{ edits: Array<{ file; find; replace }> }`, each `find` unique in its file, files only under source paths, never tests. Grade: apply to a fresh task clone, run the test command under the tool profile with no network, score 1 when the target tests pass and no test that passed at the task's base fails, 0.5 when the targets pass but another fails, 0 otherwise. The tools offered: `read_file`, `list_files`, `search` and `run_tests` (the repo's test command on the agent's proposed edits in a scratch clone), each through `execFileTool()` or `execTool()` under the tool profile.
22. **Voyages** (spec 9.2). A voyage breeds on one arena: population 8, 4 generations, local models only (Decision 7), `localOnly: true`, the designer per Decision 7, the race on the race split, children promoted only when `compareToParents()` gives `lo > 0`. The champion is scored on the sealed split once at the end (`sealedScore()`). A champion whose sealed score beats every seeded agent's on the same tasks with `lo > 0` becomes a school-bred specialist on the roster (`lineage.origin 'school'`), hireable by Phase 2 ruling 6's rule.
23. **LoRA data** (Decision 5). One example per verified change: the city's merges that passed inspection and survived 30 days, and his merged PRs on connected repos never reverted, with the changed files' text before the change. The example is a chat in the arena's own shape (system: the arena's describe; user: the task as `show()` renders it with the files' text; assistant: the edits JSON built from the diff's hunks, each hunk's old text widened until unique). Excluded: any change whose PR or merge sha is a task of any arena's sealed split, any change whose files exceed 24 KB, any example over 4,096 tokens. Training needs at least `LORA_MIN = 100` examples; the latest 10% are its validation set.
24. **LoRA training** (Decision 4). Base `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`, `--fine-tune-type lora`, `--num-layers 16`, `--batch-size 2`, `--iters 600`, `--learning-rate 1e-5`, `--mask-prompt`, `--grad-checkpoint`, `--save-every 50`, under the heavy gate. Its local credits use `modelGB` 4.3.
25. **Graduation** (spec 9.2). A trained adapter is scored on every sealed task of every arena it has not seen, against the same base without the adapter, both as the same single-shape genome through `sealedScore()`; it graduates only if the paired difference has `lo > 0`. A graduate becomes `mlx:<name>` (`grad-<base short>-<n>`), an agent on the school roster with `capability` by its sealed score (Phase 2 ruling 5's capability for 7B local, glass), root `collegiate`, `lineage.origin 'school'`.
26. **The `mlx` backend.** `engine/market/mlx.ts` serves a graduate through a warm `mlx_lm.server --model <base> --adapter-path <dir> --host 127.0.0.1 --port <free>` under the trainer profile (network denied except binding loopback), started on first use and stopped after 10 idle minutes, one at a time. Its transport is the OpenAI chat shape `mlx_lm.server` serves; tool calls come back parsed; `poolOfModel('mlx:…')` is `local` (a pin: it is today).
27. **The university plot** (Decision 12). `ensureCampus()` takes `nextSlot('campus', 'university')` the first time the Phase 4 engine starts; the campus occupies that one spiral block (240 m), on a terrace 6 m above the street grid. Nothing else moves.
28. **Commuting to school** (spec 6.4). A seeded or roster agent whose genome is a parent in a live voyage takes a trip with reason `school` to the campus when the voyage starts and home when it ends; a graduate's first trip goes from the campus to its firm's quarter when hired.

## Review Focus

1. He unplugs the Mac at 02:10 during a LoRA run, or wakes it and starts typing: within 30 s the trainer is stopped, `train.paused` records the reason and the steps lost, no adapter half trained is evaluated or graduated, and the next eligible night resumes from the checkpoint with the same data and seed. (Tasks 6, 7 and 23.)
2. A revert of an autonomous merge lands while the next autonomous merge for the same kind and repo is in flight: the grant is revoked before that merge's last check, `mayAct` refuses right before `gh pr merge`, the brief says what happened, and the repo halts as Phase 2 does. (Tasks 16 and 17.)
3. The master is missing, its weights are corrupt JSON, it is 9 days old, the trainer venv is absent, or one small net throws: every prediction abstains, every abstention counts against agreement, no ask is made and no action runs, and the school screen names the reason. (Tasks 11, 14 and 16.)
4. The engine was down while he merged a PR, so the decision is seen before any prediction exists, or a prediction is backfilled after the fact: that decision never enters an agreement window. (Tasks 14 and 15.)
5. A sealed task's PR also appears among the LoRA examples, the designer's evidence or the breeding split: it is excluded from training and from the designer, and a test names it. (Tasks 18, 19, 21 and 22.)

---

## File Structure

```
shared/types.ts                 + NetName, NetCard, NetStatus, NetVersion, Voyage view, ArenaInfo, Graduate, WorkKind, Prediction,
                                  Decision, Agreement, Grant, GrantState, TrainState, GateState, SchoolSettings; RootStyle + 'collegiate';
                                  TripReason + 'school'; BriefItemKind + 'autonomy' | 'graduate' | 'acted'; BriefAction + 'grant' | 'decline' | 'revoke';
                                  Settings.school
shared/ledger-kinds.ts          + school.*, arena.*, train.*, net.trained, master.predicted, decision.resolved, autonomy.*, merge.followup
shared/school-rules.ts          pure: WORK_KINDS, workKind(), AGREE, NET_MIN, gate constants, LORA_*, ARENA_*, VOYAGE, SCHOOL_POOL
shared/net-features.ts          pure: the feature lists and encoders per net
shared/nets.ts                  pure: forward(net, x), parseNet(json)
engine/home.ts                  + paths().school
engine/db.ts                    + nets, predictions, decisions, grants, arenas, arena_tasks, voyages, lora_runs, graduates tables
engine/market/provider.ts       + CompleteInput, CompleteResult, Provider.complete
engine/market/{claude,ollama,anthropic-api,fake-provider}.ts   + complete()
engine/market/mlx.ts            the mlx backend (graduates)
engine/market/providers.ts      + 'mlx' backend kind
engine/market/budget.ts         + 'school', 'train' kinds; acquire(…, 'school'); SCHOOL_POOL; schoolClaudeSpent()
engine/market/{spend,report,replay}.ts   + the kinds; + school tables in MarketState
engine/market/ship.ts           + registerPrediction on pr.opened; merge.followup in watchReverts; revert revokes grants
engine/market/jobs.ts           + registerPrediction on a proposed job
engine/github.ts                + mergePR()
engine/school/beagle-api.ts     the Beagle types Palimpsest uses
engine/school/beagle.ts         loadBeagle(), schoolDriver
engine/school/stats.ts          ci(), pairedCi() over Beagle's bootstrap
engine/school/gate.ts           gateNow(), probes
engine/school/trainer.ts        the warm trainer subprocess, its profile, the charge
engine/school/understudy.ts     the read-only reader
engine/school/datasets.ts       rows per net from the ledger
engine/school/nets.ts           train, evaluate, promote, current(), predict()
engine/school/decisions.ts      registerPrediction(), resolve(), agreement()
engine/school/autonomy.ts       asks, grants, mayAct(), act(), revoke
engine/school/arenas.ts         planted bugs, past issues, verification, Arena objects
engine/school/voyages.ts        breeding runs
engine/school/lora.ts           dataset, training, evaluation, graduation
engine/school/campus.ts         ensureCampus()
engine/school/tick.ts           the school's scheduler
engine/school/api.ts            the school routes
trainer/requirements.txt, trainer/school.py, trainer/nets.py, trainer/test_school.py
app/src/api.ts, app/src/router.ts   + school routes and events
app/src/ui/school.ts, school-words.ts, autonomy.ts   the school screen, its words, the grants block
app/src/ui/settings.ts, repo.ts, brief.ts, job.ts, agent.ts   as the tasks say
app/src/city/campus/*.ts        site, halls, library, clock tower, observatory, life
app/src/city/tower/*            + collegiate root
tools/ui-test-school.ts, tools/ui-test.ts, tools/capture.ts, tools/vendor-beagle.ts
test/*.test.ts                  node:test suites per task
```

## Pre-flight conflict table

| Tasks | Shared | Resolution |
|---|---|---|
| 1, all | `shared/types.ts`, `LEDGER_KINDS`, the spend kinds, `Settings.school`, the tables | Task 1 freezes them; a later field is added in its own commit and noted in the ledger |
| 2, 4 | Beagle's API | Task 2 lands in Beagle and is pinned; Task 4 imports only what ruling 1 lists |
| 3, 4, 24 | `Provider.complete`, `CompleteInput` | Task 3 defines and implements on four backends; Task 24 adds the fifth |
| 4, 21, 25 | `schoolDriver` | every Beagle model call goes through it; no school code calls a provider for a genome directly |
| 6, 7, 13, 18 to 23 | `gateNow()` | only Task 6 reads the probes; everything else asks `gateNow` |
| 8, 11, 12, 14 | rows, weights, `predict()` | Task 8 builds rows, Task 11 trains and loads weights, Task 12 evaluates and promotes, Task 14 predicts |
| 14, 15, 16, 17 | predictions, decisions, grants | Task 14 writes predictions, Task 15 decisions and agreement, Task 16 grants and `mayAct`, Task 17 acts |
| 17, Phase 2 `ship.ts` | the revert handler | Task 17 adds one call, `revokeOnRevert(data)`, before `haltRepo()` in `watchReverts()` |
| 26, 28 to 30 | the `api` client | screens call only what Task 26 added |
| 27, 28 to 35 | the sample school | `seedSchool()` inside `seedEconomy()` is the only entry point |
| 31 to 35, Phase 3 city | `scene.ts`, the perf guard | the campus is its own group built in `app/src/city/campus/`; the tower builders change only in Task 35 |

Known orderings: Task 1 first; Task 2 merged in Beagle before Task 4; Task 3 before Task 4; Tasks 5 and 6 before Task 7; Task 7 before Tasks 11, 23; Task 8 (with 9 and 10) before Task 11; Tasks 11 and 12 before 13 and 14; Task 14 before 15; 15 before 16; 16 before 17; Task 20 needs 18 and 19; Task 21 needs 4, 6 and 20; Task 23 needs 7 and 22; Task 25 needs 21, 23 and 24; Task 26 after Tasks 12 to 25; Task 27 before every UI test; the city track's Task 31 needs only Task 1 (`campus` slot and types) and Task 26's `/api/school/campus`; Task 34 needs Task 26's events; both tracks merged before Tasks 36 to 38.

## Model marks

**[Opus]** for every task but Tasks 26 and 30, which are **[Sonnet]** with a full brief. Reviews of logic and visual work go to Opus.

---

## Part A: foundations (screens track)

### Task 1: Types, ledger kinds, spend kinds, settings, tables and replay [Opus] [screens]

**Files:**
- Modify: `shared/types.ts`, `shared/ledger-kinds.ts`, `engine/home.ts` (`paths().school`, creating its subdirectories), `engine/db.ts`, `engine/settings.ts`, `engine/repos.ts` (`nextSlot` kind union gains `'campus'`), `engine/market/budget.ts`, `engine/market/spend.ts`, `engine/market/report.ts`, `engine/market/replay.ts`
- Create: `shared/school-rules.ts`
- Test: `test/market-types.test.ts`, `test/school-rules.test.ts`, `test/db.test.ts`, `test/replay.test.ts`, `test/budget.test.ts`, `test/spend.test.ts`, `test/home.test.ts`

**Interfaces:**
- Produces (`shared/types.ts`):
  ```ts
  export type NetName = 'appraiser-pass' | 'appraiser-cost' | 'router' | 'durability' | 'triage' | 'taste' | 'master';
  export type NetStatus = 'thin' | 'untrained' | 'trained' | 'trusted';
  export interface Interval { value: number; lo: number; hi: number; n: number }
  export interface NetVersion { net: NetName; version: number; at: string; rows: { train: number; heldOut: number; distilled: number };
    metric: 'brier' | 'mae' | 'agreement'; score: Interval; baseline: Interval; vsBaseline: { diff: number; lo: number; hi: number };
    trusted: boolean; current: boolean; seconds: number; path: string }
  export interface NetCard { net: NetName; status: NetStatus; reason: string | null; current: Omit<NetVersion, 'path'> | null;
    history: Array<Pick<NetVersion, 'version' | 'at' | 'score' | 'trusted'>>; labels: number; needs: number }
  export type WorkKind = 'propose:harness' | 'propose:readme-gap' | 'merge:low' | 'merge:normal' | 'merge:high' | 'merge:ui';
  export interface Prediction { id: number; key: string; kind: WorkKind; repo: string; jobId: string; p: number | null; version: number | null; reason: string | null; at: string }
  export interface Decision { key: string; kind: WorkKind; repo: string; jobId: string; approved: boolean;
    by: 'accept' | 'dismiss' | 'merge' | 'close' | 'revert'; predictionId: number | null; agreed: boolean | null; at: string }
  export interface Agreement { kind: WorkKind; repo: string | null; rows: number; agreed: number; rate: Interval | null; eligible: boolean; repoOk: boolean | null }
  export type GrantState = 'asked' | 'granted' | 'declined' | 'suspended' | 'revoked';
  export interface Grant { kind: WorkKind; repo: string; state: GrantState; at: string; by: 'him' | 'revert' | 'school'; rate: Interval | null; reason: string | null; acted: number }
  export interface GateState { kind: 'light' | 'heavy'; ok: boolean; reason: string | null; power: 'ac' | 'battery' | 'unknown'; idleMin: number | null;
    inWindow: boolean; trainNowUntil: string | null; freeGB: number | null; thermal: 'nominal' | 'limited' | 'unknown' }
  export type TrainKind = 'nets' | 'lora' | 'arena' | 'voyage' | 'eval';
  export interface TrainState { id: string; kind: TrainKind; status: 'waiting' | 'running' | 'paused' | 'done' | 'failed'; reason: string | null;
    startedAt: string; endedAt: string | null; seconds: number; steps: { done: number; of: number; lost: number } | null; credits: number }
  export interface ArenaInfo { id: string; repo: string; kind: 'planted' | 'past'; sha: string; tasks: { breeding: number; race: number; sealed: number };
    candidates: number; kept: number; builtAt: string; status: 'building' | 'ready' | 'failed'; reason: string | null }
  export interface VoyageView { id: string; arena: string; status: 'sailing' | 'paused' | 'done' | 'capped' | 'failed'; generation: number; of: number;
    scores: Array<{ genome: string; name: string; generation: number; mean: number; lo: number; hi: number; parents: string[] }>;
    promoted: Array<{ child: string; parent: string; diff: number; lo: number; hi: number }>; sealed: Interval | null; credits: number; startedAt: string; endedAt: string | null }
  export interface Graduate { id: string; model: ModelRef; base: string; loraId: string; sealed: Interval; baseSealed: Interval;
    vsBase: { diff: number; lo: number; hi: number }; examples: number; at: string; agentId: string | null }
  export interface SchoolSettings { enabled: boolean; window: { from: string; to: string }; idleMinutes: number; trainNowUntil: string | null;
    claudeCreditsPerDay: number; designer: ModelRef; understudy: boolean; baseModel: string; baseModelReady: boolean }
  // RootStyle + 'collegiate'; TripReason + 'school'; BriefItemKind + 'autonomy' | 'graduate' | 'acted'; BriefAction + 'grant' | 'decline' | 'revoke'.
  // Settings + school: SchoolSettings (enabled false, window 01:00 to 06:00, idleMinutes 15, trainNowUntil null, claudeCreditsPerDay 30,
  //   designer 'claude:sonnet', understudy false, baseModel 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', baseModelReady false).
  ```
- Produces (`shared/school-rules.ts`): `WORK_KINDS: readonly WorkKind[]` (ruling 14's six), `AGREE = { window: 50, rate: 0.95, repoMin: 10, repoLast: 10, actP: 0.9, quietDays: 30, staleDays: 8 }`, `NET_MIN = { train: 30, heldOut: 10 }`, `HELD_OUT = 0.2`, `DISTIL = { weight: 0.3, under: 100 }`, `GATE = { pollMs: 30_000, minFreeGB: 20, trainNowHours: 3, killGraceMs: 10_000 }`, `SCHOOL_POOL = { claude: 1, local: 1 }`, `LORA = { min: 100, iters: 600, saveEvery: 50, layers: 16, batch: 2, lr: 1e-5, maxTokens: 4096, maxFileBytes: 24_000, gb: 4.3 }`, `ARENA = { mutants: 120, keepPlanted: 60, keepPast: 40 }`, `VOYAGE = { population: 8, generations: 4 }`, `FOLLOWUP_DAYS = 14`, `SURVIVE_DAYS = 30`, `inWindow(window, now): boolean` (handles a window that crosses midnight), `itemKey(kind, jobId)`.
- Produces (`shared/ledger-kinds.ts`): `school.enabled`, `arena.built`, `voyage.started`, `voyage.generation`, `voyage.ended`, `train.started`, `train.paused`, `train.ended`, `net.trained`, `net.promoted`, `master.predicted`, `decision.resolved`, `autonomy.asked`, `autonomy.granted`, `autonomy.declined`, `autonomy.suspended`, `autonomy.revoked`, `autonomy.acted`, `graduate.made`, `merge.followup`.
- Produces (`engine/db.ts`, migration): `nets (net TEXT, version INTEGER, at TEXT, current INTEGER, json TEXT, PRIMARY KEY (net, version))`; `predictions (id INTEGER PRIMARY KEY, key TEXT UNIQUE, kind TEXT, repo TEXT, at TEXT, json TEXT)`; `decisions (key TEXT, at TEXT, kind TEXT, repo TEXT, json TEXT)` with index `(kind, at)`; `grants (kind TEXT, repo TEXT, state TEXT, at TEXT, json TEXT, PRIMARY KEY (kind, repo))`; `arenas (id TEXT PRIMARY KEY, repo TEXT, json TEXT)`; `arena_tasks (id TEXT PRIMARY KEY, arena TEXT, split TEXT, pr TEXT, sha TEXT, json TEXT)`; `voyages (id TEXT PRIMARY KEY, json TEXT)`; `trains (id TEXT PRIMARY KEY, kind TEXT, status TEXT, json TEXT)`; `graduates (id TEXT PRIMARY KEY, json TEXT)`.
- Produces (`engine/market/budget.ts`): `SPEND_KINDS` gains `'school'`, `'train'`; `charge()`'s kind union gains both; `acquire(model, kind: 'plan' | 'work' | 'school', estimate, opts)` (ruling 4); `schoolClaudeSpent(day): number`. `spend.ts` `CALL_KINDS` and the report's call kinds gain both.
- Produces (`engine/market/replay.ts`): `MarketState` gains `nets`, `predictions`, `decisions`, `grants`, `arenas`, `voyages`, `trains`, `graduates`; `verifyReplay()` compares each against its table.
- [ ] **Step 1: Write the failing tests:** `inWindow handles 01:00 to 06:00 and 22:00 to 04:00`; `itemKey joins kind and job`; `paths().school creates beagle, arenas, nets, lora, graduates and logs under the temp home`; `the db has the nine school tables`; `a school charge at night counts in the five-hour window, the night cap and citySpent`; `a train charge appears under the city's own calls in the spend tables and the report`; `acquire school on claude refuses past claudeCreditsPerDay with the reason`; `acquire school on local is refused while a local run holds a work lease`; `acquire school waits in its own queue and does not take a plan slot`; `replay rebuilds each school table and verifyReplay flags a corrupted grant row`; `nextSlot('campus', 'university') takes the next slot once and returns it again`; pin: `poolOfModel('mlx:grad-x') is local` (passes today).
- [ ] **Step 2:** Run `npm test` and `npm run typecheck`; expect FAIL on the new tests.
- [ ] **Step 3:** Implement. The settings default holds `school.enabled false`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Lay the Phase 4 types: the school's tables, its spend, its lease and its ledger`.

### Task 2: Beagle's library fixes, in Beagle's repo [Opus] [screens]

**Files (in a worktree of `~/Downloads/beagle` on branch `palimpsest-library`, never on his checkout's working tree):**
- Modify: `package.json` (`exports`), `src/paths.ts`, `src/store.ts`, `src/designer.ts`, `src/runner.ts`, `src/race.ts`, `src/genome.ts`, `src/models/index.ts`, `src/arenas/types.ts`, `README.md` (the fixed audit lines)
- Test: Beagle's `test/genome.test.ts`, `test/runner.test.ts`, `test/race.test.ts`, `test/designer.test.ts`, `test/paths.test.ts` (new where missing)

**Interfaces:**
- Produces (Beagle, ruling 2): `exports` entries; `paths` getters; `open()` reopening on a changed home; `breed(voyageId, generation, o: { …; designer?: string; signal?: AbortSignal })`; `race(…, o: { …; signal?: AbortSignal })` returning `complete: false, reason: 'aborted'` on abort with ungraded runs unscored; `Arena.selfCheck?(answer: unknown, input: unknown): string` and the generic default; `compareToParents(voyageId: string, generation: number)`; `mlx:` accepted by `validate()` and passed to the driver by `complete()`.
- [ ] **Step 1: Write the failing tests in Beagle:** `a genome on mlx:grad-1 validates`; `complete passes mlx to the driver`; `the self-check turn of a fix-test genome does not mention where anything happened`; `breed uses the designer it is given`; `an aborted race scores no run that had not finished and says aborted`; `compareToParents gives a positive interval for a child better on every common task and one spanning zero for a tie`; `paths follow BEAGLE_HOME changed between calls`.
- [ ] **Step 2:** Run `npm test` in the Beagle worktree; expect FAIL.
- [ ] **Step 3:** Implement, keeping Beagle's style and its existing tests green.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck` in Beagle; expect PASS.
- [ ] **Step 5:** Commit in Beagle `Let Palimpsest import Beagle: a package entry, a home read on each call, the designer and an abort as options, a self-check any arena can word, parent against child in the engine, and mlx models`; with his go-ahead push the branch and open the PR on `AllStreets/beagle`. After he merges, record the merge sha in this repo's ledger note for Task 4.

### Task 3: Provider.complete on the four backends [Opus] [screens]

**Files:**
- Modify: `engine/market/provider.ts`, `engine/market/claude.ts`, `engine/market/ollama.ts`, `engine/market/anthropic-api.ts`, `engine/market/fake-provider.ts`
- Test: `test/claude-provider.test.ts`, `test/ollama.test.ts`, `test/anthropic-api.test.ts`, `test/fake-provider.test.ts`

**Interfaces:**
- Produces (`engine/market/provider.ts`):
  ```ts
  export interface CompleteInput { model: ModelRef; system: string; turns: Array<{ role: 'user' | 'assistant'; content: string }>;
    schema: object | null; signal: AbortSignal; maxMs: number }
  export interface CompleteResult { text: string; json: unknown | null; usage: Usage }
  // Provider: + complete(i: CompleteInput): Promise<CompleteResult>;
  ```
- Produces: `claude.ts` `complete()` through the existing `call()` (rename its `kind` parameter use to `'complete'`), multi-turn folded into one message the way Beagle's `models/claude.ts` does, `--json-schema` when a schema is given, `structured_output` as `json`; `ollama.ts` and `anthropic-api.ts` `complete()` over their transports with `num_ctx` `REVIEW_NUM_CTX`; `fakeProvider` `FakeScript.complete?` with a default that answers `{ "edits": [] }` for a schema and `"ok"` otherwise.
- [ ] **Step 1: Write the failing tests:** `claude complete builds the no-tool argv with the CLI profile, --max-turns 1 and the schema, and reads structured_output`; `claude complete aborts on the signal within 5 s`; `ollama complete posts the turns and returns the text and its seconds`; `anthropic complete charges dollars from usage`; `the fake complete answers by its script`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; the existing plan, review, judge and audit tests still pass.
- [ ] **Step 5:** Commit `Give every backend a single-turn completion the school can meter`.

### Task 4: Beagle as a library, with every call through the caps [Opus] [screens]

**Files:**
- Create: `engine/school/beagle-api.ts`, `engine/school/beagle.ts`, `engine/school/stats.ts`, `tools/vendor-beagle.ts` (used only on the fallback)
- Modify: `package.json` (`"beagle": "github:AllStreets/beagle#<Task 2 merge sha>"`), `CREDITS.md`
- Test: `test/school-beagle.test.ts`, `test/school-stats.test.ts`

**Interfaces:**
- Consumes: `Provider.complete` (Task 3), `acquire(model, 'school', …)`, `charge({ kind: 'school' })`, `callPaused` (Task 1), Beagle's exports (Task 2).
- Produces (`engine/school/beagle.ts`): `loadBeagle(): Promise<BeagleApi>` (ruling 1; idempotent per home; throws `refused: Beagle's home is outside the school` when `BEAGLE_HOME` resolves elsewhere); `schoolDriver(o: { voyageId: string | null; designer: ModelRef; signal: AbortSignal; now?: () => number })`: the Beagle `Driver` that maps Beagle's `claude:claude-opus-5-5` designer name to `o.designer`, takes `acquire(model, 'school', estimate, { waitUntil: now + 10 min })`, calls `providerFor(model).complete()`, charges `kind 'school'` with `runId` the voyage id, and on a refusal for caps throws Beagle's `LimitError` (so Beagle waits rather than scoring 0) and on the signal throws an abort.
- Produces (`engine/school/stats.ts`): `ci(values: number[], seed = 1): Interval` and `pairedCi(a: number[], b: number[], seed = 1): { diff; lo; hi }`, both through Beagle's `bootstrap()`.
- [ ] **Step 0 (probe):** `node --no-warnings --import tsx -e "await import('beagle/stats')"` in this repo after `npm install`. If it fails because TypeScript is refused inside `node_modules`, run `tools/vendor-beagle.ts <sha>`, point the loader at `vendor/beagle/src`, and record the choice in `CREDITS.md` and the commit body.
- [ ] **Step 1: Write the failing tests:** `loadBeagle sets BEAGLE_HOME under the temp school and never at Beagle's real home` (a test that sets `BEAGLE_HOME` to the real path first sees the throw); `a designer call is routed to the designer setting and charged as school`; `a school Claude call past claudeCreditsPerDay throws LimitError and charges nothing`; `a school call during the hard stop is refused`; `a school call at night counts in the night cap`; `an aborted driver call throws and Beagle's race comes back incomplete` (a fake provider that waits; the race of one genome on a two-task fake arena); `ci of [1,1,1,0] is seeded and stable`; `pairedCi of a better child has lo above zero`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Import Beagle's engine as a library whose every model call goes through the city's caps`.

### Task 5: The trainer environment [Opus] [screens]

**Files:**
- Create: `trainer/requirements.txt`, `trainer/school.py` (the `ping` command and the JSON line loop only), `trainer/test_school.py`, `trainer/README.md`
- Modify: `package.json` (`trainer:setup`, `test:trainer`), `.gitignore` (`trainer/.venv`)
- Create: `engine/school/trainer-env.ts`
- Test: `test/trainer-env.test.ts`

**Interfaces:**
- Produces (`engine/school/trainer-env.ts`): `trainerPython(): string` (`PALIMPSEST_PYTHON` or `<repo>/trainer/.venv/bin/python`); `trainerStatus(): Promise<{ ready: boolean; reason: string | null; python: string | null; arch: string | null; mlx: string | null; mlxLm: string | null }>` (runs `<python> -c` through `getRunner()` printing `platform.machine()`, `mlx.core.__version__`, `mlx_lm.__version__`; `ready` only for `arm64` with both present; the reasons: "No trainer environment: run npm run trainer:setup", "The trainer's Python is not arm64", "mlx is not installed in the trainer").
- `trainer:setup` runs the ruling 7 commands and prints the three versions; `test:trainer` runs `trainer/.venv/bin/python -m unittest trainer/test_school.py` or prints "Skipped: no trainer environment".
- [ ] **Step 1: Write the failing tests:** `trainerStatus is not ready without a venv and says to run setup`; `trainerStatus refuses an x86_64 python`; `trainerStatus is ready for arm64 with mlx 0.32.4 and mlx_lm 0.32.2` (fake runner answers); Python: `ping answers pong with the versions`.
- [ ] **Step 2:** Run `npm test`; expect FAIL.
- [ ] **Step 3:** Implement; run `npm run trainer:setup` once on his Mac (no download beyond PyPI) and `npm run test:trainer`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Give the school its own native MLX environment`.

### Task 6: The training gate [Opus] [screens]

**Files:**
- Create: `engine/school/gate.ts`
- Test: `test/school-gate.test.ts`

**Interfaces:**
- Consumes: `getRunner()`, `paths().stop`, `workCount` (exported from `budget.ts` in this task as `liveWork(pool)`), `listJobs({ status: ['awarded'] })`, `bidById`, `getSettings().school`, `inWindow`, `GATE`.
- Produces: `probePower(): Promise<{ power; lowPower: boolean | null }>` (parses `pmset -g batt` and `pmset -g`), `probeIdle(): Promise<number | null>` (minutes from `ioreg -c IOHIDSystem -d 4`'s `HIDIdleTime` in ns), `probeThermal(): Promise<'nominal' | 'limited' | 'unknown'>` (`pmset -g therm`), `probeFreeGB(dir): Promise<number | null>` (`df -k`); `gateNow(kind, now): Promise<GateState>` (ruling 6; the probes run at most once per 10 s and are cached); `startTrainNow(now)` and `stopTrainNow()` writing `school.trainNowUntil`.
- [ ] **Step 1: Write the failing tests** (fake runner answers each probe): `on battery the gate fails with "on battery"`; `Low Power Mode fails it`; `outside the window it fails with the window in the reason, and Train now opens it for 3 hours`; `Train now never opens it on battery`; `heavy needs 15 idle minutes and light does not`; `a thermal limit fails heavy`; `19 GB free fails heavy`; `a local run live or an awarded local job fails both`; `an unparsable pmset answer fails the gate with "could not read the power state"`; `the stop file fails both`; `school.enabled false fails both`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Let the Mac train only on power, idle, at night and cool, and say why not`.

### Task 7: The trainer process, its sandbox, its charge and the pause [Opus] [screens]

**Files:**
- Create: `engine/school/trainer.ts`
- Modify: `engine/market/sandbox.ts` (`trainerProfile(o: { school: string; tmp: string; port?: number })`), `trainer/school.py` (`sleep` test command, SIGTERM handling that flushes a checkpoint note)
- Test: `test/school-trainer.test.ts`, `test/sandbox.test.ts`, `trainer/test_school.py`

**Interfaces:**
- Consumes: `trainerPython()`, `gateNow()`, `getSpawner()`, `wrap()`, `SECRET_PATHS`, `charge()`, `acquire(…, 'school')`.
- Produces: `trainerProfile()` (ruling 7, tested as text: default allow, `deny network*` except `network-bind` and `network-inbound` on loopback when `port` is given, `deny file-write*` with `allow` for `school` and `tmp` after it, `deny file-read*` of each `SECRET_PATHS` entry); `startTrain(o: { kind: TrainKind; gate: 'light' | 'heavy'; command: object; gb: number; onLine: (l: object) => void; now?: () => number }): Promise<TrainState>` (records `train.started`, spawns `school.py` under `wrap(…, trainerProfile)` with `HF_HUB_OFFLINE=1`, polls `gateNow` every `GATE.pollMs`, on a failing gate sends SIGTERM then SIGKILL after `GATE.killGraceMs`, records `train.paused { reason, steps.lost }`, on exit charges `kind 'train'` local credits for the wall seconds at `gb`, records `train.ended`); `pauseAll(reason)`; `liveTrains()`; `failInterruptedTrains()` (a `running` train at engine start ends `paused` with "The engine stopped during training").
- [ ] **Step 1: Write the failing tests** (fake spawner and fake gate): `a train starts only when the gate holds and records train.started`; `the gate failing mid-run sends SIGTERM within 30 s and SIGKILL 10 s later, and the train is paused with the reason`; `a paused train charges its seconds as train credits with no firm`; `the spawned argv is wrapped in the trainer profile and its env has HF_HUB_OFFLINE=1 and no API keys`; `the trainer profile denies network and writes outside the school, and denies reading ~/.ssh` (as text); `a train running at engine start is paused by failInterruptedTrains`; Python: `school.py on SIGTERM writes its last step to stdout and exits 0`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. On his Mac, run `school.py ping` under the real profile once with `sandbox-exec` and confirm MLX sees the GPU (`mx.default_device()` prints `gpu`); the profile allows by default, so a Metal failure can come only from a deny rule: record the denial from the sandbox log and narrow that deny, never the network or write denies.
- [ ] **Step 5:** Commit `Run the trainer fenced in, charged by the minute, and stop it when the gate closes`.

### Task 8: The nets' rows from the ledger [Opus] [screens]

**Files:**
- Create: `shared/net-features.ts`, `engine/school/datasets.ts`
- Test: `test/net-features.test.ts`, `test/school-datasets.test.ts`

**Interfaces:**
- Consumes: `query()` (`ledger.ts`), `reputation(firmId, log)` (`reputation.ts`), `listJobs`, `listRuns`, `job`, `bidById`, `agent`, the credits table through `creditEntries(runId)` (exported from `budget.ts` in this task), `getRepo`, `Inspection` rows (`inspection.done`), `merge.reverted`, `merge.followup` (Task 9; empty until it lands), `brief.opened`, `brief.action`, `decision.resolved` (Task 15; empty until it lands), `understudyPairs()` (Task 10; injected, empty until it lands).
- Produces (`shared/net-features.ts`): `FEATURES: Record<NetName, readonly string[]>` and `encode(net, raw: Record<string, number | string | boolean | null>): number[]` (one-hot for categoricals by a fixed vocabulary, `has_` masks, numbers as given).
- Produces (`engine/school/datasets.ts`): `Row = { id: string; at: string; x: number[]; y: number; weight: number; source: 'real' | 'distilled' }`; `rowsFor(net: NetName, now: number): Row[]` (ruling 8, oldest first; the appraiser's reputation as of the award from the ledger before that entry; durability rows only once `SURVIVE_DAYS` passed or a revert or follow-up came first; triage rows only for brief days that are over); `labelCounts(now): Record<NetName, number>`.
- [ ] **Step 1: Write the failing tests** (ledger fixtures written with `record()` in a temp home): `an awarded bid whose run passed becomes one appraiser row with pass 1 and log1p of its credits`; `an unawarded bid is never a row`; `the firm's pass rate in a row is the one before the award, not today's`; `a merge 10 days old with no revert is not a durability row yet; at 31 days it is with survived 1; a revert at day 3 makes it survived 0`; `a brief day with three items shown and one accepted gives three triage rows with one acted`; `today's brief day gives no rows`; `a UI inspection whose PR he closed gives a taste row with approved 0`; `encode one-hots a tier and sets has_ masks for nulls`; `labelCounts on an empty ledger is all zeros`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Read each net's labelled rows from what actually happened`.

### Task 9: Follow-up fixes [Opus] [screens]

**Files:**
- Modify: `engine/market/ship.ts` (`watchReverts()`), `engine/market/replay.ts`
- Test: `test/ship.test.ts`

**Interfaces:**
- Consumes: `recentCommits()` (`github.ts`), `earnedFloors`, `JOB_TRAILER` and `CITY_BRANCH` (`history.ts`).
- Produces: `followupOf(commits, mergeSha, files, mergedAt, now): Commit | null` (ruling 9, pure, exported for the test); `merge.followup` recorded and emitted once per floor (keyed on `floorId`).
- [ ] **Step 1: Write the failing tests:** `a non-city fix touching a merged file within 14 days records merge.followup once`; `a city commit, a commit after 14 days, a commit touching other files and a subject without fix are ignored`; `a follow-up neither halts the repo nor scars`; `replay keeps the follow-up rows`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Notice when a city merge needed a fix soon after, for the durability net`.

### Task 10: The Understudy reader [Opus] [screens]

**Files:**
- Create: `engine/school/understudy.ts`
- Modify: `engine/guild/design.ts` (the judge input carries `bible: string[]` when `school.understudy` is on)
- Test: `test/understudy.test.ts`, `test/design.test.ts`

**Interfaces:**
- Produces: `understudyDb(): string` (`PALIMPSEST_UNDERSTUDY_DB` or the default path; under a test the default throws as `home()` does); `understudyStatements(): string[]` (not removed, by weight, at most 40); `understudyPairs(): Array<{ id: string; at: string; aShot: string; bShot: string; pick: 'a' | 'b' }>` (`neither` skipped); `scorePair(pair): Promise<{ a: number; b: number }>` (local vision judge, cached at `paths().school/understudy/<id>.json`, under a local school lease); everything returns empty when `school.understudy` is false.
- [ ] **Step 1: Write the failing tests** (a fixture db built in the temp dir with Understudy's schema): `statements come back without removed ones`; `pairs without a pick or with neither are skipped`; `the reader opens read only and a write throws`; `with the switch off nothing is read`; `under a test the default path throws`; `the judge input carries the bible only with the switch on`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Read his taste statements and picks from Understudy, read only and only when he says so`.

### Task 11: Training a net in MLX and running it in TypeScript [Opus] [screens]

**Files:**
- Create: `trainer/nets.py`, `shared/nets.ts`
- Modify: `trainer/school.py` (`train_net`, `predict_net`), `trainer/test_school.py`
- Test: `test/nets-forward.test.ts`

**Interfaces:**
- Produces (`trainer/nets.py`): `train_net({ net, rows_path, out_path, seed }) -> { epochs, kept_epoch, seconds }` (ruling 8: reads `rows.json` `{ x, y, w, kind }`, standardises, trains, keeps the epoch with the lowest inner-split loss, writes the weights JSON); `predict_net({ weights_path, x }) -> p[]`.
- Produces (`shared/nets.ts`): `parseNet(text: string): NetWeights | null` (refuses a wrong shape, a non-finite number or mismatched sizes); `forward(net: NetWeights, x: number[]): number` (standardise, linear, exact GELU `0.5 x (1 + erf(x / sqrt 2))` as MLX's `nn.gelu` computes it, linear, then sigmoid or identity); `erf(x)` in the same file, accurate to 1e-9.
- [ ] **Step 1: Write the failing tests:** TS: `parseNet refuses NaN, a missing layer and a size mismatch`; `forward matches a hand-computed two-unit net to 1e-9`; Python: `train_net learns y = x0 > 0 on 400 synthetic rows to held-out Brier under 0.05`; `predict_net and the exported JSON agree with a fixture of 20 rows the TS test also reads` (the fixture `test/fixtures/net-parity.json` holds the weights and the 20 expected outputs; `test/nets-forward.test.ts` asserts `forward` matches them to 1e-5).
- [ ] **Step 2:** Run `npm test` and `npm run test:trainer`; expect FAIL.
- [ ] **Step 3:** Implement. `trainer/nets.py` uses `nn.gelu` (exact), never `nn.gelu_approx`, so the TS forward pass can match it.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Train each small net in MLX and run it in the engine with no Python`.

### Task 12: Held-out scores, the baseline, trust and promotion [Opus] [screens]

**Files:**
- Create: `engine/school/nets.ts`
- Test: `test/school-nets.test.ts`

**Interfaces:**
- Consumes: `rowsFor`, `labelCounts` (Task 8), `startTrain` (Task 7), `parseNet`, `forward` (Task 11), `ci`, `pairedCi` (Task 4), `NET_MIN`, `HELD_OUT`.
- Produces: `split(rows): { train: Row[]; heldOut: Row[] } | null` (ruling 11; null under `NET_MIN`); `evaluate(net, weights, heldOut, baseline: (r: Row) => number): Pick<NetVersion, 'score' | 'baseline' | 'vsBaseline' | 'trusted'>`; `trainNet(net, now): Promise<NetVersion | { thin: true; labels: number; needs: number }>` (writes `rows.json` with real held-out rows excluded, starts a `nets` train, loads and evaluates the weights, stores the version, records `net.trained`, promotes by ruling 12 and records `net.promoted`); `current(net): { weights: NetWeights; version: NetVersion } | null` (null when the file is missing or `parseNet` refuses it, with the reason kept for `netCard`); `netCard(net, now): NetCard`; `baselineFor(net)` (ruling 11).
- [ ] **Step 1: Write the failing tests** (fake trainer that writes weights fitting the fixture): `a net with 25 labels is thin and says 25 of 40`; `the held-out rows are the newest 20% and never in rows.json`; `a net that beats the base rate with hi below zero is trusted and promoted`; `a net whose interval spans zero is trained, not trusted, and not promoted over a trusted one`; `a corrupt weights file makes current null and the card names the reason` (Review Focus 3); `the appraiser's baseline is the firm's pass rate as of the award`; `every score carries n and a seeded interval`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Score every net on rows it never saw, against a baseline, and trust only what beats it`.

### Task 13: The nightly retrain and distillation [Opus] [screens]

**Files:**
- Create: `engine/school/tick.ts` (the retrain part; later tasks add theirs)
- Modify: `engine/main.ts` (`startSchool()` after the scheduler; stopped on shutdown), `engine/school/datasets.ts` (distilled rows)
- Test: `test/school-tick.test.ts`, `test/school-datasets.test.ts`

**Interfaces:**
- Consumes: `trainNet`, `current`, `gateNow('light')`, `labelCounts`, `master predictions` through `current('master')` and `predict()` (Task 14 provides `predict`; until then the distillation test injects it).
- Produces: `startSchool(o: { now?: () => number }): { tick(): Promise<void>; stop(): Promise<void> }` (each tick, at most once a night, when the light gate holds and some net has new labels since its version, retrains in ruling 12's order; it never runs two trains at once); `rowsFor` gains distilled rows (ruling 13) with `source 'distilled'` and `weight DISTIL.weight`, never in the held-out split.
- [ ] **Step 1: Write the failing tests:** `the tick retrains only nets with new labels, master last`; `it does not run outside the window or on battery`; `it runs once a night, not every tick`; `triage under 100 rows gets distilled rows from the master for proposal items only, weighted 0.3, and none held out`; `durability, router and appraiser never get distilled rows`; `stop() pauses a live retrain`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Retrain the nets each night from the day's labels, the master last`.

### Task 14: Putting the nets to work and registering the master's predictions [Opus] [screens]

**Files:**
- Create: `engine/school/decisions.ts` (the prediction half)
- Modify: `engine/market/bids.ts` (`appraisal` from the appraiser when trusted, the award per Decision 11), `engine/brief.ts` (triage orders "Recommended" and suggests a tier in quiet text when trusted), `engine/market/jobs.ts` (`postProposal` and `proposeHarnessJob` call `registerPrediction`), `engine/market/ship.ts` (after `record('pr.opened', …)` calls `registerPrediction`), `engine/market/api.ts` (`JobDetail.school`)
- Test: `test/school-predict.test.ts`, `test/bids.test.ts`, `test/brief.test.ts`

**Interfaces:**
- Consumes: `current()`, `forward()`, `encode()`, `workKind()`, `itemKey()`, `AGREE.staleDays`.
- Produces: `predict(net, raw): { p: number; version: number } | null` (null when the net is not current or not trusted); `masterInputs(job, run): Record<string, …> | null` (the five nets' outputs or masks; null on any throw); `registerPrediction(job, run: Run | null, now): Prediction` (ruling 15; idempotent by key; `p` null with the reason "the master is thin", "the master is not trusted", "the master is 9 days old", "an input could not be read: …"); `JobDetail.school: { appraisal: number | null; router: Array<{ agentId; p }>; durability: number | null; master: Prediction | null }`. `award()` uses `calibrated' = (calibrated + appraisal) / 2` only when the appraiser is trusted; otherwise unchanged (a pin keeps Phase 2's award byte for byte when it is not).
- [ ] **Step 1: Write the failing tests:** `a proposed job registers one prediction, and a second call does not add another`; `a PR opened registers a prediction with the merge kind`; `with no master the prediction abstains with the reason` (Review Focus 3); `a master 9 days old abstains`; `a net that throws makes the prediction abstain`; `a trusted appraiser fills bid.appraisal and moves the award; an untrusted one leaves the award as Phase 2 made it`; `triage reorders recommendations only when trusted`; `triage never sets a tier`; pin: `award without a trusted appraiser equals Phase 2's choice on the bids fixture`.
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Let trusted nets inform the award and the brief, and write down the master's guess before he decides`.

### Task 15: His decisions and the master's agreement [Opus] [screens]

**Files:**
- Modify: `engine/school/decisions.ts` (the resolution half), `engine/main.ts` (`installDecisions()`)
- Test: `test/school-decisions.test.ts`

**Interfaces:**
- Consumes: the bus events `job.changed`, `merge.reverted`; `predictions` rows; `ci`.
- Produces: `installDecisions(): () => void` (ruling 14: subscribes and records `decision.resolved`); `resolve(job, by, at): Decision | null`; `agreement(kind, repo?: string): Agreement` (ruling 16); `agreements(): Agreement[]` (every kind pooled and per connected repo).
- [ ] **Step 1: Write the failing tests:** `accepting a proposal with a prediction of 0.8 records approved and agreed`; `dismissing it records approved false and agreed false`; `a merged PR with his changes counts as approve`; `a closed PR counts as decline`; `a push-mode merge records no decision`; `a revert after an approve supersedes it as a decline with agreed false`; `a decision with no prediction before it has agreed null and is never in a window` (Review Focus 4); `an abstention counts as a disagreement`; `49 decisions are not eligible; 50 with 48 agreed are; 50 with 47 are not`; `the repo test needs 10 rows and none of the last 10 against`; `the rate carries a seeded interval`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Record each of his decisions against the guess made before it, kind by kind`.

### Task 16: Asks, grants, suspension, revocation and mayAct [Opus] [screens]

**Files:**
- Create: `engine/school/autonomy.ts`
- Modify: `engine/school/tick.ts` (`askDue()` each tick), `engine/brief.ts` (items `autonomy` with `grant`, `decline`, `why`; `acted` with `revoke`, `why`; `TAUGHT` gains `grant`, `decline`, `revoke`), `engine/market/replay.ts`
- Test: `test/school-autonomy.test.ts`, `test/brief.test.ts`

**Interfaces:**
- Consumes: `agreement()`, `current('master')`, `getRepo`, `paths().stop`, `run`, `prState()`, `predictions` rows.
- Produces: `askDue(now): Grant[]` (ruling 17); `grant(kind, repo, now): Grant` (only from his action; refuses when no open ask exists for the pair); `decline(kind, repo, now)`; `revoke(kind, repo, by: 'him' | 'revert', jobId?: string, now?)`; `suspend(kind, repo, reason, now)`; `grants(): Grant[]`; `mayAct(kind, repo, jobId, now): Promise<{ ok: true; p: number } | { ok: false; reason: string }>` (ruling 18, every condition read fresh, any throw answered `ok: false` with "could not check: …"); `revokeOnRevert(data: { jobId; repo })` (ruling 19).
- [ ] **Step 1: Write the failing tests** (each condition alone): `an eligible kind on a repo with test and build asks once, and not again for 30 days after a decline`; `a repo without a build command is never asked`; `only grant() moves an ask to granted, and grant without an ask is refused`; `mayAct refuses with each of: no grant, revoked, suspended, stop file, repo halted, market off, no build, window no longer eligible (and suspends), repo test failing, master missing, master untrusted, no prediction, p 0.89, inspection not pushable, PR closed, head sha moved`; `mayAct answers ok when every condition holds`; `a throw inside a check answers could not check`; `revokeOnRevert revokes the grant of an autonomous job and records by revert`; `a revert of a job the city did not act on revokes nothing`; `the brief carries the ask with grant and decline, and an acted item with revoke`; `replay rebuilds grants and verifyReplay compares them`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Every refusal reason is a sentence he reads in the brief.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Ask his permission kind by kind and repo by repo, and refuse to act unless every check holds`.

### Task 17: Acting under a grant [Opus] [screens]

**Files:**
- Modify: `engine/school/autonomy.ts` (`act()`), `engine/school/tick.ts`, `engine/github.ts` (`mergePR()`), `engine/market/ship.ts` (`watchReverts()` calls `revokeOnRevert` before `haltRepo`; `pollPRs` sees the city's own merge as merged), `docs/SELF_RECURSION_GUARDRAILS.md`
- Test: `test/school-act.test.ts`, `test/ship.test.ts`, `test/github.test.ts`

**Interfaces:**
- Consumes: `mayAct`, `acceptProposed`, `listJobs({ status: ['proposed'] })`, `listRuns` in `waiting`, `githubWriteRefused()`.
- Produces: `mergePR(fullName, number, headSha): Promise<void>` (`gh pr merge <n> --repo <full> --merge --match-head-commit <sha>`; refused by `githubWriteRefused()`; never `--admin`, `--auto` or `--delete-branch`); `act(now): Promise<number>` (for each proposed job and waiting PR whose kind and repo hold a grant: `mayAct`, then record `autonomy.acted` and act, then re-read: a merge whose PR is not `MERGED` after the call records the failure and suspends the pair); the guardrails doc gains the arrows `proposed job of a granted kind > mayAct > accept > open > bid …` and `waiting PR of a granted kind > mayAct > gh pr merge`, and why neither creates a job.
- [ ] **Step 1: Write the failing tests** (fake runner records every gh argv): `a granted proposal kind is accepted with acted recorded first`; `a granted merge kind runs gh pr merge with --merge and --match-head-commit and nothing else`; `a revert arriving between two acts revokes before the second mayAct, which refuses` (Review Focus 2); `the stop file set mid-tick stops further acts`; `a merge that GitHub refuses suspends the pair`; `the revert handler revokes before it halts` (order checked in the ledger); `githubWriteRefused stops mergePR on the real home`; pin: `no autonomous action without a grant` (passes once Task 16 lands; kept).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. Run `npm test` whole.
- [ ] **Step 5:** Commit `Act on its own only where he granted it, re-checking every time, and stand down on a revert`.

### Task 18: Arenas from planted bugs [Opus] [screens]

**Files:**
- Create: `engine/school/arenas.ts` (the build half), `engine/school/mutants.ts`
- Test: `test/school-mutants.test.ts`, `test/school-arenas.test.ts`

**Interfaces:**
- Consumes: `createBaseDir` (`worktree.ts`), `installDeps`, `startEgress`, `hostsFor`, `execTool`, `wrap`, `toolProfile`, `childEnv`, `reapRun`, `gateNow('heavy')`, `charge({ kind: 'school' })`, Beagle's `splitOf` through `loadBeagle()`.
- Produces (`engine/school/mutants.ts`, pure): `mutate(path: string, text: string, max: number, seed: number): Array<{ file; line; original; mutated; op }>` (ruling 20's six operators on non-test source files of the repo's language, never inside strings or comments, deterministic by seed).
- Produces (`engine/school/arenas.ts`): `buildPlanted(repo: Repo, now): Promise<ArenaInfo>` (heavy gate; the base clone under `paths().school/arenas/<id>/base` installed once under the install egress; each candidate in an APFS clone; the repo's test command under the tool profile with no egress; kept by ruling 20; tasks stored in `arena_tasks` with `split` by `splitOf`; records `arena.built`; a gate loss pauses the build and the next night resumes from the candidates not yet tried); `arenaTasks(id, split)`.
- [ ] **Step 1: Write the failing tests** (a tiny JS repo in the temp dir with three source functions and a `node --test` suite, `PALIMPSEST_SANDBOX=off`): `mutate flips a comparison and skips strings and comments`; `mutate is deterministic by seed`; `a mutant the suite still passes is dropped, one it fails is kept`; `the kept tasks are split by splitOf and the sealed split is never empty with 20 or more`; `the grading runs carry no proxy (no egress)`; `a gate loss mid-build pauses it and the resume tries only the rest`; `a repo with no test command is refused with the reason`; `the build is charged as local school credits`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Plant one-line bugs in his repos that their own tests catch, for the school to race on`.

### Task 19: Arenas from real past issues [Opus] [screens]

**Files:**
- Modify: `engine/school/arenas.ts` (`buildPast`)
- Test: `test/school-arenas.test.ts`

**Interfaces:**
- Consumes: `mergedPRs(fullName)` (`github.ts`), the mirror (`paths().mirrors`), `engineGit`.
- Produces: `buildPast(repo, now): Promise<ArenaInfo>` (ruling 20: PRs touching source and tests; task base is the merge's first parent with the PR's test files applied; kept only if those tests fail there and pass at the merge; `arena_tasks.pr` and `.sha` set so Tasks 21 and 22 can exclude sealed ones); `sealedRefs(): Set<string>` (every PR number and merge sha in any arena's sealed split).
- [ ] **Step 1: Write the failing tests** (a bare repo fixture with three merged PRs: one with a test that fails at its parent, one whose test already passed at its parent, one without tests): `only the first becomes a task`; `its task shows the failing test and not the fix`; `sealedRefs names the sealed tasks' PR and sha`; `the build never fetches from GitHub beyond the mirror`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Turn his merged fixes with tests into tasks the school can race on`.

### Task 20: Arenas as Beagle arenas: tools and grading in the sandbox [Opus] [screens]

**Files:**
- Modify: `engine/school/arenas.ts` (`toBeagleArena`)
- Test: `test/school-arena-grade.test.ts`

**Interfaces:**
- Consumes: Beagle's `Arena`, `ToolSpec`, `registerArena`, `unregisterArena` (Task 4's `BeagleApi`); `execFileTool`, `execTool` (`broker.ts`); the arena tasks (Tasks 18, 19).
- Produces: `toBeagleArena(info: ArenaInfo): Arena` (ruling 21: `id` `palimpsest:<repo>:<kind>`, `kind 'fixtest'`, `describe`, `answer` schema, `show(input)` (the failing tests' names and output, the planted or past task's file list; never a path of this Mac), `tools` `read_file`, `list_files`, `search`, `run_tests`, each executed in the task's scratch clone under the tool profile with no egress, `grade(answer, truth)` by ruling 21, `selfCheck(answer)` "Run the tests on your edits once more and give your final edits.", `starters()` from the seeded agents' genomes through `toGenome()`); `registerArenas(): Promise<number>` (every `ready` arena, at school start).
- [ ] **Step 1: Write the failing tests:** `a correct edit scores 1, a fix that breaks another passing test 0.5, an edit to a test file 0 with the reason`; `a find that is not unique is refused`; `read_file outside the clone and through a symlink is refused` (the broker's file tool); `run_tests has no network`; `show never contains the temp dir's path`; `the arena registers in Beagle and its sealed tasks are the stored sealed split`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Race agents on his repos' tasks through Beagle, graded by their own tests in the sandbox`.

### Task 21: Voyages [Opus] [screens]

**Files:**
- Create: `engine/school/voyages.ts`, `engine/school/campus.ts`
- Modify: `engine/school/tick.ts`, `engine/market/firms.ts` (`ROSTER` gains school-bred specialists from the `voyages` rows; `hire()` prefers them where the router is trusted), `engine/market/trips.ts` (reason `school`, the campus as a place)
- Test: `test/school-voyages.test.ts`, `test/firms.test.ts`, `test/trips.test.ts`

**Interfaces:**
- Consumes: `loadBeagle()` (`startVoyage`, `race`, `breed`, `compareToParents`, `sealedScore`, `finishVoyage`), `schoolDriver`, `gateNow('heavy')`, `sealedRefs()`, `toGenome`, `nextSlot('campus', …)` (Task 1).
- Produces: `sailVoyage(arenaId, now): Promise<VoyageView>` (ruling 22; one voyage at a time; the designer's evidence filtered to breeding-split tasks only; children kept only with `lo > 0` against their parent; aborted on a gate loss through the signal and resumed at the next generation boundary; records `voyage.started`, `voyage.generation`, `voyage.ended`; parents' agents travel to the campus and home); `voyages(): VoyageView[]`; `ensureCampus(): number`, `campusOrigin(): P`.
- [ ] **Step 1: Write the failing tests** (fake driver with scripted scores on a fake arena): `a voyage of 8 runs 4 generations and records each`; `a child no better than its parent with lo at or below zero is not promoted`; `the designer never sees a race or sealed task`; `a gate loss aborts the generation unscored and the next night resumes it`; `a champion better than every seeded agent on the sealed split with lo above zero joins the roster with origin school`; `a parent agent's persona travels to the campus and home`; `school Claude spend in a voyage stops at the day's 30 credits`; `ensureCampus takes a slot once`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Breed agents on his repos' arenas at night and keep only children that are significantly better`.

### Task 22: The LoRA dataset [Opus] [screens]

**Files:**
- Create: `engine/school/lora.ts` (the dataset half)
- Test: `test/school-lora-data.test.ts`

**Interfaces:**
- Consumes: `listRuns`, `inspection.done`, `merge.reverted`, `merge.followup`, `mergedPRs`, `engineGit` on the mirror, `sealedRefs()`, `toBeagleArena(...).describe` and `.show` for the chat shape, `LORA`.
- Produces: `hunksToEdits(before: Record<string, string>, patch: string): Array<{ file; find; replace }> | null` (ruling 23: widen each hunk's old text by whole lines until unique; null when it cannot be made unique); `buildLoraData(now): { examples: number; skipped: Record<string, number>; path: string; validPath: string }` (writes `train.jsonl` and `valid.jsonl` in `mlx_lm`'s chat format under `paths().school/lora/<id>/data`; reasons counted: `sealed`, `too-large`, `too-long`, `not-unique`, `reverted`, `young`).
- [ ] **Step 1: Write the failing tests:** `hunksToEdits widens a repeated line until it is unique and applies back to the after text`; `a city merge that survived 30 days and passed inspection is an example; one 20 days old is not`; `his merged PR never reverted is an example; a reverted one is not`; `a PR in any sealed split is skipped as sealed` (Review Focus 5); `a 30 KB file skips the change`; `the latest 10% go to valid.jsonl`; `the data never leaves paths().school`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Gather verified past work as LoRA examples, never anything from a sealed set`.

### Task 23: LoRA training and the base model download [Opus] [screens]

**Files:**
- Modify: `engine/school/lora.ts` (training), `trainer/school.py` (`lora_train`, `download_base`), `engine/school/tick.ts`
- Test: `test/school-lora-train.test.ts`, `trainer/test_school.py`

**Interfaces:**
- Consumes: `startTrain` (Task 7) with gate `heavy` and `gb LORA.gb`, `buildLoraData`, `getSettings().school.baseModel`, `.baseModelReady`.
- Produces: `downloadBase(): Promise<{ ok: boolean; bytes: number; reason: string | null }>` (the one command run without `HF_HUB_OFFLINE`, through `huggingface_hub.snapshot_download` into `paths().school/lora/base/`, egress only to `huggingface.co` and its CDN through a per-download egress proxy, only on his click, sets `baseModelReady`); `trainLora(now): Promise<TrainState>` (ruling 24; refuses without `baseModelReady` or under `LORA.min` examples with "n of 100 verified changes"; resumes from `adapters.safetensors` with `--resume-adapter-file` after a pause with the same data id and seed; records the steps done and lost).
- [ ] **Step 1: Write the failing tests** (fake spawner): `training is refused until the base is downloaded`; `training is refused under 100 examples with the count`; `the lora argv carries the ruling's flags and the trainer profile and HF_HUB_OFFLINE`; `a pause at step 230 resumes with --resume-adapter-file and the same data` (Review Focus 1); `a paused adapter is never evaluated`; `the download runs only from downloadBase and only to the Hugging Face hosts`; Python: `lora_train on a tiny synthetic model fixture writes adapters and step lines` (skipped without the venv).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Fine-tune a local coder on his verified work, at night, from a checkpoint it can resume`.

### Task 24: The mlx backend [Opus] [screens]

**Files:**
- Create: `engine/market/mlx.ts`
- Modify: `engine/market/providers.ts` (`BackendKind` gains `'mlx'`), `engine/market/sandbox.ts` (`trainerProfile` with a port)
- Test: `test/mlx-provider.test.ts`

**Interfaces:**
- Consumes: `ChatTransport`, `runLoop`, `jsonCall` shape (`toolloop.ts`, `ollama.ts`), `trainerProfile`, `getSpawner`, `graduate(id)` (Task 25; until then a fixture).
- Produces: `mlxTransport(model: string): ChatTransport` (OpenAI chat over `http://127.0.0.1:<port>/v1/chat/completions`, tools in the request, `tool_calls` parsed); `mlxProvider(): Provider` (plan, work, review, judge as the Ollama provider does them over this transport, `audit` through `runLoop` with the audit tools, `complete`); `ensureServer(model): Promise<number>` (one server at a time, started under the profile, ready when `/v1/models` answers, stopped after 10 idle minutes or on shutdown); credits by seconds at `LORA.gb`.
- [ ] **Step 1: Write the failing tests** (a fake HTTP server on port 0 standing in for `mlx_lm.server`, a fake spawner): `providerFor mlx: returns the mlx backend`; `a work loop's tool call round-trips through the transport`; `the server is started once, wrapped in the profile with loopback bind only, and stopped after 10 idle minutes`; `a second graduate stops the first server`; `credits are local by seconds`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. On his Mac, once a base is present, start `mlx_lm.server` under the profile by hand and confirm a tool call parses for Qwen2.5-Coder (the log goes in the commit body).
- [ ] **Step 5:** Commit `Serve the school's graduates as mlx models, fenced in and on loopback`.

### Task 25: Graduation [Opus] [screens]

**Files:**
- Modify: `engine/school/lora.ts` (evaluation and graduation), `engine/market/firms.ts` (graduates on the roster, root `collegiate`), `engine/school/tick.ts`
- Test: `test/school-graduate.test.ts`, `test/firms.test.ts`

**Interfaces:**
- Consumes: `sealedScore` (Beagle), `pairedCi`, `mlxProvider`, every arena's sealed split, `hire()`.
- Produces: `evaluateAdapter(loraId, now): Promise<{ sealed: Interval; baseSealed: Interval; vsBase }>` (ruling 25; both as the same single-shape genome on every sealed task; charged as `train` for the minutes); `graduate(loraId, now): Graduate | null` (only when `vsBase.lo > 0`; records `graduate.made`; adds the agent to the roster); `graduates(): Graduate[]`; a hired graduate's tower uses root `collegiate`.
- [ ] **Step 1: Write the failing tests:** `an adapter whose paired interval is above zero graduates as mlx:grad-qwen25c7-1`; `one whose interval spans zero does not, and the reason names the numbers`; `the evaluation uses only sealed tasks the adapter's data excluded`; `a graduate on the roster can be hired by the Phase 2 rule and its tower root is collegiate`; `a graduate commutes from the campus to its quarter when hired`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Graduate a fine-tuned coder only when it beats its base on the sealed set`.

### Task 26: School API routes, the client, the router and redaction [Sonnet] [screens]

**Files:**
- Create: `engine/school/api.ts`
- Modify: `engine/market/api.ts` (mounts the school routes), `app/src/api.ts`, `app/src/router.ts`
- Test: `test/school-routes.test.ts`, `test/router.test.ts`, `test/api-events.test.ts`

**Interfaces (full brief):**
- Routes (JSON; writes need `x-palimpsest: 1`):
  - `GET /api/school` -> `{ settings: SchoolSettings; gate: { light: GateState; heavy: GateState }; trainer: trainerStatus(); nets: NetCard[]; agreements: Agreement[]; grants: Grant[]; arenas: ArenaInfo[]; voyages: VoyageView[]; graduates: Graduate[]; trains: TrainState[] }`.
  - `GET /api/school/nets/:net` -> `NetCard` with its full history; `GET /api/school/voyages/:id` -> `VoyageView`; `GET /api/school/graduates/:id` -> `Graduate`; `GET /api/school/campus` -> `{ origin: { x; z }; slot: number; live: { voyage: boolean; nets: boolean; lora: boolean } }`.
  - `POST /api/school/train-now` -> `GateState` (refused 409 on battery); `DELETE /api/school/train-now`; `POST /api/school/download-base` -> 202; `POST /api/school/arenas/:owner/:name` with `{ kind }` -> 202 `ArenaInfo`.
  - `POST /api/autonomy/:kind/:owner/:name/grant` (409 without an open ask), `/decline`, `/revoke` -> `Grant`.
  - `PATCH /api/settings` accepts `school` fields: `enabled`, `window` (`HH:MM`), `idleMinutes` (5 to 120), `claudeCreditsPerDay` (0 to 100), `designer` (`ModelRef` by shape only, never `ollama list` in a route), `understudy`.
  - `JobDetail.school` (Task 14) through `scrub()`.
- `scrub()` on every field of every view above; no training file path, no `rows.json` and no Understudy shot path is ever served.
- `app/src/api.ts`: `school()`, `net(name)`, `voyage(id)`, `graduate(id)`, `campus()`, `trainNow()`, `stopTrainNow()`, `downloadBase()`, `buildArena(owner, name, kind)`, `grant(kind, owner, name)`, `decline(…)`, `revoke(…)`; `EVENT_TYPES` gains `train.started`, `train.paused`, `train.ended`, `net.trained`, `net.promoted`, `voyage.started`, `voyage.generation`, `voyage.ended`, `autonomy.asked`, `autonomy.granted`, `autonomy.revoked`, `autonomy.acted`, `graduate.made`.
- `app/src/router.ts`: `Route` gains `'school'` (`#/school`), `'net'` (`#/school/nets/:net`), `'voyage'` (`#/school/voyages/:id`), `'graduate'` (`#/school/graduates/:id`).
- [ ] **Step 1: Write the failing tests:** `the school view lists seven net cards (the five nets, the appraiser's two heads counted apart, and the master) as thin on an empty home with the counts`; `grant without an ask is 409`; `revoke answers the grant revoked`; `train-now on battery is 409 with the reason`; `settings refuse idleMinutes 2 and a designer of the wrong shape without running ollama`; `no view carries a path of this Mac or a rows file`; `SSE forwards net.trained and autonomy.acted scrubbed`; `router parses the four school routes`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Serve the school, its nets, voyages, graduates and grants, scrubbed`.

### Task 27: The sample school [Opus] [screens]

**Files:**
- Modify: `engine/market/sample-economy.ts` (`seedSchool()` called from `seedEconomy()`), `tools/sample.ts`
- Test: `test/sample-economy.test.ts`

**Interfaces:**
- Produces: `seedSchool()` adds, with ledger entries that replay: nets with histories (appraiser-pass trusted at v6, Brier 0.14 [0.10, 0.19] against 0.22, n 64; router trained not trusted; durability thin "18 of 40"; triage trusted with "taught by the master on 22 rows"; taste thin; master trusted at v5, agreement 0.92 [0.84, 0.98] on 50); agreements by kind (`propose:readme-gap` at 48 of 50 eligible, `merge:low` 44 of 50, the rest under 50); one open ask on `tidewater/harbor-ledger` for `propose:readme-gap`, one grant on `hoshi/kumo` for `merge:low` with two autonomous merges, one revoked by a revert last week; two arenas (`tidewater/harbor-ledger` planted, 48 tasks; `hoshi/kumo` past, 22 tasks); one finished voyage with four generations and two promoted children, one sailing that the clock ends in 30 s at speed 20; one graduate `mlx:grad-qwen25c7-1` (sealed 0.61 [0.52, 0.70] against base 0.47 [0.38, 0.56], diff 0.14 [0.06, 0.22]) hired by Quickset; a paused LoRA run "on battery"; the gate states for a night window. All on the fake trainer; nothing in the sample ever spawns Python. `economyClock` gains `school: boolean` (default true).
- [ ] **Step 1: Write the failing tests:** `the sample school replays clean`; `the clock ends the sailing voyage with its numbers`; `the brief holds an autonomy ask and an acted item`; `the sample never spawns python or mlx_lm`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The numbers above are the copy he reads in captures; keep them.
- [ ] **Step 4:** Run; expect PASS; the `--economy` seed on a temp home with `PALIMPSEST_PORT=4790` answers `/api/school`.
- [ ] **Step 5:** Commit `Seed a school with nets, voyages, a graduate and a grant into the sample economy`.

---

## Part B: the screens (screens track)

The screens keep the book-like language: sheets over the city, Newsreader for names and headings, IBM Plex Sans for text, Plex Mono for numbers and refs, hairline rules, sentence case, square corners. Every score is a number with its interval and its n, never a bar of colour alone.

### Task 28: The school screen [Opus] [screens]

**Files:**
- Create: `app/src/ui/school.ts`, `app/src/ui/school-words.ts`, `tools/ui-test-school.ts`
- Modify: `app/src/main.ts`, `app/src/ui/runhead.ts` (School after Firms), `app/src/ui/market.css`
- Test: `test/school-words.test.ts`, `tools/ui-test.ts` (calls `schoolChecks`)

**Interfaces:**
- Consumes: `api.school()`, `api.net()`, `api.voyage()`, `api.graduate()`, the school events.
- Produces (`app/src/ui/school-words.ts`, pure): `intervalText(i: Interval, metric)` ("Brier 0.14, 95% interval 0.10 to 0.19, on 64 held-out rows"), `netLine(card)` (thin: "18 of 40 labels; it says nothing until it has 40"), `gateLine(g: GateState)` ("Training waits: on battery." / "Training may run: on power, idle 22 minutes, inside 1:00 to 6:00."), `agreementLine(a)` ("48 of the last 50, 0.96 (0.90 to 1.00)"), `kindLabel(kind)` (`propose:readme-gap` "Posting README proposals as jobs", `merge:low` "Merging low tier PRs", and the rest).
- Produces (`app/src/ui/school.ts`): `createSchool(parent, deps)`: the sheet "School" with sections as ledgers: "The nets" (one row each: name, its job in a sentence, the score line, against the baseline, trusted or not, a small line chart of its held-out score per version with the interval as a band, drawn in SVG with hairlines, no fill glow), "The master" (agreement by kind: one row per kind with the line and eligible or how many more), "Voyages" (each with generations, the champion's score and interval, promoted children with their differences; a sailing one updates live), "Graduates" (sealed score against base with the difference and its interval), "Training" (the gate lines, the trainer status, the live train with steps, and the minutes trained this week on power); each row links to its page (`#/school/nets/:net`, `#/school/voyages/:id`, `#/school/graduates/:id`).
- [ ] **Step 1: Write the failing tests:** unit tests for each word function; UI tests (economy, shots `school.png`, `school-net.png`, `school-voyage.png`): seven net rows with numbers and intervals; durability reads "18 of 40 labels"; the master section shows `propose:readme-gap` eligible; the sailing voyage reaches its fourth generation live; the graduate row reads its difference and interval; a net's page draws one point per version; no console errors.
- [ ] **Step 2:** Run `npm run ui-test`; expect FAIL on the new checks.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): every number must carry its interval and n; the charts must read as engraved plates, not a dashboard; thin nets must look honestly empty, not broken. Commit `Show what the school has learned, each claim with its number`.

### Task 29: Autonomy where he decides: Settings, the district page, the brief and the job page [Opus] [screens]

**Files:**
- Create: `app/src/ui/autonomy.ts`
- Modify: `app/src/ui/settings.ts` (section "Autonomy"), `app/src/ui/repo.ts` (the "Autonomy grants arrive with Phase 4." note becomes the repo's grants block), `app/src/ui/brief.ts`, `app/src/ui/brief-words.ts` (`grant` "Let the city do this on its own here", `decline` "Not yet", `revoke` "Take it back"), `app/src/ui/job.ts` ("What the school thinks": the appraisal, the router's three best agents, durability, the master's guess with its version, or "The master abstained: <reason>")
- Test: `test/brief-words.test.ts`, `tools/ui-test-school.ts`

**Interfaces:**
- Produces (`app/src/ui/autonomy.ts`): `renderGrants(grants: Grant[], agreements: Agreement[], opts: { repo?: string; onGrant; onDecline; onRevoke }): HTMLElement`: one ruled row per (kind, repo): the kind in words, the agreement line, the state ("asked on Tuesday", "granted 3 November, 6 merges since", "revoked by a revert on 8 November", "declined; asks again after 2 December"), and its one action as a text button in the line; the Settings section lists every pair and a sentence above it: "The city asks before it does any kind of work on its own, repo by repo. A revert takes the permission back at once."
- [ ] **Step 1: Write the failing tests:** unit: the three labels; UI (economy, shots `autonomy-settings.png`, `district-autonomy.png`, `brief-autonomy.png`, `job-school.png`): the harbour ask grants from the brief and shows granted in Settings and on the district page without reload; Take it back on `hoshi/kumo` revokes and the row says so; the revoked-by-revert row reads its date; a job page shows the master's guess and a thin net shows its reason; keyboard reaches every action; no console errors.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): a grant must read as a permission he gives, not a toggle; the revoke must be one plain action away everywhere a grant shows. Commit `Let him grant, decline and take back the city's autonomy where he already looks`.

### Task 30: Training settings and the trainer's state [Sonnet] [screens]

**Files:**
- Modify: `app/src/ui/settings.ts` (section "School" under Analysis), `app/src/ui/treasury.ts` (the school's spend rows under the city's own calls, the minutes trained on power this week)
- Test: `tools/ui-test-school.ts`

**Interfaces (full brief):**
- Settings "School": "Run the school" (switch, `school.enabled`, line: "Off by default. While on, the city builds arenas from your repos, breeds agents and trains its nets and coders on this Mac."); "Train between" two times (`window`); "Only after the Mac has been idle for" (`idleMinutes`); the gate's live line from `gateLine()` for heavy; "Train now" (disabled on battery with the reason; shows "until 4:10" while live; "Stop"); "The school may spend on Claude each day" (`claudeCreditsPerDay`, in credits and as a share of a window: "30 credits, 3% of a window"); "Design agents with" (`designer`); "Read your taste from Understudy" (switch, with the line "Read only, on this Mac; it reads your taste statements and the pairs you picked."); "Base model for coders" (the name, its size, and "Download, about 4.3 GB" until ready, then "Ready"); the trainer status line ("The trainer is not set up on this Mac. Run npm run trainer:setup in the Palimpsest folder."). Privacy adds: "Training happens on this Mac. Nothing it learns leaves it. The one download is the base model, from Hugging Face, when you click Download."
- Treasury: `school` and `train` rows in the spend table; "Trained 3 h 12 min on power this week" under it.
- [ ] **Step 1: Write the failing UI tests:** the switch patches `enabled`; a window of `25:00` is refused in place; Train now is disabled with "on battery" when the sample gate says battery; Download shows 202 and then "Ready" when the fake finishes; the treasury lists school and train spend; no "arrive with Phase 4" text anywhere in the built app (a grep over `dist/assets/*.js`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Put the school's switches, its hours and its spend where he sets the city's limits`.

---

## Part C: the city (city track)

Every task here keeps every view at 60 fps on his M5 Pro and re-measures the city from home against the guard (12M triangles, 850 calls) with every Phase 2 and Phase 3 ornament standing. The campus budget from home is at most 40 draw calls and 900k triangles, with LOD.

### Task 31: The campus site, its terrace, quads and halls [Opus] [city]

**Files:**
- Create: `app/src/city/campus/site.ts`, `app/src/city/campus/halls.ts`, `app/src/city/campus/index.ts`
- Modify: `app/src/city/scene.ts` (`setCampus(origin)`), `app/src/main.ts` (reads `GET /api/school/campus`), `app/src/city/lots.ts` (the campus block is not an ambient lot)
- Test: `test/campus.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `api.campus()` (Task 26), `towerMaterials` (`look.ts`), Poly Haven CC0 textures already in the kit (brick, limestone, slate), `Kit` (`tower/kit.ts`).
- Produces: `createCampus(opts: { quality; materials }): { group: THREE.Group; set(origin: { x; z }): void; anchors(): CampusAnchors; update(dt, clock): void; dispose() }` where `CampusAnchors = { library: Vec3; clock: Vec3; dome: Vec3; gate: Vec3 }`; the site: a 240 m block, a terrace 6 m up with a dressed limestone retaining wall and two flights of steps to the street, two grass quads crossed by stone paths, and four collegiate gothic halls (red brick with limestone dressings, slate roofs, buttresses, pointed-arch windows with stone tracery, chimneys), each built once in a `Kit` and instanced; windows use the facade window shader with lit rooms driven by `update`.
- [ ] **Step 1: Write the failing tests:** `the campus stands on its slot's origin and inside its block`; `no ambient lot overlaps it`; `the halls are instanced: four halls cost the draw calls of one`; UI test: `the campus is visible from home and within its budget`; shots `campus-home.png`, `campus-quad.png`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the halls must read as collegiate gothic (buttress rhythm, tracery, roof pitch) at both distances, not as boxes with arches drawn on; the terrace must read as a hill the street climbs. Commit `Raise the university on its own terrace: quads and collegiate halls`.

### Task 32: The library and the clock tower [Opus] [city]

**Files:**
- Create: `app/src/city/campus/library.ts`, `app/src/city/campus/clock.ts`
- Modify: `app/src/city/campus/index.ts`
- Test: `test/campus.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `makeLibrary(k: Kit): THREE.Group` (a long reading room with tall traceried windows, a central entrance tower, a lead roof with a lantern); `makeClockTower(k: Kit, clock: () => Date): { group; update(): void }` (a four-stage tower 48 m high with a clock face on each side whose hands show his local time, lit faces at dusk as real emitters under the bloom threshold, a bell stage with louvres and pinnacles).
- [ ] **Step 1: Write the failing tests:** `the clock's hands point at 10:10 for a 10:10 clock`; `the faces emit only after sunset by the sky's clock`; UI test: shots `campus-library.png`, `campus-clock.png`; within the budget.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the clock tower must hold the skyline of the campus without competing with the city's spire; tracery must not alias at home distance. Commit `Build the university's library and its clock tower`.

### Task 33: The observatory where the master net lives [Opus] [city]

**Files:**
- Create: `app/src/city/campus/observatory.ts`
- Modify: `app/src/city/campus/index.ts`
- Test: `test/campus.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `api.school()` (the master's card), events `net.trained`, `net.promoted`, `train.started`, `train.ended`.
- Produces: `makeObservatory(k: Kit): { group; setState(s: { training: boolean; masterTrusted: boolean; version: number | null }): void; update(dt): void }`: a domed observatory on a drum (copper dome with verdigris breakup, ribs, a shutter slit); while the nets train the slit is open and the telescope inside turns slowly with warm light in the slit; when the master is trusted a small brass plate light by the door is lit and the inspector names its version and agreement; when it is thin or untrusted the dome stays shut and dark. Every state comes from the school's data, never a timer.
- [ ] **Step 1: Write the failing tests:** `the slit opens on train.started for nets and closes on train.ended`; `a thin master leaves the dome shut and unlit`; `clicking the dome opens the school screen at the master`; UI test: shots `observatory-shut.png`, `observatory-open.png`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): copper must read as aged metal under the city's own sky light, not plastic; the slit light must be the only bright thing on the dome. Commit `Give the master net its observatory, open only while it learns`.

### Task 34: Campus life from real events [Opus] [city]

**Files:**
- Create: `app/src/city/campus/life.ts`
- Modify: `app/src/city/people.ts` (trips with reason `school` end at the campus gate), `app/src/main.ts`, `app/src/ui/inspector.ts` (the campus as a place: the live voyage, the trained nets, the graduates)
- Test: `test/campus.test.ts`, `test/people.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `voyage.*`, `train.*`, `graduate.made`, `trip.started` with reason `school`, `campusAnchors()`.
- Produces: `campusLife(campus, opts): { apply(e: { type; data }): void; update(dt, clock): void }`: the library's reading room windows light, one bay per genome racing, while a voyage sails, and go dark when it ends; personas whose agents are parents in a voyage walk in through the gate and are seen crossing the quad; a graduate leaves through the gate on its first trip; nothing on the campus moves without one of these events except ambient students, which are unlabelled atmosphere like the city's crowds.
- [ ] **Step 1: Write the failing tests:** `a voyage of 8 lights 8 bays and its end darkens them`; `a school trip ends at the gate`; `the inspector on the campus lists the live voyage and the graduates`; UI test (economy): the sailing voyage lights the library; shot `campus-voyage.png`; within the budget.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): lit bays must read as people working late, not a light show. Commit `Light the library while agents are bred and walk them in through the gate`.

### Task 35: The collegiate root for graduates' towers [Opus] [city]

**Files:**
- Modify: `app/src/city/tower/*` (the root builder for `collegiate`), `shared/tower-layout.ts` (root heights per style)
- Test: `test/tower-build.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `RootStyle 'collegiate'` (Task 1), the halls' brick and limestone materials (Task 31).
- Produces: a `collegiate` root (spec 6.2): two storeys of red brick with limestone quoins, a pointed-arch entrance and a stone string course under the datum, sharing the campus's materials so a graduate's tower reads as from the university.
- [ ] **Step 1: Write the failing tests:** `a collegiate root builds with the expected height and slots`; UI test: Quickset's graduate tower stands on a collegiate root; shot `graduate-tower.png`; within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Root a graduate's tower in the university's brick`.

---

## Part D: real runs, media and the README

### Task 36: Real-run check: the trainer, the gate and the nets on his ledger [Opus] [both tracks merged]

**Files:** `docs/superpowers/plans/2026-11-12-phase-4-realrun.md` holds the notes; fixes only where found.

- [ ] **Step 1:** With his go-ahead, on the installed engine: `npm run trainer:setup`; `trainerStatus()` ready; `school.py ping` under the real trainer profile sees the GPU. Turn `school.enabled` on. Record the gate's readings over one night (power, idle, thermals) from the ledger.
- [ ] **Step 2:** Confirm the nightly retrain ran inside the window on AC power only, that every net reports `thin` with its true counts (expected: near zero on his real ledger), that no prediction was made by a thin master (every `master.predicted` abstains), and that no ask exists. Unplug during a forced "Train now" retrain and confirm the pause within 30 s.
- [ ] **Step 3:** Confirm `~/.claude/settings.json`, `~/.claude.json` and Understudy's database are byte-identical before and after (md5 recorded), and that `~/Library/Application Support/Beagle` was not touched.
- [ ] **Step 4:** Commit `Fix issues found running the school on his Mac` (never his data).

### Task 37: Real-run check: an arena, a voyage and a LoRA on one of his repos [Opus] [both tracks merged]

- [ ] **Step 1:** With his go-ahead, on a repo he names with a test command, build the planted arena by hand from the district page (`POST /api/school/arenas/...`); record candidates, kept, the split, the wall time and the credits.
- [ ] **Step 2:** Sail one voyage on it on local models only; record each generation's champion with its interval, the promoted children with their paired intervals, the designer's Claude credits (must be at most 30 that day and show in the treasury and the night cap), and the sealed score.
- [ ] **Step 3:** With his click, download the base model; build the LoRA data and record the counts and skip reasons. If at least 100 examples exist, train one adapter overnight and evaluate it; record the sealed scores and the paired difference whether or not it graduates. If fewer than 100, record the count and stop there; that is the honest result.
- [ ] **Step 4:** Commit `Record the school's first real arena, voyage and coder, with their numbers`.

### Task 38: UI test, captures, README and media [Opus] [both tracks merged]

**Files:**
- Modify: `tools/ui-test.ts`, `tools/capture.ts`, `README.md`, `CREDITS.md`, `docs/media/*`

- [ ] **Step 1:** `tools/ui-test.ts` runs the Phase 4 set on the economy with the clock (school, autonomy, training settings, campus, observatory, life, graduate tower), the console-error check on every screen, and the perf guard from home with the campus standing; `npm run ui-test` passes on a quiet GPU.
- [ ] **Step 2:** `tools/capture.ts` gains stills `school`, `school-net`, `autonomy-settings`, `brief-autonomy`, `campus-home`, `campus-quad`, `campus-clock`, `observatory-open`, `graduate-tower` and clips `voyage` (the library lit as the sample voyage sails, 30 s at the clock's speed) and `observatory` (the slit opening as the nets train). All from the sample economy at 2x.
- [ ] **Step 3:** README in his style: what Phase 4 adds in plain first person (the university, the arenas from his repos, breeding with Beagle, coders fine-tuned on his verified work and graduated only on a sealed set, the five nets and the master, earned autonomy and how it is taken back); the honest state with the real-run numbers from Tasks 36 and 37, including how few labels exist and what that means for autonomy; when the Mac trains and what it costs; privacy; the stills and clips. Shields row to phase 4.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test` pass; `npm run test:trainer` passes on his Mac; `cargo test` in `src-tauri` still passes.
- [ ] **Step 5:** Commit `Phase 4: the school` and push per his standing order.

---

## Self-review notes

- **Spec coverage.** 9 and 12 (Beagle as a library, fixes in Beagle's repo): rulings 1 and 2, Tasks 2 and 4. 9.1 (the audit's findings): checked against Beagle's head; the two already fixed are named, the open three are Task 2 (d), (e) and the two left for the city are Decision 2. 9.2 (arenas from his repos graded by their suites in a sandbox: Tasks 18 to 20; LoRA on MLX from verified past work: Tasks 22 and 23; graduates served as `mlx:` and joining firms: Tasks 24 and 25; beat the base on a sealed set: ruling 25; numbers with intervals: ruling 11, Tasks 12 and 28). 9.3 (five nets and their sources: ruling 8, Tasks 8 to 13; the master: Tasks 14 and 15; distillation both ways: ruling 13, Task 13; nightly retrain: Task 13; trained locally on MLX: Tasks 5, 7 and 11). 9.4 (95% over 50: ruling 16; asks per kind and repo: ruling 17; shown in Settings, revocable: Tasks 16 and 29; a revert drops the grant: ruling 19, Task 17). 17 (autonomy governs posting proposals and merging PRs in PR mode; unavailable without a harness: rulings 14, 17 and 18). 6.1 (the university with library, clock tower, quads and the observatory where the master lives: Tasks 31 to 33). 6.2 (graduates start in collegiate gothic brick: Task 35). 6.4 (to the university when in training: ruling 28, Tasks 21 and 34). 7.2 (hiring a graduate or a bred specialist: Tasks 21 and 25). 7.3 and 4 (a sink for his usage; the night cap): rulings 3 and 4, Tasks 1 and 4. 11 (the school screen; Settings autonomy grants; the district's grants): Tasks 28 to 30. 5 (MLX in a native arm64 venv, Beagle's pattern): ruling 7, Task 5.
- **Interfaces that do not exist today, and where they are made:** `Provider.complete` (Task 3), the `mlx` backend kind (Task 24), `acquire(…, 'school')` and the school pool (Task 1), `mergePR` (Task 17), `merge.followup` (Task 9), `RootStyle 'collegiate'` and `TripReason 'school'` (Task 1), `nextSlot('campus', …)` (Task 1), `liveWork(pool)` and `creditEntries(runId)` exported from `budget.ts` (Tasks 6 and 8), every Beagle function in ruling 1's list that Beagle lacks at `4edbd39` (Task 2).
- **Spend accounting:** every Claude call of the school goes through `schoolDriver` (Task 4) or the graduation evaluation's `schoolDriver` use (Task 25); every local minute is charged (`train` in Task 7, `school` for arena builds in Task 18 and local races through the driver); both kinds count in every cap list (Task 1's tests).
- **Tests that would pass before the change:** each Step 1 names a function, table, route or element that does not exist before its task; the pins are marked (`poolOfModel('mlx:…')` in Task 1, Phase 2's award in Task 14, "no action without a grant" in Task 17).
- **Type consistency:** `NetName`, `NetCard`, `NetVersion`, `Interval`, `WorkKind`, `Prediction`, `Decision`, `Agreement`, `Grant`, `GateState`, `TrainState`, `ArenaInfo`, `VoyageView`, `Graduate`, `SchoolSettings` are defined once in Task 1; `rowsFor` once in Task 8; `forward`, `parseNet` in Task 11; `trainNet`, `current`, `netCard` in Task 12; `predict`, `registerPrediction` in Task 14; `agreement`, `installDecisions` in Task 15; `mayAct`, `grant`, `revoke`, `revokeOnRevert` in Task 16; `act`, `mergePR` in Task 17; `toBeagleArena`, `sealedRefs` in Tasks 19 and 20; `sailVoyage`, `ensureCampus`, `campusOrigin` in Task 21; `hunksToEdits`, `buildLoraData` in Task 22; `trainLora`, `downloadBase` in Task 23; `mlxProvider` in Task 24; `graduate`, `evaluateAdapter` in Task 25; `createCampus` in Task 31.
- **Proportion:** 38 tasks against the spec's Phase 4 line and sections 9.1 to 9.4 (the largest section of the spec after the market); step bodies carry only values the spec, a Phase 2 or 3 ruling, or a ruling here pins.
