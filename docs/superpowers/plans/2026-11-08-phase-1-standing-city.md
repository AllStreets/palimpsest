# Phase 1: The First Standing City Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect real GitHub repos (each toggleable), read their history into founding towers, and show them as a photoreal city at dusk in a native Mac app whose engine keeps running as a launchd agent, with live Claude plan usage in Settings.

**Architecture:** A TypeScript engine (Node 22, SQLite via `node:sqlite`) runs as a launchd user agent on `127.0.0.1:4770`. It talks to GitHub only through the `gh` CLI and local bare mirrors, turns history into `TowerSpec`s, and serves JSON, server-sent events and the built UI. The UI is plain TypeScript plus three.js (Vite dev server on 4771). The Tauri app shows a splash, makes sure the engine is up, then navigates to the engine's URL (the Teardown pattern, minus the sidecar).

**Tech Stack:** Node 22.13+, TypeScript, tsx, `node:test`, `node:sqlite`, three.js 0.187, Vite 8, Playwright (UI checks), Tauri 2 (Rust), `gh`, `git`, `jq`, launchd.

**Spec:** `docs/superpowers/specs/2026-11-08-palimpsest-design.md` (Phase 1 in section 13; sections 6, 7.4, 8, 12, 15 to 17 apply).

## Global Constraints

- Engine API on `127.0.0.1:4770` only; UI dev server on `4771`.
- Data directory `~/Library/Application Support/Palimpsest`, overridable with `PALIMPSEST_HOME` (every test sets it to a temp dir).
- GitHub access only through the `gh` CLI with the user's existing auth; Palimpsest never stores a GitHub token.
- Never read or store Claude credentials. Usage comes only from the statusline hook (`rate_limits.five_hour` / `rate_limits.seven_day`: `used_percentage`, `resets_at`).
- Nothing is connected by default. Every repo has its own `connected` and `pushMode` toggles; `pushMode` defaults to false (stored in Phase 1, enforced in Phase 2).
- Writes to the API require header `x-palimpsest: 1`.
- No em dashes or `--` in UI copy, README or commit messages he reads. No emojis anywhere. No AI look: no card kits, glow, caps eyebrows, generic AI fonts or buttons.
- Every visible change: build, screenshot at full size plus zoomed crops, critique, iterate before showing. Record rounds and what is still weak.
- README and screenshots use only the sample dataset (Task 13), never his private repos.
- Founding floors carry `founding: true` and sit below the datum line.
- 3D assets: own code and scripted Blender first; CC0 and CC-BY allowed, each recorded in `CREDITS.md`; no paid assets.

## Review Focus

