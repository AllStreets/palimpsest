# Phase 2: The Market Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-11-09).** Revised after builder check round 1 (`.superpowers/sdd/2026-11-10-phase-2-market/plan-review-1.md`, NOT READY). Every Critical, Important and Minor item is fixed; the section "Builder check fixes" at the end maps each item to the task that fixes it. Tasks 6, 7, 9, 21, 22 and 23 of revision 1 are split, the order is corrected, and the tasks are renumbered (42 tasks).

**Goal:** Turn the standing city into a working economy: labelled GitHub issues become jobs, seeded firms of AI agents bid on them, the winner does the work in a sandboxed worktree through his own `claude -p`, a local Ollama model or (off by default) an Anthropic API key, an inspection guild from another firm checks it, the change ships as a PR or a push, and every real step shows in the city as construction, commuting and a tower that grows above its datum line.

**Architecture:** The engine (Node 22, SQLite) gains a market layer under `engine/market/` (jobs, firms, bids, treasury, runs, shipping) and a guild under `engine/guild/` (checks, reviewer, scope, design judge). Every model call goes through one `Provider` interface (defined in Task 1) with four backends: Claude through `claude -p`, Ollama through its HTTP API, the Anthropic API with his key (off by default), and a fake for tests and the sample economy. Agents never get a shell of their own: every command an agent runs goes through one engine-side executor (the command broker) that checks it against the guard and runs it under a strict `sandbox-exec` profile with a per-run fake home, no credentials and network only through a per-run egress proxy that allows the hosts this stage of this job needs. The claude CLI itself runs under a second, narrower profile with no shell tool, reaching the broker through an MCP tool. Runs execute in a per-run clone of the repo's bare mirror whose `.git` the agent cannot write; the engine ships from its own clean clone. A scheduler obeys the credit caps, the kill switch and the self-halt rules. The ledger is the source of truth and can be replayed. The UI (plain TypeScript and three.js) reads the same SSE stream and adds live construction, firm quarters with temperament silhouettes, the civic exchange, commuting and the exterior elevator ride to the city, plus the new screens in the established book-like UI language.

**Tech Stack:** Node 22.13+, TypeScript, tsx, `node:test`, `node:sqlite`, three.js 0.187, Vite 8, Playwright, Tauri 2, `gh`, `git`, `sandbox-exec` (macOS), `caffeinate`, `claude` CLI 2.1.319+ (his own install), Ollama 0.40+ on `127.0.0.1:11434`, launchd, ffmpeg (captures only).

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 2 in section 13; sections 6.1 to 6.4, 7, 8, 11, 12, 15 to 18 apply). The Phase 1 plan `docs/superpowers/plans/2026-11-08-phase-1-standing-city.md` fixes the conventions this plan continues.

**Starting head.** The Phase 1 polish round lands first: the tower work (`app/src/city/tower/*`) and the ambient city work (`app/src/city/grid.ts`, `facade.ts`, `materials.ts`) that another agent has in flight. Part A (engine) may start from the current phase-1 head; every Part B city task (Tasks 22 to 35) starts from the head that contains that polish round, and its executor rebases on it before Step 1. A Part B task that finds uncommitted changes under `app/src/city/` stops and asks the controller.

**CLI facts verified for this revision** (claude 2.1.319 `--help` and binary, `git config --global --list`, `ollama list` on 2026-11-09):
- `--bare` reads auth strictly from `ANTHROPIC_API_KEY` or `apiKeyHelper` and skips hooks, so it is never used.
- Listed: `--setting-sources <user,project,local>`, `--settings <file-or-json>`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode` (choices `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`), `--no-session-persistence`, `--json-schema`, `--tools`, `--disallowedTools`, `--append-system-prompt`, `--output-format stream-json`, `--verbose`. Present in the binary but not in help: `--max-turns`, `--append-system-prompt-file` (so the plan uses `--append-system-prompt` and probes `--max-turns`).
- Claude Code's own sandbox settings exist (`sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `excludedCommands`, `network.allowedDomains`, `deniedDomains`, `allowLocalBinding`, `allowUnixSockets`, `filesystem.allowWrite`, `denyWrite`, `denyRead`, `allowRead`). The `system/init` stream line carries `apiKeySource`.
- The CLI reads his login by running `/usr/bin/security find-generic-password`, so the profile around the claude process must allow exec of `/usr/bin/security`; the agent therefore gets no shell inside that profile (ruling 19).
- Global git config has `credential.https://github.com.helper = !/opt/homebrew/bin/gh auth git-credential`.
- Ollama models installed: `qwen3-coder:30b-a3b-q4_K_M`, `gpt-oss:20b`, `qwen2.5-coder:7b`, `qwen3:1.7b`, `qwen2.5vl:7b`, `llama3.1:8b`, `llama3.2:latest`, `nomic-embed-text:latest`.
- Codex CLI session logs (`~/.codex/sessions/**/rollout-*.jsonl`, `~/.codex/archived_sessions/*.jsonl`) carry `token_count` events with `rate_limits.primary` and `secondary` (`used_percent`, `window_minutes`, `resets_at`); no Gemini CLI is installed on his Mac.

## Global Constraints

- Engine API on `127.0.0.1:4770` only; UI dev server on `4771`. Ollama is reached only at `127.0.0.1:11434`, and only by the engine.
- Data directory `~/Library/Application Support/Palimpsest`, overridable with `PALIMPSEST_HOME` (every test sets it to a temp dir).
- GitHub access only through the `gh` CLI with the user's existing auth, and only from the engine process; Palimpsest never stores a GitHub token and no agent process can reach `gh`, its config, his git credential helper or the keychain items it uses.
- Never read or store Claude credentials. Agents run through the user's own installed, unmodified `claude` CLI in headless mode (`claude -p`) on his own login, through Ollama, or (off by default, only when he enters a key and assigns an agent to it) through the Anthropic API with his key. The claude child never sees `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX`, and a run aborts unless `system/init.apiKeySource` is `none`. Never a proxy of his login, never a Claude login screen.
- City budget: up to half of each five-hour window by default (`dayCapPct 50`), backing off to one Claude job when his interactive use is active; night cap `nightCapPct 20` of the weekly window; hard stop at 90% of either window (aborts Claude runs and Claude plan, review and judge calls in flight); concurrency two Claude jobs plus one local job, with a run's review and design judge held under that run's own slot and bid-time plan calls in their own small queued pool (ruling 28), so bidding never starves while runs are live; one run per repo at a time.
- Never without asking: delete a repo, force-push, rewrite history, change repo settings, secrets or visibility, touch billing, delete branches the city did not create. Enforced in code by three independent layers (Tasks 7 and 8): no credentials or GitHub reach inside any agent process, the guard on every command and file tool call, and the sandbox profiles.
- Gates before any merge or push: the repo's own tests, type check, lint and build (a missing check is never a pass), a reviewer from a different firm, a design check with before and after screenshots for UI changes, the diff inside the job's scope.
- Kill switches: the stop file (`paths().stop`), the per-repo market switch, the global Settings switch. A set stop file stops new runs at once and kills running ones within 5 s.
- Self-halt: three failed inspections in a row on a repo, or any revert of a city merge, halts the market on that repo until he clears it.
- No loops: jobs come only from issues people wrote (the `palimpsest` tier labels) or from his direct request; the baseline harness job (ruling 23) is proposed and waits for his click. The city's own PRs, merges and comments never create jobs. `docs/SELF_RECURSION_GUARDRAILS.md` documents the trigger graph.
- Ledger: every job, bid, award, run stage, diff, check, inspection, shipment, payment, firm and agent seeding, hire, sale and halt is recorded append-only (kinds from `LEDGER_KINDS`, Task 1) and replayable.
- Writes to the API require header `x-palimpsest: 1`. No sandboxed process can reach the engine port.
- No em dashes or `--` in UI copy, README or commit messages he reads. No emojis anywhere. No AI look: no card kits, glow, caps eyebrows, generic AI fonts or buttons; sentence case; hairline rules; real content.
- Every visible change: build, screenshot at full size plus zoomed crops, critique, iterate (at least three rounds for 3D work, two for screens) before showing. Record rounds and what is still weak in the commit body.
- README and captures use only the sample dataset (Task 21's sample economy), never his private repos or session content.
- 3D assets: own code and scripted Blender first; CC0 and CC-BY allowed, each recorded in `CREDITS.md`; no paid assets.
- Fake life is a failure: every crane, spark, searchlight, commuter persona, persona cab and lit floor corresponds to a ledger entry the UI can show. Ambient traffic and crowds are unlabelled atmosphere only.

## Test safety rules (apply to every task)

1. No test, UI test or capture ever binds port 4770 or talks to an engine on it. Node tests use port 0; `tools/ui-test.ts` uses 4779; `tools/capture.ts` uses 4789; the sample engine smoke check uses 4790.
2. No test ever reads or writes the real data home. Every test sets `PALIMPSEST_HOME` to a fresh temp dir and restores it in `afterEach`. `isRealDataHome()` (moved to `engine/home.ts` in Task 1) keeps refusing the real home in `tools/sample.ts` and now also in `sandbox.wrap()` when the sandbox is off.
3. No test ever touches the real `~/.claude/settings.json`, `~/.claude.json` or `~/.claude/projects`: server tests pass `claudeSettingsPath` to a temp file; `PALIMPSEST_CLAUDE_SETTINGS` is cleared in `beforeEach`; the transcript reader and the interactive-use detector read `PALIMPSEST_CLAUDE_PROJECTS` (Task 3) and tests point it at a temp dir; the Codex and Gemini readers read `PALIMPSEST_CODEX_HOME` and `PALIMPSEST_GEMINI_HOME` (Task 19).
4. No test ever spawns the real `claude`, `ollama`, `gh`, `security`, `caffeinate` or Playwright against a real repo. All of them go through `getRunner()` / `getSpawner()` (Task 6) and tests install fakes. The sandbox tests that do run `sandbox-exec` run `/bin/sh` or `/usr/bin/curl` under a generated profile inside a temp dir and are skipped where `sandbox-exec` is missing.
5. Real `git` is allowed in tests only against bare repos the test creates under its temp dir. No test ever pushes outside its temp dir.
6. Market tests use the fake provider (Task 6) with scripted outcomes; no model is ever called. The fake provider is also what the sample economy (Task 21) runs on, so captures never spend his plan. Anthropic API backend tests use a fake HTTP server on port 0 and a dummy key; no key is ever read from his keychain in a test.
7. A test that needs a worktree run without `sandbox-exec` sets `PALIMPSEST_SANDBOX=off` for that test only, under a temp `PALIMPSEST_HOME` (the engine refuses `off` on the real home); the profile text itself is tested as text (Task 7).
8. Timers: the scheduler, the egress proxy's idle timer and the sample clock take an injected `now()` and tick on demand in tests (`tick()`), never on wall-clock intervals.
9. `seedFirms()` runs only from `engine/main.ts`; `startServer()` never calls it, so server tests and `npm run ui-test` never run `ollama list`.
10. The opt-in smoke run (Task 11) is the only code that runs the real `claude -p`; it is a script, not a test, runs only with `PALIMPSEST_SMOKE=1` and his go-ahead, and is never part of `npm test`.

## Rulings on spec gaps (made here, listed again in the final report)

1. **Credits unit.** One credit is one tenth of one percent of the five-hour window: `CREDIT_PCT = 0.1`, so a window is 1,000 credits and the default day cap is 500 credits per window. Local model credits: `seconds * (0.001 + 0.0001 * modelGB)`.
2. **Plan calibration prior and per-model multiplier.** Weighted tokens are `(input + 5 * output + 0.1 * cacheRead + 1.25 * cacheCreation) * MODEL_WEIGHT[family]`, with `MODEL_WEIGHT = { haiku: 0.2, sonnet: 0.6, opus: 1, fable: 1 }` taken from the list price ratios (an unknown family counts as `opus`). Until measured, `DEFAULT_TOKENS_PER_PCT = 60_000` weighted tokens per percent of the five-hour window. Calibration (Task 3) pairs consecutive readings in the same window and divides his transcript tokens plus city tokens between them, both weighted per model, by the percent delta. Treasury shows it as measured or assumed.
3. **Job value tiers.** `low 20`, `normal 60`, `high 150` credits, from labels `palimpsest:low` and `palimpsest:high`; `palimpsest` alone is normal; with more than one tier label the highest wins. `gh issue list --label` ANDs its labels, so the engine queries each of the three labels separately and merges by issue number. Value is the bid ceiling.
4. **Calibrated pass probability (the award).** `calibrated = confidence * (1 - overclaim)`, where `overclaim` is the mean of `(confidence - outcome)` over the firm's last 20 resolved bids clamped to `[0, 1]`, and `NEW_FIRM_OVERCLAIM = 0.15` with no history. The appraiser net arrives in Phase 4; in Phase 2 the city's own estimate shown beside each bid is the firm's pass rate for that size (null when unknown), stored in `Bid.appraisal`.
5. **Reputation score and era.** `score = 0.5 * passRate + 0.3 * (1 - brier) + 0.2 * durability` with unknown terms at 0.5. Era by score on half-open ranges: `[0, 0.35)` stone, `[0.35, 0.5)` brick, `[0.5, 0.65)` glass, `[0.65, 0.8)` titanium, `[0.8, 1]` scifi, capped by the agent's `capability` era (opus, fable and sonnet scifi, haiku titanium, 30B local titanium, 20B local titanium, 7B local glass, 1.7B local brick, Anthropic API agents by their model family).
6. **Firm money.** Starting balance 300 credits per seeded firm. A bid costs the firm what the plan call cost. On merge the firm is paid its price; on failure it keeps the cost. Negative for 72 hours continuously means bankrupt. The reviewer is paid 5% of the job's value by the city, once, by the treasury on `inspection.done` (Task 17); `review()` itself moves no money. A dark tower sells at `2 * floors + 20` credits to the richest active firm with at least `price + 100` at the daily tick; the buyer re-clads it. Hiring in Phase 2 draws from a hand-written roster of specialist personas (the school breeds them in Phase 4): fee 80 credits, allowed when balance is above 400 and open jobs outnumber the firm's idle agents, at most four towers per quarter.
7. **Where construction shows, and one run per repo.** The crane and the work stand on the repo's district tower (the job site) above its datum. A repo has at most one run in a live stage at a time (one crane per job site, no conflicting branches on one base); other awarded jobs on it wait in `awarded`. On merge, one floor is laid there and one on the agent's own tower in its firm's quarter. A failed inspection leaves a scar floor on the job site only. A run that never produced a diff (crash, cap, kill) leaves no scar; its scaffolding comes down.
8. **The worktree.** Each run gets a local clone of the repo's bare mirror made with `git clone --local --no-hardlinks` at `<home>/runs/<runId>/repo`, on branch `palimpsest/<jobId>`. Its `origin` fetch URL is the GitHub URL and its push URL is `no-push://palimpsest` (invalid on purpose). No agent process has push credentials: children run with a per-run fake `HOME`, `GIT_CONFIG_GLOBAL` pointing at an empty per-run file (so his `gh auth git-credential` helper is never loaded), `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, and no `GH_TOKEN`/`GITHUB_TOKEN`. The engine ships from its own clone (ruling 20).
9. **Sandbox (rewritten after the builder check).** Two generated `sandbox-exec` profiles, both deny-by-default, both tested as text and by execution:
   - **Tool profile** (every command an agent runs, the install stage, every check, the push-mode recheck): reads allowed on the system (`/System`, `/usr`, `/bin`, `/sbin`, `/Library`, `/opt/homebrew`, `/private/etc`, `/dev`), toolchains under his home by exact path (`~/.nvm`, `~/.cargo/bin`, `~/.rustup`, `~/go/bin`, `~/.pyenv`, `~/.local/bin` when present), then `deny file-read*` of his home (which contains the data home), then explicit `allow file-read*` of `<runRoot>/repo`, `<runRoot>/ship` (the engine's ship clone, Task 16), `<runRoot>/base` (the design check's base checkout, Task 15), `<runRoot>/tmp`, `<runRoot>/home`, `<runRoot>/cache` and `<runRoot>/ctl` placed after the deny (later rules win; Task 7 tests this order by execution). `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.gitconfig`, `~/.claude`, `~/.claude.json` and `~/Library/Keychains` are thereby unreadable and are also denied by name as a guard against a later edit. Writes only to `<runRoot>/repo`, `<runRoot>/ship` and `<runRoot>/base` (each with its `.git/**` denied after the allow), `<runRoot>/tmp`, `<runRoot>/home` and `<runRoot>/cache`; `<runRoot>/ctl` is read-only. A baseline (Task 14) is computed in its own run root (`<home>/runs/baseline-<repoSlug>-<sha7>`) under a profile generated for that root, never in a shared directory. Exec denied for `/usr/bin/security`, any `gh` (regex `/gh$`), `/usr/bin/osascript`, `/usr/bin/sudo`, `/bin/launchctl`, `/usr/bin/open`; because a renamed copy of a binary dodges an exec rule, the profile also denies `mach-lookup` of `com.apple.SecurityServer` and `com.apple.securityd` (no keychain access from any tool process, whatever binary asks). Network: outbound only to this run's egress proxy port and to loopback ports other than the reserved ones: the engine port, `11434`, and the proxy and broker ports of every other run live when the profile is written are denied after the loopback allow; `network-bind` on loopback only. Every egress proxy and broker also demands this run's own credentials (ruling 21, Task 8), so a run that reaches another run's port, or one started later, is refused. Loopback cannot be closed to this run's ports alone: repos' own test suites bind ephemeral ports (Palimpsest's own tests use port 0), and Seatbelt cannot name ports by owner. Package caches are per run (`npm_config_cache`, `XDG_CACHE_HOME`, `PIP_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GOCACHE` under `<runRoot>/cache`) so no cache poisoning reaches his shared caches.
   - **CLI profile** (the `claude` process only): the same read rules, plus reads of the claude install directory, `~/.claude.json` and `CLAUDE_RUNTIME_PATHS` (`~/.claude/debug`, `~/.claude/statsig`, `~/.claude/todos`, `~/.claude/shell-snapshots`, `~/.claude/session-env`, `~/.claude/telemetry`); writes only to `<runRoot>/repo` (`.git/**` denied), `<runRoot>/tmp`, `~/.claude.json` and its backup and lock siblings, and `CLAUDE_RUNTIME_PATHS`; then `deny file-write*` of `~/.claude/settings*.json`, `~/.claude/CLAUDE.md`, `~/.claude/skills`, `~/.claude/plugins`, `~/.claude/agents`, `~/.claude/commands`, `~/.claude/hooks` and `~/.claude/projects`, and `deny file-read*` of `~/.claude/projects` and `~/.claude/history.jsonl`. Exec allowed only for the claude binary, `/usr/bin/security` (his login) and `process.execPath` (the hook and the broker client). Network: outbound only to this run's egress proxy port and broker port; every other loopback port is denied.
   - The control files (`settings.json`, `persona.md`, `mcp.json`, both profiles, the empty `gitconfig`) live in `<runRoot>/ctl/`, outside the repo dir, read-only to both profiles, so `commitAll` never sees them and the agent cannot rewrite its own hook.
   - `PALIMPSEST_SANDBOX=off` is honoured only when `isRealDataHome()` is false; on the real home `wrap()` throws and the run ends `crashed` with the reason.
   - `CLAUDE_RUNTIME_PATHS` is the list the smoke run (Task 11) confirms; any path it finds missing is added there and in this ruling before Task 41.
