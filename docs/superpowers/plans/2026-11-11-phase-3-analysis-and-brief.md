# Phase 3: Analysis and the Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the city its judgement about his repos and his mornings: on connect it reads what a README promises against what the code does, marks each claim REAL, PARTIAL, MISSING, STUBBED or BROKEN with file and line evidence, turns the gaps into draft jobs he accepts in one click; the first open of each day is a brief he can act on in place, every action logged for Phase 4's Triage net; and his own milestones become physical in the city, with a tour that walks through his week.

**Architecture:** The engine gains an audit runner under `engine/audit/` that reuses the market's run machinery unchanged (a fresh clone of the bare mirror under `paths().runs`, the two sandbox profiles, the per-run egress proxy and command broker, the reaper, the leases and caps) to drive one `Provider.audit()` call, a work-shaped session with the file tools and the `run` tool whose answer is structured by a JSON schema; the engine verifies every piece of evidence against the clone before anything leaves it, writes the report as a Beagle-style Markdown page, and posts each proposal as a `proposed` job that bids only after his click. A brief module composes the existing daily report with the live state into actionable items, serves them with their actions over the API, and records every action he takes as a ledger entry. A milestones module derives skyline, revival and ribbon events from the ledger and the towers, and a pure tour planner lays out the week as camera stops. The UI adds the brief screen, the audit report on the district page, Settings for the audit, and in the city a lit spire, scaffolding lights, a ribbon and the tour. Two tracks run in parallel: the screens track (engine and screens, Tasks 1 to 12, 19 and 20) and the city track (Tasks 13 to 18).

**Tech Stack:** Node 22.13+, TypeScript, tsx, `node:test`, `node:sqlite`, three.js 0.187, Vite 8, Playwright, Tauri 2, `gh`, `git`, `sandbox-exec`, the `claude` CLI 2.1.319+ (his own install, `--json-schema` and `--tools` as Phase 2 uses them), Ollama 0.40+ on `127.0.0.1:11434`.

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 3 in section 13; sections 6.2, 7.1, 8, 9.1, 10, 11, 15 to 18 apply). The Phase 2 plan `docs/superpowers/plans/2026-11-10-phase-2-market.md` fixes the conventions, the rulings (numbered 1 to 30 there and cited here as "Phase 2 ruling n") and the test safety rules this plan continues; its SDD ledger `.superpowers/sdd/2026-11-10-phase-2-market/progress.md` holds the parked items folded in below.

**Starting head.** The screens track starts from `phase-2` once Phase 2's Task 40 (`6571862` on `screens-40`) has merged into it; nothing in Tasks 1 to 12 touches `app/src/city/`. The city track (Tasks 13 to 18) starts from the head that contains Phase 2's Tasks 32 to 35 (`app/src/city/people.ts`, `app/src/city/ride.ts`, `shared/ride.ts`), because every city task here edits `scene.ts`, `main.ts` and the tower builders those tasks are still editing, and Task 17 rides the hoist Task 35 builds. A city task that finds Phase 2 city work uncommitted under `app/src/city/` stops and asks the controller. Task 19 runs only after both tracks have merged.

## Decisions for Connor

Six calls, each with the recommendation the plan is written to. A yes to all six changes nothing below; a different answer changes the named task.

1. **Audit on connect, and what it may spend.** Recommendation: every connected repo is audited once, automatically, after its first analysis (and again only when he asks), on `claude:sonnet` when Claude is available within the caps, else on the largest installed local coder; one audit may spend at most 40 credits (4% of a five-hour window) and is charged to the city, not a firm; a switch in Settings turns the automatic audit off. Changes Task 4 and Task 12 if he wants it off by default or a different cap.
2. **The brief on first open.** Recommendation: the brief opens before the city on the first open of each local day only when it carries at least one item (something merged, failed, waiting, recommended or a milestone); on an empty morning the city opens with one quiet line, "Nothing waits on you this morning", and the Brief link stays in the running head. Changes Task 11 if he wants it every morning regardless.
3. **The lit spire.** Recommendation: the spire stands on the tower that holds the skyline now (the tallest tower in the city, founding and earned floors together) and is lit; a tower that once held the skyline and was passed keeps its spire unlit as a finial, so the history of the skyline reads from the roofs. The founding city at Phase 3 start counts: the tallest tower on the day Task 13 lands gets the first spire. Changes Task 13.
4. **Revival and ribbon lifetimes.** Recommendation: a repo is quiet after 90 days without a floor (founding or earned); the first merged floor after a quiet spell hangs scaffolding lights on the tower for 7 days; a firm's first PR puts a ribbon round that floor until 7 days after it merges (or until the PR closes). Changes Tasks 7, 14 and 15.
5. **The week tour.** Recommendation: a scripted camera walk of 60 to 90 seconds from the exchange through at most eight stops (merged floors, scars, ribbons, a new spire, a revived repo, a new firm), captions in the ride's type, Escape ends it; the brief offers it on Monday mornings and the city offers it any time with `T`; it is taken in silence (no voice, no music). Changes Tasks 7 and 16.
6. **Interior rides.** Recommendation: no interiors in Phase 3. Instead the exterior ride (Phase 2 Task 35) gains a floor dossier: when the car dwells on a floor it shows what is inside that floor, its diff in numbers, the agent's plan, the inspection verdict, and for a proposal floor the README claim that caused it (Task 17). That is the content an interior would need, delivered where he already is. If he wants one interior anyway, Task 18 is scoped for it (one glazed room behind the datum floor of a repo tower, lit from the dossier) and runs only on his yes; the plan's default is that Task 18 is skipped and the question returns in Phase 5 with the dossier in hand.

## Global Constraints