1. A repo with no merged PRs, or an empty repo with no commits: connecting succeeds and shows a root-only tower, never a crash or a hung "analyzing" state.
2. A very large history (thousands of commits): founding floors capped at 120, analysis runs off the request thread, SSE reports progress, the city stays responsive.
3. `gh` missing, logged out, or a private repo it can't read: the repo shows a readable error and a retry, never a hang.
4. The app opens while the engine is not installed or not running: a clear start or install state, never a blank window.
5. Installing the usage hook over an existing custom statusline: the user's statusline output is unchanged, and uninstall restores `~/.claude/settings.json` byte for byte.

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, .gitignore (exists), CREDITS.md
shared/types.ts            Era, RootStyle, Repo, Floor, TowerSpec, District, UsageReading, Settings
shared/tower-layout.ts     pure: floor heights, root heights, datum height (used by engine tests and UI)
engine/home.ts             data dir paths
engine/db.ts               SQLite open + schema
engine/ledger.ts           append-only ledger
engine/settings.ts         settings read/patch with defaults
engine/exec.ts             injectable command runner (real: child_process.execFile)
engine/github.ts           gh wrappers: available repos, repo meta, merged PRs
engine/mirror.ts           bare mirror clone/fetch + git log parse
engine/history.ts          pure: commits + PRs -> founding floors (clusters, eras, cap, Claude marks)
engine/repos.ts            connect / disconnect / patch / analyze pipeline, root pick
engine/layout.ts           pure: district origins
engine/usage.ts            hook script text, install/uninstall, readings, staleness
engine/events.ts           in-process event bus for SSE
engine/server.ts           HTTP API + SSE + static dist
engine/main.ts             engine entry (stop file, server start)
engine/launchd.ts          plist text, install/uninstall via launchctl
bin/palimpsest.mjs         CLI: engine start|install|uninstall|status, usage install|uninstall
app/index.html, app/src/main.ts, app/src/api.ts, app/src/router.ts
app/src/city/{scene,sky,post,materials,facade,ground,grid,labels,camera}.ts
app/src/city/tower/{build,roots,eras,datum}.ts
app/src/ui/{repos,settings,inspector,engine-down}.ts, app/src/ui/style.css
app/public/textures/*      Poly Haven CC0 scans
src-tauri/                 Tauri 2 app (splash, engine check, install command)
tools/ui-test.ts           Playwright checks + screenshots
tools/sample.ts            builds the sample dataset into a PALIMPSEST_HOME
test/*.test.ts             node:test suites
```

---

### Task 1: Scaffold, shared types, data home and database

**Files:**
- Create: `package.json`, `tsconfig.json`, `shared/types.ts`, `engine/home.ts`, `engine/db.ts`, `engine/ledger.ts`, `engine/settings.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Produces:
  - `shared/types.ts`:
    ```ts
    export type Era = 'stone' | 'brick' | 'glass' | 'titanium' | 'scifi';
    export type RootStyle = 'beauxarts' | 'roman' | 'gothic' | 'pagoda' | 'chicago';
    export type FloorSize = 'small' | 'medium' | 'large';
    export interface Repo { fullName: string; private: boolean; defaultBranch: string; language: string | null;
      description: string | null; connected: boolean; pushMode: boolean; root: RootStyle;
      status: 'idle' | 'analyzing' | 'ready' | 'error'; error: string | null;
      connectedAt: string | null; analyzedAt: string | null; }
    export interface Floor { id: string; repo: string; kind: 'pr' | 'commits'; refs: string[]; title: string;
      at: string; era: Era; size: FloorSize; lines: number; claude: boolean; founding: true; url: string | null; }
    export interface TowerSpec { id: string; repo: string; kind: 'founding'; root: RootStyle; floors: Floor[]; datumIndex: number; }
    export interface District { repo: string; index: number; origin: { x: number; z: number }; tower: TowerSpec; }
    export interface UsageWindow { usedPercentage: number; resetsAt: number; }
    export interface UsageReading { at: number; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; }
    export interface Settings { quality: 'high' | 'medium'; dayCapPct: number; nightCapPct: number; hookInstalled: boolean; previousStatusLine: unknown | null; }
    ```
  - `engine/home.ts`: `home(): string`, `paths(): { db: string; mirrors: string; usage: string; logs: string; stop: string; dist: string }` (creates dirs).
  - `engine/db.ts`: `openDb(): DatabaseSync` with tables `repos(full_name pk, json)`, `towers(repo pk, json)`, `ledger(id integer pk autoincrement, at text, kind text, json text)`, `settings(key pk, json)`.
  - `engine/ledger.ts`: `record(kind: string, data: object): number`, `entries(since?: number): {id:number; at:string; kind:string; data:any}[]`.
  - `engine/settings.ts`: `getSettings(): Settings`, `patchSettings(p: Partial<Settings>): Settings`. Defaults: `quality 'high'`, `dayCapPct 50`, `nightCapPct 20`, `hookInstalled false`, `previousStatusLine null`.

- [ ] **Step 1:** Create `package.json` (`"type": "module"`, `"engines": {"node": ">=22.13"}`, scripts `test: node --no-warnings --import tsx --test 'test/**/*.test.ts'`, `typecheck: tsc --noEmit -p .`, `engine: tsx engine/main.ts`, `dev: concurrently -k "tsx watch engine/main.ts" "vite"`, `build: vite build`, `ui-test: tsx tools/ui-test.ts`, `app: vite build && tauri build`; deps `three`, `tsx`; dev deps `typescript`, `vite`, `@types/node`, `@types/three`, `playwright`, `concurrently`, `@tauri-apps/cli`) and `tsconfig.json` (strict, `module: nodenext`, `noEmit`). Run `npm install`.
- [ ] **Step 2: Write the failing tests** in `test/db.test.ts`: `home() honours PALIMPSEST_HOME`; `ledger records are append-only and ordered` (record three, `entries()` returns ids ascending, `entries(2)` returns only id 3); `settings defaults` (`getSettings().nightCapPct === 20`, `dayCapPct === 50`); `patchSettings persists across reopen`.
- [ ] **Step 3:** Run `npm test`; expect FAIL (modules missing).
- [ ] **Step 4:** Implement the modules above. `ledger` exposes no update or delete.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck`; expect PASS.
- [ ] **Step 6:** Commit `Scaffold engine, shared types, data home and ledger`.

### Task 2: GitHub access and local mirrors

**Files:**
- Create: `engine/exec.ts`, `engine/github.ts`, `engine/mirror.ts`
- Test: `test/github.test.ts`, `test/mirror.test.ts`

**Interfaces:**
- Consumes: `paths().mirrors`.
- Produces:
  - `engine/exec.ts`: `type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>`; `realRunner: Runner`; `setRunner(r: Runner)` for tests.
  - `engine/github.ts`:
    - `availableRepos(): Promise<Pick<Repo,'fullName'|'private'|'description'|'language'|'defaultBranch'>[]>` via `gh repo list --limit 500 --json nameWithOwner,isPrivate,description,primaryLanguage,defaultBranchRef`.
    - `mergedPRs(fullName): Promise<{ number: number; title: string; mergedAt: string; lines: number; mergeSha: string | null; url: string }[]>` via `gh pr list -R <full> --state merged --limit 2000 --json number,title,mergedAt,additions,deletions,mergeCommit,url`; `lines = additions + deletions`.
    - `class GhError extends Error { kind: 'missing' | 'auth' | 'notfound' | 'other' }`: missing binary, `gh auth status` failure, and "Could not resolve to a Repository" map to those kinds.
  - `engine/mirror.ts`:
    - `syncMirror(fullName): Promise<string>`: first time `gh repo clone <full> <mirrors>/<owner>__<name>.git -- --bare`; afterwards `git -C <dir> fetch origin '+refs/heads/*:refs/heads/*' --prune`. Returns the dir.
    - `readLog(dir, branch): Promise<Commit[]>` running `git log --first-parent --reverse --format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1f --numstat <branch>`.
    - `parseLog(raw: string): Commit[]` where `interface Commit { sha: string; at: string; author: string; subject: string; body: string; lines: number }` (sum of numstat added+deleted, binary `-` counts 0). An empty repo (git exits non-zero with "does not have any commits") returns `[]`.

- [ ] **Step 1: Write the failing tests.** With a fake runner: `availableRepos maps gh json` (private flag, language name or null); `GhError kind auth when gh auth fails`; `GhError kind missing when gh is not installed` (runner rejects with ENOENT); `mergedPRs sums additions and deletions`. Pure: `parseLog parses numstat and trailers` using a fixture string with two commits, one whose body contains `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and a binary file line `-\t-\timg.png`; `readLog returns [] for an empty repo` (real git: `git init --bare` in a temp dir).
- [ ] **Step 2:** Run `npm test`; expect FAIL.
- [ ] **Step 3:** Implement. All `gh` and `git` calls go through the current `Runner` with a 120 s timeout.
- [ ] **Step 4:** Run `npm test`; expect PASS. Then one manual check: `PALIMPSEST_HOME=$(mktemp -d) npx tsx -e "import('./engine/mirror.ts').then(async m=>{const d=await m.syncMirror('AllStreets/palimpsest');console.log((await m.readLog(d,'main')).length)})"` prints at least `2`.
- [ ] **Step 5:** Commit `Add gh access and bare mirrors with log parsing`.

