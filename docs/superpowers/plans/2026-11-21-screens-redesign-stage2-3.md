# Screens Redesign Stages 2 and 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Targeting language as a shared layer (tokens, fonts, panel, controls, readouts, motion, city pins, top bar, terminal mode), then rebuild the Brief on it, with real figures from the engine and every action unchanged.

**Architecture:**
- **Stage 2** lives in `app/src/ui/os/`. Every rule the prototype learned by eye (contrast floors, leader routing, pin placement, parallax, type-in timing, the stream's words) becomes a pure, DOM-free module with a unit test. Thin DOM builders sit on top of those modules, and their CSS sits beside them.
- The visual parts are judged on stills from a debug-only gallery (`__palimpsest.osGallery`), with a critique round per visual task.
- **Stage 3** first pins the Brief's action contract in a pure table, then gives the engine's brief items structured `figures`, so the words read fields instead of parsing sentences. Then it rebuilds `brief.ts` on the shared layer, and holds the perf gate with `tools/redesign-brief.ts frames`.
- The prototype (branch `redesign-brief-c` at 1020db1) is a reference to read, never a source to copy. Each task names what to take from its critique.

**Tech Stack:** plain TypeScript DOM and CSS (no framework), three.js city behind, node:test with tsx for unit tests, Playwright for stills and UI checks (tools/redesign-brief.ts, tools/ui-test.ts), self-hosted woff2 in `app/public/fonts`.

**Spec:** docs/superpowers/specs/2026-11-20-screens-redesign-design.md (read it all, including "The locked direction"). Reference: docs/superpowers/plans/2026-11-20-screens-redesign.md (Stage 1, done), and on branch `redesign-brief-c`: `docs/superpowers/plans/redesign-stage1/c/critique.md` (9 rounds) and its stills.

## Global Constraints

- Work in a worktree on branch `screens-os`, made from origin/main with superpowers:using-git-worktrees. Commit after every task. Nothing merges to main until Task 19's hard stop is answered.
- Offline: no CDN at runtime. Big Shoulders and Azeret Mono are self-hosted woff2 under the SIL Open Font License 1.1, each with its licence file beside it and a row in CREDITS.md.
- No UI framework. TypeScript DOM plus CSS only.
- Untrusted text (run summaries, PR titles, issue titles, repo names, firm names) is set with `textContent` only. Nothing under `app/src/ui/os/` uses `innerHTML`, `outerHTML` or `insertAdjacentHTML`. Keep the safe markdown renderer (`summary-md.ts`) for summaries.
- No action changes meaning. Every Brief action keeps its exact behaviour and its `look()` and `act()` calls (`api.briefAct`, `POST /api/brief/items/:id/:action`), because they teach the master net.
- Text contrast is at least 4.5:1, measured over the panel's thinnest ground laid over the city's brightest pixel (255, 255, 255). Focus is visible and drawn in the language. Every motion has a reduced-motion equivalent.
- Made today, not retro: no grain, no CRT blur, no scanline noise. No kitsch display faces.
- No tracked capitals anywhere (`test/no-tracked-caps.test.ts`), including the new `os/` stylesheets. Sentence case. Letter spacing at most 0.04em.
- No `backdrop-filter` on any element. Panes move by `transform` only. Transitions and animations touch only `transform` and `opacity`, except the terminal's one `filter` on the city host (Task 12).
- Screen words are in Connor's plain voice, with no em dashes, no "--" and no emojis. A row is a headline plus figures. Money sits on the key that spends it. The full sentence waits behind Why.
- The four action weights, by consequence: grant (heaviest, red, only the autonomy grant), spend (posting, retry, resume, audit, today's limit), decide (tier, dismiss, decline, revoke), look (Why, Diff, Fly there, Open PR, Walk the week). The spec names three weights. Decide is the plain key between them, which the prototype's round 6 found it needs.
- Red is reserved for the lock and the grant. Nothing else on the screen is red and filled.
- IBM Plex and Newsreader stay for the screens not yet redesigned. The Brief, the top bar and the pins use only the two new faces.
- Performance: with the Brief open, the uncapped median frame time stays within 10% of main's, measured in the same sitting, at both tiers. City-alone numbers stay within 3% of main's in the same sitting. The home guard still holds: under 850 calls and 12M triangles.
- GPU work takes the lock. Check both lock files first, write your line to both, and remove only that exact line afterwards:
  - /Users/connorevans/Downloads/palimpsest/.claude/worktrees/agent-a83d5a94629b92b13/.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/gpu.lock
  - /Users/connorevans/Downloads/palimpsest/.claude/worktrees/phase3-city/.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/gpu.lock
- Never use port 4770 or ~/Library/Application Support/Palimpsest. Stills and frames use port 4789 and a scratch `REDESIGN_HOME`. The UI tests use their own default port. Never open Palimpsest.app.
- Stills committed to the branch are WebP (`cwebp -q 82`), under `docs/superpowers/plans/redesign-stage2-3/stills/<task>/`. Critiques go in `docs/superpowers/plans/redesign-stage2-3/critique.md`, one section per visual task.

## Review Focus

1. **A brief item without figures.** This covers kinds with no numbers (note, milestone, acted, graduate, halt) and an item whose `figures` is null because an audit did not finish. The row must show its headline, its meta and Why, and never "undefined", "NaN" or an empty readout box. The test is in Task 15.
2. **A target whose tower cannot be placed.** The tower may not be built yet (`towerFrame` null), be behind the camera, be off the pane, or have its row scrolled out of the list. Then there is no pin, no lock and no leader for it, and the list works as before. The tests are in Task 9 (pure placement with null and behind frames) and Task 10 (a UI check).
3. **Opening and closing a screen quickly** (five times in two seconds, Escape, or a route change mid-frame). The plates must come back at full opacity, the frame hook count must return to zero, and no pin is left on screen. The test is in Task 10.
4. **A crowded city.** With 20 or more targets, several in one district, or a wall of pins between the row and the lock, pin placement and the router must finish, lift at most 4 times, and return a right-angled route. Quiet pins wait rather than cover a target's tag. The tests are in Task 9.
5. **A long untrusted string** (a 600-character summary, a 240-character PR title with markup in it). It is typed in as text, never parsed as HTML, ends within the type-in time limit, and is clipped by the layout, not the window. The tests are in Task 4 (timing) and Task 2 (the source check); the still is in Task 17.

---

## File Structure

New, under `app/src/ui/os/`:
- `tokens.ts`: colour, ground, depth, glow and motion values, `parallaxOffset`, `cssTokens`. Pure.
- `tokens.css`: `:root` custom properties mirroring tokens.ts, and the focus ring.
- `fonts.css`: the two `@font-face` rules.
- `motion.ts`: `typeSteps` (pure), `typeIn`, `scanOnce`, `stillMotion`. `motion.css`: keyframes and the reduced-motion block.
- `panel.ts`, `panel.css`: `dressPanel`. The brackets, the rail, three panes and parallax.
- `stream.ts`: `streamColumns` (pure) and `createStream`.
- `control.ts`, `control.css`: `osKey` and `weighKey`.
- `readout-model.ts`: `Readout`, `rangeModel`, `tickModel`, `segmentModel`. Pure.
- `readout.ts`, `readout.css`: `readoutRow`, `figure`, `rangefinder`, `tickStrip`, `segmentBar`.
- `route.ts`: `routeLeader`, `routePath`, `leaderBoxes`, `Box`, `Point`. Pure.
- `pin-layout.ts`: `lockGeometry`, `lockTagBox`, `placePins`. Pure.
- `pins.ts`, `pins.css`: `createPins`. The HUD layer over the city, the plates handoff, the lock and the leader.
- `topbar.css`: the running head in the language.
- `terminal.ts`, `terminal.css`: `createTerminal` and terminal mode.
- `gallery.ts`: a debug-only gallery that mounts each primitive with fixed sample data, for stills.
- `index.css`: `@import`s every os stylesheet in a fixed order (fonts, tokens, motion, panel, control, readout, pins, topbar, terminal).

New elsewhere:
- `app/src/ui/brief-actions.ts`: the Brief's action contract, as a pure table.
- `tools/redesign-harness.ts`: the shared Playwright helpers lifted out of `tools/redesign-brief.ts`.
- `tools/os-stills.ts`: the gallery stills.
- Tests: `test/os-tokens.test.ts`, `test/os-fonts.test.ts`, `test/os-css.test.ts`, `test/os-motion.test.ts`, `test/os-stream.test.ts`, `test/os-readout.test.ts`, `test/os-route.test.ts`, `test/os-pin-layout.test.ts`, `test/brief-actions.test.ts`.

Modified: `app/src/city/labels.ts`, `app/src/city/scene.ts`, `app/src/main.ts`, `app/src/ui/runhead.ts`, `app/src/ui/brief.ts`, `app/src/ui/brief-words.ts`, `app/src/ui/screens.css` (the Brief's old rules removed), `shared/types.ts`, `engine/brief.ts`, `CREDITS.md`, `tools/redesign-brief.ts`, `tools/ui-test-brief.ts`, `test/brief.test.ts`, `test/brief-words.test.ts`, `test/labels.test.ts`, `test/no-tracked-caps.test.ts`, `test/runhead-scrim.test.ts`.

---

## Stage 2: the shared layer

### Task 1: The two faces, self-hosted with their licences

**Files:**
- Create: `app/public/fonts/big-shoulders.woff2`, `app/public/fonts/big-shoulders-OFL.txt`, `app/public/fonts/azeret-mono.woff2`, `app/public/fonts/azeret-mono-OFL.txt`, `app/src/ui/os/fonts.css`, `test/os-fonts.test.ts`
- Modify: `CREDITS.md` (the fonts table)

**Interfaces:**
- Produces: the font families `'Big Shoulders'` (weights 100 to 900, variable) and `'Azeret Mono'` (weights 100 to 900, variable), loaded by `os/fonts.css` with `font-display: swap`.

- [ ] **Step 1: Write the failing test** `test/os-fonts.test.ts`:
  - `every bundled woff2 is credited`: for each `*.woff2` in `app/public/fonts`, CREDITS.md has a table row naming that file.
  - `the new faces carry the OFL beside them`: `big-shoulders-OFL.txt` and `azeret-mono-OFL.txt` exist and contain `SIL OPEN FONT LICENSE Version 1.1`.
  - `each face is a real woff2`: the first four bytes of both files are `wOF2`.
  - `fonts.css points only at files that exist`: every `url('/fonts/x.woff2')` in `os/fonts.css` resolves under `app/public/fonts`. There are exactly two `@font-face` rules, each with `font-weight: 100 900` and `font-display: swap`.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/os-fonts.test.ts`. Expected: FAIL, the files are missing.
- [ ] **Step 3: Add the fonts.** Take the variable Latin subsets from upstream: Big Shoulders from github.com/xotypeco/big_shoulders and Azeret Mono from github.com/displaay/azeret. Subset them with `pyftsubset --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212" --flavor=woff2`. The prototype's files (`git show redesign-brief-c:app/public/fonts/<file>`) may be used instead, only after `fonttools ttx -t fvar` confirms a `wght` axis of 100 to 900 and `-t name` confirms the family. Copy each upstream OFL.txt. Write `os/fonts.css` and add two CREDITS rows: "Big Shoulders, Patric King, The Big Shoulders Project Authors, display and figures" and "Azeret Mono, Displaay, The Azeret Project Authors, readouts and terminal".
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Self-host Big Shoulders and Azeret Mono for the screens".

### Task 2: Design tokens, and the os lints

**Files:**
- Create: `app/src/ui/os/tokens.ts`, `app/src/ui/os/tokens.css`, `app/src/ui/os/index.css`, `test/os-tokens.test.ts`, `test/os-css.test.ts`
- Modify: `test/no-tracked-caps.test.ts` (read `app/src/ui` recursively)

**Interfaces:**
- Consumes: Task 1's font families.
- Produces:
  - `type ColourToken = 'ground' | 'ink' | 'ink2' | 'dim' | 'amber' | 'amberHi' | 'red' | 'ice' | 'ok' | 'warn' | 'fail' | 'benched'`
  - `COLOUR: Readonly<Record<ColourToken, string>>` (`#rrggbb`)
  - `type Tone = 'ok' | 'warn' | 'fail' | 'benched' | 'quiet'`
  - `TONE_INK: Record<Tone, ColourToken>`
  - `GROUND: { rgb: Rgb; textMinAlpha: number }`, the panel's warm black and the thinnest alpha it may have under any text
  - `type Depth = 'near' | 'mid' | 'far'`
  - `DEPTH: Record<Depth, { parallax: { x: number; y: number }; shadow: string }>`
  - `GLOW: Record<'look' | 'spend' | 'grant', string>` (box-shadow values, static, never animated)
  - `MOTION: { fast: number; base: number; slow: number; typeCps: number; typeMaxMs: number; scanMs: number; ease: string }` (in ms)
  - `parallaxOffset(pointer: { x: number; y: number }, rect: { left: number; top: number; width: number; height: number }, depth: Depth): { x: number; y: number }`
  - `cssTokens(): Record<string, string>`, every custom property name (such as `--os-ink`) mapped to the value tokens.css must declare
  - CSS custom properties `--os-*` on `:root`, and `--os-display` and `--os-mono` for the faces
  - `index.css`, which later tasks import from

Starting values, from the prototype's final round. The test, not the eye, decides whether they hold:

| Token | Value |
| --- | --- |
| ground | `#090604` |
| ink | `#f5e9d9` |
| ink2 | `#c9b49c` |
| dim | `#a48f78` |
| amber | `#ffb547` |
| amberHi | `#ffd391` |
| red | `#ff5532` |
| ice | `#9fe3fb` |
| ok | `#9ee6b4` |
| fail | `#ff7a5e` |
| warn | `#ffc861` |
| benched | `#a9a3b8` |

Other starting values:
- `DEPTH.near.parallax` is { x: 5, y: 3.5 }, `mid` is { 0, 0 } and `far` is { -7, -5 }.
- `MOTION` is { fast 140, base 240, slow 450, typeCps 90, typeMaxMs 600, scanMs 900, ease `cubic-bezier(0.2, 0.75, 0.15, 1)` }.

The prototype set its panel's thinnest edge at alpha 0.8. At that alpha, `dim` measures about 3.8:1 over white, so `textMinAlpha` must rise until the test passes. That was its quiet contrast fault.

- [ ] **Step 1: Write the failing tests.**
  - `test/os-tokens.test.ts`:
    - `every ink holds 4.5:1 over the thinnest ground on the brightest city`: for each of ink, ink2, dim, amber, amberHi, ice, ok, warn, fail, benched, `contrast(hex(c), over([255,255,255], GROUND.rgb, GROUND.textMinAlpha)) >= 4.5`, using `app/src/ui/contrast.ts`.
    - `the state colours are distinct`: no two of ok, warn, fail, benched and red are closer than 40 in summed RGB distance.
    - `tokens.css declares exactly what tokens.ts says`: parse `:root{...}` in tokens.css. It deep-equals `cssTokens()`.
    - `parallax is clamped and opposed by depth`: a pointer at the rect's right edge gives `near` x = 5 and `far` x = -7. A pointer 300 px outside gives the same as the edge. The centre gives { 0, 0 }. `mid` always gives { 0, 0 }.
    - `type-in never outlasts its limit`: `MOTION.typeMaxMs <= 600`.
  - `test/os-css.test.ts`, run over every `.css` and `.ts` under `app/src/ui/os/`:
    - `no backdrop-filter`.
    - `transitions and animations move transform or opacity only`: each `transition:` or `transition-property:` names only transform, opacity, or `visibility 0s`, except the one rule marked `/* os: city-filter */`. Keyframes set only transform and opacity, plus `stroke-dashoffset` for SVG.
    - `no HTML parsing`: no `innerHTML`, `outerHTML` or `insertAdjacentHTML` in os `.ts` files.
    - `every animated rule has a reduced-motion answer`: each class named in an `animation:` declaration appears again inside an `@media (prefers-reduced-motion: reduce)` block.
  - Change `no-tracked-caps.test.ts` to walk `app/src/ui` recursively, so `os/*.css` is covered.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/os-tokens.test.ts test/os-css.test.ts test/no-tracked-caps.test.ts`. Expected: FAIL on the missing modules.
- [ ] **Step 3: Implement** `tokens.ts`, `tokens.css` and `index.css` (it imports `fonts.css` and `tokens.css` for now). Raise `GROUND.textMinAlpha` until the contrast test passes. Record the value it lands on in the commit message. Draw the focus ring as a 1.5 px amber corner-tick outline at a 3 px offset, on `:focus-visible` only.
- [ ] **Step 4: Run** the three test files, then `npm test` and `npm run typecheck`. Expected: PASS, and nothing else broken.
- [ ] **Step 5: Commit** with the message "Screens tokens: colour, ground, depth, glow and motion, held by tests".

### Task 3: The gallery and its stills harness

**Files:**
- Create: `tools/redesign-harness.ts`, `tools/os-stills.ts`, `app/src/ui/os/gallery.ts`
- Modify: `tools/redesign-brief.ts` (import the helpers it shared), `app/src/main.ts` (the debug handle)

**Interfaces:**
- Consumes: Task 2's `index.css`.
- Produces:
  - `type GalleryKind = 'type' | 'panel' | 'controls' | 'readouts' | 'pins' | 'terminal'`
  - `mountGallery(parent: HTMLElement, kind: GalleryKind): () => void` (it returns an unmount). Task 10 adds a third parameter, `city?: OsCity`.
  - `DebugHandle.osGallery(kind: GalleryKind | null): void`, present only with `?debug`, which loads `gallery.ts` by dynamic `import()` so the normal path never loads it
  - from `tools/redesign-harness.ts`, the functions `view`, `settle`, `ready`, `framings` and `toCity`, unchanged
  - `tools/os-stills.ts <kind|all> <out dir>`, which writes `<kind>.png`, `<kind>-1280.png` and `<kind>-reduced-motion.png` over the screens framing. It refuses ports 4770 and 4771 and requires `REDESIGN_HOME`, as `redesign-brief.ts` does.

Each later task adds its own kind to the gallery. In this task, `type` shows only a specimen: the date in Big Shoulders, a headline, a row of Azeret figures, every colour token as ink on the ground, and the focus ring.

- [ ] **Step 1:** Lift the helpers into `tools/redesign-harness.ts`, then run `REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/redesign-brief.ts stills <scratch>/check`. Expected: the same stills as before, without error.
- [ ] **Step 2:** Write `gallery.ts` (kind `type`), the debug handle entry and `os-stills.ts`. Run `npm run build && npm run typecheck`. Expected: PASS. Check `dist/assets` has a separate gallery chunk.
- [ ] **Step 3:** Take the GPU lock, run `os-stills.ts type`, and release the lock. Expected: three non-empty stills.
- [ ] **Step 4: Critique round** in `critique.md` under "Task 3: type and colour". Name at least 3 weaknesses: legibility of the dim ink, the figures' tabular alignment (use `font-variant-numeric: tabular-nums`), and any tracking. Refine the tokens, re-shoot, and stop when none is at the anti-goal level (at most 3 rounds).
- [ ] **Step 5: Commit** the code, the WebP stills and the critique, with the message "A debug gallery and stills harness for the screens layer".

### Task 4: Type-in and scan, with their still equivalents

**Files:**
- Create: `app/src/ui/os/motion.ts`, `app/src/ui/os/motion.css`, `test/os-motion.test.ts`
- Modify: `app/src/ui/os/index.css`, `app/src/ui/os/gallery.ts` (show both in `type`)

**Interfaces:**
- Consumes: `MOTION` from Task 2.
- Produces:
  - `typeSteps(length: number, cps: number, frameMs: number, maxMs: number, still: boolean): number[]`, cumulative character counts, one a frame, ending at `length`
  - `stillMotion(): boolean`, from `matchMedia('(prefers-reduced-motion: reduce)')`
  - `typeIn(node: HTMLElement, text: string, opts?: { cps?: number }): () => void`. It returns a cancel. It sets `aria-label` to the whole text first, writes `node.textContent` only, and always ends with the whole text, even when cancelled.
  - `scanOnce(host: HTMLElement): void`. It adds the class `os-scanning` for `MOTION.scanMs` and then removes it. It does nothing when still.

- [ ] **Step 1: Write the failing tests:**
  - `typeSteps(0, 90, 16, 600, false)` deep-equals `[0]`.
  - `typeSteps(30, 90, 16, 600, false)` ends at 30, is non-decreasing, and its length times 16 is at most 600 + 16.
  - `typeSteps(600, 90, 16, 600, false).length <= 38`: a long summary speeds up rather than running long.
  - `typeSteps(600, 90, 16, 600, true)` deep-equals `[600]`.
  - `typeIn's source never sets HTML`: read `motion.ts` and assert it does not match `/innerHTML|insertAdjacentHTML/`.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/os-motion.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** them. `typeIn` drives `typeSteps` from one `requestAnimationFrame` loop. `motion.css` holds `@keyframes os-scan`, a hairline cursor with ticks at its ends and a short trail. Critique rounds 1 to 4 found a full-height band reads as a glitch. Its reduced-motion block sets `animation: none` and hides the cursor.
- [ ] **Step 4: Run** the test, `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Re-shoot `type` (GPU lock), including `-reduced-motion`. In critique.md under "Task 4", check that the still at 0.7 s with reduced motion shows whole text and no cursor.
- [ ] **Step 6: Commit** with the message "Type-in and scan motion, with still equivalents".

### Task 5: The panel, its three panes, parallax and the stream

**Files:**
- Create: `app/src/ui/os/panel.ts`, `app/src/ui/os/panel.css`, `app/src/ui/os/stream.ts`, `test/os-stream.test.ts`
- Modify: `app/src/ui/os/index.css`, `app/src/ui/os/gallery.ts` (kind `panel`)

**Interfaces:**
- Consumes:
  - `Sheet` from `app/src/ui/controls.ts`, as `createSheet` returns it (`root`, `body`, `show`, `hide`)
  - `parallaxOffset` and `DEPTH` from Task 2
  - `stillMotion` and `scanOnce` from Task 4
- Produces:
  - `interface OsPanel { root: HTMLElement; head: HTMLElement; list: HTMLElement; back: HTMLElement; setStream(words: string[]): void; dispose(): void }`
  - `dressPanel(sheet: Sheet): OsPanel`. It adds the class `os-panel` to `sheet.root`; the four amber corner brackets and the range rail (`aria-hidden`); a back pane `.os-back` prepended; the head as the near pane; the body as the list. It runs `scanOnce` on each show.
  - `streamColumns(words: string[], columns: number, rows: number): string[]`, each column a run of cleaned words read downward with a middle dot between them
  - `createStream(host: HTMLElement): { fill(words: string[]): void }`, which builds columns once per distinct word list

What to carry from the prototype:
- The panel is warm black and deepest under the words, with a low amber light at its head and no edge but its marks.
- The head is a nearer plate. It is lit along its top and left, and casts a long shadow down and right onto the list.
- The back pane is wide and low, lit on its right and foot, with the panel casting onto it (rounds 7 and 8).
- The scrim is replaced by `.scrim:has(+ .sheet.os-panel)`, a shade only where the panel stands.
- Parallax writes at most two transforms a frame from one `requestAnimationFrame`. It reads the panel rect on `pointerenter` only. It is at rest on `pointerleave` and when still.
- The stream stays under 20% opacity. Each column is a composited layer moved by transform.

- [ ] **Step 1: Write the failing tests** in `test/os-stream.test.ts`:
  - `columns are words, not a font sample`: with words `['harbor-ledger', '60', '#312', 'halted']`, no column contains the same word twice in a row (round 3's "A I A I A").
  - `words are cleaned`: whitespace is dropped, each word is cut to 14 characters, and only `[A-Za-z0-9#.%-]` survive, so `'<b>x</b>'` becomes `'bxb'`.
  - `an empty brief still makes a stream`: `streamColumns([], 18, 64)` has 18 non-empty columns.
  - `deterministic`: the same input gives the same output.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/os-stream.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `stream.ts`, `panel.ts` and `panel.css`. The panel's thinnest ground under text uses `GROUND.textMinAlpha`. The gallery's `panel` kind dresses a sample sheet with a head, ten placeholder rows and a stream.
- [ ] **Step 4: Run** the test, `npm test` and `npm run typecheck`. Expected: PASS, with `os-css` still green.
- [ ] **Step 5:** Shoot `panel` (GPU lock). Critique under "Task 5". It must read as three depths in a still, with the panel dark enough over the overview's lit towers. Refine for up to 3 rounds.
- [ ] **Step 6: Commit** with the message "The screens panel: three panes, transform-only parallax, the stream".

### Task 6: The shaped control in its weights

**Files:**
- Create: `app/src/ui/os/control.ts`, `app/src/ui/os/control.css`
- Modify: `app/src/ui/os/index.css`, `app/src/ui/os/gallery.ts` (kind `controls`)

**Interfaces:**
- Consumes: `GLOW`, `COLOUR` and the focus ring from Task 2.
- Produces:
  - `type Weight = 'look' | 'decide' | 'spend' | 'grant'`
  - `osKey(label: string, weight: Weight, onClick: () => void, opts?: { sum?: string; className?: string }): HTMLButtonElement`, a `type="button"` key with `data-weight`
  - `weighKey(node: HTMLElement, weight: Weight, sum?: string): HTMLElement`, which dresses an existing button or link (the Brief's `textButton` keys and the external PR link) in place and leaves its listeners alone. `sum` is set as text in a `.os-sum` window.

How each weight is built (the prototype's round 2 and round 6 answers):
- **look:** a cold ice word, with its reticle appearing only on hover and focus.
- **decide:** amber corner ticks around a plain word.
- **spend:** a lit amber key in a heavier reticle, its sum in its own window.
- **grant:** the one hot red key, a breathing reticle and a turning seal (SVG built with `createElementNS`). With reduced motion it is static.

Disabled and `aria-busy` keys dim, and they keep their shape.

- [ ] **Step 1: Write the failing test** in `test/os-css.test.ts`: `only the grant weight is red`. In `control.css`, `var(--os-red)` appears only in rules whose selector contains `[data-weight='grant']`.
- [ ] **Step 2: Run** it. Expected: FAIL, because control.css is missing.
- [ ] **Step 3: Implement** `control.ts` and `control.css`. The gallery's `controls` kind shows each weight at rest, focused, disabled and busy, and `spend` with the sum "60 cr".
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Shoot `controls` (GPU lock). Critique under "Task 6". The grant must read as heaviest at a glance, and looking as lighter than any framed key. At 1280 nothing may clip. Refine for up to 3 rounds.
- [ ] **Step 6: Commit** with the message "Shaped controls in four weights, grant heaviest".

### Task 7: Readouts and figures

**Files:**
- Create: `app/src/ui/os/readout-model.ts`, `app/src/ui/os/readout.ts`, `app/src/ui/os/readout.css`, `test/os-readout.test.ts`
- Modify: `app/src/ui/os/index.css`, `app/src/ui/os/gallery.ts` (kind `readouts`)

**Interfaces:**
- Consumes: `Tone` and `TONE_INK` from Task 2.
- Produces (pure, in `readout-model.ts`):
  - `interface Readout { v: string; k?: string; tone?: Tone }`
  - `rangeModel(pct: number | null, cap: number | null): { run: number; head: number | null; cap: number | null; over: boolean; label: string }`. `run` is clamped to 0 to 100. `over` is true when pct >= cap. `label` is the aria text, for example "five-hour window 45%, limit 50%".
  - `tickModel(on: number, of: number): Array<'on' | 'off'>`, with the misses at the newest end
  - `segmentModel(parts: Array<{ key: string; n: number }>): Array<{ key: string; n: number; share: number }>`, which drops zero parts. The shares sum to 1. It returns `[]` when all are zero.
- Produces (DOM, in `readout.ts`):
  - `readoutRow(rs: Readout[]): HTMLElement`. It renders nothing for an empty `v`.
  - `figure(value: string, label: string, tone?: Tone | 'hot'): HTMLElement`
  - `rangefinder(label: string, pct: number | null, cap: number | null): HTMLElement`
  - `tickStrip(on: number, of: number, cls?: string): SVGSVGElement`
  - `segmentBar(parts: Array<{ key: string; n: number }>, aria: string): HTMLElement | null`

Every figure is Azeret Mono with tabular numerals, and every label is Big Shoulders in sentence case. Each instrument has `role="img"` and an aria-label that says the whole reading.

- [ ] **Step 1: Write the failing tests:**
  - `rangeModel(44.83, 50)` deep-equals `{ run: 44.83, head: 44.83, cap: 50, over: false, label: ... }`.
  - `rangeModel(null, 50)` has `head` null and `run` 0.
  - `rangeModel(120, 50).run === 100` and `.over === true`.
  - `tickModel(48, 50)` has 48 `on`, then 2 `off` at the end.
  - `tickModel(0, 0)` deep-equals `[]`.
  - `segmentModel([{ key: 'real', n: 8 }, { key: 'partial', n: 0 }, { key: 'missing', n: 2 }])` has keys `['real', 'missing']` and shares 0.8 and 0.2.
  - `segmentModel` of all zeros deep-equals `[]`.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/os-readout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files and `readout.css`. The gallery's `readouts` kind shows a figure row, two rangefinders (one over its cap), the two agreement scales (48 of 50, and 10 of 10 here) and a claims bar with five verdicts.
- [ ] **Step 4: Run** the tests, `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Shoot `readouts` (GPU lock). Critique under "Task 7". Labels hold to one line (round 2's "here 10/10" wrap), and the two scales cannot read as contradicting each other (round 1's fault 5). Refine for up to 3 rounds.
- [ ] **Step 6: Commit** with the message "Readouts and figures: rangefinders, tick scales, the claims bar".

### Task 8: The city's hook: projectToView and onFrame

**Files:**
- Modify: `app/src/city/labels.ts` (export `projectToView`, used by the plates themselves), `app/src/city/scene.ts` (`City.onFrame` and `City.frameHooks`), `app/src/main.ts` (the debug handle's `frameHooks`), `app/src/ui/os/tokens.css` (the plates handoff rule), `test/labels.test.ts`

**Interfaces:**
- Produces:
  - `projectToView(at: THREE.Vector3, camera: THREE.Camera, w: number, h: number, out: { x: number; y: number; behind: boolean }, scratch?: THREE.Vector3): { x: number; y: number; behind: boolean }`
  - `City.onFrame(fn: () => void): () => void`. It runs `fn` every frame after `plates.update()` and `peoplePlates.update()`. The returned function removes it, and calling it twice is harmless.
  - `City.frameHooks(): number`, for tests
  - `DebugHandle.frameHooks(): number`
  - the attribute `html[data-os-pins='on']`, which fades `.plates` to opacity 0 over `MOTION.slow` with `pointer-events: none`. The plates still place themselves, so the city's cost is unchanged.

- [ ] **Step 1: Write the failing tests** in `test/labels.test.ts`:
  - `projectToView puts the camera's target at the view's centre`: a PerspectiveCamera at (0, 0, 10) looking at the origin, w 1600 and h 1000, projects the origin to (800, 500) with `behind` false.
  - `a point behind the eye is behind`: (0, 0, 20) gives `behind` true.
  - `the plates use the shared projection`: labels.ts's `createPlates` body calls `projectToView` and contains no other `.project(camera)`.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/labels.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** them. In scene.ts, keep the hooks in a `Set<() => void>`, run after the plates, and wrap each call in `try/catch` that logs once and removes the hook, so one bad hook cannot stop the city.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`, then the GPU lock and `npm run ui-test`. Expected: PASS, with the plates unchanged in its stills.
- [ ] **Step 5: Commit** with the message "The city projects for the screens: projectToView and a frame hook".

### Task 9: Routing leaders and placing pins, as pure functions

**Files:**
- Create: `app/src/ui/os/route.ts`, `app/src/ui/os/pin-layout.ts`, `test/os-route.test.ts`, `test/os-pin-layout.test.ts`

**Interfaces:**
- Produces (`route.ts`):
  - `type Point = [number, number]`
  - `interface Box { x0: number; y0: number; x1: number; y1: number }`
  - `CLEAR = 7`
  - `routeLeader(from: { x: number; y: number }, to: { x: number; y: number; r: number }, avoid: Box[], top: number, bottom: number): Point[]`
  - `routePath(pts: Point[], cut?: number): string`, with each corner cut at 45 degrees and `cut` defaulting to 6
  - `leaderBoxes(pts: Point[], width?: number): Box[]`, one thin box a run, so a second leader can avoid the first (the prototype's open item 1 for Stage 2)
- Produces (`pin-layout.ts`):
  - `interface Projected { x: number; y: number; behind: boolean }`
  - `interface View { w: number; h: number; left: number }`, where `left` is the pane's left edge, the panel's right
  - `interface LockAt { x: number; top: number; base: number; half: number }`
  - `lockGeometry(head: Projected, foot: Projected, frame: { width: number; height: number }, view: View): LockAt | null`
  - `lockTagBox(lock: LockAt, view: View): { box: Box; flip: boolean }`
  - `interface PinCandidate { repo: string; quiet: boolean; locked: boolean; at: Projected | null; w: number; h: number }`
  - `interface PinPlacement { repo: string; shown: boolean; lift: number; box: Box | null }`
  - `placePins(cands: PinCandidate[], reserved: Box[], view: View): PinPlacement[]`, in input order

The router's rules, from rounds 3 to 9:
- Leave the rail level for a stub at `from.x + 44`, or `+ 76` when that is blocked.
- Then climb or drop to a clear channel, run along it to the target's x, and arrive on the ring.
- Try channels every 4 px between `top` and `bottom`, plus `from.y` and `to.y`.
- A channel within `r + 14` of the ring that is not exactly level is refused.
- Cost is the run length, plus 36 a turn, plus the stub's offset, plus an arrival penalty: 0 from above, 260 level, 520 from below.
- The fewest boxes crossed wins first, then the lowest cost.
- Each run keeps `CLEAR` px from every box.
- Use the constants above; write the body yourself.

The placement rules:
- A candidate is shown only if `at` is set, not `behind`, and `at.x > view.left + 18 && at.x < view.w - 24 && at.y > 84 && at.y < view.h - 40`.
- Its tag box is `{ x0: x - 7, x1: x + 10 + w, y0: y - 12 - h, y1: y + 7 }`.
- A target's tag that overlaps any reserved box, or a box already placed, lifts by `h + 14`, up to 4 times.
- A quiet pin never lifts. It hides while it would overlap.
- A `locked` pin is shown, takes no room (the lock names its tower) and adds no box.

The lock's rules:
- `lockGeometry` is null when either end is behind, or the head's x is outside `(view.left + 18, view.w - 24)`.
- `half` is `clamp(16, 70, tall * width / height / 2 + 10)`, `top` is `max(78, head.y - 14)` and `base` is `min(h - 30, foot.y + 6)`.
- `lockTagBox` flips when `x + half + 12 + 200 > w - 28`. A flipped tag stands up and to the left of the ring, clear of a leader climbing in from below (round 4).

- [ ] **Step 1: Write the failing tests.**
  - `test/os-route.test.ts`, rewritten from the intent of `redesign-brief-c:test/targeting-route.test.ts`, not copied:
    - `a clear sky`: the route from (760, 500) to { 1400, 300, r 21 } with no boxes is right-angled, starts at [760, 500] and ends at [1400, 279].
    - `pins between are routed round`: with the three boxes `{1000,240,1180,300}`, `{1100,180,1280,236}` and `{900,400,1080,520}`, no run crosses any of them.
    - `the flipped lock tag pushes the channel above it`: with `{1186,220,1386,274}`, there is no crossing.
    - `a wall of pins still gives a route`: 30 boxes tiling y 88 to 970 at x 1000 to 1100 give a right-angled route of at most 6 points that ends on the ring.
    - `from above beats from below`: with a clear sky and `to.y` mid-screen, the last run comes down (its end y is less than `to.y`).
    - `a second leader avoids the first`: route A, then route B with `leaderBoxes(A)` in `avoid`. B crosses none of A's boxes.
    - `routePath cuts corners`: `routePath([[0,0],[20,0],[20,20]])` equals `'M0.0,0.0 L14.0,0.0 L20.0,6.0 L20.0,20.0'`.
    - `deterministic`: the same input gives a deep-equal output.
  - `test/os-pin-layout.test.ts`:
    - `a tower behind the eye or not built gets no pin`: `at` null, or `behind`, gives `shown` false and `box` null.
    - `a pin over the panel waits`: `at.x = view.left + 10` is not shown.
    - `two targets on neighbouring towers: the later one lifts by h + 14`.
    - `a quiet pin never lifts and waits over a target's tag`.
    - `lifting stops at 4`: six targets at the same point with h 36 give lifts of 0, 50, 100, 150, 200 and 200. The sixth is shown at the fourth lift, overlapping, and never lifted higher.
    - `the locked pin takes no room`.
    - `lockGeometry` returns null when the head is behind, and clamps `half` between 16 and 70.
    - `lockTagBox` flips at the right edge: at `x = view.w - 100` it flips, and its box ends at `x - 14`.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement** `route.ts` and `pin-layout.ts`.
- [ ] **Step 4: Run** both files and `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with the message "Leaders that never cross a pin, and pin placement, as pure functions".

### Task 10: City pins and lock-on

**Files:**
- Create: `app/src/ui/os/pins.ts`, `app/src/ui/os/pins.css`
- Modify: `app/src/ui/os/index.css`, `app/src/ui/os/gallery.ts` (kind `pins`, and the signature becomes `mountGallery(parent, kind, city?: OsCity)`), `app/src/main.ts` (an `OsCity` built once, passed to screens and to the gallery), `tools/ui-test-screens.ts` (a pins check)

**Interfaces:**
- Consumes:
  - `projectToView`, `City.onFrame` and `City.towerFrame` (Task 8)
  - everything from `route.ts` and `pin-layout.ts` (Task 9)
  - `MOTION` (Task 2)
- Produces:
  - `interface OsCity { camera: THREE.Camera; towerFrame(repo: string): { center: THREE.Vector3; width: number; height: number } | null; onFrame(fn: () => void): () => void; districts(): string[] }`
  - `interface PinTarget { id: string; n: number; repo: string; name: string; figure: string; tone: Tone | 'ask' | 'grant' }`
  - `interface OsPins { show(): void; hide(): void; setTargets(t: PinTarget[]): void; setActive(id: string | null, row: HTMLElement | null): void }`
  - `createPins(parent: HTMLElement, panel: HTMLElement, scroller: HTMLElement, city: OsCity | undefined): OsPins`

What it does, and the prototype's lessons to keep:
- `show()` sets `html[data-os-pins='on']`, so the plates fade. It registers one `onFrame` hook and listens for `resize`. `hide()` undoes all of it. Both are idempotent: a second `show` adds no second hook.
- There is one numbered amber pin per district with targets. Each other district from `city.districts()` gets a quiet pin: a 6 px tick and its name, dim, never numbered, never lifted.
- Frame order is every read first, then every write.
- `towerFrame` is re-read every 90 frames, and a tag's size is read once after layout.
- The active row's middle is read only when the list scrolls or the active item changes.
- The lock is placed before the pins. The leader is routed only when the key of everything it avoids changes by a pixel. The telemetry box ("track 06", at the frame's foot) is in `avoid`.
- The active item is the hovered or focused row, or else the first target. A row scrolled out of the list hides the leader and keeps the lock.
- The lock's brackets close in on each new lock (`acquire`), and are static when still.
- `grant` pins and the lock use red. Everything else uses amber, or `dim` for quiet pins.
- Names and figures are set with `textContent`.

- [ ] **Step 1: Add the UI check** to `tools/ui-test-screens.ts`, using the gallery's `pins` kind with the sample city:
  - with three targets, the `.os-pin.on` count is greater than 0, and `.plates` computed opacity is `0`
  - after unmount, `.plates` opacity is `1` within 600 ms, `__palimpsest.frameHooks()` is `0`, and no `.os-pin` is in the DOM
  - mounting and unmounting five times in 2 s leaves `frameHooks()` at `0` and the plates at `1` (Review Focus 3)
  - a target whose repo has no tower makes no pin and no error in the console (Review Focus 2)
- [ ] **Step 2: Run** `npm run build && npm run ui-test` with the GPU lock. Expected: FAIL, because `createPins` is missing.
- [ ] **Step 3: Implement** `pins.ts` and `pins.css`, and the `pins` gallery kind. That kind opens a dressed panel with six sample rows over the screens framing, targets two of them, and makes one of them the grant.
- [ ] **Step 4: Run** `npm run ui-test` (GPU lock), `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Shoot `pins` (GPU lock). Critique under "Task 10". The leader must climb at the pane's edge, cross the sky and drop onto the ring, crossing no tag, stem or telemetry. The lock tag must be whole at 1280. Pins must not collide. Refine for up to 3 rounds.
- [ ] **Step 6: Commit** with the message "City pins and lock-on: one set of labels while a screen is open".

### Task 11: The top bar in the language

**Files:**
- Create: `app/src/ui/os/topbar.css`
- Modify: `app/src/ui/runhead.ts` (wrap the icon and mark in `.runhead-brand`), `app/src/ui/screens.css` (remove the runhead rules that topbar.css replaces), `app/src/ui/os/index.css`, `app/src/main.ts` (import `os/index.css` after `screens.css`), `test/runhead-scrim.test.ts` (read the backing from `os/topbar.css` and the variables from `os/tokens.css` too)

**Interfaces:**
- Consumes: the tokens, the focus ring, and `weighKey(…, 'look')` for Find.
- Produces: the running head on every screen in Big Shoulders. "Palimpsest" is the brand plate. The current place is held in amber corner ticks (`aria-current="page"`). Find is a cold look key with the shortcut in its own window. A ruled tape sits under the head, and the backing still holds 4.5:1.

- [ ] **Step 1: Update** `test/runhead-scrim.test.ts` to find `.runhead::before` in `os/topbar.css` and resolve `var(--os-*)` from `os/tokens.css`. Its assertions stay: a gradient only, one strength over the words, and 4.5:1 over (255, 255, 255). Run it. Expected: FAIL.
- [ ] **Step 2: Implement** `topbar.css` and the runhead change. Keep every link a plain `<a>` in Tab order. Keep `test/runhead-current.test.ts` unchanged.
- [ ] **Step 3: Run** `npm test`, `npm run typecheck`, then `npm run build && npm run ui-test` (GPU lock). Expected: PASS, including the every-screen checks.
- [ ] **Step 4:** Shoot `topbar.png` over the city and over Jobs, at 1600 and 1280 (add a `topbar` mode to `os-stills.ts`). Critique under "Task 11". It must not read as a book's title line (round 7), and it must sit with the old screens without a clash in weight. Refine for up to 3 rounds.
- [ ] **Step 5: Commit** with the message "The running head in the screens language".

### Task 12: Terminal mode

**Files:**
- Create: `app/src/ui/os/terminal.ts`, `app/src/ui/os/terminal.css`
- Modify: `app/src/ui/os/index.css`, `app/src/ui/os/gallery.ts` (kind `terminal`), `tools/redesign-brief.ts` (a `terminal` view in `frames`)

**Interfaces:**
- Consumes: the tokens, `typeIn` and `stillMotion`, and `osKey(…, 'look')` for Close.
- Produces:
  - `interface Terminal { el: HTMLElement; open(title: string, body: Node[]): void; close(): void; isOpen(): boolean }`
  - `createTerminal(parent: HTMLElement, onClose: () => void): Terminal`
  - `html[data-os-mode='terminal']`

What terminal mode does:
- The `#city` host gets the one rule marked `/* os: city-filter */`: `filter: blur(6px) brightness(0.3) saturate(0.6)`. That rule sits on the host, not on any panel.
- The panel stands full height (64 px under the top, 16 px over the foot) in Azeret Mono, amber on the ground. The first line types in, and the rest are set at once.
- Escape and Close call `onClose`, and focus returns to the opener.
- `body` nodes come from the caller (the summary renderer or text nodes). The terminal never parses strings.
- Stage 6 is its first real user (inspection). Here it is proved through the gallery and the frames gate only.

- [ ] **Step 1: Write the failing check.** In `tools/ui-test-screens.ts`, mount the gallery's `terminal` kind. Assert that `html[data-os-mode='terminal']` is set, that Escape removes it and returns focus to the opener, and that `#city` has no computed `filter` once closed. Run `npm run build && npm run ui-test` (GPU lock). Expected: FAIL, because the kind is missing.
- [ ] **Step 2: Implement** `terminal.ts` and `terminal.css`, and the `terminal` gallery kind, which shows 80 lines of a sample run log. Add a "terminal open" view to `tools/redesign-brief.ts frames`: `__palimpsest.osGallery('terminal')` over the screens framing.
- [ ] **Step 3: Run** `npm run ui-test` (expected: PASS), then frames uncapped on main and on this branch in the same sitting. Expected: terminal open within 10% of the Brief-open row of main in the same sitting, at both tiers. If high fails, the named fallback is a `City.setRenderScale(0.5)` hook while terminal mode is open, wired through `OsCity`. Add it and measure again. Record the numbers in critique.md.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS. `os-css` allows only the marked filter rule.
- [ ] **Step 5:** Shoot `terminal` (GPU lock). Critique under "Task 12". The city must be far behind but present, and the text crisp. There must be no CRT look. Refine for up to 3 rounds.
- [ ] **Step 6: Commit** with the message "Terminal mode: the city dims and blurs behind a full-height panel".

### Task 13: Stage 2 gate

**Files:**
- Modify: `docs/superpowers/plans/redesign-stage2-3/critique.md` (a "Stage 2 gate" section)

- [ ] **Step 1: Run** `npm test`, `npm run typecheck`, `npm run build`, then `npm run ui-test` and `PERF_TIERS=high,medium npm run perf <scratch>` (GPU lock). Expected: all green. The home guard is under 850 calls and 12M triangles at both tiers.
- [ ] **Step 2: Run** `tools/redesign-brief.ts frames` uncapped on main and on this branch in the same sitting (GPU lock). Expected: city alone within 3% at both tiers. The Brief is unchanged so far, so its row is within 10%.
- [ ] **Step 3:** Shoot `os-stills.ts all` and write the set critique. The six primitives must read as one language, and nothing may read as a dashboard kit. Fix anything at the anti-goal level in the owning task's files.
- [ ] **Step 4: Commit** with the message "Stage 2 gate: the screens layer, tested and measured". Delete the branches `redesign-brief-a` and `redesign-brief-b` (`git branch -D`, and their worktrees with `git worktree remove`). Keep `redesign-brief-c` until Task 19 is answered.

---

## Stage 3: the Brief rebuilt on the shared layer

### Task 14: Pin the Brief's action contract before touching it

**Files:**
- Create: `app/src/ui/brief-actions.ts`, `test/brief-actions.test.ts`
- Modify: `app/src/ui/brief.ts` (`actionNode` dispatches on `EFFECT`, with no change in behaviour), `tools/ui-test-brief.ts` (record the act calls)

**Interfaces:**
- Produces:
  - `type Effect = 'act' | 'why' | 'tier' | 'cap' | 'diff' | 'fly' | 'tour' | 'open-pr'`
  - `EFFECT: Readonly<Record<BriefAction, Effect>>`
  - `LOOKS: readonly BriefAction[]`, the actions recorded with `look()`: `['why', 'diff', 'fly', 'open-pr']`

The table is main's switch exactly:
- `why` → `why`, `tier` → `tier`, `cap` → `cap`, `diff` → `diff`, `fly` → `fly`, `tour` → `tour` and `open-pr` → `open-pr`.
- accept, dismiss, retry, resume, audit, grant, decline and revoke all map to `act`.

- [ ] **Step 1: Write the failing test:**
  - `every action has an effect`: the keys of `EFFECT` are the full `BriefAction` union, checked against a literal list of all 15.
  - `the table is main's`: deep-equal to the mapping above.
  - `looks are the engine's looks`: `LOOKS` deep-equals the LOOKS array in `engine/brief.ts`. Export it from the engine if it is not exported.
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/brief-actions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the table, and switch `actionNode` on `EFFECT[a]`. In `tools/ui-test-brief.ts`, listen to `page.on('request')` for `POST /api/brief/items/`. Assert the ordered list of `(itemId, action, body)` for the run's existing script: Why, Post, Tier set, Dismiss, today's limit 60 then 50, the tour, and Open PR. Save it as `tools/fixtures/brief-act-calls.json`. This fixture is the contract Task 17 must reproduce.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`, then `npm run build && npm run ui-test` (GPU lock). Expected: PASS, with the fixture written.
- [ ] **Step 5: Commit** with the message "Pin the Brief's action contract before the rebuild".

### Task 15: Real figures from the engine

**Files:**
- Modify: `shared/types.ts`, `engine/brief.ts`, `test/brief.test.ts`

**Interfaces:**
- Produces in `shared/types.ts`:
  ```ts
  export type BriefFigures =
    | { kind: 'merged'; paid: number | null }
    | { kind: 'failed'; attemptsLeft: number }
    | { kind: 'pr'; pr: number }
    | { kind: 'proposal'; cost: number }
    | { kind: 'audit'; real: number; partial: number; missing: number; stubbed: number; broken: number; claims: number; jobs: number }
    | { kind: 'usage'; window: 'five-hour' | 'seven-day'; nowPct: number; capPct: number; mine: boolean }
    | { kind: 'autonomy'; agreed: number; of: number; here: number }
    | { kind: 'tour'; stops: number; seconds: number }
    | { kind: 'revert'; sha: string | null };
  ```
  - `BriefItem.figures: BriefFigures | null`
  - `Brief.counts: { waiting: number; merged: number; spent: number }`
- Sources, each the same value the sentence already uses:
  - **merged:** `chosen.price`, or null.
  - **failed:** `final ? 0 : MAX_ATTEMPTS - attempts`.
  - **pr:** `r.prNumber`.
  - **proposal:** `TIER_VALUE[j.tier]`.
  - **audit:** `a.counts` by Verdict, `a.claimsRead`, and `proposed`. It is null unless `a.status === 'done'`.
  - **usage:** `windowNowPct(w) ?? 0`, with `capPct` set to `t.todayCapPct?.pct ?? w.capPct` and `mine` set to `t.todayCapPct !== null`.
  - **autonomy:** `agreed`, `n` and `AGREE.repoLast`.
  - **tour:** `realStops(tour)` and `Math.round(tour.seconds)`.
  - **revert:** `d.mergeSha?.slice(0, 7) ?? null`.
  - **Brief.counts:** `waiting` is the open-waiting count `lead()` computes, `merged` is `n.merged` and `spent` is `n.all`.
  - Every other kind gets `figures: null`.
- `text`, `title` and `lead` stay word for word, because Why and screen readers use them.

- [ ] **Step 1: Write the failing tests** in `test/brief.test.ts`, using the file's own fixtures:
  - a merged item has `{ kind: 'merged', paid: <the price> }`
  - a failed item with one attempt used has `attemptsLeft` 1
  - a waiting PR has `pr` equal to its `prNumber`
  - a proposal at tier high has `cost` 150, and after `actOn(id, 'tier', { tier: 'low' })` the returned item has `cost` 20
  - a done audit's figures sum `real + partial + missing + stubbed + broken` to `claims`
  - an audit that did not finish has `figures` null (Review Focus 1)
  - the usage item's `nowPct` equals the rounded percent in its title
  - an autonomy ask has `here === AGREE.repoLast`
  - a note has `figures` null
  - `brief.counts.waiting` equals the open waiting items, and `counts.merged` agrees with the number in `lead`
  - `text` is unchanged for every kind: compare against the strings the file already asserts
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/brief.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** them. Add `figures?: BriefFigures | null` to `Draft`, and in `toItem` set `figures: d.figures ?? null`. Recompute a proposal's cost from the tier in force when `briefData` builds the item.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS. Any test that deep-equals a whole item is updated deliberately, with `figures` added.
- [ ] **Step 5: Commit** with the message "Brief items carry their figures as fields, not only in sentences".

### Task 16: The Brief's words, from fields

**Files:**
- Modify: `app/src/ui/brief-words.ts`, `test/brief-words.test.ts`

**Interfaces:**
- Consumes: `BriefFigures`, `Brief.counts` (Task 15), `Readout` and `Tone` (Tasks 2 and 7), and `Weight` (Task 6).
- Produces:
  - `briefMeta(item: BriefItem, now?: number): { where: string; when: string }`, which replaces `dateline`
  - `itemReadouts(item: BriefItem, names: Names): Readout[]`, read from `item.figures` and `item.refs` only, never parsing `text`
  - `headFigures(b: Brief): Array<{ value: string; label: string; tone?: Tone | 'hot' }>`, from `b.counts`
  - `keySum(item: BriefItem, a: BriefAction): string | null`. It returns `"<cost> cr"` for `accept` on a proposal and null otherwise.
  - `weightOf(a: BriefAction): Weight`, from the Global Constraints list
  - `toneOf(kind: BriefItemKind): Tone | 'ask' | 'grant'`, with `quiet` for kinds that carry no state
  - `streamWords(b: Brief, names: Names): string[]`, the brief's own repo names, figures, PR numbers and states
  - Changed: `actionLabel`, `actedLine` and `sinceLine` in their short forms
  - Unchanged: `MOVE_LABEL`. Settings and the district page keep their long words until their own redesign.
- Removed: `dateline`. Do not add `leadFigures`, `auditCounts` or `agreementOf`; the prototype's regex parsers are not ported.

The words, as the prototype settled them (B's cut, C's final):

| Label | Value |
| --- | --- |
| accept | Post |
| tier | Tier |
| dismiss | Dismiss |
| why | Why |
| diff | Diff |
| fly | Fly there |
| retry | Retry |
| resume | Resume |
| open-pr | Open PR |
| cap | Set limit |
| audit | Audit |
| tour | Walk the week |
| grant | Let it act here |
| decline | Not yet |
| revoke | Take back |

The acted lines read "Posted 09:14", "Tier low 09:14", "Limit 60% 09:14", "Not yet, quiet 30 days 09:14", "Taken back 09:14", and so on. The since line reads "Since yesterday 06:40", and adds ", second look" on a later window.

- [ ] **Step 1: Write the failing tests.** Port the intent of the prototype's `brief-words.test.ts` changes, with items built with `figures`:
  - `the labels`: each label above.
  - `the acted lines`: each of the short forms above, and looking leaves no line.
  - `sinceLine`: its four cases.
  - `a row's readouts come from fields`:
    - merged with `paid` 28.37 and firm Quickset gives `[{ v: 'merged', tone: 'ok' }, { v: '28.37', k: 'cr' }, { v: 'Quickset', tone: 'quiet' }]`
    - a PR gives `[{ v: '#312', k: 'PR' }, { v: 'Quickset', tone: 'quiet' }, { v: 'review', tone: 'warn' }]`
    - failed with `attemptsLeft` 1 gives `[{ v: 'failed', tone: 'fail' }, { v: '1', k: 'attempt left' }]`, and with 0 gives `{ v: 'no attempts left', tone: 'quiet' }`
    - an audit gives `[{ v: '4', k: 'jobs proposed' }]`
    - usage gives `[{ v: '45%', k: 'five-hour' }, { v: '50%', k: 'cap' }]`
    - autonomy gives `[{ v: '48/50', k: 'agreed' }, { v: '10/10', k: 'here' }]`
  - `no figures, no empty readouts` (Review Focus 1): for each of note, milestone, halt, acted and graduate with `figures: null`, `itemReadouts` returns either `[]` or a single state readout. No `v` is empty, `'undefined'` or `'NaN'`.
  - `the text is never parsed`: an item whose `text` says "paid 999 credits" but whose `figures.paid` is 28.37 reads 28.37.
  - `money sits on the key`: `keySum(proposal at normal, 'accept') === '60 cr'`, and `keySum(proposal, 'dismiss') === null`.
  - `weights`: grant is `grant`; accept, retry, resume, audit and cap are `spend`; tier, dismiss, decline and revoke are `decide`; the rest are `look`.
  - `the words keep his voice`: no label, acted line or since line contains `\u2014`, `--`, or an emoji (`/\p{Extended_Pictographic}/u`).
- [ ] **Step 2: Run** `node --no-warnings --import tsx --test test/brief-words.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** them. `itemSentence` stays for Why and the screen-reader text.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS, except `brief.ts`, which still imports `dateline`. Keep a temporary `dateline` re-export until Task 17 removes the import, and say so in the commit.
- [ ] **Step 5: Commit** with the message "The Brief's words read the engine's figures, cut hard".

### Task 17: The Brief on the shared layer

**Files:**
- Modify:
  - `app/src/ui/brief.ts`, a rebuild of its rendering, keeping `act`, `look`, `toggleWhy`, `fly`, `tour`, `capField`, the tier picker, focus handling and `prime` as they are
  - `app/src/ui/brief-words.ts`, to drop the temporary `dateline`
  - `app/src/ui/screens.css` and `app/src/ui/market.css`, to remove the Brief's old rules
  - `app/src/main.ts`, to pass the `OsCity` from Task 10 into `createBrief`
- Create: `app/src/ui/brief.css`, with the Brief's own layout only and every value from `--os-*`

**Interfaces:**
- Consumes:
  - `dressPanel`, `createStream`, `osKey`/`weighKey`, `readoutRow`, `figure`, `rangefinder`, `tickStrip`, `segmentBar`, `typeIn`, `createPins` and `OsCity`
  - `EFFECT` (Task 14) and the words (Task 16)
- Produces: `BriefOptions.city?: OsCity`.

The screen, top to bottom:
- **The head** (the near pane): the day as `h1` with nothing over it, then the since readout in ice. Then `headFigures`: waiting, merged and spent, with waiting `hot` when above 0. Then two rangefinders, five-hour and seven-day, from `brief.usage`.
- **The lead, since and usage sentences** stay in the DOM as visually hidden text (`.os-sr`), for screen readers.
- **Each section** gets its head and its list.
- **Each row** has a designator: the target's number for an open waiting item, or a short hairline (round 1's fault 6). Then the meta (where, when), the headline (`h3`) and `itemReadouts`. A done audit gets the claims bar, and the autonomy ask gets the two agreement scales. The keys come from `actionNode`, dressed with `weighKey(node, weightOf(a), keySum(item, a) ?? undefined)`. The acted line, the error and the quiet line stay where they are.
- **The autonomy ask** is raised on its own shadow with red brackets, top and foot. It is the only red, filled object on the screen.
- **Why** unfolds as before. A run summary types in with `typeIn` when it arrives, through `summaryNodes` (text nodes), never as a string of HTML.
- **The pins:** targets are the open waiting items with a repo, numbered in list order. The figure is the first readout's `v` plus its `k`, and the tone is `toneOf`. The active item follows hover, then focus, then the first target. `show()` and `hide()` of the screen call the pins' `show()` and `hide()`.
- **The stream** is filled with `streamWords`.

- [ ] **Step 1: Update** `tools/ui-test-brief.ts` to the new words. "Posted as a job, " becomes `/^Posted \d{2}:\d{2}$/`, and likewise for the rest. Replace "never a row of buttons" with: every `.brief-act` has `data-weight`, and exactly one `[data-weight='grant']` is filled red per open ask. Keep the act-calls fixture check from Task 14. Run it on the old screen. Expected: FAIL on the words.
- [ ] **Step 2: Rebuild** the rendering in `brief.ts` and write `brief.css`. Remove the Brief's old rules from `screens.css` and `market.css`, so no Plex or Newsreader is left on the Brief.
- [ ] **Step 3: Run** `npm test`, `npm run typecheck`, then `npm run build && npm run ui-test` (GPU lock). Expected: PASS. The `(itemId, action, body)` sequence deep-equals `tools/fixtures/brief-act-calls.json`, and focus lands where it did.
- [ ] **Step 4: Round 1.** Take the GPU lock and run `tools/redesign-brief.ts stills`, which writes the seven stills including `brief-closed`; port the prototype's `brief-closed` step into the harness. Add a long-string fixture (Review Focus 5): a 600-character summary and a 240-character PR title containing `<b>` and `&amp;`, seeded into the scratch home. Take `brief-why-long.png` with Why open. Release the lock.
- [ ] **Step 5: Critique round 1** in critique.md under "Task 17". Judge against the spec's goals and anti-goals, CORANTO's bar, the stage 1 Review Focus lines and C's final stills. Name at least 5 weaknesses.
- [ ] **Step 6: Rounds 2 and 3.** Refine, re-shoot and critique. Stop after round 3 only if nothing is left at the anti-goal level; otherwise go on, up to 5 rounds.
- [ ] **Step 7: Commit** the code, the WebP stills and the critique, with the message "The Brief rebuilt on the screens layer".

### Task 18: The perf gate

**Files:**
- Modify: `docs/superpowers/plans/redesign-stage2-3/critique.md` (a "Perf gate" table)

- [ ] **Step 1:** Take the GPU lock. Run `REDESIGN_UNCAPPED=1 REDESIGN_HOME=<scratch> node --no-warnings --import tsx tools/redesign-brief.ts frames <out>`, first in a detached worktree of origin/main and then on this branch, in the same sitting.
- [ ] **Step 2: Check.**
  - Brief open is within 10% of main's median at both tiers.
  - City alone is within 3% of main's at both tiers. If not, run both again once; a second miss fails the gate.
  - Terminal open is within 10% of main's Brief-open row.
  - `PERF_TIERS=high,medium npm run perf` shows the home guard holding.
- [ ] **Step 3: If the Brief fails,** name what costs the frames before changing anything (superpowers:systematic-debugging). Use the debug handle's `trace` to look for a layout read after a write in the frame hook, a re-route every frame, or an animated shadow. Fix it in the owning os file and re-run the gate.
- [ ] **Step 4: Release** the lock. Write the table (tier, view, main, branch, delta) in critique.md and commit with the message "Perf gate: the Brief on the screens layer".

### Task 19: Connor's look, and a hard stop

**Files:**
- Create: `docs/superpowers/plans/redesign-stage2-3/review.html`, one self-contained page with relative image paths. It shows C's final stills beside the rebuilt Brief's seven stills plus `brief-why-long`, the six gallery stills, the top bar over Jobs, and the perf table. Each pair gets a two-line note on what changed from the prototype.

- [ ] **Step 1:** Build review.html and read it rendered to check it.
- [ ] **Step 2:** Send it to Connor with SendUserFile (status proactive). Ask with AskUserQuestion whether the Brief and the top bar are ready to merge, or which changes he wants.
- [ ] **Step 3: Stop.** Nothing merges to main, and Stage 4 does not start, until he answers. On his yes, merge `screens-os` into main with superpowers:finishing-a-development-branch, and delete the branch `redesign-brief-c` and its worktree.