- Engine API on `127.0.0.1:4770` only, with the Host and Origin checks and the `x-palimpsest: 1` header on every write; UI dev server on `4771`. Ollama only at `127.0.0.1:11434`, only from the engine.
- Data directory `~/Library/Application Support/Palimpsest`, overridable with `PALIMPSEST_HOME`; every test sets it to a temp dir.
- `redact()` (`engine/market/jobs.ts`) and `scrub()` (`engine/market/api.ts`) on everything that leaves the engine: every audit finding, claim, evidence note, proposal body, brief item, milestone title, tour caption, ledger row and event is scrubbed server-side; the UI cleans it again with `cleanText()`.
- The market is off by default (`Repo.market false`); the audit is not the market: it never bids, never commits, never pushes and never writes to GitHub. Its proposals are `proposed` jobs that wait for his click (Phase 2 ruling 23 holds for them).
- Audit runs carry every guard of a market run: a fresh `git clone --local --no-hardlinks` of the bare mirror under `<home>/runs/<auditId>/repo` with push URL `no-push://palimpsest`, the per-run fake `HOME`, empty `GIT_CONFIG_GLOBAL`, no credentials in the environment, the tool profile for every command and the CLI profile for `claude`, the egress proxy (`install` to the registries, `reading` to the registries plus the model host), the command broker and the reaper. Nothing an audit writes in its clone is ever shipped.
- The audit is charged to the city under the same caps and leases as a run (`acquire(model, 'work', …)`), counts against the day and night caps, pauses with a stale reading and aborts on the stop file and the hard stop.
- Never without asking: unchanged from Phase 2; the audit adds no GitHub write at all.
- No loops: an audit proposes only `proposed` jobs; a proposal's body carries `CITY_MARKER`; the audit never runs on its own except once after a repo's first analysis, never after a city merge; `docs/SELF_RECURSION_GUARDRAILS.md` gains the audit arrows (Task 5).
- Ledger: every audit start and end (with its findings), every proposal, every brief open and action, every milestone is recorded append-only with kinds from `LEDGER_KINDS` and replays.
- Tests never touch port 4770, the real data home, his keychain, or his real `~/.claude`, `~/.codex` or `~/.gemini` (Phase 2 test safety rules 1 to 10 apply; the audit tests use the fake provider and `PALIMPSEST_SANDBOX=off` under a temp home).
- The ui-test guard is 12M triangles and 850 draw calls from home; every city task keeps 60 fps on his M5 Pro at every view it adds.
- No em dashes, `--` or emojis in UI copy, README, report pages or commit text. No AI look: sentence case, hairline rules, ledgers not cards, no badges or counters of any kind in the play work.
- Every visible change: build, screenshot at full size and zoomed crops, critique, iterate (three rounds for 3D, two for screens); rounds and what is still weak go in the commit body.
- README media only from the sample dataset (Task 9's additions), never his repos.
- Commit trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UGpw98HC7NNMT1jveHzgfa`.

## Phase 3 rulings on spec gaps

1. **What an audit reads.** The claims come from `README.md` (any case, `.md`, `.rst` or `.txt`) and every Markdown file under `docs/` up to 200 KB in all, the first 400 KB of code it chooses to read through its tools, and the repo's own checks run through the `run` tool. A repo with no README ends `done` with zero findings and the line "No README to check."
2. **The verdicts** (spec 10, the Beagle audit as template): `REAL` (the code exists, is wired and is exercised by a test the audit found or ran), `PARTIAL` (exists and is wired, but a named part of the claim is absent or untested), `MISSING` (nothing in the code does it), `STUBBED` (a function or path exists but returns a fixed or placeholder value, or is unreachable from any entry point), `BROKEN` (wired, but a test fails, a type error stops it, or the audit's own run of it fails). Every finding carries `tested: boolean` and at least one evidence line; `REAL` needs an evidence line in a test file or a passing `run` of the repo's check.
3. **Evidence is verified by the engine.** For each `{ file, line }` the engine checks, in the clone, that the path is a regular file inside the clone (never under `.git`), and that `line` is null or within the file's line count; a failing piece is kept with `verified: false`. A finding with no verified evidence becomes `unverified` and gets no proposal. Paths are stored relative to the clone root; a path with `..`, an absolute path or a symlink is refused at parse time.
4. **Proposals.** A `MISSING`, `STUBBED` or `BROKEN` finding, and a `PARTIAL` one whose missing part the agent can name, may carry one proposal: title, body (the claim, the evidence, what to build, written for a firm to bid on), `scope` (globs the agent names, filtered to paths that exist or to new paths under an existing directory, `DENY_SCOPE` removed), `acceptance` (at least one line) and a suggested tier (`low`, `normal` or `high`, default `normal`). The engine posts it as a job with `source 'proposal'`, `status 'proposed'`, `value TIER_VALUE[tier]`, body prefixed with `CITY_MARKER`. Its key is `<repo>#<sha1 of the normalised claim>[:12]`; a key that already has a job in any status but `withdrawn` by the city (never by him) is not proposed again; a key he dismissed stays dismissed across re-audits; a key whose job merged is not proposed again unless the next audit still finds the claim `MISSING` or `BROKEN` (then it is proposed with "proposed again: the merge did not close it" in its body).
5. **The audit's model and cost.** `Settings.auditModel` is `'auto'` (default) or a `ModelRef`. `auto` picks `claude:sonnet` when `callPaused('claude:sonnet', AUDIT_ESTIMATE)` is null, else the largest installed Ollama model whose name contains `coder`, else any installed Ollama model, else the audit waits for Claude (status `waiting` with the reason). `AUDIT_ESTIMATE = 20` credits reserved on the lease; `Settings.auditMaxCredits = 40` ends the session `capped`. Credits rows carry `kind 'audit'`, `firm_id NULL`, `run_id <auditId>`; the daily report and the treasury show them as the city's own spend beside reviews and design checks.
6. **When an audit runs.** Once, automatically, after a repo's first successful analysis (`Repo.auditedAt` null and `Settings.auditOnConnect` true), queued through the scheduler like a run (one audit per repo at a time, counted in the `claude` or `local` work pool, at most one audit live at a time city-wide so audits never take both Claude slots); on demand from the district page or the brief; never on a schedule and never after a city merge. A re-analysis does not re-audit. A repo connected before Phase 3 (`auditedAt` null, `joinedAt` set) is audited by the same rule the first time the Phase 3 engine starts, oldest first, one at a time.
7. **The audit page.** `paths().reports/audits/<repo-slug>-<auditId>.md`: a Beagle-style page: a lead ("Of 14 claims in the README, 8 are real, 2 partial, 3 missing and 1 broken."), then a table of claims with verdict, tested, evidence (as `file:line`) and the proposal title, then "Real and tested", "Broken or missing" and "Proposed" sections in prose. Rendered by `renderAudit()`; the API serves the Markdown and the data.
8. **The brief's window.** The brief for day D covers everything since his last `brief.opened` (or the last 24 hours on the first ever) up to now, so "overnight" is literally since he last looked. Items are stable by id (`pr:<runId>`, `proposal:<jobId>`, `merged:<jobId>`, `failed:<jobId>`, `revert:<ledgerId>`, `halt:<repo>`, `note:<ledgerId>`, `audit:<auditId>`, `audit-due:<repo>`, `usage`, `stale`, `milestone:<id>`, `tour:<weekStart>`), and an item he acted on shows its action and is not offered again, except `pr` and `halt` items, which stay until the state they report clears.
9. **Brief actions and what they do.** `accept` (a proposal to `open`, through `acceptProposed`), `tier` (`setTier`, then stays), `dismiss` (a proposal to `withdrawn` through `dismissProposed`; any other item hidden; always records `brief.action` with `taught: true`, the triage signal), `why` (no engine change; the UI opens the job's award prose, the finding's evidence or the run's end reason), `diff` and `fly` (UI only, recorded as actions), `retry` (`repost` of a failed job with attempts left), `resume` (`resumeRepo`), `open-pr` (UI opens the PR; recorded), `cap` (`{ pct }` sets `Settings.todayCapPct = { day, pct }`, honoured by `budget.ts` in place of `dayCapPct` while `day` is today), `audit` (starts an audit on the item's repo), `tour` (recorded when he takes it), `seen` (an item scrolled into view for two seconds; recorded without `taught`). Every action records `brief.action { day, itemId, kind, action, taught, at, patch }` and emits it.
10. **Today's cap.** `todayCapPct` is clamped to 5 to `hardStopPct - 5` and expires at local midnight; the treasury shows "today's limit 30%, set by you this morning" while it holds; the daily report names it.
11. **Milestones** (spec 18, Decisions 3 and 4): `skyline` (a tower's top passes every other tower's top; `until null`; `lit` true for the holder, false once passed), `revival` (a lit floor on a repo tower whose previous newest floor is 90 or more days older; `until` 7 days after), `ribbon` (the first `pr.opened` of a firm; `until` 7 days after `merge.detected`, or at once on `closed`). Detected on the event bus and backfilled once from the ledger and the towers at engine start (`milestone.reached` is idempotent by id). Milestones are never counted or scored anywhere: no totals, no lists of "achievements"; each is shown only in the city, in the brief the morning it happens, and on the floor's row in the inspector.
12. **The tour** (Decision 5): `tourPlan(week, events, towers): Tour` is pure; stops are, in time order, up to eight of: merged floors (`floor.lit`), scars (`floor.scarred`), milestones, a firm's first job, a hire; fewer than two stops means "no tour this week". Each stop dwells 6 s with a caption; the camera glides 4 s between stops; it starts and ends at the exchange. Stops on towers that no longer stand are dropped at plan time.
13. **Provider.audit().** The Provider interface (frozen in Phase 2 Task 1) gains one method, `audit(i: AuditInput): Promise<AuditResult>`, implemented by all four backends in Task 3. Nothing else in the interface changes.
14. **An audit never halts a repo or strikes a firm.** A failed, capped, crashed or killed audit records `audit.ended` with its reason, keeps its log under the audit root (`KEPT` files as a run), proposes nothing, and can be run again by hand. It touches no reputation.
15. **The JSON the agent returns is data.** It is parsed with `parseAudit()` against `AUDIT_SCHEMA` (unknown keys dropped, strings capped: claim 400 chars, note 300, title 120, body 4,000; at most 60 findings and 3 evidence lines each), then redacted; a shape failure ends the audit `failed` with "the audit's answer did not parse" and the raw text kept in the log only.

## Folded from the Phase 2 ledger

| Parked item (ledger line) | Where it lands |
|---|---|
| Task 14 deferred: merged harness jobs re-proposed when detection still finds nothing | Task 5: every proposal, the harness included, carries a `key`; a merged or dismissed key is not proposed again by itself; the district page gets "Propose again" |
| Task 37 parked: API `CheckView` notes, concerns and offenders not redacted server-side | Task 8: `scrub()` on every inspection and job view field; test pins it |
| Task 20 deferred: the narrowed token regex (mixed case and digits in a 40+ run; `sk-ant-`, `ghp_`, `github_pat_` prefixes) | Task 8: tests on `redact()` for each form |
| Task 22 minors: the governor notice should name the frame rate; Dismiss clears all joined notices | Task 11: the notice is rebuilt as a stack with one Dismiss per notice and the frame rate in the drop notice |
| Audit line: the quality-drop notice draws over an open sheet's lower left | Task 11: notices stand clear of an open sheet |
| README line 77 and `repos.ts` copy: "push mode is stored now for when the market opens" | Task 20 (README) and Task 12 (copy) |
| Spec 17: proposals and brief items arrive with a suggested tier he can change in one click | Tasks 5, 10 and 11 |
| Spec 17: a self-halt "puts it in the brief" | Task 6 |
| Left in Phase 5 by the ledger's own rulings (overview haze, far coursing, ceramic in sun, cluster pods, corner window stretch, lens glint on tall glass, ferry wake crests, train bulkhead, stylised trees, dark tower from home, rendered.ts re-measure, a clear-air daytime still) | not in this plan |

## Review Focus

1. A repo with no README, a README of prose that promises nothing testable, or a README of 2 MB of generated text: the audit ends `done` with zero or few findings, charges what it spent, proposes nothing, the district page says "No README to check" or lists what it found, and nothing hangs. (Task 2 and Task 4 tests.)
2. An audit answer that cites `/Users/him/...`, `../../.ssh/id_rsa`, a file under `.git`, a line past the end of the file, or a proposal whose scope is `**/.env`: the evidence is unverified, the scope is filtered, no path of his Mac appears in the stored audit, the API, the event stream or the page. (Task 2, Task 5 and Task 8 tests.)
3. The stop file, the hard stop or the credit cap arrives while an audit is reading: the session is killed within 5 s, the audit ends `killed` or `capped`, nothing is proposed, the repo is not halted, no strike is written, and "Audit the README" on the district page starts it again. (Task 4 test.)
4. The engine was down over midnight, or the app is opened in two windows: one `brief.opened` per day, the second window's brief says it is not the first open, an action taken in one window shows as taken in the other without reload, and the day's report still exists for the day he missed. (Task 6 and Task 11 tests.)
5. A tower that holds a spire, a ribbon or scaffolding lights is disconnected, re-analysed, sold dark or its firm goes bankrupt: the ornament leaves with the tower, re-analysis keeps it (milestones key on floor ids that survive Phase 2 ruling 17), and a bankrupt firm's ribbon comes down the frame the tower darkens. (Task 7, Tasks 13 to 15 tests.)

---

## File Structure

```
shared/types.ts                 + Verdict, Evidence, Finding, Proposal, Audit, AuditStatus, AuditView, BriefItem, BriefItemKind,
                                  BriefAction, Brief, Milestone, MilestoneKind, Tour, TourStop; Job.source + 'proposal' | 'brief';
                                  Job.proposal; Repo.auditedAt; Settings + auditOnConnect, auditModel, auditMaxCredits, todayCapPct
shared/ledger-kinds.ts          + audit.started, audit.stage, audit.ended, brief.opened, brief.action, milestone.reached
shared/market-rules.ts          + PROPOSAL_TIERS, proposalKey(), AUDIT_ESTIMATE, AUDIT_MAX_FINDINGS, QUIET_DAYS, RIBBON_DAYS, LIGHTS_DAYS
shared/tour.ts                  pure: tourPlan(), tour timings
engine/db.ts                    + audits, milestones tables; migrations
engine/market/provider.ts       + AuditInput, AuditResult, Provider.audit
engine/audit/schema.ts          AUDIT_SCHEMA, auditPrompt(), parseAudit(), verifyEvidence(), renderAudit()
engine/audit/run.ts             the audit runner: root, clone, egress, broker, install, the audit session, verify, store, charge, ledger
engine/audit/store.ts           audits table reads and writes, listAudits(), audit(), latestAudit(repo)
engine/audit/proposals.ts       proposeFromAudit(), the key rule, the harness key
engine/brief.ts                 briefData(), openBrief(), actOn(), today's cap
engine/market/milestones.ts     detection on the bus, backfill, listMilestones(), weekTour()
engine/market/claude.ts         + audit(): a work-shaped session with --json-schema
engine/market/toolloop.ts       + audit() for the Ollama and Anthropic API loops
engine/market/fake-provider.ts  + audit() scripted
engine/market/budget.ts         + todayCapPct honoured; 'audit' charge kind
engine/market/runs.ts           + the scheduler starts queued audits (one live)
engine/market/jobs.ts           + source 'proposal' | 'brief', proposal keys, postProposal()
engine/market/report.ts         + the audit spend, today's cap, proposals in "Waiting on you"
engine/market/api.ts            + audit, brief, milestone and tour routes; scrub on every view field
engine/market/sample-economy.ts + sample audits, proposals, a week of milestones, a brief with every item kind
docs/SELF_RECURSION_GUARDRAILS.md  + the audit arrows
app/src/api.ts                  + audits, brief, milestones, tour; EVENT_TYPES
app/src/router.ts               + #/brief, #/audits/:id
app/src/ui/brief.ts             the brief screen
app/src/ui/brief-words.ts       pure view logic of the brief (tests read it)
app/src/ui/audit.ts             the audit report block (district page and #/audits/:id)
app/src/ui/repo.ts              + the audit section, Propose again, Audit the README
app/src/ui/jobs.ts, job.ts      + proposals grouped by repo with evidence; "why" shows the claim
app/src/ui/settings.ts          + Audit settings, Privacy copy
app/src/ui/runhead.ts           + Brief
app/src/main.ts                 + first-open brief, notices as a stack, milestones and the tour wired to the city
app/src/city/milestones.ts      spire, scaffolding lights, ribbon (city track)
app/src/city/tour.ts            the week tour camera (city track)
app/src/city/ride.ts            + the floor dossier (city track)
tools/ui-test-brief.ts, tools/ui-test-audit.ts, tools/ui-test.ts, tools/capture.ts
test/*.test.ts                  node:test suites per task
```

## Pre-flight conflict table

| Tasks | Shared | Resolution |
|---|---|---|
| 1, all | `shared/types.ts`, `LEDGER_KINDS`, `Provider.audit` | Task 1 freezes them; a later task needing a field adds it in its own commit and notes it in the ledger |
| 1, 3 | `AuditInput`, `AuditResult` | Task 1 defines; Task 3 implements on four backends; Task 4 calls only `providerFor(model).audit()` |
| 2, 4 | `parseAudit()`, `verifyEvidence()`, `renderAudit()` | Task 2 is pure (strings and a directory in); Task 4 calls them after `runQuiet()` |
| 4, 5 | `Audit` stored vs proposals | Task 4 stores the audit and emits `audit.ended`; Task 5 subscribes to the event and proposes; Task 4 never writes jobs |
| 5, Phase 2 `jobs.ts` | `JobSource`, `transition()` | Proposals move only through `transition()`; `LEGAL_MOVES` is unchanged (`proposed` already has `open` and `withdrawn`) |
| 6, Phase 2 `report.ts` | the day's data | `briefData()` calls `reportData(day)` for its numbers and never recomputes them; the report gains the audit spend and today's cap in Task 6 |
| 6, 9 (budget) | `todayCapPct` | Task 6 writes it through `patchSettings`; `budget.ts` reads it in Task 6's own step; the treasury view shows it in Task 11 |
| 7, 13 to 16 | `Milestone`, `Tour` | engine produces, city consumes by id; the city never derives a milestone itself |
| 8, 10 to 12 | `api` client | screens call only what Task 8 added |
| 9, 20 | sample audits and milestones | `seedEconomy()` is the only entry point; captures and UI tests seed it |
| 11, Phase 2 Task 39 | the treasury's report block | the brief renders its own items; the report stays on the treasury; both link to each other |
| 13, 14, 15, Phase 2 Tasks 22 to 28 | `tower/build.ts`, `quarters.ts`, `scaffold.ts`, `crowns.ts` | the three ornaments are built in `app/src/city/milestones.ts` and attached to a built tower's group by floor id; the tower builders are not edited |
| 16, 17, Phase 2 Task 35 | `camera.ts` scripted path, `ride.ts` captions | Task 16 reuses the scripted path mode Task 35 adds; Task 17 extends `RideKey.caption` with a `dossier` and does not change `ridePlan()`'s timings |
| 13 to 17, 20 | `tools/ui-test.ts` perf guard | every city task re-measures from home; the 12M and 850 guard is not raised |

Known orderings: Task 1 before everything; Task 2 before Task 4; Task 3 before Task 4; Task 4 before Task 5; Tasks 5 and 6 before Task 8; Task 7 before Task 8; Task 8 before Tasks 9 to 12 and 13 to 16; Task 9 before every UI test; Phase 2 Task 35 before Task 17.

## Model marks

**[Opus]** for every task but Task 8 and Task 12, which are **[Sonnet]** with a full brief. Reviews of logic and visual work go to Opus.

---

## Part A: the engine (screens track)

### Task 1: Types, schema, ledger kinds, settings and Provider.audit [Opus] [screens]

**Files:**
- Modify: `shared/types.ts`, `shared/ledger-kinds.ts`, `shared/market-rules.ts`, `engine/db.ts`, `engine/settings.ts`, `engine/market/provider.ts`, `engine/market/replay.ts` (the exhaustive switch gains the six kinds), `engine/market/budget.ts` (`charge()` kind union gains `'audit'`; `todayCapPct` read)
- Test: `test/market-types.test.ts`, `test/market-rules.test.ts`, `test/db.test.ts`, `test/replay.test.ts`, `test/budget.test.ts`

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
    startedAt: string; endedAt: string | null; endedReason: string | null; findings: Finding[]; counts: Record<Verdict, number>; unverified: number;
    claimsRead: number; credits: number; unattended: boolean; markdownPath: string | null }
  export type AuditView = Omit<Audit, 'markdownPath'> & { markdown: string | null; proposals: Job[] };
  export type BriefItemKind = 'merged' | 'failed' | 'pr' | 'proposal' | 'halt' | 'revert' | 'note' | 'audit' | 'audit-due' | 'usage' | 'stale' | 'milestone' | 'tour';
  export type BriefAction = 'accept' | 'tier' | 'dismiss' | 'why' | 'diff' | 'fly' | 'retry' | 'resume' | 'open-pr' | 'cap' | 'audit' | 'tour' | 'seen';
  export interface BriefItem { id: string; kind: BriefItemKind; repo: string | null; title: string; text: string; at: string; tier: Tier | null;
    refs: { jobId?: string; runId?: string; inspectionId?: string; prUrl?: string; floorId?: string; auditId?: string; milestoneId?: string; firmId?: string };
    actions: BriefAction[]; acted: { action: BriefAction; at: string } | null }
  export interface Brief { day: string; since: string; firstOpen: boolean; due: boolean; lead: string;
    usage: { fiveHour: BudgetWindow; sevenDay: BudgetWindow; todayCapPct: number | null; paused: TreasuryState['paused'] };
    sections: { waiting: BriefItem[]; overnight: BriefItem[]; recommendations: BriefItem[]; city: BriefItem[] };
    tour: { week: string; stops: number } | null }
  export type MilestoneKind = 'skyline' | 'revival' | 'ribbon';
  export interface Milestone { id: string; kind: MilestoneKind; towerId: string; repo: string | null; firmId: string | null; agentId: string | null;
    floorId: string | null; at: string; until: string | null; lit: boolean; title: string; detail: string }
  export interface TourStop { kind: 'merged' | 'scar' | 'skyline' | 'revival' | 'ribbon' | 'firm' | 'hire' | 'exchange'; towerId: string | null; repo: string | null;
    floorId: string | null; agentId: string | null; firmId: string | null; title: string; caption: string; at: string; dwell: number; glide: number }
  export interface Tour { week: string; from: string; to: string; stops: TourStop[]; seconds: number }
  // Job: source: 'issue' | 'manual' | 'harness' | 'proposal' | 'brief'; + proposal?: { auditId: string; findingId: string; key: string } | null; + key?: string | null.
  // Repo: + auditedAt: string | null.
  // Settings: + auditOnConnect: true, auditModel: 'auto' | ModelRef ('auto'), auditMaxCredits: 40, todayCapPct: { day: string; pct: number } | null (null).
  ```
- Produces (`shared/market-rules.ts`): `AUDIT_ESTIMATE = 20`, `AUDIT_MAX_FINDINGS = 60`, `AUDIT_MAX_EVIDENCE = 3`, `AUDIT_TEXT_CAPS = { claim: 400, note: 300, title: 120, body: 4000 }`, `QUIET_DAYS = 90`, `LIGHTS_DAYS = 7`, `RIBBON_DAYS = 7`, `TOUR = { maxStops: 8, dwell: 6, glide: 4, minStops: 2 }`, `proposalKey(repo: string, claim: string): string` (`<repo>#` plus the first 12 hex of the sha1 of the claim lower-cased with whitespace collapsed), `HARNESS_KEY(repo) = repo + '#harness'`, `todayCap(settings: Settings, day: string): number` (`todayCapPct.pct` clamped to `[5, hardStopPct - 5]` when `todayCapPct.day === day`, else `dayCapPct`).
- Produces (`shared/ledger-kinds.ts`): `audit.started`, `audit.stage`, `audit.ended`, `brief.opened`, `brief.action`, `milestone.reached`.
- Produces (`engine/db.ts`): `audits (id TEXT PRIMARY KEY, repo TEXT, status TEXT, started_at TEXT, json TEXT)` with index `audits_repo (repo, started_at)`; `milestones (id TEXT PRIMARY KEY, kind TEXT, tower_id TEXT, at TEXT, until TEXT, json TEXT)` with index `milestones_tower (tower_id)`; `jobs` gains column `key TEXT` with index `jobs_key (key)` (migration adds it when missing).
- Produces (`engine/market/provider.ts`):
  ```ts
  export interface AuditInput { repo: Repo; auditId: string; dir: string; readme: { path: string; text: string } | null; docs: Array<{ path: string; text: string }>;
    checks: RepoChecks | null; model: ModelRef; schema: object; log: (line: RunLogLine) => void; onProgress: (p: Partial<RunProgress>) => void;
    signal: AbortSignal; caps: { maxTurns: number; maxMinutes: number; maxCredits: number } }
  export interface AuditResult { answer: unknown; text: string; usage: Usage; ended: 'finished' | 'capped' | 'aborted' | 'crashed'; reason: string | null }
  // Provider: + audit(i: AuditInput): Promise<AuditResult>;
  ```
