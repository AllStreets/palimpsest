<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/wordmark-light.png" />
    <img src="docs/brand/wordmark-dark.png" alt="Palimpsest, in capital letters built like its towers: a sandstone root, brick floors, a thin bronze datum band, glass floors with a few lit windows and a brushed titanium crown. One brick floor of the M is left in rust-red primer." width="880" />
  </picture>
</p>

<p align="center">
  <img alt="phase 1" src="https://img.shields.io/badge/phase_1-standing_city-b98a5e?style=flat-square&labelColor=17130f" />
  <img alt="three.js" src="https://img.shields.io/badge/three.js-r187-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="engine" src="https://img.shields.io/badge/engine-Node_22_%C2%B7_SQLite-6e6457?style=flat-square&labelColor=17130f" />
  <img alt="macOS" src="https://img.shields.io/badge/macOS-only-6e6457?style=flat-square&labelColor=17130f" />
</p>

<p align="center">
  <img src="docs/media/hero.webp" alt="The sample city at dusk from above the rooftops. A low sun sits soft in the haze on the left. Four founding towers rise from their lit plazas over the low blocks around them: a Gothic root, a pagoda base, a Chicago limestone base and a Beaux-Arts colonnade, then stone and brick floors, glass and titanium higher up, and the tallest stands on the right with its crown against a violet sky." width="100%" />
</p>

<p align="center">
  <a href="docs/media/flyover.mp4"><picture>
    <source type="image/avif" srcset="docs/media/flyover.avif" />
    <img src="docs/media/flyover.gif" alt="A slow flight in an arc around the city at dusk. The towers slide past each other while the low sun drifts behind them." width="100%" />
  </picture></a>
</p>

<p align="center">
  <a href="docs/media/rise.mp4"><picture>
    <source type="image/avif" srcset="docs/media/rise.avif" />
    <img src="docs/media/rise.gif" alt="The camera rises up the tallest tower while circling it slowly: past its Beaux-Arts root, up through stone and brick floors, glass and titanium, and stops at the bronze band at the very top." width="100%" />
  </picture></a>
</p>

<p align="center"><sub>A flyover, then one tower from root to top. Click either for the full video.</sub></p>

<br />

I work across a lot of repos, and their history is mostly invisible. A commit log is a list. It doesn't show you which project stalled for a year, or how much of the recent work was done with an AI.

Palimpsest turns that history into a city. Each repo you connect becomes a district, and its history becomes a tower you can read from the street. The oldest work is at the bottom and the newest is at the top. Later, AI agent firms will bid on real issues from those same repos and open a pull request once their work passes inspection. Every change they land will raise a floor.

A palimpsest is a manuscript that was scraped and written over for centuries, with every layer still readable. I wanted each tower to work the same way.

Everything in these pictures is the real app, rendered by its own engine. The repos in them are a sample city I made up for the purpose.

## Reading a tower

<img src="docs/media/tower.webp" alt="One whole tower at dusk, seen across the rooftops: a red pagoda base with flared eaves, a long run of brick and stone floors lit warm by the low sun, then glass floors and a stacked steel crown against a violet sky. Two more towers stand in the haze behind it." />

A tower is read from the ground up.

The root is real architecture. Each repo gets one of five: a Beaux-Arts colonnade, Roman arcades, a Gothic front with buttresses and a rose window, a Kyoto pagoda base, or Chicago rusticated limestone. Above it, every floor is one change. When I connect a repo, the engine reads its merged pull requests. Where there were none, it clusters commits into meaningful changes, so a repo with 2,000 commits doesn't become a 2,000 floor needle. It caps at 120 floors.

The floors are built in eras taken from the repo's own timeline. Its first months are stone, then brick, then steel and glass, titanium, and something closer to science fiction near the present. Floors whose commits were co-authored by Claude are marked as such.

<img src="docs/media/root.webp" alt="Close on a Gothic root at dusk: pinnacles along the parapet, buttresses, lancet windows lit from within, and a stained glass rose window over a pointed doorway, on a paved plaza with bollard lights." />

The roots are modelled in code for Palimpsest. The Gothic one has its own pinnacles, buttresses, lancets and a rose window with real stained glass.

