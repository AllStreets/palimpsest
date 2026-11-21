# Screens redesign, stages 2 and 3: critique

One section per visual task. Each round names what is weak in the stills, what changed, and whether anything is left at the anti-goal level (spec, "Anti-goals").

## Task 3: type and colour

Stills: `stills/task-3/type.webp`, `type-1280.webp`, `type-reduced-motion.webp` (the final round). Shot with `tools/os-stills.ts type` over the screens framing, the gallery standing where the sheet stands, on the panel's ground at its thinnest (alpha 0.86) over the city.

### Round 1

1. **The dim ink was muddy.** Labels ("credits", "merged", the roles) in `dim` #a48f78 at 12px measured 4.7:1 on the worst ground. That passes, but over the lit city behind the panel they read as brown smudge, and Azeret's regular weight at 12px is thin. Anti-goal level: low quality.
2. **The figures did not line up.** Each value sat in its own flex cell with a fixed 6ch minimum, so "11" and "7" left a hole before their units, and "of 50%" wrapped under its value. Anti-goal level: looks like it was done in simple code.
3. **Azeret read as tracked.** Azeret Mono is set wide. At 12 to 13px the labels ("Type and colour", "brackets, focus") read as spaced-out letters, close to the tracked look the no-tracked-caps rule exists to stop.
4. **The headline was cramped.** Big Shoulders at 30px and weight 600 sets very tight, and the second line crowded the first.
5. **The specimen opened over the Brief.** The app reopened on a screen, so the first shot showed the old Brief through the ground. That is a harness fault, not a type one: os-stills now goes to the city first.

Changes: `dim` raised to #b09b84 (5.4:1 on the worst ground, still well under `ink2`'s 7.2:1, so the three inks keep their order). Small mono labels set at weight 500. `.os-figs` (tokens.css) carries `font-variant-numeric: tabular-nums` and `letter-spacing: -0.02em`, and the gallery's mono text the same tracking. The headline gets 0.01em. The figures became a grid of value and unit pairs, each value right-aligned in its own column. The gallery stands at the sheet's z-index under the top bar.

### Round 2

1. **The units drifted from their values.** `justify-content: space-between` spread the eight columns over the measure, so "963.24" and "credits" sat a column apart. The pairs must hug.
2. Dim now reads cleanly as a label. Tabular digits line up down both rows (963.24 over 120.08, 11 over 7, 06:40 over 19:52). The tracking reads as type, not as spacing.

Changes: the columns pack to the start with 8px between value and unit and 32px before each next value.

### Round 3

1. **At 1280 the figures ran out of the panel.** The 600px panel cut "since" at its edge, and the colour roles wrapped onto two lines. Anti-goal level: low quality.
2. **Focusing the ring scrolled the gallery** under the top bar once the content was taller than the window.
3. At 1600 the specimen holds: the date in Big Shoulders 800, the headline, two rows of Azeret figures in amber-hi, every token named in its own ink with its ratio on the worst ground, and the four amber corner ticks of the focus ring on the look key.

Changes: below a 1400px window, the figures draw closer (22px, 18px values) and the swatches drop their role column. The ring focuses with `preventScroll`. A last shot confirmed both; the date wraps to two lines at 1280, which reads as intended at that width.

### Left, below the anti-goal level

- `red` is the lowest ink at 4.6:1. It is the lock's and the grant's alone and is always set at weight 600 or more; Task 6 should keep it off small text.
- The ground swatch is drawn as an outline, because ink on itself has nothing to show.
- The gallery panel is a plain field of ground with no brackets or depth. That is Task 5's panel, not this specimen's.

## Task 4: type-in and scan

Stills: `stills/task-4/type.webp`, `type-1280.webp`, `type-reduced-motion.webp`, from `tools/os-stills.ts type`, plus `type-mid-180.webp` and `type-mid-420.webp`: the top of the panel 180 ms and 420 ms after Replay, from a one-off scratch script on the same harness, to show the motion part way. In `type` the headline types in and the figures take one scan, on mount and on Replay.

### Round 1

1. **The typing moved the page.** The headline typed onto one line and then wrapped to two, so the figures, the Replay key and the swatches below jumped down 66px part way through. A type-in that reflows reads as broken. Anti-goal level: looks like it was done in simple code.
2. The scan reads as intended: one amber hairline with a 7px tick at each end, and a faint 56px wash trailing behind it. No band, no glitch.

Changes: `.os-type-hold` (motion.css) stacks the whole line, unseen, in the same grid cell as the typed text, so the line is its full size from the first frame.

### Round 2

