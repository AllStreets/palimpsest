# Screens Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Palimpsest's non-city screens into the city's operating system, a hologram and terminal interface at Connor's CORANTO bar. Start with three throwaway Brief directions, and stop for his pick.

**Architecture:**
- **Stage 1 (this plan, in detail):** three directions of the Brief, each a throwaway prototype on its own branch. Each is refined over three capture, critique and refine rounds, then delivered as stills. A hard stop follows while Connor picks.
- **Later stages (outlined below):** each gets its own detailed plan, written after the pick, because the pick decides the tokens, fonts and primitives every later task names.

**Tech Stack:** plain TypeScript DOM and CSS in app/src/ui (no framework), self-hosted woff2 fonts in app/public/fonts, three.js city behind, tools/capture.ts for stills, tools/perf.ts for frame times.

**Spec:** docs/superpowers/specs/2026-11-20-screens-redesign-design.md

## Global Constraints

- Offline: no CDN at runtime. Every font is self-hosted woff2 under OFL or an equally permissive licence, with the licence file committed beside it.
- No UI framework is added. The stack is TypeScript DOM plus CSS.
- Untrusted text (run summaries, PR titles, issue titles) is never set with innerHTML. Keep the safe markdown renderer (app/src/ui, as used by brief.ts).
- No action changes meaning. Every Brief action keeps its exact behaviour and its `look()` and decision calls, because they teach the master net.
- Text contrast is at least 4.5:1. Focus is visible. Motion respects prefers-reduced-motion.
- Made today, not retro: no grain, no CRT blur, no scanline noise.
- Avoid kitsch display faces such as Orbitron and Audiowide.
- Screen words are in Connor's plain voice, with no em dashes, "--" or emojis.
- Performance: with the Brief open, frame time stays within 10% of the current main baseline with the Brief open, at both quality tiers. The city-alone numbers do not move.
- GPU work takes the lock: check both lock files first, write your line to both, and remove only that exact line afterwards.
  - /Users/connorevans/Downloads/palimpsest/.claude/worktrees/agent-a83d5a94629b92b13/.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/gpu.lock
  - /Users/connorevans/Downloads/palimpsest/.claude/worktrees/phase3-city/.superpowers/sdd/2026-11-14-phase-5-polish-and-launch/gpu.lock
- Never use port 4770 or ~/Library/Application Support/Palimpsest. Captures use port 4789 and a scratch PALIMPSEST_HOME. Never open Palimpsest.app.

## Review Focus

1. **A Brief with many items** (20 or more waiting, long PR titles, long summaries) must stay readable and must not overflow the holographic panel. Every direction's stills include the CAPTURE_ECONOMY Brief scrolled to its end.
2. **The city behind at its brightest framing** (the overview at dusk, lit towers) must not wash out panel text. Every direction includes one still of the Brief over the overview.
3. **Reduced motion:** type-in and scanning must have a static equivalent. Every direction includes one still taken with reduced motion emulated.
4. **The autonomy offer** must read as the heaviest action on the screen. Every direction's stills show the autonomy item (brief-autonomy).
5. **A narrow window (1280 x 800)** must not clip controls. Every direction includes one still at that size.

---

## Stage 1: three Brief directions and Connor's pick

### Task 1: Baseline stills and frame times

**Files:**
- Create: `docs/superpowers/plans/redesign-stage1/baseline.md`, with the measured numbers and the still list.

**Interfaces:**
- Produces: the baseline frame times (Brief open and city alone, both tiers) that Tasks 2 to 4 compare against, and the reference still names.

- [ ] **Step 1:** Make a worktree from origin/main (detached), run `npm install` and `npm run build`.
- [ ] **Step 2:** Take the GPU lock. Run capture with CAPTURE_ECONOMY=1 for brief, brief-2 to brief-5, brief-autonomy and overview, plus a 1280 x 800 Brief, on port 4789 with a scratch home. Expected: the stills are written and non-empty.
- [ ] **Step 3:** Run tools/perf.ts with the Brief open and with the city alone, at both quality tiers. Record the median and p95 frame times in baseline.md.
- [ ] **Step 4:** Release the lock. Commit baseline.md on main with the message "Record the Brief's baseline before the redesign".

### Tasks 2, 3 and 4: one direction each (A Phosphor, B Hologram, C Targeting)

Run them one at a time (they share the GPU lock), each on its own branch: `redesign-brief-a`, `redesign-brief-b` and `redesign-brief-c`, made from main. They are throwaway: nothing merges, and the branches stay until the pick.