- Produces (`engine/market/budget.ts`): `charge()` accepts `kind: 'bid' | 'run' | 'review' | 'judge' | 'audit'`; the day cap used by `gate` and `treasury()` is `todayCap(getSettings(), localDay(now))`; `TreasuryState.fiveHour.capPct` reports it.
- [ ] **Step 1: Write the failing tests:** `proposalKey is stable across whitespace and case`; `todayCap clamps and expires at midnight` (a `todayCapPct` for yesterday yields `dayCapPct`; `{ pct: 2 }` yields 5; `{ pct: 99 }` with `hardStopPct 90` yields 85); `the db has audits and milestones tables and jobs.key`; `replay's switch names every kind` (a kind missing from the switch is a type error: the test calls `replay()` over one entry of each new kind and expects no throw); `the treasury honours today's cap` (`patchSettings({ todayCapPct: { day: today, pct: 30 } })`, `treasury().fiveHour.capPct === 30`); `charge accepts kind audit with a null firm`.
- [ ] **Step 2:** Run `npm test`; expect FAIL on the new tests and on the type check.
- [ ] **Step 3:** Implement the types, kinds, rules, tables, migration, settings defaults, the Provider method (the four backends get a stub `audit()` that throws `not implemented` so the type check passes; Task 3 replaces them), the replay cases (`audit.ended` restores the `audits` row from its data; `milestone.reached` restores the `milestones` row; the brief kinds carry no table), and the `todayCap` read in `budget.ts`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 5:** Commit `Lay the Phase 3 types: audits, proposals, the brief, milestones and today's cap`.