1. The 180 ms frame shows "Eleven merged overnight" typed with the space for both lines held; the figures sit where they will stay. At 420 ms the second line is part typed and the hairline is past the last column, about to fade.
2. **Reduced motion, at 0.7 s:** the headline is whole ("Eleven merged overnight. Six wait on you, and one asks for the city.") and there is no cursor. Checked in `type-reduced-motion.webp`.
3. At 1280 and 1600 the finished state matches Task 3's specimen, with the Replay key added under the figures in dim.

### Left, below the anti-goal level

- The cursor layer starts one host-width to the left of its host at opacity 0. In a host without overflow clipping, the trail's first frames could show just left of the host while the opacity rises. Not visible in the gallery.
- aria-label on a paragraph or a generic span is not reliably read by screen readers. typeIn sets it as the brief asks; T17 should put typed text on an element that can carry a name, or rely on the text itself once it is whole.

## Task 5: the panel, its three panes, parallax and the stream

Stills: `stills/task-5/panel.webp`, `panel-1280.webp`, `panel-reduced-motion.webp` (the final round, round 2), and `panel-round1.webp`. Shot with `tools/os-stills.ts panel`, the GPU lock held: a sample sheet dressed by `dressPanel`, its head the date, a since line and three figures, ten placeholder rows in its list, and the stream made from the rows' own repo names and figures. The pointer is parked outside the panel, so the panes are at rest; parallax never shows in a still.

### Round 1

What works:
- The head reads as the nearest plate: proud of the panel at the left by 14 px with its own amber ticks, lit along its top and left, a hairline at its foot, and a shadow cast down and right onto the list.
- The panel is dark enough over the city: headlines, figures and the dim labels all read cleanly, and the lit towers at the panel's right edge do not come through. The ground is 0.95 at the left and never thinner than 0.86 (GROUND.textMinAlpha) at the right.
- The stream reads as words falling, not a font sample: "harbor-ledger", "benched", "#312" can be read down the columns, faint (the brightest column is at 0.138 opacity), strongest at the right under the figures.
- The scrim is only a shade where the panel stands; the city to the right stays clear.

Weaknesses:
1. **The back pane reads as a stray strip** beside the rail: 26 px proud of the panel's right, its foot off the bottom of the window, its fill so thin it reads as a shadow, not a pane. This is round 7's weakness again.

### Round 2 (final)

Changes: the panel stands 36 px off the window's foot, so the back pane's lit foot shows; the back pane stands 44 px out at the right and 24 px below, with a denser fill (0.72 to 0.86), brighter lit edges on its right and foot, a faint glow just inside them, and its ticks set 6 px in from its lit edge so the two lines do not sit a pixel apart (round 8's stub-column note); the panel casts harder to the right onto it.

What the stills show:
- Three depths in a still at both sizes: the head plate nearest, the panel with its brackets and rail, and the back pane behind, a distinct dark pane with a lit right edge and foot, the panel's shadow falling on it.
- panel-1280: the same composition, the back pane and its foot clear of the window edge.
- panel-reduced-motion: the stream stands still part way down, no scan ran, the panes at rest. Everything reads whole.

### Left, below the anti-goal level

- Under reduced motion each stream column stops at a quarter of its fall, so the foot of the list has fewer streaks than its top. It is decoration under 20% opacity; not worth a different still layout.
- The head's shadow onto the list is quiet over the panel's own dark ground. It shows clearly once rows scroll under the head (T6 onward will show it).

## Task 6: the shaped control in its weights

Stills: `stills/task-6/controls.webp`, `controls-1280.webp`, `controls-reduced-motion.webp` (the final round, round 3), `controls-1280-round1.webp`, `focus-spend-round2.webp`, and `focus-sheet.webp`, `hover-look.webp`, `hover-spend.webp`. The first three are from `tools/os-stills.ts controls`; the focus and hover crops are from a one-off scratch script on the same harness, which focuses each weight's `data-gallery-focus` key in turn (keyboard focus can be on one key only, so the gallery itself focuses the grant's). The GPU lock was held for every shoot. The `controls` kind shows each weight, lightest to heaviest, at rest, focused, disabled and busy, with `spend` carrying "60 cr".

### Round 1

What works:
- **The grant reads heaviest at a glance.** It is the one filled red key: 40 px tall, Big Shoulders 800 at 19 px in the ground's dark ink, the seal at its left, a red reticle 7 px out with a red glow. Nothing else in the panel is red.
- **Looking reads lighter than any framed key.** "Fly there" is a cold ice word in weight 500 with no frame at rest; decide has amber ticks and a faint fill; spend is a lit amber key with a 2 px reticle and its sum in a dark window.
- The order of weight is legible down the page without the labels: word, framed word, lit key, hot key.
- Disabled and busy keys dim to 0.45 and keep every part of their shape, reticle and sum included.