### Task 3: History into founding floors

**Files:**
- Create: `engine/history.ts`
- Test: `test/history.test.ts`

**Interfaces:**
- Consumes: `Commit` (Task 2), PR shape from `mergedPRs`, `Floor`, `Era`.
- Produces: `foundingFloors(repo: string, commits: Commit[], prs: PR[]): Floor[]` and the constants `MAX_FOUNDING_FLOORS = 120`, `CLUSTER_GAP_HOURS = 6`, `CLUSTER_MAX_LINES = 400`, `ERA_CUTS = [0.2, 0.45, 0.7, 0.9]`.

Rules the tests pin:
1. A first-parent commit whose sha equals a PR's `mergeSha` becomes that PR's floor: `kind 'pr'`, `refs ['#<n>']`, `title` = PR title, `lines` = PR lines, `url` = PR url, `at` = PR `mergedAt`.
2. Other commits, in order, cluster while: same author, gap to the previous commit at most 6 hours, cluster lines at most 400 including the new commit. A cluster becomes `kind 'commits'`, `refs ['<first7>..<last7>']` (or `['<sha7>']` for one), `title` = first commit subject, `at` = last commit time, `url` null.
3. `size`: lines under 50 small, under 400 medium, else large.
4. `claude` is true if any commit in the floor has a body matching `/Co-Authored-By:\s*Claude/i`; for PR floors, check the merge commit's body.
5. While floors exceed 120, merge the adjacent pair with the smallest combined lines (refs concatenated, title of the earlier, `at` of the later, `claude` OR, `kind 'pr'` if either is, size recomputed).
6. Era from `t = (at - firstAt) / (lastAt - firstAt)` (t = 1 when all equal): below 0.2 stone, 0.45 brick, 0.7 glass, 0.9 titanium, else scifi.
7. `id` = `<repo>#<refs[0]>`; `founding: true`.

