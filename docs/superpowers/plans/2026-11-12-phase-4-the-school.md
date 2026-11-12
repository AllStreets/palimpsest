# Phase 4: The School Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-11-12).** Revised after builder check round 1 (`.superpowers/sdd/phase-4-plan-review-1.md`, NOT READY: 3 Critical, 14 Important, 12 Minor). Every item is addressed; "Builder check fixes" at the end maps each to the ruling or task that fixes it. Task 21 of revision 1 is split, the campus plot moves into Task 1, and two tasks are added (verified history; the agent page's lineage), so the tasks are renumbered (41 tasks).

**Goal:** Open the university: the city breeds agents on arenas built from his own repos with Beagle's engine, fine-tunes small local coders with LoRA on MLX from verified past work and graduates only those that beat their base on a sealed set, trains five small nets and a master net from what actually happened, shows every one of them with held-out scores and confidence intervals (and says plainly when there is nothing yet to show), and asks his permission, kind by kind and repo by repo, to act on its own once the master agrees with his own decisions often enough, dropping any grant the moment a revert or his own undoing says it was wrong.

**Architecture:** A school layer under `engine/school/` owns everything new. Beagle (`AllStreets/beagle`) is imported as a library through one loader (`engine/school/beagle.ts`) that points Beagle's store under the Palimpsest home, writes Palimpsest's arena tasks into that store, and replaces Beagle's model driver with one that goes through Palimpsest's own `Provider.complete()`, leases and credits, so no Beagle call can bypass the caps, the Claude slots, the sandbox or the night cap. Arenas are built, only on his click and only from market-on repos, from planted bugs and from verified past changes, checked by running each repo's own suite under the tool profile, and raced through Beagle with tools that run through the command broker. Training (the nets, the LoRA) runs in a native arm64 Python venv with `mlx` and `mlx-lm`, as a warm subprocess under its own sandbox profile, only when the training gate holds (on AC power, idle, inside the window, cool, with disk, with no local job waiting); it yields to real work and resumes from checkpoints. The nets are small MLPs trained in MLX and exported as JSON weights; the engine runs their forward pass in TypeScript (`shared/nets.ts`). The master's predictions are registered before he decides, resolved only against what he himself then did (never the city's own acts), and the autonomy gate reads only those prospective pairs; every path that cannot prove the gate holds refuses. Graduates are scored on a sealed race outside any voyage and served by `mlx_lm.server` through a new `mlx:` backend. The UI adds the school screen, autonomy in Settings, on the district page and in the brief, lineage on the agent page, and in the city the university campus on its own plot with the observatory where the master net lives.

**Tech Stack:** Node 22.13+, TypeScript, tsx 4.23 (loads Beagle's `.ts` from `node_modules`, verified by the builder check), `node:test`, `node:sqlite`, three.js 0.187, Vite 8, Playwright, Tauri 2, `gh`, `git`, `sandbox-exec`, `pmset`, `ioreg`, `df`, the `claude` CLI 2.1.319+ (his own install), Ollama 0.40+ on `127.0.0.1:11434`, Beagle at a pinned full sha, Python 3.12 arm64 (uv's `cpython-3.12-macos-aarch64-none`), `mlx` 0.32.4, `mlx-lm` 0.32.2, numpy, `huggingface_hub`.

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 4 in section 13; sections 2 goals 6 and 7, 4, 5, 6.1, 6.2, 6.4, 7.2, 7.3, 8, 9.1 to 9.4, 11, 12 and 17 apply). The Phase 2 plan (`2026-11-10-phase-2-market.md`, "Phase 2 ruling n", "Phase 2 test safety rule n") and the Phase 3 plan (`2026-11-11-phase-3-analysis-and-brief.md`, "Phase 3 ruling n") fix the conventions this plan continues.

**Starting head.** Phase 4 starts only after Phase 3's Task 21 and Phase 3's final review have landed, with `phase-3-screens` and `phase-3-city` merged. That head contains Phase 2's `b1bb756` (`home()` throws under a test whose home is unset or real), Phase 3's notices and audit settings (`9156a19`, `d9e17dd`) and Phase 3's city ornaments (Tasks 14 to 18), which the campus's draw budget is measured against. A task that finds `engine/home.ts` without `onRealDataHome()` or `app/src/city/scene.ts` without `towerPiece()` stops and asks the controller. Task 2 is a hard stop in the controller's ledger: Task 4 cannot start until he has merged Task 2's PR on Beagle.

**What was found on this Mac (2026-11-12), read-only, and confirmed by the builder check:**
- Beagle is cloned at `~/Downloads/beagle` (clean, head `4edbd39`, public repo). Since the 2026-11-08 audit it fixed breeding outside geotag (`aae774c`) and the sandbox (`6b58364`). Still open: the self-check prompt is geotag's (`src/runner.ts:88`), parent against child is compared only in the browser (`app/src/holdroom.ts`), fossils are geotag only, there is no LoRA. For use as a library it lacks: `exports`, a lazy home (`src/paths.ts` reads `BEAGLE_HOME` at import, `store.open()` caches one database), a designer option (`DESIGNER` fixed), an abort, the `mlx:` prefix (`validate()`, `complete()`, the `Driver` union), an export of `splitOf` (only in `src/arenas/custom.ts`), a way to write tasks into its store (every race reads `tasks` from Beagle's own database), and a sealed race outside a voyage (`sealedScore()` needs a finished voyage whose genome rows only `race()` inserts, and runs once per voyage and genome). tsx loads Beagle's `.ts` from `node_modules`; plain Node refuses (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); the engine's launchd plist runs `node --import tsx`.
- MLX is not importable from any system Python; it is installed in Beagle's venv `~/Downloads/beagle/trainer/.venv` (CPython 3.12.7 arm64, `mlx` 0.32.4, `mlx_lm` 0.32.2, `huggingface_hub` 2.4.0 with `hf_xet`), which runs on `Device(gpu, 0)` and works under a `sandbox-exec` profile of ruling 7's shape. No MLX language model is downloaded.
- Power on macOS 26.4: `pmset -g` prints "Currently in use:" with `powermode 1` (0 automatic, 1 low power, 2 high power) and no `lowpowermode` key; `pmset -g custom` shows `powermode 1` under "AC Power:" and `0` under "Battery Power:", so **his Mac runs Low Power on AC**; `pmset -g therm` prints only "Note: No thermal warning level has been recorded", "Note: No performance warning level has been recorded" and "Note: No CPU power status has been recorded"; `pmset -g batt` starts "Now drawing from 'AC Power'"; `ioreg` `HIDIdleTime` and `df -k` parse (310 GB free).
- His real ledger: 20 `repo.analyzed`, 7 `repo.connected`, 1 `repo.disconnected`, 1 `run.ended`; the market is off on every repo; no bid, inspection, brief action or merge.
- His mirrors: palimpsest 25 commits and 0 merged PRs, teardown 14 and 0, Chicago-Open-World 398 and 0, beagle 61 and 0, understudy 14 and 0, ONEXUS 441 and 11. **Merged PRs alone give about 11 LoRA examples against the 100 needed.**
- Understudy: 37 live statements, 400 readings, 1,724 images, **0 answered pairs and 0 verdicts**, WAL journal.
- The ui-test home budget stood at 799 calls and 9.86M triangles (shadow map redrawn) before Phase 3's Tasks 15 to 17 landed, against the guard of 850 calls and 12M triangles.

**The honest state.** For months on his real data: every net is thin, every master prediction abstains, no ask is made, and the LoRA cannot train unless he says yes to Decision 7. Planted-bug arenas and voyages on market-on repos are what can run now. The plan is written so the school says this on every card, not so it looks busy.

## Decisions for Connor

Seventeen calls, one line each, with the recommendation the plan is written to. Answer in plain text; a yes to all changes nothing below.

