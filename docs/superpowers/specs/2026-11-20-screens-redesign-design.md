# Palimpsest screens redesign: the city's operating system

Date: 2026-11-20. Owner: Connor. Status: draft for his approval.

## Why

The city (three.js) meets Connor's bar. Every screen that is not the city does not. The Brief, Jobs, Repos, Firms, School, Treasury, Settings, the firm and agent pages, and inspection read as generic and AI-made. In his words: "the fonts, colors, excessive text, and button shapes make it feel very AI as well as unpolished."

The quality bar is CORANTO, his best UI. Palimpsest must reach that bar with its own identity, not CORANTO's.

## The look

Palimpsest's screens become the city's operating system: the instruments of a powerful machine intelligence that runs an economy of AI firms. The city stays the warm, real place it is. The screens are the advanced technology used to read it and run it.

Connor's references are blended, not copied:

- **Glowing holograms.** Light that floats over the city, with real depth, glow and layering.
- **Chunky green terminals (Alien).** Monospaced type, text that types itself in, one strong phosphor colour.
- **Terminator vision.** Targeting brackets, scanning sweeps, and readouts pinned to what they describe.
- **The Matrix.** Live data streaming and code as texture, so the machine feels like it is thinking.

**Made today, not retro.** No grain, no CRT blur, no scanline noise, no 80s or 90s pastiche. The ideas of those films come back built with current technology: crisp edges, smooth motion, real depth, shading and light.

## Goals

1. **Screens float as holograms over the live city.** The city keeps moving behind them. This is Connor's choice, from his own proposal. Where it fits, a readout attaches to its subject in the city, such as a firm's numbers beside its tower or a job pointing to its floor.
2. **A terminal mode for deep reading.** It covers the full inspection log, a firm's ledger, code and diffs, and run output. The city dims and blurs far behind, and the panel goes full height in a phosphor-on-black terminal. Connor approved this.
3. **Much less text.** Readouts, figures and short labels replace sentences. An explanation is one tap away (hover, focus or expand), never the default.
4. **Distinctive type.**
   - A display face with a technological character for titles and figures.
   - A strong monospace for readouts and the terminal.
   - Both are self-hosted woff2 files under a permissive licence such as OFL.
   - IBM Plex and Newsreader are replaced, not restyled.
5. **Shaped controls.** Buttons become designed objects, never underlined words or default rectangles: targeting brackets, glowing keys, segmented switches.
   - Actions carry visible weight by consequence. The weight ranks from:
     - **heaviest:** granting the city authority (autonomy offers);
     - **then:** spending money (posting a job, retries, tier changes);
     - **lightest:** looking (Open the PR, Ask why).
6. **Depth and light.** Layered panels at different depths, glow, shading, light that responds to state, and motion that means something:
   - scanning when the city reads;
   - typing in when a summary arrives;
   - a pulse on what waits on Connor.
7. **Colour.** Deep black glass with one or two luminous accents, plus a small, strict set of state colours (ok, warn, fail, benched).
   - My call, to be confirmed in the first round: a phosphor green, with a cooler holographic cyan for depth.
   - Contrast must stay at or above 4.5:1 for text.