- [ ] **Step 1: Write the failing tests:** `PR merge commit becomes a PR floor`; `same-author commits within 6h cluster`; `a 7h gap splits clusters`; `cluster closes at 400 lines`; `author change splits clusters`; `Claude trailer marks the floor`; `caps at 120 floors by merging smallest neighbours` (generate 500 one-line commits 7 h apart; expect `length === 120` and total lines preserved); `eras follow the timeline` (five floors evenly spaced get stone, brick, glass, titanium, scifi); `no commits gives no floors`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `foundingFloors` (pure, no I/O).
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Turn repo history into founding floors`.

### Task 4: Repo service, tower specs and district layout

**Files:**
- Create: `engine/repos.ts`, `engine/layout.ts`, `engine/events.ts`, `shared/tower-layout.ts`
- Test: `test/repos.test.ts`, `test/layout.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  - `engine/events.ts`: `emit(type: string, data: object)`, `subscribe(fn: (e: {type: string; data: any}) => void): () => void`.
  - `engine/repos.ts`:
    - `listRepos(): Repo[]` (connected and previously connected, sorted by `connectedAt`).
    - `connect(fullName): Promise<Repo>`: stores the repo (`connected true`, `status 'analyzing'`, `root = pickRoot(fullName)`), records ledger `repo.connected`, starts `analyze` without awaiting it, returns immediately.
    - `analyze(fullName): Promise<void>`: emits `repo.analyzing` with `{ repo, step: 'mirror' | 'log' | 'prs' | 'floors' }`, runs `syncMirror`, `readLog`, `mergedPRs`, `foundingFloors`, stores a `TowerSpec` (`datumIndex = floors.length`), sets `status 'ready'`, `analyzedAt`, emits `repo.analyzed`, records ledger `repo.analyzed {floors}`. On error: `status 'error'`, `error` = readable message from `GhError` kind, emits `repo.error`.
    - `disconnect(fullName)`: `connected false`; tower kept for reconnect; ledger `repo.disconnected`.
    - `patchRepo(fullName, p: Partial<Pick<Repo,'pushMode'|'root'>>): Repo`; ledger `repo.patched`.
    - `pickRoot(fullName): RootStyle`: `ROOTS[fnv1a32(fullName) % 5]` with `ROOTS = ['beauxarts','roman','gothic','pagoda','chicago']`.
    - `city(): District[]` for connected repos in `connectedAt` order, `origin = districtOrigin(i)`.
  - `engine/layout.ts`: `DISTRICT_PITCH = 240`; `districtOrigin(i: number): {x: number; z: number}` walks a square spiral over block coordinates skipping (0,0), which is reserved for the civic plaza.
  - `shared/tower-layout.ts`: `ROOT_HEIGHT: Record<RootStyle, number> = { beauxarts: 30, roman: 24, gothic: 34, pagoda: 28, chicago: 26 }`, `FLOOR_HEIGHT: Record<FloorSize, number> = { small: 3.6, medium: 4.2, large: 5.2 }`, `layoutTower(spec): { rootHeight: number; floors: { floor: Floor; y0: number; h: number }[]; datumY: number; top: number }`.

