# Credits

## Textures

Scanned PBR textures from [Poly Haven](https://polyhaven.com), all CC0 (public domain). Each set is the 2k JPG with colour (`_diff`), normal (`_nor`) and packed ambient occlusion, roughness and metalness (`_arm`) maps, in `app/public/textures/`.

| Files | Texture | Author | License | Used for |
|---|---|---|---|---|
| `sand_*` | [Sandstone Blocks 08](https://polyhaven.com/a/sandstone_blocks_08) | Poly Haven | CC0 | District plinths; classical tower roots; stone-era floors (sandstone and travertine recoloured from it) |
| `brick_*` | [Red Brick 03](https://polyhaven.com/a/red_brick_03) | Poly Haven | CC0 | Brick-era floors: common red as scanned; cream city, salmon, buff and glazed white terracotta recoloured from it |
| `granite_*` | [Granite Tile](https://polyhaven.com/a/granite_tile) | Poly Haven (Charlotte Baglioni) | CC0 | Pink and dark grey granite floors, recoloured from it |
| `ashlar_*` | [Marble 01](https://polyhaven.com/a/marble_01) | Poly Haven (Rob Tuytel) | CC0 | Limestone and white marble floors, recoloured from its cut slabs |
| `ironspot_*` | [Dark Brick Wall](https://polyhaven.com/a/dark_brick_wall) | Poly Haven (Dimitrios Savva, Dario Barresi) | CC0 | Dark ironspot brick floors |
| `metal_*` | [Metal Plate](https://polyhaven.com/a/metal_plate) | Poly Haven | CC0 | Brushed steel |
| `pave_*` | [Precast Stone Paving](https://polyhaven.com/a/precast_stone_paving) | Poly Haven | CC0 | Pavements, plazas and the ground |
| `rust_*` | [Rusty Metal 02](https://polyhaven.com/a/rusty_metal_02) | Poly Haven | CC0 | Primer on steel frames and scar floors; the mottling of weathered copper (verdigris) |

## Own work

The sky, fog, facade windows, street grid, lamps and skyline are procedural, written for Palimpsest.

The Palimpsest towers (`app/src/city/tower/`) are modelled in code, written for Palimpsest: the five roots (Beaux-Arts colonnade with fluted Ionic columns, Roman arcades, Gothic buttresses, lancets and rose window, the pagoda base with its flared tile eaves, the Chicago rusticated base), the five floor eras and the per-repo material variants inside each (`variants.ts`), the datum line, the interior-mapped window glass and the rose window's stained glass. No third-party models are used; the scanned textures above supply the stone, brick and metal surfaces.

The analyzing-site scaffold (`app/src/city/scaffold.ts`) is modelled in code, written for Palimpsest.

The civic exchange (`app/src/city/exchange.ts`) is an original design, modelled in code and written for Palimpsest: the granite stylobate and grand stair, the portico of fluted Corinthian columns between rusticated pavilions, the entablature and its brass tote board, the attic clock, the copper dome on its drum of clerestory windows and the glazed lantern, the trading floor's laylights, the forecourt fountain and its four lamp standards, and the civic plaza's paving pattern (`ground.ts`). It copies no real building. No third-party models are used; its stone takes the scanned textures above.

The architecture kits in `app/public/kits/kits.glb` are own work, authored in Blender from code by `tools/kits/kits.py` (run headless; the script is the source): the coursed stone and banded brick blocks laid over the masonry floors, the six sci-fi family crowns (deco tiers, ziggurat summit, needle blades, arcology sky garden, ribbed dome, stacked pods), and the ambient city's roof and massing pieces (timber water tanks on braced stands, stair bulkheads, louvred penthouses, finned plant screens, rooftop units, cars, oriel bays, cut-corner walls). No third-party models or textures are in it.

## Type

Bundled in `app/public/fonts/` (Latin subsets, WOFF2) so the app works offline. The app's splash (`src-tauri/splash/`) shows before the engine can serve anything, so it carries its own copies of the same files in `src-tauri/splash/fonts/`. All under the [SIL Open Font License 1.1](https://openfontlicense.org).

| Files | Typeface | Designer | Used for |
|---|---|---|---|
| `newsreader.woff2`, `newsreader-italic.woff2` | [Newsreader](https://fonts.google.com/specimen/Newsreader) | Production Type | Repo names, era headings |
| `plex-sans.woff2` | [IBM Plex Sans](https://github.com/IBM/plex) | Mike Abbink, Bold Monday | Interface text |
| `plex-mono-400.woff2` | [IBM Plex Mono](https://github.com/IBM/plex) | Mike Abbink, Bold Monday | Commit and PR refs |
| `docs/brand/fonts/Cinzel*.ttf` | [Cinzel](https://github.com/NDISCOVER/Cinzel) | Natanael Gama, The Cinzel Project Authors | The letterforms of the 3D wordmark and the P of the app mark (license text in `docs/brand/fonts/OFL-Cinzel.txt`) |

## Brand and media

The wordmark, the app mark and the app icon set are own work, rendered in Blender by scripts written for Palimpsest (`docs/brand/wordmark.py`, `docs/brand/logo.py`, `docs/brand/icons.py`). They reuse the Poly Haven sandstone, brick and rust scans listed above. The icons in `src-tauri/icons/` are copies of `docs/brand/icons/`.

The README's hero, stills and clips in `docs/media/` are captured from the app itself by `tools/capture.ts`, from the fictional repos that `tools/sample.ts` writes. No real repo appears in them.
