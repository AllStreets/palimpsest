# Palimpsest: design

Date: 2026-11-08. Status: draft for approval.
Repo: github.com/AllStreets/palimpsest. Folder: `~/Downloads/palimpsest`.

## 1. Intent

Palimpsest is the place Connor works out of across all of his repos. A market of AI agent firms bids on real work from those repos, does it in isolation, passes rigorous inspection and ships it. The whole thing is visible as a photoreal city at dusk: every agent has a tower, every merged change raises a floor, and the skyline is a readable history of who built what, and how well.

Two things have to be true at once, and neither is allowed to carry the other:

- **Functionally real.** Real issues, real diffs, real tests, real merges, real usage spent from his real Claude plan, real models trained on his machine. Nothing in the city is decoration pretending to be data.
- **Visually shocking.** Film and AAA-game realism: real materials, reflections, light, weather of the evening. His words: "shocking, life-like", "phenomenal video games", "beautiful".

Why: it is his daily workplace (so it must earn its place every morning), and it is a portfolio flagship that shows economics fundamentals (markets, bidding, reputation, bankruptcy), machine learning that actually trains, and design-engineering range. It is held to his wow bar: the best of AgentZeus/WFR, CORANTO, Bombechat, Chicago Open World, Foundry.

Who it serves: Connor first. Second, people who clone the public repo, who must be able to run it safely with their own providers and with nothing connected by default.

The name: a palimpsest is a manuscript written over across centuries with every layer still readable. Each tower is exactly that.

## 2. Goals