**The directions** (all within the spec's language; they differ in type, colour, control shapes and motion):
- **A Phosphor (Alien terminal-led).**
  - A deep black with one phosphor green.
  - Monospace-forward type, and summaries that type themselves in.
  - Controls as bracketed keys, `[ OPEN PR ]` style but crafted, not ASCII.
  - Depth from layered terminals, with a soft glow.
- **B Hologram (holographic glass).**
  - A cool cyan and white light on smoked glass, with panels at several depths and parallax on hover.
  - A refined technical display face plus a mono.
  - Controls as glowing keys with an inner light.
  - The city reads clearly through the glass.
- **C Targeting (Terminator HUD and Matrix stream).**
  - A HUD over the city: corner brackets, a scanning sweep, and readouts pinned to each item's district in the city (reuse app/src/city/labels.ts projection).
  - A warm amber or red accent with one cool secondary.
  - Data-stream texture behind the item list.
  - Controls as targeting reticles.
  - The autonomy offer gets a lock-on treatment.

**Files (per direction, throwaway):**
- Modify: `app/src/ui/brief.ts` and the Brief rules in `app/src/ui/screens.css` or `market.css`, as needed.
- Create: the direction's fonts in `app/public/fonts`, with their licence files.
- Create: `docs/superpowers/plans/redesign-stage1/<a|b|c>/critique.md`, with each round's critique.

**Interfaces:**
- Consumes: Task 1's baseline numbers and still names.
- Produces: final stills under `docs/superpowers/plans/redesign-stage1/<a|b|c>/` named `brief.png`, `brief-scrolled.png`, `brief-overview.png`, `brief-reduced-motion.png`, `brief-1280.png` and `brief-autonomy.png`, plus that direction's Brief frame times.

- [ ] **Step 1:** Read the spec, Global Constraints and Review Focus, the frontend-design skill, and Connor's memory file /Users/connorevans/.claude/projects/-Users-connorevans-Downloads-palimpsest/memory/feedback_screens_ai_look.md.
- [ ] **Step 2: Round 1.** Build the direction on the Brief. Take the GPU lock, capture the six stills, release the lock.
- [ ] **Step 3:** Critique round 1 in critique.md against the spec's goals and anti-goals, CORANTO's bar and the five Review Focus lines. Name at least 5 concrete weaknesses.
- [ ] **Step 4: Rounds 2 and 3.** Refine against the critique, re-capture, and critique again. Stop after round 3 only if the critique names no weakness at the anti-goal level; otherwise add rounds, up to 5.
- [ ] **Step 5:** Check that `npm test` and typecheck are green. Copy may change, so update the Brief word tests if the words changed. Run tools/perf.ts with the Brief open. Expected: within 10% of baseline, or the critique says what costs the frames.
- [ ] **Step 6:** Commit on the direction's branch with the message "Brief direction <A|B|C>: <name>, three rounds". Do not merge.

### Task 5: The pick sheet, and a hard stop

**Files:**
- Create: `docs/superpowers/plans/redesign-stage1/pick.html`, one page that sets the three directions side by side. For each it shows the six stills, a three-line note (what it feels like, its strength, its risk) and its frame time against the baseline.

- [ ] **Step 1:** Build pick.html, self-contained with relative image paths. Read it rendered to check it.
- [ ] **Step 2:** Send it to Connor with SendUserFile (status proactive), and ask with AskUserQuestion which direction to build: A, B, C, or a named blend.
- [ ] **Step 3: Stop.** Stage 2 does not start until he answers.

---

## Later stages (each gets its own detailed plan after the pick)

1. **Stage 2, the shared layer from the pick.**
   - Design tokens (colour, depth, glow, motion).
   - The fonts.
   - Primitives: the glass or terminal panel, the shaped control in three weights (look, spend, grant), readouts, type-in and scan motion, and anchored readouts through labels.ts.
   - Terminal mode (dim and blur the city, a full-height phosphor panel).
   - Built properly, test-first, in its own files (for example app/src/ui/os/*), from the winning branch's learnings and not its code.
2. **Stage 3, the Brief rebuilt on the shared layer.** Copy is cut. The words and tests are updated, and the perf gate is held.
3. **Stage 4, Jobs, Repos and Firms,** in that order, each in three rounds with Connor seeing stills.
4. **Stage 5, School.** It reserves the 3D net view region. Then the 3D net view itself: the nets feeding the master, their labels, and agreement over time, at the School screen and the campus.
5. **Stage 6:** Treasury, Settings, the firm, agent and job pages, and inspection in terminal mode.
6. **Delete** the three direction branches after Stage 2 lands.
