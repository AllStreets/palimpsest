# Phase 5: Polish and Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-11-14).** Revised after the plan check (`.superpowers/sdd/2026-11-14-phase-5-plan-check.md`, NOT READY: 3 Critical, 6 Important, 7 Minor). Every item is addressed; "Plan check fixes" at the end maps each to where it is fixed. Decision 13 (the licence) is added.

**Goal:** Bring every parked look up to his film bar and every parked minor to closed, make the city hold 60 fps at full window on both tiers with the home guard untouched, give Palimpsest a finished logo, a sample dataset anyone who clones it can open in one command, diagrams drawn from the code, a launch film, a README whose every claim has been checked against the code, and land it all on main after a phase final review.

**Architecture:** Two tracks run in parallel in separate worktrees with no shared file. The city track owns `app/src/city/**`, `app/src/main.ts`, the kits and textures, `tools/perf.ts` and `tools/ui-test.ts`; every look it changes is judged on named stills shot by `tools/perf.ts`, which also prints the frame rate and the draw budget for that view, so a look and its cost are measured in the same run. The screens and docs track owns `app/src/ui/**`, the engine, the shell, the brand, the sample, `tools/capture.ts`, the diagrams and the README text. A short Task 0 before the split freezes the measuring tools both tracks rely on. After both tracks merge, the launch tasks shoot every still and clip once from the sample, cut the film, place the diagrams, run the media budget and a gap pass of every README sentence against the code, check a clean clone on a temp home, and hand the branch to a phase final review; main moves only after that review and only once Phase 4 is on main.

**Tech Stack:** Node 22.13+, TypeScript, tsx, `node:test`, three.js 0.187 (WebGL2), Vite 8, Playwright (Chromium on the GPU), Tauri 2, Blender 4 (scripted, `docs/brand/*.py`, `tools/kits/*.py`), ffmpeg (`/opt/homebrew/bin/ffmpeg`, libx264, libsvtav1), `cwebp`, `img2webp`, `gh` (read only unless he says go).

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 5 in section 13; sections 1, 2 goal 10, 4, 5, 6.6, 15, 16 and 18 apply). The Phase 2 to Phase 4 plans fix the conventions, rulings and test safety rules this plan continues ("Phase n ruling m"). Their ledgers hold the parked lines this plan closes: `/Users/connorevans/Downloads/palimpsest-phase2/.superpowers/sdd/2026-11-10-phase-2-market/progress.md` and `phase-2-final-review.md` there, `.superpowers/sdd/2026-11-11-phase-3-analysis-and-brief/progress.md` and `phase-3-final-review.md`, `.superpowers/sdd/2026-11-12-phase-4-the-school/progress.md` and `final-review.md`, and `/Users/connorevans/Downloads/palimpsest/.superpowers/sdd/2026-11-09-phase-1-polish/progress.md`.

**Starting head.** Branch `phase-5` from `phase-4` at `306851d` plus this plan. Phase 4 is not on main: main waits for his merge of the Beagle PR, because the `beagle` dependency is a `git+file` pin to a bare copy in his checkout (`package.json`), which a fresh clone cannot install. Nothing in this plan needs Beagle to change. Task 0 runs on `phase-5`; then `phase-5-city` and `phase-5-screens` are cut from Task 0's commit in two worktrees.

**What was found (2026-11-14, read only):**
- `docs/media` holds 104 MB in 61 files. The heaviest are `rise.mp4` 15.2 MB, `flyover.mp4` 14.4 MB, `rise.gif` 7.3 MB, `flyover.gif` 7.2 MB, `rise.avif` 6.9 MB, `rise-card.webp` 6.4 MB, `flyover.avif` 5.7 MB, `flyover-card.webp` 5.4 MB, `week.mp4` 5.0 MB and `hero.png` 4.0 MB. `street.webp` and `people-follow.webp` are on disk but out of the README (Phase 2 ruling, ledger line 398).
- `app/public/textures` is 41 MB of 2K and 4K JPEGs; the largest are `metal_arm.jpg` 3.9 MB, `brick_nor.jpg` 3.7 MB and `pave_nor.jpg` 3.0 MB.
- The home budget at the Phase 4 city merge (`78b048b`) was 687 calls on high and 551 on medium, against the guard of 850 calls (strictly below) and 12M triangles with the shadow map redrawn (`tools/ui-test.ts:1490-1491`). The campus sub-guard is 15 calls and 900k triangles, school towers 4 calls.
- A logo exists: a Blender render of a P built in floors (`docs/brand/logo.py`, `docs/brand/logo.png`), the wordmark (`docs/brand/wordmark.py`), and an icon set copied into `src-tauri/icons/`. The Phase 1 plan called the icons a placeholder "until the Phase 5 logo". The UI has no favicon (`app/index.html:7` is `data:,`).
- The README has no diagram. Its "Where it stands" says Phase 5 is "a performance pass, and the README's diagrams", its shields row reads "phase 4", and its versions are `0.1.0` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- The sample is `tools/sample.ts` (with its economy flag it also writes the sample market and school), served by hand as three commands in the README's "Run it". `seedEconomy` has no sample-home guard of its own (Phase 2 Task 21 minor).
- The renderer is WebGL2 only and has no depth of field (spec 6.6 asks for WebGPU where available and depth of field for close-ups). The sun is fixed at dusk (`app/src/city/sky.ts:4`).
- Debug hooks are already behind `?debug` (`app/src/main.ts:619`), so the Phase 1 and Phase 2 minors about ungated `window.__palimpsest` hooks are closed. The window still opens with `window.maximize()?` and `window.show()?` (`src-tauri/src/main.rs:235-236`), the Phase 1 minor.
- At the Mac and outside this plan: Phase 2 Task 41, Phase 3 Task 20, Phase 4 Tasks 39 and 40 and Task 26 Step 4, the usage hook, `trainer:setup`, the base download and the Beagle PR.

## Decisions for Connor

Thirteen calls, one line each, with the recommendation the plan is written to. Until he answers, the recommendation holds, except where a task says it waits.