### Task 2: The audit prompt, the schema, the parser, evidence verification and the page [Opus] [screens]

**Files:**
- Create: `engine/audit/schema.ts`, `engine/audit/prompt.md` (the surveyor's instructions, the Beagle audit as the worked example)
- Test: `test/audit-schema.test.ts`

**Interfaces:**
- Produces: `AUDIT_SCHEMA: object` (JSON schema: `{ claims: number; findings: Array<{ claim; source: { file; line }; verdict; tested; evidence: Array<{ file; line; note }>; proposal: { title; body; scope: string[]; acceptance: string[]; tier } | null }> }` with `additionalProperties: false` and the enum of verdicts); `auditPrompt(i: Pick<AuditInput, 'repo' | 'readme' | 'docs' | 'checks'>): string` (the task in his terms: list what the README and docs promise, check each against the code with Read, Glob and Grep, run the repo's own checks with the `run` tool where they exist, mark each claim by ruling 2, cite `file:line`, propose a job for each gap by ruling 4, answer only in the schema; the Beagle audit's findings from spec 9.1 are the example of the register); `parseAudit(answer: unknown, text: string): { claims: number; findings: Finding[] } | { error: string }` (ruling 15: caps, `additionalProperties` dropped, ids `f1..fn`, paths normalised and refused when absolute, containing `..`, or under `.git`; tier defaulted to `normal`; `DENY_SCOPE` globs removed from `scope`; an `acceptance` of zero lines gets "The claim in the README holds and a test shows it."; the fallback when `answer` is null is the first `{...}` block of `text`); `verifyEvidence(findings: Finding[], dir: string): Finding[]` (ruling 3, synchronous, `lstat` not `stat`, so a symlink is refused; a finding with no verified evidence gets `unverified: true` and `proposal: null`); `countVerdicts(findings): Record<Verdict, number>`; `renderAudit(a: Audit, names: { repoDescription: string | null }): string` (ruling 7; every outside string through `plain()` from `report.ts`); `auditSlug(repo, auditId): string`.
- [ ] **Step 1: Write the failing tests:** `the prompt names the README path, each docs file and the repo's test command`; `parseAudit keeps five verdicts, drops unknown keys, caps 60 findings and 3 evidence lines`; `parseAudit refuses absolute paths, parent paths and .git paths` (each becomes `verified: false` evidence or a dropped scope glob; nothing throws); `parseAudit falls back to the JSON block in the text`; `a malformed answer returns an error, not findings`; `verifyEvidence marks a missing file, a symlink and a line past the end unverified, and a finding with none loses its proposal` (a temp dir with one 10 line file and a symlink to `/etc/hosts`); `renderAudit writes the lead, the table and the three sections with no dash punctuation and no path of this Mac` (an evidence note containing `/Users/x/secret` is redacted); `a README of generated text 2 MB long is cut to 200 KB before the prompt` (Review Focus 1).
- [ ] **Step 2:** Run `node --import tsx --test test/audit-schema.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement. The prompt is prose he would write to a careful engineer: short, with the five verdicts defined once and the example findings from spec 9.1 in a fenced block.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Define the README audit: its prompt, its schema, its parser, verified evidence and its page`.

### Task 3: Provider.audit on the four backends [Opus] [screens]

**Files:**
- Modify: `engine/market/claude.ts`, `engine/market/toolloop.ts`, `engine/market/ollama.ts`, `engine/market/anthropic-api.ts`, `engine/market/fake-provider.ts`
- Test: `test/claude-provider.test.ts`, `test/toolloop.test.ts`, `test/fake-provider.test.ts`

**Interfaces:**
- Consumes: `AuditInput`, `AuditResult` (Task 1), `auditPrompt()` and `AUDIT_SCHEMA` (Task 2; the runner passes `schema`, the backend passes it through).
- Produces: `claudeProvider().audit(i)`: the work session (`head()`, `WORK_TOOLS` plus `RUN_TOOL`, the hook, the nested sandbox, `--include-hook-events`, the CLI profile, `runQuiet` before start and each tool turn) with `--json-schema JSON.stringify(i.schema)` and the audit prompt on stdin; `answer` is `structured_output` else null; `caps` as given. The Ollama and Anthropic loops: the same tool loop as `work()` with the audit prompt, ending when the model answers with JSON that parses (one retry with "answer only with the JSON" when it does not), `answer` the parsed object. `fakeProvider({ audit })`: scripted; `fakeDefaults.audit(i)` reads `i.readme` and answers two findings (one `REAL` citing the README's own first line, one `MISSING` with a proposal titled from the README's second heading) so the sample economy and the UI tests have content without a script. `FakeScript` gains `audit?: (i: AuditInput) => Awaitable<AuditResult>`.
- [ ] **Step 1: Write the failing tests:** claude: `audit builds the work argv plus --json-schema and reads structured_output` (the fake spawner from `test/claude-provider.test.ts` answers a `stream-json` with `structured_output`); `an audit over its credit cap ends capped`; toolloop: `the local audit retries once for JSON and then crashes with the reason`; fake: `the default fake audit answers one REAL and one MISSING finding from the README`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. In `claude.ts`, factor the body of `work()` into `drive(i, { prompt, schema, hooks })` so `work()` and `audit()` share one path; no second copy of the argv.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Teach every backend to audit a repo and answer in the schema`.

### Task 4: The audit runner [Opus] [screens]

**Files:**
- Create: `engine/audit/run.ts`, `engine/audit/store.ts`
- Modify: `engine/market/runs.ts` (the scheduler tick starts one queued audit when none is live; `failInterruptedRuns()` also ends audits left `preparing`, `installing` or `reading` as `crashed`), `engine/repos.ts` (`runAnalysis` queues an audit per ruling 6; `Repo.auditedAt` set when an audit ends `done`), `engine/main.ts` (backfill: repos with `joinedAt` and no `auditedAt` are queued oldest first when `auditOnConnect`)
- Test: `test/audit-run.test.ts`

**Interfaces:**
- Consumes: `createRunDir`, `controlFiles`, `removeRunDir`, `KEPT` (`worktree.ts`), `startEgress`, `hostsFor` (`egress.ts`), `startBroker`, `forgetRun` (`broker.ts`), `installDeps` (`install.ts`), `acquire`, `charge`, `callPaused`, `unattended` (`budget.ts`), `runQuiet`, `reapRun`, `providerFor`, `parseAudit`, `verifyEvidence`, `countVerdicts`, `renderAudit`, `auditSlug` (Task 2), `installedModels` (`firms.ts`).
- Produces (`engine/audit/store.ts`): `saveAudit(a)`, `audit(id): Audit | null`, `listAudits(f: { repo?: string; status?: AuditStatus[] } = {}): Audit[]` (newest first), `latestAudit(repo): Audit | null`, `liveAuditIds(): string[]`.
- Produces (`engine/audit/run.ts`): `queueAudit(repo: Repo, trigger: AuditTrigger): Audit` (status `waiting`, records `audit.started`, emits it; refuses with a thrown `Error` when the repo already has a live or waiting audit); `pickAuditModel(settings, installed: string[], now): ModelRef | null` (ruling 5); `startQueuedAudit(opts: { now; quiet?; reap?; installDeps? }): Promise<Audit | null>` (the oldest `waiting` audit when no audit is live and `pickAuditModel` returns one: `acquire(model, 'work', AUDIT_ESTIMATE)`, root `<home>/runs/<auditId>` with `createRunDir(repo, auditId, 'palimpsest/' + auditId)`, egress, broker with `stage: () => toolStage`, `installing` with `hostsFor('install', …)`, then `reading` with `hostsFor('working', ecosystems, model)`, the README and docs read by the engine from the clone (ruling 1 caps), `providerFor(model).audit()` with `caps { maxTurns: 60, maxMinutes: 25, maxCredits: settings.auditMaxCredits }`, `runQuiet` then `parseAudit` and `verifyEvidence` against the clone, `renderAudit` to `paths().reports/audits/<slug>.md`, `charge({ kind: 'audit', firmId: null, runId: auditId, … })`, `audit.stage` per stage, `audit.ended` with the whole `Audit`, `repo.auditedAt` on `done`, `removeRunDir` keeping `KEPT`, `forgetRun`, release); `killAudit(id, reason): boolean` (aborts the lease; the stop file and the hard stop reach it through the lease's signal as runs do); `auditLogPath(id)`. The scheduler calls `startQueuedAudit()` each tick after runs are started, so runs keep priority for the slots.
- [ ] **Step 1: Write the failing tests** (fake provider, `PALIMPSEST_SANDBOX=off`, a bare repo in the temp dir with a README of three claims and a `package.json` with a test script): `a queued audit runs in a fresh clone and ends done with its findings, its page and a credits row of kind audit with no firm` (the clone's push URL is `no-push://palimpsest`; the root is removed but `log.jsonl` is kept; `repo.auditedAt` is set); `the fake agent's evidence citing /etc/passwd and ../x is unverified and proposes nothing` (Review Focus 2); `a repo with no README ends done with zero findings and "No README to check"` (Review Focus 1); `the stop file kills a reading audit within 5 s and leaves the repo unhalted with no strike` (Review Focus 3; the fake audit waits on its signal); `the credit cap ends the audit capped`; `only one audit is live at a time and a repo cannot queue two`; `auto picks sonnet when Claude is free and a local coder when it is paused` (`pickAuditModel` with a stale reading); `the first analysis queues an audit once, and a re-analysis does not`; `an audit left reading when the engine stopped ends crashed at start`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Reuse, do not copy: the runner is a short lifecycle over the same functions `runs.ts` calls; a helper shared with `runs.ts` is extracted only if both call it unchanged.
- [ ] **Step 4:** Run; expect PASS. Run `npm test` whole; the Phase 2 suites still pass.
- [ ] **Step 5:** Commit `Audit a repo's README against its code in a sandboxed clone, charged to the city`.

### Task 5: Proposals as draft jobs, and the key rule [Opus] [screens]

**Files:**
- Create: `engine/audit/proposals.ts`
- Modify: `engine/market/jobs.ts` (`postProposal()`, `key` on every job, `proposeHarnessJob` uses `HARNESS_KEY`), `engine/guild/baseline.ts` (`ensureHarnessProposal` honours the key rule), `docs/SELF_RECURSION_GUARDRAILS.md`
- Test: `test/proposals.test.ts`, `test/jobs.test.ts`, `test/baseline.test.ts`

**Interfaces:**
- Consumes: `Audit` with verified findings (Task 4's `audit.ended` event), `CITY_MARKER`, `TIER_VALUE`, `proposalKey`, `HARNESS_KEY`.
- Produces (`engine/market/jobs.ts`): `postProposal(input: { repo; title; body; scope; acceptance; tier; key; source: 'proposal' | 'brief'; proposal: Job['proposal'] }): Job` (status `proposed`, body `CITY_MARKER + '\n' + body`, records `job.proposed`, emits it); `keyTaken(repo, key): Job | null` (the newest job with that key that is not `withdrawn` by the city; a `withdrawn` by him counts as taken: dismissed stays dismissed); `transition()` to `withdrawn` records who withdrew (`by: 'him' | 'city'` in the note) so `keyTaken` can tell.
- Produces (`engine/audit/proposals.ts`): `proposeFromAudit(a: Audit): Job[]` (ruling 4: for each finding with a proposal and verified evidence, `keyTaken` decides; a merged key is proposed again only when the verdict is still `MISSING` or `BROKEN`, with the "proposed again" line; the proposal's `jobId` is written back into the stored audit); `installProposals(): () => void` (subscribes to `audit.ended` with status `done`).
- Produces (`docs/SELF_RECURSION_GUARDRAILS.md`): the audit arrows (`first analysis > audit (once) > proposed job > his click > open`; `his click on the district page or the brief > audit`), and the sentence that an audit never runs after a city merge.
- [ ] **Step 1: Write the failing tests:** `an audit with three gaps posts three proposed jobs with the marker, the tier's value and the finding's evidence in the body`; `a proposal key already open is not posted again`; `a key he dismissed stays dismissed on the next audit`; `a merged key is posted again only while the claim is still missing or broken`; `a harness job that merged is not proposed again by the next analysis` (the Task 14 parked item); `proposed jobs never bid` (the scheduler ticks with a proposed job and no bidding opens); `every proposed job's scope excludes DENY_SCOPE`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Turn each verified gap into a draft job that waits for his click, once`.

### Task 6: The brief engine [Opus] [screens]

**Files:**
- Create: `engine/brief.ts`
- Modify: `engine/market/report.ts` (the audit spend row, today's cap line, proposals from audits under "Waiting on you" with their claim), `engine/market/budget.ts` (nothing new beyond Task 1; the test here pins the cap in the gate)
- Test: `test/brief.test.ts`, `test/report.test.ts`

**Interfaces:**
- Consumes: `reportData(day)`, `latestReport()`, `treasury()`, `listJobs`, `listRuns`, `listRepos`, `listAudits`, `listMilestones` and `weekTour` (Task 7; until Task 7 lands the brief's `city` section and `tour` are empty through an injected `milestones: () => []`), `acceptProposed`, `setTier`, `dismissProposed`, `resumeRepo`, `queueAudit`, `patchSettings`, `query`.
- Produces: `briefData(now: number, opts: { milestones?: () => Milestone[]; tour?: (week: string) => Tour | null } = {}): Brief` (ruling 8: `since` from the last `brief.opened`, else 24 h; `waiting`: `pr`, `proposal` (with `tier` and actions `accept, tier, dismiss, why`), `halt` (`resume, why`), unanswered notes; `overnight`: `merged` (`diff, fly, why`), `failed` (`retry` when attempts remain, `why`, `dismiss`), `revert` (`why, fly`); `recommendations`: `audit-due` for a connected repo never audited (`audit, dismiss`), `audit` for an audit that ended since (`why` opens the report, `accept` on each of its proposals is on the proposal items), `usage` when either window is past `todayCap` minus 10 points (`cap`), `stale` when the reading is stale (`why`; Resume anyway stays on the treasury); `city`: `milestone` (`fly, dismiss`) and `tour`; `acted` filled from `brief.action` rows of the same `itemId` since `since`; `due` is `firstOpen && items > 0` (Decision 2); `lead` is two sentences from the counts); `openBrief(now): Brief` (records `brief.opened` once per local day, returns the brief with `firstOpen` true the first time); `actOn(itemId: string, action: BriefAction, body: { tier?: Tier; pct?: number }, now: number): { item: BriefItem; result: unknown }` (ruling 9; refuses an action the item does not offer with an `Error` naming it; `taught` true for `dismiss`, `accept`, `tier`, `retry`, `cap`; records `brief.action` and emits it); `briefDay(now)`.
- [ ] **Step 1: Write the failing tests** (the fixtures of `test/report.test.ts`): `the brief lists what merged, failed and waits since the last open, with the actions each offers`; `accept on a proposal opens it and records a taught action`; `dismiss withdraws a proposal and is recorded as taught`; `tier changes the value and stays`; `cap sets today's limit, clamps it and the treasury reports it`; `an action the item does not offer is refused`; `openBrief records one open per day and the second brief says firstOpen false` (Review Focus 4); `an item acted on carries its action and a PR item stays until its PR closes`; `a halted repo appears with Resume, and resume clears it` (spec 17); `the daily report lists the audit's spend under the city's own calls and names today's cap`; `due is false on a morning with nothing to show`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Item texts are the report's register: plain sentences, the job title quoted, the firm named, numbers as the report prints them (`plain()`, `num()` from `report.ts`).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Compose the morning brief from the report and the live city, and log what he does with it`.

### Task 7: Milestones and the week tour (engine) [Opus] [screens]

**Files:**
- Create: `engine/market/milestones.ts`, `shared/tour.ts`
- Modify: `engine/main.ts` (`installMilestones()` and the backfill), `engine/brief.ts` (wires `listMilestones` and `weekTour`)
- Test: `test/milestones.test.ts`, `test/tour.test.ts`

**Interfaces:**
- Consumes: `layoutTower` (`shared/tower-layout.ts`), `city()` and `loadTower` (`repos.ts`), `quarters()` and `agentTowerId` (`firms.ts`), the bus events `floor.lit`, `floor.laid`, `pr.opened`, `merge.detected`, `job.changed` (to `closed`), `firm.bankrupt`, `repo.disconnected`, `repo.analyzed`, `query`.
- Produces (`engine/market/milestones.ts`): `installMilestones(o: { now?: () => number } = {}): () => void` (ruling 11: on `floor.lit` recompute the skyline over every standing tower, founding and agent, by `layoutTower(spec).top`; a new holder reaches `skyline:<towerId>` with `lit true` and the old holder's row is patched `lit false`; a lit floor on a repo tower whose previous newest floor `at` is `QUIET_DAYS` or more earlier reaches `revival:<floorId>` with `until` now plus `LIGHTS_DAYS`; the first `pr.opened` of a firm reaches `ribbon:<floorId>` with `until null`, patched to merge plus `RIBBON_DAYS` on `merge.detected` and to now on `closed`; `firm.bankrupt` ends that firm's ribbons now; `repo.disconnected` removes nothing (the tower stands); each reach records `milestone.reached` once by id); `backfillMilestones(now)` (the skyline holder of the standing city, revivals and ribbons from the ledger since the start, recorded once; Decision 3's "first spire"); `listMilestones(now, o: { active?: boolean } = {}): Milestone[]` (`active`: `until` null or after now); `milestonesOf(towerId)`.
- Produces (`shared/tour.ts`, pure): `weekOf(now): { week: string; from: string; to: string }` (Monday 00:00 local to the next); `tourPlan(w, events: Array<{ kind: TourStop['kind']; at; towerId; floorId; agentId; firmId; repo; title }>, standing: Set<string>): Tour | null` (ruling 12: at most `TOUR.maxStops` stops in time order, the busiest kinds first when there are more (`skyline`, `revival`, `ribbon`, `scar`, `merged`, `firm`, `hire`), stops on towers not in `standing` dropped, `exchange` first and last with `dwell 3`, each stop `dwell TOUR.dwell` and `glide TOUR.glide`, captions "Ashlar & Vane laid floor 41 on harbor-ledger, Tuesday"; null under `TOUR.minStops`).
- Produces (`engine/market/milestones.ts`): `weekTour(now): Tour | null` (events from the ledger: `floor.lit`, `floor.scarred`, `milestone.reached`, `firm.seeded` or a firm's first `job.awarded`, `agent.hired`).
- [ ] **Step 1: Write the failing tests:** `a lit floor that passes the tallest tower moves the spire and leaves the old holder unlit`; `a floor on a repo quiet for 100 days reaches a revival for seven days; one quiet 10 days does not`; `a firm's first PR ribbons its floor, a merge dates the ribbon's end, a close ends it now, a bankruptcy ends it now` (Review Focus 5); `backfill reaches the skyline once and is idempotent`; `re-analysis keeps milestones by floor id` (Review Focus 5); `a tour has at most eight stops in time order, starts and ends at the exchange, drops a tower that no longer stands, and is null with one event`; `the tour's seconds equal dwell plus glide over its stops`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Reach milestones from his own history and plan a walk through the week`.

### Task 8: API routes, events, the client and redaction everywhere [Sonnet] [screens]

**Files:**
- Modify: `engine/market/api.ts`, `engine/server.ts` (SSE forwards the new kinds), `app/src/api.ts`, `app/src/router.ts`, `engine/market/jobs.ts` (`redact()` tests)
- Test: `test/market-routes.test.ts`, `test/api-events.test.ts`, `test/router.test.ts`, `test/jobs.test.ts`

**Interfaces (full brief):**
- Routes (JSON; writes need `x-palimpsest: 1`; ids match `ID`):
  - `GET /api/audits?repo=` -> `Audit[]` without `markdownPath`; `GET /api/audits/:id` -> `AuditView` (`markdown` read from the page, `proposals` the jobs whose `proposal.auditId` matches); `POST /api/repos/:owner/:name/audit` -> 202 `Audit` (`queueAudit(repo, 'demand')`), 409 with the reason when one is live or waiting, 404 when not connected; `POST /api/audits/:id/kill` -> `{ ok }`.
  - `GET /api/brief` -> `Brief` (no record); `POST /api/brief/open` -> `Brief` (`openBrief`); `POST /api/brief/items/:itemId/:action` with body `{ tier?, pct? }` -> `{ item, result }`, 409 on a refused action with its message.
  - `GET /api/milestones?active=1` -> `Milestone[]`; `GET /api/tour?week=` -> `Tour | null` (this week by default).
  - `PATCH /api/settings` accepts `auditOnConnect` (boolean), `auditModel` (`'auto'` or a `ModelRef` of an installed backend), `auditMaxCredits` (10 to 200); `todayCapPct` is not patchable here (only through the brief's `cap` action), and is cleared by `PATCH { todayCapPct: null }`.
  - SSE forwards `audit.started`, `audit.stage`, `audit.ended`, `job.proposed` (already), `brief.action`, `milestone.reached`.
- `scrub()` is applied to every field of `AuditView`, `Brief`, `Milestone`, `Tour`, and (the Phase 2 Task 37 parked item) to `InspectionView.checks[].detail`, review `notes`, `concerns`, scope `offenders` and `JobDetail.award.why` before they are sent. `redact()` tests: a 44 character mixed-case alphanumeric run, `sk-ant-…`, `ghp_…`, `github_pat_…` are each redacted; a 40 hex sha is kept.
- `app/src/api.ts`: `audits(repo?)`, `audit(id)`, `startAudit(owner, name)`, `killAudit(id)`, `brief()`, `openBrief()`, `briefAct(itemId, action, body?)`, `milestones(active?)`, `tour(week?)`; `EVENT_TYPES` extended.
- `app/src/router.ts`: `Route` gains `'brief'` (`#/brief`) and `'audit'` (`#/audits/:id`); `PATH_OF`, `LISTS`, `ONE` extended; `parseHash` tests.
- [ ] **Step 1: Write the failing tests:** `audits list, read with proposals, start on demand and refuse a second`; `the brief opens once a day over the API and an action answers the item`; `a refused brief action is 409 with its reason`; `settings validate auditMaxCredits and auditModel`; `milestones and the tour serve from the economy fixtures`; `SSE forwards audit.ended and brief.action`; `no view carries a path of this Mac` (an inspection with a `/Users/...` offender and an audit with a `/Users/...` note both come back scrubbed); `redact catches each token form`; `router parses #/brief and #/audits/:id`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Serve audits, the brief, milestones and the tour, scrubbed, over the API and the event stream`.

### Task 9: The sample economy: audits, proposals, a week of milestones and a brief [Opus] [screens]

**Files:**
- Modify: `engine/market/sample-economy.ts`, `engine/sample.ts` (sample READMEs for two repos in `SAMPLE_TREES`), `tools/sample.ts`
- Test: `test/sample-economy.test.ts`

**Interfaces:**
- Produces: `seedEconomy()` adds: a `done` audit on `tidewater/harbor-ledger` (14 claims: 8 `REAL`, 2 `PARTIAL`, 3 `MISSING`, 1 `BROKEN`, one finding `unverified`, four proposals of which one he accepted yesterday and is now `bidding`, one he dismissed), a `done` audit on `lantern/assay-kit` with zero findings ("No README to check"), a `reading` audit on `hoshi/kumo` that the clock ends `done` in 20 s at `speed 20` (emitting `audit.stage` and `audit.ended` and posting two proposals), a `capped` audit from last week; milestones: the skyline on the harbour tower reached last Tuesday (its previous holder unlit), a revival on `hoshi/kumo` reached yesterday (lights still on), a ribbon on Quickset's first PR floor (the waiting floor), all with `milestone.reached` entries; a week of ledger events that plans a tour of seven stops; `brief.opened` for the last six days and `brief.action` rows (an accept, a dismiss, a cap) so the triage log has history; the brief for today has every item kind at least once (`pr`, `proposal`, `merged`, `failed`, `halt`, `revert`, `note`, `audit`, `audit-due` for `marlow/locked-vault`'s neighbour, `usage` (seeded reading at 44% against a 50 cap), `milestone`, `tour`). `economyClock` gains `audit: boolean` (default true) to run the reading audit. `verifyReplay().ok` still holds.
- [ ] **Step 1: Write the failing tests:** `the economy seeds four audits and their proposals and replays clean`; `the clock ends the reading audit done with two new proposals and events`; `today's brief holds every item kind`; `the week tour plans seven stops`; `the sample stand-in never calls the network`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. The sample READMEs, claims and proposal bodies are copy he reads in captures: written as a real maintainer and a careful auditor write.
- [ ] **Step 4:** Run; expect PASS. Then the `--economy` seed on a temp home with `PALIMPSEST_PORT=4790` answers `/api/brief` and `/api/audits`.
- [ ] **Step 5:** Commit `Seed audits, proposals, milestones and a morning brief into the sample economy`.

---

## Part B: the screens (screens track)

The screens continue the book-like language: sheets over the city, Newsreader for names and headings, IBM Plex Sans for text, Plex Mono for refs, hairline rules, sentence case, square corners, the bronze rule under the current place; lists are ledgers.

### Task 10: The audit report on the district page, the audit page, and proposals with their claims [Opus] [screens]

**Files:**
- Create: `app/src/ui/audit.ts`, `tools/ui-test-audit.ts`
- Modify: `app/src/ui/repo.ts`, `app/src/ui/repos.ts` (row line "audited 3 days ago" or "never audited"), `app/src/ui/jobs.ts` (the Proposed section groups proposals by repo under the audit that made them, each with its claim in quiet text, Accept, a tier picker and Dismiss), `app/src/ui/job.ts` (a proposal's page shows "Why the city proposes this": the claim, the verdict and the evidence as `file:line` links to GitHub at `baseSha`), `app/src/main.ts`, `app/src/ui/market.css`
- Test: `tools/ui-test.ts` (calls `auditChecks`)

**Interfaces:**
- Produces (`app/src/ui/audit.ts`): `renderAuditBlock(v: AuditView, names, opts: { onAccept(jobId); onDismiss(jobId); onTier(jobId, tier) }): HTMLElement` (the lead; a ledger of claims: verdict as a word in small caps with a hand-drawn mark per verdict (a full square for REAL, half for PARTIAL, empty for MISSING, hatched for STUBBED, a struck square for BROKEN), tested or not, evidence as `file:line` links, the proposal's title with Accept, tier and Dismiss when its job is still `proposed` or its status word otherwise; an `unverified` finding says "evidence not found in the clone"; a running audit shows its stage and a Stop); `verdictWord(v)`, `verdictMark(v)`.
- District page: a section "README against the code" with the latest audit's block, a day picker of past audits (linking to `#/audits/:id`), "Audit the README" (disabled with the reason while one is live or waiting; the 409 reason shown in place), and "Propose again" beside a harness or proposal key that merged or was dismissed. `#/audits/:id` renders the same block with the trail "Repos, <repo>, audit of <date>".
- [ ] **Step 1: Write the failing UI tests** (economy, `tools/ui-test-audit.ts`, shots `audit.png`, `audit-proposals.png`, `district-audit.png` at 1600 x 1000): the harbour district page shows the lead with its counts, 14 rows, one unverified row and four proposal rows with the right states; Accept on a proposed row moves it to Bidding on the board and the row's state changes without reload; the tier picker patches the value; Dismiss withdraws; "Audit the README" on `lantern/assay-kit` starts an audit (202) and the button disables with the reason; the clock ends the `hoshi/kumo` audit and its two proposals appear on the board under its heading; the job page of a proposal shows the claim and an evidence link; no console errors.
- [ ] **Step 2:** Run `npm run ui-test`; expect FAIL on the new checks.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): the verdict marks must read at a glance without colour; the claims ledger must not look like a scorecard. Commit `Show what each README promises against what the code does, and the jobs that close the gap`.

### Task 11: The brief screen, first open each day, every action in place [Opus] [screens]

**Files:**
- Create: `app/src/ui/brief.ts`, `app/src/ui/brief-words.ts`, `tools/ui-test-brief.ts`
- Modify: `app/src/main.ts` (first-open, the notice stack, `fly` and `diff` handlers through the existing job page hooks, `tour` handed to the city once Task 16 lands, until then "The tour arrives with the city track" in quiet text), `app/src/ui/runhead.ts` (Brief first after City), `app/src/ui/treasury.ts` (the "today's limit" line beside the five-hour meter), `app/src/ui/market.css`
- Test: `test/brief-words.test.ts`, `tools/ui-test.ts` (calls `briefChecks`)

**Interfaces:**
- Consumes: `api.brief()`, `api.openBrief()`, `api.briefAct()`, events `brief.action`, `job.changed`, `audit.ended`, `milestone.reached`.
- Produces (`app/src/ui/brief-words.ts`, pure): `briefTitle(day)` ("Tuesday 11 November"), `itemSentence(item, names)`, `actionLabel(action)` (`accept` "Post as a job", `tier` "Change the tier", `dismiss` "Dismiss", `why` "Ask why", `diff` "Open the diff", `fly` "Fly to the floor", `retry` "Retry", `resume` "Resume", `open-pr` "Open the PR", `cap` "Change today's limit", `audit` "Audit it", `tour` "Walk through the week"), `usageLine(usage)`, `emptyMorning()` = "Nothing waits on you this morning".
- Produces (`app/src/ui/brief.ts`): `createBrief(parent, { listen, onDismiss, flyToFloor, openDiff, startTour }): { show(): void; hide(): void }`: the sheet "Brief" with the day as its title and the lead under it; sections "Waiting on you", "Overnight", "Recommended", "In the city" as ledgers; each item one ruled row: the sentence, then its actions as text buttons in the sentence's line (never a button row); `tier` opens the three tiers inline; `cap` opens a one-line field with the current cap and "until midnight"; `why` unfolds the reason under the row (the award prose for a merged or failed job, the claim and evidence for a proposal, the end reason for a failure, the halt reason), `diff` and `fly` call the handlers and record; an acted item stays in place with "Posted as a job, 9:14" in quiet text; `seen` is sent once per item when its row has been in view two seconds; the usage line with both windows and today's limit; the tour row with its stop count and "Walk through the week". Updates from events without reload. The notice stack: `createNotice` becomes a column of notices each with its own Dismiss, the governor's notice names the frame rate it saw, and notices stand clear of an open sheet (left of it, never over it).
- `main.ts`: before `await city.ready`, `api.brief()`; when `due`, `navigate('brief')` and `api.openBrief()` so the brief draws over the veil as the city loads behind it; when not due and `firstOpen`, the empty-morning line as a notice. The running head gains Brief.
- [ ] **Step 1: Write the failing tests:** `brief-words` unit tests for each label and the title; UI tests (`tools/ui-test-brief.ts`, shots `brief.png`, `brief-why.png`, `brief-cap.png`): on a fresh open with the economy the brief opens before the city (`body.dataset.route === 'brief'` within the veil's time) and `brief.opened` is recorded once; it lists every section with at least one item; Post as a job on the proposal moves it and the row says so; Dismiss on the failed job hides nothing but marks it and records `taught`; Change today's limit to 30 shows "today's limit 30%" on the treasury; Ask why unfolds the claim under the proposal; Fly to the floor leaves the brief and the camera moves; a second window's brief says it is not the first open and shows the first window's action within 2 s (Review Focus 4); with the economy's actions cleared and no items the city opens with the empty line; the notices stand clear of the open sheet; no console errors.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): the brief must read as a morning page, not a dashboard; every action must be reachable by keyboard in the row. Commit `Open each day with a brief he can act on in place`.

### Task 12: Settings for the audit, the Repos row and the copy [Sonnet] [screens]

**Files:**
- Modify: `app/src/ui/settings.ts`, `app/src/ui/repos.ts`, `app/src/ui/repo.ts` (the "Autonomy grants arrive with Phase 4" note stays), `tools/ui-test-market.ts`
- Test: `tools/ui-test.ts`

**Interfaces (full brief):**
- Settings gains a section "Analysis" under Caps: "Audit each repo's README once when it connects" (switch, `auditOnConnect`), "Audit with" (`auto`, described as "Claude Sonnet when your plan has room, else the largest local coder", or a model from the installed list), "An audit may spend" (`auditMaxCredits`, shown in credits and as a share of a five-hour window: "40 credits, 4% of a window"). Privacy adds the line "An audit reads a fresh clone of your repo on this Mac inside the same sandbox as a job; what leaves is the same as a job's: your own claude CLI's calls on your login, or nothing for a local model." Repos rows: "audited <short date>" linking to the district page's section, or "never audited"; the push note reads "merges to main after inspection; needs a test and a build command" everywhere (the Phase 1 "when the market opens" copy is gone from `repos.ts` and `settings.ts`).
- [ ] **Step 1: Write the failing UI tests:** the Analysis section patches the three settings and refuses 5 credits; the Privacy text contains the audit line; a Repos row reads "audited" for the harbour repo and "never audited" for the vault; no "when the market opens" text anywhere in the built app (a grep over `dist/assets/*.js`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two). Commit `Add the audit settings and retire the copy that waited for the market`.

---

## Part C: the city (city track)

Every task here starts from the head that contains Phase 2's Task 35 (see "Starting head"), keeps every view at 60 fps, and re-measures the city from home against the ui-test guard (12M triangles, 850 calls).

### Task 13: The lit spire on the tower that holds the skyline [Opus] [city]

**Files:**
- Create: `app/src/city/milestones.ts`
- Modify: `app/src/city/scene.ts` (`setMilestones(ms: Milestone[])`, `milestoneShows()`), `app/src/main.ts` (reads `GET /api/milestones?active=1`, applies `milestone.reached`), `app/src/ui/inspector.ts` (a floor row with a milestone carries its title in quiet text: "the skyline, since Tuesday")
- Test: `test/city-milestones.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Milestone` (Task 7 through Task 8's route and event), `layoutTower`, `makeSpire(k, height, half)` (`crowns.ts`), the built tower's group by `towerId` (`Centerpiece`).
- Produces (`app/src/city/milestones.ts`): `createMilestones(opts: { quality }): { set(ms: Milestone[], towers: (towerId) => { group: THREE.Object3D; layout: TowerLayout; half: number } | null): void; update(dt, clock): void; shows(): Map<string, MilestoneShow>; dispose() }` where `MilestoneShow = { kind; towerId; lit: boolean; y: number }`; `skyline` builds a spire from `makeSpire` scaled to `max(12, 0.08 * layout.top)` m on the roof (or above a crown: it stands on the tower's true top), with a warm aircraft lamp at its tip and three lit rings when `lit`, unlit steel when passed; the lamp is a real emitter under the bloom threshold, breathing over 4 s; the spire leaves with the tower (Review Focus 5) and moves within one frame when `lit` passes to another tower. One draw call per spire kind city-wide (instanced).
- [ ] **Step 1: Write the failing tests:** `the spire stands on the tower's true top`; `a lit spire has an emissive tip and an unlit one has none`; `a tower removed takes its spire`; UI test (economy): `the harbour tower carries the lit spire and its previous holder an unlit one`; shot `spire.png` close and `spire-home.png` from home; the lamp reads from home; triangles and calls within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the spire must read as a mast with footing and stays, not a cone; the tip must read from home without blooming. Commit `Light a spire on the tower that holds the skyline`.

### Task 14: Scaffolding lights on a revived repo [Opus] [city]

**Files:**
- Modify: `app/src/city/milestones.ts`, `app/src/city/scaffold.ts` (`makeLitScaffold(stages)`: `makeRecladScaffold` with a string of lamps per lift), `app/src/main.ts`
- Test: `test/city-milestones.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Milestone` of kind `revival` with `floorId` and `until`, `makeRecladScaffold(stages)` (Phase 2 Task 28).
- Produces: `revival` hangs a two-lift scaffold on the revived floor and the one below with a string of 16 warm lamps per lift (flicker by `hash01`), standing from `at` to `until`; `set()` removes it the frame `until` passes or the tower leaves; the lamps are the only emitters; one instanced draw for all lamps.
- [ ] **Step 1: Write the failing tests:** `a revival hangs lights round its floor and the floor below`; `lights come down at until`; UI test: `the kumo tower carries scaffolding lights`; shot `revival.png`; within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the lights must read as a festoon on scaffold tubes, warm, not a neon outline. Commit `Hang scaffolding lights on a repo that comes back to life`.

### Task 15: A ribbon on a new firm's first PR floor [Opus] [city]

**Files:**
- Modify: `app/src/city/milestones.ts`, `app/src/main.ts`, `app/src/ui/inspector.ts`
- Test: `test/city-milestones.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `Milestone` of kind `ribbon` with `floorId`, `firmId`, `until`; `firmMarkColor(firmId, slots)` (`eras.ts`).
- Produces: a cloth ribbon round the floor's slab edge in the firm's mark colour with a bow at the street-facing corner, sewn as a catmull-rom strip with a slight sag between the corners and a slow sway (vertex shader, 0.3 Hz); it stays through the waiting floor's cure; comes down at `until`, at once on a bankrupt firm (Review Focus 5: `quarterEvent({ kind: 'bankrupt' })` also calls `set()`); the inspector row reads "first PR of Quickset".
- [ ] **Step 1: Write the failing tests:** `a ribbon wraps the floor's slab at its height`; `a bankrupt firm's ribbon leaves the same frame the tower darkens`; UI test: `Quickset's first PR floor carries the ribbon`; shot `ribbon.png`; within the guard.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): the ribbon must read as cloth (sag, sheen, a bow), never a flat band or a glow. Commit `Tie a ribbon round a new firm's first floor`.

### Task 16: The week tour [Opus] [city]

**Files:**
- Create: `app/src/city/tour.ts`
- Modify: `app/src/main.ts` (`T` and the brief's "Walk through the week"), `app/src/city/camera.ts` (reuses the scripted path mode from Phase 2 Task 35), `app/src/ui/brief.ts` (`startTour` handed in)
- Test: `test/tour-camera.test.ts`, `tools/ui-test.ts`, `tools/capture.ts` (a `week` clip)

**Interfaces:**
- Consumes: `Tour` (Task 8 `api.tour()`), `city.floorFrame`, `city.towerFrame`, `city.agentFrame`, `city.exchange()`, the ride's caption element style (Task 35 `ride.ts`).
- Produces (`app/src/city/tour.ts`): `tourKeys(tour: Tour, frames: (stop: TourStop) => Frame | null, exchange: Frame): TourKey[]` (pure: for each stop an eye 70 m out and 25 m up from the frame's centre on the bearing from the previous stop, a `dwell` and a `glide` from the stop, the exchange first and last); `startTour(city, keys, captions): { stop(): void; done: Promise<void> }`: the camera glides on a smoothed path (catmull-rom through the eyes, ease in and out per glide), the stop's floor highlighted as the inspector does, the caption lower left in the ride's type with the title and the day, Escape or a drag ends it and returns home; recorded through `api.briefAct('tour:<week>', 'tour')` when started from the brief.
- [ ] **Step 1: Write the failing tests:** `tourKeys places the exchange first and last and an eye per stop`; `glides sum to the tour's seconds`; UI test (economy): starting the tour moves the camera through seven stops and the caption changes at each; Escape restores the home view; `week` clip in captures (45 s at the clock's speed).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (three): no stop may frame a tower edge-on or cut a crown; glides must not swing through buildings (an eye inside any tower's frame moves out to the nearest street). Commit `Walk the camera through his week, stop by stop`.

### Task 17: The floor dossier on the ride (the interior-ride call) [Opus] [city]

**Files:**
- Modify: `shared/ride.ts` (`RideKey.caption.dossier`), `app/src/city/ride.ts`, `app/src/main.ts` (dossier data read once per ride from `api.job()`, `api.run()`, `api.inspection()`, `api.audit()` for the floors that have them), `app/src/ui/inspector.ts` ("Ride up" is already there)
- Test: `test/ride.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Consumes: `ridePlan()` and `startRide()` as Phase 2 Task 35 landed them; `Floor.earned` (`jobId`, `runId`), `Job.proposal` (Task 1), `InspectionView`.
- Produces: `RideKey.caption` gains `dossier: { diff: { files: number; lines: number } | null; plan: string | null; verdict: string | null; claim: string | null; firm: string | null } | null` (filled for earned floors by `dossierOf(floor, data)` in `shared/ride.ts`, pure); the ride dwells 2.4 s (instead of 1.2) on a floor with a dossier and the caption grows a second block set small: "4 files, 212 lines. Plan: add the missing retry to the uploader. Passed, pushable." and for a proposal floor "From the README: 'resumable uploads'" with the verdict; the block is cleaned with `cleanText()` and never wider than the caption's column. Nothing changes for founding floors.
- [ ] **Step 1: Write the failing tests:** `dossierOf fills diff, plan, verdict and claim from the views and null for a founding floor`; `ridePlan dwells longer on a floor with a dossier`; UI test: the ride on the harbour tower shows a dossier block on an earned floor and none on a founding floor; shot `ride-dossier.png`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two): legible against glass and sky at 1440 x 900; the dwell must not feel like a stall. Commit `Show what is inside a floor as the ride passes it`.

### Task 18: One interior room, only on his yes [Opus] [city] [optional]

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

### Task 19: Real-run check: the Beagle audit [Opus] [both tracks merged]

**Files:** `docs/superpowers/plans/2026-11-11-phase-3-realrun.md` holds the notes (timings, cost, what was weak); fixes only where found.

- [ ] **Step 1:** With his go-ahead, on the installed engine with the usage hook, connect `AllStreets/beagle` (spec 9.1: the first README-versus-reality case). Watch the audit through the district page: a fresh clone under `runs/`, the install stage, the reading stage under `sandbox-exec` (confirm with `ps -o pid,command` that `claude` runs under the CLI profile and each `run` command under the tool profile), the egress log showing only the registries and `api.anthropic.com`, the end with its page.
- [ ] **Step 2:** Compare its findings with the hand audit of 2026-11-08 in spec 9.1: breeding outside geotag (the hardcoded tool allow-list in `src/genome.ts`), no parent-versus-child significance test, the geotag-specific self-check prompt, no sandbox, fossils for geotag only, no LoRA. Record which the audit found, with what verdict and evidence, which it missed, and any claim it got wrong. Confirm every evidence line opens to a real line on GitHub. Confirm the credits charged agree with the hook's next reading within the margin the treasury shows, that `~/.claude/projects` gained no transcript, and that `~/.claude/settings.json` is byte-identical.
- [ ] **Step 3:** Accept one proposal from the brief the next morning (the job then runs through Phase 2's market on his plan as any labelled issue would); confirm the brief recorded the open, the accept and the dismiss of another, and that the day's report lists the audit's spend under the city's own calls.
- [ ] **Step 4:** Time the audit (target: under 15 minutes and under 40 credits for Beagle); if it misses more than two of the six hand findings, tune `engine/audit/prompt.md` and rerun once. Commit `Fix issues found on the first real audit` (never his data).

### Task 20: UI test, captures, README and media [Opus] [both tracks merged]

**Files:**
- Modify: `tools/ui-test.ts`, `tools/capture.ts`, `README.md`, `CREDITS.md`, `docs/media/*`

- [ ] **Step 1:** `tools/ui-test.ts` runs the whole Phase 3 set on the economy with the clock (audit, brief, settings, spire, lights, ribbon, tour, dossier), the console-error check across every screen, and the perf guard from home with every ornament standing; `npm run ui-test` passes on a quiet GPU.
- [ ] **Step 2:** `tools/capture.ts` gains stills `brief`, `audit`, `district-audit`, `spire`, `revival`, `ribbon`, `ride-dossier` and clips `week` (the tour) and `audit` (the hoshi/kumo audit ending and its proposals appearing on the board, 30 s at the clock's speed); re-capture `hero` and `overview` with the spire standing. All from the sample economy at 2x.
- [ ] **Step 3:** README in his style: what Phase 3 adds in plain first person (the morning brief, the README audit and what each verdict means, proposals as jobs that wait for a click, the spire, the lights, the ribbon, the tour), the honest state (the audit is one agent's reading, verified only as far as file and line; what the school will add), how an audit is sandboxed and charged, privacy, the new stills and clips. Line 77's "when the market opens" becomes the present tense. Shields row to phase 3.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test` all pass; `cargo test` in `src-tauri` still passes.
- [ ] **Step 5:** Commit `Phase 3: the city reads his repos and his mornings` and push per his standing order.

---

## Self-review notes

- Spec coverage: goal 3 and section 10 (audit on connect and on demand with the five verdicts and file and line evidence: Tasks 2, 4; proposals as jobs: Task 5; the Beagle case: Task 19); 7.1 job sources `proposal` and `brief` (Tasks 1, 5, 6); 8 (the audit under every guard, the ledger kinds, no loops documented: Tasks 4, 5); 9.1 as the template (Tasks 2, 19); 11 daily brief with every listed action: post as a job (`accept`), change scope or budget first (`tier`; scope is edited on the job page before accepting, the brief links there under `why`), ask the city why (`why`), dismiss teaching triage (`dismiss` with `taught`), open the diff (`diff`), fly to the floor (`fly`), retry (`retry`), approve or decline a pending push (per spec 17 the pending items are PRs and proposals: `open-pr`, `accept`, `dismiss`), change today's usage limit (`cap`) (Tasks 6, 11); 11 repo district's README-versus-reality report (Task 10); 13 Phase 3 line (all); 15 "actionable daily brief", "README-versus-reality analysis, Beagle as first case" (Tasks 6, 11, 19); 17 suggested tier in one click (Tasks 5, 10, 11), self-halt in the brief (Task 6), the brief's pending items as PRs and proposals (Task 6); 18 no points, badges or streaks (ruling 11, the copy rule), the lit spire (13), scaffolding lights (14), the ribbon (15), tours through his week (7, 16), designed with him (Decisions for Connor), fed by the brief (the brief offers the tour and shows milestones) and by the master net in Phase 4 (the `brief.action` and `milestone.reached` rows are its training data); the interior call (Decision 6, Tasks 17 and 18). Earned autonomy, the nets and the school stay Phase 4 and the copy says so.
- Type consistency: `Audit`, `Finding`, `Proposal`, `Brief`, `BriefItem`, `Milestone`, `Tour`, `AuditInput`, `AuditResult` are defined once in Task 1; `parseAudit`, `verifyEvidence`, `renderAudit` once in Task 2; `queueAudit`, `startQueuedAudit`, `killAudit` once in Task 4; `postProposal`, `keyTaken` once in Task 5; `briefData`, `openBrief`, `actOn` once in Task 6; `tourPlan`, `weekOf` once in Task 7; `createMilestones` once in Task 13 and extended in 14 and 15; `tourKeys`, `startTour` once in Task 16; `dossierOf` once in Task 17.
- Tests that would pass before the change: each Step 1 names a function or a route that does not exist before its task (`proposalKey`, `parseAudit`, `Provider.audit`, `queueAudit`, `postProposal`, `briefData`, `tourPlan`, the `/api/audits` routes, `createMilestones`, `tourKeys`, `dossierOf`) or a UI element no screen draws yet (the audit block, the brief sheet, the spire, the ribbon), so each fails first with "not a function", a 404 or a missing locator; the Phase 2 suites they extend (`replay.test.ts`, `budget.test.ts`, `market-routes.test.ts`, `report.test.ts`) gain assertions on fields that are absent today.
- Proportion: 20 tasks (18 default, one optional, two of them Sonnet) against the spec's Phase 3 line and sections 10, 11 and 18; step bodies carry only values the spec, a Phase 2 ruling or a ruling here pins.
