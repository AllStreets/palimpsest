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