Weaknesses:
1. **At 1280 the grant's disabled and busy keys stand below the window's foot.** The gallery scrolls, so nothing clips, but a still at 1280 does not show the whole set.

Changes: under 1400 px, the spend states go two by two and the bands, labels and state gaps draw closer.

### Round 2

1. At 1280 every key and its state label is in the window, grant's busy key included (`controls-1280.webp`).
2. Focus, each weight in turn: the amber ring stands outside each key's own reticle. On look the ice ticks arrive from 4 px out and settle 1 px off the word, with the ring at 6 px: a lock-on, not a box. On decide the ticks close in by 2 px and the ring stands at 7.5 px. On the grant the ring stands at 16 px, clear of the breathing reticle at its widest (11 px).
3. **On spend the ring sat 6 px outside an amber reticle of the same colour** and read as a thicker, blurred bracket rather than a second frame (`focus-spend-round2.webp`). The focused key looked heavier, not focused.
4. Hover: look's ticks show and the face takes a faint ice wash; spend's reticle closes in and the face brightens. Both by opacity and transform only.

Changes: the spend key's ring stands at 13 px.

### Round 3 (final)

- Spend focused now reads as two distinct frames: the key's own heavy reticle, and the thin amber ring well outside it (`focus-sheet.webp`).
- At 1600 and 1280 the composition holds and nothing clips; the reduced-motion still is whole at 0.7 s, its reticle at rest and its seal still.

### Left, below the anti-goal level

- Disabled and busy look the same, as the brief asks ("they dim, and they keep their shape"). Busy shows a progress cursor and holds the grant's breath; a still cannot tell them apart.
- (Fixed in review, below.) The disabled grant was red and filled at 0.45 opacity.
- When a caller sets an aria-label on a key (the Brief does), the sum in the window is not part of the name the reader hears. T17 should fold the sum into that label.

### Review fix: the keys' words on their own faces

A new test (`test/os-tokens.test.ts`) reads each weight's ink and fill from control.css through the tokens and holds the words at 4.5:1 on their own face, at every gradient end, over the panel at its thinnest on white. It found one failure: the dimmed grant's dark ink on red at 0.45 opacity was 2.04:1. The dimmed grant no longer dims by opacity. Its face darkens to 40% red in the ground, its glow goes out, its words turn ink2 (5.48:1), and its reticle dims to 0.45. The re-shot `controls`, `controls-1280` and `controls-reduced-motion` show it: still the grant's shape and the only red face, plainly not lit, its words legible.

## Task 7: readouts and figures

Stills: `stills/task-7/readouts.webp`, `readouts-1280.webp` and `readouts-reduced-motion.webp` (round 2, final), and `readouts-round1.webp`, all from `tools/os-stills.ts readouts` with the GPU lock held. The `readouts` kind shows a row of head figures (6 waiting, hot; 11 merged; 963.24 credits) with a line of readouts under it (one readout with an empty figure, left out), two rangefinders (five-hour at 44.83% under a 50% limit, and seven-day at 62%, over it), the two agreement scales (48 of 50 over every repo, and 10 of 10 here), and a claims bar with all five verdicts.

### Round 1

