# Screens Redesign Stage 4 Implementation Plan: Jobs, Repos, Firms and the palette

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Jobs, Repos, Firms and the Cmd+K palette in the Brief's Targeting language. Each screen pins its own subjects in the city: districts, job floors, firm towers, and the palette's highlighted result. Each screen keeps its own signature on one uniform shell, and every action stays unchanged.

**Architecture:**
- First, the shared layer grows in three ways, each with tests:
  - Pins learn subjects beyond a repo's district: a floor, a firm's tower, an agent's tower.
  - The Brief's wiring (sheet, panel, pins, hover and focus lock) becomes one `mountScreen` shell, and the Brief moves onto it unchanged.
  - The controls gain the switch, field and segmented radios that these screens need.
- Then each screen follows the Brief's recipe:
  - pin its action contract in a fixture recorded from main;
  - move its words into a tested words module, cut hard;
  - rebuild it on the shell;
  - take at least three still and critique rounds.
- A perf gate and Connor's look close the stage.

**Tech Stack:** plain TypeScript DOM and CSS (no framework), three.js city behind, node:test with tsx, Playwright (tools/redesign-harness.ts, tools/ui-test*.ts).

**Spec:** docs/superpowers/specs/2026-11-20-screens-redesign-design.md. Read it all, especially "The locked direction".
- Prior plan, whose patterns this repeats: docs/superpowers/plans/2026-11-21-screens-redesign-stage2-3.md (Tasks 14 to 19 are the recipe).
- Ledger with every ruling so far: `.claude/worktrees/redesign-os/.superpowers/sdd/2026-11-21-screens-redesign-stage2-3/progress.md`. Read its rulings before starting.
- The reference screen is the live Brief: `app/src/ui/brief.ts`, `brief.css`, `brief-words.ts`, `brief-actions.ts`.

**Connor's direction for this stage (Nov 21):** "we need the HUD titles over the repos and stuff on the map... make each page unique but have a uniform UI throughout them based off of the brief page for all other pages, including the command K find."

## Global Constraints