10. **Claude runs do not persist sessions** (`--no-session-persistence`), so city runs never write to `~/.claude/projects`; the full `stream-json` log is kept under the run directory instead. Every transcript under `~/.claude/projects` is therefore his own: the calibration counts all of it (ruling 2), and any write there in the last ten minutes means his interactive use is active (spec 17).
11. **Night.** Unattended means no app client on the SSE stream for 30 minutes, or local time between 23:00 and 07:00. The night cap counts weekly percentage points spent by Claude runs and calls started while unattended within the current seven-day window.
12. **Baselines.** "No previously passing test fails" is measured against a baseline run of the repo's checks at the run's base commit, cached per sha. A check failing both before and after is `preexisting`: it does not block a PR, it does block push mode.
13. **Design check without a way to render.** The guild screenshots every UI change it can render (ruling 24). Only when a repo has no `checks.screenshot` command and no renderable target (no web build output and no preview script, for example a Swift app) does the vision judge score the diff text alone against the design bar, and the report says so (`diffOnly`). It is never counted as a pass by omission.
14. **The river.** Commuting needs ferries, so the city gets a straight river 56 m wide centred on the street line at world x = -360 (between district block columns -1 and -2), with quays, three bridges and ferry piers. The district spiral is unchanged: a district's 90 m reserve clears the banks by 2 m. Ambient lots the river crosses become quays.
15. **The agent's tower width.** Agent towers use a 16 m floor width (district towers use 26 m) so a quarter of four reads as a cluster, not as four districts.
16. **Jobs retry once.** A failed job returns to the board once (`attempts` up to 2); the firm that failed it may not bid on it again. After the second failure it is marked failed and the issue gets the `palimpsest:failed` label. A run killed by the stop file, a hard stop or him returns the job to `open` without consuming an attempt; a crash or a cap consumes one.
17. **The datum is fixed at join.** `Repo.joinedAt` is set at the repo's first successful analysis (migrated from `analyzedAt` for repos already connected). Founding floors are built only from merged PRs and commits at or before `joinedAt`, excluding any commit with a `Palimpsest-Job:` trailer and any PR whose head branch starts with `palimpsest/`. A re-analysis (retry, reconnect) rebuilds the founding floors from that same window and keeps every floor with `founding: false` above them in its laid order, so `datumIndex` stays the founding count and earned floors survive. Earned floors live in their own table (`earned_floors`) and the tower is composed founding plus earned on read.
18. **Anthropic API key backend (off by default).** `anthropic:<model>` agents run the same local tool loop as Ollama against `https://api.anthropic.com/v1/messages` with his key, stored by the engine in his login keychain under service `Palimpsest Anthropic API key` (entered in Settings, never shown again, never passed to any child). It is off until he enters a key, turns `anthropicApi.enabled` on and assigns an agent to an `anthropic:` model; no seeded agent uses it. Spend is in dollars from the API's `usage` and the list prices, converted at `CREDITS_PER_USD = 20` for the firm's books, and capped separately by `anthropicApi.dailyUsd` (default 5 once enabled); it never counts against his plan windows.
19. **The command broker.** No agent gets a shell inside a process that can read his login. The claude CLI runs with `--tools "Read,Edit,Write,Glob,Grep"` and one MCP tool, `mcp__palimpsest__run`, served by `engine/market/broker-mcp.mjs` (plain JS, started by the CLI under the CLI profile) which forwards each call over loopback with a per-run bearer token to the engine's broker. The broker, the Ollama loop and the Anthropic loop all execute commands through one function, `execTool()`, which checks `forbidden()` and then runs the command under the tool profile. Claude Code's own Bash sandbox was considered (builder check item 4): Seatbelt profiles do not reliably nest, and the CLI profile must allow `/usr/bin/security`, so the broker is the primary design; the smoke run records whether a nested `sandbox.enabled` with `failIfUnavailable: true` works and, if it does, Task 11 turns it on as a fourth layer.
20. **The engine ships from its own clone.** For every shipment the engine makes `<runRoot>/ship` by `git clone --local --no-hardlinks <mirror>`, fetches the run branch from the run dir as data (`git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.file.allow=always fetch <runDir> refs/heads/<branch>`), checks that the fetched tip equals `run.headSha` (recorded by the engine at `commitAll`), and pushes that sha by name with hooks and fsmonitor disabled. Every engine git command in a run dir or ship clone carries `-c core.hooksPath=/dev/null -c core.fsmonitor=false` and `GIT_CONFIG_NOSYSTEM=1`.
21. **Egress per stage.** Each run has its own HTTP CONNECT proxy (`engine/market/egress.ts`) on a loopback port. Its allowlist changes by stage: `install` allows the registries of the ecosystems the repo uses (npm `registry.npmjs.org`; Python `pypi.org`, `files.pythonhosted.org`; Rust `index.crates.io`, `static.crates.io`, `crates.io`; Go `proxy.golang.org`, `sum.golang.org`); `working` allows those registries plus the model provider for Claude runs (`api.anthropic.com` and the hosts the smoke run shows his login refresh needs, recorded in `CLAUDE_HOSTS`); `checks`, `design` and the push-mode recheck allow nothing. Every CONNECT is logged to the run log as allowed or refused. The proxy demands `Proxy-Authorization` with this run's own token (carried in the proxy URL the run's environment gets), so no other run can use it. That is "network only to what the job needs" (spec 7.5).
22. **Agents are genomes.** An agent carries Beagle's genome fields (`instructions`, `tools`, `workflow: { shape: 'single' | 'plan-then-answer' | 'self-check' | 'vote'; n? }`, `memory: { examples: 0..8 }`) plus `lineage: { origin: 'seeded' | 'roster' | 'school'; parents: string[]; generation: number }`. `toGenome(agent)` returns a value Beagle's `validate()` accepts (model as `claude:` or `ollama:`; `anthropic:` maps to `claude:` with a note). The runner honours the workflow shape (Task 13) and includes `memory.examples` of the firm's own merged job summaries in the work prompt.
23. **The baseline harness job.** When analysis (or check detection) finds a repo with no test or no build command, the engine posts a `proposed` job "Add a baseline test and build harness" with tier normal and scope `['**']`. A proposed job never bids until he accepts it (job board or district page), so the no-loop rule holds; dismissing withdraws it. Push mode stays unavailable on that repo until both commands exist.
24. **Screenshots for his repos.** The design check renders before and after in this order: `checks.screenshot` (a script that writes `PALIMPSEST_SHOT`), else a detected preview: a Vite, Next, Astro or plain static web app is built with `checks.build` and served from its output (`dist/`, `build/`, `out/`, or a root `index.html`) by a static server inside the tool profile on a loopback port, then shot by the engine's Playwright at 1440 x 900 for each route in `checks.shots` (default `['/']`, editable on the district page). Ruling 13 applies only when neither path exists.
25. **Silhouettes.** Each agent has a `silhouette` derived from its temperament (spec 6.2): `lens` for careful reviewers (each earned floor rotates 1.5 degrees on the one below and the roof carries a glazed lens crown that grows a ring every five floors), `cantilever` for fast builders (every third earned floor steps out 3 m, alternating sides, on visible steel brackets), `needle` for specialists (earned floors taper to 60% of the base width over twenty floors and end in a spire), `plain` otherwise. Seeds: Ashlar & Vane lens, Quickset cantilever, Meridian needle, Kiln and Sparrow plain, roster specialists needle.
26. **Commute modes.** Six trip modes, matching `TripMode`: `walk`, `tram`, `rail` (elevated rail on a viaduct loop at 12 m around the district ring), `pod` (maglev pods on two cross lines at 18 m), `ferry`, `cab` (an autonomous cab summoned for that persona, so it carries the persona's plate). The ride's hoist (Task 35) is not a trip mode. Choice in `route()`: under 150 m walk; crossing the river with piers within 200 m of both ends ferry; under 700 m tram; 700 to 1,500 m cab; over 1,500 m pod when a pod line passes within 300 m of both ends, else rail.
27. **Keep-awake.** With `keepAwake` on (default off), the engine runs `caffeinate -i -w <enginePid>` while any run or call is live and kills it when the last ends (Task 13); the treasury screen says when the assertion is held.
28. **Lease pools.** Concurrency is counted per pool: `claude` runs (`claudeConcurrency`, 1 while he is active), `local` runs (`localConcurrency`), `api` runs and calls (the dollar cap), and a `plan` pool for bid-time plan calls (two Claude and one local plan call at a time, independent of the run slots, still charged to the caps). A plan call that finds its pool full waits in a FIFO queue until a slot frees or the job's bid window closes (then the agent sits out with "no slot before the window closed"). A run's reviewer and design judge calls are leased under the run's own work slot (`lease.sub(kind)`), so a finishing run can always be inspected. Every lease carries an `AbortController`; entering `hard` or `stopped` aborts every Claude lease in flight (runs, plan, review and judge calls), and `stopped` aborts local and API leases too.
29. **Agent file tools never run in the engine.** For Ollama and API agents, `read_file`, `write_file`, `edit_file`, `list_files` and `search` run through the broker as `node <repo>/engine/market/file-tool.mjs` under the tool profile, exactly like `run`, so the sandbox, not the engine, bounds them. The helper and the hook both resolve the `realpath` of the target and of every parent, refuse any symlink on the path (a symlink inside the repo is listed but never followed), and open files with `O_NOFOLLOW`; a target outside `dir` or inside `dir/.git` is refused. Claude's own file tools run inside the CLI profile and are checked by the hook with the same `pathAllowed()`.
30. **A halt keeps a waiting PR waiting.** A job halted from `waiting` (its PR still open) records `haltedFrom` and resumes to `waiting`, never to `open`, so a resume never re-bids work whose PR is still on GitHub; a job halted from any other status resumes to `open`.

## Review Focus

1. The stop file appears while two Claude runs and a local run are mid-flight: every child process (claude, broker commands, checks) is killed within 5 s, the runs end as `killed` with no scar, no payment moves, no attempt is consumed, and the scaffolding comes down in the city.
2. A reading older than five hours with jobs queued: Claude runs and Claude plan calls pause with a visible reason in Treasury and on the job board, local runs continue, and a fresh reading resumes them without a restart. Clearing the stop file starts the market again without a restart.
3. A `claude -p` process that prints malformed or truncated `stream-json` (crash, SIGKILL, disk full), or whose `system/init` shows an `apiKeySource` other than `none`: the run ends as `crashed`, the partial log is kept, the job returns to the board, nothing is pushed.
4. A PR he closes without merging, and a merge he later reverts: the first clears the waiting floor without a scar and pays nothing; the second lights the durability flag, halts that repo, and shows the halt in Treasury and on the district.
5. A firm's last agent is retired by bankruptcy while a persona of its is mid-commute: the trip ends, the tower goes dark that frame, and the follow camera (if following) releases to the city.
6. An agent that writes a git hook, edits `.git/config`, runs `node -e "require('child_process').execSync('git push --force origin HEAD:main')"`, reads `~/.config/gh/hosts.yml`, runs `security find-generic-password`, edits `~/.claude/settings.json` through the Edit tool, posts to the engine port or to another run's proxy or broker, makes a symlink to `~/.config/gh/hosts.yml` and reads it with `read_file`, or writes through a symlink to `~/.claude/settings.json`, `~/.zshrc` or `.git/config` with `write_file` or Edit: every one is refused by at least two layers, the run log shows the refusals, and the engine's own later git commands in that run dir run no agent code.
7. Re-analysing a repo that has earned floors: the earned floors, their order and the datum height are unchanged, and no city merge appears below the datum.

---

## File Structure

```
shared/types.ts                 + Job, Tier, Bid, Firm, Agent (genome, lineage, silhouette), Run, Inspection, CheckResult,
                                  Reputation, BudgetWindow, TreasuryState, Quarter, SiteState, Trip, ProviderUsage types;
                                  Floor.founding: boolean; EarnedFloor; Repo.joinedAt
shared/credits.ts               pure: weighted tokens with model weights, credits, local and API credits, calibration maths
shared/market-rules.ts          pure: tiers, EV, calibration, reputation score and era, bankruptcy, sale price, transitions
shared/ledger-kinds.ts          LEDGER_KINDS, the closed list every record uses
shared/silhouette.ts            pure: temperament to silhouette, per-floor offsets, twist, taper and crown parameters
shared/commute.ts               pure: the transit network, routing and mode choice, trip durations
shared/ride.ts                  pure: elevator ride keyframes from a tower layout
engine/home.ts                  + paths().runs, paths().reports, isRealDataHome()
engine/db.ts                    + market tables and migrations
engine/exec.ts                  + Spawner (streaming child processes) and setSpawner
engine/ledger.ts                + record() validates the kind
engine/usage.ts                 + transcript tokens, calibration, interactive-use detector
engine/repos.ts                 + joinedAt, founding window, earned floors kept, slots table, checks fields
engine/providers-usage.ts       OpenAI or Codex and Gemini usage readers for Settings
engine/market/provider.ts       the Provider interface and input and output types (no backends)
engine/market/budget.ts         the city treasury: windows, caps, back-off, night, staleness, concurrency leases, SSE count
engine/market/firms.ts          seeds, personas, genomes, lineage, silhouettes, quarters, hiring, bankruptcy, dark tower sales
engine/market/personas/*.md     one persona file per seeded agent and per roster specialist
engine/market/reputation.ts     pass rate by size, Brier, durability, era (reads the ledger)
engine/market/jobs.ts           issues to jobs, manual and proposed jobs, the transition table, no-cycle filters
engine/market/bids.ts           bidding window, plan calls, award by expected value
engine/market/fake-provider.ts  the scripted fake backend
engine/market/claude.ts         the claude -p backend
engine/market/toolloop.ts       the local tool loop shared by Ollama and the Anthropic API, and the vision judge
engine/market/ollama.ts         the Ollama transport
engine/market/anthropic-api.ts  the Anthropic API transport and keychain access (engine only)
engine/market/providers.ts      providerFor(model), setProvider()
engine/market/guard-core.mjs    forbidden() and pathAllowed() in plain JS (shared by the hook and the engine)
engine/market/guard-core.d.mts  its types
engine/market/guard.ts          typed re-export plus FORBIDDEN_REASONS copy
engine/market/guard-hook.mjs    the PreToolUse hook claude -p runs (plain JS, imports guard-core.mjs)
engine/market/broker.ts         execTool() and the per-run loopback broker server
engine/market/broker-mcp.mjs    the stdio MCP server claude starts; forwards run calls to the broker
engine/market/file-tool.mjs     file reads, writes, edits, lists and searches for the local tool loop, run under the tool profile
engine/market/sandbox.ts        tool and CLI profile text, wrap(argv, kind) helper
engine/market/egress.ts         the per-run CONNECT proxy with a per-stage allowlist
engine/market/worktree.ts       per-run clone, branch, fake home, control dir, commitAll, diffOf, cleanup
engine/market/install.ts        dependency install stage per ecosystem
engine/market/runs.ts           scheduler, stages, workflow shapes, progress, kill switch, keep-awake, crash recovery
engine/market/ship.ts           ship clone, PR mode, push mode, PR polling, revert watch, floors
engine/market/treasury.ts       firm balances, payments, costs, the city's spend ledger
engine/market/report.ts         the daily report (markdown) and its API shape
engine/market/replay.ts         rebuilds market state from the ledger
engine/market/trips.ts          persona trips from real events
engine/market/sample-economy.ts the scripted economy for captures and UI tests
engine/guild/checks.ts          detect a repo's test, typecheck, lint, build, screenshot and preview; run a check
engine/guild/baseline.ts        baselines per sha, the harness proposal
engine/guild/inspect.ts         runs the checks against a baseline, scope, design, verdict
engine/guild/review.ts          reviewer selection and the review call
engine/guild/design.ts          before and after screenshots and the vision judge
engine/guild/design-bar.md      his design bar, for the vision judge
engine/server.ts                + market routes and events
tools/smoke-claude.ts           the opt-in sandboxed claude -p smoke run
docs/SELF_RECURSION_GUARDRAILS.md  trigger graph and no-cycle proof
app/src/api.ts                  + market calls and event types
app/src/router.ts               + routes with ids
app/src/city/tower/eras.ts      + scar primer floor, cured-unlit floor, earned floor accent
app/src/city/tower/build.ts     + agent towers (width option), dark towers, silhouettes
app/src/city/tower/crowns.ts    lens crown and needle spire for agent towers
app/src/city/quarters.ts        firm quarters in the city
app/src/city/exchange.ts        the civic exchange hall at (0,0)
app/src/city/construction.ts    crane, skeleton, welding, netting, hoist mast, searchlights, cure, teardown, scar
app/src/city/river.ts           river, quays, bridges, piers
app/src/city/transit.ts         tram lines, elevated rail, pod rail, stops, stations, cab ranks
app/src/city/vehicles.ts        trams, rail trains, pods, ferries, cabs
app/src/city/ambient.ts         ambient traffic and crowds
app/src/city/people.ts          agent persona figures, walk cycle, trips, follow camera, lantern marker
app/src/city/ride.ts            the exterior elevator ride (camera and captions)
app/src/ui/{jobs,job,firms,firm,agent,run,inspection,treasury,repo}.ts   new screens
app/src/ui/market.css           styles for the new screens
tools/sample.ts                 + --economy
tools/ui-test.ts, tools/capture.ts  + market checks and shots
test/*.test.ts                  node:test suites per task
```

## Pre-flight conflict table

One row per pair of tasks that share a file or an interface, and the resolution the plan fixes. Executors copy this table into the SDD ledger and add rows for anything found during implementation.

| Tasks | Shared | What one produces against what the other consumes | Resolution |
|---|---|---|---|
| 1, 2, 22 | `Floor.founding`, `EarnedFloor`, `earned_floors` | Task 1 widens `founding` to `boolean` and adds `earned`; Task 2 composes towers from founding plus earned; Task 22 draws by `earned.state` | Phase 1 literal checks become `=== true` in Task 1; Task 22 reads no field Task 1 did not add |
| 1, 20 | `shared/types.ts` vs route bodies | Routes serialize exactly these types | Task 20 adds no fields; a missing field is a Task 1 fix |
| 1, all engine tasks | `LEDGER_KINDS`, `record()` | Task 1 creates the closed list and makes `record()` refuse unknown kinds | Every later task records only members; a task needing a new kind adds it to `shared/ledger-kinds.ts` in its own commit and to the replay switch in Task 18 |
| 1, 6 to 10, 12 to 15 | `Provider` and its input types | Task 1 freezes the interface in `engine/market/provider.ts`; Tasks 6, 9 and 10 implement it; bids, runs and the guild call it | No task changes the interface; a needed change is a Task 1 fix recorded in the ledger |
| 2, 16 | `earned_floors`, `layFloor`, `removeFloor` | Task 2 creates the table and composition; Task 16 lays, lights, scars and removes | Task 16 writes earned floors only through Task 2's functions |
| 3, 13, 17, 39 | `TreasuryState`, leases | budget produces it and the leases; runs and calls lease; treasury pays within it; the screen shows it | One shape in Task 1; Task 3 owns the computation and `noteSseClients()` (called by the server); Task 17 owns firm balances only |
| 3, 12, 15, 13 | `acquire()` leases | bids, reviews, judges and runs all take a lease before calling a model | `mayStart()` is internal to budget; bids use `acquire(model, 'plan', …, { waitUntil })`, runs use `acquire(model, 'work', …)`, reviews and judges use the run lease's `sub()` (ruling 28) |
| 4, 23, 24, 28 | `Quarter`, `TowerSpec.kind 'agent'`, `Agent.silhouette` | firms produce quarters and silhouettes, the city draws them, bankruptcy darkens and re-clads them | `Quarter.towers[]` carries `dark`, `firmId`, `silhouette`; Task 28 changes data only through Task 17's functions |
| 5, 12, 13, 16 | `JobStatus` transitions | jobs opens, bids awards, runs runs, ship closes | `transition(job, to)` in Task 5 is the only place a status changes; the legal table lives in `shared/market-rules.ts` (`LEGAL_MOVES`) |
| 6, 9, 10 | `Spawner`, `setProvider` | Task 6 makes the spawner and the fake; Tasks 9 and 10 add backends to `providers.ts` | `providerFor()` lives in Task 6; Tasks 9 and 10 register by `kind` |
| 7, 8, 9, 10, 14, 15, 16 | `sandbox.wrap()`, `execTool()`, `egress` | every child runs wrapped; every agent command goes through `execTool()` | `wrap()` returns argv; nothing spawns `sandbox-exec` directly; nothing but `execTool()` runs an agent's command |
| 7, 16 | run dir vs ship clone | worktree makes the run dir and records nothing pushable; ship makes its own clone | Ship never runs git with the run dir as its working directory except `fetch` from it as a path |
| 8, 9 | `guard-hook.mjs`, `broker-mcp.mjs` | Task 8 writes both scripts; Task 9 points the CLI's settings and MCP config at them | Paths come from `controlFiles(runId)` in Task 7 |
| 13, 14, 15 | `inspect()`, `installDeps()` | runs call install and inspect as injected functions | Task 13 tests use stubs; the real ones land in Tasks 14 and 15 and are wired in Task 15's last step |
| 15, 16 | `Inspection.passed`, `pushable` | ship requires passed; push mode additionally requires pushable | Both rules live in `inspect.ts` as `canOpenPR()` and `canPush()` |
| 16, 17 | merge event | ship records `job.changed` to merged; treasury pays on that ledger kind | Treasury subscribes to the event bus, never to ship directly |
| 15, 17 | reviewer pay | the guild records `inspection.done` with `reviewerAgentId`; treasury pays the share | `review()` moves no money (builder check: double payment) |
| 4, 18 | firm seeding | firms records `firm.seeded` and `agent.seeded`; replay rebuilds firms from them | Replay never reads the firms table to build firms |
| 20, 36 to 40 | `api` client | screens call only what Task 20 added | Screens add no fetches of their own |
| 21, 42 | sample economy | captures and UI tests seed it | `seedEconomy()` and `economyClock()` are the only entry points |
| 21, 33 | sample trips | the economy seeds trips before routing exists | Task 21 stores hand-written legs; Task 33 switches the seed and the clock to `startTrip()` |
| 26, 27, 35 | `construction.ts` hoist mast | the ride reuses the crane's hoist | Task 26 exports `makeHoist()`; Task 35 only positions it |
| 29, 30, 31, 33 | `shared/commute.ts` network | river, rails and cab ranks are drawn from the same network the engine routes on | The river constants land in Task 29, the network and `route()` in Task 30; both sides import them |
| 31, 32 | `vehicles.ts` vs `ambient.ts` | persona vehicles vs unlabelled ambient | Ambient code never imports trips; persona cabs are built in `vehicles.ts` only |
| 22 to 35, Phase 1 polish | `app/src/city/tower/*`, `grid.ts`, `facade.ts`, `materials.ts` | the polish round edits these files now | Part B starts from the head that contains the polish round (see "Starting head") |
| 40, Phase 1 `repos.ts` push note | push mode note | the note said "takes effect when the market opens" | Task 40 replaces the note in the UI; engine `repos.ts` edits stay in Tasks 2, 4 and 14 |
| 13, Phase 1 `main.ts` | `failInterruptedAnalyses()` | runs add `failInterruptedRuns()`, `seedFirms()` and `scheduler.start()` at startup | Task 13 adds the three calls; `startServer()` stays free of them |

Known cross-task orderings: Task 1 before everything; Task 6 before Task 12 (bids test with the fake); Task 7 before Task 8 (the broker wraps); Tasks 7 and 8 before Task 9 (the CLI backend needs the control files, the hook and the broker); Task 11 before Task 41; Task 21 before Task 22 (the city tasks need something to show); Task 26 before Tasks 27 and 35; Task 29 before Task 30; Task 30 before Tasks 31 and 33; Task 33 before Task 34.

## Model marks

Each task is marked for the implementer model per the controller's routing: **[Opus]** for every build task, engine, integration and visual alike; **[Sonnet]** for mechanical tasks whose brief carries the full interface. Reviews of logic and of visual work go to Opus; scoped re-reviews to Sonnet.

---

## Part A: the engine of the market

### Task 1: Market types, schema, ledger kinds and the Provider interface [Opus]

**Files:**
- Modify: `shared/types.ts`, `engine/db.ts`, `engine/ledger.ts`, `engine/home.ts`, `tools/sample.ts` (imports `isRealDataHome` from `engine/home.ts`)
- Create: `shared/market-rules.ts`, `shared/credits.ts`, `shared/ledger-kinds.ts`, `engine/market/provider.ts`
- Test: `test/market-types.test.ts`, `test/credits.test.ts`, `test/market-rules.test.ts`, `test/ledger.test.ts`; update `test/history.test.ts`, `test/sample.test.ts`, `test/tower-build.test.ts` where `founding: true` is asserted as a literal type

**Interfaces:**
- Produces (`shared/types.ts`):
  ```ts
  export type Tier = 'low' | 'normal' | 'high';
  export type JobSource = 'issue' | 'manual' | 'harness';
  export type JobStatus = 'proposed' | 'open' | 'bidding' | 'awarded' | 'running' | 'inspecting' | 'shipping' | 'waiting' | 'merged' | 'failed' | 'closed' | 'halted' | 'withdrawn';
  export interface Job { id: string; repo: string; source: JobSource; issue: number | null; url: string | null; title: string; body: string;
    scope: string[]; acceptance: string[]; tier: Tier; value: number; status: JobStatus; attempts: number; postedAt: string;
    bidsCloseAt: string | null; awardedBid: string | null; runId: string | null; floorId: string | null; closedAt: string | null; excludedFirms: string[]; haltedFrom: JobStatus | null; }
  export type ModelRef = `claude:${string}` | `ollama:${string}` | `anthropic:${string}` | `mlx:${string}`;
  export type WorkflowShape = 'single' | 'plan-then-answer' | 'self-check' | 'vote';
  export type Silhouette = 'lens' | 'cantilever' | 'needle' | 'plain';
  export interface Agent { id: string; firmId: string; name: string; model: ModelRef; persona: string; temperament: string;
    instructions: string; tools: string[]; workflow: { shape: WorkflowShape; n?: number }; memory: { examples: number };
    lineage: { origin: 'seeded' | 'roster' | 'school'; parents: string[]; generation: number; at: string };
    silhouette: Silhouette; maxTurns: number; capability: Era; bidsOn: Tier[]; retired: boolean; retiredReason: string | null; towerIndex: number; }
  export interface Firm { id: string; name: string; root: RootStyle; motto: string; slot: number; balance: number;
    status: 'active' | 'bankrupt'; negativeSince: string | null; bankruptAt: string | null; createdAt: string; }
  export interface Bid { id: string; jobId: string; firmId: string; agentId: string; plan: string; price: number; confidence: number;
    calibrated: number; appraisal: number | null; ev: number; cost: number; at: string; }
  export type RunStage = 'preparing' | 'installing' | 'working' | 'inspecting' | 'shipping' | 'waiting' | 'done';
  export type RunOutcome = 'merged' | 'failed' | 'closed' | 'killed' | 'capped' | 'crashed' | null;
  export interface RunProgress { toolCalls: number; filesChanged: number; testsRun: number; turns: number; weightedTokens: number; credits: number; refusals: number; }
  export interface Run { id: string; jobId: string; bidId: string; agentId: string; firmId: string; repo: string; model: ModelRef; branch: string;
    dir: string | null; baseSha: string | null; headSha: string | null; stage: RunStage; outcome: RunOutcome; endedReason: string | null; progress: RunProgress;
    startedAt: string; endedAt: string | null; prNumber: number | null; prUrl: string | null; mergeSha: string | null; inspectionId: string | null;
    scar: boolean; unattended: boolean; }
  export type CheckName = 'install' | 'test' | 'typecheck' | 'lint' | 'build' | 'review' | 'scope' | 'design';
  export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'preexisting';
  export interface CheckResult { name: CheckName; status: CheckStatus; detail: string; durationMs: number; logPath: string | null; testsRun: number | null; }
  export interface Inspection { id: string; runId: string; jobId: string; repo: string; reviewerAgentId: string | null; reviewerFirmId: string | null; checks: CheckResult[];
    passed: boolean; pushable: boolean; design: { before: number | null; after: number; diffOnly: boolean; shots: Array<{ route: string; before: string | null; after: string | null }> } | null; cost: number; at: string; }
  export interface Reputation { firmId: string; passRate: Record<FloorSize, number | null>; passRateAll: number | null; brier: number | null;
    durability: number | null; overclaim: number; score: number; samples: number; era: Era; }
  export interface BudgetWindow { capPct: number; cityPct: number; usedPct: number | null; estimatedPct: number; resetsAt: number | null; }
  export interface TreasuryState { tokensPerPct: number; calibrated: boolean; samples: number; fiveHour: BudgetWindow; sevenDay: BudgetWindow;
    night: { capPct: number; usedPct: number; unattended: boolean }; interactiveActive: boolean;
    paused: null | { reason: 'stopped' | 'stale' | 'cap' | 'night' | 'hard'; detail: string };
    concurrency: { claude: number; local: number; api: number; claudeMax: number; localMax: number };
    api: { enabled: boolean; spentUsdToday: number; dailyUsd: number }; keepAwake: { on: boolean; held: boolean };
    citySpent: { today: number; week: number }; }
  export interface EarnedFloor { jobId: string; runId: string; agentId: string; firmId: string; state: 'waiting' | 'lit' | 'scar'; reverted: boolean; }
  // Floor: `founding: boolean` (was the literal true) and `earned?: EarnedFloor`.
  // TowerSpec: `kind: 'founding' | 'agent'`, `firmId?: string`, `agentId?: string`, `dark?: boolean`, `silhouette?: Silhouette`.
  export interface Quarter { firmId: string; slot: number; origin: { x: number; z: number }; root: RootStyle; dark: boolean; towers: TowerSpec[]; }
  export type SiteStage = 'crane' | 'framing' | 'inspecting' | 'curing' | 'waiting' | 'teardown' | 'scar';
  export interface SiteState { repo: string; runId: string; jobId: string; agentId: string; firmId: string; stage: SiteStage; progress: number; size: FloorSize; since: string; }
  export type TripMode = 'walk' | 'tram' | 'rail' | 'pod' | 'ferry' | 'cab';
  export type TripReason = 'bid' | 'job' | 'inspect' | 'home';
  export interface Trip { id: string; agentId: string; firmId: string; reason: TripReason; jobId: string | null; from: { x: number; z: number }; to: { x: number; z: number };
    legs: Array<{ mode: TripMode; path: Array<[number, number, number]>; ms: number }>; startedAt: string; ms: number; endedAt: string | null; }
  // Repo: + `market: boolean` (false), `label: string` ('palimpsest'), `checks: RepoChecks | null`, `halted: { at: string; reason: string } | null`, `strikes: number`, `joinedAt: string | null`.
  export interface RepoChecks { test: string | null; typecheck: string | null; lint: string | null; build: string | null; screenshot: string | null;
    preview: { kind: 'vite' | 'next' | 'astro' | 'static'; outDir: string } | null; shots: string[]; install: string | null; ecosystems: Array<'npm' | 'python' | 'rust' | 'go'>; detected: boolean; }
  export interface ProviderUsage { provider: 'claude' | 'ollama' | 'anthropic-api' | 'openai' | 'gemini' | 'mlx'; status: 'ready' | 'not-found' | 'off' | 'later';
    windows: Array<{ label: string; usedPct: number | null; resetsAt: number | null }>; tokens: { today: number; week: number } | null; spendUsd: { today: number; week: number } | null; detail: string; }
  // Settings: + `claudeConcurrency 2`, `localConcurrency 1`, `bidWindowSec 120`, `hardStopPct 90`, `resumeStaleUntil: number | null`, `keepAwake: false`,
  //   `ollamaHost '127.0.0.1:11434'`, `anthropicApi: { enabled: false, dailyUsd: 5 }`.
  ```
- Produces (`shared/market-rules.ts`): `TIER_VALUE = { low: 20, normal: 60, high: 150 }`, `TIER_LABELS(base = 'palimpsest') = [base, base + ':low', base + ':high']`, `tierFromLabels(labels: string[], base = 'palimpsest'): Tier | null` (null when no tier label; highest wins), `NEW_FIRM_OVERCLAIM = 0.15`, `calibrated(confidence, overclaim)`, `expectedValue(calibrated, value, price)`, `overclaimOf(resolved: Array<{ confidence: number; passed: boolean }>)`, `reputationScore(r)`, `eraForScore(score, capability)` (half-open ranges, ruling 5), `isBankrupt(negativeSince, now)` (72 h), `salePrice(floors)`, `canHire(balance, openJobs, idleAgents, towers)`, `START_BALANCE = 300`, `HIRE_FEE = 80`, `REVIEWER_SHARE = 0.05`, `MAX_ATTEMPTS = 2`, `CREDITS_PER_USD = 20`, and the transition table:
  ```ts
  export const LEGAL_MOVES: Record<JobStatus, JobStatus[]> = {
    proposed: ['open', 'withdrawn'],
    open: ['bidding', 'withdrawn', 'halted'],
    bidding: ['awarded', 'open', 'withdrawn', 'halted'],          // open: no positive bid this window
    awarded: ['running', 'open', 'failed', 'withdrawn', 'halted'], // open: killed before it started; failed: crashed in preparing or installing
    running: ['inspecting', 'open', 'failed', 'withdrawn', 'halted'], // open: killed (no attempt); failed: crashed or capped
    inspecting: ['shipping', 'failed', 'open', 'withdrawn', 'halted'], // open: killed mid-inspection
    shipping: ['waiting', 'merged', 'failed', 'open', 'halted'],  // open: push rejected twice, no scar
    waiting: ['merged', 'closed', 'withdrawn', 'halted'],
    failed: ['open'],                                             // only while attempts < MAX_ATTEMPTS
    halted: ['open', 'waiting', 'withdrawn'],                     // resume: back to waiting if halted from waiting (PR still open), else open (ruling 30)
    merged: [], closed: [], withdrawn: [],
  };
  export function legalMove(from: JobStatus, to: JobStatus): boolean;
  ```
- Produces (`shared/credits.ts`): `CREDIT_PCT = 0.1`, `DEFAULT_TOKENS_PER_PCT = 60_000`, `MODEL_WEIGHT = { haiku: 0.2, sonnet: 0.6, opus: 1, fable: 1 }`, `modelFamily(model: string): keyof typeof MODEL_WEIGHT` (unknown counts as opus), `weightedTokens(u: { input; output; cacheRead; cacheCreation }, model: string): number`, `claudeCredits(weighted, tokensPerPct)`, `localCredits(seconds, modelGB)`, `apiCredits(usd)`, `calibrate(prev, observed)` (EMA, alpha 0.3), `pctFor(credits)`.
- Produces (`shared/ledger-kinds.ts`): `LEDGER_KINDS` (closed list: the Phase 1 kinds `repo.analyzed`, `repo.connected`, `repo.disconnected`, `repo.error`, `repo.patched`, `usage.hook.installed`, plus `firm.seeded`, `agent.seeded`, `agent.hired`, `agent.retired`, `job.proposed`, `job.posted`, `job.changed`, `bid.placed`, `job.awarded`, `run.started`, `run.stage`, `run.refused`, `run.diff`, `run.ended`, `check.done`, `inspection.done`, `pr.opened`, `pushed`, `merge.detected`, `merge.reverted`, `floor.laid`, `floor.lit`, `floor.removed`, `floor.scarred`, `credits.moved`, `firm.bankrupt`, `tower.sold`, `repo.halted`, `repo.resumed`, `trip.started`, `trip.ended`, `report.written`, `api.key.set`, `api.key.removed`); `type LedgerKind`.
- Produces (`engine/ledger.ts`): `record(kind: LedgerKind, data)` throws `unknown ledger kind <kind>` for anything outside the list.
- Produces (`engine/home.ts`): `Paths` gains `runs` (`<home>/runs`) and `reports` (`<home>/reports`), both created by `paths()`; `isRealDataHome(dir, real = defaultHome())` moved here from `tools/sample.ts`.
- Produces (`engine/market/provider.ts`, types only, frozen from here on):
  ```ts
  export interface Usage { weightedTokens: number; seconds: number; usd: number; credits: number }
  export interface PlanInput { job: Job; agent: Agent; persona: string; repoSummary: string; examples: string[] }
  export interface WorkInput { job: Job; agent: Agent; persona: string; runId: string; dir: string; branch: string; plan: string | null; examples: string[];
    log: (line: RunLogLine) => void; onProgress: (p: Partial<RunProgress>) => void; signal: AbortSignal;
    caps: { maxTurns: number; maxMinutes: number; maxCredits: number } }
  export interface ReviewInput { job: Job; agent: Agent; persona: string; diff: string; acceptance: string[]; checks: CheckResult[] }
  export interface JudgeInput { bar: string; before: string[]; after: string[]; diff: string | null }  // base64 PNGs per route
  export interface Provider {
    kind: 'claude' | 'ollama' | 'anthropic' | 'fake';
    plan(i: PlanInput, signal: AbortSignal): Promise<{ plan: string; price: number; confidence: number; usage: Usage }>;
    work(i: WorkInput): Promise<{ summary: string; usage: Usage; ended: 'finished' | 'capped' | 'aborted' | 'crashed'; reason: string | null }>;
    review(i: ReviewInput, signal: AbortSignal): Promise<{ approve: boolean; notes: string; concerns: string[]; usage: Usage }>;
    judge(i: JudgeInput, signal: AbortSignal): Promise<{ before: number | null; after: number; notes: string; usage: Usage }>;
  }
  export type RunLogLine = { at: string; kind: 'system' | 'assistant' | 'tool' | 'result' | 'stderr' | 'engine' | 'refused' | 'egress'; text: string; data?: unknown };
  ```
- Produces (`engine/db.ts`): tables `jobs(id pk, repo, status, json)`, `firms(id pk, json)`, `agents(id pk, firm_id, json)`, `bids(id pk, job_id, json)`, `runs(id pk, job_id, repo, stage, json)`, `inspections(id pk, run_id, json)`, `baselines(repo, sha, json, primary key(repo, sha))`, `earned_floors(id pk, tower_id, seq integer, json)`, `trips(id pk, json)`, `slots(kind, owner, slot integer, primary key(kind, owner))`, `credits(id integer pk autoincrement, at, firm_id, run_id, kind, amount real, usd real, json)`; `migrate()` runs on `openDb()` and is idempotent; it sets `joinedAt = analyzedAt` on repos that have none.

- [ ] **Step 1: Write the failing tests.** `credits.test.ts`: `weighted tokens weigh output five times`; `opus weighs five times haiku` (`weightedTokens(u, 'claude-opus-4') === 5 * weightedTokens(u, 'claude-haiku-4')`); `an unknown family counts as opus`; `one credit is a tenth of a percent` (`pctFor(10) === 1`); `local credits are cheap` (`localCredits(600, 18) < 2`); `api credits are twenty per dollar`; `calibrate blends by 0.3`. `market-rules.test.ts`: `tier from labels` (`['palimpsest','palimpsest:high']` is high, `['bug']` is null); `calibrated discounts overclaim` (`calibrated(0.9, 0.2) === 0.72`); `expected value` (`expectedValue(0.72, 60, 30) === 13.2`); `overclaim of a perfect firm is 0 and of a boaster is positive`; `era ranges are half-open` (`eraForScore(0.35, 'scifi') === 'brick'`, `eraForScore(0.8, 'scifi') === 'scifi'`, `eraForScore(0.7999, 'scifi') === 'titanium'`); `era caps at capability` (`eraForScore(0.95, 'glass') === 'glass'`); `bankrupt after 72 hours negative`; `sale price` (`salePrice(10) === 40`); `canHire needs balance over 400, more open jobs than idle agents, fewer than four towers`; `legal moves include bidding to open, awarded to failed, running to open and failed, inspecting to failed, halted to open and to waiting, proposed to open`; `merged is terminal`. `ledger.test.ts`: `record refuses a kind outside LEDGER_KINDS`; `record accepts every Phase 1 kind`. `market-types.test.ts`: `migrate creates the market tables and is idempotent` (open twice, every table listed in `sqlite_master`, no throw); `migrate sets joinedAt from analyzedAt`; `paths creates runs and reports`; `isRealDataHome is exported from engine/home`.
- [ ] **Step 2:** Run `npm test`; expect FAIL (missing modules, unknown kinds accepted, no tables).
- [ ] **Step 3:** Implement. Pure modules in `shared/` import nothing from `engine/`. Change the Phase 1 tests' `founding: true` literal checks to `=== true`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`; expect PASS (Phase 1 suites included).
- [ ] **Step 5:** Commit `Add the market's shared types, credit maths, rules, ledger kinds and provider interface`.

### Task 2: Re-analysis keeps earned floors and the datum [Opus]

**Files:**
- Modify: `engine/repos.ts`, `engine/history.ts`
- Test: additions to `test/repos.test.ts`, `test/history.test.ts`

**Interfaces:**
- Consumes: `earned_floors` (Task 1), `Repo.joinedAt`.
- Produces (`engine/history.ts`): `foundingFloors(fullName, commits, prs, opts: { until: string | null })` keeps only items at or before `until` and drops commits carrying a `Palimpsest-Job:` trailer and PRs whose `headRefName` starts with `palimpsest/` (`mergedPRs` gains `headRefName` in its `--json` list).
- Produces (`engine/repos.ts`): `runAnalysis` sets `joinedAt` at the first success only, builds founding floors with `until: repo.joinedAt`, and saves the founding tower with `datumIndex = founding.length`; `loadTower(fullName)` composes `founding floors ++ earnedFloors(towerId)` ordered by `seq`; `layEarnedFloor(towerId, floor): Floor`, `updateEarnedFloor(id, patch)`, `removeEarnedFloor(id)` (the only writers of `earned_floors`, used by Task 16); `GET /api/city` serves the composed tower.
- [ ] **Step 1: Write the failing tests:** `re-analysis keeps earned floors in order above the datum` (seed a tower, lay two earned floors, run `analyze()` again with the fake gh, assert both are still there after the founding floors and `datumIndex` is unchanged); `commits after joinedAt do not become founding floors`; `a city merge never becomes a founding floor` (a commit with `Palimpsest-Job: j1` and a PR from `palimpsest/j1` both inside the window are dropped); `joinedAt is set once` (a second analysis leaves it); `a failed re-analysis leaves the tower untouched`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`; expect PASS.
- [ ] **Step 5:** Commit `Keep earned floors and the datum through a re-analysis`.

### Task 3: Credits, calibration and the city treasury [Opus]

**Files:**
- Modify: `engine/usage.ts`, `engine/settings.ts`, `engine/server.ts` (calls `noteSseClients` on SSE connect and disconnect)
- Create: `engine/market/budget.ts`
- Test: `test/budget.test.ts`, additions to `test/usage.test.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: `latestReading()`, `isStale()`, `shared/credits.ts`, settings, the `credits` table.
- Produces (`engine/usage.ts`): `projectsDir(): string` = `process.env.PALIMPSEST_CLAUDE_PROJECTS ?? join(homedir(), '.claude', 'projects')` (never a literal `~`); `readings(sinceMs): UsageReading[]`; `transcriptTokens(fromMs, toMs, dir = projectsDir()): { weighted: number; messages: number }` summing `message.usage` of assistant lines whose timestamp falls in the range, deduplicated by `message.id` plus `requestId`, weighted per `message.model`; `interactiveActive(now = Date.now(), dir = projectsDir()): boolean` (any `.jsonl` under it with mtime within 10 minutes); `calibration(): { tokensPerPct: number; calibrated: boolean; samples: number }` from pairs of consecutive readings in the same five-hour window (`resetsAt` equal) with a positive percent delta: `observed = (transcriptTokens(a, b).weighted + cityWeighted(a, b)) / deltaPct`, blended with `calibrate()`, stored under settings key `tokensPerPct` with `samples`.
- Produces (`engine/market/budget.ts`):
  - `noteSseClients(n: number, now = Date.now())` (the server calls it on every SSE connect and close) and `sseClientCount(): number`, `lastSseAt(): number | null`.
  - `treasury(now = Date.now()): TreasuryState`: `estimatedPct = reading.pct + cityWeightedSince / tokensPerPct * (1 + 0.1 * hoursStale)` per window; `cityPct` from city credits in the window; `paused` in priority order `stopped` (stop file), `hard` (either `estimatedPct >= hardStopPct`), `stale` (reading older than 5 h and `resumeStaleUntil` not in the future), `cap` (`cityPct + CREDIT_PCT * nextEstimate > dayCapPct`), `night` (unattended and night usedPct at or above nightCapPct); `concurrency.claudeMax = interactiveActive ? 1 : claudeConcurrency`; `api` from today's `usd` sum; `keepAwake` from `registerKeepAwake()` (stub until Task 13).
  - `acquire(model: ModelRef, kind: 'plan' | 'work', estimate: number, opts?: { now?: number; waitUntil?: number }): Promise<{ ok: true; lease: Lease } | { ok: false; reason: NonNullable<TreasuryState['paused']> | { reason: 'busy'; detail: string } }>` per ruling 28: `work` returns `busy` at once when its pool is full (the scheduler retries next tick); `plan` waits in its pool's FIFO queue until `waitUntil` (the bid window's close) and only then returns `busy`. Local models ignore `stale`, `cap` and `night`, obey `stopped` and `hard`; `anthropic:` models obey `stopped` and the dollar cap only. `Lease = { signal: AbortSignal; sub(kind: 'review' | 'judge', model: ModelRef, estimate: number): Lease | { ok: false; reason }; release(): void }`: a review or judge call takes a sub-lease of its run's work lease (same slot; cap checks still apply to its own model); when the reviewer's model is in another pool, the sub-lease counts against that pool too but never waits behind plan calls. Call estimates: `PLAN_ESTIMATE = 3`, `REVIEW_ESTIMATE = 5`, `JUDGE_ESTIMATE = 4` credits.
  - `unattended(now): boolean` per ruling 11.
  - `charge(o: { runId: string | null; firmId: string | null; model: ModelRef; kind: 'bid' | 'run' | 'review' | 'judge'; usage: Usage; unattended: boolean }): number` writes a `credits` row and returns credits.
  - `onHardStop(fn: () => void)`: called once each time the state enters `hard` or `stopped`. Budget itself aborts every live lease's signal per ruling 28 before calling the listeners, so plan, review and judge calls end too; Task 13 adds its own listener to move the aborted runs to `killed`.
  - `registerKeepAwake(fn: () => { on: boolean; held: boolean })`: the treasury reads keep-awake state through it; until Task 13 registers the real one, the default stub returns `{ on: settings.keepAwake, held: false }`, so Task 3 depends on nothing later.
