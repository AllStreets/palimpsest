# The Brief's baseline, before the redesign

Measured on 2026-11-20 at origin/main 728128e, on this Mac (Apple silicon, Metal), headless Chromium on the GPU, engine on port 4789 with a scratch data home, the sample city and the sample economy seeded.

## Frame times

Tool: `tools/redesign-brief.ts frames` (committed with this file). Window 1512 x 890 at 2x, perf.ts's window. The governor is held (`?fixed-quality`). Each row is 3 runs of 5 s after a settle, read through the debug handle's frameLog; median and p95 over every frame of the 3 runs.

- **City alone:** the city from the overview, no sheet open.
- **Brief open:** the Brief over the screens framing (the city set in the pane right of the sheet), as the app shows it.

### At 60 Hz (vsync on, as Connor sees it)

| Tier | View | Median | p95 |
| --- | --- | --- | --- |
| high | city alone | 16.70 ms | 16.70 ms |
| high | Brief open | 16.70 ms | 16.80 ms |
| medium | city alone | 16.70 ms | 16.80 ms |
| medium | Brief open | 16.70 ms | 16.70 ms |

Every view holds the 60 Hz refresh, so these numbers cannot show a 10% cost. The uncapped numbers below are the ones the directions are held to.

### Uncapped (`REDESIGN_UNCAPPED=1`: vsync and the frame-rate limit lifted, so a frame's time is its cost)

| Tier | View | Median | p95 | Frames |
| --- | --- | --- | --- | --- |
| high | city alone | 8.60 ms | 9.80 ms | 1721 |
| high | Brief open | 8.10 ms | 9.20 ms | 1848 |
| medium | city alone | 4.90 ms | 6.10 ms | 3016 |
| medium | Brief open | 4.60 ms | 5.80 ms | 3147 |

The gate for a direction: Brief open within 10% of these, so at most **8.91 ms median on high** and **5.06 ms median on medium**, and the city-alone rows unchanged.

The Brief open costs less than the city alone here because the screens framing stands farther back than the overview; compare Brief to Brief and city to city, never across.

## Stills

The six stills every direction is judged by, from `tools/redesign-brief.ts stills` (1600 x 1000 at 2x unless named), kept as WebP in `baseline/`:

| Still | What it shows | Review focus |
| --- | --- | --- |
| `brief.png` | The Brief's first screen over the screens framing | |
| `brief-scrolled.png` | The Brief's body scrolled to its end | 1, many items |
| `brief-overview.png` | The Brief over the overview, the city at its brightest framing | 2, the city behind |
| `brief-reduced-motion.png` | prefers-reduced-motion emulated, shot 0.7 s after it opens | 3, reduced motion |
| `brief-autonomy.png` | The autonomy ask (brief-autonomy) scrolled to the top | 4, the autonomy offer |
| `brief-1280.png` | A 1280 x 800 window | 5, narrow window |

The capture tool's own stills on the same build (`CAPTURE_ECONOMY=1 CAPTURE_PORT=4789 tools/capture.ts brief brief-autonomy overview`): `brief.png`, `brief-2.png` to `brief-5.png`, `brief-autonomy.png` and `overview.png`, all written and non-empty (4.9 to 7.0 MB each at 2x). They were kept in the scratch folder, not committed.

## What the baseline shows

- Six items wait, then Handled today, Overnight, Recommended and In the city: a long page, set as a newspaper (Newsreader headlines, IBM Plex for the rest).
- Every action is the same underlined text. The autonomy offer ("Let the city do this on its own here") weighs no more than "Ask why".
- The sheet is a flat dark slab with a scrim over the city; no depth, glow or layering.
