# Credits

## Textures

Scanned PBR textures from [Poly Haven](https://polyhaven.com), all CC0 (public domain). Each set is the 2k JPG with colour (`_diff`), normal (`_nor`) and packed ambient occlusion, roughness and metalness (`_arm`) maps, in `app/public/textures/`.

| Files | Texture | Author | License | Used for |
|---|---|---|---|---|
| `sand_*` | [Sandstone Blocks 08](https://polyhaven.com/a/sandstone_blocks_08) | Poly Haven | CC0 | District plinths; classical tower roots |
| `brick_*` | [Red Brick 03](https://polyhaven.com/a/red_brick_03) | Poly Haven | CC0 | Brick-era floors |
| `metal_*` | [Metal Plate](https://polyhaven.com/a/metal_plate) | Poly Haven | CC0 | Brushed steel |
| `pave_*` | [Precast Stone Paving](https://polyhaven.com/a/precast_stone_paving) | Poly Haven | CC0 | Pavements, plazas and the ground |
| `rust_*` | [Rusty Metal 02](https://polyhaven.com/a/rusty_metal_02) | Poly Haven | CC0 | Primer on steel frames and scar floors |

## Own work

The sky, fog, facade windows, street grid, lamps and skyline are procedural, written for Palimpsest.

The Palimpsest towers (`app/src/city/tower/`) are modelled in code, written for Palimpsest: the five roots (Beaux-Arts colonnade with fluted Ionic columns, Roman arcades, Gothic buttresses, lancets and rose window, the pagoda base with its flared tile eaves, the Chicago rusticated base), the five floor eras, the datum line, the interior-mapped window glass and the rose window's stained glass. No third-party models are used; the scanned textures above supply the stone, brick and metal surfaces.

The analyzing-site scaffold (`app/src/city/scaffold.ts`) is modelled in code, written for Palimpsest.

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