8. **The 3D net view (Connor's request of Nov 17).** A very high quality 3D view of what the nets learn and aggregate: the nets feeding the master, their labels, and their agreement with his decisions over time. It lives at the School screen and the campus.
   - It is designed in this language, but built after the four core screens. My call on ordering.

## Order

1. **Brief first.** It holds his daily decisions, which teach the master net, and it contains every element type the other screens need. It sets the design language.
2. Then **Jobs, Repos and Firms**, which Connor opens most.
3. Then School (with the 3D net view), Treasury, Settings, the firm, agent and job pages, and inspection (terminal mode).

## Anti-goals (what would make Connor wince, even if it is technically sci-fi)

- Low quality.
- Boring fonts, boring buttons, boring colours.
- Flat panels with no depth, layering or shading.
- Anything that looks like it "was done in simple code".
- Cheap retro: grain, CRT effects, neon kitsch.
- A dashboard-kit or card-kit look.

## Non-goals

- The city's look is out of scope. It already meets the bar, except where a readout attaches to it.
- No change to what any action does. In particular, the Brief's decisions keep exactly their current semantics, because they teach the master net.
- No new features beyond the 3D net view.

## Constraints

- **Offline and self-hosted.** The app is Tauri. The engine serves the built UI from 127.0.0.1:4770, so there is no CDN at runtime.
- **The stack stays.** The UI stays plain TypeScript DOM plus CSS (app/src/ui, with style.css, screens.css and market.css, about 8,700 lines). It has no UI framework, and none is added.
- **Performance.** Holograms over a live city cost GPU. The quality governor and the existing perf harness (tools/perf.ts) must show no regression at either tier.
  - Blur and backdrop effects are budgeted.
  - Reduced-motion and lower quality tiers get calmer versions.
- **Accessibility.** Keyboard focus is visible and styled in the language. Contrast is at least 4.5:1. Typing and scanning motion respects prefers-reduced-motion.
- **Safety and voice.**
  - Untrusted text, such as run summaries and PR titles, is never set with innerHTML. Keep the safe markdown renderer.
  - Screen words stay in Connor's plain voice, with no em dashes, "--" or emojis. With much less text, every word left must earn its place.
- **Tests.** The existing UI tests and screen-word tests stay green, or are updated deliberately with the new words.

## How quality is reached (Connor: "iterate to get the quality bar and then exceed it")

Each screen goes through rounds before Connor sees it:

1. Capture stills with tools/capture.ts.
2. Critique them against this document and CORANTO.
3. Refine.

At least three rounds per screen. Use the frontend-design skill. The Brief begins with two or three directions, as set out below.

## Decided after the builder check

- **Connor's choice: the Brief starts with two or three directions.**
  - Each direction is a throwaway prototype, refined a few rounds on its own branch.
  - Connor gets stills of each and picks one. That is a hard stop.
  - The shared layer (tokens, fonts, panel and control primitives) is built only from his pick, and nothing from a losing direction leaks into it.
  - The directions may differ in type, colour, control shapes and motion, not only in layout.
- **Structure (my call, from the code).**
  - Screens already sit over the city as sheets, with a darkening scrim, and the city keeps rendering behind them.
  - The hologram treatment replaces the scrim and keeps the city live. It does not add a new render path.
- **Anchored readouts (my call).** The city already projects positions to the screen for its name plates (app/src/city/labels.ts). Anchored readouts reuse or extend that, and a small hook in the city code for this is in scope.
- **Copy (my call).**
  - Explanations may be cut outright or moved behind hover, focus or expand.
  - The *-words.ts files and their tests are rewritten with each screen's redesign, not in a separate pass.
  - Connor sees the words in each screen's stills.
- **Performance acceptance (my call).**
  - The baseline is current main measured with tools/perf.ts with each screen open, plus the city alone, on this Mac at both quality tiers.
  - A screen passes if its frame time with the screen open is within 10% of the baseline with the same screen open, and the city-alone numbers do not move. The existing home guard of under 850 calls and 12M triangles still holds.
- **School (my call).** The School redesign reserves the region where the 3D net view will live, so the view can drop in later without reshaping the screen.

## Left to the builder

- The exact fonts, within the type goal and its licence.
- Exact colours and glow, within the colour goal.
- Panel geometry, motion timing and control shapes.
- How readouts attach to the city: which subjects get anchored readouts, and how they track the camera.

## The locked direction (Connor, Nov 20)

Connor picked Direction C, "Targeting", from three directions (A Phosphor, B Hologram, C Targeting). He took it with four changes he saw and approved in a second round. Reference: branch `redesign-brief-c` at 1020db1, stills in docs/superpowers/plans/redesign-stage1/c/ on that branch.

- **The HUD.** The panel is warm black, marked by amber corner brackets and a range rail. A red lock-on is used only for the heaviest action, the autonomy grant, both in the list and on its tower in the city. Controls are targeting reticles. The data-stream texture behind lists stays subtle.
- **Type.** Big Shoulders for display, Azeret Mono for readouts. No tracked capitals (test/no-tracked-caps.test.ts).
- **One set of labels.** While a screen is open, the city's plates give way to the screen's pins. A district with nothing on the screen gets a quiet pin. The plates return when the screen closes.
- **Depth.** Three panes with transform-only parallax: a nearer header, the list, and a back pane. No backdrop-filter on large areas.
- **The top bar** is in this language on every screen.
- **Leader lines** route in right angles and never cross a pin (`routeLeader`).
- **Copy** is cut hard, as in B. A row is a headline plus figures, money sits on the key that spends it, and the full sentence is behind Why.
