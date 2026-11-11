# Phase 3: Analysis and the Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-11-11).** Revised after builder check round 1 (`.superpowers/sdd/2026-11-10-phase-2-market/phase-3-plan-review-1.md`, NOT READY: 5 Critical, 9 Important, 4 Minor). Every item is addressed; the section "Builder check fixes" at the end maps each to the task or ruling that fixes it. Task 11 of revision 1 is split, so the tasks are renumbered (21 tasks, one optional).

**Goal:** Give the city its judgement about his repos and his mornings: on connect it reads what a README promises against what the code does, marks each claim REAL, PARTIAL, MISSING, STUBBED or BROKEN with file and line evidence verified against the committed tree, turns the gaps into draft jobs he accepts in one click; the first open of each day is a brief he can act on in place, every action logged for Phase 4's Triage net; and his own milestones become physical in the city, with a tour that walks through his week.

**Architecture:** The engine gains an audit runner under `engine/audit/` that reuses the market's run machinery unchanged (a fresh clone of the bare mirror under `paths().runs`, the two sandbox profiles, the per-run egress proxy and command broker, the reaper, the leases and caps) to drive one `Provider.audit()` call: a read-only session (`Read`, `Glob`, `Grep` and the `run` tool; no `Edit` or `Write`) whose answer is structured by a JSON schema the backend owns. The engine verifies every piece of evidence against the base commit through its own `git` (`ls-tree`, `show <baseSha>:<path>`), never against the working tree the agent could have written to, writes the report as a Beagle-style Markdown page, and posts each proposal as a `proposed` job that bids only after his click. Audit spend is charged to the city under the same kinds lists the caps, the treasury and the report already read. A brief module composes the day's report with the ledger since his previous open day into actionable items, serves them with their actions, and records every action he takes. A milestones module derives skyline, revival and ribbon events from the emitted bus events and the towers, and a pure tour planner lays out the week as camera stops. The UI adds the brief screen, the audit report on the district page, a scope editor on a proposed job, Settings for the audit, and in the city a lit spire, scaffolding lights, a ribbon and the tour. Two tracks run in parallel: the screens track (Tasks 1 to 13, 20 and 21) and the city track (Tasks 14 to 19).

**Tech Stack:** Node 22.13+, TypeScript, tsx, `node:test`, `node:sqlite`, three.js 0.187, Vite 8, Playwright, Tauri 2, `gh`, `git`, `sandbox-exec`, the `claude` CLI 2.1.319+ (his own install; `--json-schema`, `--tools`, `--allowedTools`, `--disallowedTools`, `--include-hook-events` and `--max-turns` as Phase 2 uses them), Ollama 0.40+ on `127.0.0.1:11434`.

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 3 in section 13; sections 6.2, 7.1, 8, 9.1, 10, 11, 15 to 18 apply). The Phase 2 plan `docs/superpowers/plans/2026-11-10-phase-2-market.md` fixes the conventions, the rulings (numbered 1 to 30 there and cited here as "Phase 2 ruling n") and the test safety rules this plan continues; its SDD ledger `.superpowers/sdd/2026-11-10-phase-2-market/progress.md` holds the parked items folded in below.

**Starting head.** The screens track starts from `phase-2` once Phase 2's Task 40 (`6571862` on `screens-40`) has merged into it, which the ledger schedules after Task 32 commits; nothing in Tasks 1 to 13 touches `app/src/city/`. The city track's Tasks 14, 15 and 16 (spire, lights, ribbon) start from the head that contains Phase 2's Task 32 committed (`app/src/city/ambient.ts` and its edits under `app/src/city/`); Tasks 17 and 18 (the tour and the dossier) start from the head that contains Phase 2's Task 35 (`app/src/city/ride.ts`, `shared/ride.ts`, the scripted path mode in `app/src/city/camera.ts`), because they reuse the path mode, `ridePlan()` and `RideKey.caption`. A city task that finds Phase 2 city work uncommitted under `app/src/city/` stops and asks the controller. Tasks 20 and 21 run only after both tracks have merged.

## Decisions for Connor

Eight calls, each one line with the recommendation the plan is written to. A yes to all eight changes nothing below; a different answer changes the named task.