Every constraint in the stage 2-3 plan's Global Constraints holds here word for word, except the paths changed below. In short:
- Offline, no framework, textContent only for untrusted text, no `innerHTML` in new code (the static SVG icon constants already in repos.ts may stay).
- Contrast at least 4.5:1 over the panel's thinnest ground on white.
- No tracked capitals, letter spacing at most 0.04em.
- No `backdrop-filter`. Transitions and animations touch only `transform` and `opacity`.
- Connor's plain voice: no em dashes, no "--", no emojis. A row is a headline plus figures, money sits on the key that spends it, and the full sentence waits behind Why or a hover.
- The four weights: grant, spend, decide, look. Red is reserved for the lock and the grant.
- GPU lock on both lock files for every capture, ui-test and frames run. Write your line, and remove only that line, even on failure.
- Port 4789 and a scratch `REDESIGN_HOME`. Never use 4770, the real data home, or Palimpsest.app.
- Work in a worktree on branch `redesign-stage4` from origin/main (superpowers:using-git-worktrees). Commit after every task. Nothing merges until Task 12's hard stop is answered.
- Stills are WebP (`cwebp -q 82`) under `docs/superpowers/plans/redesign-stage4/stills/<task>/`, with critiques in `docs/superpowers/plans/redesign-stage4/critique.md`.
- **Uniform, then unique.** Every screen uses `mountScreen` (Task 2): the same panel, brackets, rail, three panes, stream, keys, readouts, pins and head structure (an `h1` title, then figures). What makes a screen its own is its signature element (named in each screen's task), not its own colours, fonts or control shapes.
- IBM Plex and Newsreader leave every screen this stage touches. They stay only on pages not yet redesigned (the detail pages, School, Treasury, Settings, inspection: Stage 5).
- No action changes meaning. Each screen's sequence of API calls for its ui-test script deep-equals its fixture recorded from main (Tasks 5 and 7; Firms sends only GETs, Task 9). Weights follow the inventory table in each screen's task.

## Review Focus

1. **A subject that cannot be placed.** A firm with no standing tower (bankrupt with its towers sold, or no agents), a job whose floor is not built yet (`floorId` null, or the floor gone after a rebuild), or a repo that is not connected. The row works, and gets no pin, lock or leader. A job with no floor falls back to its repo's district. Tests: Task 1 (frameOf returns null), each screen's ui-test.
2. **Live rows under the pointer.** Jobs re-renders every second (round clocks) and on every bid. A hovered or focused row must keep its lock, its leader and keyboard focus through a re-render, and a fresh bid must not move the lock to another job. Test: Task 6's ui-test hovers a bidding row while a bid lands, and asserts that the active pin id and `document.activeElement` are unchanged.
3. **Switch races.** On, off, on within 300 ms on Connect, Market or Push ends in the last state. `aria-checked` tells the truth at every step, and exactly the requests `latestWins` sends today go out. Tests: Task 3 (`osSwitch` unit) and Task 8's ui-test (the existing rapid-toggle check, kept).
4. **A crowded board.** 40 jobs across 10 repos, or 30 connected repos. The pins get at most 20 targets, taken from the rows nearest the list's visible window, and the crowding pass still lifts at most 4 times. Test: Task 2 (`targetsInView` unit, with 40 rows and a scrolled window).
5. **Untrusted names in the HUD.** A firm name, a repo description or a job title with bidi controls, `<img onerror>` or 300 characters. In a pin tag, a palette row or a screen row, it shows as clipped text and never as markup. Test: Task 6 reuses the existing hostile-title job, and Task 10's palette ui-test searches for it and asserts the highlighted row's pin tag `textContent`.

---

## File Structure

New:
- `app/src/ui/os/screen.ts`: `mountScreen`, `targetsInView`. The uniform shell.
- `app/src/ui/os/subject.ts`: `Subject`, `subjectKey`, `parseSubject`. Pure.
- `app/src/ui/os/field.css` and additions to `control.ts` and `control.css`: `osSwitch`, `osField`, `osRadios`.
- `app/src/ui/jobs-words.ts`, `app/src/ui/firms-words.ts`, plus additions to `repos-words.ts`.
- `app/src/ui/jobs.css`, `app/src/ui/repos.css`, `app/src/ui/firms.css`, `app/src/ui/palette.css`: each screen's own layout, with every value from `--os-*`.
- `tools/redesign-screens.ts`: stills and frames for any screen.
- `tools/fixtures/jobs-act-calls.json`, `tools/fixtures/repos-act-calls.json`.
- Tests: `test/os-subject.test.ts`, `test/os-screen.test.ts`, `test/jobs-words.test.ts`, `test/firms-words.test.ts`, plus extended `test/os-control.test.ts`, `test/os-pins.test.ts` and `test/repos-words.test.ts`.

Modified:
- `app/src/ui/os/pins.ts`, `pin-layout.ts`, `gallery.ts`
- `app/src/city/scene.ts` (`firmFrame`), `app/src/main.ts` (`osCity`, creation of the four screens)
- `app/src/ui/brief.ts`, `jobs.ts`, `board.ts`, `repos.ts`, `firms.ts`, `palette.ts`, `palette-sources.ts`, `palette-rank.ts` (`PaletteEntry.at`)
- `app/src/ui/screens.css` and `market.css`: each rebuilt screen's old rules removed, by range, after a grep shows no other page uses the class
- `tools/ui-test-jobs.ts`, `ui-test-firms.ts`, `ui-test-screens.ts` (`reposChecks`, `paletteChecks`), `ui-test-market.ts` (its Repos parts), `ui-test-brief.ts`, `tools/capture.ts` (the screens' wait selectors)

---

## Stage 4a: the shared layer grows

### Task 1: Subjects: pins on floors, firm towers and agent towers

**Files:**
- Create: `app/src/ui/os/subject.ts`, `test/os-subject.test.ts`
- Modify: `app/src/ui/os/pins.ts`, `app/src/ui/os/pin-layout.ts` (rename the `repo` key fields to `at`), `app/src/city/scene.ts`, `app/src/main.ts:467`, `app/src/ui/brief.ts` (`pinTargets`), `app/src/ui/os/gallery.ts`, `test/os-pins.test.ts`, `test/os-pin-layout.test.ts`

**Interfaces:**
- Produces, in `subject.ts`:
  ```ts
  export type Subject =
    | { kind: 'repo'; repo: string }
    | { kind: 'floor'; repo: string; floorId: string }
    | { kind: 'firm'; firmId: string }
    | { kind: 'agent'; agentId: string };
  export function subjectKey(s: Subject): string; // 'repo:a/b' | 'floor:a/b#f-12' | 'firm:quickset' | 'agent:ola-bergstrom'
  export function parseSubject(key: string): Subject | null; // null for anything malformed
  ```
- Changes in `pins.ts`:
  - `PinTarget.repo` becomes `PinTarget.at: string` (a subject key).
  - `OsCity.towerFrame(repo)` becomes `OsCity.frameOf(at: string): Frame | null`.
  - `OsCity.districts()` becomes `OsCity.standing(): string[]`, the subject keys of standing districts as `repo:<full>`. Quiet pins stay districts only.
  - `createPins(parent, panel, scroller, city, opts?: { quiet?: boolean })`, where `quiet` defaults to true. Firms, Jobs and the palette pass false (Task 2 forwards it).
  - The pin tag's short name comes from `PinTarget.name`, never from parsing the key.
- Produces in `scene.ts`: `firmFrame(firmId: string): Frame | null`, the frame of the firm's tallest standing agent tower in its quarter, or null when none stands.
- In `main.ts`, `osCity.frameOf` dispatches on `parseSubject`:
  - `repo` → `towerFrame`
  - `floor` → `floorFrame`
  - `firm` → `firmFrame`
  - `agent` → `agentFrame`
  - null → null

- [ ] **Step 1: Write the failing tests:**
  - `os-subject`: each kind round-trips through `subjectKey` and `parseSubject`. `parseSubject('repo:')`, `parseSubject('floor:a/b')` (no `#`), `parseSubject('ship:x')` and `parseSubject('')` are all null. A repo name containing `#` is refused in a floor key, and kept whole in a repo key.
  - `os-pins`:
    - Two targets on one floor share a pin.
    - A `floor:` and a `repo:` target on the same repo are two pins.
    - `frameOf` returning null gives no pin, lock or leader (Review Focus 1).
    - With `quiet: false`, no quiet pin is drawn for a standing district that has no target.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/os-subject.test.ts test/os-pins.test.ts test/os-pin-layout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the Brief to `at: subjectKey({ kind: 'repo', repo })`, and update the gallery's sample targets.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then `npm run build && npm run ui-test` (GPU lock). Expected: PASS. The Brief's act-calls fixture still deep-equals, and its stills from `tools/redesign-brief.ts stills` match by eye (no visual change).
- [ ] **Step 5: Commit** with the message "Pins name their subject: a district, a floor, a firm's tower or an agent's".

### Task 2: The uniform shell, with the Brief moved onto it

**Files:**
- Create: `app/src/ui/os/screen.ts`, `test/os-screen.test.ts`
- Modify: `app/src/ui/brief.ts` (its sheet, panel, pins, scroll fold and hover and focus wiring move into the shell; nothing else changes)

**Interfaces:**
- Produces:
  ```ts
  export interface ScreenOptions { title: string; onDismiss(): void; city?: OsCity; quietPins?: boolean }
  export interface OsScreen {
    sheet: Sheet; panel: OsPanel; head: HTMLElement; list: HTMLElement;
    /** Rows that pin: each row element carries data-target=<PinTarget.id>. Hover, then focus, then `fallback` picks the lock. */
    setTargets(t: PinTarget[], fallback?: string | null): void;
    setStream(words: string[]): void;
    show(): void; hide(): void; readonly shown: boolean;
  }
  export function mountScreen(parent: HTMLElement, name: string, o: ScreenOptions): OsScreen;
  /** At most `max` targets, nearest the visible window first, then in list order (Review Focus 4). */
  export function targetsInView<T extends { id: string }>(ts: T[], rowTop: (id: string) => number | null, view: { top: number; bottom: number }, max = 20): T[];
  ```
- The shell owns:
  - the scroll fold (`dataset.scrolled`);
  - `setTargets` only when the JSON key changes;
  - re-aiming on row hover, focus and re-render, by `data-target` id, so a row element replaced with the same id keeps the lock (Review Focus 2);
  - `pins.show` and `hide` with the screen.
- The Brief keeps its own `activeId` rule (grant first) through `fallback`.

- [ ] **Step 1: Write the failing tests** in `os-screen` (node, with the DOM stand-in the os tests already use):
  - `targetsInView` with 40 rows and a window over rows 18 to 24 returns 20 targets that include 18 to 24, in list order.
  - Rows with a null top come last.
  - `max` is honoured.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `mountScreen`, and move the Brief onto it.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then `npm run build && npm run ui-test` (GPU lock). Expected: PASS, with the Brief's act-calls fixture deep-equal, focus landing where it did, and the Brief's eleven stills unchanged by eye.
- [ ] **Step 5: Commit** with the message "One shell for every screen; the Brief moves onto it unchanged".

### Task 3: Switches, fields and segmented radios in the language

**Files:**
- Modify: `app/src/ui/os/control.ts`, `app/src/ui/os/control.css`, `app/src/ui/os/gallery.ts` (the `controls` kind shows all three, in every state), `test/os-control.test.ts`
- Create: `app/src/ui/os/field.css` (imported from `os/index.css` after control.css)

**Interfaces:**
- Produces:
  ```ts
  /** A designed on/off switch: role=switch, aria-checked, class `os-switch ${className}`. Keeps createSwitch's Switch interface. */
  export function osSwitch(className: string, label: string, weight: Weight, onChange: (on: boolean) => void): Switch;
  /** An input, select or textarea dressed as a readout field: label above in the mono, focus ring from tokens. */
  export function osField<E extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(control: E, label: string): HTMLElement;
  /** Segmented radios, role=radiogroup, roving tabindex, each a reticle segment; `sum` per choice (a tier's credits). */
  export function osRadios<V extends string>(label: string, choices: Array<{ value: V; text: string; sum?: string }>, value: V, onPick: (v: V) => void, className?: string): { root: HTMLElement; set(v: V): void; disable(on: boolean): void };
  ```
- `Switch` is the existing interface from `controls.ts`, re-exported.
- A switch's weight sets its on-state ink. A grant-weight switch (Push mode, Task 8) is the one switch that may use red, and only while on.

- [ ] **Step 1: Write the failing tests:**
  - **`osSwitch`:**
    - Space and click toggle it, and `aria-checked` follows.
    - Three toggles in 300 ms call `onChange` three times and end in the last state (Review Focus 3).
    - A disabled switch has `aria-disabled` and ignores clicks.
    - Only `weight === 'grant'` uses `--os-red` (a source check on control.css, like Task 6's grant test in stage 2-3).
  - **`osRadios`:**
    - Arrow keys move both the check and the focus.
    - `set` does not call `onPick`.
    - Each choice's `sum` is in its aria-label.
  - **`osField`:**
    - The label is a real `<label for>`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the three controls.
- [ ] **Step 4: Shoot** `os-stills.ts controls` (GPU lock) and critique under "Task 3" in critique.md. The switch must read as a designed object at 1280 and with reduced motion, never as an iOS toggle. Do up to 3 rounds.
- [ ] **Step 5: Run** `npm test` and `npm run typecheck`. Commit with the message "Switches, fields and segmented radios in the Targeting language".

### Task 4: Stills and frames for any screen

**Files:**
- Create: `tools/redesign-screens.ts`
- Modify: `tools/redesign-harness.ts`, only if a helper must be lifted out of `redesign-brief.ts`

**Interfaces:**
- CLI:
  ```
  REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/redesign-screens.ts stills <jobs|repos|firms|palette> <out>
  REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/redesign-screens.ts frames <jobs|repos|firms|palette> <out>
  ```
- Each screen gets an open helper: navigate to the hash (the palette presses Meta+K), wait for its row selector, park the mouse, wait 4.5 s, then re-frame.
- Every screen's stills:
  - `<s>.png`, over the screens framing;
  - `<s>-scrolled.png`;
  - `<s>-overview.png`;
  - `<s>-1280.png`;
  - `<s>-reduced-motion.png`;
  - `<s>-hover.png`, with the pointer on the third row so its lock and leader show;
  - `<s>-closed.png`.
- Extra stills:
  - Jobs: `jobs-bidding-live.png`, one second after a seeded bid lands.
  - Repos: `repos-search.png`, with "or" typed.
  - Firms: `firms-benched.png`, with a firm planted at -155.
  - Palette: `palette-query.png`, with "quick" typed, and `palette-over-jobs.png`.
- `frames` measures like `redesign-brief.ts frames`: city alone, then the screen open, at both tiers, with REDESIGN_UNCAPPED honoured.

- [ ] **Step 1:** Write the tool. Run `stills jobs` on the current (old) Jobs screen (GPU lock). Expected: all its stills are written. These "before" stills go in `stills/before/`.
- [ ] **Step 2:** Do the same for repos, firms and palette. Commit the before stills (WebP) with the message "Stills and frames for any screen, and the before stills".

---

## Stage 4b: the screens

The recipe for each screen: contract fixture, words, rebuild, then rounds. Each screen task ends with:
- **Round 1:** stills plus a critique naming at least 5 weaknesses against the spec's goals and anti-goals, CORANTO's bar, and the live Brief's stills (the uniformity check: put one of this screen's stills beside `brief.png`, and name every difference in head, row rhythm, key shape or type).
- **Rounds 2 and 3:** refine, re-shoot and critique. Stop after round 3 only if nothing is left at the anti-goal level; otherwise go on, up to 5 rounds.

### Task 5: Jobs: the contract and the words

**Files:**
- Create: `app/src/ui/jobs-words.ts`, `test/jobs-words.test.ts`, `tools/fixtures/jobs-act-calls.json`
- Modify: `tools/ui-test-jobs.ts` (record the calls), `app/src/ui/jobs.ts` (read the words from jobs-words, with no visual change yet)

**Interfaces:**
- The action contract, with weights. Every call is unchanged:

  | Key | Call | Weight |
  | --- | --- | --- |
  | Accept on a proposal | `POST /api/jobs/:id/accept` | spend, sum = `TIER_VALUE[tier]` cr |
  | Tier on an audit line | `PATCH /api/jobs/:id {tier}` | spend |
  | Dismiss | `POST /api/jobs/:id/dismiss` | decide |
  | Withdraw (ask) | local | look |
  | Withdraw (yes) | `POST /api/jobs/:id/withdraw` | decide |
  | Keep it | local | look |
  | Repost | `POST /api/jobs/:id/repost` | spend, sum = value cr |
  | Resume | `POST /api/jobs/:id/resume` | spend |
  | Resume the market here | `POST /api/repos/:o/:n/resume` | spend |
  | Post | `POST /api/jobs` | spend, sum = chosen tier's value |
  | Repo filter, post tier, links, Try again | local or navigation | look |

- Produces in `jobs-words.ts`:
  - `jobReadouts(j: Job, d: Detail | null, names: Names, now: number): Readout[]`
  - `roundWords(open: Date | null, now: number): { v: string; k: string }`
  - `boardFigures(jobs: Job[]): Array<{ value: string; label: string; tone?: Tone | 'hot' }>`, in the order proposed, bidding, running, waiting on you, merged today, failed. Waiting is `hot` above 0.
  - `jobPinFigure(j: Job): string`
  - `streamWords(jobs: Job[], names: Names): string[]`
  - The section titles, cut. Keep the `SECTION_TITLES` export in board.ts if other pages read it.

- [ ] **Step 1:** In `ui-test-jobs.ts`, listen for `POST`, `PATCH` and `DELETE` to `/api/jobs` and `/api/repos`. Record the ordered `(method, path, body)` list for its existing script, on the current screen, into `tools/fixtures/jobs-act-calls.json`, and add a check that deep-equals it. Run it (GPU lock). Expected: the fixture is written, PASS.
- [ ] **Step 2: Write the failing words tests:**
  - A bidding job reads `[{ v: '60', k: 'cr' }, { v: '3/5', k: 'bids' }, { v: '1:42', k: 'closes' }]`.
  - A running job reads its stage and `spent of price`.
  - A failed job with 1 attempt left reads `{ v: '1', k: 'attempt left' }`.
  - A job with no detail yet has no empty `v` (Review Focus 1 of stage 2-3, kept).
  - `boardFigures` of an empty board is `[]`.
  - None of the words contain `—`, `--` or an emoji.
  - `jobReadouts` never reads `body` or `title`.
- [ ] **Step 3: Implement** them. jobs.ts reads its words from here.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then ui-test (GPU lock). Expected: PASS.
- [ ] **Step 5: Commit** with the message "Jobs: its action contract pinned and its words in one place".

### Task 6: Jobs on the shell

**Files:**
- Modify: `app/src/ui/jobs.ts` (rendering rebuilt; `act`, `load`, `heard`, the event handlers, the `latestWins`-style busy state and the post form's submit kept), `app/src/main.ts` (pass `city: osCity`), `tools/ui-test-jobs.ts` (new words and selectors), `app/src/ui/market.css` (remove lines ~1-580, 1987-2030 and 4517-4590 once a grep shows them unused elsewhere; the bids table classes may be shared with job.ts, so check)
- Create: `app/src/ui/jobs.css`

**The screen:**
- **Head:**
  - `h1` "Jobs". The ui-test's 'Job board' title check changes deliberately.
  - Then `boardFigures`.
  - Then the signature, **the pipeline rail**: one segmented bar across the head with a segment per section (proposed → bidding → running → waiting → done). Each segment is sized by count and inked by tone. Clicking a segment scrolls to its section (look).
  - The repo filter is `osRadios` under it.
- **Rows:**
  - A designator (the pin number, or a hairline), the meta (repo · source · ago), the headline (`h3`), `jobReadouts`, and the keys.
  - **Bidding rows** carry a live round: a `rangefinder` counting down the window, and the bids as a ranked ladder (one line per bid: firm, price, confidence, the city's estimate, EV), with the lead lit and fresh bids sweeping in. Sat-out agents go behind a "sat out N" look key.
  - **Running rows** carry the stage `tickStrip`.
  - **The proposal and audit groups** keep their grouping, one sub-line per repo or gap, each with its own keys.
- **Withdraw** keeps its two-step ask, with the yes key at decide weight.
- **Pins:** the targets are the jobs in proposed, bidding, running and waiting.
  - `at` is `floor:<repo>#<floorId>` when `floorId` is set and the floor stands; otherwise `repo:<repo>` (Review Focus 1).
  - The figure is `jobPinFigure`. The tone is `warn` for waiting on him and `ok` for running, otherwise `quiet`.
  - `quietPins: false`. `targetsInView` caps them at 20.
- **The post form** moves to the foot as one row of `osField`s, with the tier as `osRadios` carrying each tier's sum, and Post as a spend key carrying the chosen sum.
- **Stream:** `streamWords`.

- [ ] **Step 1: Update** `ui-test-jobs.ts`.
  - Change the words and selectors deliberately. Keep the hostile-title, refusal-text and live-count checks.
  - Add:
    - every action key has `data-weight` as in Task 5's table;
    - a pin with `data-at` for a running job's floor;
    - Review Focus 2's hover-while-a-bid-lands check.
  - Run it on the old screen. Expected: FAIL.
- [ ] **Step 2: Rebuild** the screen, and remove its old CSS.
- [ ] **Step 3: Run** `npm test`, `npm run typecheck`, then `npm run build && npm run ui-test` (GPU lock). Expected: PASS, with the act calls deep-equal to `jobs-act-calls.json`.
- [ ] **Step 4: Rounds 1 to 3** with `tools/redesign-screens.ts stills jobs`, under "Task 6".
- [ ] **Step 5: Commit** the code, the WebP stills and the critique, with the message "Jobs rebuilt on the screens layer, its floors pinned in the city".

### Task 7: Repos: the contract and the words

**Files:**
- Create: `tools/fixtures/repos-act-calls.json`
- Modify: `tools/ui-test-screens.ts` (`reposChecks` records its calls), `tools/ui-test-market.ts` (its Repos part records too, in the same fixture under a second key), `app/src/ui/repos-words.ts`, `test/repos-words.test.ts`

**Interfaces:**
- The contract, with weights:

  | Key | Call | Weight |
  | --- | --- | --- |
  | Connect switch | `POST .../connect` or `POST .../disconnect`, latestWins | decide |
  | Disconnect | `POST .../disconnect` | decide |
  | Retry analysis | `POST .../analyze` | decide |
  | Market switch | `PATCH {market}` | decide |
  | Push mode switch | `PATCH {pushMode}`, refused locally by `pushModeRefusal` | grant |
  | Tower root | `PATCH {root}` | decide |
  | Resume | `POST .../resume` | spend |
  | Find, Try again, links | local or navigation | look |

  **Ruling for Connor (flag it at Task 12):** Push mode lets the city merge to main with no review, which is authority. It takes the grant weight, so its switch is the second red object in the app, red only while on. If Connor disagrees, it becomes decide, and that is a one-line change.

- Produces in `repos-words.ts`:
  - `repoReadouts(r: Repo, floors: number | null): Readout[]`. Examples: `{ v: '18', k: 'floors' }`, `{ v: 'audited 3d' }`, `{ v: 'halted', tone: 'fail' }`, `{ v: 'analyzing 2/4', tone: 'warn' }`.
  - `reposFigures(repos: Repo[], available: number)`, giving: in the city, market on, push on, and halted (`hot` above 0).
  - `repoPinFigure(r, floors)`
  - `streamWords(repos)`
  - `PUSH_NOTE`, `marketNote` and `STEPS` move here from repos.ts.

- [ ] **Step 1:** Record the fixture from the current screen. Run (GPU lock). Expected: PASS, with the fixture written.
- [ ] **Step 2: Write the failing words tests:**
  - The examples above.
  - An unconnected repo has no floors readout.
  - A null floor count never prints "null".
  - The voice check.
- [ ] **Step 3: Implement** them. **Step 4:** Run `npm test`, typecheck and ui-test. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Repos: its action contract pinned and its words in one place".

### Task 8: Repos on the shell

**Files:**
- Modify: `app/src/ui/repos.ts` (rendering rebuilt; the `Row` state, `latestWins` coalescers, reorder-by-insertBefore and event handling kept), `app/src/main.ts`, `tools/ui-test-screens.ts`, `tools/ui-test-market.ts`, `tools/capture.ts`, `app/src/ui/screens.css` (remove 219-665, keeping the classes other pages still use: check `.repos-sec`, `.repos-trouble` and `.sheet-facts`, and move the survivors to the screens that own them), `market.css:4768-4806`
- Create: `app/src/ui/repos.css`

**The screen:**
- **Head:**
  - `h1` "Repos", then `reposFigures`.
  - Then Find as an `osField`, with the live count as a readout. Keep '/' and Escape, and remove the document listener on hide (fixes the existing leak).
- **The signature, the district roster:**
  - Connected repos are rows in slot order, each with a **floors tickStrip**: the tower's floors as ticks, the newest lit.
  - The switches (Connect, Market, Push) sit as one aligned column of `osSwitch`es, so the whole city's settings read down a single line.
  - The root picker is five reticle glyphs in an `osRadios`, keeping the five SVG icons.
- **Unconnected repos** sit below in the quieter back-pane style: name, language and a Connect switch only, with no description until hovered or focused.
- **Alerts:**
  - A halted repo shows a fail readout and a Resume spend key.
  - A harness proposal is a look key to the job.
- **Pins:** every connected repo, with `at: repo:<full>`, its figure from `repoPinFigure`, and tone `fail` when halted. `quietPins: false`, because every district is a target here.
- **Stream:** `streamWords`.

- [ ] **Step 1: Update** the ui-tests' selectors and words deliberately.
  - Keep the `[role="switch"]`, `.connect`, `.market`, `.push` and `.root-choice[data-root]` contracts, plus the rapid-toggle check (Review Focus 3) and the push refusal note check.
  - Add `data-weight="grant"` on the push switch, and a pin per connected repo.
  - Run on the old screen. Expected: FAIL.
- [ ] **Step 2: Rebuild** the screen.
- [ ] **Step 3: Run** `npm test`, typecheck and ui-test (GPU lock). Expected: PASS, with the fixture deep-equal.
- [ ] **Step 4: Rounds 1 to 3** under "Task 8".
- [ ] **Step 5: Commit** with the message "Repos rebuilt on the screens layer, every district pinned".

### Task 9: Firms, with its words

**Files:**
- Create: `app/src/ui/firms-words.ts`, `test/firms-words.test.ts`, `app/src/ui/firms.css`
- Modify: `app/src/ui/firms.ts` (the list rebuilt; keep and export `svgEl`, `gauge`, `measures`, `silhouetteGlyph`, `balanceCell` and `grouped` for the firm and agent pages), `app/src/main.ts`, `tools/ui-test-firms.ts`, `tools/capture.ts`, `market.css:2064-2216` (the list only; `.gauge`, `.firm-bal` and `.silhouette` stay for the detail pages)

**Interfaces:**
- The screen has no actions beyond the name link (a look key) and Fly there per row: a look key calling `main.ts`'s existing quarter flight through a new `FirmsOptions.flyToQuarter(firmId)` (the firm page already uses it). No fixture is needed. The ui-test asserts that no request other than GETs leaves the screen.
- Produces in `firms-words.ts`:
  - `firmReadouts(f: FirmView, floors: number): Readout[]`: pass rate, calibration, durability (each `null`-safe; "no samples" is quiet), agents and floors.
  - `balanceModel(balance: number)`, which returns `{ pct: number; marks: Array<{ at: number; label: 'bench' | 'zero' }>; tone: Tone }` on a scale from the bench line (-150) to the best balance on screen. Tone is fail when bankrupt, benched when at or below -150, and warn below 0.
  - `firmsFigures(firms)`: active, benched, bankrupt, and total balance.
  - `firmPinFigure(f)`, the balance as "353 cr".
  - `streamWords(firms)`.
- The bench line and the bankrupt hours come from `shared/market-rules.ts` (`benched`, `BANKRUPT_HOURS`), never as constants copied here.

**The screen:**
- **Head:** `h1` "Firms", then `firmsFigures`.
- **The signature, the balance instruments:** each firm is a row with its name, its motto behind hover, and its `firmReadouts`. A wide **balance rangefinder** runs across the row, with the bench line and zero marked, so the whole city's solvency reads down the column. Bankrupt firms go dark (hatched, their towers' sale as one line). Benched firms carry the bench readout and its stipend clock.
- **Pins:** each firm with `at: firm:<id>`, the figure `firmPinFigure`, and tone from `balanceModel`. A firm with no standing tower gets no pin (Review Focus 1). `quietPins: false`.

- [ ] **Step 1: Write the failing tests:**
  - `balanceModel(-155)` is benched, `(-40.21)` is warn, and `(353)` is ok.
  - A bankrupt firm is fail whatever its balance.
  - The marks sit at the right fractions.
  - The readouts carry no "NaN" or "null".
  - The voice check.
- [ ] **Step 2: Update** `ui-test-firms.ts` deliberately. Keep:
  - the balance-equality check across list, firm page and agent page;
  - the 72 h bankrupt check, and its `.neg`;
  - Lodestar's dark row;
  - the name link to `#/firms/quickset`.

  Add a pin per firm with a standing tower, none for Lodestar, and the GET-only check. Run on the old screen. Expected: FAIL.
- [ ] **Step 3: Implement** the words and rebuild the list. Run `npm test`, typecheck and ui-test (GPU lock). Expected: PASS.
- [ ] **Step 4: Rounds 1 to 3** under "Task 9", including `firms-benched.png`.
- [ ] **Step 5: Commit** with the message "Firms rebuilt as balance instruments, every firm's tower pinned".

### Task 10: The palette in the language, locking onto what it finds

**Files:**
- Modify: `app/src/ui/palette.ts`, `palette-sources.ts` (each entry gets `at` where it has a subject: repo → `repo:`, firm → `firm:`, agent → `agent:`, job → its floor or repo, as in Task 6), `palette-rank.ts` (`PaletteEntry.at?: string`), `app/src/ui/runhead.ts` (pass the city through, if the palette is mounted there), `app/src/main.ts`, `tools/ui-test-screens.ts` (`paletteChecks`), `app/src/ui/screens.css` (remove the palette block from line 1287)
- Create: `app/src/ui/palette.css`

**The palette:**
- A compact panel from the same parts: brackets, the rail, and no stream (it is too small). It sits at the top centre, over the city or any screen, with no scrim blur and a darkening only.
- The input is a command line in Azeret Mono with a block caret, its label "Find" visually hidden.
- Rows carry a designator by kind (two letters in the mono, e.g. `RP`, `FM`, `AG`, `JB`, `SC`), the name in Big Shoulders, and the state as a quiet readout.
- **The signature:** the highlighted row's subject locks in the city through its own pins instance (one target, `quietPins: false`), with a leader from the row. With no subject (a screen, a net), there is no lock. With a screen open under the palette, that screen's pins step back (hidden) while the palette is open, and return on close.
- Keep the whole behaviour contract: Cmd+K and Ctrl+K, Escape, click outside, the focus trap and its return, the recent picks under `RECENT_KEY`, ranking, `ROWS_EMPTY` and `ROWS_QUERY`, and the foot's tally.

- [ ] **Step 1: Write the failing tests:**
  - **palette-sources:** every repo, firm and agent entry has a parseable `at`, and screen and net entries have none.
  - **`paletteChecks`:**
    - Arrow down onto a firm puts one `.os-pin[data-at="firm:<id>"]` locked.
    - Escape removes it, and the Jobs screen's pins come back.
    - The hostile job title searched shows as text in the row and in the pin tag (Review Focus 5).
    - Focus returns where it was.
  - Run. Expected: FAIL.
- [ ] **Step 2: Implement** it.
- [ ] **Step 3: Run** `npm test`, typecheck and ui-test (GPU lock). Expected: PASS.
- [ ] **Step 4: Rounds 1 to 3** under "Task 10", with `palette.png`, `palette-query.png` and `palette-over-jobs.png`.
- [ ] **Step 5: Commit** with the message "The palette in the screens language, locking onto what it finds".

### Task 11: The perf gate

- [ ] **Step 1:** Ask the controller to confirm the machine is quiet, and check it yourself before starting:
  - `top -l 1 -o cpu | head -12` shows no `mds_stores` or `mdworker` above 20% CPU, and no Virtualization VM running. Spotlight indexing and a VM made the Nov 21 re-measure useless (±20% swings).
  - If the machine is not quiet, stop and report.
- [ ] **Step 2:** Take the GPU lock. For each of jobs, repos and firms, interleave `tools/redesign-screens.ts frames <s>` on a detached worktree of origin/main and on this branch: BASE, NEW, BASE, NEW, at least 2 pairs.
- [ ] **Step 3: Check.**
  - With the screen open, the uncapped median is within 10% of main's with the same screen open, at both tiers.
  - City alone is within 3%.
  - `PERF_TIERS=high,medium npm run perf` holds the home guard.
  - On a miss, use superpowers:systematic-debugging, with the bisect order from the handoff: the topbar mask pseudo-elements, the always-on ResizeObservers, the pins' per-frame allocation, then `:has()`.
- [ ] **Step 4:** Write the table in critique.md, release the lock, and commit with the message "Perf gate: Jobs, Repos and Firms on the screens layer".

### Task 12: Connor's look, and a hard stop

- [ ] **Step 1:** Build `docs/superpowers/plans/redesign-stage4/review.html`, one self-contained page with relative image paths.
  - Each screen's before and after stills side by side, plus the Brief's still beside them for uniformity.
  - The palette stills.
  - The perf table.
  - "Rulings I made", including the Push mode one from Task 7.
- [ ] **Step 2:** Publish it for Connor, and ask whether Jobs, Repos, Firms and the palette are ready to merge or what he wants changed.
- [ ] **Step 3: Stop.** Nothing merges until he answers. On his yes, merge with superpowers:finishing-a-development-branch, then run `npm run build`, restart the engine, and rebuild and install the app (`npm run app`).

---

## After this plan: Stage 5

A separate plan, written after Task 12's answer, covers the rest of the app on the same shell:
- School, with the region the 3D net view will use;
- Treasury;
- Settings;
- the firm, agent, job and district pages;
- the audit page;
- inspection in terminal mode.

Then the 3D net view itself.