- [ ] **Step 1: Write the failing tests:** `connect returns at once and analysis completes` (fake runner serving a fixture log and PR json; await an `repo.analyzed` event; `listRepos()[0].status === 'ready'`); `empty repo gives a root-only tower` (`floors.length === 0`, status ready); `auth failure sets a readable error` (status error, message mentions `gh auth login`); `disconnect keeps the tower and hides the district`; `pushMode defaults to false and patches persist`; `pickRoot is stable`; `districtOrigin` first nine are distinct, none is (0,0), and `districtOrigin(3)` is identical across calls; `layoutTower` datum sits at the top of the founding floors and `top = rootHeight + sum(h)`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Add repo service, tower specs and district layout`.

### Task 5: Live Claude usage through the statusline hook

**Files:**
- Create: `engine/usage.ts`
- Test: `test/usage.test.ts`

**Interfaces:**
- Consumes: `paths().usage`, settings.
- Produces:
  - `hookScript(previousCommand: string | null): string`: a POSIX `sh` script that reads stdin to a temp file, appends `{"at":<epoch>,"rate_limits":<.rate_limits>}` as one line to `<usage>/readings.jsonl` via `jq -c` only when `.rate_limits` is present, then pipes the same stdin into `previousCommand` (when set) and prints its output, else prints nothing. It must exit 0 even if `jq` fails.
  - `installHook(claudeSettingsPath = ~/.claude/settings.json)`: backs the file up to `<usage>/settings.json.bak` byte for byte, saves the current `statusLine` value in `Settings.previousStatusLine`, writes the script to `<usage>/statusline.sh` (mode 755), sets `statusLine` to `{ "type": "command", "command": "sh '<usage>/statusline.sh'" }`, sets `hookInstalled true`, ledger `usage.hook.installed`.
  - `uninstallHook(claudeSettingsPath)`: restores the backup byte for byte if the current file's `statusLine` is still ours, otherwise only resets `statusLine` to the saved previous value; `hookInstalled false`.
  - `latestReading(): UsageReading | null` (last line of readings.jsonl, mapped from `used_percentage` / `resets_at`), `isStale(r, now = Date.now()): boolean` (older than 5 hours).
- [ ] **Step 1: Write the failing tests:** `hook records rate limits and chains the previous statusline` (run the script with `sh` against a JSON sample containing `rate_limits.five_hour.used_percentage 42` and a previous command `printf previous`; expect stdout `previous` and one jsonl line with 42); `hook without rate_limits records nothing`; `install then uninstall restores settings byte for byte` (temp settings.json with unusual spacing and other keys); `stale after five hours`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5:** Commit `Read live Claude usage through a chained statusline hook`.

### Task 6: Engine server, stop file, launchd agent and CLI

**Files:**
- Create: `engine/server.ts`, `engine/main.ts`, `engine/launchd.ts`, `bin/palimpsest.mjs`
- Test: `test/server.test.ts`, `test/launchd.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces:
  - `startServer(port = 4770): Promise<{ close(): Promise<void>; port: number }>` binding `127.0.0.1`. Routes:
    - `GET /api/health` -> `{ ok: true, version, stopped: boolean }` (`stopped` when `paths().stop` exists)
    - `GET /api/repos/available`, `GET /api/repos`, `POST /api/repos/:owner/:name/connect`, `POST /api/repos/:owner/:name/disconnect`, `PATCH /api/repos/:owner/:name` (`{pushMode?, root?}`), `POST /api/repos/:owner/:name/analyze` (retry)
    - `GET /api/city` -> `District[]`
    - `GET /api/usage` -> `{ reading: UsageReading | null; stale: boolean; hookInstalled: boolean }`, `POST /api/usage/hook/install`, `POST /api/usage/hook/uninstall`
    - `GET /api/settings`, `PATCH /api/settings`
    - `GET /api/events` (SSE of the event bus)
    - everything else: static files from `paths().dist` with `index.html` fallback
    - non-GET without `x-palimpsest: 1` -> 403; unknown repo -> 404; `GhError` -> 502 with `{ error, kind }`.
  - `engine/launchd.ts`: `LABEL = 'com.palimpsest.engine'`; `plist(o: { node: string; repo: string; logs: string; path: string }): string` with `ProgramArguments [node, --import, tsx, <repo>/engine/main.ts]`, `RunAtLoad true`, `KeepAlive true`, `WorkingDirectory <repo>`, `EnvironmentVariables.PATH` including `/opt/homebrew/bin:/usr/local/bin`, stdout and stderr to `<logs>/engine.log`; `install()` writes `~/Library/LaunchAgents/com.palimpsest.engine.plist` and runs `launchctl bootstrap gui/<uid> <plist>`; `uninstall()` runs `launchctl bootout gui/<uid>/com.palimpsest.engine` and removes the plist; `status(): 'running' | 'installed' | 'absent'`.
  - CLI: `palimpsest engine start|install|uninstall|status`, `palimpsest usage install|uninstall`.