1. **Beagle import:** a git dependency on `AllStreets/beagle` pinned by full sha (tsx loads it, no vendoring); the pin moves only in a commit you approve, and Beagle stays in PR mode with no `merge:*` grant while Palimpsest imports it. Recommend yes.
2. **Who fixes Beagle:** Task 2 makes eleven small library fixes in a fresh clone under the scratchpad (never in your checkout) as one PR for you to merge; fossils beyond geotag and LoRA inside Beagle stay as Beagle jobs for the city. Recommend yes.
3. **Low Power on AC (your call):** your Mac runs Low Power on AC, so either (a) the gate ignores power mode on AC and trains slower and cooler, or (b) Low Power blocks training and you switch AC to Automatic. Recommend (a); the plan builds `school.allowLowPower` defaulting to your answer.
4. **When the Mac trains:** on AC power only, after 15 idle minutes, between 01:00 and 06:00, with no thermal or performance warning recorded, 20 GB free and no local job waiting; "Train now" skips the window and idle but never AC power. Recommend yes.
5. **Setting up the trainer:** while building, the trainer runs on Beagle's existing venv through `PALIMPSEST_PYTHON` (nothing downloaded); `npm run trainer:setup`, which downloads Python and the MLX wheels from PyPI, runs only when you run it or say go. Recommend yes.
6. **The LoRA base model:** download `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` (about 4.3 GB) only when you click Download, with your Hugging Face login not sent and the xet transfer off. Recommend yes.
7. **Verified past work:** your repos hold about 11 merged PRs, so also count your own direct commits on default branches that touch source, survived 30 days with no revert or follow-up fix, and (where a suite exists) pass their tests when the school checks them, about 950 commits; this departs from spec 9.2's "passed inspection" and feeds both the LoRA and the past-change arenas. Recommend yes, knowingly.
8. **Arenas:** built only when you click "Build an arena" on a district page or in Settings, and only from repos whose market is on (Phase 3's rule that nothing of a repo reaches Claude before its market opens). Recommend yes.
9. **Understudy:** read its database read-only; with the switch on, your 37 taste statements are added to the design judge's bar for every UI inspection in the market, not only the Taste net; it has 0 answered pairs today, so Taste gets no labels from it yet. Recommend yes.
10. **The school's Claude spend:** voyages race local models only; the designer runs on `claude:sonnet` at most 30 credits a day (3% of a window), takes one of the city's Claude slots, waits while you are using Claude, counts in the night cap; else `ollama:qwen3-coder:30b`. Recommend yes.
11. **Kinds of work:** six: `propose:harness`, `propose:readme-gap`, `merge:low`, `merge:normal`, `merge:high`, `merge:ui`. Recommend yes.
12. **The agreement window:** 95% over the last 50 of your own decisions of a kind, pooled across repos, only predictions made before you decided, an abstention counting against, the city's own acts never counted; a repo needs 10 decisions of that kind with none of its last 10 against. A kind you approve almost always may never be offered, because a master that cannot beat the base rate is not trusted. Recommend yes.
13. **Acting under a grant:** the master must predict approve at 0.9 or more with a current version, the window must still hold, and before any merge the city re-reads the repo for a revert; your withdrawing an auto-accepted job or closing its PR counts against the master and suspends the grant; a revert revokes it; a grant you revoke is not asked about again for 30 days unless you re-grant it in Settings. Recommend yes.
14. **The appraiser in the award:** shown beside every bid once it beats the firm's pass rate as of the award on held-out rows, then the mean of the firm's calibrated confidence and its estimate; its later training rows are partly chosen by itself, so its baseline stays the firm's pass rate. Recommend yes.
15. **Firms paying the school (spec 7.2):** a firm with at least 400 credits may pay 120 credits to commission a voyage on a ready arena of a repo it has worked, and gets first refusal on the champion. Recommend yes.
16. **Where the university stands:** on the next free plot of the district spiral, taken the first time Phase 4's engine starts, so nothing already standing moves. Recommend yes.
17. **The campus's draw budget:** hold the campus to 25 calls from home with shadows and its life, re-measured at the merged Phase 3 head, rather than raising the 850 guard. Recommend hold.

## Global Constraints

- Engine API on `127.0.0.1:4770` only, with the Host and Origin checks and the `x-palimpsest: 1` header on every write; UI dev server on `4771`. Ollama only at `127.0.0.1:11434`, only from the engine. `mlx_lm.server` only on a loopback port the engine picks, only from the engine.
- Data directory `~/Library/Application Support/Palimpsest`, overridable with `PALIMPSEST_HOME`; every test sets it to a temp dir, and `home()` throws under a test whose home is unset or real. Everything the school writes lives under `paths().school` (`<home>/school`: `beagle/`, `arenas/`, `nets/`, `lora/`, `graduates/`, `understudy/`, `logs/`).
- `redact()` (`engine/market/jobs.ts`) and `scrub()` (`engine/market/api.ts`) on everything that leaves the engine; the UI cleans again with `cleanText()`. Training files, arena task bodies and Understudy shots are never served.
- The market is off by default (`Repo.market false`). The school is off by default (`school.enabled false`): no arena is built, no voyage sails, nothing trains, no net feeds the award or the brief, no prediction is anything but an abstention ("the school is off") and `act()` does nothing. Turning it off takes effect at once, mid-train included. No autonomy grant exists until he grants one.
- Nothing from a repo reaches Claude before its market is on: arenas come only from market-on repos, built only on his click (Decision 8).
- Nothing trains on his Claude plan unmetered. Every Claude call the school makes goes through `Provider.complete()` under `acquire(model, 'school', …)`, which counts in `claudeConcurrency`, drops to the single slot while `interactiveActive()`, and is refused past `school.claudeCreditsPerDay`; it is charged with `charge({ kind: 'school', unattended })`, so it counts in the day cap, the night cap, the hard stop, `citySpent`, the treasury and the report. Local training and inference are charged as local credits (`train`, `school`), which never enter the Claude windows.
- Downloads only on his click or go-ahead: the base model (Task 25), `trainer:setup` (Task 5). Every other trainer environment carries `HF_HUB_OFFLINE=1`.
- The training gate (ruling 6) is re-read every 30 s while anything trains or races; when it fails the trainer is stopped within 30 s and resumes from its last checkpoint. A probe that cannot be read fails the gate.
- Earned autonomy is fail-closed: an action under a grant happens only when every check in ruling 18 answers yes at that moment, a fresh revert read included; any error means no action and a recorded reason. A revert of an autonomous merge revokes its grant before any other autonomous action on that repo; his undoing of an autonomous act suspends it.
- Never without asking: unchanged. An autonomous merge is `gh pr merge --merge --match-head-commit <run.headSha>` on a repo whose grant he gave; never `--admin`, `--auto` or `--delete-branch`.
- Nothing is written to Beagle's repo except through a PR he merges; the Beagle pin moves only in a commit he approves (Decision 1).
- No loops: the school never creates jobs. `docs/SELF_RECURSION_GUARDRAILS.md` gains the school and autonomy arrows (Task 17).
- Ledger: every school, arena, voyage, training, net, prediction, decision and autonomy event is recorded append-only with kinds from `LEDGER_KINDS`, replays and is compared by `verifyReplay()`.
- The ui-test guard from home is 850 draw calls and 12M triangles with the shadow map redrawn; the campus has its own sub-guard (Decision 17).
- No em dashes, `--` or emojis in UI copy, README, report pages or commit text. No AI look; scores are numbers with their interval and n, never stars or glow; an empty chart is a sentence, never an empty axis.
- Every visible change: build, screenshot at full size and zoomed crops, critique, iterate (three rounds for 3D, two for screens); rounds and what is still weak go in the commit body.
- README media only from the sample dataset.
- Commit trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UGpw98HC7NNMT1jveHzgfa`.

## Test safety rules (Phase 2 rules 1 to 10 hold; these are added)

11. No test spawns the real Python, `mlx_lm.lora`, `mlx_lm.server` or `trainer/school.py`: every spawn goes through `getSpawner()` and tests install fakes. The trainer's own tests are `npm run test:trainer` (Python `unittest` on synthetic data under a temp dir with `HF_HUB_OFFLINE=1`), never part of `npm test`, skipped with a message when no trainer Python is found.
12. No test reads Understudy's real database: the reader opens only `PALIMPSEST_UNDERSTUDY_DB` under a test, refuses the default path the way `home()` does, and tests build fixtures (one in WAL mode).
13. No test imports Beagle with `BEAGLE_HOME` unset or at Beagle's real home: `loadBeagle()` sets it to `paths().school/beagle` and throws if it resolves anywhere else; every test replaces Beagle's driver with a fake and sets `BEAGLE_BACKOFF_MS=0`.
14. No test runs `pmset`, `ioreg`, `df` or `sysctl` for real: the probes go through `getRunner()` and tests answer them with the outputs captured on his Mac (`test/fixtures/pmset/`).
15. No test or route downloads a model.
16. No test runs `gh pr merge`: it goes through `getRunner()` like every `gh` call, and with the real runner on a temp home `githubWriteRefused()` refuses it before any `gh` call.

## Phase 4 rulings on spec gaps

1. **Beagle as a library** (spec 9, 12; Decision 1). `"beagle": "github:AllStreets/beagle#<full 40-hex sha>"`, never a branch or tag; the pin moves only in a commit he approves. Only `engine/school/beagle.ts` imports it, by `import()` of a non-literal specifier (`const spec = 'beagle/' + entry`) typed through `engine/school/beagle-api.ts`, so `tsc` (which checks `.ts` files under `node_modules`, `skipLibCheck` skipping only `.d.ts`) never sees Beagle's sources. `loadBeagle()` sets `BEAGLE_HOME` to `paths().school/beagle`, calls `setDriver(schoolDriver)`, and refuses if Beagle's home resolves outside `paths().school`. While Palimpsest imports Beagle, the repo `AllStreets/beagle` is never asked about or granted any `merge:*` kind (`askDue` skips it), so no city-written code reaches the engine except through a pin he approves.
2. **The Beagle fixes** (spec 9.1; Decision 2). In a fresh `git clone https://github.com/AllStreets/beagle` under the scratchpad (never a worktree of `~/Downloads/beagle`, whose `.git` must not be written), one branch, one PR: (a) `exports` for `./race`, `./designer`, `./genome`, `./stats`, `./runner`, `./arenas`, `./models`, `./store`; (b) `paths` and `store.open()` read `BEAGLE_HOME` on each call and reopen when it changes; (c) `breed(…, { designer?: string })`; (d) `Arena.selfCheck?(answer, input): string` with a generic default replacing the geotag sentence; (e) `compareToParents(voyageId, generation)`: the seeded paired bootstrap of per-task differences on common tasks; (f) `race()` and `breed()` take `signal?: AbortSignal`, an abort leaving ungraded runs unscored and returning `complete: false, reason: 'aborted'`; (g) `mlx:` in `validate()` and `complete()`; (h) `splitOf` re-exported from `./arenas`; (i) the `Driver` provider union gains `'mlx'`; (j) `putArena(id: string, name: string)` and `putTasks(arenaData: string, rows: Array<{ id; input; truth; split: 'breeding' | 'race' | 'sealed' }>)` writing Beagle's `arenas` and `tasks` tables (replacing a task by id); (k) `sealedRace(arenaId: string, genomes: Genome[], o: { signal?: AbortSignal; seed?: number }): Promise<{ hash: string; scores: Score[]; perTask: Record<string, Record<string, number>> }>`: races the genomes on the sealed split outside any voyage, recording its runs under a synthetic voyage `sealed-<n>` per call so a second call scores afresh, and returns the `sealedHash(arenaId)` it used. Beagle's own `npm test` passes with each.
3. **The spend kinds.** `'school'` (model calls for voyages and graduation, Claude or local, and arena builds by wall time) and `'train'` (MLX training and evaluation passes) join `SPEND_KINDS` (`budget.ts`), `CALL_KINDS` (`spend.ts`), the report's call kinds and `charge()`'s union. Rows carry `firm_id NULL` (or the commissioning firm, ruling 22), `run_id` the voyage, net version or LoRA id, and `unattended: unattended(now)` at the call's start, so the night cap (`json.unattended = 1`) sees school spend. Local credits follow Phase 2 ruling 1 with `modelGB` from the model's size.
4. **The school lease.** `acquire(model, 'school', estimate, { waitUntil })` queues FIFO on the school queue behind the same `gate()`. A Claude school lease is a Claude work lease for counting: it holds one of `claudeConcurrency`'s slots (`workCount('claude')` includes it), is refused while `interactiveActive(now)` (the one Claude slot then stays his market's), and is refused once `schoolClaudeSpent(today) + estimate > school.claudeCreditsPerDay`. A local school lease needs `workCount('local') === 0` and holds the local slot: real work always beats the school.
5. **`Provider.complete()`.** One turn, no tools, an optional schema: `complete(i: CompleteInput): Promise<CompleteResult>` on every backend. Claude reuses the no-tool `call()` path in `claude.ts` (empty strict MCP config, `CALL_DENY`, the CLI profile, `CALL_MAX_TURNS` 3, as Phase 2 chose for structured output), with a free-text branch that omits `--json-schema` when `schema` is null; Ollama and the Anthropic API reuse their transports; the fake answers from its script.
6. **The training gate** (Decisions 3 and 4). `gateNow(kind: 'light' | 'heavy', now): Promise<GateState>`. Both kinds need: `school.enabled`; the stop file absent; `pmset -g batt` beginning "Now drawing from 'AC Power'"; the "Currently in use:" `powermode` of `pmset -g` not `1` unless `school.allowLowPower` (a value outside 0, 1, 2 or a missing key fails); the local time inside `school.window` (default 01:00 to 06:00) unless "Train now" is live; no local run live and no `awarded` job whose winning bid is local. `heavy` (LoRA, voyages, arena builds) adds: `HIDIdleTime` at least `school.idleMinutes` (default 15) unless "Train now"; `pmset -g therm` either consisting only of "Note: No … has been recorded" lines (nominal) or naming a thermal or performance warning level of 0, any other level is `limited` and anything unrecognised is `unknown`, both failing; `df -k <home>` at least 20 GB free. "Train now" lasts 3 hours and never skips AC power, power mode, thermals or disk.
7. **The trainer.** `trainer/` in this repo: `requirements.txt` pins `mlx==0.32.4`, `mlx-lm==0.32.2`, `numpy`, `huggingface_hub`; `npm run trainer:setup` (run only by him or on his go-ahead; Decision 5) runs `uv venv --python cpython-3.12-macos-aarch64-none trainer/.venv` and `uv pip install -r trainer/requirements.txt` and checks `arm64`. The engine uses `PALIMPSEST_PYTHON` when set (during development, Beagle's `trainer/.venv/bin/python`, which already has the pinned versions), else `trainer/.venv/bin/python`. `trainer/school.py` is one warm subprocess speaking JSON lines (`ping`, `train_net`, `predict_net`, `lora_train`, `download_base`), started under the trainer profile: `(allow default)`, `(deny network*)` (except loopback bind for the server, ruling 26), `(deny file-write*)` with allows for `paths().school`, its tmp and `/dev/null` after it, `deny file-read*` of `SECRET_PATHS`; the builder check ran MLX on the GPU under exactly this shape. The gate loss path sends SIGTERM, waits 10 s, then SIGKILL.
8. **The nets** (spec 9.3). One-hidden-layer MLP (16 units, exact GELU as MLX's `nn.gelu`, AdamW lr 1e-2, weight decay 1e-2, at most 300 epochs, early stop on the training rows' newest 15%, seed 1), features standardised, exported as JSON `{ net, version, features, norm: { mean; std }, layers: Array<{ W; b }>, out: 'sigmoid' | 'linear' }`. Units, labels and features (lists fixed in `shared/net-features.ts`, unknowns as 0 with a `has_*` mask):
   - **Appraiser:** one row per awarded bid whose run ended; labels `pass` and `cost` (log1p of the run's credits); features: tier, scope globs, acceptance lines, source, language, checks present, price over value, confidence, plan length, workflow shape, model family, capability era, the firm's pass rate and Brier as of the award. Heads `appraiser-pass` and `appraiser-cost`. Unawarded bids are never rows; once the appraiser moves awards its rows are partly self-selected, which the school screen says.
   - **Router:** the same rows without price, confidence and plan; predicts `pass` for a (job, agent) pair.
   - **Durability:** one row per merged city job 30 days after merge, or earlier on a `merge.reverted` or `merge.followup`; label `survived`; features: diff files and lines, tier, model family, checks passed, `preexisting` count, design checked, review concerns, `hisChanges`.
   - **Triage:** one row per item id in each finished day's `brief.opened.items`; label `acted` (a non-dismiss `brief.action` that day); features: item kind, tier, hours since `at`, weekday, first open, section position, the repo's share of his past accepts.
   - **Taste:** one row per inspection with `design` whose job he merged or closed in PR mode, plus one per answered Understudy pair; label `approved`; features: the judge's `after`, `before`, difference, `diffOnly`, shots; for a pair, the local vision judge's two scores.
   - **Master:** one row per resolved decision (ruling 14); label `approved`; features: the five nets' outputs with masks, the kind (one-hot over six), the repo's approval share over its last 20 decisions.
9. **Follow-up fixes.** `watchRevertsFor()` also records `merge.followup { jobId, runId, repo, floorId, mergeSha, fixSha, files, at }` once per floor when, within 14 days after a city merge and by ancestry, a non-city commit (no `Palimpsest-Job:` trailer, not from a `palimpsest/*` branch) whose subject matches `/\bfix(es|ed)?\b/i` touches a file the merge touched. Files come from `engineGit(mirror, ['show', '--name-only', '--format=', sha])` on the mirror, since `recentCommits()` carries none. Never halts, never scars.
10. **Understudy** (Decision 9). `engine/school/understudy.ts` opens the database read-only (`node:sqlite` `readOnly: true`); when that fails on a WAL database whose `-shm` cannot be created, it opens the URI `file:<path>?immutable=1`. Only when `school.understudy` is on; reads `statements` not removed and `pairs` with `pick` in `a` or `b`; never writes or copies images outside `paths().school`. With the switch on the statements join the design judge's bar for every UI inspection (disclosed in Settings and Decision 9). A pair is scored once by the local vision judge under a local school lease and cached.
11. **Evaluation** (spec 9.2). Rows ordered by `at`; the newest 20% (at least 10) held out. A net reports nothing (`status 'thin'`, "n of 40 labels" with its cause, ruling 29) until 30 training rows and 10 held out. Every sigmoid head, the master included, is scored by Brier with a seeded 95% interval from Beagle's `bootstrap()` (10,000 resamples, seed 1), against a baseline (the training rows' base rate; for the appraiser, the firm's pass rate as of the award): `vsBaseline` from `bootstrap()` over per-row differences. A head is `trusted` only when `vsBaseline.hi < 0`. The cost head uses mean absolute error the same way. The master's agreement at 0.5 is reported beside its Brier, never instead. At a skewed base rate (he approves 97% of a kind) the baseline's Brier is near 0.03 and a master that only says "approve" is not trusted, so that kind is never offered; the school screen says so for the kind.
12. **Retraining.** Nightly under the light gate, in the order appraiser, router, durability, triage, taste, master, only nets with new labels. Versions at `paths().school/nets/<net>/v<n>.json`, recorded as `net.trained`; promoted to current only if trusted or the current is not (`net.promoted`).
13. **Distillation** (spec 9.3), only where targets mean the same: Triage on proposal items and Taste on UI merges take the master's `P(approve)` as a soft label (weight 0.3) while under 100 own rows. The master never learns from its own predictions. Held-out rows are always real.
14. **His decisions and kinds** (Decisions 11 and 12). A decision is his and only his:
    - a proposal accepted (`job.changed` from `proposed` to `open`) or dismissed (to `withdrawn` with `withdrawnBy 'him'`);
    - a PR-mode city PR merged by him (`job.changed` to `merged` with the run in `waiting`; `hisChanges` and `mergedWithChanges` approve) or closed by him (the run ended `closed` with `PR_CLOSED_REASON`, exported from `ship.ts` as the text `closed(r)` writes today, "The PR was closed without a merge."); a job settled `closed` because its issue closed is not a decision;
    - a revert (`merge.reverted`), which supersedes an earlier approve of that job as a decline.
    Excluded: every `job.changed` or merge whose key has an `autonomy.acted` row (the city's own act). His later withdrawal of an auto-accepted job, or close of the PR it produced, is a decision with `approved false` and `agreed false`, and suspends that (kind, repo) grant (`autonomy.suspended { reason: 'he undid it' }`). Push-mode merges are not his decisions. `workKind(job, inspection)`: `propose:harness` (source `harness`), `propose:readme-gap` (source `proposal`), `merge:ui` (an inspection with `design`), else `merge:<tier>`. Key `<kind>:<jobId>`.
15. **Prospective predictions.** When a decision becomes pending (a job posted `proposed`; `pr.opened`), `registerPrediction(job, run | null)` records `master.predicted { key, kind, repo, jobId, p, version, reason, at }` once per key; `p` null (an abstention) when the school is off, the master is missing, thin, untrusted, older than 8 days, or an input fails. `decision.resolved { key, kind, repo, jobId, approved, by, predictionId, agreed, at }`; `agreed` null when no prediction was recorded strictly before the decision (never in a window), false for an abstention.
16. **Agreement** (Decision 12). `agreement(kind, repo?)` over the last 50 non-null `agreed` rows of that kind (latest resolution per key); `rate` with its interval; `eligible` needs 50 rows and `rate.value >= 0.95`. Repo test: at least 10 of its rows of that kind, none of its last 10 `agreed false`.
17. **Asks and grants.** The school tick asks once per (kind, repo) when the kind is eligible, the master trusted, the repo passes its test, has a test and a build command, is connected, not halted, market on, is not `AllStreets/beagle` while pinned (ruling 1), and the pair has no open ask, no grant, and no decline or revocation by him younger than 30 days. `autonomy.asked` and a brief item `autonomy:<kind>:<repo>` (`grant`, `decline`, `why`). Only his action grants; he may re-grant a revoked pair from Settings at any time without an ask. Declining or revoking silences the pair for 30 days.
18. **Acting under a grant** (Decision 13). `mayAct(kind, repo, jobId, now)` answers yes only when all hold, read fresh: `school.enabled`; an active grant with no revocation or suspension after it; the stop file absent; the repo connected, market on, not halted, with test and build; `agreement(kind)` still eligible and the repo test passing (else `autonomy.suspended` and a fresh ask); the master current and trusted; a `master.predicted` row for this key with `p >= 0.9` whose version is the current one or no older than `AGREE.staleDays`; for a merge: the inspection `passed` and `pushable`, the PR open, its head equal to `run.headSha`, and a fresh revert read of that repo (`watchRevertsFor(repo, now, { force: true })`: a mirror sync and the revert and follow-up scan past the 30-minute throttle; a failed read refuses; a revert found revokes first). Any throw answers `{ ok: false, reason: 'could not check: …' }`. Acts: `propose:*` through `acceptProposed()`; `merge:*` through `mergePR()`. Each records `autonomy.acted` before and its result after. A `gh pr merge --merge` refused because the repo allows only squash or rebase suspends the pair with that reason.
19. **Revocation by revert** (spec 9.4). A `merge.reverted` whose job has an `autonomy.acted` row revokes that pair (`autonomy.revoked { by: 'revert', jobId }`) in the handler, before the repo halts; it also enters the window as `agreed false`.
20. **Arenas** (spec 9.2; Decision 8). Built only by his click (`POST /api/school/arenas/:owner/:name`, from the district page or Settings), only for a connected repo with the market on and a test command; never by the tick. Two kinds:
    - **Planted bugs:** up to 120 one-line mutants on non-test source lines (flip a comparison, off by one, swap `&&` and `||`, drop a `!`, swap `true` and `false`, return the first argument), each kept only if the suite passes at the head and fails with it; at most 60 kept.
    - **Past changes:** from verified history (ruling 23): changes that touched source and tests, where the task base is the change's parent with the change's test files applied, kept only if those tests fail there and pass at the change; at most 40. A rebase-merged PR whose first parent is not on the default branch before the PR is skipped.
    Split by Beagle's `splitOf(id)` (60, 25, 15), written into Beagle's store with `putArena` and `putTasks` (`Arena.data` is the arena id), so `sealedHash` covers the sealed split. Each task grades in an APFS clone of an arena base whose dependencies were installed once under the install egress; grading has no network. Building is heavy-gated and charged as local `school` credits.
21. **Arena answers and grading.** Answer `{ edits: Array<{ file; find; replace }> }`, each `find` unique, source files only. Grade: apply to a fresh task clone, run the test command under the tool profile, 1 when the targets pass and nothing that passed at base fails, 0.5 when the targets pass and another fails, else 0. Tools: `read_file`, `list_files`, `search`, `run_tests`; `run_tests` makes a fresh scratch clone per call (`ToolSpec.run` gets only `ctx.task`, so racing genomes cannot share one). `graderTimeoutMs` is the repo's `CHECK_MS` (15 minutes) and `maxTurns` 24.
22. **Voyages and commissions** (spec 7.2, 9.2; Decision 15). The tick sails one voyage at a time, on the ready arena least recently voyaged (a commissioned one first): population 8, 4 generations, local models only, Beagle `concurrency 1`, the designer per Decision 10 seeing only breeding-split tasks, children kept only with `compareToParents().lo > 0`. About 500 tool-using runs per voyage at 60 kept tasks: **a voyage spans several nights**; a gate loss aborts through the signal and the next night calls `race()` again, which skips runs already stored, so it resumes per run. The champion is scored once by `sealedRace()` against every seeded **local** agent on the same sealed tasks; with `lo > 0` against each it joins the roster (`lineage.origin 'school'`). Claude agents are not compared and the screen says so. A firm with at least 400 credits and an idle agent may commission a voyage on a ready arena of a repo it has a floor on: 120 credits move from the firm to the city (`credits.moved`, `voyage.commissioned`), at most one commissioned voyage live, and that firm has first refusal on its champion for 7 days.
23. **Verified history** (Decision 7). `verifiedChanges(repo, now)`: the city's merges that passed inspection and survived 30 days; his merged PRs never reverted; and, with Decision 7's yes, his direct commits on the default branch that touch source, are 30 days old, have no revert or follow-up fix, and (where a suite exists) whose tests pass at the commit when the school checks them under the tool profile (cached by sha). LoRA examples: chat in the arena's shape, assistant answer the edits built from the change's hunks, excluding any change in a sealed split, files over 24 KB, examples over 4,096 tokens. Training needs `LORA.min` 100 examples.
24. **LoRA training** (Decision 6). Base `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`, `--fine-tune-type lora --num-layers 16 --batch-size 2 --iters 600 --learning-rate 1e-5 --max-seq-length 4096 --mask-prompt --grad-checkpoint --save-every 50 --adapter-path <dir>`, heavy gate. The checkpoint is `<dir>/adapters.safetensors` (rewritten at each save, with `<step>_adapters.safetensors` beside it). A resume passes `--resume-adapter-file <dir>/adapters.safetensors` and `--iters` the remaining steps; it loads weights only, so the optimiser state and the batch order restart; the run records `optimizerReset: true` and the steps lost. A resumed run is not equivalent to an uninterrupted one and the card says so.
25. **Graduation** (spec 9.2). An adapter is scored by one `sealedRace()` per arena whose sealed tasks its data excluded, as the adapter genome against the base genome (same single-shape instructions); it graduates only if the paired difference over all those tasks has `lo > 0`. Each `sealedRace` adds one sealed use to that arena; after `SEALED_USES` (10) the arena's sealed split is spent: no further graduation or champion claim on it until he rebuilds the arena (a fresh split, a new `sealed_hash`), and the screen shows the use count. A graduate becomes `mlx:grad-<base short>-<n>`, a roster agent with root `collegiate`, `lineage.origin 'school'`.
26. **The `mlx` backend.** A warm `mlx_lm.server --model <base> --adapter-path <dir> --host 127.0.0.1 --port <free>` under the trainer profile with loopback bind only, one at a time, stopped after 10 idle minutes; OpenAI chat transport with tool calls; `poolOfModel('mlx:…')` is `local`.
27. **The university plot** (Decision 16). `ensureCampus()` takes `nextSlot('campus', 'university')` at the Phase 4 engine's first start (Task 1); the campus is that one 240 m block on a terrace 6 m up. Nothing moves.
28. **Commuting to school** (spec 6.4). A seeded or roster agent whose genome is a parent in a live voyage takes a trip with reason `school` to the campus and home when it ends or pauses for the night; a graduate's first trip goes from the campus to its firm's quarter.
29. **Honest empty states.** Every card that has nothing says why, from data: appraiser and router "No bid has been run: the market is off on every repo" (or "n of 40 awarded runs ended"); durability "No city merge has had 30 days yet"; triage "n finished brief days so far"; taste "No UI change has been inspected yet; Understudy has 37 statements and 0 answered pairs" (counts read live); master "None of your decisions has had a prediction yet"; LoRA "11 of 100 verified changes" (counted by `verifiedChanges`), or "Download the base model first"; arenas "No arena: build one from a market-on repo's page"; the trainer "Not set up on this Mac". A chart with fewer than two points is a sentence, never an axis.

## Review Focus

1. He unplugs the Mac at 02:10 during a LoRA run, or wakes it and starts typing: within 30 s the trainer is stopped, `train.paused` records the reason and the steps lost, no half-trained adapter is evaluated, and the next eligible night resumes from `adapters.safetensors` with the remaining steps and `optimizerReset: true` recorded. (Tasks 6, 7 and 25.)
2. A revert of an autonomous merge is pushed a minute before the next autonomous merge on that kind and repo: the second merge's own fresh revert read finds it, revokes the grant, refuses, and the repo halts. (Tasks 16 and 17.)
3. The master is missing, its weights are corrupt, it is 9 days old, the school is off, the trainer is absent, or one small net throws: every prediction abstains, every abstention counts against agreement, no ask is made and no action runs, and the screen names the reason. (Tasks 12, 13, 14 and 16.)
4. A decision seen before any prediction existed (the engine was down), the city's own auto-accept or auto-merge, or a job closed because its issue closed: none of them enters an agreement window; his undoing of an autonomous act does, as a disagreement. (Tasks 14 and 15.)
5. A sealed task's change appears among the LoRA examples, the designer's evidence or the breeding split, or a sealed split is used an eleventh time: it is excluded, or the claim is refused with "sealed set spent", and a test names it. (Tasks 20, 21, 24 and 27.)

---

## File Structure

```
shared/types.ts                 + NetName, NetCard, NetStatus, NetVersion, Interval, WorkKind, Prediction, Decision, Agreement, Grant, GrantState,
                                  GateState, TrainKind, TrainState, ArenaInfo, VoyageView, Graduate, SchoolSettings; RootStyle + 'collegiate';
                                  TripReason + 'school'; BriefItemKind + 'autonomy' | 'graduate' | 'acted'; BriefAction + 'grant' | 'decline' | 'revoke'
shared/ledger-kinds.ts          + school.enabled, arena.built, voyage.*, train.*, net.*, master.predicted, decision.resolved, autonomy.*, graduate.made, merge.followup
shared/school-rules.ts          pure: WORK_KINDS, workKind(), itemKey(), AGREE, NET_MIN, GATE, LORA, ARENA, VOYAGE, SEALED_USES, COMMISSION, inWindow()
shared/net-features.ts          pure: feature lists and encoders
shared/nets.ts                  pure: parseNet(), forward(), erf()
engine/home.ts                  + paths().school
engine/db.ts                    + school tables
engine/market/provider.ts       + CompleteInput, CompleteResult, Provider.complete
engine/market/{claude,ollama,anthropic-api,fake-provider}.ts   + complete()
engine/market/mlx.ts            the mlx backend
engine/market/providers.ts      + 'mlx'
engine/market/budget.ts         + kinds, the school lease, liveWork(), creditEntries(), schoolClaudeSpent()
engine/market/{spend,report,replay}.ts
engine/market/ship.ts           + PR_CLOSED_REASON, watchRevertsFor(), merge.followup, registerPrediction, revokeOnRevert
engine/market/jobs.ts           + registerPrediction on proposed jobs
engine/market/firms.ts          + school roster, commissions, graduates
engine/github.ts                + mergePR()
engine/school/{beagle-api,beagle,stats,trainer-env,gate,trainer,understudy,datasets,nets,decisions,autonomy,
               history,mutants,arenas,voyages,roster,lora,campus,tick,api}.ts
trainer/requirements.txt, school.py, nets.py, test_school.py, README.md
app/src/api.ts, router.ts
app/src/ui/school.ts, school-words.ts, autonomy.ts, settings.ts, repo.ts, brief.ts, brief-words.ts, job.ts, agent.ts, treasury.ts
app/src/city/campus/{index,site,halls,library,clock,observatory,life}.ts, app/src/city/breakdown.ts, app/src/city/tower/*
tools/ui-test-school.ts, tools/ui-test.ts, tools/capture.ts
test/fixtures/pmset/*.txt, test/fixtures/net-parity.json, test/*.test.ts
```

## Pre-flight conflict table

| Tasks | Shared | Resolution |
|---|---|---|
| 1, all | types, kinds, spend kinds, `Settings.school`, tables, the campus plot | Task 1 freezes them |
| 2, 4, 21, 22, 27 | Beagle's API and store | Task 2 lands in Beagle; Task 4 imports ruling 1's list; Task 21 writes tasks with `putTasks`; Tasks 22 and 27 race through `race()` and `sealedRace()` |
| 3, 4, 26 | `Provider.complete` | Task 3 on four backends; Task 26 adds the fifth |
| 4, 22, 27 | `schoolDriver` | every Beagle model call goes through it |
| 6, all trainers | `gateNow()` | only Task 6 reads probes |
| 8, 11, 12, 14 | rows, weights, `predict()` | in that order |
| 14 to 17 | predictions, decisions, grants | 14 writes predictions, 15 decisions, 16 grants and `mayAct`, 17 acts |
| 17, Phase 2 `ship.ts` | the revert handler | Task 9 extracts `watchRevertsFor()`; Task 17 calls `revokeOnRevert()` in it before `haltRepo()` |
| 18, 20, 24 | verified history | Task 18 produces `verifiedChanges()`; 20 and 24 consume it |
| 28, 30 to 33 | the `api` client | screens call only what Task 28 added (and Task 1's campus route) |
| 29, 30 to 38 | the sample school | `seedSchool()` inside `seedEconomy()` |
| 34 to 38, Phase 3 city | `scene.ts`, `breakdown.ts`, the perf guard | the campus is its own group with its own `breakdown()` key; tower builders change only in Task 38 |

Known orderings: Task 1 first; Task 2 merged by him before Task 4; Task 3 before Task 4; Tasks 5 and 6 before Task 7; Task 7 before Tasks 11, 25 and 27; Tasks 8, 9 and 10 before Task 11; Task 9 before Task 17; Tasks 11 and 12 before 13 and 14; 14, 15, 16, 17 in order; Task 18 before Tasks 20 and 24; Tasks 19 and 20 before 21; Task 21 before 22; Task 22 before 23; Tasks 24 and 25 before 27; Task 26 before 27; Task 28 after Tasks 12 to 27; Task 29 before every UI test; the city track starts after Task 1 (the campus plot and `/api/school/campus`), Task 37 needs Task 28's events; both tracks merged before Tasks 39 to 41.

## Model marks

**[Opus]** for every task but Tasks 28, 32 and 33, which are **[Sonnet]** with a full brief. Reviews of logic and visual work go to Opus.

---

## Part A: foundations (screens track)

### Task 1: Types, ledger kinds, spend kinds, settings, tables, replay and the campus plot [Opus] [screens]

**Files:**
- Modify: `shared/types.ts`, `shared/ledger-kinds.ts`, `engine/home.ts`, `engine/db.ts`, `engine/settings.ts`, `engine/repos.ts` (`nextSlot` kind union gains `'campus'`), `engine/main.ts` (`ensureCampus()` at start), `engine/market/budget.ts`, `engine/market/spend.ts`, `engine/market/report.ts`, `engine/market/replay.ts`, `engine/market/api.ts` (mounts `GET /api/school/campus`)
- Create: `shared/school-rules.ts`, `engine/school/campus.ts`
- Test: `test/market-types.test.ts`, `test/school-rules.test.ts`, `test/db.test.ts`, `test/replay.test.ts`, `test/budget.test.ts`, `test/spend.test.ts`, `test/home.test.ts`, `test/campus-plot.test.ts`

**Interfaces:**
- Produces (`shared/types.ts`):
  ```ts
  export type NetName = 'appraiser-pass' | 'appraiser-cost' | 'router' | 'durability' | 'triage' | 'taste' | 'master';
  export type NetStatus = 'thin' | 'untrained' | 'trained' | 'trusted';
  export interface Interval { value: number; lo: number; hi: number; n: number }
  export interface NetVersion { net: NetName; version: number; at: string; rows: { train: number; heldOut: number; distilled: number };
    metric: 'brier' | 'mae'; score: Interval; baseline: Interval; vsBaseline: { diff: number; lo: number; hi: number };
    agreement: Interval | null; trusted: boolean; current: boolean; seconds: number; path: string }
  export interface NetCard { net: NetName; status: NetStatus; reason: string | null; cause: string | null; current: Omit<NetVersion, 'path'> | null;
    history: Array<Pick<NetVersion, 'version' | 'at' | 'score' | 'trusted'>>; labels: number; needs: number; selfSelected: boolean }
  export type WorkKind = 'propose:harness' | 'propose:readme-gap' | 'merge:low' | 'merge:normal' | 'merge:high' | 'merge:ui';
  export interface Prediction { id: number; key: string; kind: WorkKind; repo: string; jobId: string; p: number | null; version: number | null; reason: string | null; at: string }
  export interface Decision { key: string; kind: WorkKind; repo: string; jobId: string; approved: boolean;
    by: 'accept' | 'dismiss' | 'merge' | 'close' | 'revert' | 'undo'; predictionId: number | null; agreed: boolean | null; at: string }
  export interface Agreement { kind: WorkKind; repo: string | null; rows: number; agreed: number; rate: Interval | null; eligible: boolean; repoOk: boolean | null; skewed: boolean }
  export type GrantState = 'asked' | 'granted' | 'declined' | 'suspended' | 'revoked';
  export interface Grant { kind: WorkKind; repo: string; state: GrantState; at: string; by: 'him' | 'revert' | 'school'; rate: Interval | null; reason: string | null; acted: number; quietUntil: string | null }
  export interface GateState { kind: 'light' | 'heavy'; ok: boolean; reason: string | null; power: 'ac' | 'battery' | 'unknown'; powerMode: 0 | 1 | 2 | null;
    idleMin: number | null; inWindow: boolean; trainNowUntil: string | null; freeGB: number | null; thermal: 'nominal' | 'limited' | 'unknown' }
  export type TrainKind = 'nets' | 'lora' | 'arena' | 'voyage' | 'eval';
  export interface TrainState { id: string; kind: TrainKind; status: 'waiting' | 'running' | 'paused' | 'done' | 'failed'; reason: string | null;
    startedAt: string; endedAt: string | null; seconds: number; steps: { done: number; of: number; lost: number; optimizerReset: boolean } | null; credits: number }
  export interface ArenaInfo { id: string; repo: string; kind: 'planted' | 'past'; sha: string; tasks: { breeding: number; race: number; sealed: number };
    candidates: number; kept: number; sealedUses: number; sealedHash: string | null; builtAt: string; status: 'building' | 'paused' | 'ready' | 'failed' | 'spent'; reason: string | null }
  export interface VoyageView { id: string; arena: string; status: 'sailing' | 'paused' | 'done' | 'capped' | 'failed'; generation: number; of: number;
    runs: { done: number; of: number }; commissionedBy: string | null;
    scores: Array<{ genome: string; name: string; generation: number; mean: number; lo: number; hi: number; parents: string[] }>;
    promoted: Array<{ child: string; parent: string; diff: number; lo: number; hi: number }>; sealed: Interval | null; credits: number; startedAt: string; endedAt: string | null }
  export interface Graduate { id: string; model: ModelRef; base: string; loraId: string; sealed: Interval; baseSealed: Interval;
    vsBase: { diff: number; lo: number; hi: number }; examples: number; arenas: string[]; at: string; agentId: string | null }
  export interface SchoolSettings { enabled: boolean; window: { from: string; to: string }; idleMinutes: number; allowLowPower: boolean; trainNowUntil: string | null;
    claudeCreditsPerDay: number; designer: ModelRef; understudy: boolean; commitsAsWork: boolean; baseModel: string; baseModelReady: boolean }
  // RootStyle + 'collegiate'; TripReason + 'school'; BriefItemKind + 'autonomy' | 'graduate' | 'acted'; BriefAction + 'grant' | 'decline' | 'revoke'.
  // Settings + school: enabled false, window 01:00 to 06:00, idleMinutes 15, allowLowPower (Decision 3's answer; true as written), trainNowUntil null,
  //   claudeCreditsPerDay 30, designer 'claude:sonnet', understudy false, commitsAsWork (Decision 7's answer; true as written),
  //   baseModel 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', baseModelReady false.
  ```
- Produces (`shared/school-rules.ts`): `WORK_KINDS`, `workKind()`, `itemKey(kind, jobId)`, `AGREE = { window: 50, rate: 0.95, repoMin: 10, repoLast: 10, actP: 0.9, quietDays: 30, staleDays: 8 }`, `NET_MIN = { train: 30, heldOut: 10 }`, `HELD_OUT = 0.2`, `DISTIL = { weight: 0.3, under: 100 }`, `GATE = { pollMs: 30_000, minFreeGB: 20, trainNowHours: 3, killGraceMs: 10_000 }`, `LORA = { min: 100, iters: 600, saveEvery: 50, layers: 16, batch: 2, lr: 1e-5, maxSeq: 4096, maxFileBytes: 24_000, gb: 4.3 }`, `ARENA = { mutants: 120, keepPlanted: 60, keepPast: 40, maxTurns: 24 }`, `VOYAGE = { population: 8, generations: 4, concurrency: 1 }`, `SEALED_USES = 10`, `COMMISSION = { fee: 120, minBalance: 400, firstRefusalDays: 7 }`, `FOLLOWUP_DAYS = 14`, `SURVIVE_DAYS = 30`, `inWindow(window, now)`.
- Produces (`shared/ledger-kinds.ts`): `school.enabled`, `arena.built`, `voyage.started`, `voyage.commissioned`, `voyage.generation`, `voyage.ended`, `train.started`, `train.paused`, `train.ended`, `net.trained`, `net.promoted`, `master.predicted`, `decision.resolved`, `autonomy.asked`, `autonomy.granted`, `autonomy.declined`, `autonomy.suspended`, `autonomy.revoked`, `autonomy.acted`, `graduate.made`, `merge.followup`.
- Produces (`engine/db.ts`): `nets (net, version, at, current, json; PK (net, version))`; `predictions (id INTEGER PRIMARY KEY, key TEXT UNIQUE, kind, repo, at, json)`; `decisions (key, at, kind, repo, json)` indexed `(kind, at)`; `grants (kind, repo, state, at, json; PK (kind, repo))`; `arenas (id PK, repo, json)`; `arena_tasks (id PK, arena, split, ref, json)`; `voyages (id PK, json)`; `trains (id PK, kind, status, json)`; `graduates (id PK, json)`; `verified (repo, sha, json; PK (repo, sha))`.
- Produces (`engine/market/budget.ts`): the kinds; `charge()` union; `acquire(model, 'plan' | 'work' | 'school', …)` (ruling 4); `schoolClaudeSpent(day)`; `liveWork(pool): number` and `creditEntries(runId)` exported. `spend.ts`, `report.ts` gain the kinds.
- Produces (`engine/market/replay.ts`): `MarketState` gains `nets`, `predictions`, `decisions`, `grants`, `arenas`, `voyages`, `trains`, `graduates`; `verifyReplay()` compares each.
- Produces (`engine/school/campus.ts`): `ensureCampus(): number`, `campusOrigin(): { x: number; z: number }`; route `GET /api/school/campus` -> `{ origin; slot; live: { voyage: boolean; nets: boolean; lora: boolean } }` (all false until later tasks fill them).
- [ ] **Step 1: Write the failing tests:** `inWindow handles 01:00 to 06:00 and 22:00 to 04:00`; `paths().school creates its subdirectories under the temp home`; `the db has the ten school tables`; `a school charge made unattended counts in the night cap, the five-hour window and citySpent`; `a train charge on an mlx model never enters the Claude window`; `a train charge appears under the city's own calls in the spend tables and the report`; `acquire school on claude takes a Claude work slot, so a second market Claude run is busy at claudeConcurrency 2`; `acquire school on claude is refused while his interactive use is active`; `acquire school on claude refuses past claudeCreditsPerDay`; `acquire school on local is refused while a local run holds a work lease`; `replay rebuilds each school table and verifyReplay flags a corrupted grant row`; `ensureCampus takes the next slot once, the same slot again on restart, and moves no district`; `GET /api/school/campus answers the origin of that slot`; pin: `poolOfModel('mlx:grad-x') is local`.
- [ ] **Step 2:** Run `npm test` and `npm run typecheck`; expect FAIL on the new tests.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Lay the Phase 4 types: the school's tables, spend, lease and ledger, and the university's plot`.

### Task 2: Beagle's library fixes, as one PR on Beagle [Opus] [screens]

**Files (in a fresh `git clone https://github.com/AllStreets/beagle` under the scratchpad, branch `palimpsest-library`; `~/Downloads/beagle` is never touched):**
- Modify: `package.json`, `src/paths.ts`, `src/store.ts`, `src/designer.ts`, `src/runner.ts`, `src/race.ts`, `src/genome.ts`, `src/models/index.ts`, `src/arenas/index.ts`, `src/arenas/types.ts`, `README.md`
- Test: Beagle's tests (new files where missing)

**Interfaces:**
- Produces (Beagle, ruling 2 (a) to (k)).
- [ ] **Step 1: Write the failing tests in the clone:** `a genome on mlx:grad-1 validates`; `complete passes mlx to the driver`; `the self-check turn of a fix-test genome does not mention where anything happened`; `breed uses the designer it is given`; `an aborted race scores no unfinished run and says aborted`; `compareToParents gives lo above zero for a child better on every common task and spans zero for a tie`; `paths follow BEAGLE_HOME changed between calls`; `splitOf is importable from ./arenas`; `putTasks writes tasks a race then reads, and sealedHash changes when a sealed task changes`; `sealedRace scores two genomes on the sealed split outside any voyage, and a second call scores afresh`.
- [ ] **Step 2:** Run `npm test` in the clone; expect FAIL.
- [ ] **Step 3:** Implement in Beagle's style; its existing tests stay green.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck` in the clone; expect PASS.
- [ ] **Step 5:** Commit in the clone `Let Palimpsest import Beagle: a package entry, a home read on each call, a store it can write tasks to, a sealed race outside a voyage, the designer and an abort as options, a self-check any arena can word, parent against child in the engine, and mlx models`. With his go-ahead push the branch and open the PR on `AllStreets/beagle`; stop. After he merges, record the full merge sha in the controller's ledger for Task 4.

### Task 3: Provider.complete on the four backends [Opus] [screens]

**Files:**
- Modify: `engine/market/provider.ts`, `engine/market/claude.ts`, `engine/market/ollama.ts`, `engine/market/anthropic-api.ts`, `engine/market/fake-provider.ts`
- Test: `test/claude-provider.test.ts`, `test/ollama.test.ts`, `test/anthropic-api.test.ts`, `test/fake-provider.test.ts`

**Interfaces:**
- Produces (`provider.ts`):
  ```ts
  export interface CompleteInput { model: ModelRef; system: string; turns: Array<{ role: 'user' | 'assistant'; content: string }>;
    schema: object | null; signal: AbortSignal; maxMs: number }
  export interface CompleteResult { text: string; json: unknown | null; usage: Usage }
  // Provider: + complete(i: CompleteInput): Promise<CompleteResult>;
  ```
- Produces: `claude.ts` `complete()` through `call()` with `CALL_MAX_TURNS`, a schema-less branch without `--json-schema`, multi-turn folded into one message as Beagle's `models/claude.ts` does; `ollama.ts`, `anthropic-api.ts` `complete()`; `FakeScript.complete?` (default `{ "edits": [] }` with a schema, `"ok"` without).
- [ ] **Step 1: Write the failing tests:** `claude complete with a schema builds the no-tool argv with the CLI profile, --max-turns 3 and --json-schema and reads structured_output`; `claude complete without a schema omits --json-schema and returns the result text`; `claude complete aborts on the signal within 5 s`; `ollama complete returns the text and its seconds`; `anthropic complete charges dollars`; `the fake complete answers by its script`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; plan, review, judge and audit tests still pass.
- [ ] **Step 5:** Commit `Give every backend a single-turn completion the school can meter`.

### Task 4: Beagle as a library, with every call through the caps [Opus] [screens]

**Files:**
- Create: `engine/school/beagle-api.ts`, `engine/school/beagle.ts`, `engine/school/stats.ts`
- Modify: `package.json` (`"beagle": "github:AllStreets/beagle#<full sha from Task 2>"`), `CREDITS.md`
- Test: `test/school-beagle.test.ts`, `test/school-stats.test.ts`

**Interfaces:**
- Consumes: `Provider.complete` (Task 3); `acquire(…, 'school')`, `charge`, `unattended()` (Task 1, `budget.ts`); Beagle (Task 2).
- Produces (`beagle.ts`): `loadBeagle(): Promise<BeagleApi>` (ruling 1); `schoolDriver(o: { voyageId: string | null; designer: ModelRef; firmId: string | null; signal: AbortSignal; now?: () => number })`: maps Beagle's designer name to `o.designer`, leases `acquire(model, 'school', estimate, { waitUntil: now + 10 min })`, calls `providerFor(model).complete()`, charges `kind 'school'` with `unattended: unattended(now)` and the firm when commissioned, throws Beagle's `LimitError` on a cap refusal (Beagle backs off, then ends the race "Claude usage limit") and an abort on the signal.
- Produces (`stats.ts`): `ci(values, seed = 1): Interval`, `pairedCi(a, b, seed = 1): { diff; lo; hi }` over Beagle's `bootstrap()`.
- [ ] **Step 1: Write the failing tests:** `loadBeagle sets BEAGLE_HOME under the temp school and throws when it points at Beagle's real home`; `tsc does not check Beagle's sources` (`npm run typecheck` passes with the dependency installed); `a designer call goes to the designer setting and is charged as school`; `a school Claude call past claudeCreditsPerDay throws LimitError and charges nothing`; `a school Claude call while he is active throws LimitError`; `a school call during the hard stop is refused`; `a school call at night is charged unattended and counts in the night cap`; `an aborted driver call leaves Beagle's race incomplete`; `ci is seeded and stable`; `pairedCi of a better child has lo above zero`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Import Beagle's engine as a library whose every model call goes through the city's caps`.

### Task 5: The trainer environment [Opus] [screens]

**Files:**
- Create: `trainer/requirements.txt`, `trainer/school.py` (`ping` and the JSON line loop), `trainer/test_school.py`, `trainer/README.md`, `engine/school/trainer-env.ts`
- Modify: `package.json` (`trainer:setup`, `test:trainer`), `.gitignore` (`trainer/.venv`)
- Test: `test/trainer-env.test.ts`

**Interfaces:**
- Produces: `trainerPython(): string | null` (`PALIMPSEST_PYTHON` or `trainer/.venv/bin/python` when it exists); `trainerStatus(): Promise<{ ready; reason; python; arch; mlx; mlxLm }>` (reasons: "The trainer is not set up on this Mac", "The trainer's Python is not arm64", "mlx is not installed in the trainer"). `test:trainer` uses `trainerPython()` or prints "Skipped: no trainer Python".
- [ ] **Step 1: Write the failing tests:** `trainerStatus is not ready without a python and says so`; `it refuses x86_64`; `it is ready for arm64 with mlx 0.32.4 and mlx_lm 0.32.2` (fake runner); Python: `ping answers pong with the versions`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Develop and run `npm run test:trainer` with `PALIMPSEST_PYTHON=~/Downloads/beagle/trainer/.venv/bin/python` (read-only use of Beagle's venv with `PYTHONDONTWRITEBYTECODE=1`, so nothing is installed or written into it). Do not run `npm run trainer:setup` without his go-ahead (Decision 5).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Give the school a native MLX environment, set up only when he says`.

### Task 6: The training gate [Opus] [screens]

**Files:**
- Create: `engine/school/gate.ts`, `test/fixtures/pmset/` (`g-ac-lowpower.txt`, `custom.txt`, `therm-none.txt`, `batt-ac.txt`, plus hand-made `batt-battery.txt`, `g-automatic.txt`, `therm-warning.txt`, `g-nokey.txt`)
- Test: `test/school-gate.test.ts`

**Interfaces:**
- Consumes: `getRunner()`, `paths().stop`, `liveWork(pool)` (Task 1), `listJobs({ status: ['awarded'] })`, `bidById`, `getSettings().school`, `inWindow`, `GATE`.
- Produces: `parseBatt(text): 'ac' | 'battery' | 'unknown'`, `parsePowerMode(text): 0 | 1 | 2 | null` (the `powermode` under "Currently in use:"), `parseTherm(text): 'nominal' | 'limited' | 'unknown'` (ruling 6), `parseIdle(text): number | null`, `parseFreeGB(text): number | null`; `gateNow(kind, now): Promise<GateState>` (probes cached 10 s); `startTrainNow(now)` (refused on battery), `stopTrainNow()`.
- [ ] **Step 0:** Capture `pmset -g`, `pmset -g custom`, `pmset -g therm`, `pmset -g batt` on his Mac (read-only) into the fixtures above, unedited.
- [ ] **Step 1: Write the failing tests** (the captured fixtures): `the captured pmset -g reads power mode 1`; `the captured therm notes read nominal`; `a warning level of 2 reads limited and an unknown line unknown`; `a pmset -g without powermode fails the gate with "could not read the power mode"`; `on AC in Low Power the gate holds with allowLowPower and fails without it`; `on battery it fails with "on battery", and Train now cannot open it`; `outside the window it fails, and Train now opens it for 3 hours`; `heavy needs 15 idle minutes and light does not`; `limited or unknown thermals fail heavy`; `19 GB free fails heavy`; `a live or awarded local job fails both`; `the stop file and school.enabled false fail both`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Let the Mac train only on power, idle, at night and cool, read the way macOS 26 says it, and say why not`.

### Task 7: The trainer process, its sandbox, its charge and the pause [Opus] [screens]

**Files:**
- Create: `engine/school/trainer.ts`
- Modify: `engine/market/sandbox.ts` (`trainerProfile`), `trainer/school.py` (`sleep` test command, SIGTERM note)
- Test: `test/school-trainer.test.ts`, `test/sandbox.test.ts`, `trainer/test_school.py`

**Interfaces:**
- Consumes: `trainerPython()`, `gateNow()`, `getSpawner()`, `wrap()`, `SECRET_PATHS`, `charge()`.
- Produces: `trainerProfile(o: { school: string; tmp: string; bindPort?: number }): string` (ruling 7); `startTrain(o: { kind; gate; command: object; gb: number; onLine; now? }): Promise<TrainState>` (records `train.started`; spawns `school.py` under the profile with `HF_HUB_OFFLINE=1`; polls `gateNow` every 30 s and `school.enabled`; on failure SIGTERM, SIGKILL after 10 s, `train.paused { reason, steps.lost }`; on exit charges `kind 'train'` for the wall seconds at `gb`; `train.ended`); `pauseAll(reason)`; `liveTrains()`; `failInterruptedTrains()`.
- [ ] **Step 1: Write the failing tests** (fake spawner and gate): `a train starts only when the gate holds`; `a failing gate sends SIGTERM within 30 s and SIGKILL 10 s later and pauses with the reason`; `turning the school off pauses a live train`; `a paused train charges its seconds as train credits`; `the argv is wrapped in the trainer profile with HF_HUB_OFFLINE=1 and no API keys`; `the profile denies network and writes outside the school and reads of ~/.ssh` (text); `a running train at engine start is paused`; Python: `school.py on SIGTERM writes its last step and exits 0`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. On his Mac, run `school.py ping` under the real profile with `PALIMPSEST_PYTHON` at Beagle's venv and record `Device(gpu, 0)` in the commit body.
- [ ] **Step 5:** Commit `Run the trainer fenced in, charged by the minute, and stop it when the gate closes`.

### Task 8: The nets' rows from the ledger [Opus] [screens]

**Files:**
- Create: `shared/net-features.ts`, `engine/school/datasets.ts`
- Test: `test/net-features.test.ts`, `test/school-datasets.test.ts`

**Interfaces:**
- Consumes: `query()`, `reputation(firmId, log)`, `listJobs`, `listRuns`, `bidById`, `agent`, `creditEntries(runId)` (Task 1), `getRepo`, `inspection.done`, `merge.reverted`, `merge.followup` (Task 9; empty until it lands), `brief.opened`, `brief.action`, `decision.resolved` (Task 15; empty until it lands), `understudyPairs()` (Task 10; injected).
- Produces: `FEATURES`, `encode(net, raw)`; `Row = { id; at; x: number[]; y: number; weight: number; source: 'real' | 'distilled' }`; `rowsFor(net, now): Row[]` (ruling 8); `labelCounts(now)`; `thinCause(net, now): string` (ruling 29, from live counts: repos with the market on, awarded runs ended, merges 30 days old, finished brief days, inspected UI changes, Understudy counts, predicted decisions).
- [ ] **Step 1: Write the failing tests:** `an awarded bid whose run passed is one appraiser row with pass 1 and log1p of its credits`; `an unawarded bid is never a row`; `the firm's pass rate in a row is the one before the award`; `a merge 10 days old with no revert is not a durability row; at 31 days it is; a revert at day 3 makes it survived 0`; `a finished brief day with three items and one accepted gives three triage rows`; `a UI inspection whose PR he closed gives a taste row with approved 0`; `encode one-hots a tier and masks nulls`; `on an empty ledger with every market off thinCause for the appraiser says the market is off on every repo`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Read each net's labelled rows from what actually happened, and why there are none`.

### Task 9: Follow-up fixes and a revert read per repo [Opus] [screens]

**Files:**
- Modify: `engine/market/ship.ts` (`watchReverts()` loops over a new `watchRevertsFor()`; `PR_CLOSED_REASON` exported), `engine/market/replay.ts`
- Test: `test/ship.test.ts`

**Interfaces:**
- Consumes: `recentCommits()`, `engineGit` on the mirror, `earnedFloors`, `JOB_TRAILER`, `CITY_BRANCH`.
- Produces: `watchRevertsFor(repo: Repo, now, o: { force?: boolean } = {}): Promise<{ ok: boolean; reverted: string[]; reason: string | null }>` (the per-repo body of today's watch; `force` bypasses `REVERT_WATCH_MS` and syncs the mirror; `ok false` when the read fails); `followupOf(commits, filesOf: (sha) => Promise<string[]>, mergeSha, files, mergedAt, now)` (ruling 9); `merge.followup` once per floor; `PR_CLOSED_REASON`.
- [ ] **Step 1: Write the failing tests:** `a non-city fix touching a merged file within 14 days records merge.followup once, with files read by show --name-only`; `a city commit, a late commit, other files and a subject without fix are ignored`; `watchRevertsFor with force reads a repo inside the 30-minute throttle`; `a failed mirror read answers ok false`; `replay keeps follow-ups`; pin: `a follow-up neither halts the repo nor scars`.
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement; `watchReverts()` behaves as before.
- [ ] **Step 4:** Run; expect PASS; the Phase 2 revert tests still pass.
- [ ] **Step 5:** Commit `Notice fixes that followed a city merge, and let one repo be read for reverts on demand`.

### Task 10: The Understudy reader [Opus] [screens]

**Files:**
- Create: `engine/school/understudy.ts`
- Modify: `engine/guild/design.ts` (the judge input carries `bible: string[]` when `school.understudy` is on)
- Test: `test/understudy.test.ts`, `test/design.test.ts`

**Interfaces:**
- Produces: `understudyDb()`, `understudyStatements()`, `understudyPairs()`, `understudyCounts(): { statements; pairs; answered }`, `scorePair(pair)` (ruling 10); empty when the switch is off.
- [ ] **Step 1: Write the failing tests** (fixtures with Understudy's schema, one in WAL mode with no `-shm` writable): `statements come back without removed ones`; `pairs without a pick or with neither are skipped`; `a WAL database opens through immutable when readOnly fails`; `a write through the reader throws`; `with the switch off nothing is read`; `under a test the default path throws`; `the judge input carries the bible only with the switch on`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Read his taste statements and picks from Understudy, read only and only when he says so`.

### Task 11: Training a net in MLX and running it in TypeScript [Opus] [screens]

**Files:**
- Create: `trainer/nets.py`, `shared/nets.ts`, `test/fixtures/net-parity.json`
- Modify: `trainer/school.py` (`train_net`, `predict_net`), `trainer/test_school.py`
- Test: `test/nets-forward.test.ts`

**Interfaces:**
- Produces (`trainer/nets.py`): `train_net({ net, rows_path, out_path, seed })` and `predict_net({ weights_path, x })` (ruling 8, `nn.gelu`, never `nn.gelu_approx`).
- Produces (`shared/nets.ts`): `parseNet(text): NetWeights | null` (refuses wrong shapes and non-finite numbers); `erf(x)` accurate to 1e-9; `forward(net, x): number` (standardise, linear, GELU `0.5 x (1 + erf(x / sqrt 2))`, linear, sigmoid or identity).
- [ ] **Step 1: Write the failing tests:** TS: `parseNet refuses NaN, a missing layer and a size mismatch`; `erf matches tabulated values to 1e-9`; `forward matches a hand-computed two-unit net`; `forward matches net-parity.json's 20 expected outputs to 1e-5`; Python: `train_net learns y = x0 > 0 on 400 synthetic rows to held-out Brier under 0.05`; `predict_net reproduces net-parity.json`.
- [ ] **Step 2:** Run `npm test` and `npm run test:trainer`; expect FAIL.
- [ ] **Step 3:** Implement; generate `net-parity.json` once with `predict_net` and commit it.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Train each small net in MLX and run it in the engine with no Python`.

### Task 12: Held-out scores, the baseline, trust and promotion [Opus] [screens]

**Files:**
- Create: `engine/school/nets.ts`
- Test: `test/school-nets.test.ts`

**Interfaces:**
- Consumes: `rowsFor`, `labelCounts`, `thinCause` (Task 8), `startTrain` (Task 7), `parseNet`, `forward` (Task 11), `ci`, `pairedCi` (Task 4).
- Produces: `split(rows)`; `evaluate(net, weights, heldOut, baseline)` (ruling 11: Brier for every sigmoid head, the master included, MAE for cost, agreement beside the master's Brier); `trainNet(net, now)`; `current(net)` (null when missing or refused, reason kept); `netCard(net, now): NetCard` (with `cause` from `thinCause` and `selfSelected` true for the appraiser once it has moved an award); `baselineFor(net)`.
- [ ] **Step 1: Write the failing tests:** `a net with 25 labels is thin, says 25 of 40 and names its cause`; `held-out rows are the newest 20% and never in rows.json`; `a head beating the base rate with hi below zero is trusted and promoted`; `a head whose interval spans zero is not trusted and not promoted over a trusted one`; `the master is trusted by Brier against the base rate, with agreement reported beside it`; `a master that only says approve on a 97% kind is not trusted and the kind is marked skewed`; `a corrupt weights file makes current null and the card names it`; `the appraiser's baseline is the firm's pass rate as of the award`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Score every net on rows it never saw, against a baseline, and trust only what beats it`.

### Task 13: The nightly retrain, distillation and the school's off switch [Opus] [screens]

**Files:**
- Create: `engine/school/tick.ts`
- Modify: `engine/main.ts` (`startSchool()`; stopped on shutdown), `engine/school/datasets.ts` (distilled rows), `engine/settings.ts` (`patchSettings` turning `school.enabled` off calls `schoolOff()`)
- Test: `test/school-tick.test.ts`, `test/school-datasets.test.ts`

**Interfaces:**
- Consumes: `trainNet`, `current`, `gateNow('light')`, `labelCounts`; `predict` (Task 14; injected until it lands).
- Produces: `startSchool(o)`: `{ tick(); stop() }` (ruling 12, at most once a night, one train at a time); distilled rows (ruling 13); `schoolOff(now)` (records `school.enabled { on: false }`, `pauseAll('the school was turned off')`, aborts a live voyage or arena build; `predict()`, `registerPrediction()` and `act()` read `school.enabled` on every call).
- [ ] **Step 1: Write the failing tests:** `the tick retrains only nets with new labels, master last`; `not outside the window or on battery`; `once a night`; `triage under 100 rows gets distilled rows for proposal items only, weight 0.3, none held out`; `turning the school off pauses a live retrain at once`; pin: `durability, router and appraiser never get distilled rows`.
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Retrain the nets each night from the day's labels, master last, and stop everything the moment he turns the school off`.

### Task 14: The nets at work and the master's prospective guesses [Opus] [screens]

**Files:**
- Create: `engine/school/decisions.ts` (the prediction half)
- Modify: `engine/market/bids.ts` (`appraisal` and the award, Decision 14), `engine/brief.ts` (triage order and a suggested tier in quiet text), `engine/market/jobs.ts` (`postProposal`, `proposeHarnessJob` call `registerPrediction`), `engine/market/ship.ts` (after `record('pr.opened', …)`), `engine/market/api.ts` (`JobDetail.school`)
- Test: `test/school-predict.test.ts`, `test/bids.test.ts`, `test/brief.test.ts`

**Interfaces:**
- Produces: `predict(net, raw): { p; version } | null` (null when the school is off or the net is not current and trusted); `masterInputs(job, run)`; `registerPrediction(job, run | null, now): Prediction` (ruling 15); `JobDetail.school: { appraisal; router: Array<{ agentId; p }>; durability; master: Prediction | null }`; the award uses `(calibrated + appraisal) / 2` only with a trusted appraiser and the school on.
- [ ] **Step 1: Write the failing tests:** `a proposed job registers one prediction, once`; `a PR opened registers one with the merge kind`; `with no master the prediction abstains with the reason`; `with the school off it abstains with "the school is off"`; `a master 9 days old abstains`; `a net that throws makes it abstain`; `a trusted appraiser moves the award, and with the school off the award is Phase 2's again`; `triage reorders recommendations only when trusted and the school is on, and never sets a tier`; pin: `award without a trusted appraiser equals Phase 2's choice on the bids fixture`.
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Let trusted nets inform the award and the brief, and write down the master's guess before he decides`.

### Task 15: His decisions, never the city's, and the master's agreement [Opus] [screens]

**Files:**
- Modify: `engine/school/decisions.ts` (the resolution half), `engine/main.ts` (`installDecisions()`)
- Test: `test/school-decisions.test.ts`

**Interfaces:**
- Consumes: `job.changed`, `run.ended`, `merge.reverted`; `PR_CLOSED_REASON` (Task 9); `predictions`; `autonomy.acted` rows (Task 17; read by key, empty until it lands); `suspend()` (Task 16; injected until it lands); `ci`.
- Produces: `installDecisions()` (ruling 14); `resolve(job, by, at)`; `agreement(kind, repo?)` (ruling 16, with `skewed` from Task 12's mark); `agreements()`.
- [ ] **Step 1: Write the failing tests:** `accepting a proposal predicted 0.8 records approved and agreed`; `dismissing it records agreed false`; `a merged PR with his changes approves`; `a PR he closed declines`; `a job closed because its issue closed records no decision`; `a push-mode merge records no decision`; `a revert after an approve supersedes it as a decline`; `a decision with no earlier prediction has agreed null and is in no window`; `an abstention counts as a disagreement`; `an autonomous accept and an autonomous merge record no decision.resolved`; `his withdrawal of an auto-accepted job records agreed false, by undo, and suspends the pair`; `his close of an autonomous PR does the same`; `49 rows are not eligible, 50 with 48 agreed are, 50 with 47 are not`; `the repo test needs 10 rows and none of the last 10 against`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Record each of his own decisions against the guess made before it, and never count the city's`.

### Task 16: Asks, grants, suspension, revocation and mayAct [Opus] [screens]

**Files:**
- Create: `engine/school/autonomy.ts`
- Modify: `engine/school/tick.ts` (`askDue()`), `engine/brief.ts` (items `autonomy` with `grant`, `decline`, `why`; `acted` with `revoke`, `why`; `TAUGHT` gains `grant`, `decline`, `revoke`), `engine/market/replay.ts`
- Test: `test/school-autonomy.test.ts`, `test/brief.test.ts`

**Interfaces:**
- Consumes: `agreement()`, `current('master')`, `getRepo`, `paths().stop`, `run`, `prState()`, `watchRevertsFor()` (Task 9), `predictions`.
- Produces: `askDue(now)` (ruling 17); `grant(kind, repo, now, o: { fromSettings?: boolean })` (from an open ask, or from Settings for a pair he revoked); `decline()`; `revoke(kind, repo, by, jobId?, now?)` (sets `quietUntil`); `suspend(kind, repo, reason, now)`; `grants()`; `mayAct(kind, repo, jobId, now)` (ruling 18); `revokeOnRevert(data)` (ruling 19).
- [ ] **Step 1: Write the failing tests:** `an eligible kind with a trusted master asks once`; `a declined pair is silent 30 days`; `a pair he revoked is silent 30 days and he can re-grant it from Settings`; `a repo without a build command and AllStreets/beagle are never asked`; `only grant moves an ask to granted`; `mayAct refuses with each of: school off, no grant, revoked, suspended, stop file, halted, market off, no build, window no longer eligible (and suspends), repo test failing, master missing, untrusted, no prediction, p 0.89, a prediction from a master 9 days old and replaced, not pushable, PR closed, head moved, a failed revert read`; `a revert pushed a minute before is found by mayAct's own read, which revokes and refuses`; `mayAct answers ok when every condition holds`; `a throw answers could not check`; `revokeOnRevert revokes an autonomous job's grant`; `the brief carries the ask and an acted item with revoke`; `replay rebuilds grants`; pin: `a revert of a job the city did not act on revokes nothing`.
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement. Every refusal reason is a sentence he reads.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Ask his permission kind by kind and repo by repo, and refuse to act unless every check holds`.

### Task 17: Acting under a grant [Opus] [screens]

**Files:**
- Modify: `engine/school/autonomy.ts` (`act()`), `engine/school/tick.ts`, `engine/github.ts` (`mergePR()`), `engine/market/ship.ts` (`watchRevertsFor()` calls `revokeOnRevert` before `haltRepo`), `docs/SELF_RECURSION_GUARDRAILS.md`
- Test: `test/school-act.test.ts`, `test/ship.test.ts`, `test/github.test.ts`

**Interfaces:**
- Produces: `mergePR(fullName, number, headSha)` (`gh pr merge <n> --repo <full> --merge --match-head-commit <sha>`; refused by `githubWriteRefused()`); `act(now): Promise<number>` (ruling 18; nothing when the school is off); the guardrails arrows (`proposed job of a granted kind > mayAct > accept > open > bid …`; `waiting PR of a granted kind > mayAct (fresh revert read) > gh pr merge`), why neither creates a job, and the Beagle pin rule (ruling 1).
- [ ] **Step 1: Write the failing tests** (fake runner): `a granted proposal kind is accepted with acted recorded first`; `a granted merge kind runs exactly gh pr merge with --merge and --match-head-commit`; `a revert pushed one minute before the next act is found by that act's own check, which refuses` (Review Focus 2); `the stop file mid-tick stops further acts`; `a squash-only repo's refusal suspends the pair with that reason`; `the revert handler revokes before it halts`; `with the real runner on a temp home mergePR is refused before any gh call`; `act does nothing with the school off`; pin: `no autonomous action without a grant`.
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; `npm test` whole.
- [ ] **Step 5:** Commit `Act on its own only where he granted it, re-reading for reverts every time, and stand down on a revert`.

### Task 18: Verified history [Opus] [screens]

**Files:**
- Create: `engine/school/history.ts`
- Test: `test/school-history.test.ts`

**Interfaces:**
- Consumes: `listRuns`, `inspection.done`, `merge.reverted`, `merge.followup`, `mergedPRs`, `engineGit` on the mirror, `execTool` under the tool profile (the test check), `getSettings().school.commitsAsWork`, `JOB_TRAILER`, `CITY_BRANCH`.
- Produces: `verifiedChanges(repo: Repo, now, o: { check?: boolean }): Promise<Array<{ ref: string; sha: string; parent: string; kind: 'city' | 'pr' | 'commit'; files: string[]; touchesTests: boolean; at: string }>>` (ruling 23; the test check under the heavy gate, cached in `verified`); `verifiedCounts(): Record<string, { city; pr; commit }>` (for the screen's "11 of 100").
- [ ] **Step 1: Write the failing tests** (a bare repo fixture with direct commits, one merged PR, one revert, one follow-up fix): `a 40-day-old commit touching source with passing tests is verified`; `a 20-day-old commit is not`; `a reverted commit and one followed by a fix are not`; `a commit whose tests fail at it is not`; `a city commit is counted as city only when it passed inspection`; `with commitsAsWork off only city merges and PRs count`; `verifiedCounts reports each kind`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Find his verified past work: city merges, PRs and the commits that survived`.

### Task 19: Arenas from planted bugs [Opus] [screens]

**Files:**
- Create: `engine/school/mutants.ts`, `engine/school/arenas.ts` (the build half)
- Test: `test/school-mutants.test.ts`, `test/school-arenas.test.ts`

**Interfaces:**
- Consumes: `createBaseDir`, `installDeps`, `startEgress`, `hostsFor`, `execTool`, `wrap`, `toolProfile`, `childEnv`, `reapRun`, `gateNow('heavy')`, `charge`, Beagle's `splitOf`, `putArena`, `putTasks`, `sealedHash` (via `loadBeagle()`).
- Produces: `mutate(path, text, max, seed)` (pure, ruling 20); `buildPlanted(repo, now): Promise<ArenaInfo>` (refuses a market-off repo or one with no test command with the reason; writes tasks to `arena_tasks` and to Beagle's store with `Arena.data` the arena id; records `arena.built` with `sealedHash`; a gate loss pauses and the next night tries only the untried candidates); `arenaTasks(id, split)`.
- [ ] **Step 1: Write the failing tests** (a tiny JS repo, `PALIMPSEST_SANDBOX=off`): `mutate flips a comparison, skips strings and comments, and is deterministic`; `a mutant the suite passes is dropped, one it fails is kept`; `kept tasks are in Beagle's store under the arena id with their splits, and the recorded sealedHash is Beagle's sealedHash of that arena`; `grading runs carry no proxy`; `a gate loss pauses and resumes the rest`; `a market-off repo is refused`; `charged as local school credits`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Plant one-line bugs in his repos that their own tests catch, written into Beagle's store`.

### Task 20: Arenas from past changes [Opus] [screens]

**Files:**
- Modify: `engine/school/arenas.ts` (`buildPast`)
- Test: `test/school-arenas.test.ts`

**Interfaces:**
- Consumes: `verifiedChanges()` (Task 18), the mirror, `engineGit`.
- Produces: `buildPast(repo, now)` (ruling 20; `arena_tasks.ref` the PR number or sha); `sealedRefs(): Set<string>` (every ref and sha in any sealed split).
- [ ] **Step 1: Write the failing tests:** `a verified commit with a test that fails at its parent becomes a task`; `one whose test already passed at its parent does not`; `a rebase-merged PR whose first parent is not on the base is skipped`; `its task shows the failing test, not the fix`; `sealedRefs names the sealed tasks`; `nothing is fetched beyond the mirror`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Turn his verified fixes with tests into tasks the school can race on`.

### Task 21: Arenas as Beagle arenas: tools and grading in the sandbox [Opus] [screens]

**Files:**
- Modify: `engine/school/arenas.ts` (`toBeagleArena`, `registerArenas`)
- Test: `test/school-arena-grade.test.ts`

**Interfaces:**
- Consumes: Beagle's `Arena`, `ToolSpec`, `registerArena`; `execFileTool`, `execTool`.
- Produces: `toBeagleArena(info)` (ruling 21: `id` and `data` the arena id, `kind 'fixtest'`, `show()` with no path of this Mac, tools, `run_tests` in a fresh scratch clone per call, `grade`, `graderTimeoutMs` 15 minutes, `maxTurns` 24, `selfCheck`, `starters()` from the seeded local agents through `toGenome()`); `registerArenas()`.
- [ ] **Step 1: Write the failing tests:** `a correct edit scores 1, one breaking another test 0.5, an edit to a test file 0`; `a non-unique find is refused`; `two run_tests calls on one task use two scratch clones`; `run_tests has no network`; `show never contains the temp path`; `a race of two fake genomes reads its tasks from Beagle's store`; pin: `read_file outside the clone and through a symlink is refused` (the broker's file tool).
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Race agents on his repos' tasks through Beagle, graded by their own tests in the sandbox`.

### Task 22: Voyages [Opus] [screens]

**Files:**
- Create: `engine/school/voyages.ts`
- Modify: `engine/school/tick.ts`, `engine/market/trips.ts` (reason `school`, the campus from `campusOrigin()`)
- Test: `test/school-voyages.test.ts`, `test/trips.test.ts`

**Interfaces:**
- Consumes: `loadBeagle()` (`startVoyage` with `concurrency 1` and `localOnly`, `race`, `breed`, `compareToParents`, `sealedRace`, `finishVoyage`), `schoolDriver`, `gateNow('heavy')`, `sealedRefs()`, `campusOrigin()`.
- Produces: `sailVoyage(arenaId, now, o: { firmId?: string }): Promise<VoyageView>` (ruling 22; one at a time; resumes per run; the champion against every seeded local agent through one `sealedRace`, which counts a sealed use; records `voyage.*`); `voyages()`; parents' trips.
- [ ] **Step 1: Write the failing tests** (fake driver, fake arena): `a voyage of 8 runs 4 generations and records each`; `a child with lo at or below zero is not promoted`; `the designer sees only breeding tasks`; `a gate loss aborts unscored and the next night's race skips the stored runs`; `Beagle runs at concurrency 1`; `the champion is compared only with seeded local agents and the view says Claude agents were not compared`; `a spent arena (10 sealed uses) makes no champion claim`; `school Claude spend in a voyage stops at the day's 30 credits`; `parents travel to the campus and home`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Breed agents on his repos' arenas over several nights and keep only children that are significantly better`.

### Task 23: The school roster, commissions and hiring [Opus] [screens]

**Files:**
- Create: `engine/school/roster.ts`
- Modify: `engine/market/firms.ts` (`ROSTER` reads school-bred specialists and graduates; `hire()` prefers them where the router is trusted, and a commissioning firm first for 7 days), `engine/market/treasury.ts` (the daily tick's commission rule)
- Test: `test/school-roster.test.ts`, `test/firms.test.ts`, `test/treasury.test.ts`

**Interfaces:**
- Consumes: `voyages()`, `graduates()` (Task 27; empty until it lands), `predict('router', …)`, `credits.moved`.
- Produces: `schoolRoster(): RosterSeed[]`; `commission(firmId, arenaId, now): VoyageView` (ruling 22: balance at least 400, an idle agent, a floor on the arena's repo, no commissioned voyage live; 120 credits to the city; `voyage.commissioned`); `firstRefusal(agentSeedId): string | null`.
- [ ] **Step 1: Write the failing tests:** `a school-bred champion appears on the roster with origin school`; `a firm with 390 credits cannot commission`; `a commission moves 120 credits and queues the voyage first`; `the commissioning firm hires the champion first for 7 days`; `hire prefers a school agent only where the router is trusted`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Let firms pay the school to breed a specialist and hire what it produces`.

### Task 24: The LoRA dataset [Opus] [screens]

**Files:**
- Create: `engine/school/lora.ts` (the dataset half)
- Test: `test/school-lora-data.test.ts`

**Interfaces:**
- Consumes: `verifiedChanges()` (Task 18), `sealedRefs()` (Task 20), `toBeagleArena(...)` for the chat shape, `LORA`.
- Produces: `hunksToEdits(before, patch)`; `buildLoraData(now): { examples; skipped: Record<'sealed' | 'too-large' | 'too-long' | 'not-unique', number>; path; validPath }`.
- [ ] **Step 1: Write the failing tests:** `hunksToEdits widens a repeated line until unique and reproduces the after text`; `each verified change is an example and a sealed one is skipped as sealed`; `a 30 KB file skips the change`; `an example over 4,096 tokens is skipped`; `the latest 10% go to valid.jsonl`; `the data stays under paths().school`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Gather verified past work as LoRA examples, never anything from a sealed set`.

### Task 25: LoRA training and the base model download [Opus] [screens]

**Files:**
- Modify: `engine/school/lora.ts`, `trainer/school.py` (`lora_train`, `download_base`), `trainer/test_school.py`, `engine/school/tick.ts`
- Test: `test/school-lora-train.test.ts`

**Interfaces:**
- Consumes: `startTrain` (heavy, `LORA.gb`), `buildLoraData`, `startEgress`.
- Produces: `downloadBase()` (his click only; `snapshot_download` into `paths().school/lora/base/` with `HF_HUB_DISABLE_XET=1`, `HF_TOKEN=` empty and `HF_HUB_OFFLINE` unset, through a per-download egress proxy allowing `huggingface.co` and `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co`; sets `baseModelReady`); `trainLora(now)` (ruling 24; refused without the base or under 100 examples with "n of 100 verified changes"; resume by the remaining steps from `adapters.safetensors`, `optimizerReset: true`).
- [ ] **Step 1: Write the failing tests** (fake spawner): `training is refused until the base is downloaded`; `refused under 100 examples with the count`; `the argv carries --max-seq-length 4096, the ruling's flags, the trainer profile and HF_HUB_OFFLINE`; `a pause at step 230 resumes with --resume-adapter-file adapters.safetensors and --iters 370 and records optimizerReset`; `a paused adapter is never evaluated`; `the download env has HF_HUB_DISABLE_XET=1 and an empty HF_TOKEN and its proxy allows only the Hugging Face hosts`; Python: `lora_train on a two-layer random Qwen-shaped model built in the test from a config (never downloaded) writes adapters and step lines`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Fine-tune a local coder on his verified work, at night, resuming honestly from its checkpoint`.

### Task 26: The mlx backend [Opus] [screens]

**Files:**
- Create: `engine/market/mlx.ts`
- Modify: `engine/market/providers.ts` (`'mlx'`)
- Test: `test/mlx-provider.test.ts`

**Interfaces:**
- Consumes: `ChatTransport`, `runLoop`, `trainerProfile` with `bindPort`, `getSpawner`.
- Produces: `mlxTransport(model)`, `mlxProvider()` (plan, work, review, judge, audit, complete), `ensureServer(model)` (ruling 26).
- [ ] **Step 1: Write the failing tests** (fake HTTP server on port 0, fake spawner): `providerFor mlx returns the mlx backend`; `a work loop's tool call round-trips`; `the server starts once under the profile with loopback bind only and stops after 10 idle minutes`; `a second graduate stops the first server`; `credits are local by seconds`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. On his Mac, once a base exists, confirm a tool call parses for Qwen2.5-Coder under the profile (log in the commit body).
- [ ] **Step 5:** Commit `Serve the school's graduates as mlx models, fenced in and on loopback`.

### Task 27: Graduation [Opus] [screens]

**Files:**
- Modify: `engine/school/lora.ts` (evaluation, graduation), `engine/school/tick.ts`
- Test: `test/school-graduate.test.ts`

**Interfaces:**
- Consumes: `sealedRace` (Beagle), `pairedCi`, `mlxProvider`, `schoolRoster` (Task 23), `SEALED_USES`.
- Produces: `evaluateAdapter(loraId, now)` (ruling 25; one `sealedRace` per eligible arena, each a sealed use; charged as `train`); `graduate(loraId, now): Graduate | null` (`graduate.made`); `graduates()`.
- [ ] **Step 1: Write the failing tests:** `an adapter whose paired interval is above zero graduates as mlx:grad-qwen25c7-1 with root collegiate`; `one spanning zero does not and the reason names the numbers`; `only arenas whose sealed tasks its data excluded are used`; `each evaluation adds a sealed use, and the eleventh is refused with "sealed set spent"`; `Beagle's store holds the evaluation's runs, and the hash it used is the arena's sealedHash`; `a graduate commutes from the campus to its quarter when hired`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Graduate a fine-tuned coder only when it beats its base on a sealed race`.

### Task 28: School API routes, the client, the router and redaction [Sonnet] [screens]

**Files:**
- Create: `engine/school/api.ts`
- Modify: `engine/market/api.ts`, `app/src/api.ts`, `app/src/router.ts`
- Test: `test/school-routes.test.ts`, `test/router.test.ts`, `test/api-events.test.ts`

**Interfaces (full brief):**
- Routes (JSON; writes need `x-palimpsest: 1`):
  - `GET /api/school` -> `{ settings; gate: { light; heavy }; trainer; nets: NetCard[]; agreements; grants; arenas; voyages; graduates; trains; lora: { examples: number; needs: number; counts: verifiedCounts(); baseReady: boolean } }`.
  - `GET /api/school/nets/:net`, `/voyages/:id`, `/graduates/:id`; `GET /api/school/campus` stays as Task 1 made it, now filling `live`.
  - `POST /api/school/train-now` (409 on battery), `DELETE /api/school/train-now`, `POST /api/school/download-base` (202), `POST /api/school/arenas/:owner/:name` with `{ kind }` (202; 409 for a market-off repo or one without a test command, with the reason).
  - `POST /api/autonomy/:kind/:owner/:name/grant` (409 without an open ask unless `{ fromSettings: true }` on a revoked pair), `/decline`, `/revoke`.
  - `PATCH /api/settings` accepts `school` fields: `enabled`, `window` (`HH:MM`), `idleMinutes` (5 to 120), `allowLowPower`, `claudeCreditsPerDay` (0 to 100), `designer` (by shape only, never `ollama list`), `understudy`, `commitsAsWork`.
  - `scrub()` on every field; no training file, rows file, task body or Understudy shot path is ever served.
- `app/src/api.ts`: `school()`, `net()`, `voyage()`, `graduate()`, `campus()`, `trainNow()`, `stopTrainNow()`, `downloadBase()`, `buildArena()`, `grant()`, `decline()`, `revoke()`; `EVENT_TYPES` gains the train, net, voyage, autonomy and graduate events.
- `app/src/router.ts`: `school`, `net`, `voyage`, `graduate`.
- [ ] **Step 1: Write the failing tests:** `on an empty home the school view has seven thin cards each with a cause, no arena, lora 0 of 100 and the trainer not set up`; `building an arena on a market-off repo is 409 with the reason`; `grant without an ask is 409, and from Settings on a revoked pair is 200`; `train-now on battery is 409`; `settings refuse idleMinutes 2 and a malformed designer without running ollama`; `no view carries a path of this Mac`; `SSE forwards net.trained and autonomy.acted scrubbed`; `the router parses the four routes`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Serve the school, its nets, voyages, graduates and grants, scrubbed`.

### Task 29: The sample school [Opus] [screens]

**Files:**
- Modify: `engine/market/sample-economy.ts` (`seedSchool()`), `tools/sample.ts`
- Test: `test/sample-economy.test.ts`

**Interfaces:**
- Produces: `seedSchool()` with replaying ledger entries: nets (appraiser-pass trusted at v6, Brier 0.14 [0.10, 0.19] against 0.22, n 64; router trained not trusted; durability thin "18 of 40" with its cause; triage trusted "taught by the master on 22 rows"; taste thin; master trusted at v5, Brier 0.09 [0.05, 0.14] against 0.16, agreement 0.92 [0.84, 0.98] on 50); agreements (`propose:readme-gap` 48 of 50 eligible, `merge:low` 44 of 50, one kind marked skewed); an open ask on `tidewater/harbor-ledger` for `propose:readme-gap`; a grant on `hoshi/kumo` for `merge:low` with two autonomous merges and one earlier grant revoked by a revert; one he revoked by hand, quiet until a date; two arenas (planted on harbor-ledger, 48 tasks, 3 sealed uses; past on kumo, 22 tasks); one finished voyage, one sailing that the clock ends in 30 s at speed 20, one commissioned by Quickset; a graduate `mlx:grad-qwen25c7-1` (sealed 0.61 [0.52, 0.70] against 0.47 [0.38, 0.56], diff 0.14 [0.06, 0.22]) hired by Quickset; a paused LoRA "on battery" with `optimizerReset` on its resume; night gate states. All on the fake trainer; nothing spawns Python. `economyClock.school` (default true).
- [ ] **Step 1: Write the failing tests:** `the sample school replays clean`; `the clock ends the sailing voyage`; `the brief holds an ask and an acted item`; `the sample never spawns python or mlx_lm`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; the numbers above are capture copy.
- [ ] **Step 4:** Run; expect PASS; `--economy` on a temp home with `PALIMPSEST_PORT=4790` answers `/api/school`.
- [ ] **Step 5:** Commit `Seed a school with nets, voyages, a graduate and grants into the sample economy`.

---

## Part B: the screens (screens track)

Book-like language as before; every score is a number with its interval and n; every empty card says why.

### Task 30: The school screen, full and empty [Opus] [screens]

**Files:**
- Create: `app/src/ui/school.ts`, `app/src/ui/school-words.ts`, `tools/ui-test-school.ts`
- Modify: `app/src/main.ts`, `app/src/ui/runhead.ts` (School after Firms), `app/src/ui/market.css`
- Test: `test/school-words.test.ts`, `tools/ui-test.ts` (calls `schoolChecks`)

**Interfaces:**
- Produces (`school-words.ts`, pure): `intervalText(i, metric)` ("Brier 0.14, 95% interval 0.10 to 0.19, on 64 held-out rows"), `netLine(card)` (thin: "18 of 40 labels. No city merge has had 30 days yet."), `gateLine(g)` ("Training waits: on battery." / "Training may run: on power in Low Power mode, idle 22 minutes, inside 1:00 to 6:00."), `agreementLine(a)` (and for a skewed kind "You approve nearly all of these, so the master cannot show it knows better than that; this kind may never be offered."), `kindLabel(kind)`, `loraLine(l)` ("11 of 100 verified changes"), `sealedLine(info)` ("sealed set used 3 of 10 times").
- Produces (`school.ts`): `createSchool(parent, deps)`: sections "The nets", "The master", "Arenas", "Voyages" (runs done of total, "spans several nights"), "Graduates", "Training"; charts in SVG hairlines only with two or more points, else the sentence.
- [ ] **Step 1: Write the failing tests:** unit tests per word function; UI on the economy (shots `school.png`, `school-net.png`, `school-voyage.png`): seven net rows with intervals; the skewed kind's sentence; the sailing voyage advances live; the graduate's difference; a net page with one point per version; UI on an **empty home** (no economy, shot `school-empty.png`): seven thin cards each naming its cause, "No arena", "0 of 100 verified changes" with the base model not downloaded, "The trainer is not set up on this Mac", and no `svg` chart element anywhere; no console errors.
- [ ] **Step 2:** Run `npm run ui-test`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): numbers carry intervals and n; charts read as engraved plates; the empty school reads honestly empty, not broken. Commit `Show what the school has learned, each claim with its number, and say so when there is nothing yet`.

### Task 31: Autonomy where he decides: Settings, the district page, the brief and the job page [Opus] [screens]

**Files:**
- Create: `app/src/ui/autonomy.ts`
- Modify: `app/src/ui/settings.ts` ("Autonomy"), `app/src/ui/repo.ts` (the Phase 3 note becomes the grants block, and "Build an arena" for a market-on repo with a test command), `app/src/ui/brief.ts`, `app/src/ui/brief-words.ts` (`grant` "Let the city do this on its own here", `decline` "Not yet", `revoke` "Take it back"), `app/src/ui/job.ts` ("What the school thinks")
- Test: `test/brief-words.test.ts`, `tools/ui-test-school.ts`

**Interfaces:**
- Produces: `renderGrants(grants, agreements, opts: { repo?; onGrant; onDecline; onRevoke; onRegrant })`: one ruled row per pair with its state ("asked on Tuesday", "granted 3 November, 6 merges since", "revoked by a revert on 8 November", "you took it back; quiet until 2 December", "suspended: you undid an accepted proposal") and its one action; Settings lists every pair and lets him re-grant a revoked one; the district page's "Build an arena" is disabled with the reason on a market-off repo.
- [ ] **Step 1: Write the failing tests:** unit labels; UI (shots `autonomy-settings.png`, `district-autonomy.png`, `brief-autonomy.png`, `job-school.png`): the harbour ask grants from the brief and shows in Settings and on the district page live; Take it back revokes and shows the quiet date; Settings re-grants it; the suspended row names his undo; a job page shows the master's guess or the abstention's reason; "Build an arena" on a market-off repo is disabled with the reason; keyboard reaches every action; no console errors.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Let him grant, decline and take back the city's autonomy where he already looks`.

### Task 32: Training settings and the trainer's state [Sonnet] [screens]

**Files:**
- Modify: `app/src/ui/settings.ts` ("School"), `app/src/ui/treasury.ts`
- Test: `tools/ui-test-school.ts`

**Interfaces (full brief):**
- Settings "School": "Run the school" (`enabled`; "Off by default. While on, the city trains its nets at night, races agents on arenas you build, and trains coders on this Mac."); "Train between" (`window`); "Only after the Mac has been idle for" (`idleMinutes`); "Train in Low Power mode on power" (`allowLowPower`; "Your Mac is set to Low Power on power; training then runs slower and cooler."); the heavy gate's `gateLine()`; "Train now" (disabled on battery with the reason; "until 4:10"; "Stop"); "The school may spend on Claude each day" ("30 credits, 3% of a window"; "It takes one of the city's Claude slots and waits while you are using Claude."); "Design agents with" (`designer`); "Count my own commits as verified work" (`commitsAsWork`; "Commits that touched source, lasted 30 days with no revert or fix, and pass their tests. This goes beyond changes the guild inspected."); "Read your taste from Understudy" (`understudy`; "Read only, on this Mac. Your taste statements are also added to the bar every UI change in the market is judged against."); "Base model for coders" ("Download, about 4.3 GB" until ready; "Your Hugging Face login is not sent."); the trainer line. Privacy adds: "Training happens on this Mac and nothing it learns leaves it. Arenas are built only from repos whose market you turned on, and only when you click. The one download is the base model, when you click Download."
- Treasury: `school` and `train` spend rows; "Trained 3 h 12 min on power this week".
- [ ] **Step 1: Write the failing UI tests:** each switch patches its field; `25:00` is refused in place; Train now disabled on battery; Download answers 202 then "Ready"; the treasury lists school and train spend; no "arrive with Phase 4" text in `dist/assets/*.js`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Put the school's switches, its hours and its spend where he sets the city's limits`.

### Task 33: Lineage on the agent page [Sonnet] [screens]

**Files:**
- Modify: `app/src/ui/agent.ts`, `engine/market/api.ts` (`AgentDetail.school: { voyage: VoyageView | null; graduate: Graduate | null }`)
- Test: `test/school-routes.test.ts`, `tools/ui-test-school.ts`

**Interfaces (full brief):**
- A bred specialist's page shows its parents (links), the voyage and generation it came from, its sealed score with interval against each seeded local agent, and who commissioned it; a graduate's page shows its base model, adapter id, examples trained on, the arenas of its sealed race, and its sealed score against base with the difference and interval; a seeded agent's page is unchanged. Text through `cleanText()`.
- [ ] **Step 1: Write the failing tests:** route: `AgentDetail.school for the sample graduate carries its graduate row`; UI (shot `agent-graduate.png`): Quickset's graduate shows base, adapter and the difference; a bred specialist links its two parents; no console errors.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Show where a school agent came from on its own page`.

---

## Part C: the city (city track)

Every task keeps 60 fps on his M5 Pro and re-measures from home against the guard (850 calls, 12M triangles, shadow map redrawn) with every Phase 2 and Phase 3 ornament standing. The campus has its own `campus` key in `breakdown()` and a sub-guard of at most 25 calls and 900k triangles from home, shadow pass and campus life included (Decision 17): one merged mesh per material beyond the far LOD distance, the four halls one instanced draw per material, and no shadow casting for tracery, chimneys, pinnacles, paths or figures.

### Task 34: The campus site, its terrace, quads and halls [Opus] [city]

**Files:**
- Create: `app/src/city/campus/site.ts`, `app/src/city/campus/halls.ts`, `app/src/city/campus/index.ts`
- Modify: `app/src/city/scene.ts` (`setCampus(origin)`), `app/src/city/breakdown.ts` (`campus` key), `app/src/main.ts` (reads `GET /api/school/campus`, Task 1), `app/src/city/lots.ts`, `tools/ui-test.ts` (`CAMPUS_HOME_CALLS = 25`, `CAMPUS_HOME_TRIANGLES = 900_000`)
- Test: `test/campus.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `api.campus()`, `towerMaterials`, the kit's CC0 brick, limestone and slate, `Kit`.
- Produces: `createCampus(opts): { group; set(origin); anchors(): CampusAnchors; update(dt, clock); dispose() }` (`CampusAnchors = { library; clock; dome; gate }`): terrace 6 m up with a dressed limestone wall and two flights of steps, two quads with stone paths, four collegiate gothic halls built once in a `Kit` and instanced, windows through the facade shader.
- [ ] **Step 0:** Re-measure home at the merged Phase 3 head; record calls and triangles in the commit body. If fewer than 25 calls remain under 850, stop and put the guard to him (Decision 17).
- [ ] **Step 1: Write the failing tests:** `the campus stands on its slot's origin, inside its block`; `no ambient lot overlaps it`; `four halls cost the calls of one`; UI: `breakdown().campus is within 25 calls and 900k triangles from home with shadows`, `the whole city is still within 850 and 12M`; shots `campus-home.png`, `campus-quad.png`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): collegiate gothic at both distances, not boxes with arches; the terrace reads as a hill. Commit `Raise the university on its own terrace: quads and collegiate halls`.

### Task 35: The library and the clock tower [Opus] [city]

**Files:**
- Create: `app/src/city/campus/library.ts`, `app/src/city/campus/clock.ts`
- Modify: `app/src/city/campus/index.ts`
- Test: `test/campus.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `makeLibrary(k)`; `makeClockTower(k, clock): { group; update() }` (four stages, 48 m, faces showing his local time, lit after sunset as real emitters under the bloom threshold).
- [ ] **Step 1: Write the failing tests:** `the hands point at 10:10 for 10:10`; `the faces emit only after sunset`; UI: shots `campus-library.png`, `campus-clock.png`; the campus sub-guard still holds.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Build the university's library and its clock tower`.

### Task 36: The observatory where the master net lives [Opus] [city]

**Files:**
- Create: `app/src/city/campus/observatory.ts`
- Modify: `app/src/city/campus/index.ts`
- Test: `test/campus.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `api.school()` (the master's card), `net.trained`, `net.promoted`, `train.started`, `train.ended` (Task 28).
- Produces: `makeObservatory(k): { group; setState(s: { training; masterTrusted; version }); update(dt) }`: a copper dome on a drum with a shutter slit, open with warm light and a turning telescope only while the nets train; a lit brass plate by the door only while the master is trusted; shut and dark while it is thin.
- [ ] **Step 1: Write the failing tests:** `the slit opens on train.started for nets and closes on train.ended`; `a thin master leaves it shut and dark`; `clicking the dome opens the school screen at the master`; UI shots `observatory-shut.png`, `observatory-open.png`; sub-guard holds.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Give the master net its observatory, open only while it learns`.

### Task 37: Campus life from real events [Opus] [city]

**Files:**
- Create: `app/src/city/campus/life.ts`
- Modify: `app/src/city/people.ts` (trips with reason `school` end at the gate), `app/src/main.ts`, `app/src/ui/inspector.ts`
- Test: `test/campus.test.ts`, `test/people.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `campusLife(campus, opts): { apply(e); update(dt, clock) }`: one lit reading-room bay per genome racing while a voyage sails (instanced, one draw), dark when it pauses or ends; voyage parents walk in through the gate; a graduate leaves on its first trip; ambient students are unlabelled atmosphere; the inspector on the campus lists the live voyage, the trained nets and the graduates.
- [ ] **Step 1: Write the failing tests:** `a voyage of 8 lights 8 bays and its pause darkens them`; `a school trip ends at the gate`; `the inspector lists the live voyage`; UI (economy): the sailing voyage lights the library; shot `campus-voyage.png`; the sub-guard holds with life on.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Light the library while agents are bred and walk them in through the gate`.

### Task 38: The collegiate root for school towers [Opus] [city]

**Files:**
- Modify: `app/src/city/tower/*` (the `collegiate` root), `shared/tower-layout.ts`
- Test: `test/tower-build.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: a `collegiate` root: two storeys of red brick with limestone quoins, a pointed-arch entrance and a stone string course, sharing the campus's materials.
- [ ] **Step 1: Write the failing tests:** `a collegiate root builds with the expected height and slots`; UI: Quickset's graduate tower stands on it; shot `graduate-tower.png`; the city guard holds.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Root a school agent's tower in the university's brick`.

---

## Part D: real runs, media and the README

### Task 39: Real-run check: the trainer, the gate and the nets on his ledger [Opus] [both tracks merged]

**Files:** `docs/superpowers/plans/2026-11-12-phase-4-realrun.md` holds the notes; fixes only where found.

- [ ] **Step 1:** With his go-ahead (and his answers to Decisions 3 and 5): the trainer on `PALIMPSEST_PYTHON` or after he runs `trainer:setup`; `trainerStatus()` ready; `school.py ping` under the real profile on the GPU. Turn `school.enabled` on. Record one night's gate readings (power, power mode, idle, therm notes).
- [ ] **Step 2:** Confirm the nightly retrain ran only inside the window on AC; every net is `thin` with its true counts and causes; every `master.predicted` abstains; no ask exists; the school screen on his real home matches the empty-home UI test. Unplug during a "Train now" retrain and confirm the pause within 30 s. Turn the school off and confirm everything stops at once.
- [ ] **Step 3:** Confirm `~/.claude/settings.json`, `~/.claude.json` and Understudy's database are byte-identical before and after (md5), `~/.claude/projects` gained no entry, and `~/Library/Application Support/Beagle` and `~/Downloads/beagle` were not touched.
- [ ] **Step 4:** Commit `Fix issues found running the school on his Mac` (never his data).

### Task 40: Real-run check: an arena, a voyage and a LoRA on one of his repos [Opus] [both tracks merged]

- [ ] **Step 1:** With his go-ahead, on a repo he names whose market he has turned on and that has a test command, click "Build an arena" (planted); record candidates, kept, the split, `sealedHash`, wall time and credits.
- [ ] **Step 2:** Let one voyage sail on local models over **several nights**; record each night's runs done, each generation's champion with its interval, promoted children with their paired intervals, the designer's Claude credits each day (at most 30, shown in the treasury and the night cap), and the final sealed comparison against the seeded local agents.
- [ ] **Step 3:** Record `verifiedCounts()` for every connected repo with his Decision 7 answer. With his click, download the base model. If at least 100 examples exist, train one adapter over the nights it needs and evaluate it; record the sealed scores and the paired difference whether or not it graduates, and every resume with its steps lost. Under 100, record the count; that is the honest result.
- [ ] **Step 4:** Commit `Record the school's first real arena, voyage and coder, with their numbers`.

### Task 41: UI test, captures, README and media [Opus] [both tracks merged]

**Files:**
- Modify: `tools/ui-test.ts`, `tools/capture.ts`, `README.md`, `CREDITS.md`, `docs/media/*`

- [ ] **Step 1:** `tools/ui-test.ts` runs the Phase 4 set on the economy (school, empty school on a fresh home, autonomy, training settings, agent lineage, campus, observatory, life, graduate tower), the console-error check, and the perf guard from home with the campus sub-guard; `npm run ui-test` passes on a quiet GPU.
- [ ] **Step 2:** `tools/capture.ts` gains stills `school`, `school-empty`, `school-net`, `autonomy-settings`, `brief-autonomy`, `agent-graduate`, `campus-home`, `campus-quad`, `campus-clock`, `observatory-open`, `graduate-tower` and clips `voyage` and `observatory`, from the sample economy at 2x.
- [ ] **Step 3:** README in his style: the university, arenas from his repos on his click, breeding with Beagle, coders fine-tuned on verified work (what counts, Decision 7) and graduated only on a sealed race, the five nets and the master, earned autonomy and how it is taken back; the honest state with Tasks 39 and 40's numbers, including how few labels exist and what that means; when the Mac trains (Low Power included) and what it costs; privacy; the media. Shields row to phase 4.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test` pass; `npm run test:trainer` passes on his Mac; `cargo test` in `src-tauri` passes.
- [ ] **Step 5:** Commit `Phase 4: the school` and push per his standing order.

---

## Self-review notes

- **Spec coverage.** 9 and 12: rulings 1 and 2, Tasks 2 and 4. 9.1: checked at Beagle `4edbd39`; two fixed upstream, three open (Task 2 (d), (e); fossils and LoRA left to the city, Decision 2). 9.2: arenas graded by his suites in a sandbox (Tasks 19 to 21), LoRA on MLX from verified work (Tasks 18, 24, 25), graduates as `mlx:` joining firms (Tasks 23, 26, 27), beating the base on a sealed set (ruling 25), numbers with intervals and honest empties (rulings 11, 29; Task 30). 9.3: rulings 8, 12, 13; Tasks 8 to 14. 9.4: rulings 14 to 19; Tasks 15 to 17, 31. 17: autonomy for proposals and PR merges, a harness first (rulings 14, 17, 18). 7.2: hiring and paying the school to breed (ruling 22, Task 23). 6.1: Tasks 34 to 36. 6.2: Task 38. 6.4: ruling 28, Tasks 22, 37. 11: school screen (30), Settings (31, 32), district grants (31), agent lineage (33). 4 and 7.3 (no sink for his usage): rulings 3, 4; Tasks 1, 4. 5: ruling 7, Task 5.
- **Interfaces created here:** `Provider.complete` (3); `mlx` backend (26); the school lease and kinds (1); `liveWork`, `creditEntries` (1); `watchRevertsFor`, `PR_CLOSED_REASON` (9); `mergePR` (17); `verifiedChanges` (18); `nextSlot('campus')`, `ensureCampus`, `campusOrigin`, `/api/school/campus` (1); Beagle's (a) to (k) (2).
- **Spend:** every school Claude call through `schoolDriver` with `unattended` and a Claude work slot (1, 4); local minutes charged (7, 19, 22, 27); all kinds in every cap list (1).
- **Pins:** Task 1 `poolOfModel`, Task 9 "neither halts nor scars", Task 13 "never get distilled rows", Task 14 Phase 2's award, Task 16 "revokes nothing", Task 17 "no action without a grant", Task 21 the broker's symlink refusal.
- **Type consistency:** the Task 1 types are used unchanged; `Decision.by` gains `undo` (Task 1) for ruling 14; `NetVersion.metric` is `brier | mae` with `agreement` beside it (ruling 11); `ArenaInfo.status` includes `paused` and `spent`; names checked across tasks (`watchRevertsFor`, `verifiedChanges`, `sealedRace`, `putTasks`, `schoolRoster`, `commission`, `thinCause`, `schoolOff`).
- **Proportion:** 41 tasks against the spec's largest phase; step bodies carry only values a ruling pins.

## Builder check fixes

| Item | Fixed by |
|---|---|
| C1 the window counted the city's own acts | Ruling 14 (acted keys excluded; his undo is a disagreement and suspends); Decisions 12 and 13; Task 15 tests |
| C2 the gate's probes do not parse on macOS 26 | Ruling 6 (`powermode` under "Currently in use:", therm notes as nominal, `allowLowPower`); Decision 3 put to him; Task 6 with captured fixtures |
| C3 Beagle's task store and the sealed set | Ruling 2 (h), (j), (k); ruling 20 (`putArena`, `putTasks`, `Arena.data`); ruling 25 (`sealedRace`); Tasks 2, 19, 21, 27 tests read Beagle's store and the hash |
| I4 fresh revert read before a merge | Ruling 18; Task 9 `watchRevertsFor(…, { force })`; Tasks 16 and 17 tests; Review Focus 2 |
| I5 silence after he revokes | Ruling 17; `Grant.quietUntil`; re-grant from Settings; Tasks 16, 31 |
| I6 school Claude slot and `unattended` | Rulings 3 and 4; Task 1 and Task 4 tests |
| I7 market-off and private repos | Ruling 20 and Decision 8 (his click, market-on only); Global Constraints; Tasks 19, 28, 31 |
| I8 Beagle clone, (h), (i), pin policy | Ruling 2 (fresh clone, (h), (i)); ruling 1 and Decision 1 (full sha, his approval, no merge grant on Beagle) |
| I9 commits as verified work | Decision 7; rulings 20 and 23; Task 18; counts in "What was found" |
| I10 LoRA flags and resume | Ruling 24; Task 25; Review Focus 1 |
| I11 the master's trust and skew | Ruling 11; Decision 12; Task 12 tests; `Agreement.skewed`; Task 30 copy |
| I12 voyages: local controls, concurrency, nights | Ruling 22; `VOYAGE.concurrency`; Task 22; Task 40 Step 2 |
| I13 order and split | Campus plot and route in Task 1; Task 21 of revision 1 split into Tasks 22 and 23; starting head after Phase 3 Task 21 and its final review |
| I14 draw budget | Part C header, Decision 17, Task 34 Step 0 re-measure, `campus` breakdown key and sub-guard |
| I15 empty states | Ruling 29; `thinCause`; Task 28 and Task 30 empty-home tests; no chart under two points |
| I16 downloads | Decision 5, Task 5 (Beagle's venv via `PALIMPSEST_PYTHON`); Decision 6 and Task 25 (`HF_HUB_DISABLE_XET=1`, empty `HF_TOKEN`, host list) |
| I17 school off means off | Global Constraints; Task 13 `schoolOff`; Tasks 14, 16, 17 tests |
| M18 `githubWriteRefused` wording | Test safety rule 16; Task 17 test |
| M19 `CALL_MAX_TURNS` and free text | Ruling 5; Task 3 tests |
| M20 `tsc` and Beagle's sources | Ruling 1 (non-literal specifier); Task 4 test |
| M21 pins | Tasks 9, 13, 16, 21 marked |
| M22 7.2 and agent lineage | Ruling 22 and Task 23 (commissions); Task 33 (agent page); Decision 15 |
| M23 grader timeout, turns, scratch clones | Ruling 21; `ARENA.maxTurns`; Task 21 tests |
| M24 follow-up files | Ruling 9; Task 9 test |
| M25 WAL fallback and disclosure | Ruling 10; Task 10 test; Decision 9; Task 32 copy |
| M26 rebase merges and sealed uses | Ruling 20; ruling 25 and `SEALED_USES`; Tasks 20, 27 tests; Task 30 `sealedLine` |
| M27 prediction version and squash-only | Ruling 18; Task 16 and 17 tests |
| M28 issue-closed settlement | Ruling 14 (`PR_CLOSED_REASON`); Task 15 test |
| M29 `~/.claude/projects` and the model fixture | Task 39 Step 3; Task 25 Python test |
