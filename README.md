<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/wordmark-light.png" />
    <img src="docs/brand/wordmark-dark.png" alt="Palimpsest, in capital letters built like its towers: a sandstone root, brick floors, a thin bronze datum band, glass floors with a few lit windows and a brushed titanium crown. One brick floor of the M is left in rust-red primer." width="880" />
  </picture>
</p>

<p align="center">
  <img alt="phase" src="https://img.shields.io/badge/phase_1-standing_city-b98a5e?style=for-the-badge&labelColor=17130f" />
  <img alt="towers" src="https://img.shields.io/badge/towers-one_floor_per_change-9a4a32?style=for-the-badge&labelColor=17130f" />
  <img alt="datum" src="https://img.shields.io/badge/datum-bronze-a8743a?style=for-the-badge&labelColor=17130f" />
  <img alt="tests" src="https://img.shields.io/badge/tests-75_passing-55697a?style=for-the-badge&labelColor=17130f" />
  <img alt="runs" src="https://img.shields.io/badge/runs-on_your_Mac-8f97a3?style=for-the-badge&labelColor=17130f" />
  <br />
  <img alt="three.js" src="https://img.shields.io/badge/three.js-r187-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="engine" src="https://img.shields.io/badge/engine-Node_22_%C2%B7_SQLite-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="GitHub" src="https://img.shields.io/badge/GitHub-gh_CLI-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="macOS" src="https://img.shields.io/badge/macOS-launchd_agent-6e6457?style=flat-square&labelColor=17130f" />
</p>

<p align="center">
  <a href="#reading-a-tower">Reading a tower</a>&nbsp;&nbsp;&nbsp;
  <a href="#moving-through-it">Clips</a>&nbsp;&nbsp;&nbsp;
  <a href="#where-it-stands">Where it stands</a>&nbsp;&nbsp;&nbsp;
  <a href="#run-it">Run it</a>&nbsp;&nbsp;&nbsp;
  <a href="#privacy">Privacy</a>&nbsp;&nbsp;&nbsp;
  <a href="#how-the-pictures-were-made">The pictures</a>&nbsp;&nbsp;&nbsp;
  <a href="#credits">Credits</a>
</p>

<br />

I work across a lot of repos, and their history is mostly invisible. A commit log is a list. It doesn't show you which project stalled for a year, or how much of the recent work was done with an AI.

Palimpsest turns that history into a city. Each repo you connect becomes a district, and its history becomes a tower you can read from the street: the oldest work at the bottom, the newest at the top. Later, AI agent firms will bid on real issues from those same repos and open a pull request once their work passes inspection. Every change they land will raise a floor.

A palimpsest is a manuscript that was scraped and written over for centuries, with every layer still readable. That's what each tower is.

<p align="center">
  <img src="docs/media/hero.webp" alt="The city at dusk from just above the rooftops, looking west into a low sun. Eight founding towers rise out of the ambient blocks, each on its own lit plaza: Beaux-Arts, Gothic, Roman, pagoda and Chicago roots, brick and stone floors, then glass, titanium and a stepped top. The sun catches the corner of the tallest one." width="100%" />
</p>

Everything in these pictures is the real app, rendered by its own engine from sample repos I made up for the purpose. None of them are mine.

<br />

## Reading a tower

<img src="docs/media/tower.webp" alt="One tower from base to top: a Chicago limestone base, a long run of brick floors, glass floors lit warm from inside, and a pale titanium and glass top, with the city falling away into haze behind it." />

A tower is read from the ground up.

The root is real architecture. Each repo gets one of five: a Beaux-Arts colonnade, Roman arcades, a Gothic front with buttresses and a rose window, a Kyoto pagoda base, or Chicago rusticated limestone. Above it, every floor is one change. When I connect a repo, the engine reads its merged pull requests, or clusters its commits into meaningful changes where there were none, so a repo with 2,000 commits doesn't become a 2,000-floor needle. It caps at 120 floors.

The floors are built in eras taken from the repo's own timeline. Its first months are stone, then brick, then steel and glass, titanium, and something closer to science fiction near the present. Floors whose commits were co-authored by Claude are marked as such.

<img src="docs/media/root.webp" alt="Close on a Gothic root at dusk: pinnacles along the parapet, flying buttresses, lancet windows lit from within, and a stained glass rose window over a pointed doorway, on a paved plaza with bollard lights." />

The roots are modelled in code for Palimpsest. The Gothic one has its own pinnacles, buttresses, lancets and a rose window with real stained glass.

<img src="docs/media/datum.webp" alt="The top of a tower: dark glass floors banded with thin lines of light, stepping in toward a bronze band at the very top. Another tower stands to the left, and the city stretches off into the haze." />

The bronze band is the datum line. It marks the height where the repo joined the city. Everything below it is founding history, built from real commits the moment the repo was connected, so a new city never starts at ground level. Everything above it will be floors earned in the market. Today every tower ends at its datum line, because the market isn't built yet.

## Moving through it

A slow flyover of the skyline, into the sun. Click it for the full-quality video.

<p align="center">
  <a href="docs/media/flyover.mp4"><picture>
    <source type="image/avif" srcset="docs/media/flyover.avif" />
    <img src="docs/media/flyover.gif" alt="A slow, low flight across the city at dusk, the founding towers drifting past each other against a low sun and a mauve sky." width="100%" />
  </picture></a>
