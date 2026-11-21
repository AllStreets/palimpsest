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