What works:
- **The two scales cannot contradict each other** (stage 1 round 1's fault 5). Each is its own row with its own count: "48/50" over its strip of 50, and "10/10" over a strip of 10. The two share one tick pitch, 5 px, so ten here stands a fifth as long as fifty everywhere and plainly is not a slice of it. The misses are drawn as two hollow ticks at the newest end of the 50 alone. Here is lit in amberHi and every repo in amber, so they read as two measures.
- **Labels hold to one line** (stage 1 round 2's wrap). "Last 50, every repo" and "Last 10, here" sit under their strips, `white-space: nowrap`, at 1600 and 1280. "Here" is not squeezed into a strip's width any more.
- Figures are Azeret in tabular numerals and labels Big Shoulders in sentence case, all through. The hot figure is amberHi with a soft glow, and nothing on the page is red: the cap is an ink bracket, and misses and broken claims are hollow in the fail ink.
- The rangefinder's run, head and cap read at a glance. The run is drawn in by `transform: scaleX`, so a later reveal can move it on the compositor.
- At 1280 everything fits, and the reduced-motion still is whole at once (nothing here moves).

Weaknesses:
1. **An over reading barely says it is over.** Only the "62%" turns warn. The run passes the bracket, but the words "limit 50%" stay dim, so the line reads as a number and a limit rather than a limit broken.
2. The "missing" segment is a dim outline on the panel and could be taken for empty track. The key under the bar names it, so it stays.

Changes: on an over reading the limit's words turn warn with the figure, as the bracket already does.

### Round 2 (final)

- Seven-day now reads "62% limit 50%" all in warn, with a warn bracket the run has passed. It is over without a word "over" and without red.
- Nothing else moved. 1600, 1280 and reduced motion hold.

### Left, below the anti-goal level

- The agreement scales need the size of the run here, not only the count agreed. `agreementScales` takes `hereOf` (10 or fewer) beside `here`, so fewer than 10 decisions show as a shorter strip ("3/4", "Last 4, here"), and none says "None here yet". Task 15's `BriefFigures` autonomy shape has `here` alone, so T15 must add `hereOf` (or T17 must find it) for the ask to be honest.
- (Fixed in review, below.) The rangefinder's aria-label did not say "over" in words.

### Review fix: over, said and shown

Review found that over reached the reader only through a class and the eye mostly through colour. An over reading now ends its aria-label with ", over the limit" ("seven-day window 62%, limit 50%, over the limit"), and the label under the cap is unchanged. On the screen the word "over" stands in warn between the figure and the limit, in Big Shoulders 700. The readout.css contrast test covers it (warn, 4.5:1 or more on the thinnest panel). The re-shot `readouts`, `readouts-1280` and `readouts-reduced-motion` show "62% over limit 50%" on one line.

## Task 10: city pins and the lock-on

Stills: `stills/task-10/pins.webp`, `pins-1280.webp` and `pins-reduced-motion.webp` (round 3, final), with `pins-1280-round1.webp` and `pins-1280-round2.webp`, all from `tools/os-stills.ts pins` with the GPU lock held. The `pins` kind is the dressed panel with six sample rows over the screens framing. Three rows are targets over two districts: row 1 (harbor-ledger) takes the lock, row 2 (fieldnotes) is the grant, and row 4 shares fieldnotes, so its pin reads "02 +1". Row 6 names a district not built yet, which gets no pin. Every other standing district gets a quiet pin.

### Round 1

What works:
- **One set of labels.** The city's own plates are gone while the pins show, and every tower is named once: two numbered pins, quiet names elsewhere.
- **The leader** leaves the panel's rail at row 1, climbs at the pane's edge, crosses the sky above the skyline and drops onto the ring from above. It crosses no tag, stem or the telemetry.
- **The lock tag is whole at 1280.** Near the right edge it flips up and left of the ring, and the leader comes down past its right edge.
- Red appears only on the grant pin's mark, rule and number. The lock on an ordinary item is amber.
- Nothing collides: quiet "assay-kit" and "kumo" stand close but apart.

Weaknesses:
1. **At 1280 the leader left at row 2, not row 1.** The row's middle was read once, before the faces arrived and the rows reflowed, and nothing read it again.
2. The shared-district label never showed: the shared district was also the locked one, and a locked pin gives way to the lock.

Changes: the row's middle is read again when the list's layout moves it (a ResizeObserver on the list and the active row, and the fonts' loadingdone). The shared row now shares the grant's district.

### Round 2

- The leader now leaves at row 1 at both sizes, and "02 +1" reads on the grant's pin.
- But the districts were picked by where their towers projected at mount, while the camera was still easing into the framing. So the lock went to a short tower in the middle (blank-slate), and the stills changed between runs.

Change: the gallery prefers the sample city's harbor-ledger, fieldnotes and quarry where they stand in view, and falls back to the projection pick.

### Round 3 (final)

- 1600, 1280 and reduced motion hold. The leader is a five-point route (rail, stub, sky channel, the tower's line, the ring). Reduced motion shows the same frame, with the brackets already closed.

### The detour ruling

The router can find seven-point detours: it changes channel once past a wall. Laid over a live skyline, a leader that steps twice through the sky reads as noise, not as a line naming one tower. It is also the case most likely to brush another tag's stem. So pins.ts caps the route at 5 points (`maxPoints: 5`), and where only a detour would do, the lock alone names the tower. The search is also capped at 20k considers (a pathological layout returns null in about 6 ms, against 315 ms uncapped).

### Left, below the anti-goal level

- The lock tag is a fixed 200 by 56, so a short name leaves dark room on the right. The fixed size is what the router keeps clear of; a measured size would need one more read.
- The leader's stub, from the rail to the first column, runs under the panel's back pane, so the line seems to rise from the back pane's edge. It reads as leaving the pane, which is what the brief asks.

## Task 11: the top bar

Stills in `stills/task-11/`: `topbar` (over the city) and `topbar-jobs` (over the job board), at 1600 and 1280, each whole and cropped to the head, and `topbar-focus-crop` (Find focused from the keyboard, School hovered, Jobs current).

### Round 1

- It reads as an instrument head, not a book's title line (round 7). The name is upright and heavy in Big Shoulders, closed off from the places by a tall amber tick. The places are set in the same condensed face, and the ruled tape runs under them like a gauge's scale.
- The current place is held in four amber corner ticks, with its word lit, so it is never marked by colour alone.
- Find is a cold ice key. Its ticks show faintly at rest, and ⌘K sits in its own dark window.
- Over Jobs, the condensed 17 px places sit under the 60 px Newsreader title without fighting it. The head is lighter than the title and heavier than the filter row, so the three steps read in order. The backing runs across the sheet's top, in the sheet's own near-black, so no band shows there.
- Over the city, the backing is a dark band that fades down and to the right before the skyline. It is a touch heavier than main's, because the ground is the screens' ground at 0.84.

Weakness: the hover ticks were amber at 0.4. With Jobs current and School hovered, two places sat in amber ticks, and School read as a second current place (`round1-topbar-focus-crop.webp`).

Change: the hover ticks are now drawn in the dim ink, not amber.

### Round 2 (final)

- A hovered place now shows grey ticks, and only the current place is amber. The focus ring (the amber .os-focus corners) stands outside Find's own ice ticks, so focus reads as a second, outer frame.
- 1600 and 1280 both hold. At 1280 the head ends at about 1145 px, clear of the right edge.

### Left, below the anti-goal level

- The stone mark is the old bronze PNG, in a thin amber ring. A mark redrawn for the new language would sit better, but that is brand work, not this task.
- Over the city, the backing's right fade passes over the sky as a soft edge. It cannot be shorter, because Find must stay on the full-strength ground.

## Task 12: terminal mode

Stills in `stills/task-12/`: `terminal`, `terminal-1280` and `terminal-reduced-motion` (round 2, final), and `terminal-round1`, all from `tools/os-stills.ts terminal` with the GPU lock held. The kind opens the terminal from its "Run log" look key over the screens framing, with an 80-line sample run log.

### Round 1

- The city is far behind but present: a dark, soft skyline with the tall tower's line still readable at the right. It reads as the place you came from, not as noise.
- The words are crisp. Azeret Mono in amber on a near-black ground, the times in dim figures, no glow, no scanlines, no curvature. It reads as a log, not a CRT.
- The panel stands 64 px under the top, so the running head stays whole above it, and 16 px over the foot.

Weakness: the filler batch lines took the "ok" green every ninth line, so a run of identical lines flickered green at random and the eye looked for a reason. And the title, in amber-hi at the body's weight, barely separated from the log.

Changes: filler lines carry no tone (only the steps that pass or fail are toned), and the title is set at 600.

### Round 2 (final)

- The tones now mark only the six lines that mean something: the tests that pass, the one that fails on purpose. The title reads as the head of the log.
- 1280 holds: the 880 px column leaves the opener clear at the left.
- Reduced motion: the panel and the blur are there at once, the title whole.

### Frames (uncapped, same sitting, `tools/redesign-brief.ts frames`, 1512 x 890 at 2x)

| | main Brief | branch Brief | terminal, full scale | terminal, half scale |
|---|---|---|---|---|
| high, pair 1 | 8.00 | 8.40 | 9.10 (+13.8%) | |
| high, pair 2 | 7.80 | 7.80 | | 9.10 (+16.7%) |
| medium, pair 1 | 4.60 | 4.80 | 6.60 (+43.5%) | |
| medium, pair 2 | 4.60 | 4.60 | | 6.20 (+34.8%) |

Medians in ms, percentages against main's Brief row of the same pair. A third branch run between the pairs gave 9.50 high and 6.00 medium at half scale.

With the named half-scale fallback in, the gate still failed at both tiers. A probe (high, screens framing) showed why: any filter on the city host costs the same, blur or not (12.5 ms with the full filter, 11.2 ms with only brightness and saturate, against 7.7 to 8.0 ms with none). The cost is the compositor drawing the full-window layer through a filter at device resolution, not the blur kernel and not the city's own drawing, so halving the render scale wins back only 0.4 to 1 ms. The half scale is kept (the 6px blur hides it, and it is the cheaper of the two), and the gate is handed back to the controller: the next lever would be holding the city's frames while the terminal stands over it, so the filtered layer is drawn once.

### Fix round 1: the city holds still behind the terminal

Ruling: stop redrawing the city while the terminal is open. The half-scale fallback is removed (it rebuilt the post chain and restarted the lens). `City.hold(on)` skips the whole update and draw while held, keeps the clock running, and draws one frame after each resize; the terminal holds the city once the blur has eased in (MOTION.slow; at once when still) and releases it on every close. The stills are reshot held (`terminal.webp`, `terminal-1280.webp`, `terminal-reduced-motion.webp`): the frozen city reads exactly as the moving one did, blurred and dim far behind.

Frames, uncapped, same sitting (main at 9b31df4 first, then the branch), medians in ms:

| | main Brief | branch Brief | terminal, held |
|---|---|---|---|
| high | 7.90 | 8.00 | 18.40 (p95 18.80) |
| medium | 4.60 | 4.60 | 18.40 (p95 18.80) |

City alone: main 8.70 high, 4.90 medium; branch 8.60 and 5.00.

The 18.40 is not cost. With nothing drawing, Chromium's uncapped mode has no damage to pace frames by, and the requestAnimationFrame interval falls to its idle cadence: the same 18.4 to 18.5 ms with the city held and no filter at all, at both tiers alike. Capped at 60 Hz (the probe), the city, the held terminal and the held city without a filter all sit at 16.70 ms, p95 16.70. The uncapped interval stops measuring work once there is none to do; the work per held frame is nothing but composite.

### Left, below the anti-goal level

- The log's last visible line is cut by the panel's foot. It is a scroller, so it is honest, but a short fade would read softer.

## Stage 2 gate

Run at 4a52e48 (the screens redesign merged with main's ui-test fixes). Stills: `stills/task-13/` (type, panel, controls, readouts, pins, terminal, topbar; the 1280 and reduced-motion variants were shot and read, not committed).

### Checks

| Gate | Result |
|---|---|
| npm test | 2387 pass, 0 fail, 2 skipped (2389) |
| typecheck, build | clean |
| ui-test (full) | "ui-test passed" |
| Home guard (perf, high) | 630 calls, 8.77M triangles (under 850 and 12M) |
| Home guard (perf, medium) | 514 calls, 5.44M triangles |
| Perf live home, 10 s | mean 16.67 ms, 0 of 599 over 20.8 ms |
| City alone, uncapped, high | main 8.70 / 8.70 ms, branch 8.60 / 8.70 (two sittings), within 3% |
| City alone, uncapped, medium | main 4.70 / 4.80, branch 5.40 / 4.80 |
| Brief open, uncapped, high | main 7.80 / 7.80, branch 7.80 / 7.80 (0%) |
| Brief open, uncapped, medium | main 4.70 / 4.50, branch 4.70 / 4.60 (0 to +2%) |
| Terminal, capped 60 Hz | 16.70 ms, p95 16.80, both tiers, same as city |
| Terminal, city draws while held | zero: ui-test "the city holds still behind the open terminal" passes |

The first medium branch city-alone run read 5.40 ms (+15%). It was one noisy sitting: run again in the opposite order, branch 4.80 against main 4.80 (4.70 in the first pass), so within 3%. Recorded rather than dropped. The Brief is unchanged so far, so its row is a pure check of the layer's idle cost.

Uncapped terminal rows (18.40 ms) are not used, per the Task 12 ruling.

### Set critique

The six primitives read as one language: Big Shoulders for names and headlines, Azeret Mono for figures, one amber ink, corner brackets on every key, pane and pin, hairline rules, a single red reserved for the grant. The key weights climb visibly from look (bare text) to decide (outlined) to spend (outlined with its sum) to grant (the only filled red). The readouts are instruments (rangefinder with its limit mark, tick-bar agreement, claims strip), not tiles or cards: no rounded boxes, no shadows, no gradients. Nothing reads as a dashboard kit. No anti-goal failure, nothing fixed here.

### Left open (below the gate)

- The deferred minors from Tasks 1 to 12 stay open (motion lint scope, os-stills out dir before home check, stills dated by new Date(), kind list duplicated, scanOnce timer, lean on a still pointer, permanent will-change on panel panes, fixed 18 stream columns, the --os-sheen type mix, disabled hover wash, label capitalisation, districts() allocation, pin lift layout rewrites, T12 hold race and stale text).
- The terminal gate has no direct draw counter; it relies on the ui-test held flag.
- Branches redesign-brief-a and redesign-brief-b, with their worktrees, are not yet deleted (the deletion was blocked by the permission classifier).

## Task 17: the Brief on the shared layer

Stills: `stills/task-17/`, shot with `tools/redesign-brief.ts stills` on the sample city and the CAPTURE_ECONOMY economy (port 4789, a scratch home, the GPU lock held for every shoot). Eight stills a round: `brief`, `brief-scrolled`, `brief-autonomy`, `brief-overview`, `brief-closed`, `brief-1280`, `brief-reduced-motion` and `brief-why-long`. The last is Review Focus 5: the PR waiting for review is given a 240-character title with `<b>` and `&amp;` in it and a 600-character markdown summary, seeded into the scratch home, and Why is opened on it. The committed stills are round 4's (final), with `brief-round1.webp`, `brief-1280-round2.webp` and `brief-scrolled-round3.webp` for the weaknesses named below. Judged against the spec's goals and anti-goals, CORANTO's bar, the Stage 1 Review Focus and C's final stills (branch `redesign-brief-c`, 1020db1).

### Round 1

The first build on the layer: the dressed panel, the head (the day, the since line typed in, the three figures, both rangefinders as one link to the treasury), the four ledgers with their section heads and counts, each row a designator, where and when, the headline, its readouts and its weighed keys, the ask in red brackets with its two agreement scales, and the pins over the city.

What works:
- **One language with the stage 2 primitives.** Big Shoulders headlines, Azeret figures, amber designators in corner ticks, the keys climbing from the ice Why to the lit Post with its sum in a window. Nothing on the Brief is in Plex or Newsreader.
- **Review Focus 5 holds.** The 240-character title reads `<b>nightly</b>` and `&amp;` as text and is clipped by the layout at three lines with an ellipsis; the summary keeps its list and code marks, the markup in it shown as text, and ends inside its own window. Nothing runs off the panel.
- **The pins** stand on every waiting tower with numbers that match the rows; the plates are gone, and `brief-closed` has them back in full.
- Reduced motion reads whole at 0.7 s: the since line is set at once, the stream stands, the brackets are already closed.

Weaknesses:
1. **The autonomy ask is sixth.** The engine lists it after the proposals, so on the first screen the heaviest decision is below the fold: the lock sits on harbor-ledger's tower with no leader, because its row is scrolled out. The heaviest thing on the screen is not on the screen. (Review Focus: the ask as the heaviest thing.)
2. **The keys stand in the engine's order** (Post, Tier, Dismiss, Why), so the key that spends sits mid-row with a second lit key beside it, and the row ends on a light ice word. C ended each row on its heaviest key.
3. **The ask's evidence reads as a form.** The two agreement scales stack, each count over a short label, so "48/50" is no bigger than a row's figure. C set the run on one line, the count large; here the ask's case is smaller than its headline.
4. **Handled rows waste a line.** A settled row is its headline, then a nearly empty line holding only Why and "Posted 18:30" at the far right.
5. **The audit's explanation is a three-line paragraph in the list** under Recommended: the excessive text the spec cuts. The Audit key carries its sum, and Why carries the rest.
6. **At 1280 the head eats 340 px of 800.** The rangefinders wrap under the figures, so only two rows of the list show under it.
7. Tier and Post are both spend keys (the ruling), so a proposal shows two lit amber keys side by side. Left by the ruling; ordering (2) at least puts Post at the edge.

### Round 2

Changes: the autonomy ask leads Waiting on you (the open asks first, then the rest in the engine's order; nothing else moves); the keys stand lightest to heaviest, so a row ends on its heaviest key; the two agreement scales stand on one line, each count at 30 px in amber beside its strip; a handled row is one line, its keys and acted time beside the headline; the audit's explanation is for the reader alone (`.os-sr`), the Audit key and its sum saying it on the screen; the head's figures and rangefinders hold one line down to 1280.

What works:
- **The ask is the heaviest thing on the first screen**, at 1600 and 1280: raised on its own shadow, closed in red brackets, its grant the one red, filled object, and the lock and leader on harbor-ledger's tower, the leader leaving the ask's rail, climbing at the pane's edge and dropping onto the ring. This is C's brief-autonomy, now the first still.
- Each row ends on its heaviest key: Resume with its sum, Audit with its sum, Let it act here.
- At 1280 the head is 270 px, the ask and the first proposal both in view.

Weaknesses:
1. **On a proposal the row ends on Tier, not Post.** Both are spend keys (the ruling), and the engine lists accept first, so the stable sort leaves Tier at the edge and Post, the key that spends, inside.
2. **At 1280 the ask's run here is clipped** past the panel's right edge ("Last 10" cut): the four-column line does not wrap.
3. **Rows with no figures still take two lines** (a note, a failed job's Why and Dismiss): the keys stand alone under the headline, far right, the rows twice the height they need.
4. A pin's tag near the window's right edge (harbor-ledger, "01 +2", in `brief-why-long`) stands within a few pixels of it. pins.ts places it; below the anti-goal level, left to the layer.

### Round 3

Changes: of two keys of one weight, the one carrying a sum stands last, so a proposal ends on Post and its 60 cr; the agreement scales are two groups that wrap, the run here taking the next line where the panel is narrow; a row with no figures is one line, its keys beside the headline.

What works:
- Every row ends on the key that spends or grants: Post 60 cr, Resume 20 cr, Audit 40 cr, Let it act here. Read down the right edge, the column is the page's decisions in order of weight.
- At 1280 the ask's two runs stand whole, one over the other, inside the brackets.
- The overnight ledger is shorter: a note is one line, its Why and Dismiss beside it.

Weaknesses:
1. **A one-line row's headline steps 16 px right of every other headline** (`brief-scrolled`, "Docs: name the SQLite version the crate needs"): the third column's gap was set on the whole grid, so it also opened between the designator and the text. A broken left edge in a list read for its alignment.
2. Under the anti-goal level and left as is: the award paragraph behind Why is a long mono line at 12 px (the whole sentence is what Why is for); the pin tags are the layer's.

### Round 4 (final)

Change: the gap before the keys of a one-line row is padding on the keys' own cell, not a gap of the grid, so every headline in the list starts on one edge.

What the final stills show, against C's final round:
- **brief**: the ask first, in red brackets on its own shadow, its two runs on one line (48/50 every repo, 10/10 here) and Let it act here the only red, filled object; the lock on harbor-ledger's tower and the leader from the ask's rail, up the pane's edge, across the sky and down onto the ring. Then the proposals, each ending on Post and its sum, the PR with its three look keys, the halt ending on Resume 20 cr. As C's brief-autonomy, with the ask now where the page opens.
- **brief-scrolled**: the rows slide under the head plate; the overnight notes are one line each; Recommended ends on Audit 40 cr; Today's limit shows its two figures and Set limit. No paragraph is left in the list.
- **brief-overview**: over the city's brightest framing the panel holds, the head plate and every figure legible; the lock and leader on harbor-ledger, close.
- **brief-1280**: the head at 270 px, the ask whole with its runs on two lines, the first proposal in view.
- **brief-reduced-motion**: the same page whole at 0.7 s, the since line set at once, the brackets already closed, the stream still.
- **brief-why-long**: the 240-character title as text and clipped at three lines; Why open with the award line typed in and the summary in its own window, revealed by the sweep, its markup and entities as text, clipped at its 600 characters by the renderer and inside the panel.
- **brief-closed**: the plates back in full, no pin left.

Against C: the same HUD, keys and ask; the real build adds the since line in ice, mono head figures, two lit rangefinders that lead to the treasury, the claims bar on a finished audit, and one-line rows where there are no figures. C's pin figure for a proposal was its cost; here it is the first readout (the tier), as the plan sets it.

### Left, below the anti-goal level

- The pin's figure on a proposal reads "normal tier", not the cost: the plan names the first readout as the pin's figure, and the cost is a key sum, never a readout (Task 16). If Connor wants the cost on the tower, it is one line in `pinTargets`.
- A tier change is a spend key (the ruling), so a proposal shows two lit keys, Tier and Post. Post now stands at the edge.
- A pin's tag near the window's right edge can sit within a few pixels of it (pins.ts, the layer's placement).
- The award paragraph behind Why is a long mono line; that is what Why is for.
- Motion never shows in a still: the since line typing in, the ask's brackets closing, the summary's sweep and scan, the stream.

### Frames (uncapped, `tools/redesign-brief.ts frames`, 1512 x 890 at 2x, the GPU lock held)

Main is 29187f0 in a detached worktree; the branch is this task's build. Two sittings, back to back.

| Tier | View | Main, sitting 1 | Branch, sitting 1 | Branch, sitting 2 | Main, sitting 2 | Delta (sitting 2) |
| --- | --- | --- | --- | --- | --- | --- |
| high | city alone | 8.60 (p95 9.80) | 11.50 (p95 12.80) | 8.60 (p95 9.80) | 8.60 (p95 9.70) | 0% |
| high | Brief open | 8.10 (p95 9.10) | 9.90 (p95 11.60) | 7.80 (p95 8.90) | 7.80 (p95 8.80) | 0% |
| medium | city alone | 4.90 (p95 6.00) | 5.70 (p95 6.60) | 4.80 (p95 5.90) | 4.80 (p95 6.20) | 0% |
| medium | Brief open | 4.50 (p95 5.90) | 4.90 (p95 5.60) | 4.40 (p95 5.20) | 4.50 (p95 6.40) | -2% |

Sitting 1's branch run was slow on every view, the city alone included (+34% on high, where the Brief is closed and nothing of it draws), while Spotlight indexed the stills just written (fseventsd and mds_stores at 100% CPU). Run again at once in the opposite order (branch first), the branch matched main on every row. Recorded rather than dropped. The Brief open holds main's frame time at both tiers, inside the 10% gate.