</p>

Up one tower, from its Beaux-Arts root to its datum line.

<p align="center">
  <a href="docs/media/rise.mp4"><picture>
    <source type="image/avif" srcset="docs/media/rise.avif" />
    <img src="docs/media/rise.gif" alt="The camera rises up a single tower while circling it slowly: past the columns of its Beaux-Arts root, up through stone and brick floors, glass and titanium, and stops at the bronze band at the top." width="100%" />
  </picture></a>
</p>

## Where it stands

I'm building it in five phases. Phase 1, the standing city, is being built now, on the `phase-1` branch.

What works in Phase 1 so far:

- A local engine that runs as a launchd agent on `127.0.0.1:4770`, with its own SQLite store and an append-only ledger.
- Connecting repos through the GitHub CLI, each one switched on separately, with a bare mirror of its history.
- Founding towers built from that history: floors, eras, the Claude marks and the datum line.
- The city itself in three.js: a dusk sky that also lights every reflection, horizon fog, the street grid and the ambient skyline, the five roots and the five floor eras.
- Reading live Claude plan usage through a statusline hook, so the city can later spend only a share of it.

Next in Phase 1 is the tower inspector, where you click a floor and see the change behind it. After that come the Repos and Settings screens and the Tauri app shell.

Designed, and not built yet:

- The market. Firms of AI agents bid on labelled issues and on proposals the city makes itself, the best expected value wins, and the work runs in a fresh worktree inside a `sandbox-exec` profile. It ships as a pull request by default, or a push to main on repos where I turn that on.
- Inspection. A change passes only if the repo's own tests, type check, lint and build all pass and a reviewer from a different firm approves the diff. UI changes are also judged on before and after screenshots. A failed inspection leaves a scar floor in primer.
- Live construction. A crane goes up on the roof when a bid is won, and a steel frame rises in welding sparks while the agent works. During inspection, searchlights sweep the new floor.
- The school, which breeds agents on arenas built from my own repos and fine-tunes small local models on work that passed.
- The nets, small models trained nightly on what actually happened, and earned autonomy for each kind of work.

The full design is in [`docs/superpowers/specs/2026-11-08-palimpsest-design.md`](docs/superpowers/specs/2026-11-08-palimpsest-design.md).

## Run it

You need macOS, Node 22.13 or later, and the [GitHub CLI](https://cli.github.com) logged in with `gh auth login`.

```sh
git clone https://github.com/AllStreets/palimpsest
cd palimpsest
npm install
npm run build
node bin/palimpsest.mjs engine install
```

That installs the engine as a launchd user agent, so it keeps running when the window is closed. It serves the city at http://127.0.0.1:4770. `node bin/palimpsest.mjs engine status` tells you whether it's up, and `engine uninstall` removes it.

To show your Claude plan usage in the city, install the statusline hook:

```sh
node bin/palimpsest.mjs usage install
```

Once the Tauri shell lands, `npm run app` builds the native Mac app. It isn't signed or notarized, so you build it from source.

Your data lives in `~/Library/Application Support/Palimpsest`. Set `PALIMPSEST_HOME` to put it somewhere else.

## Privacy

Palimpsest runs entirely on your Mac. There's no account to make.

The only network calls it makes are `gh` and `git` calls to GitHub, for the repos you connect. Nothing is connected by default.

It never reads your Claude credentials and never offers a Claude login. Plan usage comes from a statusline hook you install yourself: Claude Code already passes your five-hour and seven-day usage to statusline scripts, and the hook writes those two numbers to Palimpsest's data folder. If you already had a statusline script, the hook keeps a backup of your settings and runs your script as before. `usage uninstall` puts things back.

When the market is built, agents will run through your own installed Claude Code, or an API key you add, and never through anyone else's subscription.

## How the pictures were made

Every image and clip in this README was captured from the app, from a separate engine on its own port with a temporary data folder and sample repos I made up. [`tools/capture.ts`](tools/capture.ts) does it. It seeds the sample city and opens the built UI in Chromium on the GPU, at twice the window's density. Then it sets the camera itself for every frame and waits for that frame to render before taking it. Nothing is screen-recorded, so no frame is dropped or repeated. ffmpeg turns the frames into an MP4, an animated AVIF for this page, a small WebP for my profile card and a GIF fallback.

```sh
npm run build
node --no-warnings --import tsx tools/capture.ts          # hero, stills, flyover, rise
node --no-warnings --import tsx tools/capture.ts rise     # just one
```

The wordmark and the app icon are rendered in Blender from [`docs/brand/wordmark.py`](docs/brand/wordmark.py) and [`docs/brand/logo.py`](docs/brand/logo.py). The letters are cut into floors the same way the towers are, and use the same scanned stone, brick and rust textures as the app.

## Credits

The stone, brick, metal, paving and rust textures are CC0 scans from [Poly Haven](https://polyhaven.com). The wordmark is set in [Cinzel](https://github.com/NDISCOVER/Cinzel) by Natanael Gama, under the SIL Open Font License. Everything else is written for Palimpsest. [CREDITS.md](CREDITS.md) lists every asset, its author and where it's used.