- [ ] **Step 1: Write the failing tests** (seeded `readings.jsonl`, a temp projects dir with transcript fixtures, credits rows under a temp home, injected `now`): `transcript tokens dedupe by message id and request id`; `calibration counts his transcript tokens plus city tokens between readings`; `calibration weighs an opus transcript above a haiku one`; `projectsDir defaults under the home directory with no literal tilde`; `estimate grows with staleness margin`; `paused stale after five hours and resumes with resumeStaleUntil`; `cap blocks a plan call that would cross the day cap but allows a local one`; `a third concurrent claude run is busy`; `a plan call waits for a plan slot while two claude runs hold the run slots and gets one before the window closes`; `a plan call still queued when the window closes returns busy`; `a review sub-lease shares its run's slot`; `entering hard aborts a plan call in flight`; `keep-awake reads the stub until registered`; `hard stop at 90 blocks everything but anthropic and fires onHardStop`; `interactive activity drops claudeMax to 1`; `night cap counts only unattended rows`; `stop file pauses with reason stopped`; `anthropic calls stop at the daily dollar cap`. `server.test.ts`: `SSE connects and disconnects update sseClientCount`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Measure credits against his real plan usage and gate every model call on the city budget`.

### Task 4: Firms, agents, genomes, personas and quarters [Opus]

**Files:**
- Create: `engine/market/firms.ts`, `engine/market/reputation.ts`, `engine/market/personas/*.md` (10 seeded agents, 6 roster specialists), `shared/silhouette.ts`
- Modify: `engine/repos.ts` (slot allocation moves to the `slots` table shared by repos and firms), `engine/layout.ts`
- Test: `test/firms.test.ts`, `test/reputation.test.ts`, `test/silhouette.test.ts`, additions to `test/repos.test.ts`

**Interfaces:**
- Produces (`engine/market/firms.ts`): `SEED_FIRMS` (five): `ashlar-vane` "Ashlar & Vane" gothic, careful reviewers (silhouette lens, workflow `self-check`), agents Ines Ashlar `claude:sonnet` and Teodor Vane `claude:sonnet`; `quickset` "Quickset" chicago, fast builders (cantilever, `single`), Mack Quickset `claude:haiku`, Priya Rao `claude:haiku`, Ola Bergstrom `claude:sonnet`; `meridian` "Meridian Works" beauxarts, specialists on high tier only (needle, `plan-then-answer`), Hal Meridian `claude:opus`; `kiln` "Kiln Brothers" roman, local heavy lifters (plain, `plan-then-answer`), Oskar Kiln `ollama:qwen3-coder:30b-a3b*`, Bruno Kiln `ollama:gpt-oss:20b*`; `sparrow` "Sparrow & Co" pagoda, cheap small jobs (plain, `vote` with `n 3` for bids only), Wren Sparrow `ollama:qwen2.5-coder:7b*`, Juno Pike `ollama:qwen3:1.7b*` (docs and tests only). Every agent gets `memory.examples` (0 to 8; 3 by default), `tools` (`read`, `edit`, `write`, `glob`, `grep`, `run`), `instructions` (the persona file's body) and `lineage { origin: 'seeded', parents: [], generation: 0, at }`. A trailing `*` means `resolveModel(prefix, installed: string[])` picks the first installed tag with that prefix, else the agent seeds as `retired: true` with `retiredReason 'model not installed'`.
  - `seedFirms(installed: string[]): void` is idempotent (keyed on firm id), takes slots from `nextSlot('firm', id)`, records `firm.seeded` (the full firm) and `agent.seeded` (the full agent) for each, and is called only from `engine/main.ts` after `ollama list` through the runner (`installedModels()`, which returns `[]` when Ollama is not running). The sample economy calls it with a fixed list.
  - `listFirms()`, `listAgents(firmId?)`, `firm(id)`, `agent(id)`, `quarters(): Quarter[]` (each agent's tower spec, `kind 'agent'`, `silhouette`, root = firm root, datumIndex 0, floors earned), `hire(firmId): Agent | null` from `ROSTER` (specialists: tests, docs, UI, refactor, migration, performance; `lineage.origin 'roster'`; records `agent.hired`), `retireAgent(agentId, reason)` (records `agent.retired`), `retireFirm(firmId)` and `sellTower(agentId, buyerFirmId)` used by Task 17, `idleAgents(firmId)`, `toGenome(agent)` per ruling 22.
- Produces (`shared/silhouette.ts`): `silhouetteFor(temperament: string): Silhouette`; `floorTransform(s: Silhouette, earnedIndex: number, baseWidth: number): { rotY: number; offsetX: number; offsetZ: number; width: number; bracket: boolean }`; `crownFor(s: Silhouette, earnedCount: number): { kind: 'lens' | 'spire' | 'none'; rings: number; height: number }` per ruling 25.
- Produces (`engine/market/reputation.ts`): `reputation(firmId): Reputation` from the ledger (resolved bids, inspections, reverts); `eraFor(agent): Era`.
- Produces (`engine/repos.ts`): `nextSlot(kind: 'repo' | 'firm', owner: string): number` backed by the `slots` table, migrating existing repo slots into it on first call.
- Personas: each `.md` is the agent's instructions in plain prose: who they are, how they work (the temperament), what they refuse (the never-without-asking list verbatim), how to report (a final JSON block the provider parses). They are copy he reads on the agent page, so no AI rhetoric.
- [ ] **Step 1: Write the failing tests:** `seedFirms is idempotent and allocates five firm slots after existing repo slots`; `seedFirms records firm.seeded and agent.seeded once each`; `agents whose model is not installed seed as retired`; `resolveModel picks the installed tag` (`qwen3-coder:30b-a3b` prefix resolves to `qwen3-coder:30b-a3b-q4_K_M`); `every agent's genome passes a copy of Beagle's validate rules` (shape list, `n` 2 to 7 for vote, examples 0 to 8; the rules are copied into the test, not imported); `seeded agents carry seeded lineage`; `quarters carry one agent tower per active agent with the firm's root and silhouette`; `hire adds a roster agent with roster lineage and refuses a fifth tower`; `silhouette maps careful reviewers to lens, fast builders to cantilever, specialists to needle`; `cantilever steps every third floor and alternates sides`; `needle tapers to 60 percent at twenty floors`; `reputation of a new firm has null rates and era from capability`; `reputation after three merges and one scar has passRate 0.75 and a Brier score`; `repo slots migrate into the slots table unchanged`; `startServer does not seed firms` (start a server on port 0 with a runner that fails the test on any `ollama` call).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Write the 16 persona files by hand.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Seed five firms with their agents, genomes, personas and quarters`.

### Task 5: Jobs from labelled GitHub issues [Opus]

**Files:**
- Create: `engine/market/jobs.ts`
- Modify: `engine/github.ts` (issue list per label, issue state, label add and remove, issue comment)
- Test: `test/jobs.test.ts`, additions to `test/github.test.ts`

**Interfaces:**
- Produces (`engine/github.ts`): `openIssues(fullName, label): Promise<Array<{ number; title; body; labels: string[]; url; author: string; updatedAt }>>` via `gh issue list -R <full> --label <label> --state open --limit 200 --json number,title,body,labels,url,author,updatedAt` (one label per call); `issueState(fullName, number): Promise<'OPEN' | 'CLOSED'>` via `gh issue view <n> -R <full> --json state`; `addLabel`, `removeLabel` via `gh issue edit`; `commentIssue` via `gh issue comment`.
- Produces (`engine/market/jobs.ts`): `pollJobs(repo: Repo): Promise<Job[]>` queries each of `TIER_LABELS(repo.label)` separately, merges by issue number, takes the tier from the merged labels, and posts new jobs only (skips issues already holding a job, issues whose body carries the city's marker `[palimpsest]`, and issues labelled `palimpsest:done` or `palimpsest:failed`); then, for every job in a non-terminal status whose issue was in none of the three lists, calls `issueState()` and withdraws the job when the issue is `CLOSED` (a running job is killed first through Task 13's `kill()`, injected). `postManualJob(input)` (his direct request, spec 7.1); `proposeHarnessJob(repo)` (ruling 23; records `job.proposed`; idempotent per repo); `acceptProposed(jobId)` and `dismissProposed(jobId)`; `parseScope(body)` (lines under a `Scope:` heading, globs, default `['**']`) and `parseAcceptance(body)` (markdown checkboxes, else the title); `transition(job, to, patch?): Job` that throws `illegal move <from> to <to>` unless `legalMove()` allows it and, for `failed > open`, `attempts < MAX_ATTEMPTS`; `listJobs(filter?)`, `job(id)`; on `merged` adds label `palimpsest:done` and comments the PR link; on final `failed` adds `palimpsest:failed` with the inspection summary; events `job.posted`, `job.proposed`, `job.changed`.
- [ ] **Step 1: Write the failing tests** (fake runner): `each tier label is queried separately` (the runner sees three `gh issue list` calls with one `--label` each); `an issue labelled only palimpsest:high becomes a high job worth 150`; `an issue holding two tier labels takes the highest`; `an issue already holding a job is not posted twice`; `issues marked done or failed are skipped`; `a closed issue withdraws its open job`; `scope and acceptance parse from the body`; `illegal transitions throw` (`merged` to `open`); `bidding returns to open, running goes to failed, halted returns to open`; `failed returns to open once then stays failed`; `manual job posts without an issue`; `the harness proposal waits until accepted and dismiss withdraws it`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Post jobs from labelled issues and his own requests`.

### Task 6: The spawner and the fake provider [Opus]

**Files:**
- Modify: `engine/exec.ts`
- Create: `engine/market/fake-provider.ts`, `engine/market/providers.ts`
- Test: `test/exec.test.ts`, `test/fake-provider.test.ts`

**Interfaces:**
- Produces (`engine/exec.ts`): `type Spawner = (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string; clearEnv?: boolean }) => { pid: number | null; lines: AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>; kill(signal?: 'SIGTERM' | 'SIGKILL'): void; done: Promise<{ code: number | null; signal: string | null }> }`; children start in their own process group and `kill()` signals the group, so a command's own children die with it; `clearEnv: true` starts from an empty environment plus `opts.env`; `realSpawner`, `getSpawner()`, `setSpawner()`.
- Produces (`engine/market/fake-provider.ts`): `fakeProvider(script?: FakeScript): Provider` where `FakeScript = { plan?: (i) => ...; work?: (i) => ...; review?: ...; judge?: ... }`, with defaults that plan a short plan at 60% of value with confidence 0.7, write one file named in the job body inside `i.dir`, call `log` with a few lines and `onProgress` ticks, honour `signal` (ends `aborted`), approve reviews, and judge `after 7`.
- Produces (`engine/market/providers.ts`): `providerFor(model: ModelRef): Provider` (`claude:` to the claude backend, `ollama:` to Ollama, `anthropic:` to the API backend, each registered by Tasks 9 and 10), `setProvider(kind, p)` and `resetProviders()` for tests and the sample engine.
- [ ] **Step 1: Write the failing tests:** `spawner streams stdout and stderr lines and reports exit` (`/bin/sh -c 'printf "a\nb\n"; printf "c\n" >&2'`); `kill ends done with a signal and kills the group` (`/bin/sh -c 'sleep 30 & sleep 30'`, kill, both gone); `clearEnv drops the parent environment` (`/usr/bin/env` prints only the given keys); `fake provider writes its file, logs and finishes`; `fake provider ends aborted when the signal fires`; `providerFor routes by prefix and setProvider overrides`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Stream child processes by group and add the scripted fake provider`.

### Task 7: Sandbox profiles, the egress proxy and per-run worktrees [Opus]

**Files:**
- Create: `engine/market/sandbox.ts`, `engine/market/egress.ts`, `engine/market/worktree.ts`
- Test: `test/sandbox.test.ts`, `test/egress.test.ts`, `test/worktree.test.ts`

**Interfaces:**
- Produces (`sandbox.ts`): `toolProfile(o: ProfileInput): string` and `cliProfile(o: ProfileInput & { claudeBin: string; nodeBin: string; brokerPort: number }): string` per ruling 9, where `ProfileInput = { runRoot: string; home: string; dataHome: string; enginePort: number; proxyPort: number; toolchains: string[] }`; `CLAUDE_RUNTIME_PATHS`; `wrap(argv: string[], kind: 'tool' | 'cli', o): string[]` writes the profile to `<runRoot>/ctl/<kind>.sb` and returns `['/usr/bin/sandbox-exec', '-f', <path>, ...argv]`; when `PALIMPSEST_SANDBOX === 'off'` or the platform is not darwin it returns `argv` and logs `sandbox off`, but throws `sandbox cannot be off on the real data home` when `isRealDataHome(home())`. `childEnv(runRoot, extra): Record<string, string>` builds the tool environment from nothing: `HOME=<runRoot>/home`, `TMPDIR=<runRoot>/tmp`, `PATH` (system plus detected toolchains), `GIT_CONFIG_GLOBAL=<runRoot>/ctl/gitconfig`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `HTTPS_PROXY`/`HTTP_PROXY`/`https_proxy`/`http_proxy` to the egress port, `NO_PROXY=localhost,127.0.0.1`, `npm_config_cache`, `npm_config_userconfig=<runRoot>/ctl/npmrc`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME=<runRoot>/home/.config`, `PIP_CACHE_DIR`, `CARGO_HOME`, `GOMODCACHE`, `GOCACHE`, `CI=1`; never any variable from the engine's own environment.
- Produces (`egress.ts`): `startEgress(runId, log): Promise<{ port: number; setStage(stage: 'install' | 'working' | 'checks', hosts: string[]): void; close(): Promise<void> }>` an HTTP CONNECT and plain HTTP forward proxy on `127.0.0.1:0` that answers `407` to any request without this run's `Proxy-Authorization` token (written to `<ctl>/egress.token`, and embedded in the proxy URL of the run's environment), and allows a host only when it is in the current stage's list (exact host or a listed `*.suffix`), answers `403` otherwise, and logs each decision as an `egress` line; `hostsFor(stage, ecosystems, model)` per ruling 21; `CLAUDE_HOSTS = ['api.anthropic.com']` until Task 11 extends it.
- Produces (`worktree.ts`): `createRunDir(repo: Repo, runId: string, branch: string): Promise<{ runRoot: string; dir: string; baseSha: string }>` (`<home>/runs/<runId>/{repo,tmp,home,cache,ctl}`; `git clone --local --no-hardlinks --branch <default> <mirror> <runRoot>/repo`; `git checkout -b <branch>`; `git remote set-url origin https://github.com/<full>.git`; `git remote set-url --push origin no-push://palimpsest`; writes an empty `<ctl>/gitconfig` and `<ctl>/npmrc`; records `sha256(.git/config)` in `<ctl>/git-config.sha`; returns `git rev-parse HEAD`); `controlFiles(runId)` returns every `ctl` path; `engineGit(dir, args)` runs git as the engine with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, `GIT_CONFIG_NOSYSTEM=1`, and refuses (throws `run dir git config changed`) when `.git/config` no longer matches the recorded hash; `diffOf(dir, baseSha): Promise<{ patch: string; files: string[]; lines: number; sha256: string }>`; `commitAll(dir, message, jobId): Promise<string | null>` (null when nothing changed; author `Palimpsest <palimpsest@local>`, trailer `Palimpsest-Job: <jobId>`; returns the new head sha, which runs store as `run.headSha`); `removeRunDir(runId)` (keeps `log.jsonl`, `diff.patch` and `inspection/`).
- [ ] **Step 1: Write the failing tests.** `sandbox.test.ts` (text): `tool profile denies by default`; `the run root read allow comes after the home read deny`; `tool profile denies reads of gh config, netrc, npmrc, docker, ssh, aws, claude and keychains by name`; `tool profile denies writes under the repo's .git`; `tool profile denies exec of security, gh, osascript, sudo, launchctl and open`; `tool profile denies the engine port, 11434 and other live runs' proxy and broker ports after the loopback allow`; `tool profile allows reads and writes of ship and base and denies their .git`; `tool profile denies mach-lookup of the security server`; `cli profile denies every loopback port but this run's proxy and broker`; `cli profile allows exec of only the claude binary, security and node`; `cli profile allows writes to claude runtime paths and denies settings, CLAUDE.md, skills, plugins, agents, commands, hooks and projects`; `wrap is identity when sandbox is off on a temp home`; `wrap throws when sandbox is off on the real home`; `childEnv carries no variable from the parent` (set `GH_TOKEN` and `ANTHROPIC_API_KEY` in the test process; neither appears). `sandbox.test.ts` (execution, `test.skip` without `sandbox-exec`): `a write outside the run root fails`; `a read of a file under the run root succeeds although the home is denied`; `a read of a file in the temp home outside the run root fails`; `a write to repo/.git/config fails`; `exec of /usr/bin/security fails`; `a renamed copy of security cannot reach the keychain` (copy `/usr/bin/security` to `<runRoot>/tmp/sec`; `sec list-keychains` succeeds outside the sandbox and fails inside; skipped if it fails outside); `curl to a loopback server standing in for the engine port fails while one on another port succeeds`. `egress.test.ts` (a local HTTPS-free target: a plain HTTP server on port 0 standing in for a registry, CONNECT exercised against it): `a request without this run's token gets 407`; `another run's token gets 407`; `a listed host passes and an unlisted host gets 403`; `setStage checks closes the list`; `every decision is logged`. `worktree.test.ts` (real git on a temp bare repo made from a temp working repo): `createRunDir clones without hardlinks on the branch with origin fetch rewritten and push invalid`; `a push from the run dir fails` (`git push origin HEAD` exits non-zero without network); `engineGit refuses after .git/config changes`; `engineGit does not run a planted hook` (write `.git/hooks/pre-commit` that touches a marker; `commitAll`; marker absent); `diffOf reports files, lines and a hash`; `commitAll returns null when clean and a sha after a write`; `removeRunDir keeps the log and the patch`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. If an execution test shows that a later `allow` does not override an earlier `deny` on this macOS, restructure the profile as explicit allows only (no home deny) and record it in ruling 9 before committing.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Sandbox every child with tool and CLI profiles, filter egress per stage and clone a worktree per run`.

### Task 8: The guard, the hook and the command broker [Opus]

**Files:**
- Create: `engine/market/guard-core.mjs`, `engine/market/guard-core.d.mts`, `engine/market/guard.ts`, `engine/market/guard-hook.mjs`, `engine/market/broker.ts`, `engine/market/broker-mcp.mjs`, `engine/market/file-tool.mjs`, `docs/SELF_RECURSION_GUARDRAILS.md`
- Test: `test/guard.test.ts`, `test/guard-hook.test.ts`, `test/broker.test.ts`

**Interfaces:**
- Produces (`guard-core.mjs`, plain JS so the hook runs under plain `node` with no TypeScript loader): `forbidden(command, dir, dataHome)` returning a reason for: any `git push`, `git remote`, `git config`, `git filter-branch`, `git filter-repo`, `git reset --hard origin/`, `git rebase` touching `origin/`, `git branch -D|-d` of a branch not named `palimpsest/`, `git tag -d`, any `gh`, `rm -rf` (or `rm -r`) on a path outside `dir`, `~`, `/`, or the data home, `sudo`, `launchctl`, `osascript`, `security`, `curl|wget ... | sh|bash`, `chmod` or writes on `.git/`, and any command naming `~/.claude`, `.claude.json`, `.config/gh`, `.netrc`, `.npmrc` or `.git/config`; a command string is normalized (quotes, `$()` and backticks expanded to their text, `node -e`, `python -c` and `sh -c` bodies scanned too) before matching. It is one layer: the sandbox and the absence of credentials are the others, so a string the guard misses still cannot push. `pathAllowed(tool: 'Read' | 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'Glob' | 'Grep', path, dir): string | null` resolves the `realpath` of the target (or, for a target that does not exist yet, of its nearest existing parent) and checks every parent on the way, and refuses any path that is or passes through a symlink, resolves outside `dir`, or lands inside `dir/.git` (ruling 29).
- Produces (`file-tool.mjs`, plain JS): `node file-tool.mjs <dir> <op> <json args>` performing `read`, `write`, `edit`, `list` and `search` for the local tool loop; it calls `pathAllowed()` first and opens every file with `fs.constants.O_NOFOLLOW` (writes with `O_NOFOLLOW | O_CREAT`, never through a symlink), refuses symlinks found while listing or searching, caps reads at 256 KB, and prints a JSON result; it is run only by `execFileTool()` under the tool profile.
- Produces (`guard.ts`): typed re-exports plus `FORBIDDEN_REASONS` as readable copy for the run log and the inspection page.
- Produces (`guard-hook.mjs`): reads the PreToolUse hook JSON from stdin; for `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Glob` and `Grep` calls `pathAllowed()` on every path field; for `mcp__palimpsest__run` calls `forbidden()`; for any other tool name refuses (`tool not allowed in a city run`); exits 2 with the reason on stderr when refused, else 0. It fails closed: the whole body runs in a `try`, and any exception, unparsable or truncated stdin, a missing or non-string path field, an unexpected tool input shape or a path it cannot resolve exits 2 with `guard could not check this call`; a 5 s self-timeout also exits 2. Run by the CLI as `<process.execPath> <repo>/engine/market/guard-hook.mjs <dir> <dataHome>`.
- Produces (`broker.ts`): `execTool(o: { runId; runRoot; dir; command: string; timeoutMs: number; stage: 'working' | 'install' | 'checks'; signal: AbortSignal; log }): Promise<{ code: number | null; stdout: string; stderr: string; refused: string | null }>`: clamps `timeoutMs` to `[1_000, MAX_TOOL_MS]` (`MAX_TOOL_MS = 15 * 60_000`; an agent's request above it is cut to it and the log says so); calls `forbidden()`, records `run.refused` and returns the reason as `refused` without running anything when it refuses; otherwise runs `/bin/sh -c <command>` through `getSpawner()` with `clearEnv`, `childEnv()`, cwd `dir`, wrapped by `wrap(argv, 'tool')`; output capped at 64 KB each side for the caller and spooled to the run log up to `MAX_SPOOL_BYTES = 20 MB` per run (after that, each call logs only its first and last 4 KB and a line saying how much was dropped). `execFileTool(o: { runId; runRoot; dir; op; args; signal; log })` runs `file-tool.mjs` the same way (ruling 29). `startBroker(runId, ctx): Promise<{ port: number; close() }>`: a loopback HTTP server that accepts `POST /run { command, timeoutMs }` with `authorization: Bearer <token>`, where the token is generated per run and written to `<ctl>/broker.token` (mode 0400, readable by the CLI profile, never on any argv), and answers with `execTool()`'s result; a missing or wrong token gets `401` and is logged.
- Produces (`broker-mcp.mjs`): a minimal stdio MCP server (JSON-RPC 2.0 `initialize`, `tools/list`, `tools/call`) exposing one tool `run` (`{ command: string; timeoutMs?: number }`, description "Run a shell command in the repository. The city refuses pushes, credentials and anything outside the repository.") that reads the broker port and token from `<ctl>/broker.json` and `<ctl>/broker.token` (their paths are its only argv) and forwards each call, returning stdout, stderr and the exit code as text, or the refusal.
- `docs/SELF_RECURSION_GUARDRAILS.md`: the trigger graph (issue label by a person > job > bid > run > PR or push > GitHub; analysis > proposed harness job > his click > job; PR poll > floor; revert watch > halt), the no-cycle proof (the only writes to GitHub are branches named `palimpsest/*`, PRs, labels and comments, all made by the engine; none of them is a job source; city merges are filtered from issue polling by author marker and label and from founding history by trailer and branch; proposals are Phase 3 and will be gated by the same filter), the three layers that stop an agent pushing (no credentials, guard, sandbox) with their code locations, every kill switch and cap with its code location.
- [ ] **Step 1: Write the failing tests:** `guard.test.ts` table-driven over 40 commands: forbidden ones return a reason (including `node -e "require('child_process').execSync('git push --force origin HEAD:main')"`, `sh -c "gh pr merge 1"`, `cat ~/.config/gh/hosts.yml`, `echo x > .git/hooks/pre-commit`, `security find-generic-password -s gh:github.com -w`), allowed ones return null (`npm test`, `git status`, `git diff`, `rm -rf node_modules` inside dir); `pathAllowed refuses ../outside, an absolute path to ~/.claude/settings.json and dir/.git/config`; `pathAllowed refuses a symlink in dir pointing at a temp stand-in for ~/.config/gh/hosts.yml, one pointing at ~/.claude/settings.json, and one pointing at dir/.git/config` (the targets are files in the test's temp home); `pathAllowed refuses a path whose parent directory is a symlink`. `guard-hook.test.ts` (runs the hook with `process.execPath`, no tsx): `exits 2 for a forbidden run call`; `exits 2 for an Edit outside dir`; `exits 2 for an unknown tool`; `exits 0 for npm test and an Edit inside dir`; `exits 2 on unparsable stdin, on an empty body, on a missing file_path and on a non-string path`; `exits 2 for an Edit through a symlink`. `broker.test.ts` (`PALIMPSEST_SANDBOX=off` on a temp home): `a forbidden command is refused, recorded and never spawned`; `an allowed command runs in dir with the child environment` (prints `$HOME` and it is `<runRoot>/home`); `a request without the token gets 401 and another run's token gets 401`; `the token is on no argv` (inspect the spawned argv of the MCP server); `timeoutMs above the cap is clamped`; `the spool stops growing at the cap and says so`; `file-tool read through a symlink to a temp hosts.yml stand-in is refused`; `file-tool write through a symlink to a temp settings.json stand-in is refused and the target is unchanged`; `file-tool write through a symlink to .git/config is refused`; `the MCP server lists one tool and forwards a call` (spawn `broker-mcp.mjs` with `process.execPath`, speak JSON-RPC over stdio); `aborting the signal kills the command`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Refuse what the city must never do and route every agent command through one broker`.

### Task 9: The claude -p backend [Opus]

**Files:**
- Create: `engine/market/claude.ts`
- Modify: `engine/market/providers.ts` (register)
- Test: `test/claude-provider.test.ts`

**Interfaces:**
- Consumes: `wrap(…, 'cli')`, `controlFiles()`, `startBroker()`, `startEgress()`, `guard-hook.mjs`, `broker-mcp.mjs`.
- Produces: `claudeProvider(): Provider`. For `work()` the engine writes `<ctl>/settings.json` (hooks only: `PreToolUse` with matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|mcp__palimpsest__run` and the hook command above; `permissions.allow` for exactly those tools; `permissions.deny` for `Bash`, `WebFetch`, `WebSearch`, `Task`, `Agent`), `<ctl>/mcp.json` (the broker MCP server with its URL and token), and `<ctl>/persona.md`, then spawns, wrapped by the CLI profile, with `clearEnv` and an environment of `HOME` (his real home, needed for his login), `PATH`, `TMPDIR=<runRoot>/tmp`, `HTTPS_PROXY`/`HTTP_PROXY` to the egress port, `NO_PROXY=127.0.0.1,localhost`, `MCP_TOOL_TIMEOUT=900000`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, and nothing else (so `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` never reach it):
  `claude -p --model <m> --output-format stream-json --verbose --no-session-persistence --setting-sources "" --settings <ctl>/settings.json --strict-mcp-config --mcp-config <ctl>/mcp.json --permission-mode dontAsk --tools Read,Edit,Write,Glob,Grep --allowedTools mcp__palimpsest__run --disallowedTools Bash WebFetch WebSearch Task --append-system-prompt <persona text>`, cwd the run dir, prompt on stdin. Never `--bare` (it would read only `ANTHROPIC_API_KEY` and skip the hooks). If Task 11 shows that the CLI rejects an empty `--setting-sources`, the value becomes `local` and `createRunDir` refuses a clone that contains `.claude/settings.local.json`.
  - Parses each `stream-json` line: `system/init` (model, tools, `mcp_servers`, `plugins`, `apiKeySource`): the run aborts with `ended 'crashed'`, reason `claude would bill an API key` unless `apiKeySource === 'none'`, and with reason `unexpected tools` if any tool outside the allowed set or any MCP server other than `palimpsest` is listed; `assistant` (text and `tool_use` blocks, counted as `toolCalls`); `user` (tool results; a hook refusal counts in `refusals`); `result` (`usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `num_turns`, `duration_ms`, `subtype`). Credits use `weightedTokens(usage, model)`.
  - `plan()` and `review()` have no run root of their own (a bid comes before any run), so each call gets a scratch root `<home>/runs/call-<callId>/{work,tmp,ctl}` with an empty `work` dir as cwd, its own egress proxy (stage `working`, `CLAUDE_HOSTS` only, its own token) and its own CLI profile generated for that root (writes only to `work`, `tmp` and the claude runtime paths), removed when the call ends. The diff, job and persona go in on stdin and the system prompt; nothing of the repo is on disk. argv: `claude -p --model <m> --output-format stream-json --verbose --no-session-persistence --setting-sources "" (or the Task 11 fallback) --settings <ctl>/settings.json --strict-mcp-config --mcp-config <ctl>/mcp.json --permission-mode dontAsk --tools "" --json-schema <shape> --append-system-prompt <persona text>`, plus `--max-turns 3` when the probe finds it (else turns are counted). `<ctl>/settings.json` is `{ "permissions": { "deny": ["Bash", "Read", "Edit", "Write", "WebFetch", "WebSearch", "Task", "Agent"] } }` with no hooks (there are no tools to hook); `<ctl>/mcp.json` is `{ "mcpServers": {} }`, so `--strict-mcp-config` excludes every MCP server of his; the `system/init` check (`apiKeySource none`, no tools, no MCP servers, no plugins) applies as for work. The same environment rules apply (`clearEnv`, no API key variables).
  - Caps: `maxTurns` by counting assistant messages, `maxMinutes` by timer, `maxCredits` by running weighted tokens; on a cap or `signal` abort, `SIGTERM` to the group then `SIGKILL` after 5 s, `ended 'capped'` or `'aborted'`. A non-JSON line goes to the log as `stderr`; a stream that ends without a `result` is `crashed`.
  - No provider ever reads `~/.claude/.credentials.json`, the keychain or any token; the file header says so.
- [ ] **Step 1: Write the failing tests** (`setSpawner` fakes replaying recorded `stream-json` fixtures; no real claude): `argv carries setting sources, strict MCP, the settings file, dontAsk and the tool list, and never --bare`; `argv is wrapped in the CLI profile`; `the child environment has no API key or auth token` (set both in the test process); `init with apiKeySource other than none crashes the run before any tool runs`; `init listing Bash or a foreign MCP server crashes the run`; `the settings file hooks every file tool and the run tool`; `usage parses from the result line into weighted credits`; `a stream without result is crashed and keeps the partial log`; `a turn cap kills the group and reports capped`; `abort kills within five seconds`; `plan uses json schema, no tools, an empty strict MCP config, empty setting sources and no session persistence`; `plan runs in its own scratch root with its own profile and removes it after`; `plan init listing any tool or MCP server crashes the call`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Run Claude agents through his own claude -p with no shell, no API key and only the city's tools`.

### Task 10: The local tool loop: Ollama, the Anthropic API backend and the vision judge [Opus]

**Files:**
- Create: `engine/market/toolloop.ts`, `engine/market/ollama.ts`, `engine/market/anthropic-api.ts`
- Modify: `engine/market/providers.ts` (register both)
- Test: `test/toolloop.test.ts`, `test/ollama.test.ts`, `test/anthropic-api.test.ts`

**Interfaces:**
- Produces (`toolloop.ts`): `runToolLoop(transport: ChatTransport, i: WorkInput, o: { maxTurns; maxMs; creditsFor(usage) }): Promise<WorkResult>` with tools `read_file`, `write_file`, `edit_file`, `list_files`, `search`, `run` and `finish`; file tools run through `execFileTool()` under the tool profile (ruling 29), never in the engine process; `run` goes through `execTool()` (Task 8), and a refusal goes back to the model as the tool result; turn cap, wall cap, credits cap, abort; `ChatTransport = { chat(messages, tools, signal): AsyncIterable<ChatChunk> }`.
- Produces (`ollama.ts`): `ollamaProvider(): Provider` on `POST http://<ollamaHost>/api/chat` with `stream: true`; credits from seconds and model size (`ollama show` once per model, cached); `plan()` and `review()` are single calls with `format: 'json'`; `judge()` sends `images` (base64 PNG) to the installed vision model resolved by prefix `qwen2.5vl:7b*`, falling back to the diff text only when no image exists. Calls the engine makes to Ollama are not sandboxed (the engine is trusted); the agent's commands are.
- Produces (`anthropic-api.ts`): `anthropicProvider(): Provider` on `POST https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`, streaming) with the key from `apiKey()`; usage to dollars by `API_PRICES` per model family (USD per million input and output tokens; cache reads and writes at the documented multipliers), to credits by `apiCredits()`; refuses to start unless `settings.anthropicApi.enabled` and a key exist; every call first `acquire()`s an `api` lease, which enforces `dailyUsd`. `apiKey(): Promise<string | null>` via `security find-generic-password -s 'Palimpsest Anthropic API key' -w` through the engine's runner; `setApiKey(key)` via `security add-generic-password -U`; `removeApiKey()`; records `api.key.set` and `api.key.removed` (never the key). The key never enters a child environment, a log or the ledger.
- [ ] **Step 1: Write the failing tests:** `toolloop.test.ts` with a scripted transport and `PALIMPSEST_SANDBOX=off` on a temp home: `a forbidden run is refused and the model is told why`; `file tools stay inside the run dir` (`../outside` and `.git/config` refused); `read_file of a symlink to a temp hosts.yml stand-in is refused and nothing reaches the transport`; `write_file through a symlink to a temp settings.json stand-in is refused`; `file tools never open a file in the engine process` (a spy on `fs.open` in the engine sees no call during the loop); `the loop stops at the turn cap with capped`; `finish ends with the summary`. `ollama.test.ts` (a fake HTTP server on port 0 standing in for Ollama, `ollamaHost` pointed at it): `streams a tool call and its result`; `credits come from seconds and model size`; `judge sends both images`. `anthropic-api.test.ts` (a fake HTTP server on port 0 standing in for the API base, a fake runner for `security`): `the backend refuses while disabled`; `usage converts to dollars and credits`; `the daily dollar cap stops the next call`; `the key is read through security and never appears in the log`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Run local and API agents through one sandboxed tool loop`.

### Task 11: The opt-in sandboxed claude -p smoke run [Opus]

**Files:**
- Create: `tools/smoke-claude.ts`
- Modify: `engine/market/sandbox.ts` (`CLAUDE_RUNTIME_PATHS`), `engine/market/egress.ts` (`CLAUDE_HOSTS`), this plan's rulings 9, 19 and 21 if the run changes them
- Test: `test/smoke-claude.test.ts` (the script's parsing and refusals only, with a fake spawner)

**Interfaces:**
- Produces: `npx tsx tools/smoke-claude.ts` refuses unless `PALIMPSEST_SMOKE=1`, `PALIMPSEST_HOME` is a temp dir (never the real home), and the stop file is absent. It makes a throwaway local repo with one file, a run root, the control files, the broker and the egress proxy exactly as a real Claude run would, and runs one tiny `claude -p --model haiku` work call ("Add a line saying hello to NOTES.md, then run `cat NOTES.md` with the run tool") under the CLI profile. It prints: the `system/init` line's `apiKeySource`, tools, MCP servers and plugins; whether the hook fired (a marker line the hook writes to the run log); every egress decision; the exit; the diff; the weighted tokens; and every sandbox denial the CLI reported. It then tries, in the same run dir under the tool profile, the attacks of Review Focus 6 and prints each refusal. With `--nested-sandbox` it repeats the call with `sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false }` in the settings file and reports whether the CLI starts.
- [ ] **Step 1: Write the failing test:** `the smoke script refuses without PALIMPSEST_SMOKE, on the real home and with the stop file present`; `it reports a non-none apiKeySource as a failure` (fake spawner replaying an init line).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`; expect PASS. Then ask the controller for his go-ahead (it spends a few cents of his plan) and run `PALIMPSEST_SMOKE=1 PALIMPSEST_HOME=$(mktemp -d) npx tsx tools/smoke-claude.ts` and `... --nested-sandbox`. Expected: `apiKeySource none`, tools exactly `Read, Edit, Write, Glob, Grep, mcp__palimpsest__run`, no plugins, the hook marker present, `NOTES.md` changed, only Anthropic hosts allowed by egress, every Review Focus 6 attack refused. Fix `CLAUDE_RUNTIME_PATHS`, `CLAUDE_HOSTS` and the `--setting-sources` value from what it reports, rerun until clean, and record the result (including whether the nested sandbox works) in the commit body and in rulings 9, 19 and 21.
- [ ] **Step 5:** Commit `Prove a sandboxed claude -p run on his login before the market opens`.

### Task 12: Bidding and award by expected value [Opus]

**Files:**
- Create: `engine/market/bids.ts`
- Test: `test/bids.test.ts`

**Interfaces:**
- Consumes: `providerFor()` (tests use the fake), `reputation()`, `acquire()`, `charge()`.
- Produces: `openBidding(job, now): Job` (status `bidding`, `bidsCloseAt = now + bidWindowSec`); `eligibleAgents(job): Agent[]` (active firm, not retired, not in `job.excludedFirms`, `bidsOn` includes the tier); `collectBid(job, agent, now): Promise<Bid | null>`: takes a `plan` lease with `acquire(agent.model, 'plan', PLAN_ESTIMATE, { waitUntil: bidsCloseAt })` (queued per ruling 28) and returns null (recording the reason on the job's bid list as "sat out: <reason>") when refused; passes the lease's signal to the call so a hard stop ends it; makes the plan call with the job, the persona and `memory.examples` of the firm's merged job summaries; for `workflow.shape 'vote'` makes `n` plan calls and takes the median price and confidence; clamps price to `[1, value]` and confidence to `[0.05, 0.99]`; `calibrated` from the firm's `overclaim`; `appraisal` = firm pass rate for the job's size; `ev = expectedValue(calibrated, value, price)`; charges the firm through `charge(kind 'bid')`; releases the lease; `award(job, now): Bid | null` once `now >= bidsCloseAt` or every eligible agent has bid or sat out: highest `ev > 0`, ties to the lower price, then the higher calibrated; records `job.awarded` with `{ considered: Bid[], satOut: Array<{ agentId; reason }>, chosen, why }`; events `bid.placed`, `job.awarded`; a job with no positive bid moves `bidding > open` and reopens next tick.
- [ ] **Step 1: Write the failing tests** (fake provider returning scripted bids): `a boastful firm loses to a calibrated one at the same price`; `price above value is clamped to value`; `award waits for the window unless every agent has bid or sat out`; `no positive EV moves the job back to open`; `excluded firms do not bid`; `claude firms sit out while claude is paused and local firms still bid`; `a plan call queues while two claude runs are live and still bids before the window closes`; `a plan call still queued at the close makes the agent sit out`; `a hard stop aborts a plan call in flight and the agent sits out`; `a vote firm makes n plan calls and bids the median`; `bid cost is charged to the firm`; `the award reasoning names every bid considered and every agent that sat out`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Collect bids with plans, prices and confidence and award by expected value`.

### Task 13: The runner and the scheduler [Opus]

**Files:**
- Create: `engine/market/runs.ts`, `engine/market/install.ts` (interface only here; Task 14 fills the per-ecosystem commands)
- Modify: `engine/main.ts`
- Test: `test/runs.test.ts`

**Interfaces:**
- Consumes: Tasks 3 to 12; `installDeps()` (Task 14), `inspect()` (Task 15) and `ship()` (Task 16) as injected functions.
- Produces: `createScheduler(deps: { now?: () => number; installDeps; inspect; ship; pollJobs? }): Scheduler` with `tick(): Promise<void>`, `start(intervalMs = 15_000)`, `stop()`. `start()` always runs; every tick first checks the stop file and the global switch and does nothing else while either is set, so clearing the stop file resumes the market on the next tick with no restart. One tick: poll issues for every repo with `market` on and not halted (every 5 minutes per repo), open bidding on `open` jobs, collect bids due, award, start runs for awarded jobs while `acquire(model, 'work', bid.price)` succeeds and the repo has no live run (ruling 7), poll PRs and the revert watch through Task 16, the daily tick at local midnight through Tasks 17 and 18.
- `startRun(bid): Promise<Run>`: stage `preparing` (create run dir, start egress and, for Claude, the broker; baseline through Task 14 if missing), `installing` (`installDeps()` with egress stage `install`; an install failure ends the run `failed` with an `install` check and no scar; a crash in `preparing` or `installing` moves the job `awarded > failed`, since the job only moves to `running` when `working` begins), `working` (egress stage `working`; the workflow shape decides the calls: `single` one `work()`; `plan-then-answer` passes the winning bid's plan as `WorkInput.plan`; `self-check` runs `work()` then a second short `work()` asking the agent to review its own diff against the acceptance list and fix what fails; `vote` behaves as `single` for work), `commitAll` (stores `headSha`), `diffOf` (records `run.diff` with files, lines, `sha256` and the patch path), `inspecting` (Task 15, egress stage `checks`), `shipping` or `failed` (Task 16). Caps: `{ maxTurns: agent.maxTurns, maxMinutes: 25 for local and 40 for Claude and API, maxCredits: bid.price * 1.5 }`.
- Events: `run.started`, `run.stage { runId, stage }`, `run.log { runId, line }` (throttled to 10 lines per second per run, the rest spooled to `log.jsonl`), `run.progress { runId, progress }`, `run.ended { runId, outcome, reason }`, plus `site.changed { SiteState }` derived for the city. `kill(runId, reason)`.
- Kill paths: the stop file is checked at every stage boundary and by a 2 s watcher while a run is live; a set stop file, `onHardStop()` (which has already aborted every Claude lease, plan, review and judge calls included) or `kill()` aborts the run's `AbortSignal`, which ends the provider call, every broker command and every check (`killed`, no scar, job back to `open` without consuming an attempt); egress and broker close on every end.
- Keep-awake: while `keepAwake` is on and any run or lease is live, one `caffeinate -i -w <process.pid>` child is held through the spawner; it is killed when the last ends or the setting turns off; `keepAwakeState(): { on; held }`, registered with `registerKeepAwake()` (Task 3) at scheduler creation.
- `failInterruptedRuns()` at engine start marks runs left in a live stage as `crashed` and reopens their jobs (consuming an attempt per ruling 16). `sites(): SiteState[]` for `GET /api/live`. Unattended runs (`unattended: true` at start) are charged to the night cap.
- `main.ts`: after `failInterruptedAnalyses()`, call `failInterruptedRuns()`, `seedFirms(await installedModels())`, `startServer()`, then `createScheduler(...).start()` unconditionally.
- [ ] **Step 1: Write the failing tests** (fake provider, fake runner, `PALIMPSEST_SANDBOX=off` on a temp home, temp bare repos, injected `now`, stub `installDeps`, `inspect` and `ship`): `a tick takes a posted job through bidding, award, install and a run to inspecting`; `concurrency holds two claude and one local runs with a fourth waiting`; `a second awarded job on the same repo waits while the first runs`; `the stop file kills a working run within the watcher interval and reopens the job without an attempt`; `clearing the stop file resumes the next tick without a restart` (scheduler started while the stop file exists); `a hard stop aborts claude runs and leaves local runs going`; `a crash while installing moves the job from awarded to failed`; `resuming a repo puts a halted waiting job back to waiting and does not re-bid it`; `a crashed provider fails the attempt and reopens the job once`; `a capped run ends capped and consumes an attempt`; `an install failure fails the run without a scar`; `a plan-then-answer agent receives its bid's plan`; `a self-check agent makes a second work call`; `interrupted runs crash at startup and reopen their jobs`; `run.log events are throttled and the file holds every line`; `site states follow the stages`; `a halted repo is skipped by the poll`; `keep-awake holds caffeinate while a run is live and releases it after`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Schedule and run awarded jobs under the caps, the kill switch and one run per repo`.

### Task 14: Checks, the install stage, baselines and the harness proposal [Opus]

**Files:**
- Create: `engine/guild/checks.ts`, `engine/guild/baseline.ts`
- Modify: `engine/market/install.ts`, `engine/repos.ts` (`checks` detected on connect and on analyze; `patchRepo` accepts `checks`, `market`, `label`; proposes the harness job), `engine/sample.ts` (the stand-in answers detection for the sample repos)
- Test: `test/checks.test.ts`, `test/install.test.ts`, `test/baseline.test.ts`

**Interfaces:**
- Produces (`checks.ts`): `detectChecks(dir): RepoChecks` from `package.json` scripts (`test`, `typecheck` or a `tsc` dependency, `lint`, `build`), `Cargo.toml` (`cargo test`, `cargo build`), `pyproject.toml` or `pytest.ini` (`pytest`), `go.mod` (`go test ./...`, `go build ./...`), `Makefile` targets `test` and `build`; `screenshot` from a `package.json` script `palimpsest:screenshot`; `preview` from `vite`, `next` (with `output: 'export'`), `astro` dependencies or a root `index.html` (ruling 24); `shots: ['/']`; `install` and `ecosystems` from lockfiles (`package-lock.json` gives `npm ci`, `pnpm-lock.yaml` gives `pnpm install --frozen-lockfile`, `yarn.lock` gives `yarn install --immutable`, `requirements.txt` gives `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, `pyproject.toml` gives `python3 -m venv .venv && .venv/bin/pip install -e .`, `Cargo.lock` gives `cargo fetch`, `go.sum` gives `go mod download`); `detected: true`. `runCheck(ctx, name, command, log): Promise<CheckResult>` through `execTool()` with stage `checks` (no network) and a 15 minute cap, parsing test counts where the runner prints them (`node --test`, `vitest`, `jest`, `pytest`, `cargo test`, `go test`) into `testsRun`.
- Produces (`install.ts`): `installDeps(ctx, repo): Promise<CheckResult>` running `repo.checks.install` through `execTool()` with stage `install` (egress to the registries of `repo.checks.ecosystems` only) and a 10 minute cap; `skipped` when there is nothing to install; rerun before the after-checks only when the diff touches a manifest or a lockfile.
- Produces (`baseline.ts`): `baseline(repo, sha): Promise<CheckResult[]>` (cached in `baselines`; computed on a fresh run root at `sha` with install then every configured check); `ensureHarnessProposal(repo)` calls `proposeHarnessJob()` (Task 5) when `checks.test` or `checks.build` is null; called on connect, on analyze and on a checks patch.
- [ ] **Step 1: Write the failing tests:** `checks.test.ts`: `detects npm, cargo, pytest and go checks from fixtures`; `detects a vite preview and a static index`; `no manifest gives null checks and detected true`; `install commands follow the lockfile`; `test counts parse from node --test output`. `install.test.ts` (`PALIMPSEST_SANDBOX=off`, temp home, fake spawner): `install runs with the install stage and the repo's ecosystems`; `nothing to install is skipped`. `baseline.test.ts` (temp repo with a real `node --test` suite): `the baseline caches per sha`; `a repo without a build command gets one harness proposal, not two`; `a repo with both commands gets none`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Detect each repo's checks and install, run baselines and propose a harness where none exists`.

### Task 15: The inspection guild: reviewer, scope, design screenshots and the verdict [Opus]

**Files:**
- Create: `engine/guild/inspect.ts`, `engine/guild/review.ts`, `engine/guild/design.ts`, `engine/guild/design-bar.md`
- Modify: `engine/market/runs.ts` (wire the real `installDeps` and `inspect` as the scheduler's defaults)
- Test: `test/inspect.test.ts`, `test/review.test.ts`, `test/design.test.ts`

**Interfaces:**
- Produces (`review.ts`): `pickReviewer(run): Agent | null` (highest reputation agent of an active firm other than the worker's whose model can get a `review` sub-lease; a local reviewer when Claude is paused); `review(run, job, diff, checks, lease): Promise<{ result: CheckResult; reviewerAgentId: string; reviewerFirmId: string; usage: Usage }>`: takes a `review` sub-lease of the run's work lease (ruling 28), charges the call's cost to the city through `charge(kind 'review')`, and moves no money to the reviewer's firm (Task 17 pays the share once on `inspection.done`).
- Produces (`design.ts`): `shoot(ctx, repo, sha, routes): Promise<Array<{ route: string; path: string }>>`: `checks.screenshot` with `PALIMPSEST_SHOT=<path>` through `execTool()`, else the preview: build through `execTool()`, serve the output dir from a static server started through `execTool()` on a loopback port inside the tool profile, and shoot each route with the engine's Playwright (Chromium, 1440 x 900, device scale 2) from outside the sandbox against that loopback port; the Playwright context routes every request through `context.route('**/*')` and aborts anything whose origin is not exactly `http://127.0.0.1:<that port>` (so no engine port, no `11434`, no internet, no other loopback service; WebSockets and service workers are blocked too) and logs each blocked URL to the inspection log; the base side is built in `<runRoot>/base`, a checkout of `baseSha` made by the engine with `engineGit`; else `[]`. `judgeDesign(ctx, before, after, diff, lease): Promise<{ before; after; diffOnly; notes; usage }>` with a `judge` sub-lease (charged to the city), against `design-bar.md`; pass when `after >= 6` and `after >= before - 1`; `diffOnly` only when neither side has a shot (ruling 13).
- Produces (`inspect.ts`): `inspect(run, job, repo, diff, lease): Promise<Inspection>` (the run's work lease; its signal aborts every check): reinstall when the diff touches a manifest; runs every configured check after the change and compares with the baseline (`fail` before and after is `preexisting`; missing command is `skipped`); `scope` (every changed file matches a `job.scope` glob and none matches `DENY_SCOPE = ['.github/workflows/**', '.env', '.env.*', '**/*.pem', '**/*.key', '**/id_rsa*', '.claude/**', '.git/**']`; lockfiles allowed only with their manifest); `review`; `design` when the diff touches `UI_FILES = /\.(css|scss|html|tsx|jsx|vue|svelte|swift|astro)$/` (shots at base and head for every route in `checks.shots`, stored under `<runRoot>/inspection/`); `passed = canOpenPR(checks)` (no `fail`, review passed, at least one of test or build ran or the repo has none, and design passed when it ran) and `pushable = canPush(checks)` (passed, no `preexisting`, test and build both `pass`); records `check.done` per check and `inspection.done` (with `reviewerAgentId`, `reviewerFirmId`); three consecutive failed inspections on a repo set `repo.halted` and `strikes` (`repo.halted` recorded); a pass resets `strikes`.
- `design-bar.md`: his bar in prose: sentence case, hairlines over boxes, no glow or neon, no caps eyebrows, no identical card grids, real content, bespoke controls, tables for tabular data, typography from the project's own fonts.
- [ ] **Step 1: Write the failing tests:** `inspect.test.ts` (fake provider, `PALIMPSEST_SANDBOX=off` on a temp home, temp repos with a real `node --test` suite): `a missing test command is skipped, never passed`; `a test failing before and after is preexisting: PR allowed, push refused`; `a new failure fails`; `out of scope file fails scope`; `workflow and .claude files always fail scope`; `three failures halt the repo and a pass resets strikes`; `abort ends the inspection and kills the running check`. `design.test.ts` (fake spawner; Playwright replaced by an injected `screenshotter`): `a UI diff on a static repo is shot before and after at each route`; `a repo with a screenshot script uses it`; `a Swift UI diff with no preview is judged diffOnly`; `a judge call takes a sub-lease of the run's slot and is charged to the city`; `the screenshotter's request filter aborts the engine port, 11434 and an internet URL and allows the served port` (the filter is a pure function `allowShotRequest(url, port)` tested directly, plus one Playwright-free check that the route handler is installed before navigation). `review.test.ts`: `the reviewer is never from the worker's firm`; `review moves no money to the reviewer's firm`; `a paused claude pool picks a local reviewer`; `a review succeeds while two claude runs hold both run slots`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement, then make the real `installDeps` and `inspect` the scheduler's defaults and rerun `test/runs.test.ts`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Inspect every change: checks against a baseline, a reviewer from another firm, scope and screenshots`.

### Task 16: Shipping: PR mode, push mode, merge detection, reverts and floors [Opus]

**Files:**
- Create: `engine/market/ship.ts`
- Modify: `engine/github.ts` (PR create, view), `engine/repos.ts` (uses Task 2's earned floor writers)
- Test: `test/ship.test.ts`

**Interfaces:**
- Produces (`github.ts`): `createPR(fullName, { head; base; title; body }): Promise<{ number; url }>`, `prState(fullName, number): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt; mergeCommit; closedAt }>`, `recentCommits(fullName, branch, since)` (through the mirror after `syncMirror`).
- Produces (`ship.ts`): `shipClone(run): Promise<string>` per ruling 20 (refuses when the fetched tip is not `run.headSha`); `ship(run, job, repo, inspection, signal): Promise<Run>`: from the ship clone, `git push origin <headSha>:refs/heads/palimpsest/<jobId>` with hooks and fsmonitor disabled (the argv passes `forbidden()` as a belt and braces test, though the guard binds agents, not the engine); then PR mode: `createPR` with a body that lists the plan, the inspection table and the ledger link, records `pr.opened`, stage `waiting`, floor laid with `state 'waiting'`; push mode (only when `repo.pushMode && inspection.pushable && repo.checks.test && repo.checks.build`): in the ship clone, `git merge --no-ff <headSha>` into the default branch, record the merge sha, rerun install, `test` and `build` there through `execTool()` under the tool profile (egress stage `install` for the install, nothing after; the clone's `.git` is write-denied), check `git rev-parse HEAD` still equals the recorded merge sha, then `git push origin <mergeSha>:refs/heads/<default>` (no flags; on rejection fetch and retry once, then end the job `shipping > open` without a scar), record `pushed`, stage `done`, outcome `merged`, floor `lit`. `pollPRs(now)`: every open waiting run every 5 minutes: `MERGED` records `merge.detected`, lights the floor and resolves the job; `CLOSED` removes the waiting floor, job `closed` (no scar, no payment). `watchReverts(now)`: every 30 minutes per repo with lit floors: a commit whose body says `This reverts commit <mergeSha>` or whose subject is `Revert "<floor title>"` marks the floor `reverted`, records `merge.reverted`, halts the repo. Floors through `layEarnedFloor`: repo tower floor `{ id: '<repo>#job-<jobId>', kind: 'pr' | 'commits', refs: ['#<pr>'] or ['<sha7>'], title: job.title, at, era: eraFor(agent), size by diff lines, claude: model starts with 'claude', founding: false, earned }`; agent tower floor the same with id `agent:<agentId>#job-<jobId>`; scar floor on failed inspection: `title 'Failed inspection: <job title>'`, `earned.state 'scar'`, on the repo tower only. Events `job.changed`, `floor.laid`, `floor.lit`, `floor.removed`, `floor.scarred`, `merge.reverted`, `repo.halted`.
- [ ] **Step 1: Write the failing tests** (fake runner for gh, real git between temp bare repos standing in for GitHub, fake provider, `PALIMPSEST_SANDBOX=off` on a temp home): `PR mode pushes from the ship clone and lays a waiting floor`; `the ship clone refuses a run dir whose tip moved after commitAll`; `a hook planted in the run dir never runs during shipping` (marker file stays absent); `merged PR lights the floor` (payment asserted through the ledger kind in Task 17); `closed PR removes the floor with no scar`; `push mode merges, reruns checks in the ship clone and pushes main` (assert the bare repo's main moved to the recorded merge sha and no push argv carried force); `a check that rewrites HEAD in the ship clone stops the push`; `push mode refuses when inspection is not pushable`; `a rejected push retries once then reopens without a scar`; `a revert halts the repo and marks the floor`; `failed inspection lays a scar on the repo tower only`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Ship passed work from the engine's own clone as a pull request or a push and raise the floors`.

### Task 17: Treasury accounting, payments, bankruptcy, hiring and dark towers [Opus]

**Files:**
- Create: `engine/market/treasury.ts`
- Test: `test/treasury.test.ts`

**Interfaces:**
- Produces: `installTreasury()` subscribes to the event bus: `bid.placed` debits the bid cost, `run.ended` debits the run's credits, `job.changed` to `merged` credits the price, `inspection.done` credits the reviewer's firm `REVIEWER_SHARE * value` from the city (the only reviewer payment), all as `credits` rows with kinds `bid`, `run`, `pay`, `review-pay`, `hire`, `sale` (the review and judge call costs are Task 3's `review` and `judge` rows, charged to the city), each recorded as `credits.moved`; `balances(): Record<string, number>`; `dailyTick(now)`: marks `negativeSince`, declares bankruptcy after 72 h (`firm.bankrupt`, agents retired through `retireAgent`, towers `dark`, any live trip of theirs ended), sells dark towers per ruling 6 (`tower.sold { from, to, price, agentId }`, the spec stays at its plot with `firmId` = buyer, root and look = buyer's), hires per `canHire()`; `cityLedger(dayStart, dayEnd)` sums for the report.
- [ ] **Step 1: Write the failing tests** (emit events by hand with injected `now`): `a merge pays the price`; `the reviewer share is paid once per inspection` (emit `inspection.done` and `job.changed merged`; one `review-pay` row); `a failed run leaves the cost on the firm`; `bankruptcy after 72 hours negative retires agents and darkens towers`; `a dark tower sells to the richest firm that can afford it and is re-clad`; `hiring adds an agent and charges the fee`; `balances replay from credits rows`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Pay firms on merge, let them go bankrupt, sell dark towers and hire specialists`.

### Task 18: Replay and the daily report [Opus]

**Files:**
- Create: `engine/market/replay.ts`, `engine/market/report.ts`
- Test: `test/replay.test.ts`, `test/report.test.ts`

**Interfaces:**
- Produces: `replay(entries): MarketState` (firms from `firm.seeded`, `agent.seeded`, `agent.hired`, `agent.retired`, `firm.bankrupt`, `tower.sold`; jobs, bids, runs, diffs from `run.diff`, balances from `credits.moved`, floors, halts) with an exhaustive `switch` over `LedgerKind` (a missing case is a type error); `verifyReplay(): { ok: boolean; diffs: string[] }` comparing with the tables, including firms and agents; `writeDailyReport(day): string` to `paths().reports/<day>.md` (jobs posted, awarded, merged, failed and why, credits spent by firm and by model against the caps, calibration, API dollars if any, halts and reverts, bankruptcies, sales, hires, what waits on him: open PRs and proposed jobs), recording `report.written`; `latestReport(): { day; markdown; data }`.
- [ ] **Step 1: Write the failing tests:** `a full fake run (post, bid, award, install, run, inspect, ship, merge) replays to the stored state` (uses the scheduler with the fake provider); `replay rebuilds firms and agents with nothing in the firms table` (drop the table rows, replay, compare); `replay restores each run's diff hash and files`; `the daily report lists the day's merges and spend and says what waits on him, including a proposed harness job`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The report is prose and tables he reads: sentence case, no rhetoric.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Make the ledger replayable down to firms and diffs and write the daily report`.

### Task 19: Provider usage for Settings: Codex, Gemini, Ollama and the API [Sonnet]

**Files:**
- Create: `engine/providers-usage.ts`
- Test: `test/providers-usage.test.ts` with fixture dirs under `test/fixtures/codex/` and `test/fixtures/gemini/`

**Interfaces (full brief):**
- `codexHome(): string` = `process.env.PALIMPSEST_CODEX_HOME ?? join(homedir(), '.codex')`; `geminiHome(): string` = `process.env.PALIMPSEST_GEMINI_HOME ?? join(homedir(), '.gemini')`.
- `openaiUsage(now = Date.now()): ProviderUsage`: reads the newest `*.jsonl` under `<codexHome>/sessions/**` and `<codexHome>/archived_sessions/` modified in the last 7 days, line by line, keeping the last `{"type":"token_count", ...}` payload's `rate_limits.primary` and `rate_limits.secondary` (`used_percent`, `window_minutes`, `resets_at`) as windows labelled "5 hours" (300 minutes) and "week" (10080 minutes), and summing `info.total_token_usage` deltas into `tokens.today` and `tokens.week` when present; `status 'not-found'` when the directory is missing, with `detail 'Codex CLI not found on this Mac'`.
- `geminiUsage(now): ProviderUsage`: sums token counts from `<geminiHome>/tmp/*/chats/*.json` messages' `tokens.total` when present (no plan percentages; `windows: []`); `status 'not-found'` when the directory is missing.
- `ollamaUsage(): Promise<ProviderUsage>`: reachable or not at `ollamaHost`, installed models, local credits today and this week from the `credits` table.
- `claudeUsage(): ProviderUsage` from `latestReading()` and the treasury; `anthropicApiUsage(): ProviderUsage` (`status 'off'` until enabled; spend from `credits.usd`); `mlxUsage(): ProviderUsage` (`status 'later'`, detail "arrives with the school").
- `providerUsages(): Promise<ProviderUsage[]>` in the order Claude, Anthropic API, Ollama, OpenAI or Codex, Gemini, MLX. Read only; never writes to `~/.codex` or `~/.gemini`; never reads `~/.codex/auth.json`.
- [ ] **Step 1: Write the failing tests:** `codex windows come from the last token_count line`; `codex not installed reports not found`; `codex auth.json is never opened` (the fixture dir holds an `auth.json` with mode 000; the reader must not throw); `gemini sums tokens and has no windows`; `the api provider is off until enabled`; `the list is in the fixed order`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Show what each provider can honestly report about its usage`.

### Task 20: Market API routes and SSE events [Sonnet]

**Files:**
- Modify: `engine/server.ts`, `app/src/api.ts`
- Test: additions to `test/server.test.ts`, `test/api-events.test.ts`

**Interfaces (full brief):**
- Routes (all JSON; writes need the header):
  - `GET /api/jobs?status=&repo=` -> `Job[]`; `GET /api/jobs/:id` -> `{ job; bids: Bid[]; award: { chosen; why; satOut } | null; runs: Run[]; inspections: Inspection[]; ledger: LedgerEntry[] }`; `POST /api/jobs` (manual job body); `POST /api/jobs/:id/withdraw`; `POST /api/jobs/:id/repost` (a failed job with attempts left); `POST /api/jobs/:id/accept` and `POST /api/jobs/:id/dismiss` (proposed jobs); `PATCH /api/jobs/:id` (`{ tier }` while proposed or open).
  - `GET /api/firms` -> `Array<Firm & { reputation: Reputation; agents: Agent[] }>`; `GET /api/firms/:id` -> the same plus `jobs`, `credits` rows; `GET /api/agents/:id` -> `{ agent; firm; tower: TowerSpec; runs; genome; lineage: { agent: Agent['lineage']; parents: Agent[]; children: Agent[] } }`.
  - `GET /api/runs/:id` -> `Run & { job; inspection }`; `GET /api/runs/:id/log?since=<line>` -> `RunLogLine[]`; `GET /api/runs/:id/diff` -> text; `POST /api/runs/:id/kill`.
  - `GET /api/inspections/:id` -> `Inspection` with check logs inline (capped at 64 KB each); `GET /api/inspections/:id/shot/:route/:which` -> PNG.
  - `GET /api/treasury` -> `TreasuryState & { balances; calibration }`; `POST /api/treasury/resume-stale`; `GET /api/report/latest`, `GET /api/report/:day`.
  - `GET /api/providers` -> `ProviderUsage[]`; `POST /api/providers/anthropic/key` (`{ key }`, stored through `setApiKey`, answers `{ ok: true }` and never echoes it); `DELETE /api/providers/anthropic/key`.
  - `GET /api/quarters` -> `Quarter[]`; `GET /api/live` -> `{ sites: SiteState[]; trips: Trip[] }`.
  - `PATCH /api/repos/:owner/:name` accepts `market`, `label`, `checks`; `POST /api/repos/:owner/:name/resume` clears `halted` and `strikes` (`repo.resumed`) and moves each halted job back per ruling 30 (`waiting` if it was halted from waiting, else `open`).
  - `PATCH /api/settings` accepts the new keys with validation (concurrency 1 to 4, bid window 30 to 600, hard stop 50 to 95, `anthropicApi.dailyUsd` 0 to 100, `keepAwake` boolean).
  - SSE: every event type above is forwarded (`job.*`, `bid.placed`, `run.*`, `site.changed`, `floor.*`, `merge.*`, `repo.halted`, `repo.resumed`, `firm.bankrupt`, `tower.sold`, `agent.hired`, `agent.retired`, `trip.started`, `trip.ended`, `report.written`).
- `app/src/api.ts`: one client function per route, `EVENT_TYPES` extended, types imported from `shared/types`.
- [ ] **Step 1: Write the failing tests:** one test per route group with the fake provider: `jobs routes post, list and withdraw`; `a proposed job accepts into open`; `job detail carries bids, award, sat-out agents and ledger`; `run log pages by since`; `kill ends a run`; `treasury reports paused reasons`; `the api key route never echoes the key`; `agent detail carries genome and lineage`; `repo resume clears a halt, reopens its jobs and leaves a job with an open PR waiting`; `settings validate concurrency`; `SSE forwards run.stage`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Serve the market over the API and the event stream`.

### Task 21: The sample economy [Opus]

**Files:**
- Create: `engine/market/sample-economy.ts`
- Modify: `tools/sample.ts` (`--economy`), `engine/sample.ts` (gh stand-in answers issues per label, issue view, PR create and view; `ollama list` stand-in), `engine/server.ts` (a sample engine installs the fake provider and, with `PALIMPSEST_SAMPLE_ECONOMY=live`, the clock)
- Test: `test/sample-economy.test.ts`

**Interfaces:**
- Produces: `seedEconomy(now): Promise<void>` writes, on top of `seedSample()`, the five firms (through `seedFirms(SAMPLE_INSTALLED)`) with their towers already holding 3 to 14 earned floors in each silhouette, a bankrupt sixth firm `lodestar` whose dark tower was bought by Quickset and re-clad, one hired roster specialist (lineage `roster`), jobs in every status (one proposed harness job on a sample repo without a build, two open with live bids and one firm sitting out, one awarded, one running with a log of 60 lines including two refusals and egress lines, one inspecting, one waiting on a PR, four merged, one scarred, one closed, one halted repo), credits rows for a week, three daily reports, provider usage fixtures (a Codex fixture home under the sample home), and trips in flight across every mode including a persona cab (stored with hand-written legs; Task 33 switches the seed and the clock to `startTrip()` once routing exists); every record is reachable through the ledger (`verifyReplay().ok`). `economyClock(opts: { now; speed }): { tick(ms): void; stop(): void }` advances the scripted runs through their stages with real `run.*`, `site.changed`, `floor.*` and `trip.*` events on the fake provider, so a capture shows a crane rise, sparks, searchlights and a cure in about 40 s at `speed 20`. The sample gh stand-in answers `gh issue list` per label with eight fictional issues (three on the harbour repo, written as a real maintainer writes them), `gh issue view`, `gh pr create` and `gh pr view` with scripted states.
- [ ] **Step 1: Write the failing tests:** `the economy seeds every job status and replays clean`; `the clock moves a running job to merged with a lit floor and a trip home`; `the sample stand-in never calls the network` (no runner call escapes the stand-in); `npx tsx tools/sample.ts <tmp> --economy writes the marker and refuses the real home`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The fictional issues, bids and plans are copy he will read in captures; write them like a working team's.
- [ ] **Step 4:** Run; expect PASS. Then `PALIMPSEST_HOME=$(mktemp -d)` seeded with `--economy`, `PALIMPSEST_PORT=4790 PALIMPSEST_SAMPLE_ECONOMY=live npm run engine`, and `curl -s 127.0.0.1:4790/api/live` shows sites and trips.
- [ ] **Step 5:** Commit `Add a sample economy so captures and tests show a living market without spending anything`.

---

## Part B: the city

Every task in this part starts from the head that contains the Phase 1 polish round's tower work (`app/src/city/tower/*`) and ambient city work (`grid.ts`, `facade.ts`, `materials.ts`); see "Starting head".

### Task 22: Earned, waiting and scar floors on towers [Opus]

**Files:**
- Modify: `app/src/city/tower/eras.ts`, `app/src/city/tower/build.ts`, `app/src/city/tower/kit.ts`, `app/src/city/tower/look.ts`, `app/src/ui/inspector.ts`, `app/src/main.ts`
- Test: additions to `test/tower-build.test.ts`, `test/inspector.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Floor.earned`, `TowerSpec.kind`, `GET /api/city` serving composed towers (Task 2).
- Produces: `buildTower(spec, quality, mats, look, opts?: { width?: number; dark?: boolean })`; floors with `earned.state 'waiting'` build in their era's material with every pane unlit and the slab edge in bare concrete; `'scar'` builds as the approved primer floor (matte rust-red primer, exposed studs at the corners, no glazing, slab edge left rough), height by size; `'lit'` floors are the era's floor with a thin cool light line at the slab edge (distinct from the Claude amber, which stays for `claude: true`); `dark: true` towers use the unlit variant of every material, no light lines, the datum left. Inspector: earned floors list under a heading "Built in the market" above the datum entry, each row with the agent and firm names, the job title, a link to the PR, and for a scar the words "Failed inspection" and a link to the inspection report; clicking an earned floor still flies to it.
- [ ] **Step 1: Write the failing tests:** `an earned floor builds above the datum`; `a scar floor has no panes`; `a waiting floor has no lit panes`; `a dark tower has no emissive material`; `agent towers build at width 16`; inspector: `earned floors list with agent, firm and job`. UI test: a shot `tower-earned.png` on the harbour tower from the sample economy showing lit, waiting and scar floors above the bronze band.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the scar must read as a deliberate wound, not a missing texture; the waiting floor as finished but asleep; the light line under the bloom threshold. Commit `Raise earned floors above the datum, with waiting floors asleep and scars in primer`.

### Task 23: Temperament silhouettes: the lens crown, the cantilever and the needle [Opus]

**Files:**
- Create: `app/src/city/tower/crowns.ts`
- Modify: `app/src/city/tower/build.ts`, `app/src/city/tower/kit.ts`
- Test: `test/silhouette-build.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `TowerSpec.silhouette`, `shared/silhouette.ts` (Task 4).
- Produces: `buildTower` applies `floorTransform()` to each earned floor of an agent tower (founding and root floors are untouched); `lens`: the twist accumulates floor by floor, and `makeLensCrown(rings, quality)` sets a glazed drum with a polished lens disc on the roof, one ring of mullions per five floors, catching the sky; `cantilever`: stepped floors carried on visible steel brackets (`bracket: true` floors get a pair of tapered brackets from the kit), the facade continuing round the overhang; `needle`: floors narrowing to the taper, ending in `makeSpire(height)` with an aviation lamp; `plain`: unchanged. Each silhouette shows from the overview at dusk as a distinct outline.
- [ ] **Step 1: Write the failing tests:** `a lens tower's tenth earned floor is rotated 15 degrees and carries a crown with two rings`; `a cantilever tower offsets its third and sixth earned floors to opposite sides with brackets`; `a needle tower's twentieth earned floor is 60 percent wide and ends in a spire`; `founding floors are never transformed`. UI test: `silhouettes.png` from a bearing that shows one tower of each kind against the sky, plus zoomed crops of the crown, brackets and spire.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the twist must read as a growing twist, not a modelling error; the brackets as structure that carries the load; the lens crown as optics, not a dome. Commit `Shape each agent's tower by how it works: a lens crown, a cantilever, a needle`.

### Task 24: Firm quarters and agent towers in the city [Opus]

**Files:**
- Create: `app/src/city/quarters.ts`
- Modify: `app/src/city/scene.ts`, `app/src/city/occupancy.ts`, `app/src/city/labels.ts`, `app/src/main.ts`, `shared/district-layout.ts`
- Test: `test/quarters.test.ts`, additions to `test/occupancy.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `QUARTER_OFFSETS: Array<{ x: number; z: number }> = [{ x: -52, z: -52 }, { x: 52, z: -52 }, { x: -52, z: 52 }, { x: 52, z: 52 }]`; `quarterCenterpiece(q: Quarter, quality, looks): Centerpiece` building one agent tower per `q.towers[i]` (with its silhouette) at `QUARTER_OFFSETS[towerIndex]`, a shared paved court with the firm's name cut into a low stone plinth at the street edge, a covered walk joining the towers in the firm's root vernacular; `occupancy()` takes quarters and returns `quarters` beside `districts` (a quarter is occupied while its firm has any tower, dark or not); plates: one per quarter (`name` the firm, `sub` "<n> agents, <balance> credits" or "bankrupt"); picking an agent tower opens the agent page (Task 38) and the firm plate opens the firm page; `City.setPlots` accepts quarters; looks for agent towers come from `lookFor(firmId)` so a firm's cluster shares a material family while each tower differs by `pickLooks` within it.
- [ ] **Step 1: Write the failing tests:** `quarter offsets keep four 16 m towers clear of each other, their cantilevers and the collar`; `occupancy includes quarters and keeps districts unchanged`; UI test: `quarters.png` from a bearing that shows two quarters and a district; the plates read; picking a quarter tower reports `kind 'agent'`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Stand each firm's agents in their own quarter`.

### Task 25: The civic exchange: the job board as a place [Opus]

**Files:**
- Create: `app/src/city/exchange.ts`, `design/blender/exchange.py` (if a scripted export is used), `app/public/models/exchange.glb` (own work, recorded in `CREDITS.md`)
- Modify: `app/src/city/scene.ts`, `app/src/city/ground.ts` (the civic plaza paving), `app/src/main.ts`
- Test: `tools/ui-test.ts`, `test/exchange.test.ts`

**Interfaces:**
- Produces: `makeExchange(quality): { object; pickables; setBoard(jobs: Array<{ status: JobStatus; bids: number }>): void; setStopped(stopped: boolean): void; dispose }` at (0,0): a Beaux-Arts exchange hall (a stepped stylobate, a colonnade of fluted columns from the kit, a shallow copper dome lit from within, a clock over the entrance) with a tote board along the entablature: one brass slot per open or bidding job (up to 24), each lit while bidding and ticking a small lamp per bid received (real counts only), dark slots for none. Picking it opens `#/jobs`. The civic plaza gets its paving pattern, four lamp standards and a fountain that runs only while the engine is not stopped (an honest sign of the kill switch).
- [ ] **Step 1: Write the failing tests:** `the tote board lights one slot per bidding job and one lamp per bid` (`setBoard([{ status: 'bidding', bids: 3 }, { status: 'open', bids: 0 }])` gives one lit slot with three lit lamps and one dark slot); `the board holds 24 slots and ignores the rest`; `the fountain stops when the engine is stopped`; `picking the hall returns the jobs route`. UI test: `exchange.png` close on the hall at dusk with the sample economy's two bidding jobs lit on the board; clicking it navigates to `#/jobs`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Hero geometry modelled properly, not boxes; instancing for columns and lamps.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Build the civic exchange where jobs are posted and bids tick by`.

### Task 26: Live construction: crane, skeleton, welding and netting [Opus]

**Files:**
- Create: `app/src/city/construction.ts`
- Modify: `app/src/city/scene.ts`, `app/src/main.ts`, `app/src/city/post.ts` (flicker light budget)
- Test: `test/construction.test.ts` (pure state to geometry), `tools/ui-test.ts`

**Interfaces:**
- Consumes: `SiteState` from `GET /api/live` and `site.changed` events; `towerFrame()` and the tower's top.
- Produces: `makeConstruction(quality): Construction` with `set(site: SiteState | null, top: number, half: number, floorHeight: number)`, `update(dt)`, `dispose()`, and `makeHoist(height): Hoist` (the construction hoist mast with its car, shared with Task 35). Stages: `crane`: a tower crane standing on the roof (mast sections, slewing ring, cab, jib with trolley and hook block, counter-jib with ballast, an aviation lamp on the jib tip) and a skeleton of two to four columns rising at the new floor's height; `framing`: the steel frame rises with `progress` (beams and decking filled in by fraction, netting hung on the outer face, welding sparks as a GPU particle burst at the working edge with a flickering blue-white point light, the crane's trolley traversing and the hook rising with each progress step); progress follows real `toolCalls` and `testsRun`, never a timer (between events the frame holds still and only the sparks and the lamp keep moving); `inspecting`, `curing`, `waiting`, `teardown` and `scar` are Task 27's stages but the API is one object.
- [ ] **Step 1: Write the failing tests:** `the crane stands on the tower top and the skeleton is at floor height`; `framing at progress 0.5 shows half the beams`; `a site set to null disposes its parts`; UI test with the economy clock at `speed 20`: `construction.png` and a four-frame strip; no console errors; fps within 5 of the overview.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): crane proportions from reference photographs, sparks that read as welding (brief, bright, falling), the flicker within the bloom budget. Commit `Raise a crane and weld the frame while an agent really works`.

### Task 27: Inspection searchlights, the cure, teardown and the scar [Opus]

**Files:**
- Modify: `app/src/city/construction.ts`, `app/src/city/scene.ts`, `app/src/main.ts`
- Test: `test/construction.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `inspecting`: the frame complete, two guild searchlights on tripods at the plaza edge sweeping the new floor (volumetric cones through the haze, slow crossing sweeps, real duration until `inspection.done`); `curing`: the frame fades into the era's finished floor over 4 s (material cross-fade), the crane slews to park and its lamp goes steady, then the windows light row by row (`lit`), or stay dark (`waiting`, crane parked and stays); `teardown`: the netting drops, the skeleton lowers and the crane dismantles over 6 s, no floor; `scar`: the teardown ends on the primer floor of Task 22 with a single work lamp left burning on it for the rest of the evening. Each transition is driven by `site.changed`; the city asks `GET /api/live` again on `engine.reconnected`.
- [ ] **Step 1: Write the failing tests:** `inspecting places two searchlights at the plaza edge aimed at the floor`; `curing ends with the floor's era material and no crane`; `scar ends with a primer floor and a work lamp`; UI test with the economy clock: `inspection.png`, `cured.png`, `scar.png`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Sweep the new floor with searchlights, cure it and light it, or leave a scar`.

### Task 28: Dark towers and the buyer's re-clad [Opus]

**Files:**
- Modify: `app/src/city/quarters.ts`, `app/src/city/tower/look.ts`, `app/src/main.ts`
- Test: `test/quarters.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `firm.bankrupt` and `tower.sold` events, `Quarter.dark`, `TowerSpec.dark` and `firmId`.
- Produces: on `firm.bankrupt`, every window in the quarter goes out over 2 s (no rebuild, a uniform on the facade materials), the quarter plate reads "bankrupt" and its court lamps go dark; on `tower.sold`, a re-clad sequence: scaffolding (the Phase 1 `makeScaffold` kit) rises up the tower over 8 s, the floors rebuild in the buyer's look, root and the bought agent's silhouette behind it, the scaffolding comes down and the windows relight; the tower's plate moves to the buyer's cluster list (the plot stays where it is, since towers do not walk).
- [ ] **Step 1: Write the failing tests:** `a dark quarter has no lit panes`; `a sold tower rebuilds with the buyer's look and root`; UI test: `dark-tower.png` from the sample economy's `lodestar` plot, and the re-clad end state.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Darken a bankrupt firm's towers and let a buyer re-clad them`.

### Task 29: The river, quays and bridges [Opus]

**Files:**
- Create: `shared/commute.ts` (river constants only here), `app/src/city/river.ts`
- Modify: `app/src/city/lots.ts` (lots the river crosses become quays), `app/src/city/grid.ts`, `app/src/city/ground.ts`, `app/src/city/scene.ts`
- Test: `test/river.test.ts`, `test/lots.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces (`shared/commute.ts`): `RIVER = { x: -360, width: 56 }`; `BRIDGES = [-480, 0, 480]` (z of each bridge); `PIERS` every 480 m along the river from z = -1440 to 1440 plus one at the civic end; `crossesRiver(a, b): boolean`.
- Produces (`river.ts`): the channel cut into the ground with stone quays and mooring rings, a water surface (planar reflection of the sky dome and the towers, slow ripple normals, the sun's path on it), three bridges modelled properly (a steel through-arch, a three-span stone arch, a cable-stayed deck with a single pylon) with lamps, ferry piers with shelters and a lit sign each.
- [ ] **Step 1: Write the failing tests:** `the river clears every district reserve by 2 m`; `lots the river crosses become quays with no buildings`; `crossesRiver detects a crossing`; UI test: `river.png` at dusk from the stone bridge, and a zoomed crop of a pier.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the water must take the dusk and the towers; bridges modelled, not slabs. Commit `Cut the river through the city with its quays, bridges and piers`.

### Task 30: The transit network: trams, elevated rail, pods and cab ranks [Opus]

**Files:**
- Create: `app/src/city/transit.ts`
- Modify: `shared/commute.ts`, `app/src/city/scene.ts`
- Test: `test/commute.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces (`shared/commute.ts`, pure): `tramLoop(extentBlocks): Array<[number, number]>` (a loop on the streets around the district ring, growing with the spiral), `tramStops(loop)`, `railLoop(extentBlocks): Array<[number, number, number]>` (the elevated rail on a viaduct at 12 m around the outer edge of the district ring), `railStations(loop)`, `podRail(): Array<[number, number, number]>` (two maglev lines along x and z through the civic plaza at 18 m, stations every 240 m), `cabRanks(extent)` (one per district plaza and one at the exchange), `network(extent): Network`, `route(from, to, net): Trip['legs']` with mode choice per ruling 26; walking legs on the street grid (Manhattan); speeds `walk 1.4`, `tram 12`, `rail 20`, `pod 25`, `ferry 6`, `cab 11` m/s plus a 20 s wait per boarding (cabs 30 s, they come to you).
- Produces (`transit.ts`): tram rails inlaid in the street with catenary poles, stops with shelters; the elevated rail viaduct on paired concrete piers with stations at platform height and stairs to the street; the pod rail on slender steel pylons with stations as glass boxes lit from within; cab ranks as marked bays with a lit sign; everything instanced.
- [ ] **Step 1: Write the failing tests:** `route walks a short trip`; `route takes the ferry across the river between piers and a bridge when far from piers`; `route takes a cab between 700 and 1500 m`; `route takes the pod across the city along a pod line and the rail when no pod line serves both ends`; `the tram loop and the rail loop enclose every district slot used`; UI test: `transit.png` (a tram stop with the viaduct behind), `pods.png` (a pod station at height).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The engine (Task 33's trips) imports the same `shared/commute.ts`.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the viaduct and pylons as engineered structure, catenary that reads at distance. Commit `Lay the tram, elevated rail, pod and cab network the commuters ride`.

### Task 31: Transit vehicles: trams, trains, pods, ferries and persona cabs [Opus]

**Files:**
- Create: `app/src/city/vehicles.ts`
- Modify: `app/src/city/scene.ts`
- Test: `test/vehicles.test.ts` (pure motion along a polyline), `tools/ui-test.ts`

**Interfaces:**
- Produces: `createVehicles(net, quality): { update(dt); board(trip: Trip, leg: number): VehicleRef | null; summonCab(trip: Trip, leg: number): VehicleRef; dispose }`: trams (two articulated cars, lit interiors, pantograph, headlamps, moving on the loop on a timetable), elevated trains (three cars on the viaduct), pods (maglev capsules on the rail, quiet, interior lit), ferries (a low double-ended boat with cabin lights and a wake decal) between piers; persona cabs: an autonomous cab (a compact pod-like car with a roof light) that drives from the nearest rank to the persona, carries it along the leg on the street grid, sets it down and returns to the rank. A persona's trip boards the next vehicle on its leg (`board()` returns the vehicle it rides, so the figure moves with it); a `cab` leg calls `summonCab()`.
- [ ] **Step 1: Write the failing tests:** `a vehicle advances along its polyline at its speed and wraps the loop`; `board returns the next tram on the leg's line`; `a summoned cab drives from the nearest rank and ends at the leg's end`; UI test: `tram.png` close on a tram at a stop, `ferry.png`, `cab.png` (a persona stepping into a cab); fps within 5 of the overview with every vehicle running.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three). Commit `Run trams, trains, pods, ferries and cabs for the city's commuters`.

### Task 32: Ambient traffic and crowds [Opus]

**Files:**
- Create: `app/src/city/ambient.ts`
- Modify: `app/src/city/scene.ts`, `app/src/city/post.ts` (headlamp budget)
- Test: `test/ambient.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `createAmbient(net, quality): { update(dt); setDensity(n: number); dispose }`: ambient cabs and cars on the street grid (headlamps and tail lamps, low poly, instanced, stopping at junctions in turn), ambient pedestrians at street level near plazas and stops (an instanced crowd with a simple walk cycle, variation in coat colour and pace), density by quality setting and time of day. Ambient code never imports trips, never carries a plate, and its cabs carry no roof light, so they can never be mistaken for a persona's cab.
- [ ] **Step 1: Write the failing tests:** `ambient vehicles never leave the street grid`; `density follows the quality setting`; `no ambient object carries a plate`; UI test: `street.png` at dusk at street level near a plaza; fps within 5 of the overview at high quality.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the crowd must not read as clones in step. Commit `Fill the streets with unlabelled traffic and crowds`.

### Task 33: Persona trips from real events (engine) [Opus]

**Files:**
- Create: `engine/market/trips.ts`
- Modify: `engine/market/runs.ts`, `engine/market/bids.ts`, `engine/guild/review.ts`, `engine/market/treasury.ts` (emit and end trips), `engine/market/sample-economy.ts` (seed and clock use `startTrip()`)
- Test: `test/trips.test.ts`

**Interfaces:**
- Produces: `startTrip(agent, reason, jobId, from, to, now): Trip` (routes with `shared/commute.ts`, records `trip.started`, emits it); `endTrip(tripId, why)` (records `trip.ended`); `activeTrips(now): Trip[]`; trips start on `bid.placed` (quarter to exchange), `job.awarded` (exchange or quarter to the job's district), review start for the reviewer (quarter to the district), `run.ended` (district to quarter); an agent has at most one trip (a new one ends the old); a retired agent's trip ends at once (bankruptcy, Review Focus 5).
- [ ] **Step 1: Write the failing tests:** `an award starts a trip from the exchange to the district with legs`; `a 1,000 m trip to a district takes a cab`; `run end starts a trip home`; `a second trip ends the first`; `retiring an agent ends its trip and records trip.ended`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Send agents on trips when they really bid, work, inspect and go home`.

### Task 34: Agent personas as people in the city [Opus]

**Files:**
- Create: `app/src/city/people.ts`
- Modify: `app/src/main.ts`, `app/src/city/scene.ts`, `app/src/city/camera.ts` (follow mode)
- Test: `test/people.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `createPeople(city, vehicles): { set(trips: Trip[], agents: Agent[]); update(dt); follow(agentId | null); positionOf(agentId): Vector3 | null; dispose }`: a figure per agent persona built in code (a 1.8 m articulated figure with a coat in the firm's accent, a procedural walk cycle, a lantern they carry at dusk), walking its legs and riding vehicles between (boarding through `vehicles.board()` or `summonCab()`); beyond 400 m the figure is a small warm lantern light at its position so a trip reads from the overview; a plate above the figure within 150 m (`name`, `sub` "to <district> for <job title>"); `follow()` keeps the camera 12 m behind and above the figure until the user drags or presses Escape, and releases when the trip ends or the agent retires. Keyboard `F` on a selected agent follows.
- [ ] **Step 1: Write the failing tests:** `a figure's position follows its legs by elapsed time`; `a figure in a cab moves with the cab`; `beyond 400 m only the lantern renders`; `follow releases when the trip ends`. UI test with the economy: `commute.png` close on a figure at a tram stop with its plate; `follow` moves the camera.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the walk must not slide; the figure must read as a person at 20 m and never as a mannequin. Commit `Send each agent persona through the city on its real errands`.

### Task 35: The exterior elevator ride [Opus]

**Files:**
- Create: `shared/ride.ts`, `app/src/city/ride.ts`
- Modify: `app/src/ui/inspector.ts`, `app/src/main.ts`, `app/src/city/camera.ts` (a scripted path mode), `app/src/city/construction.ts` (the hoist is placed on construction towers from Task 26)
- Test: `test/ride.test.ts`, `tools/ui-test.ts`, `tools/capture.ts` (a `ride` clip)

**Interfaces:**
- Produces (`shared/ride.ts`, pure): `ridePlan(layout: TowerLayout, floors: Floor[], opts: { live: SiteState | null }): RideKey[]` where `RideKey = { t: number; y: number; dwell: number; caption: { title; date; who; mark: 'datum' | 'scar' | 'claude' | 'live' | null } | null }`; speed 3 floors per second, slowing to 0.8 over the datum, scar floors and Claude floors (dwell 1.2 s with a caption), ending on the roof (or the crown of an agent tower) with a 6 s slow orbit, or at the live work when a site is under construction (dwell with the live caption "<agent> is framing floor <n>").
- Produces (`app/src/city/ride.ts`): `startRide(city, repoOrAgentTower, plan)`: a glass car on an exterior rail (on standing towers; it follows a lens tower's twist and steps out round a cantilever) or the crane crew's hoist car (on construction towers, the same `makeHoist()`), the camera riding 9 m out from the facade looking slightly up, captions set in the inspector's type at the lower left (title, date, who), the floor passing outlined as the inspector highlight does; Escape or a drag ends it and returns to the previous view; the inspector gets a "Ride up" action and `R` rides the selected tower.
- [ ] **Step 1: Write the failing tests:** `ridePlan slows at the datum and dwells on scars and Claude floors`; `a live site ends the ride at the work with its caption`; `a root-only tower rides the root and the roof`; UI test: starting a ride moves the camera up over 3 s and the caption shows a floor title; Escape restores the view.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. Add the `ride` clip to `tools/capture.ts` (the harbour tower, datum to roof).
- [ ] **Step 5: Quality rounds** (three): the car must feel like a real hoist (cable, a little sway at stops), captions legible against glass and sky. Commit `Ride the outside of a tower floor by floor to the roof or the live work`.

---

## Part C: the screens

The new screens continue the Phase 1 language: sheets over the city, Newsreader for names and headings, IBM Plex Sans for text, Plex Mono for refs and numbers, hairline rules, sentence case, square corners, the bronze rule under the current place. Nothing is a card grid; lists are ledgers. Every number links to the ledger entry that produced it.

### Task 36: The job board screen [Opus]

**Files:**
- Create: `app/src/ui/jobs.ts`, `app/src/ui/market.css`
- Modify: `app/src/router.ts` (routes with ids: `#/jobs`, `#/jobs/:id`, `#/firms`, `#/firms/:id`, `#/agents/:id`, `#/runs/:id`, `#/inspections/:id`, `#/treasury`, `#/repos/:owner/:name`), `app/src/ui/runhead.ts` (Jobs, Firms, Treasury links), `app/src/main.ts`
- Test: `test/router.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `#/jobs`: the board as the exchange's own ledger: sections Proposed (the harness proposals with Accept and Dismiss), Bidding (each job with its value, the clock to close, and the bids so far as a ruled list: firm, agent, price, confidence, the city's estimate, EV, updating live; agents that sat out with the reason in quiet text), Running (stage and progress words from real counts: "14 tool calls, 2 tests run, 1 refused"), Waiting on you (open PRs with links), Done today, Failed, Halted repos with a Resume action. A "Post a job" form (repo, title, body, tier) at the end. Filters by repo. Everything updates from SSE without reload.
- [ ] **Step 1: Write the failing tests:** `router parses ids`; UI test with the economy clock: the board lists the two bidding jobs, a bid arrives live, the running job's progress text changes, the proposed harness job accepts into Bidding on the next tick, `Post a job` creates one that appears under Bidding.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Open the job board`.

### Task 37: Job detail, run detail with live log and the inspection report [Opus]

**Files:**
- Create: `app/src/ui/job.ts`, `app/src/ui/run.ts`, `app/src/ui/inspection.ts`
- Modify: `app/src/main.ts`, `app/src/ui/market.css`
- Test: `tools/ui-test.ts`

**Interfaces:**
- `#/jobs/:id`: the issue (title, body as rendered markdown, scope, acceptance as a checklist), the bids with the award reasoning in prose ("Ashlar & Vane won at 38 credits: calibrated 0.71 against a stated 0.8 ..."), who sat out and why, the run (link), the floor (fly to it, ride up), the ledger trail as a dated list. Actions: withdraw, repost, change tier while proposed or open, kill while running.
- `#/runs/:id`: the live log as a terminal transcript set in Plex Mono (system lines quiet, assistant text, tool calls folded with their results, refusals and egress decisions as quiet ruled lines with the reason, stderr in rust), following the tail while live with a "hold" toggle, paged by `since`; the progress counts; the diff as a unified patch with file headers; credits so far against the bid; Kill.
- `#/inspections/:id`: the report as a table of checks (name, status as a word plus a small shape, duration, a fold to the log), the reviewer's notes and concerns, the scope list, the design judgement with the before and after screenshots side by side per route and the scores (or "judged on the diff alone: nothing to render" when `diffOnly`), and the verdict line ("Passed; pushable" or "Failed: test, scope").
- [ ] **Step 1: Write the failing UI tests** (economy): the running job's log grows live and the hold toggle stops it following; refusals show with their reason; the inspection page shows eight checks for the scarred job with `fail` on two; the job page's award prose names the winner and who sat out.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Show a job's bids, its live run and its inspection report`.

### Task 38: Firm pages and the agent page with its design and lineage [Opus]

**Files:**
- Create: `app/src/ui/firms.ts`, `app/src/ui/firm.ts`, `app/src/ui/agent.ts`
- Modify: `app/src/main.ts`, `app/src/ui/inspector.ts` (an agent tower opens the agent page)
- Test: `tools/ui-test.ts`

**Interfaces:**
- `#/firms`: every firm as a ledger row: name, motto, balance (negative in rust with "bankrupt in <n> h"), reputation (pass rate, calibration, durability as three small gauges drawn by hand), agents, floors built, a dark marker for bankrupt firms with "bought by <firm>" on sold towers.
- `#/firms/:id`: the firm's story: its quarter (fly to it), agents with their models, temperaments and silhouettes, jobs won and lost (with the EV that lost them), the credits ledger as a running balance, reputation over time as a small hand-drawn line, hires.
- `#/agents/:id`: the persona in full (the prose from its file), its design (model, tools, workflow shape, memory examples, as the genome fields read), its lineage (origin, generation, parents and children as links, "seeded with the city" or "hired from the roster on <date>"), its tower floor by floor (reusing the inspector's floor list), runs, the calibration of its firm, "Follow" (Task 34) and "Ride up" (Task 35).
- [ ] **Step 1: Write the failing UI tests** (economy): the firms list shows six firms with one bankrupt; the firm page's running balance ends at the firm's balance; the agent page shows the workflow shape and the hired specialist's roster lineage; the agent page follows the persona.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Add the firm pages and the agent page with its design and lineage`.

### Task 39: The treasury screen and the daily report [Opus]

**Files:**
- Create: `app/src/ui/treasury.ts`
- Modify: `app/src/main.ts`, `app/src/ui/market.css`
- Test: `tools/ui-test.ts`

**Interfaces:**
- `#/treasury`: the five-hour and seven-day windows as two ruled meters (his use, the city's share, the cap, the hard stop, the reset time), the calibration line ("1% of the window is about 58,000 weighted tokens, measured from 14 pairs" or "assumed"), the paused reason in plain words with the one action that clears it (Resume anyway for stale, open Settings for stopped), concurrency now (Claude, local, API), night cap use, API dollars today against the daily limit when enabled, whether the Mac is being kept awake, spend today and this week by firm and by model as a table, firm balances, and the latest daily report rendered below with a day picker. Every row links to its credits entry.
- [ ] **Step 1: Write the failing UI tests** (economy with a stale reading variant): the meters show the seeded percentages; the stale pause shows and Resume anyway clears it; the report for the latest day renders and lists the proposed harness job under what waits on him.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Show the treasury against his real plan and the daily report`.

### Task 40: Repos, the district page and Settings for the market [Opus]

**Files:**
- Create: `app/src/ui/repo.ts`
- Modify: `app/src/ui/repos.ts`, `app/src/ui/settings.ts`
- Test: `tools/ui-test.ts`

**Interfaces:**
- Repos rows: a Market switch (default off) beside Push mode; the push note becomes "merges to main after inspection; needs a test and a build command" and the switch is disabled with that reason when `checks.test` or `checks.build` is null; a "halted" line with Resume when `halted`; a "harness proposed" line linking to the job when one waits; the row name opens the district page.
- `#/repos/:owner/:name`: the district page: toggles (connected, market, push mode), the label, the detected checks as editable commands (install, test, typecheck, lint, build, screenshot) with "detected" or "set by you", the preview kind and the screenshot routes (editable list), the network the repo's jobs may reach (the registries from its ecosystems, read only), the halt state and strikes, jobs on this repo (with Accept on a proposed harness job), floors earned, and a note that autonomy grants arrive with Phase 4.
- Settings: Providers lists, from `GET /api/providers`: Claude through your Claude Code (as before, with the five-hour and weekly readings); Anthropic API key (off; a key field that stores to the keychain and never shows the key again, an enable switch, a daily dollar limit, which agents use it, and the line "Spends your API key's dollars, not your Claude plan"); Ollama (reachable or not at `ollamaHost`, installed models, which agents use them); OpenAI or Codex (the five-hour and weekly percentages and tokens read from the Codex CLI's own logs on this Mac, or "Codex CLI not found on this Mac"); Gemini (tokens from the Gemini CLI's logs, or "not found"); MLX as "arrives with the school". Caps gains concurrency, bid window, hard stop, keep awake ("keeps the Mac awake while the city is working"); the kill switch copy says what stops (new runs at once, running ones within five seconds); Privacy adds "Leaves this Mac: gh calls, your own claude CLI's calls to Anthropic made on your login exactly as when you use it yourself, package downloads from the registries a job needs, and, only if you turn it on, Anthropic API calls on your key. Ollama stays on this Mac."
- [ ] **Step 1: Write the failing UI tests:** the market switch patches `market`; push mode is disabled on the repo without a build command and says why; the district page saves a test command and a screenshot route; Settings shows Ollama reachable (the sample engine answers `ollama list` through the stand-in) and the Codex windows from the sample fixture; the API key field posts and clears, and the key never appears in the page afterwards.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Add the market switches, the district page and the provider settings`.

---

## Part D: real runs, media and the README

### Task 41: Real-run check on his own repos [Opus]

**Files:** none new unless fixes are needed; `docs/superpowers/plans/2026-11-10-phase-2-market-realrun.md` holds the notes (timings, costs, what was weak).

- [ ] **Step 1:** Confirm Task 11's smoke run passed on this head (rerun it if the sandbox, egress or claude backend changed since). With the installed engine on his real data home and the usage hook installed (ask him first; it changes `~/.claude/settings.json` through the documented path), turn Market on for `AllStreets/palimpsest` in PR mode, label one small real issue `palimpsest` (a docs or test change he picks), and watch it through the city and `#/jobs`: bids from at least one Claude firm and one local firm, an award, an install stage, a run under `sandbox-exec` (confirm with `ps -o pid,command` that the claude process and the broker's commands run under their profiles), an inspection with the repo's own `npm test` and `npm run typecheck`, and a PR opened on GitHub by his `gh` login from the ship clone.
- [ ] **Step 2:** Confirm the credits charged against the five-hour window agree with the hook's next reading within the margin shown in Treasury; confirm `~/.claude/projects` gained no city transcript and `~/.claude/settings.json` is byte-identical to before the run (apart from the hook he approved); confirm the run log shows only allowed registry and Anthropic hosts; confirm the stop file kills a second run within 5 s and the job returns to the board; confirm clearing the stop file resumes the market without a restart.
- [ ] **Step 3:** Merge the PR by hand; confirm the floor lights above the datum, the agent's tower gains a floor in its silhouette, the firm is paid, the reviewer's firm is paid once, and the daily report at midnight lists it. Revert it on a branch locally only if he agrees to test the halt; otherwise test the halt through the fake.
- [ ] **Step 4:** Time each stage (target: bidding under 3 minutes, a small job under 20 minutes end to end); fix what is slow or wrong. Commit `Fix issues found on real market runs` (never his data).

### Task 42: UI test, captures, README and media update [Opus]

**Files:**
- Modify: `tools/ui-test.ts`, `tools/capture.ts`, `README.md`, `CREDITS.md`, `docs/media/*`

- [ ] **Step 1:** `tools/ui-test.ts` runs the whole Phase 2 set on the sample economy with the clock, every shot above, and a console-error check across every screen; `npm run ui-test` passes.
- [ ] **Step 2:** `tools/capture.ts` gains shots `market-overview` (the city with a crane up, a tram passing, the exchange lit, the three silhouettes on the skyline), `construction` clip (crane to cure, 40 s at the clock's speed), `commute` clip (a persona from the exchange by tram to the site, and one by cab), `ride` clip, `jobs`, `job`, `run-log`, `inspection`, `firms`, `agent`, `treasury` stills; re-capture `hero`, `overview`, `flyover` and `rise` since the city changed. All from the sample economy at 2x.
- [ ] **Step 3:** README in his style: what Phase 2 adds in plain first person (the market, how a job moves, what the crane means, that every light is a ledger entry), the honest state (what runs for real, what waits for the school), how to turn the market on for one repo safely (label, PR mode first, caps), the sandbox, the broker and the never list, privacy (his own claude CLI, Ollama local, the API key off by default), the new screenshots and clips, credits for any new third-party asset. Shields row updated to phase 2. No em dashes, no badge walls beyond the existing row, no AI rhetoric.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test` all pass; `cargo test` in `src-tauri` still passes.
- [ ] **Step 5:** Commit `Phase 2: a market that builds the city` and push per his standing order (each reviewed task is pushed to main as it lands; this is the last).

---

## Self-review notes

- Spec coverage: 6.1 quarters and dark towers (24, 28), the job board as a place (25); 6.2 datum (2), earned floors and scars (22), silhouettes (4, 23); 6.3 (26, 27); 6.4 every named mode: walking, trams, ferries on a river, maglev pods, elevated rail, autonomous cabs for personas, ambient traffic and crowds (29 to 34); 7.1 (5); 7.2 agent design with workflow shape, memory examples and Beagle genome compatibility (4), bids and award (12), reputation (4), money and hiring (17); 7.3 (1, 3); 7.4 providers and usage (3, 9, 10, 19, 40); 7.5 fresh worktree per job, `sandbox-exec`, network only to what the job needs, turn caps, ledger (7, 8, 10, 13); 7.6 checks against a baseline, reviewer from a different firm, screenshots before and after for UI changes, scope (14, 15); 7.7 (16); 8 never list, gates, caps and switches, self-halt, no loops, ledger with diffs and replay (5, 7, 8, 13, 15, 16, 18); 11 job, agent (with lineage), repo district, settings screens (36 to 40); 13 phase 2 line (all); 17 what counts as merged (16), runs when closed with keep-awake (13, 40), value (1, 5), repos without tests with the baseline harness job (14, 36, 40), providers in v1: Claude through his Claude Code (9), Anthropic API key (10, off by default), Ollama (10), MLX with the school in Phase 4, OpenAI or Codex and Gemini usage display (19, 40); stale numbers (3), unattended (3, 13); 18 elevator (35). Earned autonomy, proposals, the brief, the nets and the school are Phases 3 and 4 and are named as such in copy.
- Type consistency: `SiteState`, `Trip`, `Quarter`, `TreasuryState`, `Inspection`, `ProviderUsage` are defined once in Task 1 and only consumed afterwards; `Provider` is defined once in Task 1; `LEDGER_KINDS` once in Task 1; `forbidden()` and `pathAllowed()` once in Task 8; `execTool()` once in Task 8; the profiles once in Task 7.
- Proportion: 42 tasks against a 276 line spec, on his order to split rather than cut; step bodies carry only values the spec or a ruling pins.

## Builder check fixes

Each item of `plan-review-1.md` and the task (or ruling) that fixes it. The controller accepted every item.

### Required fixes

| # | Item | Fixed in |
|---|---|---|
| C1 | Drop `--bare`; use `--setting-sources`, `--strict-mcp-config`, `--settings`; strip API-key env vars; abort unless `apiKeySource` is `none` | Task 9 (argv, `clearEnv`, init check), Global Constraints, Review Focus 3 |
| C2 | Remove push capability from runs: invalid pushurl; deny exec of gh and security; deny reads of `~/.config/gh` and credential files; engine pushes from its own clean clone with hooks and fsmonitor off; sandbox denies writes to `.git/config`, `.git/hooks`, `.git/info` | Ruling 8, ruling 9 (all of `.git/**` write-denied), ruling 20; Task 7 (pushurl, fake home, empty `GIT_CONFIG_GLOBAL`, `engineGit`, profile tests), Task 16 (ship clone, tip check), Task 8 (guard layer) |
| C3 | Restrict `~/.claude` to exact runtime paths; deny settings, CLAUDE.md, skills, plugins, agents, commands; control files outside the writable tree, read-only; per-run `npm_config_cache` and `XDG_CACHE_HOME` | Ruling 9 (CLI profile, `CLAUDE_RUNTIME_PATHS`, `ctl/`), Task 7 (`childEnv`, profile tests), Task 11 (confirms the list) |
| C4 | Opt-in smoke run of one tiny `claude -p` under the generated profile; consider Claude Code's own sandbox | Task 11; ruling 19 (considered, broker primary, nested sandbox probed and enabled if it works) |
| C5 | `runAnalysis` preserves earned floors and the datum; city merges excluded from founding history | Ruling 17, Task 2, Review Focus 7 |
| C6 | Transition table; order (6 before 5; `LEDGER_KINDS` and `Provider` into Task 1); double reviewer payment; scheduler start after resume | `LEGAL_MOVES` in Task 1 and `transition()` in Task 5; Task 1 holds `LEDGER_KINDS` and `Provider`, the fake lands in Task 6 before bids in Task 12; ruling 6, Task 15 (`review()` moves no money) and Task 17 (pays once); Task 13 (`start()` always, gate per tick) |
| I7 | Dependency-install stage; one run per repo; cap and concurrency gating for bid, review and judge calls; hard stop aborts runs in flight | Task 14 (`installDeps`, ecosystems), Task 13 (`installing` stage, one run per repo, `onHardStop`), ruling 7, Task 3 (`acquire()` leases for every call kind), Tasks 12 and 15 (callers lease) |
| I8 | Calibrate from transcript tokens plus city tokens, with a per-model multiplier | Ruling 2, Task 1 (`MODEL_WEIGHT`), Task 3 (`transcriptTokens`, `calibration`) |
| I9 | Refuse `PALIMPSEST_SANDBOX=off` on the real home; seed firms only in `main.ts` | Ruling 9, Task 7 (`wrap` throws), test safety rules 7 and 9, Task 4 (`startServer does not seed firms`), Task 13 (`main.ts`) |
| I10 | Restore the API-key backend (off by default) and the OpenAI and Gemini usage display; keep-awake; temperament silhouettes; persona cabs; `firm.seeded` and diff ledger kinds; 7.2 agent fields; 7.5 per-job network; 7.6 screenshots for his repos; 17 baseline harness job; 11 lineage | Ruling 18 and Task 10 (API backend), Task 19 and Task 40 (usage display), ruling 27 and Task 13 (keep-awake), ruling 25 and Tasks 4 and 23 (silhouettes), ruling 26 and Tasks 30, 31, 33 (cabs, elevated rail), Task 1 (`firm.seeded`, `agent.seeded`, `run.diff`) and Task 18 (replay), ruling 22 and Task 4 (genome fields), ruling 21 and Task 7 (egress per stage), ruling 24 and Task 15 (screenshots), ruling 23 and Tasks 5, 14, 36, 40 (harness job), Tasks 20 and 38 (lineage) |
| I11 | Split Tasks 6, 7, 9, 21, 22, 23 | Old 6 into Tasks 6 (spawner and fake), 9 (claude backend), 10 (Ollama loop, API backend and judge). Old 7 into Tasks 7 (sandbox, egress, worktree), 8 (guard, hook, broker), 11 (smoke run). Old 9 into Tasks 14 (checks, install, baseline) and 15 (review, scope, design). Old 21 into Tasks 29 (river and bridges) and 30 (transit network). Old 22 into Tasks 31 (vehicles and persona cabs) and 32 (ambient traffic and crowds). Old 23 into Tasks 33 (engine trips) and 34 (figures) |
| M12 | Rename `Window` (shadows the DOM type); add runs and reports to `paths()` | Task 1 (`BudgetWindow`, `paths().runs`, `paths().reports`) |
| M13 | Query each tier label separately; detect closed issues | Ruling 3, Task 5 (`TIER_LABELS`, one query per label, `issueState()`) |
| M14 | Replace the tests that pass before the change | Task 1 (`founding floors still say founding true` replaced by `record refuses a kind outside LEDGER_KINDS`, `migrate creates the market tables`, `migrate sets joinedAt`); Task 25 (`exchange builds and picks` replaced by tote board slot and lamp counts, the 24 slot limit, the fountain and the pick route) |

### Spec coverage gaps

| Gap | Fixed in |
|---|---|
| 6.2 silhouette from temperament | Ruling 25, Tasks 4 and 23 |
| 6.4 personas ride cabs; elevated rail distinct from pods; `TripMode` lacks `cab` | Ruling 26, Task 1 (`TripMode` with `rail` and `cab`), Tasks 30, 31, 33, 34 |
| 7.2 workflow shape, memory examples, Beagle genome compatibility | Ruling 22, Tasks 1, 4, 12 (vote), 13 (shapes and examples) |
| 7.5 network only what the job needs | Ruling 21, Task 7 (egress), Tasks 13 and 14 (stages) |
| 7.6 screenshots for his repos | Ruling 24, Tasks 14 (preview detection) and 15 (`shoot`) |
| 17 providers in v1 | Ruling 18, Tasks 10, 19, 40 |
| 17 keep-awake | Ruling 27, Tasks 13, 39, 40 |
| 17 baseline harness job | Ruling 23, Tasks 5, 14, 36, 40 |
| 8 ledger: diffs and firm seeding; replay rebuilds firms | Task 1 (kinds), Task 4 (records), Task 13 (`run.diff`), Task 18 (replay from the ledger alone) |
| 11 agent page lineage | Task 1 (`Agent.lineage`), Tasks 4, 20, 38 |

### Rulings

| Review ruling | Change |
|---|---|
| 2 needs a per-model multiplier | Ruling 2 (`MODEL_WEIGHT`) |
| 3 query each tier label | Ruling 3 |
| 5 half-open ranges | Ruling 5 |
| 7 one run per repo | Ruling 7 |
| 8 `--no-hardlinks`, no push credentials | Ruling 8 |
| 9 disagreed (creds, `~/.claude` writes, network open) | Ruling 9 rewritten, rulings 19 to 21 added; after the re-check, ruling 9 also covers the ship and base clones, baseline roots, the security server mach lookup and loopback, and rulings 28 to 30 are added |
| Self-review deferral of providers disagreed | Ruling 18; self-review notes now list every v1 provider |

### Task integrity

| Item | Fixed in |
|---|---|
| Task 5 consumed Provider from Task 6 | `Provider` in Task 1; fake in Task 6; bids in Task 12 |
| `LEDGER_KINDS` created late but used early | Task 1 |
| `sseClientCount()` had no producer | Task 3 (`noteSseClients`, `sseClientCount` in `budget.ts`, called by the server) |
| Transition table gaps | `LEGAL_MOVES` in Task 1 with tests |
| Reviewer paid twice | Tasks 15 and 17 |
| `runAnalysis` rewrote the tower | Ruling 17, Task 2 |
| Scheduler did not start after the stop file cleared | Task 13 |
| Control files committed by `commitAll` and failing scope | Ruling 9 (`ctl/` outside the repo dir), Task 7 |
| No dependency install in fresh clones | Task 14, Task 13 (`installing`) |
| Several runs on one repo conflict | Ruling 7, Task 13 |
| Calibration never fired | Ruling 2, Task 3 |
| Tests that passed before the change | Tasks 1 and 25 |
| Splits | Tasks 6 to 11, 14 and 15, 29 to 34 |
| Dirty `app/src/city/tower/*` | "Starting head" note; Part B preamble; conflict table row |

### Safety

| Item | Fixed in |
|---|---|
| `--bare` skipped hooks | Task 9 (never `--bare`; hook on every file tool and the run tool) |
| Push without gates through the gh credential helper, open 443, `node -e` past a string guard, gh reachable | Ruling 8 (no helper, invalid pushurl), ruling 9 (gh and security exec denied, gh config unreadable), ruling 21 (egress allowlist, GitHub never listed), Task 8 (guard scans `node -e`, but is not relied on alone), Review Focus 6 |
| Agent controls the run dir's `.git`; engine git ran there unsandboxed with credentials; push-mode merge clone reran agent code | Ruling 9 (`.git/**` write-denied), ruling 20, Task 7 (`engineGit` with hooks and fsmonitor off and a config hash check), Task 16 (ship clone, checks under the tool profile with `.git` write-denied, sha check before push) |
| Writable `~/.claude`; `Bash` matcher missed Write and Edit | Ruling 9 (CLI profile), Task 8 (`pathAllowed` on every file tool), Task 9 (matcher covers every allowed tool; `dontAsk` with an explicit allow list) |
| Shared caches allowed poisoning | Ruling 9 and Task 7 (per-run caches, fake home) |
| `--settings` pointed into the writable run dir | Ruling 9 (`ctl/` read-only, outside the repo dir) |
| Profile read rule contradiction with the run dir inside the data home | Ruling 9 (allow after deny), Task 7 (execution tests of the order) |
| Readable gh config, netrc, npmrc, docker, keychains; exec of security and gh | Ruling 9, Task 7; for the CLI profile, which must exec `security` for his login, the agent has no shell (ruling 19) |
| `PALIMPSEST_SANDBOX=off` honoured on the real home | Ruling 9, Task 7 |
| API dollars through inherited env | Global Constraints, Task 9 (`clearEnv`, `apiKeySource` check) |
| Bid, review and judge bypassed caps; hard stop did not abort | Task 3 (leases), Tasks 12 and 15, Task 13 (`onHardStop`) |
| `seedFirms()` in `startServer` would spawn Ollama in tests | Task 4, Task 13, test safety rule 9 |
| Sandboxed code could call the engine API (found while revising) | Ruling 9 (engine port denied), Task 7 test |

### Feasibility

| Item | Fixed in |
|---|---|
| `--bare` breaks Max auth | Task 9 |
| `guard-hook.mjs` could not import `guard.ts` under plain node | Task 8 (`guard-core.mjs` in plain JS with a `.d.mts`; hook run by `process.execPath`) |
| `claude -p` under a deny-default profile untested before the real run | Task 11 (before any market run; Task 41 reruns it) |
| `--max-turns` not in help | Task 9 (probe, else count turns) |
| `interactiveActive` default `~/.claude/projects` not expanded | Task 3 (`projectsDir()` with `homedir()`) |

### Re-check fixes (round 2)

The Sonnet re-check found every item above addressed (READY WITH FIXES) and asked for nine more. Each is fixed here.

| # | Item | Fixed in |
|---|---|---|
| R1 | Local tool loop file tools ran in the engine unsandboxed; `pathAllowed()` followed symlinks, so a symlink could leak `~/.config/gh/hosts.yml` or write `~/.claude/settings.json`, `~/.zshrc` or `.git/config` | Ruling 29; Task 8 (`pathAllowed()` with realpath of target and every parent, symlinks refused; `file-tool.mjs` with `O_NOFOLLOW`; `execFileTool()`; symlink tests); Task 10 (file tools through the broker, no `fs.open` in the engine, symlink tests); Review Focus 6 |
| R2 | The hook must fail closed | Task 8 (`guard-hook.mjs` exits 2 on any exception, bad or empty JSON, missing or odd path, unresolvable path or a 5 s timeout; tests) |
| R3 | `plan()` and `review()` argv and bid-time scratch root | Task 9 (full argv with `--setting-sources ""` or the fallback, `--no-session-persistence`, `--strict-mcp-config` with `{ "mcpServers": {} }`, `--tools ""`, deny-all permissions, init check; a per-call scratch root with its own egress and CLI profile; tests) |
| R4 | Tool profile must cover the ship clone, the design base checkout and baseline dirs | Ruling 9 (`<runRoot>/ship`, `<runRoot>/base`, `.git/**` denied in each; baselines in their own run root); Task 7 tests; Task 15 (`<runRoot>/base`) |
| R5 | Playwright must reach only the served loopback port | Task 15 (`context.route('**/*')` aborting every other origin, WebSockets and service workers; `allowShotRequest()` tested) |
| R6 | One run could use another run's proxy or broker over loopback | Ruling 9 (CLI profile denies every loopback port but its own; tool profile denies the engine port, 11434 and other live runs' ports), ruling 21 and Task 7 (`407` without this run's proxy token), Task 8 (broker `401` for another run's token); tests. Not fully applied: the tool profile cannot deny all loopback except this run's ports, because repos' own test suites bind ephemeral ports (Palimpsest's own tests use port 0) and Seatbelt cannot name ports by owner; per-run credentials carry that case |
| R7 | Broker caps, token by file, keychain mach lookup | Task 8 (`MAX_TOOL_MS` clamp, `MAX_SPOOL_BYTES` spool cap, token in `<ctl>/broker.token` never on argv); ruling 9 and Task 7 (`mach-lookup` of `com.apple.SecurityServer` and `com.apple.securityd` denied; renamed `security` copy test) |
| R8 | Busy leases starved bids; hard stop left calls running | Ruling 28 (plan pool with a FIFO queue up to the bid window; review and judge as sub-leases of the run's slot; every lease abortable); Task 3 (`acquire()` and `Lease.sub()`, `onHardStop` aborts every Claude lease; tests); Tasks 12, 13, 15 (callers) |
| R9 | `awarded > failed`; halted waiting jobs re-bid; seven versus six modes; Task 3 forward dependency | `LEGAL_MOVES` in Task 1 (`awarded > failed`, `halted > waiting`), ruling 30 and `Job.haltedFrom`, Tasks 13 and 20 (resume restores waiting; tests); ruling 26 (six trip modes, matching `TripMode`); Task 3 (`registerKeepAwake()` stub; `onHardStop` owned by Task 3, consumed by Task 13) |