- [ ] **Step 1: Write the failing tests** (server on port 0): `health reports stopped when the stop file exists`; `writes without the header are refused`; `connect then city returns a district` (fake runner); `gh missing returns 502 with kind missing`; `SSE delivers repo.analyzed`; `unknown path serves index.html`; `plist contains label, KeepAlive and the PATH`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. `main.ts` starts the server, logs, and keeps serving read-only data even when stopped.
- [ ] **Step 4:** Run; expect PASS. Then `node bin/palimpsest.mjs engine install`, `curl -s 127.0.0.1:4770/api/health` shows `ok: true`, and `node bin/palimpsest.mjs engine status` prints `running`.
- [ ] **Step 5:** Commit `Serve the engine over HTTP and run it as a launchd agent`.

### Task 7: City foundation (sky, light, ground, skyline)

**Files:**
- Create: `vite.config.ts` (root `app`, port 4771, proxy `/api` to 4770, outDir `../dist`), `app/index.html`, `app/src/main.ts`, `app/src/api.ts`, `app/src/router.ts`, `app/src/city/{scene,sky,post,materials,facade,ground,grid,camera}.ts`, `app/public/textures/*`, `CREDITS.md`, `tools/ui-test.ts`
- Test: `tools/ui-test.ts` (Playwright)