1. Connect GitHub repos (public and private), each individually toggleable, and keep working on them with increasing autonomy.
2. On connecting a repo, read its history and build its founding tower immediately, so a new city never starts at ground level.
3. On connecting a repo, compare what its README promises against what the code really does, and propose strategies to close the gap. Proposals become jobs.
4. Run a real market: jobs, bids, a winner, work in a sandboxed worktree, inspection, then a PR or a push to main.
5. Spend his Claude Max ($100/month) usage sensibly and visibly, with local models as cheap labor.
6. A school that actually trains: evolves agent designs (Beagle's engine), fine-tunes small local language models on verified past work, and trains the city's neural nets.
7. A master net that learns his judgment, and autonomy that is earned per kind of work when the master agrees with him often enough.
8. A daily brief on the first open of each day that he can act on in place.
9. A city that is alive: construction, inspection, commuters, the university, all driven by real events.
10. A native Mac app (Tauri), a logo at Bombechat's level, and a README with screenshots, video and diagrams.

## 3. Non-goals (v1)

- Proactive proposals for repos he is not looking at, beyond the README-versus-reality pass. The fuller "study my repos and take my projects where I want them" is saved for later (section 14).
- Multi-user or hosted service. It is a local app; other people run their own copy.
- Windows or Linux builds.
- A signed or notarized download. Build from source, like Teardown.

## 4. Anti-goals (failure even if it works)

- **Fake life.** Towers, commuters or numbers that don't come from real events. Ambient city traffic may exist for atmosphere, but every agent persona's movement, every floor and every searchlight corresponds to something real, and the UI can show what.
- **AI look.** Card kits, glow, caps eyebrows, generic AI fonts and buttons (see his no-AI-look rules). The UI should feel like a place, not a dashboard.
- **Silent damage.** Any destructive action on a repo without his consent, or a push that skipped the gates.
- **Reputation from fiction.** History floors that look identical to floors earned in the market.
- **A sink for his usage.** The city must never starve his own interactive Claude use.
- **Breaking Anthropic's terms:** never read or store his Claude credentials, never offer a Claude login, never route anyone else's subscription. Agents run only through the user's own unmodified Claude Code, or an API key (section 7.4).

## 5. Constraints

- Hardware: Apple M5 Pro, 64 GB. MLX in a native arm64 venv (his Anaconda and uv are x86 under Rosetta; Beagle's `trainer/.venv` shows the working pattern).
- Local models already installed via Ollama include `qwen3-coder:30b-a3b`, `qwen2.5-coder:7b`, `gpt-oss:20b`, `qwen3:1.7b`, `nomic-embed-text`, `qwen2.5vl:7b`.
- Ports: engine API `127.0.0.1:4770`, UI dev server `4771`. (4760 is taken locally.)
- Data directory: `~/Library/Application Support/Palimpsest` (overridable with `PALIMPSEST_HOME` for tests and sample data).
- No em dashes or `--` in any UI copy, README or commit text he reads. No emojis anywhere.
- Every visible change goes through build, screenshot, critique, iterate before he sees it. Report how many rounds ran and what is still weak.
- README media comes only from a sample dataset, never his private repos or session content.

## 6. The city

### 6.1 Layout

- **Districts are repos.** Each connected repo gets a district on a street grid. Its founding tower is the district landmark.
- **Agent towers.** Each agent persona has its own tower in its firm's district quarter. Firms are visible as clusters sharing a root style.
- **The university** (the school) sits on its own hill or quad: a beautiful, classic, elite campus. Collegiate gothic, a library, a clock tower, quads, an observatory dome where the master net lives.
- **The job board** is a real place in the city (a civic hall or exchange) where posted jobs and live bids appear.
- **Dark towers** belong to bankrupt firms. A firm that buys a dark tower re-clads it in its own style.

### 6.2 Palimpsest towers (approved direction)

A tower is read bottom to top:

- **Root:** real-world vernacular inherited from lineage (Beaux-Arts, Roman, Gothic, Kyoto pagoda base, Chicago limestone, and more). School graduates start in collegiate gothic brick.
- **Floors:** one per merged change. Each floor is laid in the architecture of the agent's ability at that time: stone, brick, steel and glass, titanium, then sci-fi megastructure. Era is driven by the agent's reputation and capability, not by the calendar.
- **Silhouette:** how the agent works shapes the upper structure (a careful reviewer twists and grows a lens crown; a fast builder cantilevers; a specialist goes needle-thin).
- **Scars:** a failed inspection leaves a visible scar floor (approved in the mockup: a floor left in primer).
- **Datum line:** a thin bronze band at the height where a repo or agent joined the city. Below it, founding history from real commits. Above it, floors earned in the market.

### 6.3 Live construction (approved, he called the crane and sparks "phenomenal")

| Real event | What the city shows |
|---|---|
| Bid won | A tower crane on the roof, a skeleton column or two |
| Agent working | Steel frame rises, netting, welding sparks and flicker light |
| Inspection running | Inspection guild searchlights sweep the new floor |
| Passed and merged | Frame cures into the floor's finished material; windows light |
| Failed | Scaffolding comes down; scar floor if the attempt is recorded |
| Firm bankrupt | Tower goes dark |

Progress inside a stage follows real progress where it is measurable (tool calls, tests run), not a timer.

### 6.4 Commuting

Agent personas travel to their work, with traditional and futuristic modes: walking, trams, ferries on a river, maglev pods, elevated rail, autonomous cabs. A persona heads to a job site when it is assigned, to the university when it's in training, to the job board when it bids. Ambient traffic and crowds fill the streets for atmosphere and are not labeled as agents.

### 6.5 Founding towers from history

On connect, the engine reads the repo's merged PRs and commits:

- One floor per merged PR; where there were no PRs, commits are clustered into meaningful changes (by time gaps, files touched and message). A repo with 2,000 commits does not become a 2,000-floor needle.
- Eras come from the repo's own timeline: its first months are the stone root, then brick, steel, glass, sci-fi near the present.
- Commits co-authored by Claude (detectable from `Co-Authored-By` trailers) are marked as such on their floors.
- Everything here sits below the datum line.

### 6.6 Look and rendering

- three.js. WebGPU renderer where available (Tauri's WKWebView on macOS 26 supports it), WebGL2 fallback.
- Physically based materials from real scans (Poly Haven textures, CC0), image-based lighting generated from the same sky the viewer sees (the mockup proved mismatched HDRIs make metal look like plastic).
- Dusk is the signature time. A day and night cycle is welcome if it holds the bar.
- Post: ambient occlusion, bloom on real emitters only, filmic tone mapping, depth of field for close-ups.
- Hero assets (podiums, columns, cranes, I-beams, university buildings) are modelled properly, not boxes. Procedural detail where it is honest: the facade window shader from the mockup.
- Performance target: 60 fps on his M5 Pro at full window size, with a quality setting.

The approved mockup is `docs/mockups/palimpsest-tower.html`. It sets the floor, not the ceiling.

## 7. The market and the work

### 7.1 Jobs

A job comes from: a labelled GitHub issue, a README-versus-reality proposal, a daily-brief recommendation he acts on, or his direct request. A job carries its repo, a scope, acceptance criteria, a budget ceiling (in credits, 7.3) and a value.

### 7.2 Firms, agents, bids, reputation

- **Agent:** a design (model, instructions, tools, workflow shape, memory examples), compatible with Beagle's genome shape so the school can breed it. Models can be `claude:*` (through Claude Code), `ollama:*`, or `mlx:*` (school graduates).
- **Firm:** a group of agents with a treasury, a reputation and a style. v1 seeds a handful of firms with distinct temperaments and root styles.
- **Bid:** plan, price (credits) and confidence. The appraiser net gives the city its own estimate of each bid.
- **Award:** the job goes to the best expected value: calibrated pass probability times value, minus price. Over-promising lowers calibration and loses future work.
- **Reputation:** pass rate by job size, plus calibration (Brier score of stated confidence against outcomes), plus durability (merges not later reverted).
- **Money:** a firm is paid its bid on merge; on failure it eats what it spent. A firm whose treasury stays negative past a grace period goes bankrupt.
- **Hiring:** a firm can pay the school to breed a specialist or hire a graduate.

### 7.3 Credits and the treasury

- Credits measure real usage. For Claude, a job's cost is the run's token usage from `claude -p --output-format json`, converted to a share of plan usage by calibrating against the official percentages (7.4). For local models, credits reflect time and memory, much cheaper.
- City budget default: up to half of each five-hour window, backing off when his own interactive Claude use is active. Daily and weekly caps in Settings.
- Concurrency default: two Claude jobs and one local job at a time.

### 7.4 Providers and his usage (from the research, 2026-11-08)

- **Claude, his setup:** agents run through his own installed, unmodified `claude` CLI in headless mode (`claude -p`), on his own login. Palimpsest never reads his OAuth token, never offers a Claude login, never proxies.
- **Live plan usage:** Claude Code passes `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`, `resets_at`) to statusline scripts. Palimpsest ships a statusline hook that records these to its data directory; his existing statusline script keeps working (the hook chains it). This is the documented path.
- **Local transcripts** (`~/.claude/projects/*/*.jsonl`, deduplicated by `message.id` plus `requestId`) give per-project trends, never plan percentages.
- **Settings, for everyone:** add multiple providers. Claude via your own Claude Code, or an Anthropic API key; OpenAI or Codex; Gemini; Ollama; MLX. Each shows the usage or spend it can honestly report.

### 7.5 Doing the work

- Every job runs in a fresh git worktree on its own branch.
- Agents run sandboxed: macOS `sandbox-exec` profile limiting writes to the worktree and a temp directory, network allowed only to what the job needs (package registries, the model provider). Beagle's audit found its agent edits ran unsandboxed; Palimpsest must not.
- The runner is new, reusing Beagle's patterns (tool loop, turn caps, ledger) where they fit.

### 7.6 Inspection guild

A change passes only if all hold:

- The repo's own tests, type check, lint and build pass, and no previously passing test fails.
- The guild's reviewer (a separate agent from a different firm) approves the diff against the acceptance criteria.
- For UI changes: screenshots before and after, scored by the taste net and a vision judge against his design bar.
- The diff stays inside the job's scope (no unrelated files).

### 7.7 Shipping

Per-repo toggle:

- **PR mode (default):** opens a pull request.
- **Push mode:** merges to main after inspection passes. Only on repos where he turned it on.

## 8. Trust (modelled on his ONEXUS guardrails)

- **Never without asking:** delete a repo, force-push. My additions: rewrite history, change repo settings, secrets or visibility, touch billing, or delete branches it did not create.
- **Gates:** section 7.6 before any merge or push.
- **Caps and kill switches:** usage caps, a per-repo off switch, a global stop (and a stop file on disk, like ONEXUS's `AGENTS_SYNC_DISABLED`).
- **Self-halt:** three failed inspections in a row on a repo, or any revert of a city merge, halts the city on that repo and puts it in the brief.
- **No loops:** the city's own merges never create jobs about the same change. Document the trigger graph and prove no cycle, as `SELF_RECURSION_GUARDRAILS.md` does for ONEXUS.
- **Ledger:** every bid, award, diff, test run, inspection and push is recorded, append-only, and replayable.

## 9. The school

The university. It imports Beagle's engine (race engine, sealed sets, bootstrap CIs, designer, re-grade) as a library and fixes what the audit found broken.

### 9.1 What the Beagle audit found (2026-11-08)

Real and tested: race engine, sealed sets, bootstrap CIs, re-grade, designer, and the `fixtest` coding arena pattern (clone, edit, run the suite). Broken or missing: breeding outside geotag (a hardcoded tool allow-list in `src/genome.ts` rejects coding tools), no parent-versus-child significance test, geotag-specific self-check prompt, no sandbox, fossils are an MLP over embeddings for geotag only, no LoRA anywhere. These become the first README-versus-reality case and the first jobs in the market.

### 9.2 What the school does

- **Breeds agents** on arenas built from his real repos: planted-bug and real-past-issue arenas from each connected repo, graded by its own test suite in a sandbox.
- **Fine-tunes local language models** with LoRA on MLX (`mlx-lm`) on verified past work (diffs that passed inspection and survived). Graduates are served as `mlx:*` models and join firms as cheap specialists. A graduate must beat its base model on a sealed set before it can graduate.
- **Trains the city's nets** (9.3).
- Everything it trains is shown with held-out scores and confidence intervals. No claim without a number.

### 9.3 The city as a neural net

Small nets, each with one measurable job, trained locally on MLX, retrained nightly from what actually happened:

| Net | Learns | From |
|---|---|---|
| Appraiser | a job's cost and pass chance | every bid, run and inspection |
| Taste | his design bar | Understudy's calibration pairs and bible, his approvals and rejections of UI work |
| Triage | which recommendations he acts on | his actions in the daily brief |
| Durability | which merges survive | reverts and follow-up fixes |
| Router | which firm and model suit which job | outcomes by job type |

The **master net** takes the small nets' outputs and predicts one thing: would he approve this? Nets teach each other through distillation: where a small net has little data, it learns from the master's predictions; the master learns from the small nets' signals.

### 9.4 Earned autonomy (approved)

When the master net agrees with his real decisions often enough on a kind of work (default: 95% over the last 50 decisions of that kind), the city asks his permission to handle that kind on its own. Autonomy is granted per kind of work and per repo, shown in Settings, and revocable. A revert of an autonomous merge drops that grant back to asking.

## 10. Repo analysis

On connect (and on demand):

1. Read history and build the founding tower (6.5).
2. **README versus reality:** list what the README and docs promise, check each against the code (does the function exist, is it wired, is it tested, is it stubbed or hardcoded), mark REAL, PARTIAL, MISSING, STUBBED or BROKEN with file and line evidence. The Beagle audit is the template.
3. Propose strategies to close the gaps. Each proposal is a draft job.

## 11. Screens

- **Daily brief.** First open each day, before the city. What merged overnight, what failed and why, usage spent against his plan, what's waiting on him, and the top recommendations. Every item is actionable in place: post as a job, change scope or budget first, ask the city why, dismiss (which teaches triage), open the diff, fly to the floor, retry, approve or decline a pending push, change today's usage limit.
- **The city.** The main view. Click a tower for the agent; a district for the repo; the job board for live bids; the university for the school.
- **Agent and tower.** The tower annotated floor by floor, the agent's design, reputation, calibration, history and lineage.
- **Repo district.** Its toggles (connected, push mode, autonomy grants), its README-versus-reality report, its jobs.
- **Job.** Bids, the award reasoning, the live run, the diff, the inspection results, the ledger trail.
- **School.** Each net's held-out score over time, voyages, graduates, the master net's agreement by kind of work.
- **Settings.** Providers, usage caps, repos, autonomy grants, kill switch, quality, privacy (what leaves the machine).

## 12. Architecture (builder's choice where not stated; these are my calls)

- **App:** Tauri 2 app (`src-tauri/`) as a client of the engine, which runs as a launchd user agent (section 17).
- **Engine:** TypeScript on Node 22+, run with `tsx` in dev. HTTP and server-sent events on `127.0.0.1:4770`. Storage in SQLite (`node:sqlite`) plus files for bundles and models.
- **UI:** Vite on 4771 in dev; three.js city plus the screens above. React for the screens is acceptable; the city is plain three.js.
- **Trainer:** Python, native arm64 venv, `mlx` and `mlx-lm`, run as a warm subprocess like Beagle's fossil server.
- **GitHub:** the `gh` CLI with his existing auth, so Palimpsest never stores a GitHub token itself.
- **Beagle:** imported as a library (its modules export clean functions; add a package entry). Fixes to Beagle are made in Beagle's repo, ideally by the city.

## 13. Phases

Each phase ends with something real he can use, held to the bar before he sees it.

1. **Foundation and the first standing city.** Repo connection with toggles, history analysis and founding towers, the photoreal city with districts, the Tauri shell, Settings with the Claude usage hook. He opens a city that is already standing.
2. **The market.** Jobs, firms, bids, sandboxed worktree runs through `claude -p` and Ollama, the inspection guild, PR and push modes, the ledger, live construction driven by real runs, commuting, the exterior elevator ride (18).
3. **Analysis and the brief.** README versus reality, proposals as jobs, the actionable daily brief, play tailored to him (18), and the call on interior rides.
4. **The school.** Beagle as a library with its fixes, repo-based arenas, LoRA graduates, the five nets and the master net, earned autonomy.
5. **Polish and launch.** Logo, README with screenshots, video and diagrams, the sample dataset, performance pass.

## 14. Saved for later

- The city studies all connected repos continuously and proposes its own work toward his goals for each project, even when he is not working on it.

## 15. Decided by Connor

Name Palimpsest. Palimpsest tower direction, crane and sparks. Tauri app. Logo at Bombechat's level; README with screenshots, videos, diagrams. All repos connectable, each toggleable, off by default for others. Push to main after rigorous testing, toggleable per repo. Never delete repos or force-push without asking. Trust modelled on ONEXUS. His Claude Max plan through his own Claude Code; multiple providers in Settings for others. Local models too. A school that really trains agents and neural nets. Many nets feeding a master net that learns his functioning and design bar. Earned autonomy. History towers on connect. An actionable daily brief. Commuting, traditional and futuristic. README-versus-reality analysis, Beagle as first case. Eventually fully autonomous, always beautiful.

## 16. My calls (check these)

Datum line; eras driven by ability for earned floors and by timeline for history; credits as calibrated plan usage; half of each five-hour window by default with back-off; concurrency two Claude plus one local; seeded firms; award by expected value; reputation from pass rate, calibration and durability; three-strike self-halt; extra never-without-asking items; `sandbox-exec` sandbox; 95% over 50 for autonomy; `gh` CLI for GitHub; SQLite; the phase order.

## 17. Settled after the builder check (my calls unless marked)

- **What counts as merged.** Push mode on a repo: the city merges to main by itself once every gate passes; no per-push approval. PR mode: the engine polls GitHub (`gh`) for the PR's fate. Merged by him = merged. Closed without merge = failed (no scar, since it is his call, but it trains triage and the master net). While a PR waits, its floor shows as cured but unlit, with the crane parked. Earned autonomy (9.4) governs two things: whether the city may post its own proposals as jobs without asking, and whether it may merge its own PRs in PR-mode repos for that kind of work. The brief's pending items are PRs and proposals waiting on him, not pushes.
- **Runs when the app is closed.** The engine is a launchd user agent (`com.palimpsest.engine`) with its own lifecycle, crash recovery and the stop file. The Tauri app is a client of it. This replaces the sidecar pattern in section 12. The Mac must be awake; the engine may request a keep-awake assertion while jobs run, toggle in Settings.
- **Job value.** Value is in credits and set by people, not by the nets that price bids, so the market is not circular. Defaults come from the source: issue labels map to tiers (low, normal, high), proposals and brief items arrive with a suggested tier he can change in one click. Value doubles as the ceiling a firm may bid. Triage may suggest tiers but never sets them.
- **Repos without tests or build.** Inspection never treats a missing check as passing. A repo with no test suite gets a first job to add a baseline harness (build plus smoke tests), proposed during analysis. Until it has one, push mode and autonomy are unavailable for it, and the city only opens PRs that pass the reviewer and whatever checks exist.
- **Other providers in v1.** Full agent backends in v1: Claude through his Claude Code, Anthropic API key, Ollama, MLX. OpenAI or Codex and Gemini: usage display in v1, full backends later.
- **Stale usage numbers.** The statusline hook records whenever an interactive session renders. Between readings, the city estimates from its own runs' token counts using the last calibration, with a safety margin that grows with staleness. If the reading is older than one five-hour window, Claude jobs pause until a fresh reading or he resumes them. His interactive use counts as active when any non-city transcript in `~/.claude/projects` was written to in the last ten minutes; the city then drops to one Claude job.
- **Unattended Claude use (Connor).** Yes, capped. Claude jobs may run overnight or while he is away within a separate night cap (default 20% of the weekly window, set in Settings). Local models carry the bulk of overnight work. Daytime caps in 7.3 still apply.
- **3D asset sources (Connor).** Built in code, modelled in Blender through scripts, CC0 libraries (Poly Haven and similar), and CC-BY models with attribution. Every third-party asset is recorded in `CREDITS.md` (name, author, license, link, where it is used). Most of the city should be Palimpsest's own work at a high bar. Third-party work is also studied as reference: how good modellers handle silhouette, bevels, trim sheets and material breakup, so our own assets improve. No paid assets.


## 18. Play and the view (asked by Connor, 2026-11-09)

- **The view grows with the city.** How far the camera can fly out, the home framing, the fog distance and the far plane scale with the tallest tower, so a 120 floor tower is never cropped and a small city is never lost in haze. Lands in the Phase 1 polish pass.
- **Elevator rides, exterior first.** A glass car or construction hoist climbs the outside of a tower; the camera rides it, each floor passing with its change, date and agent, slowing at the datum, scar floors and Claude floors, ending on the roof with the city below. In Phase 2 the hoist is the same one the crane crews use, so a ride on a tower under construction ends at the live work. Phase 2.
- **Interior rides, undecided.** He has not decided. My call: only once a floor has something to show inside (its diff, the agent's plan, the inspection), which arrives with Phase 3's analysis; until then an interior would be empty rooms. Decide at the start of Phase 3.
- **Play tailored to him, not generic gamification.** No points, badges or streak counters. Milestones become physical in the city from his own history and habits: a tower passing the city's skyline gets a lit spire, a repo revived after months gets scaffolding lights, a first PR from a new firm gets a ribbon on its floor, tours that walk through his week. Designed with him at the start of Phase 3, fed by the brief and the master net's model of what he cares about.