1. **The logo.** Three directions rendered on the real sizes (Dock 1024, Finder 128, menu 32, 16, the splash, the running head, the wordmark), one a refinement of today's P in floors; he picks or combines. Task 22 waits for his pick. Recommend yes.
2. **The film.** 70 to 90 seconds, silent (no licensed music), titles set in Newsreader on the dusk palette, at most 9.5 MB so it fits a GitHub attachment on any plan; he drags it into the README in GitHub's editor for inline play (only he can make that upload), and the repo copy is linked from a poster until he does. Recommend yes.
3. **Media weight.** Never rewrite history to shed old media (it is on the never list); from now on hold the budget in ruling 8, drop the GIF fallbacks and the unused `*-card` variants, and keep only what the README shows. Recommend yes.
4. **WebGPU (spec 6.6).** Stay on WebGL2 for v1: every custom shader would have to be rewritten in three's node language for a renderer the city does not need to hold 60 fps. Recorded as a deviation in the README and spec section 16. Recommend yes.
5. **Day and night (spec 6.6, "welcome if it holds the bar").** Dusk only for v1; the parked "clear-air daytime still" becomes a clear-air dusk still. Recommend yes.
6. **The colour re-measure (Phase 2 Task 22 ruling: "Phase 5 decides").** Re-measure `rendered.ts` and `ambient-rendered.ts` once, in Task 15, after the last task that changes a look or a texture (Tasks 6 to 14). It shifts the six pinned looks, his own towers included; he gets a before and after sheet of the six looks (sample towers only) before the merge. Recommend yes.
7. **Interiors (Phase 3 Decision 6 returns).** No interior room; the floor dossier on the ride stays the inside of a floor. Optional Task 16 runs only on his yes. Recommend no.
8. **The campus from home.** If a distance read alone cannot show the campus past the tower in front of it, the home framing may turn by at most 12 degrees (ruling 18). His opening view changes slightly. Recommend yes.
9. **Main.** Phase 5 lands on main only after Phase 4 does, which waits for his merge of the Beagle PR and the pin moving to `github:AllStreets/beagle#<merge sha>`. No vendoring. Recommend yes.
10. **The launch on GitHub.** Each only on his explicit OK at the end: push main; tag `v1.0.0` and a release with the film; `gh repo edit` for the description, topics and homepage; the social preview (a repo setting, uploaded by him in Settings); the profile clip on his profile README (another repo). Task 33 prepares the exact commands. Recommend he OKs each.
11. **Real runs before launch.** The launch README says plainly which real runs have happened. Recommend he does at least Phase 2 Task 41 and Phase 3 Task 20 before Task 29, so the README can give real numbers (never his repos' content); without them the README says they have not run.
12. **Version 1.0.0** in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` at Task 33. Recommend yes.
13. **The licence.** The repo has no LICENSE file, and a public launch needs one. Recommend MIT, the plainest for people who clone it to run and learn from; the alternative is all rights reserved with the source only to read. Task 25 adds `LICENSE` and a one-line "License" section with his answer; until he answers, Task 25 writes neither and Task 33 waits.

## Global Constraints

- Engine API on `127.0.0.1:4770` only, with the Host and Origin checks and `x-palimpsest: 1` on every write; UI dev server on `4771`. No task, test, tool or capture binds or calls 4770. Ports: on the city track ui-test 4779 and perf 4791 (`PERF_PORT`, Task 0); on the screens track ui-test 4781 (`UI_PORT`, `tools/ui-port.ts`) and capture 4788 (`CAPTURE_PORT`); after the merge capture and film share 4789 one after the other; sample 4790, diagrams 4792, the clean-clone check 4793.
- His data is never touched: no task reads or writes `~/Library/Application Support/Palimpsest`, `~/.claude`, `~/.claude.json`, his repos, his mirrors or his installed engine. Every tool runs on a temp or sample home (`isRealDataHome()` refuses). The installed engine is upgraded only after the phase final review, with his OK, by steps sent to him.
- Nothing touches GitHub without his explicit OK in the session: no push, tag, release, PR, label, `gh repo edit`, upload or write to any other repo. No task makes a read-only `gh` call either. `git` stays local.
- No download or network fetch of any kind without his OK, with one exception: the registry installs (`npm install` from registry.npmjs.org) inside Task 30's clean clone. Fetching `github:AllStreets/beagle` after the pin moves happens in Task 33 on his word. No CC0 texture, Blender add-on, Playwright browser, font, model or package is fetched by any other task; a task that finds it needs one stops and asks.
- The machine is shared by both tracks: frame-rate gates are measured only while the measuring task holds `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/gpu.lock` (written by the controller, holding the task number and start time); while it is held the other track runs only `npm test` and `npm run typecheck`, never a ui-test, capture, perf or Playwright run. Draw calls and triangles may be measured without the lock; fps may not.
- The home guard: under 850 draw calls (strictly) and at most 12M triangles from home with the shadow map redrawn, measured on both tiers (high and medium) by `homeBudget(page, tier)` (Task 0); never raised. The campus sub-guard (15 calls, 900k triangles), the school towers' 4 calls and the milestones' calls (`MILESTONE_CALLS`) hold on both tiers.
- Frame rate: at least 58 fps median (ruling 3) at every named perf view on both tiers at `PERF_VIEWPORT` (ruling 4). A city task may not lower any view by more than 3 fps or add more than 10 calls from home without naming why in its commit body and buying it back in the same task.
- No em dashes, double hyphens or emojis in UI copy, README, alt text, diagrams, the film's titles or commit text. No AI look (his rules: no tracked caps eyebrows, no identical cards, no glow, no badges, no decorative chart motifs, no monospace as decoration, no lede under every title, no single coloured word, no skeleton loaders). Sentence case, hairlines, real content. No AI image generation anywhere: every image is rendered by the app, by scripted Blender or by the diagrams tool.
- Every visible change: build, shoot the task's named stills at full size and zoomed crops, critique against the bar, iterate: three rounds for 3D and the logo, two for screens and diagrams. Rounds and what is still weak go in the commit body. Rounds live under `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/task-<n>-rounds/`, never in `docs/media`.
- `docs/media` is written only by Tasks 27 and 28 (and `docs/brand` by Tasks 21 and 22), from the sample only.
- 3D assets: own code and scripted Blender first, CC0 and CC-BY recorded in `CREDITS.md`, nothing paid.
- Fake life stays a failure: nothing added in this phase may show an agent, floor or event that is not in the ledger.
- Commit trailers on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UGpw98HC7NNMT1jveHzgfa`.

## Test safety rules (Phase 2 rules 1 to 10 and Phase 4 rules 11 to 16 hold; these are added)

17. No tool writes `docs/media` or `docs/brand` unless run by Task 21, 22, 27 or 28; `tools/capture.ts` and `tools/film.ts` default `CAPTURE_OUT` to a temp dir and write `docs/media` only with `CAPTURE_WRITE_MEDIA=1`.
18. No test or tool runs a `gh` write. `tools/launch.ts` (Task 33) prints the commands; it executes nothing.
19. The clean-clone check (Task 30) runs `npm install` under a `sandbox-exec` profile that denies every read of `/Users/connorevans/Downloads/palimpsest/.superpowers/beagle-local`, so the bare Beagle copy on this Mac is hidden exactly as it is from a stranger's Mac; nothing in his checkout is renamed or moved. It clones this branch from the local repo into the scratchpad, never from GitHub, with `PALIMPSEST_HOME`, `HOME`-free settings paths (`PALIMPSEST_CLAUDE_SETTINGS`, `PALIMPSEST_CLAUDE_PROJECTS`) and the sample all under that scratch dir, and deletes it after.
20. `npm run sample` refuses any folder that `isRealDataHome()` names or that exists, is not empty and has no sample marker.
21. A test that passes before its task is marked **(guard)** in the task and must pass before and after; every other new test in Step 1 must fail before the change, and Step 2 says so. A guard is never the only test of a task's change.

## Phase 5 rulings

1. **Branches and tracks.** `phase-5` from `306851d`; Task 0 on it; then `phase-5-city` (Tasks 1 to 16) and `phase-5-screens` (Tasks 17 to 25), each in its own worktree, both from Task 0's commit; Task 26 merges both into `phase-5`. Two agents at a time, one per track.
2. **File ownership.** The table under "File structure and ownership" is binding. A task that needs a file the other track owns stops and asks the controller. `test/*.test.ts` files belong to the track that owns the module they test; a new test file is named for its module.
3. **The measure.** `homeBudget(page, tier)` (Task 0) loads the sample economy at `SEED_AT`, flies home, redraws the shadow map and returns `{ calls, triangles, parts }` from `breakdown()`. `viewFps(page)` is the median of `requestAnimationFrame` frame rates over 3 s after a 1 s settle with the city clock running. Every city task runs `PERF_TIERS=high,medium npm run perf <dir>` (the `perf` script Task 0 adds runs `tools/perf.ts` through tsx's import hook, the invocation its own header gives; plain `node` cannot load it) before (round 0) and after, and records both tables in the commit body.
4. **Full window.** Task 0 reads his display read-only (`system_profiler SPDisplaysDataType -json`, the main display's "UI Looks like" size) and sets `PERF_VIEWPORT` in `tools/perf.ts` to the visible frame below the menu bar at DPR 2; if the read fails, `{ width: 1728, height: 1080, dpr: 2 }`.
5. **Named stills.** Each city task adds its views to `tools/perf.ts` (`views()`), by the names in its Step 0, and shoots them with `PERF_ONLY` through the same script. Round stills and crops go to the task's rounds folder (`r0` before, `r1` to `r3`). Crops are 800 by 500 at 100% from the full still, chosen by the critique.
6. **The critique.** Each round writes `critique.md` in its round folder: for each still, what reads as film and what reads as a game or as generated, against his named bar (CORANTO, WFR/AgentZeus, Bombechat, Chicago Open World, Foundry) and his no-AI-look list. A round ends only when every line is fixed or named as still weak.
7. **Before and after on unchanged views.** A city task that touches a shared material or shader also shoots `home`, `overview`, `hero` and `tower-close`, and its reviewer compares them with round 0; an unintended change is a fix-round item.
8. **Media budget** (Decision 3), enforced by `npm run media:check` (Task 24): every file in `docs/media` is referenced by `README.md` (a poster counts when its clip is linked); every reference exists; every `<img>` has alt text with no em dash, double hyphen or emoji; each still at most 450 KB; each inline animation at most 4 MB; each linked MP4 at most 9 MB; the film at most 9.5 MB; the README's inline payload (every `src` and `srcset` a reader's browser fetches on open, the larger of AVIF and fallback counted) at most 25 MB; `docs/media` in all at most 45 MB.
9. **The film** (Decision 2). `tools/film.ts` cuts 70 to 90 s at 1600 by 1000, 30 fps, H.264 `yuv420p` with `+faststart`, two-pass to at most 9.5 MB, silent. Every frame comes from the capture tool's frame-stepped pipeline on the sample. Order: the city at dusk (hero rise), a job becomes a floor (construction), the ride with its dossier, the commute, the brief and the README audit (screens, 4 s each), the school (voyage, observatory), the week tour, and the close on the skyline. Title cards: Newsreader 40 px on the dusk ink, sentence case, one line, 2 s each with 0.5 s fades, no motion graphics. Poster `film-poster.webp` at most 450 KB.
10. **The profile clip.** `tools/film.ts` also cuts a 10 to 12 s seamless loop of the city (the flyover's arc) at 800 by 500: `profile.avif` at most 3 MB and `profile.webp` at most 4 MB, with the HTML snippet for his profile README written beside it in `docs/media/profile.md`.
11. **Diagrams.** Four, drawn by `tools/diagrams.ts` as HTML and SVG in Newsreader and IBM Plex Sans on the app's paper and ink, hairline rules, sentence case, no shadows, no icons, no glow, no boxes for their own sake; rendered by Playwright at 1600 wide, DPR 2, to `docs/media/diagram-<name>-light.webp` and `-dark.webp`, each at most 300 KB, used through `<picture>` with `prefers-color-scheme`. Names: `machine` (what runs where: the app, the engine as a launchd agent on 4770, SQLite and the ledger, the mirrors, `gh`, the `claude` CLI, Ollama on 11434, the trainer subprocess, `mlx_lm.server`), `floor` (how a job becomes a floor: job states, bidding, award, run stages, inspection checks, PR or push, floor states), `sandbox` (the guard, the two `sandbox-exec` profiles, the egress proxy per stage, the command broker, the never list), `school` (the ledger to rows to nets to the master, predictions before his decisions, agreement, asks and grants; arenas to voyages and LoRA to sealed races to graduates). Every label comes from a runtime list in `tools/diagrams/data.ts` that is checked against the code's types and constants (Task 23).
12. **The logo** (Decision 1). Rendered only by scripted Blender from `docs/brand/*.py` with the app's own scanned textures; three directions on one contact sheet `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/logo-directions.png` at the real sizes; no change to any shipped icon until he picks.
13. **The sample dataset.** `npm run sample` runs `tools/sample-run.ts`: target `PALIMPSEST_SAMPLE_HOME` or `<repo>/sample-home` (gitignored); refuses per test safety rule 20; seeds the city, the economy and the school at `SEED_AT` unless `SAMPLE_NOW=1`; serves it on 4790 with `PALIMPSEST_SAMPLE_ECONOMY=live`; prints `The sample city is at http://127.0.0.1:4790` and nothing else; Ctrl+C stops it. `seedEconomy` and `seedSchool` throw "Not a sample home" on any home without the marker.
14. **Spec deviations** (Decisions 4 and 5) are written into spec section 16 as one line each and into the README's "Where it stands" (Task 25).
15. **Main** (Decision 9). Task 33 runs only after Task 31's verdict, Task 32's fixes and Phase 4's merge to main. Locally it merges `phase-5` into `main`; the push, tag, release and repo settings wait for his OK.
16. **Close-up depth of field** (spec 6.6). On high only, in four close modes: the ride, follow, a tour stop and the inspector's close tower view, with the focus at the subject's distance; off from home, the overview and any view farther than 160 m from its target; off on medium. One bokeh pass at half resolution.
17. **The street stills.** `street` and `people-follow` return to the README only if Tasks 1 to 3 end with both stills named "film, not game" in the last critique and the controller agrees on viewing them; otherwise they stay out and the README does not mention them.
18. **The campus from home** (Decision 8). In order: (a) a distance read that moves nothing: the clock tower's lantern and the library's lit gable carried above the roofline at their real heights; (b) only if (a) leaves less than 1.5% of the campus's projected area visible from home (`visibleShare('campus')`, an ID pass, Task 10), the home framing's yaw turns by at most 12 degrees, with the tallest tower uncropped, every district in frame and every guard holding. Never a plot moved.
19. **The hardlink escape** (Phase 4 Task 7, disclosed). Task 19 proves on this Mac whether a profile rule can stop a sandboxed process hard-linking a file it may read into a folder it may write. Keep the first rule the escape test proves; if none does, the disclosure stays and the README says so in the same words.
20. **Parked to after a real audit.** Phase 3 final review Minors 6 (a capped audit keeps nothing), 7 (a declared check that writes) and 11 (proposal keys follow wording) wait for Phase 3 Task 20's real audit, as that review ruled; the README keeps its softened sentence.
21. **Verify before fixing.** Every sweep task (17, 18) starts by checking each listed line against `HEAD` and records it as `closed at <file:line or commit>` or `open`; only open lines are fixed, each with a failing test first.
22. **No local dependencies at launch** (plan check C1). `tools/install-check.ts` (`npm run install:check`, Task 24) fails when any dependency in `package.json` or any `resolved` or `version` in `package-lock.json` begins with `file:` or `git+file:`, naming each. It fails today by design (the Beagle pin), so it is not part of `npm test` until Task 33 moves the pin and adds it there as `test/clean-install.test.ts`. Task 30 runs it; Task 33 refuses to merge or print any launch command while it fails.
23. **The sample marker** (plan check C2). `seedSample()` itself writes the sample marker (`SAMPLE_MARKER`, `sample.json`) before it writes anything else, so every caller (`tools/perf.ts`, `tools/ui-test.ts`, `tools/capture.ts`, the tests) is marked without editing them; the guard in `seedEconomy` and `seedSchool` lands in the same commit as the marker.

## Parked items and where each lands

Nothing parked in Phases 1 to 4 is left without a home. "Verify" means Step 0 of that task confirms it closed.

| Parked item | Source | Task |
|:-|:-|:-|
| Street-level realism: kerbs, gutters, worn asphalt, wet patches, pavement tile scale, plain lamp poles | P2 final review I2, P2 ledger 398 | 1 |
| Window interiors behind dark windows; corner window stretch on chamfered and rounded corners; the oriel body | P2 I2, AF, AUD-C | 2 |
| Walkers out of step; near-field figures; face skin texture; sitting figures close | P2 I2, AUD-C, FIG, ledger 327 | 3 |
| Restore the `street` and `people-follow` stills | P2 ledger 398 | 27, 29 (ruling 17) |
| Persona cabs at signals; pier height and signal waits; the tram barely reads from home; train corner overhang on the viaduct radius | P2 T30, T32, T34 | 4 |
| Ferry wake crests dash close; the windscreen's hard bulkhead plate; LOD cross-fade capture at 400 m; uniform pod interior; the ride car's lamp bloom | P2 T30, T31; owner list | 5 |
| Overview haze washes the city peach-pink; sun bloom blows out the upper right in low views; fog measured from the new home before the eased home; the 120-floor city hazed less (taste) | P2 audit, P3 Minor 14, P1 Task C | 6 |
| The `rendered.ts` and `ambient-rendered.ts` re-measure; tables go stale silently; contrast tests read declared swatches; pins cover look ids not parameters; the glass "material alone" test; `standingLots` retones neighbours | P2 T22 ruling, P1 Tasks B and D | 15 (Decision 6; after the last look change) |
| A clear-air daytime still | P2 T42 | 6 (Decision 5: clear-air dusk) |
| Stone coursing past 600 m; ceramic in sun; sci-fi crowns small at hero distance; Gothic and pagoda linework hidden by size; cluster pods and the arcology pavilion as boxes; hero glint and variety; granite split window; the corner under `SEPARATION`; the city-wide reuse key and a removed repo freeing a variant | AF, P2 audit, PERF, P1 Task B | 7 |
| Construction glow from home; uniform near beams; searchlight glint on very tall glass; close glazed floors bright under the beam; the dark tower as an unlit block; campanile atop a small new district | P2 T25 to T28 | 8 |
| Spire lenses sub-pixel and heavy collars; revival bulbs light nothing, with its four carried minors; the ribbon's dark side and brown copper; the tour's hot roof line | P3 final review section 5, P3 ledger 101 | 8 |
| Stylised trees; sun-facing foliage greys from above | P2 T28, P4 ledger 86 | 9 |
| Reader silhouettes; lamp-head glow shape; slit lining tone; turf at dusk; louvres small at 60 m; the campus hidden behind the harbor-ledger tower from home | P4 ledger 6, 86, 118, 147 | 10 |
| H flies home with the inspector open; `T` on Monday walks the current week | P1 Task C, P3 Minor 15 | 11 |
| Per-cluster batch culling for close views; the quarters' 4.0M uncullable triangles | P4 ledger 95, P2 PERF | 12 |
| The floor-landing re-merge hitch; a freed plot refills in one frame; quarter rebatches in hire bursts; `setClock` clones matrices each minute | P4 ledger 95, P1 Task A, P2 T24, T25 | 13 |
| Texture weight (41 MB; the 6.3 MB ironspot set); the `sand_*` credit row no longer covering limestone, granite and Gothic roots | P1 Task B | 14 |
| Roof-kit AO gone from 640 to 1250 m; LOD pop at 450 m; far towers shadowless at wide home (`SHADOW_HALF 320`); the live-sites calls flake (P2 M5) | P2 PERF, P1 Task C, P2 final review | 15 |
| Media weight | P2 ledger 390 | 24, 27 |
| Credits explanation tooltip only; "3 jobs" over one grouped row; the board's source explainer; find-in-page misses emptied diff rows; HIDDEN misses invisible code points; ages refresh only on events; the sample round closing while bids climb; `bid.placed` against the current round; the governor notice's frame rate; Dismiss on joined notices; notices losing contrast, ellipsised, in the running head; "audited on your word"; the cost-head bias disclosure; the repos page's done-hold and toggle-after-disconnect | P2 T22, T36, T37; P3 section 5, Minor 9; P4 ledger 37; P1 Task A | 17 |
| Engine minors: credit rounding, `modelFamily`, `eraForScore` NaN, overclaim, the transaction test, `foundingFloors` default, duplicate slots, post-exit window, `maxMs`, outliving members, TLS fronting record, layout checks, the self-charging API row, signal in `createRunDir`, cached refused checks, lockfile-less npm, the inherited env in `syncMirror`, sample folder overrides, `unattended` hours, stale `pushWhy`, unredacted 500s (M1), the baseline joiner abort (M3), empty backfilled reports (M6), egress per run in the guardrails doc (M7), harness re-proposal (M8, verify), the gate cache minors, Understudy's immutable fallback, the stopped connect still analysing, the window's `maximize()?`, the load-sensitive tests | P1 Task A; P2 ledger and final review; P4 ledger 25, 51, 80, 125, 143, 186 | 18 |
| The hardlink escape | P4 ledger 29, P4 final review README item 5 | 19 |
| The sample's plan template reads machine-made (verify); `seedEconomy` without its own guard | P3 Minor 8, P2 T21 | 20 |
| The logo and app icon (placeholder since Phase 1) | P1 plan, spec 2 goal 10 | 21, 22 |
| District-audit and job-scope stills; the `audit` clip; hero and overview with the spire; revival shot closer; week and dossier stills framed off the sun | P3 ledger 116, P3 Minor 14 | 24, 27 |
| A capped audit keeps nothing; a check that writes; proposal keys by wording | P3 Minors 6, 7, 11 | parked (ruling 20) |
| Interiors | P3 Decision 6 | Decision 7, optional 16 |
| Real runs (P2 T41, P3 T20, P4 T39, T40, T26 Step 4) | ledgers | at the Mac (Decision 11) |

## Review Focus

1. Someone clones it on a Mac with only Node: `npm install`, `npm test` and `npm run sample` work with no `gh` login, no Claude, no Ollama, no Python and no Rust; the sample city opens on 4790; nothing is written outside the clone and its sample folder. (Tasks 20 and 30.)
2. `npm run sample` pointed at his real home, at `~/Documents`, or at a folder with files and no marker: it refuses in one sentence and writes nothing. (Task 20.)
3. The medium tier, or the governor stepping down mid-ride with depth of field and street detail on: every close view keeps 58 fps, nothing a README still shows exists only on high without the caption saying so. (Tasks 11 and 15.)
4. A README sentence, number or alt text that no longer matches the code or the still above it (a view re-shot from another angle, a count changed by a fix): the gap pass and `media:check` catch it before the review. (Tasks 27 and 29.)
5. A floor lands, three hires arrive, a firm goes bankrupt and a repo disconnects while the ride is running: no frame over 33 ms, no stale batch, every disposed mesh counted. (Task 13.)

## File structure and ownership

| Owner | Files |
|:-|:-|
| Task 0 only, then city | `tools/ui-test.ts`, `tools/perf.ts`, `app/src/main.ts` |
| City track | `app/src/city/**`, `app/public/kits/**`, `app/public/textures/**`, `tools/kits/**`, `shared/tower-layout.ts`, `shared/ride.ts`, `shared/tour.ts`, `shared/commute.ts`, `shared/district-layout.ts`, `shared/silhouette.ts`, `CREDITS.md` (until Task 26), city tests (`test/{ambient,aniso-patch,campus,collar,construction,city-milestones,exchange,figures,governor,kits,kit-fallback,lod,lots,masonry-shader,measured,occupancy,people,plain-batch,quarters,ride,river,river-lod,school-towers,shopfronts,silhouette-build,tour,tour-camera,tower-build,tower-variants,transit-signs,vehicle-kits,vehicles,view}.test.ts` and new `test/{street,facade,trees,post,batch,textures}.test.ts`) |
| Screens and docs track | `app/src/ui/**`, `app/src/api.ts`, `app/src/router.ts`, `app/index.html`, `app/public/brand/**` (new), `engine/**`, `shared/types.ts`, `shared/market-rules.ts`, `shared/school-rules.ts`, `shared/ledger-kinds.ts`, `src-tauri/**`, `bin/**`, `docs/brand/**`, `docs/SELF_RECURSION_GUARDRAILS.md`, `docs/superpowers/specs/**`, `tools/capture.ts`, `tools/sample.ts`, `tools/sample-run.ts` (new), `tools/diagrams.ts` and `tools/diagrams/**` (new), `tools/film.ts` (new), `tools/media-check.ts` (new), `tools/launch.ts` (new), `tools/ui-test-{audit,brief,detail,firms,jobs,market,notices,school,treasury,screens}.ts`, `package.json`, `.gitignore`, `README.md`, every other test file |
| Launch tasks (26 to 33, one at a time) | anything, plus `docs/media/**` |

Pre-flight conflicts: `tools/ui-test.ts` held the splash, settings, repos and every-screen checks; Task 0 moves them unchanged into `tools/ui-test-screens.ts` so the screens track never edits `ui-test.ts`. The city track needs no `package.json` change; a task that finds it needs a dependency stops and asks. `CREDITS.md` new rows from the screens track (none expected) wait for Task 26.

Known orderings: Task 0 first. City track in order 1 to 15 (16 only on his yes); Tasks 12 to 15 come after the visual tasks so the perf pass measures the finished city. Screens track: 17 to 20 in any order, 21 before 22 with his pick between them, 23 and 24 any time, 25 last. Task 26 after both tracks; 27 to 33 in order.

## Model marks

**[Fable]** for the visual-critical builders (Tasks 1, 2, 3, 6, 7, 9, 21, 22) and the phase final review (Task 31); **[Opus]** for the rest of the builds; **[Sonnet]** for Tasks 30 and 33 and for scoped re-reviews. Reviews of visual work go to Opus with the round stills. If Fable is out, Opus builds and the controller adds a round.

## Part A: before the split

### Task 0: The measuring tools both tracks rely on [Opus] [both]

**Files:**
- Modify: `tools/ui-test.ts` (export `homeBudget(page, tier)`; move `splashChecks`, `settingsChecks`, `reposChecks`, `freedPlotChecks`, `everyScreenChecks` unchanged into the new file and call them from `main()`), `tools/perf.ts` (`PERF_VIEWPORT`, `PERF_TIERS`, `PERF_PORT` replacing the fixed `PORT = 4791` with that default, `viewFps`, `homeBudget` per tier into `perf.json`), `app/src/main.ts` (debug handle: `frameLog`), `package.json` (a `perf` script running `tools/perf.ts` through tsx, as the `ui-test` script runs `tools/ui-test.ts`; the only `package.json` edit before the split)
- Create: `tools/ui-test-screens.ts`
- Test: `tools/ui-test.ts` (whole run), `test/governor.test.ts` (pin for `frameLog` math)

**Interfaces:**
- Produces: `homeBudget(page: Page, tier: 'high' | 'medium'): Promise<{ calls: number; triangles: number; parts: Record<string, { calls: number; triangles: number }> }>` exported from `tools/ui-test.ts`; `viewFps(page: Page): Promise<number>` in `tools/perf.ts` (ruling 3); `PERF_VIEWPORT: { width: number; height: number; dpr: number }`; `perf.json` shape `{ viewport, tiers: { high: { home: Budget; views: Record<string, { fps: number; calls: number; triangles: number }> }, medium: … } }`; debug `frameLog: { start(): void; stop(): number[] }` returning frame times in ms; `frameStats(ms: number[]): { max: number; p99: number; over33: number }` in `app/src/city/governor.ts`.
- [ ] **Step 0:** Read the display size (ruling 4) and record it. Run `npm test`, `npm run ui-test` and `PERF_TIERS=high,medium npm run perf .superpowers/sdd/2026-11-14-phase-5-polish-and-launch/baseline` at `306851d` with only the `perf` script added; record home calls and triangles on both tiers and the fps of every existing view in `baseline/perf.json` and the ledger. Confirm `?debug` gates the debug handle (`main.ts:619`) for the Phase 1 and 2 minors.
- [ ] **Step 1: Write the failing tests:** `frameStats counts frames over 33 ms and the 99th percentile`; `perf.ts listens on PERF_PORT`; UI: `homeBudget answers for high and for medium with the shadow map redrawn`; guard: `the splash, settings, repos and every-screen checks run from ui-test-screens.ts with the same results` **(guard)**.
- [ ] **Step 2:** Run; expect FAIL on the new names; the guard passes.
- [ ] **Step 3:** Implement. Moving the checks changes no assertion.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck` and `npm run ui-test`; expect the same check count as Step 0 plus the new ones, all passing.
- [ ] **Step 5:** Commit `Measure the city the same way on both tiers and both tracks before Phase 5 splits`. Cut `phase-5-city` and `phase-5-screens` from it.

## Part B: the city track

Every task in this part: Step 0 shoots its named stills at round 0 and records `homeBudget` on both tiers and `viewFps` at every named view; Step 4 re-measures both and holds the home guard, the sub-guards and the frame rate rule (Global Constraints); the quality rounds follow rulings 5 to 7. Every home-guard, sub-guard and frame-rate test in a city task is a **(guard)** (test safety rule 21); Step 2's expected failures are the task's other new tests. fps is measured only under the GPU lock (Global Constraints). The stills named in each task are new `tools/perf.ts` views unless they already exist there or in `tools/capture.ts` (then the same eye and target are copied).

### Task 1: The street floor: kerbs, gutters and worn asphalt [Fable] [city]

**Files:**
- Modify: `app/src/city/ground.ts`, `app/src/city/grid.ts`, `app/src/city/materials.ts`, `tools/perf.ts` (views)
- Create: `app/src/city/street.ts` (the kerb, gutter and asphalt pieces and the wear shader chunk)
- Test: `test/street.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `KERB = { height: 0.15, width: 0.3, gutter: 0.45 }` (metres); `streetSurface(quality): { kerbs: THREE.InstancedMesh; asphalt: THREE.Material }` with wear driven by world position (tyre tracks along lanes, patch repairs, oil darkening at stops and cab ranks, wet patches in gutters and low spots catching the sky), kerbs instanced along every street edge with dropped kerbs at crossings; lamp poles from the kit with a base, a shaft taper and a head, not plain black cylinders.
- [ ] **Step 0:** Stills `street` (copied from capture), `street-kerb` (eye 1.6 m at a kerb looking down a street at dusk), `street-gutter-close` (eye 0.9 m over a gutter with a wet patch), `street-junction` (a crossing with dropped kerbs and a lane line), `street-above` (60 m above a junction). Record what reads as a game in each.
- [ ] **Step 1: Write the failing tests:** `every street edge has a kerb 0.15 m high and a gutter 0.45 m wide`; `crossings drop the kerb to road level`; `wear is deterministic by world position`; `kerbs draw in one instanced call per tier`; UI: `the kerb shows a lit edge in street-kerb` (pixel contrast across the kerb line above a set floor), `home stays under 850 calls and 12M on both tiers` **(guard)**.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement. No new texture files: the wear uses the existing CC0 asphalt and pave sets with world-space breakup.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three) on the five stills plus ruling 7's four. Commit `Give the streets kerbs, gutters and asphalt that has been driven on`.

### Task 2: Facades at street level: rooms behind the glass, true corners and the oriel [Fable] [city]

**Files:**
- Modify: `app/src/city/facade.ts`, `app/src/city/shopfronts.ts`, `app/src/city/ambient.ts`, `tools/perf.ts`
- Test: `test/facade.test.ts` (new), `test/shopfronts.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: dark windows show a room by interior mapping (back wall, floor, ceiling, one of eight furniture cards chosen by a hash of the window, lit or unlit by `occupancy`), never a black void; windows on chamfered and rounded corners are mapped by arc length round the corner, so they keep their width (`cornerU(x, z, corner): number`); the oriel gains a body: corbels, a panelled apron, side lights and a lead roof, from the kit.
- [ ] **Step 0:** Stills `street-windows` (ground to fourth floor, 12 m away), `corner-chamfer` (a chamfered ambient corner at 30 m), `corner-round`, `oriel-close`, `shop-close` (from capture). List every pure black window and stretched corner.
- [ ] **Step 1: Write the failing tests:** `cornerU keeps window width within 5% round a chamfer and a quarter round`; `the same window always shows the same room`; `a lit room's furniture card is visible and an unlit one is dim but not black` (shader uniform test); UI: `no window in street-windows reads below luminance 0.02 over more than 2% of its area`; guards.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement. The rooms are one shader path in the existing facade material, so they add no draw calls.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Put rooms behind the city's windows, keep them true round corners, and finish the oriel`.

### Task 3: People up close [Fable] [city]

**Files:**
- Modify: `tools/kits/figures.py`, `app/public/kits/figures.glb`, `app/public/kits/figures-skin.webp` (new), `app/src/city/figures.ts`, `app/src/city/people.ts`, `tools/perf.ts`
- Test: `test/figures.test.ts`, `test/people.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: faces with a skin texture baked in Blender (pores and tone breakup at the close level only, four skin tones, no uncanny gloss), hair as shaped cards, hands with fingers at the close level; the skin lives in its own atlas, `app/public/kits/figures-skin.webp` (1024 by 1024, four tones in quadrants, loaded only when the close level is first drawn), under `FIGURES_SKIN_BUDGET = 262_144` bytes, and the fingers and hair cards fit `figures.glb`'s 420 KB by quantising the crowd level's positions and normals (`KHR_mesh_quantization` written by the Blender script; three's GLTFLoader reads it with no new dependency); `phaseOf(id: string): number` giving each walker its own stride phase and a speed spread of plus or minus 12%; seated figures that bend at hip and knee on benches and in vehicles; `FIGURES_BUDGET` stays 420,000 bytes.
- [ ] **Step 0:** Stills `people-follow`, `people-close`, `people-platform`, `people-seated` (all from capture), `face-close` (a persona at 1.8 m).
- [ ] **Step 1: Write the failing tests:** `two walkers side by side are out of phase`; `stride phase is stable per id across reloads`; `figures.glb stays within 420 KB` **(guard)**; `figures-skin.webp stays within FIGURES_SKIN_BUDGET`; `the skin atlas is not fetched until a close figure is drawn`; `a seated figure's hip sits on the seat`; UI: `people-follow holds 58 fps on both tiers` **(guard)**.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement in the Blender kit script; the near and crowd levels share the skeleton as today.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Ruling 17's judgement of `street` and `people-follow` happens in the last round of this task, with Tasks 1 and 2 in. Commit `Give the city's people faces, hands and their own pace`.

### Task 4: Traffic that keeps to the street [Opus] [city]

**Files:**
- Modify: `app/src/city/vehicles.ts`, `app/src/city/transit.ts`, `app/src/city/lines.ts`, `app/src/city/people.ts` (persona cab legs), `tools/perf.ts`
- Test: `test/vehicles.test.ts`, `test/people.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: persona cabs and ambient traffic share one signal state per junction (`signalAt(junction, t): 'go' | 'stop'`) and queue behind each other; walkers wait at the kerb on red; the tram reads from home by its lit saloon windows and its headlamp (real emitters under the bloom threshold); the train keeps inside the viaduct on its curves (`VIADUCT_MIN_RADIUS` the smallest curve the rail cars clear with their bogie spacing); piers stand on the riverbed, not above or below it.
- [ ] **Step 0:** Stills `junction-signal` (a persona cab stopped at red with ambient cars behind), `tram-home` (home view crop on the tram line), `viaduct-corner`, `pier-foot`.
- [ ] **Step 1: Write the failing tests:** `a persona cab stops at a red signal and leaves on green`; `no vehicle enters a junction on stop`; `walkers do not cross on go for traffic`; `no train car body leaves the viaduct deck on any curve`; `every pier foot is within 0.2 m of the riverbed`; UI: `the tram's windows read in tram-home` (lit pixels along the line above a floor).
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Make every cab, car and walker keep to the signals, and let the tram be seen from home`.

### Task 5: Vehicles up close and the ride car [Opus] [city]

**Files:**
- Modify: `app/src/city/river.ts` (wake), `app/src/city/vehicles.ts`, `tools/kits/kits.py` (windscreen, pod interior), `app/public/kits/*.glb`, `app/src/city/ride.ts`, `app/src/city/post.ts` (only the ride car's emitters), `tools/perf.ts`
- Test: `test/river.test.ts`, `test/vehicle-kits.test.ts`, `test/ride.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: a continuous ferry wake (crests as a smooth V that decays with distance, no dashes) in the water shader; the train and tram windscreens with a framed glass, wipers and a soft bulkhead edge; pod interiors with two seat colourways and a lit ceiling strip that varies per pod; the vehicle LOD cross-fade centred on 400 m with no pop; the ride car's lamps lit under the bloom threshold with a small warm halo (no blown flare on its glass).
- [ ] **Step 0:** Stills `ferry-wake` and `pod-interior` (from capture), `train-windscreen`, `lod-400` (a vehicle crossing 400 m, three frames 0.5 s apart), `ride-car` (the lift car mid climb at 20 m).
- [ ] **Step 1: Write the failing tests:** `the wake height along its arm has no gap longer than 0.5 m`; `two pods side by side differ in seats or strip`; `the cross-fade keeps summed opacity within 0.95 to 1.05 across 380 to 420 m`; `the ride car's lamp colours stay under BLOOM_THRESHOLD`; UI: `lod-400 frames differ by under 2% in mean luminance`.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Finish the ferries, trains, pods and the ride car for a close look`.

### Task 6: Haze and the sun [Fable] [city]

**Files:**
- Modify: `app/src/city/sky.ts`, `app/src/city/post.ts`, `app/src/city/camera.ts` (fog from the eased home), `app/src/city/lots.ts`, `tools/perf.ts`
- Test: `test/lots.test.ts`, `test/post.test.ts` (new), `tools/ui-test.ts`

**Interfaces:**
- Produces: the overview haze graded by height and distance so towers keep their own hue (the city reads as stone, brick, glass and copper, not one peach); the sun disc's bloom contribution clamped (`SUN_BLOOM_MAX`) so a low view toward the sun keeps its upper right; fog measured from the eased home target; `standingLots` retones no neighbour when one tower's look changes. The colour tables are not re-measured here (Task 15 does it once, after Task 14).
- [ ] **Step 0:** Stills `home`, `overview`, `hero`, `sun-low` (the week-poster framing toward the sun), `ride-dossier-view`, `overview-clear` (the clear-air dusk still, Decision 5: haze at 40% of the home value); the six pinned looks as `look-<id>` close stills (round 0 of Decision 6's sheet, which Task 15 completes).
- [ ] **Step 1: Write the failing tests:** `a look change retones only its own lot`; `the sun's bloom stays under SUN_BLOOM_MAX at any view`; `fog is measured from the eased home`; UI: `in overview the hue spread across the six towers is at least 0.08 in OKLab a and b` (median per tower).
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Grade the haze so the city keeps its colours, and keep the sun out of the bloom`.

### Task 7: Far architecture [Fable] [city]

**Files:**
- Modify: `app/src/city/tower/{look,eras,crowns,roots,variants,aniso-patch}.ts`, `app/src/city/masonry` (only through the tower path), `app/src/city/quarters.ts` (cluster pods), `app/src/city/exchange.ts` (the arcology pavilion), `tools/perf.ts`
- Test: `test/tower-build.test.ts`, `test/tower-variants.test.ts`, `test/silhouette-build.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: stone coursing that reads to 1,200 m (coursing carried into the far LOD as a mip-aware line term); ceramic that stays cool in direct sun (a measured specular and a lower albedo in the warm band); sci-fi crowns sized to read at hero distance (at least 14 px tall in `hero`); Gothic and pagoda linework carried by silhouette at distance (pinnacles and eaves as geometry above `HIDE_PX`); cluster pods with ribs, glazing and a lit band; the arcology pavilion with a structure the light breaks across; a glint and look variety back in `hero`; the variant reuse key per district, so a removed repo frees nothing city-wide; the granite split window and the sample corner under `SEPARATION` fixed.
- [ ] **Step 0:** Stills `coursing-700`, `coursing-1100`, `ceramic-sun`, `scifi-crown-hero`, `gothic-far`, `pagoda-far`, `cluster-pods`, `arcology-pavilion`, `hero`.
- [ ] **Step 1: Write the failing tests:** `a variant freed by a removed repo is reused only in its own district`; `the sample corner keeps SEPARATION`; `crowns of the sci-fi family are at least the hero minimum height`; UI: `coursing lines are resolvable in coursing-1100` (an FFT or line-contrast measure along the facade above a floor), guards.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement. Geometry added for distance is merged into existing batches (no new calls from home).
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Keep stone, ceramic, crowns and the old roots readable across the city`.

### Task 8: The market and the milestones from home [Opus] [city]

**Files:**
- Modify: `app/src/city/construction.ts`, `app/src/city/searchlight.ts`, `app/src/city/milestones.ts`, `app/src/city/scaffold.ts`, `app/src/city/ribbon.ts`, `app/src/city/tour.ts`, `app/src/city/exchange.ts` (campanile rule), `app/src/city/lightsout.ts` (dark towers), `tools/perf.ts`
- Test: `test/construction.test.ts`, `test/city-milestones.test.ts`, `test/exchange.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: a lit site reads from home (a warm work-light haze at least 6 px across and sparks visible as a flicker at 1,500 m); near beams vary (weathering and primer patches by hash); the searchlight glint scales with tower height so a 376 m glass tower catches it from home; glazed floors under the beam capped below white; a dark tower reads as a dead building (a few emergency exit lights, no lit windows, darker glass, a cold crown) rather than a block; spire lenses carried to 2 px at distance and lighter joint collars; revival bulbs that light the scaffold boards (one baked light term per string, no point lights), plus the four carried revival tests (non-top floor, floor 0, dispose, precomputed flicker hashes, clamped lower-stage lifts); the ribbon lit on its shaded side by sky fill, copper firms read copper, and a 2 px read from home; the tour stop's roof line under the bloom threshold; the campanile only on a district whose tower is at least the campanile's height plus 20 m.
- [ ] **Step 0:** Stills `construction-home`, `beams-near`, `glint-tall`, `glazed-beam-close`, `dark-tower-home`, `spire-lenses`, `revival-close`, `ribbon-shade`, `tour-stop-roof`.
- [ ] **Step 1: Write the failing tests:** the five revival tests above; `the campanile skips a small new district`; `glint strength grows with tower height`; `a dark tower shows no lit window`; UI: `construction-home shows the site's haze above a pixel floor`, `ribbon-shade's dark side is above luminance 0.05`, guards and `MILESTONE_CALLS` on both tiers **(guard)**.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Let the market's work, its dark towers and his milestones read from home`.

### Task 9: Trees and foliage [Fable] [city]

**Files:**
- Modify: `tools/kits/kits.py` (tree kit), `app/public/kits/*.glb`, the tree builders in `app/src/city/grid.ts`, `app/src/city/quarters.ts`, `app/src/city/campus/site.ts`, `tools/perf.ts`
- Create: `app/src/city/trees.ts` (one shared tree system for streets, quarters and the campus)
- Test: `test/trees.test.ts` (new), `tools/ui-test.ts`

**Interfaces:**
- Produces: `createTrees(quality): { place(spots: TreeSpot[]): void; update(clock): void }` with three species (plane, linden, a columnar hornbeam), each with a trunk, branch structure and leaf cards with translucency, wind sway under 0.05 m, and per tree hue and size spread; leaves lit by a capped sun term so a sun-facing crown stays green from above (`LEAF_SUN_MAX`); one instanced draw per species and level.
- [ ] **Step 0:** Stills `trees-street`, `trees-from-above` (80 m up, sun side), `quarter-court` (from capture), `campus-quad`.
- [ ] **Step 1: Write the failing tests:** `three species, one draw each per level`; `a tree's look is stable by its spot`; `the sun term stays under LEAF_SUN_MAX`; UI: `trees-from-above crowns keep saturation above 0.15 on the sun side`; guards, campus sub-guard **(guard)**.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement; retire the old per-place tree builders.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Plant real trees in the streets, the quarters and the quads`.

### Task 10: The campus, finished [Opus] [city]

**Files:**
- Modify: `app/src/city/campus/{life,observatory,site,library,clock,halls}.ts`, `app/src/city/view.ts` (only under ruling 18 (b)), `tools/perf.ts`
- Test: `test/campus.test.ts`, `test/view.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: readers in the bays with shoulders, heads and arms on the desk at three poses (one instanced draw); lamp heads with a round glass shade and a soft round glow; the observatory slit lined in a warm grey plaster under amber light rather than orange; turf with blade breakup and a dusk tone that is not flat; louvres sized and lit so they read at 60 m; `visibleShare(key: 'campus'): number` on the debug handle (an ID pass of the campus against the city from home); ruling 18's fix.
- [ ] **Step 0:** Stills `campus-home`, `campus-bays`, `campus-lamps`, `observatory-open`, `campus-turf-dusk`, `library-louvres-60m`. Measure `visibleShare('campus')` from home.
- [ ] **Step 1: Write the failing tests:** `readers take three poses in one draw`; `the slit lining's colour stays within the grey band`; UI: `visibleShare('campus') is at least 0.015 from home`; campus sub-guard on both tiers; if ruling 18 (b) applies, `the tallest tower is uncropped and every district is in frame from home`.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement ruling 18 in its order.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three). Commit `Finish the campus: its readers, lamps, observatory and lawns, and let it be seen from home`.

### Task 11: Depth of field for close-ups, and the keys that move the camera [Opus] [city]

**Files:**
- Modify: `app/src/city/post.ts`, `app/src/city/camera.ts`, `app/src/city/ride.ts`, `app/src/city/tour.ts`, `app/src/main.ts` (H with the inspector open; `T` on Monday), `tools/perf.ts`
- Test: `test/post.test.ts`, `test/tour.test.ts`, `test/tour-camera.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `setFocus(o: { mode: 'ride' | 'follow' | 'tour' | 'inspect' | null; distance: number }): void` on the post chain (ruling 16): a half-resolution bokeh pass with aperture tied to the focus distance, eased over 0.6 s on and off, never on medium, never past 160 m; H flies home only when no text field has focus and closes the inspector first; on Monday before noon, or whenever the current week plans fewer than `minStops`, `T` walks the previous week.
- [ ] **Step 0:** Stills `ride-top` (from capture), `people-follow`, `tour-stop`, `inspector-close`, and the same four on medium.
- [ ] **Step 1: Write the failing tests:** `depth of field is off from home, the overview and past 160 m`; `it is never on at medium`; `focus eases over 0.6 s`; `H with the inspector open closes it, then flies home`; `H in a text field types`; `T on a Monday morning walks last week`; UI: the four views hold 58 fps on high with depth of field on.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5: Quality rounds** (three): focus must read as a lens, not a blur filter; edges of towers against the sky must not halo. Commit `Focus the lens on close-ups only, and fix the home and tour keys`.

### Task 12: Per-cluster batch culling for close views [Opus] [city]

**Files:**
- Modify: `app/src/city/batch.ts`, `app/src/city/plain-batch.ts`, `app/src/city/quarters.ts`, `app/src/city/breakdown.ts`, `tools/perf.ts`
- Test: `test/plain-batch.test.ts`, `test/batch.test.ts` (new), `test/quarters.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: batches split into spatial clusters of at most 64 m with their own bounds, so the frustum culls them; draw ranges merged per frame only for visible clusters (`visibleRanges(camera): Array<[start, count]>`), keeping one draw call per batch; the quarters' 4.0M triangles culled the same way.
- [ ] **Step 0:** Measure `street`, `ride-top`, `quarter-court`, `people-follow`, `campus-quad` and home on both tiers.
- [ ] **Step 1: Write the failing tests:** `a cluster behind the camera is not drawn`; `visible ranges cover exactly the visible clusters`; `calls per batch stay one` **(guard)**; UI: `street and quarter-court draw at least 25% fewer triangles than round 0 on high`; home calls not higher than round 0.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement; the near, shadow and AO layers keep their passes.
- [ ] **Step 4:** Run; expect PASS; re-measure every view.
- [ ] **Step 5:** Shoot ruling 7's four views and the five above against round 0 (SSIM at least 0.99 through `tools/perf.ts`'s compare). Commit `Cull the city's batches by cluster so close views draw only what they see`.

### Task 13: No hitches [Opus] [city]

**Files:**
- Modify: `app/src/city/batch.ts`, `app/src/city/construction.ts`, `app/src/city/quarters.ts`, `app/src/city/lots.ts`, `app/src/city/exchange.ts` (`setClock`), `app/src/main.ts` (re-merge scheduling), `tools/ui-test.ts`
- Test: `test/batch.test.ts`, `test/quarters.test.ts`, `test/lots.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: `scheduleRemerge(key: string, work: () => void): void` that spreads re-merges over idle frames at no more than 4 ms of work per frame and coalesces repeated keys, so a floor landing, a quarter's hires (debounced 1.5 s) and a re-clad never stall a frame; a freed plot fills back over 1.2 s (blocks rising from the ground) rather than in one frame; `setClock` reuses its matrices.
- [ ] **Step 0:** With `frameLog`, record frame times on both tiers during: a floor landing, three hires in one second, a bankruptcy re-clad, a disconnect that frees a plot, and all four during the ride.
- [ ] **Step 1: Write the failing tests:** `scheduleRemerge coalesces a key and does at most 4 ms a frame`; `hires in a burst rebatch once`; `a freed plot fills over 1.2 s`; `setClock allocates no matrices`; UI: `no frame over 33 ms in any of Step 0's five cases on either tier` (`frameStats(...).over33 === 0`), `every disposed geometry and material is counted by renderer.info after a disconnect`.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5:** Commit `Spread the city's rebuilds over idle frames so nothing hitches`.

### Task 14: Texture weight and the first frame [Opus] [city]

**Files:**
- Modify: `app/public/textures/*`, `app/src/city/materials.ts`, `app/src/city/kits.ts`, `CREDITS.md` (the `sand_*` row covering limestone, granite and Gothic roots), `tools/perf.ts` (first-frame timing)
- Test: `test/textures.test.ts` (new), `tools/ui-test.ts`

**Interfaces:**
- Produces: each texture sized to the largest texel density any view needs (measured from the nearest view of each use), re-encoded at quality 88 with the original 4K kept out of the repo; `app/public/textures` at most 24 MB; the ironspot set at most 2.5 MB; textures loaded in the order the home view needs them, with the city drawn as soon as the stone, brick and glass sets are in; first city frame within 4 s of navigation on the built app served by a local engine.
- [ ] **Step 0:** Record per-texture size, the first-frame time (navigation to first frame with towers drawn) over five cold loads, and stills `root-close`, `street-kerb`, `plaza`, `tower-close`.
- [ ] **Step 1: Write the failing tests:** `the textures folder is at most 24 MB`; `every texture listed in materials.ts exists and every file is used` **(guard)**; `CREDITS.md names every texture set and the roots it covers`; UI: `the first city frame comes within 4 s` (median of five), `SSIM against round 0 at least 0.98 at root-close, street-kerb, plaza and tower-close`.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; re-measure.
- [ ] **Step 5:** Commit `Halve the city's texture weight and draw the city before the last texture lands`.

### Task 15: The whole-city performance pass at full window [Opus] [city]

**Files:**
- Modify: whichever of `app/src/city/{lod,governor,post,grid,river-lod,scene}.ts` the measurement names; `app/src/city/tower/rendered.ts`, `app/src/city/ambient-rendered.ts` (the re-measure); `tools/ui-test.ts` (the live-sites calls check through `homeBudget`, Phase 2 M5)
- Test: `test/lod.test.ts`, `test/governor.test.ts`, `test/measured.test.ts`, `test/tower-variants.test.ts`, `tools/ui-test.ts`

**Interfaces:**
- Produces: every named perf view at 58 fps or more on both tiers at `PERF_VIEWPORT`; roof-kit AO carried to 1,250 m; no LOD pop at 450 m (a cross-fade over 430 to 470 m); far towers shadowed at wide home within the guard (a second, cheaper shadow cascade or a baked contact shadow beyond `SHADOW_HALF`); the governor notice names the frame rate it measured; `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/perf-final.json`, the table the README's performance line quotes; and, once every look and texture of Tasks 6 to 14 has landed, the measured colour tables regenerated once (Decision 6) by running (never editing) the capture tool's swatch path (`SWATCH_WRITE=1`, `AMBIENT_WRITE=1`) on the sample at `SEED_AT`, with a staleness test that fails when a look's material parameters change without a re-measure (a hash of the parameters stored beside each row), contrast tests that read rendered colour, not declared swatches, and pins that cover the material parameters, not only look ids.
- [ ] **Step 0:** Run `tools/perf.ts` on both tiers over every view (the old and every Phase 5 view); list every view under 58 fps and every key over its share.
- [ ] **Step 1: Write the failing tests:** `the LOD cross-fade spans 430 to 470 m`; `AO reaches 1,250 m`; `the measured table is stale when a look's parameters change`; `contrast is checked on rendered colour`; UI: `every named view holds 58 fps on high and on medium` (a guard for views already there, failing first for the views Step 0 lists as slow), `a governor step down to medium in the middle of a ride keeps 58 fps and turns depth of field off without a jump`, `live sites add their calls as measured through homeBudget, not single frames`, home guard on both tiers.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Fix each slow view at its cause, cheapest first; never by dropping content a README still shows.
- [ ] **Step 4:** Run; expect PASS; write `perf-final.json`. Re-measure the colour tables last, then finish Decision 6's before and after sheet of the six looks (round 0 from Task 6) in the rounds folder.
- [ ] **Step 5:** Shoot ruling 7's four views against Task 0's baseline. Commit `Hold 60 fps at full window on both tiers across every view` with the table in the body.

### Task 16: One interior room, only on his yes [Fable] [city] [optional]

Runs only if he answers yes to Decision 7. Scope as Phase 3 Task 19: one glazed room behind the datum floor of the district tower, shown on the ride when it stops at the datum, built in the facade kit, its contents from the floor's dossier (the change's title on a drawing on the table, the agent's plan pinned up), within the guard; three quality rounds on `ride-datum-room`. Commit `Open one room behind the datum floor`.

## Part C: the screens and docs track

### Task 17: Screens minors, verified then closed [Opus] [screens]

**Files:**
- Modify: whichever of `app/src/ui/{board,jobs,job,run,detail,notices,audit,audit-words,repos,school,school-words,treasury}.ts`, `app/src/ui/*.css` and `engine/market/{api,bids,sample-economy}.ts` the open lines name
- Test: the matching `test/*.test.ts`, `tools/ui-test-{jobs,detail,notices,audit,school,screens}.ts`

**Interfaces:**
- Consumes: the screens rows of the parked table.
- Produces: per line, closed or fixed: the credits explanation in the page, not a tooltip only; the job board's header counts the rows it shows; the board's source explainer back; find-in-page reaches emptied diff rows (rendered on search); `HIDDEN` covers every invisible code point in Unicode's `Default_Ignorable_Code_Point` set plus bidi controls; ages tick each minute; the sample round never shows closing while bids still climb; `bid.placed` outside the current round is refused; notices keep contrast over a lit tower (an ink plate at 0.82 opacity), wrap to two lines then ellipsise with the full text on hover and focus, and sit lower left clear of an open sheet; "audited when you asked"; the school screen discloses the cost head's bias from excluded capped runs; the repos page keeps its done-hold across a refresh and shows the tower again after a toggle-on.
- [ ] **Step 0:** Ruling 21 for each line; write the table to the ledger.
- [ ] **Step 1: Write the failing tests**, one per open line, named for it (for example `HIDDEN strips U+2066 to U+2069 and U+FEFF`, `the board header counts grouped rows as shown`).
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck` and the screens ui-test files; expect PASS.
- [ ] **Step 5: Quality rounds** (two) on `jobs`, `job`, `notices`, `audit`, `school`, `repos` (capture names, shot to the rounds folder). Commit `Close the screens' parked lines`.

### Task 18: Engine and shell minors, verified then closed [Opus] [screens]

**Files:**
- Modify: whichever of `engine/**`, `src-tauri/src/main.rs`, `docs/SELF_RECURSION_GUARDRAILS.md` the open lines name
- Create: `tools/load.ts`
- Test: the matching `test/*.test.ts`; `cargo test` in `src-tauri`

**Interfaces:**
- Consumes: the engine row of the parked table.
- Produces: each open line fixed with its test, or recorded closed (ruling 21); in particular `let _ = window.maximize(); window.show()` with the failure logged; server 500s through `redact()`; the baseline joiner recomputes when its own signal is live; backfilled reports only from the first market entry; the guardrails doc records egress per run and TLS fronting as residuals; the gate cache holds in-flight promises and caches a failed read for 1 s, not 10; `parseIdle` reads the `HIDIdleTime` of the HID system entry; a stopped connect cancels its analysis; the load-sensitive tests (broker reaper, `ship.test.ts` follow-up window, runs wall watcher, ollama mid-flight) pass three full runs in a row under a synthetic load (`tools/load.ts`: one busy loop per performance core for the length of the run, no GPU, no port), never under `tools/perf.ts`, which belongs to the city track.
- [ ] **Step 0:** Ruling 21 for each line; write the table to the ledger.
- [ ] **Step 1: Write the failing tests**, one per open line.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` three times, `npm run typecheck`, `cargo test`; expect PASS each time.
- [ ] **Step 5:** Commit `Close the engine's and the shell's parked lines`.

### Task 19: The hardlink escape [Opus] [screens]

**Files:**
- Modify: `engine/market/sandbox.ts`, `engine/school/trainer.ts` (its profiles), `README.md` (only the sandbox section's limit sentence, if it changes)
- Test: `test/sandbox.test.ts`

**Interfaces:**
- Produces: `hardlinkRule(writable: string[]): string` added to the tool, CLI and trainer profiles if ruling 19's proof finds one; otherwise nothing changes but the test, which then pins the disclosed behaviour.
- [ ] **Step 1: Write the failing test** under a temp dir with `sandbox-exec`: `a sandboxed process cannot hard-link a readable file from outside the run into the run's writable folder`, plus `a hard link inside the writable folder still works` (git and npm need it) **(guard)**.
- [ ] **Step 2:** Run; expect FAIL (the escape is real today).
- [ ] **Step 3:** Try ruling 19's candidates in order on this Mac; keep the first that passes both tests without breaking `test/sandbox.test.ts` and the market's run tests.
- [ ] **Step 4:** Run `npm test`; expect PASS. If no rule works, mark the first test `todo` with the reason, and leave the README sentence as it is.
- [ ] **Step 5:** Commit `Close the sandbox's hardlink path` or `Pin the sandbox's known hardlink limit in a test`.

### Task 20: A sample anyone who clones it can open [Opus] [screens]

**Files:**
- Create: `tools/sample-run.ts`
- Modify: `tools/sample.ts`, `engine/market/sample-economy.ts` (guard; verify the plan sentences, Phase 3 Minor 8), `engine/school/` sample seeding (guard), `engine/sample.ts` (folder overrides honoured only on a sample home), `package.json` (a `sample` script running `tools/sample-run.ts` through tsx, the same way the `ui-test` script runs), `.gitignore` (`sample-home/`)
- Test: `test/sample.test.ts`, `test/sample-economy.test.ts`

**Interfaces:**
- Produces: ruling 13; ruling 23 (`seedSample` writes the marker first); `sampleTarget(env, cwd): { dir: string } | { refuse: string }` with the refusals "That is your real Palimpsest folder; the sample needs its own.", "That folder has files in it and is not a sample; choose an empty one.".
- [ ] **Step 1: Write the failing tests:** `seedSample marks the home before it writes anything, so seedEconomy and seedSchool accept it`; `seedEconomy on a seedSample home with no other step succeeds` (the path `tools/perf.ts`, `tools/ui-test.ts` and `tools/capture.ts` take); `sampleTarget refuses the real home`; `it refuses a non-empty folder without the marker`; `it reuses a folder with the marker`; `seedEconomy throws Not a sample home on a plain temp home`; `the sample seeds the same ledger twice at SEED_AT` **(guard)**; `no sample plan reads as a template` (no plan in the sample matches `/find where .* happens in/`).
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS; run `npm run perf` with `PERF_ONLY=home` once on the screens track's own port (`PERF_PORT=4794`, without the GPU lock, calls only) to prove the city's tools still seed; run `npm run sample` with `PALIMPSEST_SAMPLE_HOME` under the scratchpad and open 4790 in Playwright: the city, the board moving, the school.
- [ ] **Step 5:** Commit `Open the sample city in one command, and refuse any folder that is not a sample`.

### Task 21: The logo: three directions [Fable] [screens]

**Files:**
- Modify: `docs/brand/logo.py`, `docs/brand/wordmark.py`, `docs/brand/icons.py`, `docs/brand/finish.py`
- Create: `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/logo-directions.png` (not committed)

**Interfaces:**
- Produces: three directions (ruling 12): (a) today's P in floors, refined: a real plinth and ground instead of the flat slab, the skyline behind it from the city's own towers instead of boxes, the datum band and one primer floor legible at 32 px; (b) a single tower read bottom to top as the mark, root to crown, cut to the icon's rounded square; (c) a letterform from the wordmark carved in stone with one lit window row and the bronze datum, closest to a printed mark. Each at 1024, 128, 32 and 16, on the macOS Dock and Finder backgrounds in light and dark, plus the running head at 18 px and the splash.
- [ ] **Step 1:** Render all three through Blender scripts only.
- [ ] **Step 2: Quality rounds** (three) at every size; the 16 px icon must be recognisable from the other two.
- [ ] **Step 3:** Send him the contact sheet with one line per direction. Stop until he picks or combines (Decision 1). Commit the script changes only: `Draw three directions for the mark`.

### Task 22: The logo, finished [Fable] [screens]

**Files:**
- Modify: `docs/brand/*`, `src-tauri/icons/*` (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.png`, `icon.icns` with 16 to 1024), `src-tauri/splash/index.html`, `app/src/ui/runhead.ts`, `app/index.html` (favicon), `docs/brand/wordmark-{dark,light}.png`
- Create: `app/public/brand/{favicon-32.png,favicon-180.png}`, `docs/brand/social.png` (1280 by 640, at most 1 MB)
- Test: `tools/ui-test-screens.ts` (splash and running head), `cargo test`

**Interfaces:**
- Consumes: his pick.
- Produces: the chosen mark everywhere he sees the app: the Dock, Finder, the splash, the running head at 18 px, the browser tab, the README wordmark, the social card (prepared for Decision 10; uploaded only by him).
- [ ] **Step 1: Write the failing tests:** `the splash shows the mark and the name`; `the running head draws the mark at 18 px`; `the favicon is served`; `icon.icns carries 16, 32, 64, 128, 256, 512 and 1024` **(guard)**.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Render and wire.
- [ ] **Step 4:** Run; expect PASS; `npm run app` builds (a local release build of the Tauri shell in the existing `src-tauri/target`, about ten minutes on this Mac, under the GPU lock's rule since it loads every core; nothing is installed or opened) and the bundle's icon is the new one (checked with `sips` on the bundle's `icon.icns`, not by opening the app).
- [ ] **Step 5: Quality rounds** (three) at every size side by side with the city stills. Commit `Give Palimpsest its mark in the Dock, the splash, the running head and the README`.

### Task 23: Diagrams drawn from the code [Opus] [screens]

**Files:**
- Create: `tools/diagrams.ts`, `tools/diagrams/data.ts`, `tools/diagrams/{machine,floor,sandbox,school}.ts`, `test/diagrams.test.ts`
- Modify: `package.json` (a `diagrams` script running `tools/diagrams.ts` through tsx, as `ui-test` does)

**Interfaces:**
- Produces (`data.ts`): `RUN_STAGES = [...] as const satisfies readonly RunStage[]`, `CHECKS satisfies readonly CheckName[]`, `JOB_STATES satisfies readonly JobStatus[]`, `NETS satisfies readonly NetName[]`, each with a type-level exhaustiveness check (`Exclude<RunStage, (typeof RUN_STAGES)[number]>` must be `never`); `WORK_KINDS` and `DEFAULT_PORT` imported, never copied; ruling 11's four diagrams; output to `CAPTURE_OUT` (default a temp dir; `docs/media` only in Task 27).
- [ ] **Step 1: Write the failing tests:** `every run stage, check, job state and net appears in its diagram`; `the machine diagram's ports come from DEFAULT_PORT and the Ollama constant`; `no label contains an em dash, a double hyphen or an emoji`; `every label is sentence case`.
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement; render with Playwright on 4792 with the app's fonts.
- [ ] **Step 4:** Run; expect PASS; render the eight images into the rounds folder.
- [ ] **Step 5: Quality rounds** (two): each diagram must explain one real mechanism a reader cannot get from the prose beside it, read in both themes, and look drawn for this app, not generated. Commit `Draw the README's diagrams from the code's own lists`.

### Task 24: The capture list, the media budget and the film tool [Opus] [screens]

**Files:**
- Modify: `tools/capture.ts` (default output to a temp dir; `CAPTURE_WRITE_MEDIA=1`; new stills and clips; drop the GIF and card outputs)
- Create: `tools/film.ts`, `tools/media-check.ts`, `tools/install-check.ts`
- Modify: `package.json` (`"media:check"`, `"film"`, `"install:check"`)
- Test: `test/media-check.test.ts`, `test/install-check.test.ts`

**Interfaces:**
- Produces: capture names added: `district-audit`, `job-scope`, `audit` (clip, 30 s at the clock's speed: the audit ending and its proposals appearing on the board), `hero` and `overview` (re-framed with the spire standing), `revival` (closer to the festoon), `week-poster` and `ride-dossier` (framed off the sun), `overview-clear`, `street`, `people-follow`, and the eight diagram images through `tools/diagrams.ts`; `mediaCheck(readme: string, dir: string): { ok: boolean; problems: string[] }` (ruling 8); `film.ts` (rulings 9 and 10) reading clip frames the capture tool wrote; `installCheck(pkg: object, lock: object): string[]` (ruling 22), the list of local dependencies. The capture tool and the film tool use `CAPTURE_PORT` (4788 on the screens track; 4789 after the merge, one after the other).
- [ ] **Step 1: Write the failing tests** on fixture folders: `a file in docs/media that the README does not use is a problem`; `a missing reference is a problem`; `a still over 450 KB is a problem`; `alt text with an em dash is a problem`; `the inline payload counts the larger of AVIF and its fallback`; `a poster counts as used when its clip is linked`; `installCheck names a git+file dependency in package.json and a file: resolved entry in the lock` (on fixtures; the real repo is not part of `npm test`).
- [ ] **Step 2:** Run; expect FAIL on the non-guard tests; guards pass.
- [ ] **Step 3:** Implement. Dry-run `tools/capture.ts` for the new names and `tools/film.ts` on the current city into the scratchpad to prove the pipeline (these frames are thrown away).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Hold the README's media to a budget and give the film its own tool`.

### Task 25: The README for launch, in words [Opus] [screens]

**Files:**
- Modify: `README.md`, `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (section 16, ruling 14 only)
- Create: `LICENSE` (only with his answer to Decision 13)

**Interfaces:**
- Produces: the launch README's text in his style (first person, plain, specific; no badge wall beyond the one shields row, no triplets, no closing line written to land): the shields row to `v1.0`; the film's poster under the hero; "Try it on the sample city" with `npm run sample` before "Run it"; the four diagrams placed where each mechanism is told (`machine` under "Run it", `floor` in the market, `sandbox` in the sandbox section, `school` in the school); a short "How fast it is" from `perf-final.json` (filled in Task 29); "Where it stands" rewritten: all five phases built, the deviations (ruling 14), the honest state of the real runs (Decision 11), the at-the-Mac items; "How the pictures were made" with the film, the diagrams and the media budget; media references named but the files left for Task 27. The install sentence about Beagle is written for both states, and Task 33 keeps the one that matches: while `npm run install:check` fails, "A fresh clone will not install yet: the school's Beagle dependency points at a copy on my Mac until its pull request is merged"; once it passes, the sentence is removed and "Run it" stands as written (the README never names a `.superpowers` path, since that folder is not in the repo). The film block is written once in its final form: the poster `docs/media/film-poster.webp` linked to `docs/media/film.mp4`, under it the line "The launch film, 80 seconds, silent. Click to play."; if he uploads the film to GitHub (Decision 2), Task 33 changes only the link target. With his answer to Decision 13, `LICENSE` and a "License" section of one line.
- [ ] **Step 1:** Write it.
- [ ] **Step 2:** Self-check against his README rules and the no-AI-look list; remove every sentence that a reader could not check.
- [ ] **Step 3:** Commit `Write the launch README`.

## Part D: launch (both tracks merged, one task at a time)

### Task 26: Merge the tracks and re-measure [Opus] [both tracks merged]

- [ ] **Step 1:** Merge `phase-5-city` and `phase-5-screens` into `phase-5` (no conflicts are expected under ruling 2; any found is resolved toward the owning track and named in the commit body).
- [ ] **Step 2:** Run `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test`, `cargo test` and `PERF_TIERS=high,medium npm run perf <ledger>/merged`; home guard, sub-guards and every view at 58 fps on both tiers.
- [ ] **Step 3:** Commit the merge `Bring the city and the screens of Phase 5 together`.

### Task 27: Capture every still and clip, and hold the budget [Opus] [both tracks merged]

**Files:** `docs/media/*`

- [ ] **Step 1:** `CAPTURE_WRITE_MEDIA=1 npx tsx tools/capture.ts` and `CAPTURE_WRITE_MEDIA=1 npm run diagrams` on the sample at `SEED_AT`; delete every file in `docs/media` the README no longer uses (Decision 3; history untouched).
- [ ] **Step 2: Quality rounds** (two): view every still and every clip's poster at full size against its alt text and the bar; re-shoot any that misses (framing, the sun, a figure caught mid-step); `street` and `people-follow` only under ruling 17.
- [ ] **Step 3:** `npm run media:check` passes.
- [ ] **Step 4:** Commit `Shoot the launch's stills and clips from the sample`, with the before and after `docs/media` sizes.

### Task 28: The film and the profile clip [Opus] [both tracks merged]

**Files:** `docs/media/film.mp4`, `docs/media/film-poster.webp`, `docs/media/profile.{avif,webp,md}`

- [ ] **Step 1:** `CAPTURE_WRITE_MEDIA=1 npm run film` (rulings 9 and 10).
- [ ] **Step 2: Quality rounds** (three): watch it end to end at full size; cuts land on motion, titles read, no frame shows a placeholder, a debug handle, a hitch or a blown sun; the loop's seam is invisible.
- [ ] **Step 3:** `npm run media:check` passes with the film and the clip.
- [ ] **Step 4:** Commit `Cut the launch film and the profile loop`.

### Task 29: The README's media and the gap pass of every claim [Opus] [both tracks merged]

**Files:** `README.md`, any code a claim shows wrong, `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/readme-claims.md`

- [ ] **Step 1:** Put every still, clip, diagram and the film's poster in place (the film block's wording is Task 25's, unchanged) with alt text written from the still itself; fill "How fast it is" from `perf-final.json`.
- [ ] **Step 2:** The gap pass: one row in `readme-claims.md` per factual sentence and per alt text (claim, evidence as `file:line`, a test name or the still, verdict: holds, code fixed, README fixed, removed). Every number traced to its source (tests count from a full run, floors, credits, budgets, fps, sizes); every command in "Run it" and "Try it" run on a scratch home; every link resolved; no sentence names a `.superpowers` path or anything else not in the repo; the Beagle install sentence matches `npm run install:check` as it stands.
- [ ] **Step 3:** Fix each gap: code with a failing test first, or the README.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run ui-test`, `npm run media:check` pass.
- [ ] **Step 5:** Commit `Check every sentence of the README against the code`.

### Task 30: A clean clone on a temp home [Sonnet] [both tracks merged]

- [ ] **Step 1:** Run `npm run install:check`; while the Beagle pin is local it fails, and Task 30 records that as a launch blocker (not a pass). Under test safety rule 19: `git clone` the local repo at `phase-5` into the scratchpad; `npm install` under the profile that hides the bare Beagle copy, which must fail while the pin is local (the README's install sentence says so; Task 29 checked it) and must succeed after Task 33 moves the pin, when Steps 1 to 3 are repeated; `npm test`, whose test count must equal the count the README states, else the run fails; `npm run build`; `npm run sample` on 4790; Playwright opens the city, the board and the school; `node bin/palimpsest.mjs engine status` answers without touching launchd.
- [ ] **Step 2:** Confirm nothing was written outside the scratch dir (a `find` of `~/Library/Application Support`, `~/.claude` and `~/Library/LaunchAgents` by mtime since the start shows no Palimpsest entry).
- [ ] **Step 3:** Delete the scratch clone. Record the results in the ledger; any failure is a fix in Task 32.

### Task 31: Phase final review with the gap pass [Fable] [both tracks merged]

**Files:** `.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/final-review.md`

- [ ] **Step 1:** Read only, on `phase-5`: (1) whole-branch integration and safety (no route, tool or test reaches 4770, his home, `~/.claude` or GitHub; `media:check`; the sample guards); (2) the gap pass: spec section 13 line 5, section 2 goal 10, section 5, section 6.6 with Decisions 4 and 5, every row of this plan's parked table (closed with a commit, or parked with its reason), every Decision's answer as built; Task 16 recorded as ruled by his answer to Decision 7 (built, or not built on his no); (3) an independent pass over every README claim, not reading `readme-claims.md` first; (4) every README still, clip, diagram and the film viewed at full size against the bar; (5) `perf-final.json` re-run on both tiers.
- [ ] **Step 2:** Write the verdict: Critical, Important, Minor, the gap list, the README list, ready or not.

### Task 32: The review's fixes [Opus] [both tracks merged]

- [ ] **Step 1:** Fix every Critical and Important with a failing test first; fix or park each Minor with its reason.
- [ ] **Step 2:** Re-run `npm test`, `npm run typecheck`, `npm run build`, `npm run ui-test`, `cargo test`, `npm run media:check` and the perf table; repeat Task 29's rows the fixes touched.
- [ ] **Step 3:** Commit each fix on its own; a scoped re-review (Sonnet) only where a fix is not local.

### Task 33: Merge to main, and the launch on his word [Sonnet] [both tracks merged]

**Files:** `package.json`, `package-lock.json` (the pin), `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (Decision 12), `tools/launch.ts`, `test/clean-install.test.ts`, `README.md` (the Beagle sentence and, if he uploaded the film, its link)

- [ ] **Step 1:** Confirm the preconditions (ruling 15): Task 31 ready, Task 32 landed, Phase 4 on main with the pin on `github:AllStreets/beagle#<sha>` (fetched on his word, Global Constraints), `npm run install:check` passing and then added to `npm test` as `test/clean-install.test.ts`, Task 30 repeated green after the pin moved, the README's Beagle install sentence removed and Task 29's row for it re-run, and his answer to Decision 13 in. If any is missing, stop at "ready", merge nothing, print no launch command, and tell him what waits on him.
- [ ] **Step 2:** Set the version to 1.0.0 in the three files; run `npm test` and `cargo test`; commit `Palimpsest 1.0`.
- [ ] **Step 3:** Merge `phase-5` into `main` locally; run the full suite on `main`.
- [ ] **Step 4:** `tools/launch.ts` runs `installCheck` first and prints nothing else while it fails; otherwise it prints, for his OK one by one (Decision 10): the push of `main`; the tag and release with `film.mp4`; `gh repo edit` with the description, topics and homepage; the social card's path for him to upload; the profile snippet for his profile README. Nothing runs without his yes in the session.
- [ ] **Step 5:** After his yes to the push: send him the steps to move his installed engine to main (the standing order: only after a phase's final review; the database migrates one way).

## Self-review notes

- **Spec coverage.** Section 13 line 5: the logo (Tasks 21, 22), the README with screenshots (Tasks 24, 25, 27, 29), video (Tasks 24, 28), diagrams (Task 23), the sample dataset (Task 20), the performance pass (Tasks 12 to 15). Section 2 goal 10: the logo at his bar, the README with screenshots, video and diagrams. Section 1 and 5: cloners run it safely with nothing connected (Tasks 20, 30; Review Focus 1, 2), README media only from the sample (Global Constraints, rule 17). Section 6.6: 60 fps at full window with a quality setting (Tasks 0, 15), post including depth of field for close-ups (Task 11), WebGPU and day and night as recorded deviations (Decisions 4, 5; ruling 14). Section 4: no AI look (Global Constraints, ruling 6), no fake life (Global Constraints). Section 8 never list: GitHub, history and settings only on his word (Decisions 3, 10; rule 18). Section 18 polish lines were closed in Phase 1; the parked table carries every later line.
- **Interfaces created here:** `homeBudget(page, tier)`, `viewFps`, `PERF_VIEWPORT`, `frameLog`, `frameStats` (Task 0); `KERB`, `streetSurface` (1); `cornerU` (2); `phaseOf` (3); `signalAt`, `VIADUCT_MIN_RADIUS` (4); `SUN_BLOOM_MAX` (6); `createTrees`, `LEAF_SUN_MAX` (9); `visibleShare` (10); `setFocus` (11); `visibleRanges` (12); `scheduleRemerge` (13); `hardlinkRule` (19); `sampleTarget` and the marker in `seedSample` (20); `mediaCheck` and `installCheck` (24); `PERF_PORT` (0); `FIGURES_SKIN_BUDGET` (3); `tools/diagrams/data.ts` lists (23). Each is consumed only by its own task's tests, by Task 15, or by the launch tasks under the same name.
- **Every perf task re-measures the home guard on both tiers and the frame rate:** Tasks 11 to 15 by their Step 0 and Step 4, and every other city task by the Part B preamble; Task 26 after the merge; Task 31 independently.
- **Track independence:** no file appears under both owners; Task 0 moves the screens' checks out of `tools/ui-test.ts` and the city track needs no `package.json` change.
- **Proportion:** 34 tasks (Task 0 to Task 33, Task 16 optional): one before the split, 15 on the city track plus the optional room, 9 on the screens track, 8 for the launch; against a one-line phase whose weight is the parked lines; steps carry only the values the spec, a ledger ruling or a ruling here pins.

## Plan check fixes

| Item | Fixed in |
|:-|:-|
| C1 the clean clone could not catch the `git+file` pin on this Mac | Ruling 22 (`install:check` over `package.json` and `package-lock.json`, failing on `file:` and `git+file:`); Task 24 (`installCheck`, its fixture tests); test safety rule 19 (install under a profile that hides the bare copy, nothing renamed); Task 30 Step 1 (a failing check is a blocker, not a pass); Task 33 Steps 1 and 4 (no merge and no launch command while it fails; `test/clean-install.test.ts` added once the pin moves) |
| C2 the seed guard would break the city's tools | Ruling 23 (`seedSample` writes the marker first, so no city tool is edited); Task 20 tests and its Step 4 run of `tools/perf.ts` on the screens port |
| C3 no owner for the README's Beagle sentence | Task 25 (both wordings, tied to `install:check`; no `.superpowers` path in the README); Task 29 (the sentence matches the check); Task 33 Step 1 (removed after the pin moves, Task 29's row re-run) |
| I1 `test/tour.test.ts` and `test/river.test.ts` | City test list in the ownership table (`river` was listed; `tour` added); the sample seeding is C2 |
| I2 the shared machine | Task 0 (`PERF_PORT`); Global Constraints (per-track ports, the GPU lock: fps only under it, the other track runs only `npm test` and typecheck meanwhile); Task 18 (`tools/load.ts`, never `tools/perf.ts`); Task 22 (the Tauri build under the lock's rule) |
| I3 the staleness pin would fail every later look task | Decision 6 and the parked table (re-measure once in Task 15, after Tasks 6 to 14); Task 6 no longer touches the tables; Task 15 re-measures, adds the staleness, rendered-contrast and parameter pins, and finishes the six-look sheet |
| I4 tests that pass before; perf.ts run with plain node | Test safety rule 21 and the **(guard)** marks in Tasks 0, 1, 3, 8, 9, 12, 14, 15, 19, 20, 22; every Step 2 expects failure only on the non-guard tests; every perf run goes through Task 0's `perf` script, which loads tsx (ruling 3) |
| I5 network gates | Global Constraints: no download or fetch without his OK except Task 30's registry installs; the `github:` pin fetched in Task 33 on his word; no read-only `gh` calls |
| I6 skins in the figures budget | Task 3: `figures-skin.webp` under `FIGURES_SKIN_BUDGET = 262_144`, loaded at the close level only; `figures.glb` keeps 420 KB by quantised crowd geometry read by three's own loader; tests for both budgets and the deferred load |
| M1 test count | Task 30 Step 1 (the clone's `npm test` count must equal the README's) |
| M2 Task 16 | Task 31 Step 1 records it as ruled by Decision 7 |
| M3 film wording | Task 25 writes the film block once; Task 29 places the poster without rewording; Task 33 changes only the link if he uploads |
| M4 shared capture and film port | Task 24 interfaces and Global Constraints (4788 on the screens track, 4789 after the merge, one after the other) |
| M5 the Tauri build | Task 22 Step 4 (local release build in the existing target, about ten minutes, nothing installed or opened) |
| M6 ledger paths in the README | Task 25 and Task 29 (no `.superpowers` path) |
| M7 licence | Decision 13 (recommend MIT); Task 25 adds `LICENSE` with his answer; Task 33 waits for it |