**Interfaces:**
- Consumes: `GET /api/city`, `GET /api/events`.
- Produces: `createCity(canvasHost: HTMLElement, opts: { quality: 'high' | 'medium' }): City` where `City = { scene: THREE.Scene; camera: THREE.PerspectiveCamera; setDistricts(d: District[]): void; flyTo(target: THREE.Vector3, distance: number): void; onPick(fn: (hit: { kind: 'tower'; repo: string; floorId: string | null }) => void): void; dispose(): void }`; `facadeMaterial(base: number, o?: { lit?: number; metal?: number; rough?: number }): THREE.MeshStandardMaterial` (the mockup's world-space window shader); `api` client functions mirroring Task 6 routes, always sending `x-palimpsest: 1` on writes.

Port the approved mockup (`docs/mockups/palimpsest-tower.html`) as the starting point: dusk sky dome shader, environment generated from that same sky, `FogExp2` matched to the sky's horizon, ACES tone mapping, GTAO, bloom with threshold 0.97, street grid with sodium lamps, ambient skyline using `facadeMaterial` with per-instance palette. Ambient buildings avoid every district's footprint (`districtOrigin(i)` plus a 90 m radius) and the civic plaza at (0,0). Textures: copy the Poly Haven CC0 scans used by the mockup at 2k into `app/public/textures/`, credit them in `CREDITS.md`.

- [ ] **Step 1: Write the failing UI test** in `tools/ui-test.ts`: start the engine on a temp `PALIMPSEST_HOME` seeded with the sample dataset (Task 13 provides `tools/sample.ts`; until then seed one district inline), open `http://127.0.0.1:4770/`, expect no console errors, a canvas whose center pixel is not pure black after 3 s, and save `shots/city-overview.png`.
- [ ] **Step 2:** Run `npm run build && npm run ui-test`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds.** Screenshot full size and crops (horizon, street level, skyline mid-distance). Critique against the spec's section 6.6 and the mockup's final state; fix and repeat for at least three rounds. Record rounds and what is still weak in the commit body.
- [ ] **Step 6:** Commit `Build the city foundation: dusk sky, light, street grid, skyline`.

### Task 8: Palimpsest towers from TowerSpec

**Files:**
- Create: `app/src/city/tower/{build,roots,eras,datum}.ts`
- Test: `test/tower-build.test.ts` (runs three.js geometry in Node, no renderer), `tools/ui-test.ts` additions

**Interfaces:**
- Consumes: `TowerSpec`, `layoutTower` (Task 4), materials and `facadeMaterial` (Task 7).
- Produces: `buildTower(spec: TowerSpec, quality): { group: THREE.Group; pickables: Map<THREE.Object3D, string /* floorId */>; top: number }`.
  - `roots.ts`: one builder per `RootStyle` returning a group of height `ROOT_HEIGHT[style]`: beauxarts (the mockup's colonnade, entablature, dentils), roman (arcaded podium with pilasters), gothic (buttresses, pointed arches, rose window, pinnacles), pagoda (tiered stone base with flared eaves), chicago (rusticated limestone with tall arched entrance).
  - `eras.ts`: one floor builder per `Era` taking `(width, height, floor)`: stone (cut blocks, deep punched windows), brick (the mockup's brick era), glass (bronze mullions, interior light behind glass), titanium (fins), scifi (cantilevered titanium and glass with light lines). Footprint tapers 0.6% per floor; floors marked `claude` carry a thin warm accent at the slab edge.
  - `datum.ts`: bronze band at `datumY`.
- [ ] **Step 1: Write the failing tests:** `tower height equals layoutTower top`; `one pickable per floor`; `empty spec builds only the root`; `every RootStyle and Era builds without throwing`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Hero detail (columns, cornices, mullions, fins) uses instancing. Where a part needs real modelling, build it with a scripted Blender export (`design/blender/*.py` to `app/public/models/*.glb`) and record that in `CREDITS.md` as own work.
- [ ] **Step 4:** Run tests; expect PASS. Add ui-test shots `tower-<root>.png` for all five roots using the sample dataset.
- [ ] **Step 5: Quality rounds.** Per root and per era: full shot, then close crops. Hold to section 6.2 and the mockup; at least three rounds; no plastic-looking metal, no box-like heroes. Record rounds.
- [ ] **Step 6:** Commit `Build Palimpsest towers: five roots, five eras, datum line`.

### Task 9: City from data, picking and the tower inspector

**Files:**
- Create: `app/src/city/labels.ts`, `app/src/ui/inspector.ts`, `app/src/ui/style.css`
- Modify: `app/src/main.ts`, `app/src/city/scene.ts`

**Interfaces:**
- Consumes: `createCity`, `buildTower`, `api.city()`, SSE events.
- Produces: districts placed at `origin`; each district shows its tower plus a street-level name plate; SSE `repo.analyzed` rebuilds that district only; `repo.analyzing` shows a quiet progress state at the site (scaffold silhouette, no crane: cranes mean real work, Phase 2). Clicking a tower opens the inspector: repo name, root style, founding floor count, and the floors top to bottom (era, size, title, date, Claude mark, link to the PR or commit range on GitHub). Clicking a floor in the list flies the camera to it and highlights it.
- [ ] **Step 1: Write the failing UI test:** with the sample dataset, click the first district's tower; expect the inspector to list `floors.length` rows; click a row; expect the camera to move (camera position changes) and no console errors.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Inspector typography follows the mockup (Newsreader for names, IBM Plex Sans for text, Plex Mono for refs); no card kit, it reads as a printed index beside the city.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** on inspector open over the city, at least two. Commit `Place districts from real history and inspect towers floor by floor`.

### Task 10: Repos and Settings screens

**Files:**
- Create: `app/src/ui/repos.ts`, `app/src/ui/settings.ts`
- Modify: `app/src/router.ts`, `app/src/main.ts`

**Interfaces:**
- Consumes: repo, usage and settings routes; SSE.
- Produces:
  - **Repos** (`#/repos`): every repo `gh` can see, searchable, with a private marker; a connect toggle per repo (off by default); for connected repos: status (analyzing step, ready with floor count, or error with the message and a Retry), push mode toggle labelled as taking effect when the market opens, root style picker, disconnect.
  - **Settings** (`#/settings`): Providers (Claude through your Claude Code: hook installed or not, Install and Remove buttons with a one-line explanation that it chains the existing statusline; Anthropic API key, Ollama, MLX, OpenAI, Gemini listed as coming with the market); Usage (five-hour and weekly percentages with reset times, stale warning when older than 5 h); Caps (day 50%, night 20%, stored now, enforced in Phase 2); Quality (high or medium); Kill switch (creates or removes the stop file); Privacy (what leaves the machine: only `gh` calls to GitHub).
- [ ] **Step 1: Write the failing UI test:** open `#/repos`, toggle a sample repo on, expect the status to pass through analyzing to ready via SSE; open `#/settings`, expect usage percentages from a seeded readings.jsonl and the stale warning for an old reading.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.
- [ ] **Step 5: Quality rounds** (two at least, both screens). Commit `Add Repos and Settings screens`.

### Task 11: The Tauri app

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/splash/index.html`, `src-tauri/icons/*` (placeholder until the Phase 5 logo)
- Modify: `app/src/ui/engine-down.ts` (served by the splash)

**Interfaces:**
- Consumes: `GET /api/health`, `bin/palimpsest.mjs engine install`.
- Produces: identifier `com.allstreets.palimpsest`, window 1600 by 1000, dark background matching the sky's zenith. On launch the splash polls `127.0.0.1:4770/api/health` for up to 5 s; if up, navigates the window to `http://127.0.0.1:4770/`; if not, shows the engine-down state with **Start the engine** (Tauri command `install_engine` runs `node <repo>/bin/palimpsest.mjs engine install` with the repo path baked in at build time from `CARGO_MANIFEST_DIR/..`) and the log path. CSP allows `127.0.0.1:4770`.
- [ ] **Step 1:** Write the splash and the Rust shell following `~/Downloads/teardown/src-tauri/src/main.rs` (engine check, `navigate`), without the sidecar.
- [ ] **Step 2:** Run `npm run app`; expect a built `Palimpsest.app`. Launch it with the engine installed: the city appears. Then `node bin/palimpsest.mjs engine uninstall`, relaunch: the engine-down state appears; click Start the engine: the city appears.
- [ ] **Step 3:** Screenshot both states through the app (ask him to capture native-window footage if a recording is needed; never record his screen). Commit `Wrap the city in a Tauri app that starts its own engine`.

### Task 12: Real-repo check on his own history

**Files:** none new unless fixes are needed.

- [ ] **Step 1:** With the installed engine and his own data home, connect `AllStreets/beagle`, `AllStreets/palimpsest` and two more of his public repos through the Repos screen.
- [ ] **Step 2:** Confirm in the inspector that floor counts and PR titles match `gh pr list --state merged` and `git log --first-parent` for one repo by hand, and that Claude-co-authored commits are marked.
- [ ] **Step 3:** Time each analysis (target under 60 s for his repos); fix any slow step.
- [ ] **Step 4:** Commit any fixes `Fix issues found on real repos` (do not commit his data).

### Task 13: Sample dataset, README pass and push

**Files:**
- Create: `tools/sample.ts`, `docs/media/*.png`
- Modify: `README.md`, `CREDITS.md`

**Interfaces:**
- Produces: `npx tsx tools/sample.ts <dir>` writes a `PALIMPSEST_HOME` with six fictional public-style repos (varied ages, sizes, all five roots, a Claude-co-authored stretch, one empty repo) built through `foundingFloors` from generated commits, plus a usage reading. All README media comes from it.
- [ ] **Step 1:** Implement `tools/sample.ts`; `tools/ui-test.ts` uses it for every shot.
- [ ] **Step 2:** Capture README shots (city overview at dusk, a tower close-up with the inspector, Repos, Settings) through quality rounds.
- [ ] **Step 3:** Update `README.md` in his README style (human, plain, screenshots do the visual work; no badge walls, no ASCII boxes, no AI rhetoric, no em dashes): what it is, the Phase 1 state honestly, how to run it (`npm install`, `node bin/palimpsest.mjs engine install`, `npm run app`), privacy, credits.
- [ ] **Step 4:** Run `npm test`, `npm run typecheck`, `npm run ui-test`; all pass.
- [ ] **Step 5:** Commit `Phase 1: a standing city from real history` and `git push`.