<img src="docs/media/datum.webp" alt="The top of the tallest tower against the sky: glass floors banded with thin lines of light, a stacked steel crown, and a polished bronze band round the very top, with the city in haze far below." />

The bronze band at the very top is the datum line. It marks the height where the repo joined the city. Everything below it is founding history, built from real commits the moment the repo was connected, so a new city never starts at ground level. Everything above it will be floors earned in the market. Today every tower ends at its datum line, because the market isn't built yet.

## Using it

<img src="docs/media/overview.webp" alt="The app as it opens: the sample city at dusk with a name plate under each district, such as harbor-ledger, tidewater, 92 floors. The running head at the top left reads Palimpsest, City, Repos 6, Settings." />

The app opens on the city. Each district has a small plate with the repo's name and its floor count. A repo with no commits yet stands as a root with nothing on it.

<img src="docs/media/inspector.webp" alt="Close on the glass floors of the assay-kit tower with one floor outlined. On the right, the inspector lists its floors under era headings, each with a title, its size, a commit or pull request ref and a date. Many recent floors say with Claude." />

Clicking a tower opens the inspector. It lists every floor with the change behind it. Clicking a floor flies the camera to it and outlines it on the tower. The arrow keys and Enter do the same from the keyboard.

<img src="docs/media/repos.webp" alt="The Repos screen over the left half of the window. Under In the city, each repo has a connect switch, its description, its status and floor count, a choice of five roots and a push mode switch. The city stays visible on the right." />

Repos lists what your GitHub CLI can see. Nothing is connected until you turn it on. Connecting one mirrors its history and raises its tower while you watch. You can pick its root, and push mode is stored now for when the market opens.

<img src="docs/media/settings.webp" alt="The Settings screen: the Claude usage hook shown as installed, the five-hour window at 34 percent and the weekly window at 21 percent with their reset times, the day and night caps, and the quality setting." />

Settings shows your Claude plan usage from the statusline hook and the caps the city will keep to. It also has a quality setting for older Macs and a switch that stops the city.

## Where it stands

I'm building it in five phases. Phase 1, the standing city, is done.

What works in Phase 1:

- A local engine that runs as a launchd agent on `127.0.0.1:4770`, with its own SQLite store and an append-only ledger.
- Connecting repos through the GitHub CLI, each one switched on separately, with a bare mirror of its history.
- Founding towers built from that history, with floors, eras, the Claude marks and the datum line.
- The city itself in three.js. A dusk sky lights every reflection and the fog matches the horizon. The five roots and the five floor eras stand on lit plazas in a street grid, and the blocks around each plaza stay below its root so the root can be seen.
- The inspector, the Repos screen and the Settings screen.
- Reading live Claude plan usage through a statusline hook, so the city can later spend only a share of it.
- A native Mac app, built with Tauri, in `src-tauri/`. It opens on a splash while it looks for the engine. If the engine isn't running, it offers to start it. If macOS is keeping it out of the folder the source lives in, it says which folder and opens the right pane of System Settings.

There are 110 unit tests, 100 for the engine and the city and 10 for the app shell. An end to end UI test (`npm run ui-test`) also drives the built city in Chromium against the sample.

Designed, and not built yet:

- The market. Firms of AI agents bid on labelled issues and on proposals the city makes itself, the best expected value wins, and the work runs in a fresh worktree inside a `sandbox-exec` profile. It ships as a pull request by default, or a push to main on repos where I turn that on.
- Inspection. A change passes only if the repo's own tests, type check, lint and build all pass and a reviewer from a different firm approves the diff. UI changes are also judged on before and after screenshots. A failed inspection leaves a scar floor in primer.
- Live construction. A crane goes up on the roof when a bid is won, and a steel frame rises in welding sparks while the agent works. During inspection, searchlights sweep the new floor.
- The school, which breeds agents on arenas built from my own repos and fine-tunes small local models on work that passed.
- The nets, small models trained nightly on what actually happened, and earned autonomy for each kind of work.

The full design is in [`docs/superpowers/specs/2026-11-08-palimpsest-design.md`](docs/superpowers/specs/2026-11-08-palimpsest-design.md).