1. **Which repos get an automatic audit, and when.** Recommendation: only a repo whose market switch is on is audited automatically, once, after its first analysis (so a private repo's code reaches his Claude session on connect only where he already turned the market on; every other repo, and every repo connected before Phase 3, is audited only when he asks, from the district page or the brief's "never audited" line); an audit that ended capped, failed or crashed is retried only by hand; an automatic audit waits while his interactive Claude use is active (`interactiveActive`), since it would take the one Claude slot; it runs on `claude:sonnet` when the caps allow, else the largest installed local coder, and may spend at most 40 credits (4% of a five-hour window), charged to the city. Changes Tasks 4 and 13 (ruling 6).
2. **The brief on first open.** Recommendation: a deviation from spec 11's "before the city" that he should approve knowingly: the brief opens before the city on the first open of each local day only when it carries at least one item; on an empty morning the city opens with one quiet line, "Nothing waits on you this morning", and the Brief link stays in the running head. Changes Task 11.
3. **What the spire measures.** Recommendation: both heights, read apart: the lit spire stands on the tower with the greatest earned height above its datum (so the skyline is a market event and moves as firms build), and the tallest tower by total height (founding floors counted) carries an unlit finial as the founding skyline; a tower that once held the lit spire keeps it unlit when passed. The alternative, total height alone, would put the first spire on the biggest repo's founding tower and almost never move it. Changes Task 14 (ruling 11).
4. **Revival and ribbon lifetimes.** Recommendation: a repo is quiet after 90 days without a floor (founding or earned); the first merged floor after a quiet spell hangs scaffolding lights on the tower for 7 days; a firm's first PR puts a ribbon round that floor until 7 days after it merges (or until the PR closes). Changes Tasks 7, 15 and 16.
5. **The week tour.** Recommendation: a silent scripted camera walk of about 90 seconds from the exchange through at most eight stops (merged floors, scars, ribbons, a new spire, a revived repo, a new firm), captions in the ride's type, Escape ends it; the brief offers it on Monday mornings and the city any time with `T`. Changes Tasks 7 and 17.
6. **Interior rides.** Recommendation: no interiors in Phase 3; the exterior ride gains a floor dossier instead (its diff in numbers, the agent's plan, the inspection verdict, and for a proposal floor the README claim behind it; Task 18), which is the content an interior would need, where he already is; Task 19 (one glazed room behind the datum floor) is scoped and runs only on his yes, otherwise the question returns in Phase 5 with the dossier in hand.
7. **Raising today's limit from the brief.** Recommendation: "Change today's limit" may lower the cap or raise it above `dayCapPct`, up to 5 points under the hard stop (`hardStopPct - 5`), for today only; it expires at midnight and the treasury and the report say it was set by him. Changes ruling 10 and Task 6 if he wants raising refused.
8. **What the brief writes to the ledger.** Recommendation: his actions only (`brief.action` for accept, tier, dismiss, retry, resume, cap, audit, tour and the UI actions why, diff, fly, open-pr), plus one `brief.opened` a day whose data lists the item ids it showed, so "shown and not acted on" is derivable for Triage without a row per item scrolled into view; no `seen` rows. Changes ruling 9 and Task 6.

## Global Constraints

- Engine API on `127.0.0.1:4770` only, with the Host and Origin checks and the `x-palimpsest: 1` header on every write; UI dev server on `4771`. Ollama only at `127.0.0.1:11434`, only from the engine, never from a route (Phase 2 test safety rule 9).
- Data directory `~/Library/Application Support/Palimpsest`, overridable with `PALIMPSEST_HOME`; every test sets it to a temp dir.
- `redact()` (`engine/market/jobs.ts`) and `scrub()` (`engine/market/api.ts`) on everything that leaves the engine: every audit finding, claim, evidence note, proposal body, brief item, milestone title, tour caption, ledger row and event is scrubbed server-side (the SSE path already scrubs every emitted event in `server.ts`; the API views get it in Task 8); the UI cleans it again with `cleanText()`.
- The market is off by default (`Repo.market false`); the audit is not the market: it never bids, never commits, never pushes and never writes to GitHub. Its proposals are `proposed` jobs that wait for his click (Phase 2 ruling 23 holds for them). An automatic audit runs only where the market is on (Decision 1).
- Audit runs carry every guard of a market run: a fresh `git clone --local --no-hardlinks` of the bare mirror under `<home>/runs/<auditId>/repo` with push URL `no-push://palimpsest`, the per-run fake `HOME`, empty `GIT_CONFIG_GLOBAL`, no credentials in the environment, the tool profile for every command and the CLI profile for `claude`, the egress proxy (`install` to the registries, `reading` to the registries plus the model host), the command broker and the reaper. The audit's tools are read-only; the audit never calls `commitAll`, `diffOf`, `createShipDir` or `ship`; nothing in its clone is ever shipped.
- The audit is charged to the city under the same caps and leases as a run (`acquire(model, 'work', …)`), its credits rows (`kind 'audit'`) count in the day cap, the night cap, the hard stop, the treasury and the report exactly as a run's do, it pauses with a stale reading and aborts on the stop file and the hard stop.
- Never without asking: unchanged from Phase 2; the audit adds no GitHub write at all.
- No loops: an audit proposes only `proposed` jobs; a proposal's body carries `CITY_MARKER`; an audit runs only once after a market-on repo's first analysis or on his click, never after a city merge; `docs/SELF_RECURSION_GUARDRAILS.md` gains the audit arrows (Task 5).
- Ledger: every audit start and end (with its findings), every proposal, every brief open and action, every milestone is recorded append-only with kinds from `LEDGER_KINDS`, replays and is compared by `verifyReplay()`.
- Tests never touch port 4770, the real data home, his keychain, or his real `~/.claude`, `~/.codex` or `~/.gemini` (Phase 2 test safety rules 1 to 10 apply; the audit tests use the fake provider and `PALIMPSEST_SANDBOX=off` under a temp home; no test or route runs `ollama list`).
- The ui-test guard is 12M triangles and 850 draw calls from home; every city task keeps 60 fps on his M5 Pro at every view it adds.
- No em dashes, `--` or emojis in UI copy, README, report pages or commit text. No AI look: sentence case, hairline rules, ledgers not cards, no badges or counters of any kind in the play work.
- Every visible change: build, screenshot at full size and zoomed crops, critique, iterate (three rounds for 3D, two for screens); rounds and what is still weak go in the commit body.
- README media only from the sample dataset (Task 9's additions), never his repos.
- Commit trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UGpw98HC7NNMT1jveHzgfa`.

## Phase 3 rulings on spec gaps

1. **What an audit reads.** The claims come from `README.md` (any case, `.md`, `.rst` or `.txt`) and every Markdown file under `docs/`, which the engine reads from the base commit and passes in the prompt capped at `AUDIT_READ_CAPS.claude` (200 KB in all) for a Claude model and `AUDIT_READ_CAPS.local` (24 KB in all, the README first) for a local model, whose loop window is 32,768 tokens; the code is read through the tools either way, each tool result capped at 8 KB for a local model (`AUDIT_LOCAL_RESULT`), and the repo's own checks are run through the `run` tool. A repo with no README ends `done` with zero findings and the line "No README to check."
2. **The verdicts** (spec 10, the Beagle audit as template): `REAL` (the code exists, is wired and is exercised by a test the audit found or ran), `PARTIAL` (exists and is wired, but a named part of the claim is absent or untested), `MISSING` (nothing in the code does it), `STUBBED` (a function or path exists but returns a fixed or placeholder value, or is unreachable from any entry point), `BROKEN` (wired, but a test fails, a type error stops it, or the audit's own run of it fails). Every finding carries `tested: boolean` and at least one evidence line; `REAL` needs an evidence line in a test file or a passing `run` of the repo's check.
3. **Evidence is verified against the base commit, never the working tree.** The audit's tools cannot write (`AUDIT_TOOLS = ['Read', 'Glob', 'Grep']` plus `RUN_TOOL` for claude; `AUDIT_LOOP_TOOLS` = `read_file`, `list_files`, `search`, `run` for the loops), and the clone is checked clean after the session (`git status --porcelain` through `engineGit` after `runQuiet()`; anything listed ends the audit `failed` with "the audit wrote to its clone"). For each `{ file, line }` the engine checks through `engineGit` that `git ls-tree <baseSha> -- <file>` names a blob (a regular file, not a symlink, a gitlink or a tree, never under `.git`) and that `line` is null or within the line count of `git show <baseSha>:<file>`; a failing piece is kept with `verified: false`. A finding with no verified evidence becomes `unverified` and gets no proposal. Paths are stored relative to the clone root; a path with `..`, an absolute path or a backslash is refused at parse time.
4. **Proposals.** A `MISSING`, `STUBBED` or `BROKEN` finding, and a `PARTIAL` one whose missing part the agent can name, may carry one proposal: title, body (the claim, the evidence, what to build, written for a firm to bid on), `scope` (globs the agent names, filtered to paths that exist at `baseSha` or to new paths under an existing directory, `DENY_SCOPE` removed), `acceptance` (at least one line) and a suggested tier (`low`, `normal` or `high`, default `normal`). The engine posts it as a job with `source 'proposal'`, `status 'proposed'`, `value TIER_VALUE[tier]`, body prefixed with `CITY_MARKER`. Its key is `<repo>#<sha1 of the normalised claim>[:12]`; a key that already has a job in any status but `withdrawn` by the city (never by him) is not proposed again; a key he dismissed stays dismissed across re-audits; a key whose job merged is not proposed again unless the next audit still finds the claim `MISSING` or `BROKEN` (then it is proposed with "proposed again: the merge did not close it" in its body). He may edit a proposed job's scope and acceptance before accepting it (`setScope()`, Task 5; the editor, Task 10).
5. **The audit's model and cost.** `Settings.auditModel` is `'auto'` (default) or a `ModelRef`. `auto` picks `claude:sonnet` when `callPaused('claude:sonnet', AUDIT_ESTIMATE)` is null, else the installed Ollama model whose name contains `coder` with the largest parameter tag (`30b` over `7b`, parsed from the name; `localSize(name)` in `firms.ts`), else any installed Ollama model by the same rank, else the audit waits for Claude (status `waiting` with the reason). `AUDIT_ESTIMATE = 20` credits reserved on the lease; `Settings.auditMaxCredits = 40` ends the session `capped`. Credits rows carry `kind 'audit'`, `firm_id NULL`, `run_id <auditId>`; `'audit'` joins `SPEND_KINDS` (`budget.ts`), `CALL_KINDS` (`spend.ts`) and the report's call kinds, so the day cap, the night cap, the hard stop, `citySpent`, the treasury's spend tables and the daily report count it as the city's own spend beside reviews and design checks.
6. **When an audit runs** (Decision 1). Automatically: once, after a repo's first successful analysis, when `Repo.market` is true, `Settings.auditOnConnect` is true and the repo has never been audited (`latestAudit(repo) === null`, so a capped, failed or crashed audit is never retried by itself); there is no backfill of repos connected before Phase 3 (the brief's `audit-due` item and the district page carry them). On demand: from the district page or the brief, on any connected repo, market on or off, at most one waiting or live audit per repo. The scheduler starts an audit only when `config.preflight()` is null, no other audit is live city-wide (so audits never take both Claude slots), the lease is granted, and, for an automatic one, `interactiveActive()` is false (an automatic audit waits in `waiting` with the reason "waiting for your Claude session to go quiet" and is re-tried each tick; an on-demand one runs under the usual back-off like a run). Audits are started outside the scheduler's `eligible` (market-on) filter so an on-demand audit on a market-off repo runs. Never on a schedule, never after a city merge, never on re-analysis.
7. **The audit page.** `paths().reports/audits/<repo-slug>-<auditId>.md`: a Beagle-style page: a lead ("Of 14 claims in the README, 8 are real, 2 partial, 3 missing and 1 broken."), then a table of claims with verdict, tested, evidence (as `file:line`) and the proposal title, then "Real and tested", "Broken or missing" and "Proposed" sections in prose. Rendered by `renderAudit()`; the API serves the Markdown and the data.
8. **The brief's window.** `since` is the first `brief.opened` of the most recent local day before today that has one (the previous open day), or 24 hours ago when there is none; the brief's items are built from the ledger over `[since, now]` (`query({ from: since })` by kind) and from the live state (open PRs, proposed jobs, halts, the reading), and its numbers (spend, merges counted) come from `reportData(today)` plus the previous days' stored reports in the window, never recomputed. Two windows opened the same day therefore carry the same items; the second says `firstOpen: false`. Every day he opens the app records one `brief.opened`, empty morning or not (so `since` never reaches further back than his last look), with `data.items` the item ids shown (Decision 8). Items are stable by id (`pr:<runId>`, `proposal:<jobId>`, `merged:<jobId>`, `failed:<jobId>`, `revert:<ledgerId>`, `halt:<repo>`, `note:<ledgerId>`, `audit:<auditId>`, `audit-due:<repo>`, `usage`, `stale`, `milestone:<id>`, `tour:<weekStart>`); an item he acted on shows its action and is not offered again, except `pr` and `halt` items, which stay until the state they report clears.
9. **Brief actions and what they do.** `accept` (a proposal to `open`, through `acceptProposed`), `tier` (`setTier`, then stays), `dismiss` (a proposal to `withdrawn` through `dismissProposed`; any other item hidden; always recorded with `taught: true`, the triage signal), `why` (no engine change; the UI opens the job's award prose, the finding's evidence or the run's end reason), `diff` and `fly` (UI only, recorded), `retry` (`repost` of a failed job with attempts left), `resume` (`resumeRepo`), `open-pr` (UI opens the PR; recorded), `cap` (`{ pct }` sets `Settings.todayCapPct = { day, pct }`, honoured by `budget.ts` in place of `dayCapPct` while `day` is today), `audit` (queues an on-demand audit on the item's repo), `tour` (recorded when he takes it). Every action records `brief.action { day, itemId, kind, action, taught, at, patch }` and emits it. There is no `seen` action (Decision 8).
10. **Today's cap** (Decision 7). `todayCapPct.pct` is clamped to `[5, hardStopPct - 5]`, may stand above `dayCapPct`, and expires at local midnight; the treasury shows "today's limit 30%, set by you this morning" while it holds; the daily report names it.
11. **Milestones** (spec 18, Decisions 3 and 4), all keyed on emitted bus events: `skyline` (on `floor.lit`: the tower with the greatest earned height above its datum, `layoutTower(spec).top - layoutTower(spec).datumY`, over every standing tower with at least one lit earned floor; `until null`; `lit` true for the holder, false once passed; the founding skyline, the greatest `layoutTower(spec).top`, is a separate `founding-skyline` row that is never lit), `revival` (on `floor.lit` for a repo tower whose previous newest floor `at` is `QUIET_DAYS` or more earlier; `until` 7 days after), `ribbon` (on `floor.laid` whose `floor.earned.state` is `'waiting'` and whose firm has no earlier earned floor: the firm's first PR; `until` becomes `floor.lit` plus `RIBBON_DAYS` when that floor lights, or now on `job.changed` to `closed` for its job or on `firm.bankrupt` for its firm). `pr.opened` and `merge.detected` are ledger kinds only (`ship.ts` records them without emitting) and are not used. Backfilled once from the towers and the ledger at engine start (`milestone.reached` is idempotent by id). Milestones are never counted or scored anywhere: no totals, no lists of "achievements"; each is shown only in the city, in the brief the morning it happens, and on the floor's row in the inspector.
12. **The tour** (Decision 5): `tourPlan(week, events, standing): Tour | null` is pure; stops are, in time order, up to eight of: merged floors (`floor.lit`), scars (`floor.scarred`), milestones, a firm's first job, a hire; fewer than two stops means "no tour this week". Each stop dwells 6 s with a caption; the camera glides 4 s between stops; it starts and ends at the exchange (3 s each), about 90 s at eight stops. Stops on towers that no longer stand are dropped at plan time.
13. **Provider.audit().** The Provider interface (frozen in Phase 2 Task 1) gains one method, `audit(i: AuditInput): Promise<AuditResult>`, implemented by all four backends in Task 3 (the builder check agreed, on these conditions): `AuditInput` carries no `Agent` (the surveyor's persona is `engine/audit/prompt.md`), so `claude.ts` factors `work()` into `drive()` with the prompt, the system prompt, the model, the tools and the schema as parameters; `toolloop.ts` is generalised the same way (prompts and tools as parameters, a JSON answer as the finish); each backend imports `AUDIT_SCHEMA` from `engine/audit/schema.ts` rather than taking it through the input; the Task 1 stubs throw `not implemented` only because no caller exists before Task 3. Nothing else in the interface changes.
14. **An audit never halts a repo or strikes a firm.** A failed, capped, crashed or killed audit records `audit.ended` with its reason, keeps its log under the audit root (`KEPT` files as a run), proposes nothing, and can be run again by hand. It touches no reputation.
15. **The JSON the agent returns is data.** It is parsed with `parseAudit()` against `AUDIT_SCHEMA` (unknown keys dropped, strings capped: claim 400 chars, note 300, title 120, body 4,000; at most 60 findings and 3 evidence lines each), then redacted; a shape failure ends the audit `failed` with "the audit's answer did not parse" and the raw text kept in the log only.

## Folded from the Phase 2 ledger

| Parked item (ledger line) | Where it lands |
|---|---|
| Task 14 deferred: merged harness jobs re-proposed when detection still finds nothing | Task 5: every proposal, the harness included, carries a `key`; a merged or dismissed key is not proposed again by itself; the district page gets "Propose again" |
| Task 37 parked: API `CheckView` notes, concerns and offenders not redacted server-side | Task 8: `scrub()` on every inspection and job view field; test pins it |
| Task 20 deferred: the token regex forms | Done in Phase 2 (`jobs.ts` 412 to 427); Task 8 keeps the pins |
| Task 22 minors: the governor notice should name the frame rate; Dismiss clears all joined notices | Task 12: notices as a stack with one Dismiss each and the frame rate in the drop notice |
| Audit line: the quality-drop notice draws over an open sheet's lower left | Task 12: notices stand clear of an open sheet |
| README line 77 and `repos.ts` copy: "push mode is stored now for when the market opens" | Task 21 (README) and Task 13 (copy) |
| Spec 17: proposals and brief items arrive with a suggested tier he can change in one click | Tasks 5, 10 and 11 |
| Spec 17: a self-halt "puts it in the brief" | Task 6 |
| Left in Phase 5 by the ledger's own rulings (overview haze, far coursing, ceramic in sun, cluster pods, corner window stretch, lens glint on tall glass, ferry wake crests, train bulkhead, stylised trees, dark tower from home, rendered.ts re-measure, a clear-air daytime still) | not in this plan |

## Review Focus

1. A repo with no README, a README of prose that promises nothing testable, or a README of 2 MB of generated text: the audit ends `done` with zero or few findings, charges what it spent, proposes nothing, the district page says "No README to check" or lists what it found, and nothing hangs. (Tasks 2 and 4.)
2. An audit answer that cites `/Users/him/...`, `../../.ssh/id_rsa`, a file under `.git`, a file the agent created in the clone, a line past the end of the file, or a proposal whose scope is `**/.env`: the evidence is unverified, a written clone fails the audit, the scope is filtered, no path of his Mac appears in the stored audit, the API, the event stream or the page. (Tasks 2, 4, 5 and 8.)
3. The stop file, the hard stop, the credit cap, the wall deadline or an engine shutdown arrives while an audit is reading: the session is killed within 5 s, the audit ends `killed`, `capped` or `crashed`, nothing is proposed, the repo is not halted, no strike is written, its spend counts in the caps, and "Audit the README" on the district page starts it again. (Task 4.)
4. The engine was down over midnight, or the app is opened in two windows: one `brief.opened` per day, the second window's brief says it is not the first open and carries the same items, an action taken in one window shows as taken in the other without reload, and the day's report still exists for the day he missed. (Tasks 6 and 11.)
5. A tower that holds a spire, a ribbon or scaffolding lights is disconnected, re-analysed, sold dark or its firm goes bankrupt: the ornament leaves with the tower, re-analysis keeps it (milestones key on floor ids `repoFloorId()` and `agentFloorId()`, which are derived and survive Phase 2 ruling 17), and a bankrupt firm's ribbon comes down the frame the tower darkens. (Tasks 7 and 14 to 16.)

---

## File Structure

```
shared/types.ts                 + Verdict, Evidence, Finding, Proposal, Audit, AuditStatus, AuditView, BriefItem, BriefItemKind,
                                  BriefAction, Brief, Milestone, MilestoneKind, Tour, TourStop; Job.source + 'proposal' | 'brief';
                                  Job.proposal, Job.key; Repo.auditedAt; Settings + auditOnConnect, auditModel, auditMaxCredits, todayCapPct
shared/ledger-kinds.ts          + audit.started, audit.stage, audit.ended, brief.opened, brief.action, milestone.reached
shared/market-rules.ts          + proposalKey(), HARNESS_KEY, AUDIT_*, QUIET_DAYS, RIBBON_DAYS, LIGHTS_DAYS, TOUR, todayCap(), localSize()
shared/tour.ts                  pure: weekOf(), tourPlan()
engine/db.ts                    + audits, milestones tables; jobs.key; migrations
engine/market/provider.ts       + AuditInput, AuditResult, Provider.audit
engine/audit/schema.ts          AUDIT_SCHEMA, AUDIT_TOOLS, AUDIT_LOOP_TOOLS, auditPrompt(), parseAudit(), verifyEvidence(), renderAudit()
engine/audit/prompt.md          the surveyor's instructions, the Beagle audit as the worked example
engine/audit/run.ts             the audit runner: root, clone, egress, broker, install, the session, clean check, verify, store, charge, ledger
engine/audit/store.ts           audits table reads and writes
engine/audit/proposals.ts       proposeFromAudit(), the key rule
engine/brief.ts                 briefData(), openBrief(), actOn()
engine/market/milestones.ts     detection on the bus, backfill, listMilestones(), weekTour()
engine/market/claude.ts         + drive(); audit()
engine/market/toolloop.ts       + runLoop() generalised; audit()
engine/market/fake-provider.ts  + audit() scripted
engine/market/budget.ts         + 'audit' in SPEND_KINDS and charge(); todayCap() read
engine/market/spend.ts          + 'audit' in CALL_KINDS; PAYER unchanged (the city pays)
engine/market/report.ts         + 'audit' in the call kinds; today's cap; proposals under "Waiting on you"; num() exported
engine/market/replay.ts         + audits and milestones in MarketState and verifyReplay()
engine/market/runs.ts           + the scheduler starts queued audits; audits in the watcher, the shutdown kill and the interrupted sweep
engine/market/jobs.ts           + source 'proposal' | 'brief', keys, postProposal(), setScope()
engine/market/api.ts            + audit, brief, milestone and tour routes; PATCH job scope; scrub on every view field
engine/market/sample-economy.ts + sample audits, proposals, a week of milestones, a brief with every item kind
docs/SELF_RECURSION_GUARDRAILS.md  + the audit arrows
app/src/api.ts                  + audits, brief, milestones, tour, job scope; EVENT_TYPES
app/src/router.ts               + #/brief, #/audits/:id
app/src/ui/brief.ts, brief-words.ts   the brief screen and its pure view logic
app/src/ui/audit.ts             the audit report block (district page and #/audits/:id)
app/src/ui/notices.ts           the notice stack (from main.ts createNotice)
app/src/ui/repo.ts, repos.ts, jobs.ts, job.ts, settings.ts, runhead.ts, treasury.ts, main.ts   as the tasks say
app/src/city/scene.ts           + towerPiece(towerId), setMilestones(), milestoneShows()
app/src/city/milestones.ts      spire, finial, scaffolding lights, ribbon (city track)
app/src/city/tour.ts            the week tour camera (city track)
app/src/city/ride.ts, shared/ride.ts   + the floor dossier (city track)
tools/ui-test-brief.ts, tools/ui-test-audit.ts, tools/ui-test.ts, tools/capture.ts
test/*.test.ts                  node:test suites per task
```

## Pre-flight conflict table

| Tasks | Shared | Resolution |
|---|---|---|
| 1, all | `shared/types.ts`, `LEDGER_KINDS`, `Provider.audit`, the spend kinds lists | Task 1 freezes them; a later task needing a field adds it in its own commit and notes it in the ledger |
| 1, 3 | `AuditInput`, `AuditResult`, `AUDIT_SCHEMA` | Task 1 defines the types; Task 2 owns the schema; Task 3 implements on four backends importing it; Task 4 calls only `providerFor(model).audit()` |
| 2, 4 | `parseAudit()`, `verifyEvidence(findings, dir, baseSha)`, `renderAudit()` | Task 2 is pure over strings and a git dir; Task 4 calls them after `runQuiet()` and the clean check |
| 4, 5 | `Audit` stored vs proposals | Task 4 stores the audit and emits `audit.ended`; Task 5 subscribes and proposes; Task 4 never writes jobs |
| 4, Phase 2 `runs.ts` | the scheduler, the watcher, shutdown | audits live in their own `liveAudits` map in `engine/audit/run.ts`; `runs.ts` calls `startQueuedAudit()`, `watchAudits()`, `killLiveAudits()` and `failInterruptedAudits()` at the four places named in Task 4 |
| 5, Phase 2 `jobs.ts` | `JobSource`, `transition()` | proposals move only through `transition()`; `LEGAL_MOVES` is unchanged (`proposed` already has `open` and `withdrawn`) |
| 6, Phase 2 `report.ts` | the day's data | `briefData()` reads `reportData(today)` and stored reports for its numbers and the ledger for its items; the report gains the audit spend and today's cap in Task 6 |
| 6, 1 (budget) | `todayCapPct` | Task 6 writes it through `patchSettings`; `budget.ts` reads it in Task 1; the treasury view shows it in Task 11 |
| 7, 14 to 17 | `Milestone`, `Tour` | engine produces, city consumes by id; the city never derives a milestone itself |
| 8, 10 to 13 | `api` client | screens call only what Task 8 added |
| 9, 21 | sample audits and milestones | `seedEconomy()` is the only entry point; captures and UI tests seed it |
| 11, Phase 2 Task 39 | the treasury's report block | the brief renders its own items; the report stays on the treasury; both link to each other |
| 12, 11 | notices | Task 12 moves `createNotice` to `app/src/ui/notices.ts`; Task 11 uses the notice for the empty morning through the same `add()` |
| 14, 15, 16, Phase 2 Tasks 22 to 28 | `tower/build.ts`, `quarters.ts`, `scaffold.ts`, `crowns.ts` | the ornaments are built in `app/src/city/milestones.ts` into their own `Kit` and attached by `towerPiece(towerId)`; the tower builders are not edited |
| 17, 18, Phase 2 Task 35 | `camera.ts` scripted path, `ride.ts` captions | Task 17 reuses the path mode; Task 18 extends `RideKey.caption` with a `dossier` and does not change `ridePlan()`'s floor timings except the dossier dwell |
| 14 to 18, 21 | `tools/ui-test.ts` perf guard | every city task re-measures from home; the 12M and 850 guard is not raised |

Known orderings: Task 1 before everything; Task 2 before Tasks 3 and 4; Task 3 before Task 4; Task 4 before Task 5; Tasks 5, 6 and 7 before Task 8; Task 8 before Tasks 9 to 13 and 14 to 17; Task 9 before every UI test; Task 12 before Task 11's empty-morning check; Phase 2 Task 32 (committed) before Tasks 14, 15 and 16; Phase 2 Task 35 (`app/src/city/ride.ts`, `shared/ride.ts`, `camera.ts` path mode) before Tasks 17 and 18; both tracks merged before Tasks 20 and 21.

## Model marks

**[Opus]** for every task but Task 8 and Task 13, which are **[Sonnet]** with a full brief. Reviews of logic and visual work go to Opus.

---

## Part A: the engine (screens track)

### Task 1: Types, schema, ledger kinds, spend kinds, settings, replay and Provider.audit [Opus] [screens]

**Files:**
- Modify: `shared/types.ts`, `shared/ledger-kinds.ts`, `shared/market-rules.ts`, `engine/db.ts`, `engine/settings.ts`, `engine/market/provider.ts`, `engine/market/budget.ts` (`SPEND_KINDS` gains `'audit'`; `charge()` kind union gains `'audit'`; `todayCap()` read), `engine/market/spend.ts` (`CALL_KINDS` gains `'audit'`), `engine/market/report.ts` (the call kinds at line 229 gain `'audit'`; `num()` exported), `engine/market/replay.ts` (`MarketState.audits`, `MarketState.milestones`, the switch cases, `verifyReplay()` compares both tables), `engine/market/claude.ts`, `engine/market/toolloop.ts`, `engine/market/fake-provider.ts` (stubs)
- Test: `test/market-types.test.ts`, `test/market-rules.test.ts`, `test/db.test.ts`, `test/replay.test.ts`, `test/budget.test.ts`, `test/spend.test.ts`

**Interfaces:**
- Produces (`shared/types.ts`):
  ```ts
  export type Verdict = 'REAL' | 'PARTIAL' | 'MISSING' | 'STUBBED' | 'BROKEN';
  export interface Evidence { file: string; line: number | null; note: string; verified: boolean }
  export interface Proposal { key: string; title: string; body: string; scope: string[]; acceptance: string[]; tier: Tier; jobId: string | null }
  export interface Finding { id: string; claim: string; source: { file: string; line: number | null }; verdict: Verdict; tested: boolean;
    evidence: Evidence[]; unverified: boolean; proposal: Proposal | null }
  export type AuditStatus = 'waiting' | 'preparing' | 'installing' | 'reading' | 'done' | 'failed' | 'capped' | 'killed' | 'crashed';
  export type AuditTrigger = 'connect' | 'demand' | 'brief';
  export interface Audit { id: string; repo: string; model: ModelRef | null; trigger: AuditTrigger; baseSha: string | null; status: AuditStatus;
    waitingReason: string | null; startedAt: string; endedAt: string | null; endedReason: string | null; findings: Finding[]; counts: Record<Verdict, number>;
    unverified: number; claimsRead: number; credits: number; unattended: boolean; markdownPath: string | null }
  export type AuditView = Omit<Audit, 'markdownPath'> & { markdown: string | null; proposals: Job[] };
  export type BriefItemKind = 'merged' | 'failed' | 'pr' | 'proposal' | 'halt' | 'revert' | 'note' | 'audit' | 'audit-due' | 'usage' | 'stale' | 'milestone' | 'tour';
  export type BriefAction = 'accept' | 'tier' | 'dismiss' | 'why' | 'diff' | 'fly' | 'retry' | 'resume' | 'open-pr' | 'cap' | 'audit' | 'tour';
  export interface BriefItem { id: string; kind: BriefItemKind; repo: string | null; title: string; text: string; at: string; tier: Tier | null;
    refs: { jobId?: string; runId?: string; inspectionId?: string; prUrl?: string; floorId?: string; auditId?: string; milestoneId?: string; firmId?: string };
    actions: BriefAction[]; acted: { action: BriefAction; at: string } | null }
  export interface Brief { day: string; since: string; firstOpen: boolean; due: boolean; lead: string;
    usage: { fiveHour: BudgetWindow; sevenDay: BudgetWindow; todayCapPct: number | null; paused: TreasuryState['paused'] };
    sections: { waiting: BriefItem[]; overnight: BriefItem[]; recommendations: BriefItem[]; city: BriefItem[] };
    tour: { week: string; stops: number } | null }
  export type MilestoneKind = 'skyline' | 'founding-skyline' | 'revival' | 'ribbon';
  export interface Milestone { id: string; kind: MilestoneKind; towerId: string; repo: string | null; firmId: string | null; agentId: string | null;
    floorId: string | null; at: string; until: string | null; lit: boolean; title: string; detail: string }
  export interface TourStop { kind: 'merged' | 'scar' | 'skyline' | 'revival' | 'ribbon' | 'firm' | 'hire' | 'exchange'; towerId: string | null; repo: string | null;
    floorId: string | null; agentId: string | null; firmId: string | null; title: string; caption: string; at: string; dwell: number; glide: number }
  export interface Tour { week: string; from: string; to: string; stops: TourStop[]; seconds: number }
  // Job: source: 'issue' | 'manual' | 'harness' | 'proposal' | 'brief'; + proposal?: { auditId: string; findingId: string } | null; + key?: string | null.
  // Repo: + auditedAt: string | null.
  // Settings: + auditOnConnect: true, auditModel: 'auto' | ModelRef ('auto'), auditMaxCredits: 40, todayCapPct: { day: string; pct: number } | null (null).
  ```
- Produces (`shared/market-rules.ts`): `AUDIT_ESTIMATE = 20`, `AUDIT_MAX_FINDINGS = 60`, `AUDIT_MAX_EVIDENCE = 3`, `AUDIT_TEXT_CAPS = { claim: 400, note: 300, title: 120, body: 4000 }`, `AUDIT_READ_CAPS = { claude: 200_000, local: 24_000 }` (chars), `AUDIT_LOCAL_RESULT = 8_000`, `AUDIT_CAPS = { claude: { maxTurns: 60, maxMinutes: 25 }, local: { maxTurns: 40, maxMinutes: 25 } }`, `QUIET_DAYS = 90`, `LIGHTS_DAYS = 7`, `RIBBON_DAYS = 7`, `TOUR = { maxStops: 8, dwell: 6, glide: 4, exchange: 3, minStops: 2 }`, `proposalKey(repo, claim): string`, `HARNESS_KEY(repo) = repo + '#harness'`, `todayCap(settings, day): number` (ruling 10), `localSize(name: string): number` (the parameter tag in billions from an Ollama name: `30b-a3b` is 30, `7b` is 7, none is 0).
- Produces (`shared/ledger-kinds.ts`): `audit.started`, `audit.stage`, `audit.ended`, `brief.opened`, `brief.action`, `milestone.reached`.
- Produces (`engine/db.ts`): `audits (id TEXT PRIMARY KEY, repo TEXT, status TEXT, started_at TEXT, json TEXT)` with index `audits_repo (repo, started_at)`; `milestones (id TEXT PRIMARY KEY, kind TEXT, tower_id TEXT, at TEXT, until TEXT, json TEXT)` with index `milestones_tower (tower_id)`; `jobs` gains `key TEXT` with index `jobs_key (key)` (migration adds it when missing).
- Produces (`engine/market/provider.ts`):
  ```ts
  export interface AuditInput { repo: Repo; auditId: string; dir: string; baseSha: string; readme: { path: string; text: string } | null;
    docs: Array<{ path: string; text: string }>; checks: RepoChecks | null; model: ModelRef; log: (line: RunLogLine) => void;
    onProgress: (p: Partial<RunProgress>) => void; signal: AbortSignal; caps: { maxTurns: number; maxMinutes: number; maxCredits: number } }
  export interface AuditResult { answer: unknown; text: string; usage: Usage; ended: 'finished' | 'capped' | 'aborted' | 'crashed'; reason: string | null }
  // Provider: + audit(i: AuditInput): Promise<AuditResult>;
  ```
- Produces (`engine/market/replay.ts`): `MarketState.audits: Record<string, Audit>` (from `audit.started` then `audit.ended`), `MarketState.milestones: Record<string, Milestone>` (from `milestone.reached`); `verifyReplay()` diffs both against their tables; `brief.opened` and `brief.action` carry no table and are matched by the switch.
- [ ] **Step 1: Write the failing tests:** `proposalKey is stable across whitespace and case`; `todayCap clamps and expires at midnight` (yesterday's yields `dayCapPct`; `{ pct: 2 }` yields 5; `{ pct: 99 }` with `hardStopPct 90` yields 85; `{ pct: 70 }` with `dayCapPct 50` yields 70); `localSize ranks 30b-a3b over 7b over a name without a tag`; `the db has audits and milestones tables and jobs.key`; `replay rebuilds an audit and a milestone from their entries and verifyReplay compares them` (drop the rows, replay, `ok` true; corrupt a row, `ok` false); `an audit charge counts in the five-hour window, the night cap and citySpent` (`charge({ kind: 'audit', firmId: null, … })` at night, then `treasury().fiveHour.cityPct`, `.night.usedPct` and `.citySpent.today` all rise by it); `the spend tables show an audit charge under the city's own calls` (`spend.ts`); `the treasury honours today's cap`; pin: `charge accepts kind audit with a null firm` (passes at runtime today, since `credits.kind` has no CHECK; kept as a pin on the type).
- [ ] **Step 2:** Run `npm test` and `npm run typecheck`; expect FAIL on the new tests and the type check.
- [ ] **Step 3:** Implement. The three backends get an `audit()` stub throwing `not implemented` (ruling 13; replaced in Task 3).
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5:** Commit `Lay the Phase 3 types: audits, proposals, the brief, milestones, today's cap and the audit's spend`.

### Task 2: The audit prompt, the schema, the parser, evidence against the base commit and the page [Opus] [screens]

**Files:**
- Create: `engine/audit/schema.ts`, `engine/audit/prompt.md`
- Test: `test/audit-schema.test.ts`

**Interfaces:**
- Produces: `AUDIT_SCHEMA: object` (JSON schema: `{ claims: number; findings: Array<{ claim; source: { file; line }; verdict; tested; evidence: Array<{ file; line; note }>; proposal: { title; body; scope: string[]; acceptance: string[]; tier } | null }> }`, `additionalProperties: false`, the verdict enum); `AUDIT_TOOLS = ['Read', 'Glob', 'Grep'] as const` and `AUDIT_LOOP_TOOLS = ['read_file', 'list_files', 'search', 'run'] as const` (ruling 3); `auditPrompt(i: Pick<AuditInput, 'repo' | 'readme' | 'docs' | 'checks' | 'model'>): string` (the task in his terms: list what the README and docs promise, check each against the code with the read tools, run the repo's own checks with the `run` tool where they exist, mark each claim by ruling 2, cite `file:line`, propose a job for each gap by ruling 4, answer only in the schema; "you cannot change files; if a command would, do not run it"; the Beagle findings from spec 9.1 as the example of the register; the README and docs text capped by `AUDIT_READ_CAPS[model kind]`); `parseAudit(answer: unknown, text: string): { claims: number; findings: Finding[] } | { error: string }` (ruling 15: caps, unknown keys dropped, ids `f1..fn`, paths normalised and refused when absolute, containing `..`, a backslash or under `.git`; tier defaulted to `normal`; `DENY_SCOPE` globs removed from `scope`; an empty `acceptance` gets "The claim in the README holds and a test shows it."; the fallback when `answer` is null is the first `{...}` block of `text`); `verifyEvidence(findings: Finding[], dir: string, baseSha: string): Promise<Finding[]>` (ruling 3 through `engineGit(dir, ['ls-tree', baseSha, '--', file])` for mode `100644` or `100755` and `engineGit(dir, ['show', baseSha + ':' + file])` for the line count, each at most once per file; a finding with no verified evidence gets `unverified: true` and `proposal: null`); `cloneClean(dir): Promise<string[]>` (`git status --porcelain` through `engineGit`, the paths listed); `countVerdicts(findings)`; `renderAudit(a: Audit, names: { repoDescription: string | null }): string` (ruling 7; outside strings through `plain()` from `report.ts`); `auditSlug(repo, auditId)`.
- [ ] **Step 1: Write the failing tests** (a bare repo with one 10 line committed file and an uncommitted second file in a clone): `the prompt names the README path, each docs file, the test command and says the tools cannot write`; `the local prompt carries 24 KB of README and the Claude prompt 200 KB` (Review Focus 1's 2 MB README); `parseAudit keeps five verdicts, drops unknown keys, caps 60 findings and 3 evidence lines`; `parseAudit refuses absolute, parent, backslash and .git paths without throwing`; `parseAudit falls back to the JSON block in the text`; `a malformed answer returns an error`; `verifyEvidence marks a file not in the base commit (the uncommitted one), a symlink, a tree and a line past the end unverified, and a finding with none loses its proposal` (Review Focus 2); `cloneClean lists the written file`; `renderAudit writes the lead, the table and the three sections with no dash punctuation and no path of this Mac`.
- [ ] **Step 2:** Run `node --import tsx --test test/audit-schema.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement. The prompt is prose he would write to a careful engineer, short, the five verdicts defined once, the example in a fenced block.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Define the README audit: its prompt, its schema, its parser, evidence against the committed tree and its page`.

### Task 3: Provider.audit on the four backends [Opus] [screens]

**Files:**
- Modify: `engine/market/claude.ts`, `engine/market/toolloop.ts`, `engine/market/ollama.ts`, `engine/market/anthropic-api.ts`, `engine/market/fake-provider.ts`
- Test: `test/claude-provider.test.ts`, `test/toolloop.test.ts`, `test/fake-provider.test.ts`

**Interfaces:**
- Consumes: `AuditInput`, `AuditResult` (Task 1); `AUDIT_SCHEMA`, `AUDIT_TOOLS`, `AUDIT_LOOP_TOOLS`, `auditPrompt()` (Task 2); `AUDIT_CAPS`, `AUDIT_LOCAL_RESULT` (Task 1); `engine/audit/prompt.md` as the surveyor's persona.
- Produces (`engine/market/claude.ts`): `drive(d: { runId; dir; model; system: string; prompt: string; tools: readonly string[]; allowed: readonly string[]; schema: object | null; log; onProgress; signal; caps })` holding the body of today's `work()` (the control files, the hook, the nested sandbox, `--include-hook-events`, the CLI profile, `claudeEnv`, `runQuiet` before start and each tool turn); `work()` calls it with `WORK_TOOLS`, `RUN_TOOL` and no schema; `audit()` calls it with `AUDIT_TOOLS`, `RUN_TOOL`, `--json-schema JSON.stringify(AUDIT_SCHEMA)`, the surveyor persona as the system prompt and the audit prompt on stdin; `answer` is `structured_output` else null; `--disallowedTools` lists `Edit`, `Write`, `MultiEdit`, `NotebookEdit` besides `CLI_DISALLOWED_TOOLS`, and the hook's allow list for an audit excludes them too (`guardHookCommand(runRoot, dir, { readOnly: true })`).
- Produces (`engine/market/toolloop.ts`): `runLoop(o: { transport; system: string; user: string; tools: ToolSpec[]; finish: 'summary' | 'json'; resultCap?: number; } & LoopOptions & Pick<WorkInput, 'log' | 'onProgress' | 'signal' | 'caps'>)`: the loop as today with the prompts and the tool list as parameters; `finish: 'json'` ends when the model's text parses as an object (one retry with "answer only with the JSON object"), else `crashed` with the reason; `resultCap` truncates each tool result (`AUDIT_LOCAL_RESULT` for an audit). `work()` calls it with `LOOP_TOOLS` and `'summary'`; the Ollama and Anthropic API `audit()` call it with the `AUDIT_LOOP_TOOLS` subset (looked up in `LOOP_TOOLS` by name), `'json'`, `num_ctx` the review window and `AUDIT_CAPS.local`.
- Produces (`engine/market/fake-provider.ts`): `FakeScript.audit?: (i: AuditInput) => Awaitable<AuditResult>`; `fakeDefaults.audit(i)` answers two findings from `i.readme` (one `REAL` citing the README's first line, one `MISSING` with a proposal titled from its second heading) and writes nothing.
- [ ] **Step 1: Write the failing tests:** claude: `audit builds the work argv with Read, Glob and Grep only, the run tool, --json-schema and a read-only hook, and reads structured_output` (the fake spawner answers a `stream-json` with `structured_output`); `work still builds the same argv as before drive()` (the existing argv test unchanged); `an audit over its credit cap ends capped`; toolloop: `runLoop with finish json retries once and then crashes`; `an audit loop offers only the read tools and caps each result`; fake: `the default fake audit answers one REAL and one MISSING finding and writes no file`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Teach every backend to audit a repo read-only and answer in the schema`.

### Task 4: The audit runner [Opus] [screens]

**Files:**
- Create: `engine/audit/run.ts`, `engine/audit/store.ts`
- Modify: `engine/market/runs.ts` (the tick calls `startQueuedAudit()` after `startRuns()` and outside the `eligible` filter; `watchOnce()` calls `watchAudits()`; `scheduler.stop()` and `reapLiveRuns()` call `killLiveAudits()`; `failInterruptedRuns()` calls `failInterruptedAudits()`), `engine/repos.ts` (`runAnalysis` calls `queueAudit(repo, 'connect')` per ruling 6; `Repo.auditedAt` set when an audit ends `done`), `engine/market/firms.ts` (`installedModels()` result cached in `lastInstalled()` for `pickAuditModel`)
- Test: `test/audit-run.test.ts`

**Interfaces:**
- Consumes: `createRunDir`, `controlFiles`, `removeRunDir`, `KEPT`, `engineGit` (`worktree.ts`), `startEgress`, `hostsFor` (`egress.ts`), `startBroker`, `forgetRun` (`broker.ts`), `installDeps` (`install.ts`), `acquire`, `charge`, `callPaused`, `unattended` (`budget.ts`), `interactiveActive` (`usage.ts`), `runQuiet`, `reapRun`, `providerFor`, `parseAudit`, `verifyEvidence`, `cloneClean`, `countVerdicts`, `renderAudit`, `auditSlug` (Task 2), `localSize`.
- Produces (`engine/audit/store.ts`): `saveAudit(a)`, `audit(id): Audit | null`, `listAudits(f: { repo?: string; status?: AuditStatus[] } = {}): Audit[]` (newest first), `latestAudit(repo): Audit | null`, `liveAuditIds(): string[]`.
- Produces (`engine/audit/run.ts`): `queueAudit(repo: Repo, trigger: AuditTrigger): Audit` (status `waiting`, records and emits `audit.started`; throws when the repo already has a waiting or live audit); `shouldAutoAudit(repo, settings): boolean` (`repo.market && settings.auditOnConnect && latestAudit(repo.fullName) === null`); `pickAuditModel(settings, installed: string[], now): ModelRef | null` (ruling 5 with `localSize`); `startQueuedAudit(o: { now; preflight; quiet?; reap?; installDeps? }): Promise<Audit | null>` (the oldest `waiting` audit when `await preflight()` is null, no audit is live, `pickAuditModel` returns one and, for `trigger 'connect'`, `interactiveActive(now)` is false (else `waitingReason` is set and it is left waiting); then `acquire(model, 'work', AUDIT_ESTIMATE)`, root `<home>/runs/<auditId>` with `createRunDir(repo, auditId, 'palimpsest/' + auditId)`, egress, broker with `stage: () => toolStage`, `installing` with `hostsFor('install', …)`, then `reading` with `hostsFor('working', ecosystems, model)`, the README and docs read from the base commit through `engineGit show`, `providerFor(model).audit()` with `AUDIT_CAPS[kind]` and `maxCredits settings.auditMaxCredits`, then `runQuiet`, `cloneClean` (anything listed ends `failed`), `parseAudit`, `verifyEvidence(findings, dir, baseSha)`, `renderAudit` to `paths().reports/audits/<slug>.md`, `charge({ kind: 'audit', firmId: null, runId: auditId, … })`, `audit.stage` per stage, `audit.ended` with the whole `Audit`, `repo.auditedAt` on `done`, `removeRunDir` keeping `KEPT`, `forgetRun`, release; never `commitAll`, `diffOf`, `createShipDir` or `ship`); `watchAudits(now)` (a live audit past `startedAt + maxMinutes + RUN_EXTRA_MINUTES` ends `capped` with "wall deadline"); `killAudit(id, reason): boolean`; `killLiveAudits(reason): Promise<void>`; `failInterruptedAudits(): Audit[]` (audits left `preparing`, `installing` or `reading` end `crashed` with `INTERRUPTED_RUN`; `waiting` ones stay); `auditLogPath(id)`.
- [ ] **Step 1: Write the failing tests** (fake provider, `PALIMPSEST_SANDBOX=off`, a bare repo in the temp dir with a README of three claims and a `package.json` with a test script): `a queued audit runs in a fresh clone and ends done with its findings, its page and a credits row of kind audit with no firm that the treasury counts` (push URL `no-push://palimpsest`; root removed, `log.jsonl` kept; `auditedAt` set; `treasury().citySpent.today` rose); `a fake agent that writes a file in the clone fails the audit with "wrote to its clone"` (Review Focus 2); `evidence citing a file the fake agent did not commit is unverified and proposes nothing`; `a repo with no README ends done with zero findings and "No README to check"` (Review Focus 1); `the stop file kills a reading audit within 5 s, leaves the repo unhalted with no strike and counts its spend` (Review Focus 3); `the credit cap ends the audit capped and the wall deadline ends it capped`; `scheduler.stop() kills a live audit`; `an audit left reading when the engine stopped ends crashed at start and a waiting one stays waiting`; `only one audit is live at a time and a repo cannot queue two`; `an automatic audit waits while his interactive use is active and starts when it ends` (`PALIMPSEST_CLAUDE_PROJECTS` at a temp dir with a fresh transcript); `an on-demand audit runs on a market-off repo while a connect audit is not queued for one`; `a capped audit is not queued again by a re-analysis or a restart`; `auto picks sonnet when Claude is free and the 30b coder when it is paused`; `the audit never shipped: no ship dir and no push ran` (the fake runner records every git argv; none is `push`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Reuse, do not copy: the runner is a short lifecycle over the same functions `runs.ts` calls.
- [ ] **Step 4:** Run; expect PASS. Run `npm test` whole; the Phase 2 suites still pass.
- [ ] **Step 5:** Commit `Audit a repo's README against its code in a sandboxed, read-only clone, charged to the city`.

### Task 5: Proposals as draft jobs, scope edits and the key rule [Opus] [screens]

**Files:**
- Create: `engine/audit/proposals.ts`
- Modify: `engine/market/jobs.ts` (`postProposal()`, `setScope()`, `key` on every job, `proposeHarnessJob` uses `HARNESS_KEY`, `transition()` to `withdrawn` notes `by`), `engine/guild/baseline.ts` (`ensureHarnessProposal` honours the key rule), `docs/SELF_RECURSION_GUARDRAILS.md`
- Test: `test/proposals.test.ts`, `test/jobs.test.ts`, `test/baseline.test.ts`

**Interfaces:**
- Consumes: `Audit` with verified findings (Task 4's `audit.ended`), `CITY_MARKER`, `TIER_VALUE`, `proposalKey`, `HARNESS_KEY`, `DENY_SCOPE`.
- Produces (`engine/market/jobs.ts`): `postProposal(input: { repo; title; body; scope; acceptance; tier; key; source: 'proposal' | 'brief'; proposal: Job['proposal'] }): Job` (status `proposed`, body `CITY_MARKER + '\n' + body`, records and emits `job.proposed`); `setScope(jobId, patch: { scope?: string[]; acceptance?: string[] }): Job` (while `proposed` or `open`; globs validated as `parseScope` does, `DENY_SCOPE` refused with the reason; records `job.changed` with the status unchanged, as `setTier` does); `keyTaken(repo, key): Job | null` (the newest job with that key that is not `withdrawn` with `by: 'city'`; a `withdrawn` with `by: 'him'` counts as taken); `transition()` to `withdrawn` takes `note.by` (`'him'` from the API and the brief, `'city'` otherwise; the city withdraws nothing today, so `by: 'city'` is a reserved value).
- Produces (`engine/audit/proposals.ts`): `proposeFromAudit(a: Audit): Job[]` (ruling 4; the proposal's `jobId` written back into the stored audit); `installProposals(): () => void` (subscribes to `audit.ended` with status `done`).
- Produces (`docs/SELF_RECURSION_GUARDRAILS.md`): the audit arrows (`first analysis of a market-on repo > audit (once) > proposed job > his click > open`; `his click on the district page or the brief > audit`), the read-only tools and the base-commit verification, and the sentence that an audit never runs after a city merge.
- [ ] **Step 1: Write the failing tests:** `an audit with three gaps posts three proposed jobs with the marker, the tier's value and the finding's evidence in the body`; `a proposal key already open is not posted again`; `a key he dismissed stays dismissed on the next audit`; `a merged key is posted again only while the claim is still missing or broken`; `a harness job that merged is not proposed again by the next analysis`; `setScope changes a proposed job's scope and refuses a denied glob`; `every proposed job's scope excludes DENY_SCOPE`; pin: `proposed jobs never bid` (passes today, since the tick reads `open` jobs only; kept so a later change to the tick cannot pick up proposals).
- [ ] **Step 2:** Run; expect FAIL (all but the pin).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Turn each verified gap into a draft job that waits for his click, once, with a scope he can edit`.

### Task 6: The brief engine [Opus] [screens]

**Files:**
- Create: `engine/brief.ts`
- Modify: `engine/market/report.ts` (today's cap line, proposals from audits under "Waiting on you" with their claim; the audit spend row lands in Task 1)
- Test: `test/brief.test.ts`, `test/report.test.ts`

**Interfaces:**
- Consumes: `reportData(day)`, `latestReport()`, `query`, `treasury()`, `listJobs`, `listRuns`, `listRepos`, `listAudits`, `latestAudit`, `listMilestones` and `weekTour` (Task 7; injected, empty until it lands), `acceptProposed`, `setTier`, `dismissProposed`, `resumeRepo`, `queueAudit`, `patchSettings`, `num()` (exported in Task 1).
- Produces: `briefSince(now): string` (ruling 8); `briefData(now: number, opts: { milestones?: () => Milestone[]; tour?: (week: string) => Tour | null } = {}): Brief` (items from the ledger over `[since, now]`: `merged` and `failed` from `job.changed`, `revert` from `merge.reverted`, `note` from `run.note`, `audit` from `audit.ended`, `milestone` from `milestone.reached`; from the live state: `pr`, `proposal` (with `tier`; actions `accept, tier, dismiss, why`), `halt` (`resume, why`), `audit-due` for a connected repo with `latestAudit` null (`audit, dismiss`), `usage` when either window is past `todayCap` minus 10 points (`cap`), `stale` (`why`), `tour`; `acted` from `brief.action` rows of the same `itemId` since `since`; `due` is `firstOpen && items > 0` (Decision 2); `lead` two sentences from the counts; numbers from `reportData(today)` and the stored reports of the days in the window); `openBrief(now): Brief` (records `brief.opened { day, since, items: string[] }` once per local day, empty or not; `firstOpen` true the first time that day); `actOn(itemId, action, body: { tier?: Tier; pct?: number }, now): { item: BriefItem; result: unknown }` (ruling 9; refuses an action the item does not offer with an `Error` naming it; `taught` true for `dismiss`, `accept`, `tier`, `retry`, `cap`; `dismiss` on a proposal passes `by: 'him'`); `briefDay(now)`.
- [ ] **Step 1: Write the failing tests** (the fixtures of `test/report.test.ts`): `the brief lists what merged, failed and waits since the previous open day, with the actions each offers`; `two briefs the same day carry the same items and the second says firstOpen false` (Review Focus 4); `an empty morning still records brief.opened with no items and due false`; `since reaches the previous open day's first open, not the same day's`; `accept on a proposal opens it and records a taught action`; `dismiss withdraws a proposal by him and is recorded as taught`; `tier changes the value and stays`; `cap sets today's limit above the day cap, clamps it and the treasury reports it`; `an action the item does not offer is refused`; `an item acted on carries its action and a PR item stays until its PR closes`; `a halted repo appears with Resume, and resume clears it`; `the daily report lists the audit's spend under the city's own calls and names today's cap`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Item texts are the report's register.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Compose the morning brief from the report and the ledger since his last look, and log what he does with it`.

### Task 7: Milestones and the week tour (engine) [Opus] [screens]

**Files:**
- Create: `engine/market/milestones.ts`, `shared/tour.ts`
- Modify: `engine/main.ts` (`installMilestones()` and `backfillMilestones()`), `engine/brief.ts` (wires `listMilestones` and `weekTour`)
- Test: `test/milestones.test.ts`, `test/tour.test.ts`

**Interfaces:**
- Consumes: `layoutTower`, `city()`, `loadTower` (`repos.ts`), `quarters()`, `agentTowerId`, `listAgents` (`firms.ts`), `earnedFloors(towerId)`, the emitted bus events `floor.laid`, `floor.lit`, `job.changed`, `firm.bankrupt`, `repo.analyzed` (ruling 11), `query`.
- Produces (`engine/market/milestones.ts`): `installMilestones(o: { now?: () => number } = {}): () => void` (subscribes through `subscribe()` from `events.ts`; ruling 11 and Decision 3; each reach records `milestone.reached` once by id, patches write the row and emit `milestone.reached` again with the patched row); `backfillMilestones(now)`; `listMilestones(now, o: { active?: boolean } = {}): Milestone[]`; `milestonesOf(towerId)`; `weekTour(now): Tour | null` (events from the ledger: `floor.lit`, `floor.scarred`, `milestone.reached`, a firm's first `job.awarded`, `agent.hired`; `standing` from the towers now).
- Produces (`shared/tour.ts`, pure): `weekOf(now): { week: string; from: string; to: string }` (Monday 00:00 local to the next); `tourPlan(w, events: Array<{ kind: TourStop['kind']; at; towerId; floorId; agentId; firmId; repo; title }>, standing: Set<string>): Tour | null` (ruling 12; when more than `TOUR.maxStops`, keep by kind rank `skyline`, `revival`, `ribbon`, `scar`, `merged`, `firm`, `hire`; captions "Ashlar & Vane laid floor 41 on harbor-ledger, Tuesday").
- [ ] **Step 1: Write the failing tests** (every test emits on the real bus with `emit()` and reads the rows and the ledger): `a lit floor that gives a tower the greatest earned height moves the lit spire and leaves the old holder unlit`; `the founding skyline is a separate unlit row`; `a floor on a repo quiet for 100 days reaches a revival for seven days; one quiet 10 days does not`; `a firm's first waiting floor ribbons it, its lighting dates the ribbon's end, a close ends it now, a bankruptcy ends it now` (Review Focus 5); `backfill reaches the skyline once and is idempotent`; `re-analysis keeps milestones by floor id` (Review Focus 5); `a tour has at most eight stops in time order, starts and ends at the exchange, drops a tower that no longer stands, and is null with one event`; `the tour's seconds equal the dwells, the glides and the exchange's ends`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Reach milestones from his own history and plan a walk through the week`.

### Task 8: API routes, the client, the router and redaction everywhere [Sonnet] [screens]

**Files:**
- Modify: `engine/market/api.ts`, `app/src/api.ts`, `app/src/router.ts`
- Test: `test/market-routes.test.ts`, `test/api-events.test.ts`, `test/router.test.ts`, `test/jobs.test.ts`

**Interfaces (full brief):**
- Routes (JSON; writes need `x-palimpsest: 1`; ids match `ID`):
  - `GET /api/audits?repo=` -> `Audit[]` without `markdownPath`; `GET /api/audits/:id` -> `AuditView`; `POST /api/repos/:owner/:name/audit` -> 202 `Audit` (`queueAudit(repo, 'demand')`), 409 with the reason when one waits or is live, 404 when not connected; `POST /api/audits/:id/kill` -> `{ ok }`.
  - `GET /api/brief` -> `Brief` (records nothing); `POST /api/brief/open` -> `Brief` (`openBrief`); `POST /api/brief/items/:itemId/:action` with body `{ tier?, pct? }` -> `{ item, result }`, 409 on a refused action with its message.
  - `GET /api/milestones?active=1` -> `Milestone[]`; `GET /api/tour?week=` -> `Tour | null`.
  - `PATCH /api/jobs/:id` accepts `{ tier }` as before and now `{ scope?, acceptance? }` (`setScope`; 409 with the reason on a denied glob or a status past `open`).
  - `PATCH /api/settings` accepts `auditOnConnect` (boolean), `auditModel` (`'auto'` or a string matching `ModelRef`'s shape: `claude:`, `ollama:`, `anthropic:` or `mlx:` plus a name of `ID` shape; never checked against `ollama list` in a route), `auditMaxCredits` (10 to 200), `todayCapPct` only as `null` (cleared; set only through the brief's `cap`).
  - `engine/server.ts` needs no change: `handleSse` already forwards every emitted event through `scrub()`.
- `scrub()` is applied to every field of `AuditView`, `Brief`, `Milestone`, `Tour`, and (the Phase 2 Task 37 parked item) to `InspectionView.checks[].detail`, review `notes`, `concerns`, scope `offenders` and `JobDetail.award.why` before they are sent. Pins on `redact()`: a 44 character mixed-case alphanumeric run, `sk-ant-…`, `ghp_…`, `github_pat_…` are each redacted and a 40 hex sha is kept (these pass today; kept as pins).
- `app/src/api.ts`: `audits(repo?)`, `audit(id)`, `startAudit(owner, name)`, `killAudit(id)`, `brief()`, `openBrief()`, `briefAct(itemId, action, body?)`, `milestones(active?)`, `tour(week?)`, `setJobScope(id, patch)`; `EVENT_TYPES` gains `audit.started`, `audit.stage`, `audit.ended`, `brief.action`, `milestone.reached`.
- `app/src/router.ts`: `Route` gains `'brief'` (`#/brief`) and `'audit'` (`#/audits/:id`).
- [ ] **Step 1: Write the failing tests:** `audits list, read with proposals, start on demand and refuse a second`; `the brief opens once a day over the API and an action answers the item`; `a refused brief action is 409 with its reason`; `a proposed job's scope patches and a denied glob is 409`; `settings validate auditMaxCredits and auditModel by shape without running ollama` (the runner fake records no `ollama` call); `milestones and the tour serve from fixtures`; `SSE forwards audit.ended and brief.action scrubbed`; `no view carries a path of this Mac` (an inspection with a `/Users/...` offender and an audit with a `/Users/...` note both come back scrubbed); `router parses #/brief and #/audits/:id`; pins: the four `redact()` forms.
- [ ] **Step 2:** Run; expect FAIL (all but the pins).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Serve audits, the brief, milestones and the tour, scrubbed, and let him edit a proposal's scope`.

### Task 9: The sample economy: audits, proposals, a week of milestones and a brief [Opus] [screens]

**Files:**
- Modify: `engine/market/sample-economy.ts`, `engine/sample.ts` (sample READMEs for two repos in `SAMPLE_TREES`), `tools/sample.ts`
- Test: `test/sample-economy.test.ts`

**Interfaces:**
- Produces: `seedEconomy()` adds: a `done` audit on `tidewater/harbor-ledger` (14 claims: 8 `REAL`, 2 `PARTIAL`, 3 `MISSING`, 1 `BROKEN`, one finding `unverified`, four proposals of which one he accepted yesterday and is now `bidding`, one he dismissed), a `done` audit on `lantern/assay-kit` with zero findings ("No README to check"), a `reading` audit on `hoshi/kumo` that the clock ends `done` in 20 s at `speed 20` (emitting `audit.stage` and `audit.ended` and posting two proposals), a `capped` audit from last week; milestones: the lit spire on Quickset's tallest agent tower (the greatest earned height) with the harbour tower's founding skyline as the unlit finial and a previous lit holder unlit, a revival on `hoshi/kumo` reached yesterday (lights still on), a ribbon on Quickset's first PR floor (the waiting floor), all with `milestone.reached` entries; a week of ledger events that plans a tour of seven stops; `brief.opened` for the last six days with their item ids and `brief.action` rows (an accept, a dismiss, a cap) so the triage log has history; the brief for today has every item kind at least once (`pr`, `proposal`, `merged`, `failed`, `halt`, `revert`, `note`, `audit`, `audit-due` for a connected repo never audited, `usage` (seeded reading at 44% against a 50 cap), `milestone`, `tour`). `economyClock` gains `audit: boolean` (default true). `verifyReplay().ok` holds with the audits and milestones compared.
- [ ] **Step 1: Write the failing tests:** `the economy seeds four audits and their proposals and replays clean`; `the clock ends the reading audit done with two new proposals and events`; `today's brief holds every item kind`; `the week tour plans seven stops`; `the sample stand-in never calls the network`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The sample READMEs, claims and proposal bodies are copy he reads in captures.
- [ ] **Step 4:** Run; expect PASS. Then the `--economy` seed on a temp home with `PALIMPSEST_PORT=4790` answers `/api/brief` and `/api/audits`.
- [ ] **Step 5:** Commit `Seed audits, proposals, milestones and a morning brief into the sample economy`.

---

## Part B: the screens (screens track)

The screens continue the book-like language: sheets over the city, Newsreader for names and headings, IBM Plex Sans for text, Plex Mono for refs, hairline rules, sentence case, square corners, the bronze rule under the current place; lists are ledgers.

### Task 10: The audit report on the district page, the audit page, proposals with their claims and the scope editor [Opus] [screens]

**Files:**
- Create: `app/src/ui/audit.ts`, `tools/ui-test-audit.ts`
- Modify: `app/src/ui/repo.ts`, `app/src/ui/repos.ts` (row line "audited 3 days ago" or "never audited"), `app/src/ui/jobs.ts` (the Proposed section groups proposals by repo under the audit that made them, each with its claim in quiet text, Accept, a tier picker and Dismiss), `app/src/ui/job.ts` (a proposed or open job's page: "Why the city proposes this" with the claim, the verdict and the evidence as `file:line` links to GitHub at `baseSha`; the scope and acceptance lists become editable while `proposed` or `open`, one glob or line per row, Save through `api.setJobScope`, the 409 reason shown in place; read-only afterwards), `app/src/main.ts`, `app/src/ui/market.css`
- Test: `tools/ui-test.ts` (calls `auditChecks`)

**Interfaces:**
- Produces (`app/src/ui/audit.ts`): `renderAuditBlock(v: AuditView, names, opts: { onAccept(jobId); onDismiss(jobId); onTier(jobId, tier) }): HTMLElement` (the lead; a ledger of claims: verdict as a word in small caps with a hand-drawn mark per verdict (a full square for REAL, half for PARTIAL, empty for MISSING, hatched for STUBBED, a struck square for BROKEN), tested or not, evidence as `file:line` links, the proposal's title with Accept, tier and Dismiss while its job is `proposed` or its status word otherwise; an `unverified` finding says "evidence not found at the commit"; a waiting audit shows its reason; a running one its stage and a Stop); `verdictWord(v)`, `verdictMark(v)`.
- District page: a section "README against the code" with the latest audit's block, past audits linking to `#/audits/:id`, "Audit the README" (disabled with the reason while one waits or is live; the 409 reason shown in place), and "Propose again" beside a harness or proposal key that merged or was dismissed. `#/audits/:id` renders the same block with the trail "Repos, <repo>, audit of <date>".
- [ ] **Step 1: Write the failing UI tests** (economy, `tools/ui-test-audit.ts`, shots `audit.png`, `audit-proposals.png`, `district-audit.png`, `job-scope.png` at 1600 x 1000): the harbour district page shows the lead with its counts, 14 rows, one unverified row and four proposal rows with the right states; Accept on a proposed row moves it to Bidding on the board and the row's state changes without reload; the tier picker patches the value; Dismiss withdraws; "Audit the README" on `lantern/assay-kit` starts an audit (202) and the button disables with the reason; the clock ends the `hoshi/kumo` audit and its two proposals appear on the board under its heading; the job page of a proposal shows the claim and an evidence link; editing its scope to add `src/**` saves and shows, and `**/.env` is refused with the reason in place; no console errors.
- [ ] **Step 2:** Run `npm run ui-test`; expect FAIL on the new checks.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): the verdict marks must read at a glance without colour; the claims ledger must not look like a scorecard; the scope editor must read as part of the page, not a form. Commit `Show what each README promises against what the code does, and the jobs that close the gap`.

### Task 11: The brief screen, first open each day, every action in place [Opus] [screens]

**Files:**
- Create: `app/src/ui/brief.ts`, `app/src/ui/brief-words.ts`, `tools/ui-test-brief.ts`
- Modify: `app/src/main.ts` (first-open; `fly` and `diff` handlers through the existing job page hooks; `tour` handed to the city once Task 17 lands, until then "The tour arrives with the city track" in quiet text), `app/src/ui/runhead.ts` (Brief first after City), `app/src/ui/treasury.ts` (the "today's limit" line beside the five-hour meter), `app/src/ui/market.css`
- Test: `test/brief-words.test.ts`, `tools/ui-test.ts` (calls `briefChecks`)

**Interfaces:**
- Consumes: `api.brief()`, `api.openBrief()`, `api.briefAct()`, events `brief.action`, `job.changed`, `audit.ended`, `milestone.reached`; the notice stack's `add()` (Task 12).
- Produces (`app/src/ui/brief-words.ts`, pure): `briefTitle(day)` ("Tuesday 11 November"), `itemSentence(item, names)`, `actionLabel(action)` (`accept` "Post as a job", `tier` "Change the tier", `dismiss` "Dismiss", `why` "Ask why", `diff` "Open the diff", `fly` "Fly to the floor", `retry` "Retry", `resume` "Resume", `open-pr` "Open the PR", `cap` "Change today's limit", `audit` "Audit it", `tour` "Walk through the week"), `usageLine(usage)`, `emptyMorning()` = "Nothing waits on you this morning".
- Produces (`app/src/ui/brief.ts`): `createBrief(parent, { listen, onDismiss, flyToFloor, openDiff, startTour }): { show(): void; hide(): void }`: the sheet "Brief" with the day as its title and the lead under it; sections "Waiting on you", "Overnight", "Recommended", "In the city" as ledgers; each item one ruled row: the sentence, then its actions as text buttons in the sentence's line (never a button row); `tier` opens the three tiers inline; `cap` opens a one-line field with the current cap and "until midnight" (raising allowed, Decision 7); `why` unfolds the reason under the row (the award prose for a merged or failed job, the claim and evidence for a proposal, the end reason for a failure, the halt reason); `diff` and `fly` call the handlers and record; an acted item stays in place with "Posted as a job, 9:14" in quiet text; the usage line with both windows and today's limit; the tour row with its stop count. Updates from events without reload.
- `main.ts`: before `await city.ready`, `api.brief()`; when `firstOpen`, `api.openBrief()` (every day, Decision 8); when `due`, `navigate('brief')` so the brief draws over the veil as the city loads behind it; when `firstOpen` and not `due`, the empty-morning line as a notice. The running head gains Brief.
- [ ] **Step 1: Write the failing tests:** `brief-words` unit tests for each label and the title; UI tests (`tools/ui-test-brief.ts`, shots `brief.png`, `brief-why.png`, `brief-cap.png`): on a fresh open with the economy the brief opens before the city (`body.dataset.route === 'brief'` within the veil's time) and `brief.opened` is recorded once with the item ids; every section has at least one item; Post as a job on the proposal moves it and the row says so; Dismiss on the failed job marks it and records `taught`; Change today's limit to 60 (above the 50 cap) shows "today's limit 60%" on the treasury; Ask why unfolds the claim under the proposal; Fly to the floor leaves the brief and the camera moves; a second window's brief says it is not the first open, carries the same items and shows the first window's action within 2 s (Review Focus 4); with the economy's actions cleared and no items the city opens with the empty line and `brief.opened` is still recorded; no console errors.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): the brief must read as a morning page, not a dashboard; every action must be reachable by keyboard in the row. Commit `Open each day with a brief he can act on in place`.

### Task 12: The notice stack [Opus] [screens]

**Files:**
- Create: `app/src/ui/notices.ts` (from `createNotice` in `main.ts`)
- Modify: `app/src/main.ts`, `app/src/city/governor.ts` (the drop notice carries the frame rate and triangle count it saw), `app/src/ui/style.css`
- Test: `test/notices.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `createNotices(parent): { add(text: string, o?: { key?: string }): void; dismiss(key): void; text(): string; texts(): string[] }`: a column of notices at the lower left, each its own ruled line with its own Dismiss; a notice with a `key` replaces the one with that key; when a sheet is open the column stands left of it (`--sheet-width` from the sheet's CSS variable) and never over it; the governor's notice reads "The city stepped down to medium quality: 41 fps and 13.2M triangles from home." The debug handle's `notice()` keeps returning the joined text so Phase 2's UI checks hold.
- [ ] **Step 1: Write the failing tests:** `each notice dismisses alone`; `a keyed notice replaces its earlier text`; UI test: with the treasury sheet open a notice's right edge is left of the sheet's left edge; the quality-drop notice names the frame rate (`UI_FORCE_DROP=1` drops it); the Phase 2 kit-failure and governor checks still pass.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Stack the city's notices, each with its own Dismiss, clear of an open sheet`.

### Task 13: Settings for the audit, the Repos row and the copy [Sonnet] [screens]

**Files:**
- Modify: `app/src/ui/settings.ts`, `app/src/ui/repos.ts`, `app/src/ui/repo.ts` (the "Autonomy grants arrive with Phase 4" note stays), `tools/ui-test-market.ts`
- Test: `tools/ui-test.ts`

**Interfaces (full brief):**
- Settings gains a section "Analysis" under Caps: "Audit a repo's README once when its market opens" (switch, `auditOnConnect`, with the line "Only repos with the market on are audited by themselves; any repo can be audited from its district page."), "Audit with" (`auto`, described as "Claude Sonnet when your plan has room, else the largest local coder", or a model typed as `ollama:<name>` or `claude:<name>`; validated by shape), "An audit may spend" (`auditMaxCredits`, shown in credits and as a share of a five-hour window: "40 credits, 4% of a window"). Privacy adds the line "An audit reads a fresh clone of your repo on this Mac inside the same sandbox as a job, and only changes nothing; what leaves is the same as a job's: your own claude CLI's calls on your login, or nothing for a local model. A repo whose market is off is audited only when you ask." Repos rows: "audited <short date>" linking to the district page's section, or "never audited"; the push note reads "merges to main after inspection; needs a test and a build command" everywhere (the Phase 1 "when the market opens" copy is gone from `repos.ts` and `settings.ts`).
- [ ] **Step 1: Write the failing UI tests:** the Analysis section patches the three settings and refuses 5 credits and a model of the wrong shape; the Privacy text contains the audit lines; a Repos row reads "audited" for the harbour repo and "never audited" for the vault; no "when the market opens" text anywhere in the built app (a grep over `dist/assets/*.js`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Add the audit settings and retire the copy that waited for the market`.

---

## Part C: the city (city track)

Every task here starts from the head named under "Starting head", keeps every view at 60 fps, and re-measures the city from home against the ui-test guard (12M triangles, 850 calls).

### Task 14: The lit spire and the founding finial [Opus] [city]

**Files:**
- Create: `app/src/city/milestones.ts`
- Modify: `app/src/city/scene.ts` (`towerPiece(towerId): { group: THREE.Object3D; layout: TowerLayout; half: number } | null` for district towers by `<repo>#founding` and agent towers through `agentTowerId`; `setMilestones(ms: Milestone[])`; `milestoneShows()`), `app/src/main.ts` (reads `GET /api/milestones?active=1`, applies `milestone.reached`), `app/src/ui/inspector.ts` (a floor row with a milestone carries its title in quiet text: "the skyline, since Tuesday")
- Test: `test/city-milestones.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Milestone` (Task 7 through Task 8's route and event), `layoutTower`, `makeSpire(k, height, half)` (`crowns.ts`), `Kit` and `Kit.build()` (`tower/kit.ts`), `towerMaterials` (`look.ts`), `hash01` (`construction.ts`).
- Produces (`app/src/city/milestones.ts`): `createMilestones(opts: { quality; materials: TowerMaterials }): { set(ms: Milestone[], towers: (towerId: string) => ReturnType<City['towerPiece']>): void; update(dt, clock): void; shows(): Map<string, MilestoneShow>; dispose() }` where `MilestoneShow = { kind; towerId; lit: boolean; y: number }`; `skyline` builds a spire with `makeSpire` into a fresh `Kit`, built once with `Kit.build()` per quality and instanced per tower (one draw call per spire kind city-wide), scaled to `max(12, 0.08 * layout.top)` m, standing on the tower's true top (above a crown), with a warm aircraft lamp at its tip and three lit rings when `lit`, unlit steel when passed; `founding-skyline` is the same mast unlit with a bronze finial cap; the lamp is a real emitter under the bloom threshold, breathing over 4 s; the spire leaves with the tower (Review Focus 5) and moves within one frame when `lit` passes to another tower.
- [ ] **Step 1: Write the failing tests:** `towerPiece finds a district tower and an agent tower`; `the spire stands on the tower's true top`; `a lit spire has an emissive tip and an unlit one has none`; `a tower removed takes its spire`; UI test (economy): `Quickset's tallest tower carries the lit spire, the harbour tower the founding finial and the previous holder an unlit spire`; shots `spire.png` close and `spire-home.png` from home; the lamp reads from home; triangles and calls within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the spire must read as a mast with footing and stays, not a cone; the tip must read from home without blooming. Commit `Light a spire on the tower that holds the skyline`.

### Task 15: Scaffolding lights on a revived repo [Opus] [city]

**Files:**
- Modify: `app/src/city/milestones.ts`, `app/src/city/scaffold.ts` (`makeLitScaffold(stages)`: `makeRecladScaffold` with a string of lamps per lift), `app/src/main.ts`
- Test: `test/city-milestones.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Milestone` of kind `revival` with `floorId` and `until`, `makeRecladScaffold(stages)` (Phase 2 Task 28), `towerPiece()` (Task 14).
- Produces: `revival` hangs a two-lift scaffold on the revived floor and the one below with a string of 16 warm lamps per lift (flicker by `hash01`), standing from `at` to `until`; `set()` removes it the frame `until` passes or the tower leaves; the lamps are the only emitters; one instanced draw for all lamps.
- [ ] **Step 1: Write the failing tests:** `a revival hangs lights round its floor and the floor below`; `lights come down at until`; UI test: `the kumo tower carries scaffolding lights`; shot `revival.png`; within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the lights must read as a festoon on scaffold tubes, warm, not a neon outline. Commit `Hang scaffolding lights on a repo that comes back to life`.

### Task 16: A ribbon on a new firm's first PR floor [Opus] [city]

**Files:**
- Modify: `app/src/city/milestones.ts`, `app/src/main.ts`, `app/src/ui/inspector.ts`
- Test: `test/city-milestones.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Milestone` of kind `ribbon` with `floorId`, `firmId`, `until`; `firmMarkColor(firmId, slots)` (`eras.ts`); `towerPiece()`.
- Produces: a cloth ribbon round the floor's slab edge in the firm's mark colour with a bow at the street-facing corner, sewn as a catmull-rom strip with a slight sag between the corners and a slow sway (vertex shader, 0.3 Hz); it stays through the waiting floor's cure; comes down at `until`, at once on a bankrupt firm (Review Focus 5: `quarterEvent({ kind: 'bankrupt' })` also calls `set()` with the milestone list the event patched); the inspector row reads "first PR of Quickset".
- [ ] **Step 1: Write the failing tests:** `a ribbon wraps the floor's slab at its height`; `a bankrupt firm's ribbon leaves the same frame the tower darkens`; UI test: `Quickset's first PR floor carries the ribbon`; shot `ribbon.png`; within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the ribbon must read as cloth (sag, sheen, a bow), never a flat band or a glow. Commit `Tie a ribbon round a new firm's first floor`.

### Task 17: The week tour [Opus] [city]

**Files:**
- Create: `app/src/city/tour.ts`
- Modify: `app/src/main.ts` (`T` and the brief's "Walk through the week"), `app/src/city/camera.ts` (reuses the scripted path mode from Phase 2 Task 35), `app/src/ui/brief.ts` (`startTour` handed in)
- Test: `test/tour-camera.test.ts`, `tools/ui-test.ts`, `tools/capture.ts` (a `week` clip)

**Interfaces:**
- Consumes: `Tour` (Task 8 `api.tour()`), `city.floorFrame`, `city.towerFrame`, `city.agentFrame`, `city.exchange()`, the ride's caption element style (Task 35 `ride.ts`).
- Produces (`app/src/city/tour.ts`): `tourKeys(tour: Tour, frames: (stop: TourStop) => Frame | null, exchange: Frame, towers: Frame[]): TourKey[]` (pure: for each stop an eye 70 m out and 25 m up from the frame's centre on the bearing from the previous stop, moved out to the nearest street when inside any tower's frame, a `dwell` and a `glide` from the stop, the exchange first and last); `startTour(city, keys, captions): { stop(): void; done: Promise<void> }`: the camera glides on a smoothed path (catmull-rom through the eyes, ease in and out per glide), the stop's floor highlighted as the inspector does, the caption lower left in the ride's type with the title and the day, Escape or a drag ends it and returns home; recorded through `api.briefAct('tour:<week>', 'tour')` when started from the brief.
- [ ] **Step 1: Write the failing tests:** `tourKeys places the exchange first and last and an eye per stop`; `an eye inside a tower's frame moves out`; `glides sum to the tour's seconds`; UI test (economy): starting the tour moves the camera through seven stops and the caption changes at each; Escape restores the home view; `week` clip in captures (45 s at the clock's speed).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): no stop may frame a tower edge-on or cut a crown; glides must not swing through buildings. Commit `Walk the camera through his week, stop by stop`.

### Task 18: The floor dossier on the ride (the interior-ride call) [Opus] [city]

**Files:**
- Modify: `shared/ride.ts` (`RideKey.caption.dossier`), `app/src/city/ride.ts`, `app/src/main.ts` (dossier data read once per ride from `api.job()`, `api.run()`, `api.inspection()`, `api.audit()` for the floors that have them), `app/src/ui/inspector.ts`
- Test: `test/ride.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `ridePlan()` and `startRide()` as Phase 2 Task 35 landed them; `Floor.earned` (`jobId`, `runId`), `Job.proposal` (Task 1), `InspectionView`, `AuditView`.
- Produces: `RideKey.caption` gains `dossier: { diff: { files: number; lines: number } | null; plan: string | null; verdict: string | null; claim: string | null; firm: string | null } | null` (filled for earned floors by `dossierOf(floor, data)` in `shared/ride.ts`, pure); the ride dwells 2.4 s (instead of 1.2) on a floor with a dossier and the caption grows a second block set small: "4 files, 212 lines. Plan: add the missing retry to the uploader. Passed, pushable." and for a proposal floor "From the README: 'resumable uploads'" with the verdict; the block is cleaned with `cleanText()` and never wider than the caption's column. Nothing changes for founding floors.
- [ ] **Step 1: Write the failing tests:** `dossierOf fills diff, plan, verdict and claim from the views and null for a founding floor`; `ridePlan dwells longer on a floor with a dossier`; UI test: the ride on the harbour tower shows a dossier block on an earned floor and none on a founding floor; shot `ride-dossier.png`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): legible against glass and sky at 1440 x 900; the dwell must not feel like a stall. Commit `Show what is inside a floor as the ride passes it`.

### Task 19: One interior room, only on his yes [Opus] [city] [optional]

Runs only if Decision 6 is answered yes. Otherwise it is skipped and recorded as skipped in the ledger.

**Files:**
- Create: `app/src/city/interior.ts`
- Modify: `app/src/city/ride.ts` (the car stops at the datum floor of a repo tower and the facade opens), `app/src/main.ts`
- Test: `test/interior.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `makeInterior(k: Kit, floor: Floor, dossier, half, height): THREE.Group`: one room behind the datum floor's street face, 6 m deep, built in the floor's era materials (the era's `Wall`, `Trim` and `Face` slots), lit by two warm fittings, with the dossier printed on the back wall as a plate (the diff numbers, the plan, the verdict) in the inspector's type; the facade's panes on that face fade to clear as the car stops and the camera eases 3 m in; Escape or the ride's end closes it. Built on demand for the one floor, disposed after; never part of the standing city's draw calls.
- [ ] **Step 1: Write the failing tests:** `the room is built in the floor's era slots and disposed after the ride`; UI test: the ride stops at the datum, the panes clear, the plate reads; shot `interior.png`; the city from home is unchanged in calls.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the room must read as a room with real materials and light, not a box with a texture. Commit `Open one room behind the datum floor`.

---

## Part D: real runs, media and the README

### Task 20: Real-run check: the Beagle audit [Opus] [both tracks merged]

**Files:** `docs/superpowers/plans/2026-11-11-phase-3-realrun.md` holds the notes (timings, cost, what was weak); fixes only where found.

- [ ] **Step 1:** With his go-ahead, on the installed engine with the usage hook, connect `AllStreets/beagle` (spec 9.1: the first README-versus-reality case) and start its audit from the district page (its market stays off, so nothing runs by itself). Watch it: a fresh clone under `runs/`, the install stage, the reading stage under `sandbox-exec` (confirm with `ps -o pid,command` that `claude` runs under the CLI profile and each `run` command under the tool profile), the egress log showing only the registries and `api.anthropic.com`, the end with its page. Confirm in the run log that `structured_output` arrived with the tools, the MCP server and the hook on (the combination Phase 2 never ran); if it did not, record that the text fallback carried it and whether the answer parsed.
- [ ] **Step 2:** Compare its findings with the hand audit of 2026-11-08 in spec 9.1: breeding outside geotag (the hardcoded tool allow-list in `src/genome.ts`), no parent-versus-child significance test, the geotag-specific self-check prompt, no sandbox, fossils for geotag only, no LoRA. Record which the audit found, with what verdict and evidence, which it missed, and any claim it got wrong. Confirm every evidence line opens to a real line on GitHub at `baseSha`. Confirm the credits charged agree with the hook's next reading within the margin the treasury shows and show in the treasury's spend table and the day cap; confirm `~/.claude/projects` gained no transcript; confirm `~/.claude/settings.json` and `~/.claude.json` are byte-identical to before (md5 recorded before and after).
- [ ] **Step 3:** Accept one proposal from the brief the next morning after editing its scope (the job then runs through Phase 2's market on his plan as any labelled issue would, which needs the market turned on for Beagle in PR mode first, with his go-ahead); confirm the brief recorded the open, the accept, the scope edit and the dismiss of another, and that the day's report lists the audit's spend under the city's own calls.
- [ ] **Step 4:** Time the audit (target: under 15 minutes and under 40 credits for Beagle); if it misses more than two of the six hand findings, tune `engine/audit/prompt.md` and rerun once. Commit `Fix issues found on the first real audit` (never his data).

### Task 21: UI test, captures, README and media [Opus] [both tracks merged]

**Files:**
- Modify: `tools/ui-test.ts`, `tools/capture.ts`, `README.md`, `CREDITS.md`, `docs/media/*`

- [ ] **Step 1:** `tools/ui-test.ts` runs the whole Phase 3 set on the economy with the clock (audit, brief, notices, settings, spire, lights, ribbon, tour, dossier), the console-error check across every screen, and the perf guard from home with every ornament standing; `npm run ui-test` passes on a quiet GPU.
- [ ] **Step 2:** `tools/capture.ts` gains stills `brief`, `audit`, `district-audit`, `job-scope`, `spire`, `revival`, `ribbon`, `ride-dossier` and clips `week` (the tour) and `audit` (the hoshi/kumo audit ending and its proposals appearing on the board, 30 s at the clock's speed); re-capture `hero` and `overview` with the spire standing. All from the sample economy at 2x.
- [ ] **Step 3:** README in his style: what Phase 3 adds in plain first person (the morning brief, the README audit and what each verdict means, that evidence is checked against the commit, proposals as jobs that wait for a click, the spire, the lights, the ribbon, the tour), the honest state (the audit is one agent's reading, verified only as far as file and line; what the school will add), how an audit is sandboxed, read-only and charged, which repos are audited by themselves, privacy, the new stills and clips. Line 77's "when the market opens" becomes the present tense. Shields row to phase 3.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test` all pass; `cargo test` in `src-tauri` still passes.
- [ ] **Step 5:** Commit `Phase 3: the city reads his repos and his mornings` and push per his standing order.

---

## Self-review notes

- Spec coverage: goal 3 and section 10 (audit on connect for market-on repos and on demand for all, the five verdicts, file and line evidence verified at the commit: Tasks 2, 4; proposals as jobs: Task 5; the Beagle case: Task 20); 7.1 job sources `proposal` and `brief` (Tasks 1, 5, 6); 8 (the audit under every guard, read-only, the ledger kinds, no loops documented: Tasks 4, 5); 9.1 as the template (Tasks 2, 20); 11 daily brief with every listed action: post as a job (`accept`), change scope or budget first (`tier` in the brief; scope on the proposed job's page, Tasks 5, 8 and 10), ask the city why (`why`), dismiss teaching triage (`dismiss` with `taught`), open the diff (`diff`), fly to the floor (`fly`), retry (`retry`), approve or decline a pending push (per spec 17 the pending items are PRs and proposals: `open-pr`, `accept`, `dismiss`), change today's usage limit (`cap`) (Tasks 6, 11); 11 repo district's README-versus-reality report (Task 10); 13 Phase 3 line (all); 15 "actionable daily brief", "README-versus-reality analysis, Beagle as first case" (Tasks 6, 11, 20); 17 suggested tier in one click (Tasks 5, 10, 11), self-halt in the brief (Task 6), the brief's pending items as PRs and proposals (Task 6); 4 and 7.3 (an automatic audit waits for his interactive use, never retries itself, never runs on a repo he has not opened the market on: ruling 6); 18 no points, badges or streaks (ruling 11, the copy rule), the lit spire as a market event with the founding finial (14), scaffolding lights (15), the ribbon (16), tours through his week (7, 17), designed with him (Decisions for Connor), fed by the brief and, in Phase 4, by the master net (the `brief.action`, `brief.opened` item lists and `milestone.reached` rows are its training data); the interior call (Decision 6, Tasks 18 and 19). Earned autonomy, the nets and the school stay Phase 4 and the copy says so.
- Type consistency: `Audit`, `Finding`, `Proposal`, `Brief`, `BriefItem`, `Milestone`, `Tour`, `AuditInput`, `AuditResult` are defined once in Task 1; `AUDIT_SCHEMA`, `AUDIT_TOOLS`, `AUDIT_LOOP_TOOLS`, `parseAudit`, `verifyEvidence(findings, dir, baseSha)`, `cloneClean`, `renderAudit` once in Task 2; `drive()`, `runLoop()` once in Task 3; `queueAudit`, `startQueuedAudit`, `watchAudits`, `killLiveAudits`, `failInterruptedAudits` once in Task 4; `postProposal`, `setScope`, `keyTaken` once in Task 5; `briefSince`, `briefData`, `openBrief`, `actOn` once in Task 6; `tourPlan`, `weekOf` once in Task 7; `towerPiece`, `createMilestones` once in Task 14 and extended in 15 and 16; `tourKeys`, `startTour` once in Task 17; `dossierOf` once in Task 18; `createNotices` once in Task 12.
- Tests that would pass before the change: each Step 1 names a function, route or element that does not exist before its task, so it fails first with "not a function", a 404 or a missing locator; the three tests that pass today are marked as pins where they stand (Task 1 `charge` kind, Task 5 "never bid", Task 8 `redact()` forms).
- Proportion: 21 tasks (19 default, one optional, two of them Sonnet) against the spec's Phase 3 line and sections 10, 11 and 18; step bodies carry only values the spec, a Phase 2 ruling or a ruling here pins.

## Builder check fixes

| Item | Fixed by |
|---|---|
| C1 audit spend invisible to the caps | Task 1: `'audit'` in `SPEND_KINDS`, `CALL_KINDS`, the report's call kinds, with the treasury and spend tests; ruling 5 |
| C2 evidence verified against a writable clone | Ruling 3; Task 2 (`verifyEvidence` at `baseSha` through `engineGit`, `cloneClean`); Task 3 (`AUDIT_TOOLS`, `AUDIT_LOOP_TOOLS`, read-only hook); Task 4 (a dirty clone ends `failed`; the test) |
| C3 ribbon keyed on unemitted events | Ruling 11 (`floor.laid` waiting, `floor.lit`, `job.changed` closed, `firm.bankrupt`); Task 7 tests on the real bus |
| C4 ruling 6: backfill, retry, preflight, interactive, eligible | Ruling 6 rewritten (never attempted, market on, no backfill, `preflight()`, `interactiveActive`, outside `eligible`); Decision 1; Task 4 tests |
| C5 ruling 8: `since`, the second window, the report | Ruling 8 rewritten (previous open day, ledger over the window, report numbers); Task 6 tests |
| I6 toolloop generalisation, local caps, schema ownership | Ruling 1 and 13; Task 3 (`runLoop`, `AUDIT_CAPS`, `AUDIT_LOCAL_RESULT`, backends import `AUDIT_SCHEMA`) |
| I7 audits in shutdown, reap, watcher, interrupted; never ship | Task 4 (`watchAudits`, `killLiveAudits`, `failInterruptedAudits`; the no-push test) |
| I8 `MarketState` and `verifyReplay()` | Task 1 |
| I9 `auditModel` validation without `ollama list` | Task 8 (shape only); Task 13 copy |
| I10 tower accessor and the spire's mesh path | Task 14 (`towerPiece()`, a fresh `Kit` built once and instanced) |
| I11 scope editor | Ruling 4; Task 5 (`setScope`), Task 8 (PATCH), Task 10 (the editor) |
| I12 split Task 11 | Task 12 (the notice stack) |
| I13 known orderings | "Starting head" and "Known orderings" name Task 32 and Task 35 and their files |
| I14 Decisions rewritten | Decision 1 (the four omissions and private repos), Decision 3 (earned height, both), Decisions 7 and 8 added |
| M15 `num()`, `server.ts`, `pickAuditModel` rank | Task 1 exports `num()`; Task 8 says `server.ts` is unchanged; ruling 5 and `localSize()` |
| M16 pins | Tasks 1, 5 and 8 mark them |
| M17 Task 19 checks | Task 20 Steps 1 and 2 (`structured_output`, `~/.claude.json`, `~/.claude/projects`) |
| M18 empty morning | Ruling 8 and Decision 8: `brief.opened` is recorded every day he opens the app |