## Run it

You need macOS, Node 22.13 or later, Rust for the app, and the [GitHub CLI](https://cli.github.com) logged in with `gh auth login`.

Clone it somewhere outside Downloads, Documents and Desktop, such as `~/code`. macOS privacy settings guard those three folders, and they can stop the app from starting the engine from there. If that happens, the app tells you which folder it is and opens the right pane of System Settings.

```sh
git clone https://github.com/AllStreets/palimpsest ~/code/palimpsest
cd ~/code/palimpsest
npm install
node bin/palimpsest.mjs engine install
npm run app
```

`engine install` sets the engine up as a launchd user agent, so it keeps running when the window is closed. It serves the city at http://127.0.0.1:4770, which also works in a browser. `node bin/palimpsest.mjs engine status` tells you whether it's up, and `engine uninstall` removes it.

`npm run app` builds `Palimpsest.app` into `src-tauri/target/release/bundle/macos/`. Move it to Applications and open it. It isn't signed or notarized, so you build it from source.

To show your Claude plan usage in the city, install the statusline hook from Settings, or from the terminal:

```sh
node bin/palimpsest.mjs usage install
```

Your data lives in `~/Library/Application Support/Palimpsest`. Set `PALIMPSEST_HOME` to put it somewhere else.

To look around without connecting anything of yours, write the sample city into a folder of its own. Then run a second engine on that folder, on its own port, beside the one you installed:

```sh
npx tsx tools/sample.ts /tmp/palimpsest-sample
npm run build
PALIMPSEST_HOME=/tmp/palimpsest-sample PALIMPSEST_PORT=4790 npm run engine
```

The sample city is then at http://127.0.0.1:4790. Ctrl+C stops that engine and leaves yours running.

## Privacy

Palimpsest runs entirely on your Mac. There's no account to make.

The only network calls it makes are `gh` and `git` calls to GitHub, for the repos you connect. Nothing is connected by default.

It never reads your Claude credentials and never offers a Claude login. Plan usage comes from a statusline hook you install yourself. Claude Code already passes your five-hour and seven-day usage to statusline scripts, and the hook writes those two numbers to Palimpsest's data folder. If you already had a statusline script, the hook keeps a backup of your settings and runs your script as before. Removing the hook puts your settings back exactly as they were. If your settings changed while the hook was in, removing it only puts your old statusline back and keeps the other changes.

When the market is built, agents will run through your own installed Claude Code or an API key you add. They use your own subscription.

## How the pictures were made

Every image and clip in this README was captured from the app by [`tools/capture.ts`](tools/capture.ts). It starts a separate engine on its own port with a temporary data folder, and fills it with the sample city from [`tools/sample.ts`](tools/sample.ts). That is six made-up repos with histories from nine years down to none. GitHub is answered by a stand-in, so nothing real is read. The UI tests use the same sample.

The capture opens the built UI in Chromium on the GPU, at twice the window's density. It sets the camera itself for every frame and waits for that frame to render before taking it. Nothing is screen-recorded, so no frame is dropped or repeated. ffmpeg turns the frames into an MP4, an animated AVIF for this page, a small WebP for my profile card and a GIF fallback.

```sh
npm run build
node --no-warnings --import tsx tools/capture.ts          # every shot
node --no-warnings --import tsx tools/capture.ts rise     # just one
```

The wordmark and the app icon are rendered in Blender from [`docs/brand/wordmark.py`](docs/brand/wordmark.py) and [`docs/brand/logo.py`](docs/brand/logo.py). The letters are cut into floors the same way the towers are, and use the same scanned stone, brick and rust textures as the app.

## Credits

The stone, brick, metal, paving and rust textures are CC0 scans from [Poly Haven](https://polyhaven.com). The interface is set in [Newsreader](https://fonts.google.com/specimen/Newsreader) and [IBM Plex](https://github.com/IBM/plex), and the wordmark in [Cinzel](https://github.com/NDISCOVER/Cinzel) by Natanael Gama, all under the SIL Open Font License. Everything else is written for Palimpsest. [CREDITS.md](CREDITS.md) lists every asset, its author and where it's used.
