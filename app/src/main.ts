import * as THREE from 'three';

import './ui/style.css';
import './ui/screens.css';

import type { District, Repo } from '../../shared/types';
import { api } from './api';
import { coalesced } from './coalesce';
import type { Plate } from './city/labels';
import { occupancy, type RepoState } from './city/occupancy.js';
import { createCity, type PickHit } from './city/scene';
import { towerCenterpiece } from './city/tower/look';
import { type SwatchPoint, swatchBoard } from './city/tower/swatches';
import { ambientBoard, type AmbientSwatchPoint } from './city/ambient-swatches';
import { towerTones } from './city/lots';
import { loadKits, registerFallbackKits } from './city/kits';
import { texturesSettled } from './city/materials';
import { type Look, lookFor, lookKey, pickLooks, VARIANTS } from './city/tower/variants';
import type { EngineEvent } from './api';
import { navigate, onRoute } from './router';
import { createInspector, type MarketNames } from './ui/inspector';
import { createRepos } from './ui/repos';
import { createRunhead } from './ui/runhead';
import { createSettings } from './ui/settings';

interface DebugHandle {
  ready: boolean;
  districts: number;
  /** Scaffolds standing at analyzing sites. */
  sites: number;
  /** Districts built since load: a refresh rebuilds only what changed. */
  builds: number;
  lastPick: PickHit | null;
  /** Opens the inspector on a repo's tower, as clicking its plate does. */
  inspect(repo: string): void;
  highlight: { repo: string; floorId: string } | null;
  view(eye: number[], target: number[]): void;
  camera(): number[];
  /** Glides back to the home framing, as the H key does. */
  home(): void;
  /** The view's limits now, as eased this frame. */
  limits(): ReturnType<ReturnType<typeof createCity>['limits']>;
  /** Where a world point lands on screen, in normalised device coordinates (y up, the frame is -1 to 1). */
  project(p: number[]): number[];
  precompile(): Promise<void>;
  stats(): { calls: number; triangles: number };
  /** The quality the city draws at now (medium after an automatic drop). */
  quality(): 'high' | 'medium';
  /** Steps down to medium as the automatic drop does (tests). */
  dropQuality(): void;
  /** The notice line's text, or '' when none shows. */
  notice(): string;
  /** Plazas paved (the civic plaza included) and ambient buildings standing. */
  plots(): { plazas: number; buildings: number };
  /**
   * For captures that check a material against the datum and the Claude
   * amber: rebuilds a repo's tower with the named variants (ids from
   * variants.ts) and, if given, its datum after that many floors. Never
   * written anywhere; a reload restores the real look.
   */
  restyle(repo: string, ids: string[], datumIndex?: number): void;
  /**
   * For the `swatches` capture shot: floats one short tower per variant at
   * the overview's distance and bearing, moves the camera onto them, and
   * returns where each one's sunlit and shaded face sit on screen.
   */
  swatchBoard(): Promise<SwatchPoint[]>;
  /** Stands the ambient tone board in the city's light and returns where to read each tone (captures only; reload to clear). */
  ambientBoard(): Promise<AmbientSwatchPoint[]>;
}

declare global {
  interface Window {
    __palimpsest?: DebugHandle;
  }
}

/** Events that change what stands in the city: a new tower, a failed one, a restyle, a district leaving, or a floor laid, lit, scarred or taken down by the market. */
const REFRESH_ON = new Set([
  'repo.connected',
  'repo.analyzed',
  'repo.error',
  'repo.patched',
  'repo.disconnected',
  'floor.laid',
  'floor.lit',
  'floor.scarred',
  'floor.removed',
  'merge.reverted',
  'firm.bankrupt',
  'tower.sold',
]);
/** Events that change the names on the market's floors: who works where, and which runs have reports. */
const NAMES_ON = new Set(['agent.hired', 'agent.retired', 'firm.bankrupt', 'tower.sold', 'inspection.done']);

/**
 * A quiet line at the foot of the window for what the city did by itself
 * (stood on plain stand-ins when the kits would not load, stepped down to
 * medium quality). It stays until dismissed; a second notice joins the first.
 */
function createNotice(parent: HTMLElement): { add(text: string): void; text(): string } {
  const box = document.createElement('div');
  box.className = 'city-notice';
  box.setAttribute('role', 'status');
  box.hidden = true;
  const lines = document.createElement('p');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'city-notice-close';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => {
    box.hidden = true;
    lines.textContent = '';
  });
  box.append(lines, close);
  parent.appendChild(box);
  return {
    add(text) {
      lines.textContent = lines.textContent ? `${lines.textContent} ${text}` : text;
      box.hidden = false;
    },
    text: () => (box.hidden ? '' : (lines.textContent ?? '')),
  };
}

/** What the plate under an analyzing site says for each step of the engine's analysis. */
const STEP_TEXT: Record<string, string> = {
  mirror: 'Cloning history',
  log: 'Reading history',
  prs: 'Reading pull requests',
  floors: 'Laying out floors',
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

async function main(): Promise<void> {
  const host = document.getElementById('city');
  const veil = document.getElementById('veil');
  if (!host) throw new Error('missing #city');

  const notice = createNotice(document.body);
  // The Blender-authored kits (masonry courses, crowns, roof pieces) load before anything is built from them.
  // Missing or corrupt, the city stands on plain stand-ins and says so, rather than going blank.
  const [settingsQuality] = await Promise.all([
    api.settings().then(
      (s) => s.quality,
      () => 'high' as const,
    ),
    loadKits().catch((err: unknown) => {
      console.warn('the architecture kits did not load; building from plain stand-ins', err);
      registerFallbackKits();
      notice.add('The architecture kits did not load (kits/kits.glb is missing or damaged), so the city is built from plain blocks. Reinstalling Palimpsest restores them.');
    }),
  ]);
  /** The quality towers are built at: Settings' choice, until the city steps down by itself. */
  let quality: 'high' | 'medium' = settingsQuality;
  // Captures and the UI test hold the quality still with ?fixed-quality, so a slow headless frame never changes a shot.
  const autoQuality = !new URLSearchParams(location.search).has('fixed-quality');
  /**
   * Each tower's materials, picked over every repo that holds a slot,
   * connected or not, so neighbouring towers differ and a tower keeps its
   * look while a neighbour is switched off. Filled in by place().
   */
  let looks = new Map<string, Look>();
  /** Debug restyles (captures only): a look and a datum height per repo. */
  const restyled = new Map<string, { look: Look; datumIndex?: number }>();
  const lookOf = (d: District): Look => restyled.get(d.repo)?.look ?? looks.get(d.repo) ?? lookFor(d.repo);
  const city = createCity(host, {
    quality,
    autoQuality,
    makeDistrictCenterpiece: (d) => towerCenterpiece(d, quality, lookOf(d)),
    centerpieceKey: (d) => `${lookKey(lookOf(d))}|${quality}`,
    districtTones: (d) => towerTones(lookOf(d)),
  });

  const debug: DebugHandle = {
    ready: false,
    districts: 0,
    sites: 0,
    builds: 0,
    lastPick: null,
    inspect: (repo) => inspect(repo, null),
    highlight: null,
    view: (e, t) => city.view(new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(t[0], t[1], t[2])),
    camera: () => city.camera.position.toArray(),
    home: () => city.home(),
    limits: () => city.limits(),
    project: (p) => new THREE.Vector3(p[0], p[1], p[2]).project(city.camera).toArray(),
    precompile: () => city.precompile(),
    stats: () => city.stats(),
    quality: () => city.quality(),
    dropQuality: () => city.dropQuality(),
    notice: () => notice.text(),
    plots: () => city.plots(),
    async ambientBoard() {
      const board = ambientBoard(city.scene, city.camera, (lots) => city.ambientBoard(lots), (e, t) => city.view(e, t));
      await city.precompile();
      await texturesSettled();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return board.points(innerWidth, innerHeight);
    },
    async swatchBoard() {
      const board = swatchBoard(city.scene, city.camera, (e, t) => city.view(e, t));
      await city.precompile();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return board.points(innerWidth, innerHeight);
    },
    restyle(repo, ids, datumIndex) {
      const look = { ...lookOf(byRepo(repo) ?? ({ repo } as District)) };
      for (const id of ids) {
        const v = Object.values(VARIANTS).flat().find((x) => x.id === id);
        if (v) look[v.era] = v;
      }
      restyled.set(repo, { look, datumIndex });
      place();
    },
  };
  window.__palimpsest = debug;

  /** The towers the engine last served. */
  let served: District[] = [];
  /** The districts standing now: served towers whose repos are still connected. */
  let districts: District[] = [];
  /**
   * Every repo the page knows, connected or not, as last stored, with the
   * analysis step it reached. `done` holds a finished first analysis's
   * scaffold up until the refresh that brings its tower.
   */
  const known = new Map<string, RepoState & { step: string; done?: boolean }>();
  const byRepo = (repo: string): District | undefined => districts.find((d) => d.repo === repo);
  /** The step a repo's analysis last reported. */
  const analyzingStep = (repo: string): string => known.get(repo)?.step ?? '';

  // ---------------------------------------------------------------- navigation and screens
  const runhead = createRunhead(document.body);
  /** Screens listen to the one event stream while they are open. */
  const listeners = new Set<(e: EngineEvent) => void>();
  const listen = (fn: (e: EngineEvent) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const toCity = (): void => navigate('city');
  const repos = createRepos(document.body, { listen, onDismiss: toCity });
  const settings = createSettings(document.body, { listen, onDismiss: toCity, onStopped: (s) => runhead.setStopped(s) });
  void api.health().then((h) => runhead.setStopped(h.stopped), () => {});

  // ---------------------------------------------------------------- the inspector
  const inspector = createInspector(document.body, {
    onSelect(repo, floorId) {
      city.highlightFloor(repo, floorId);
      debug.highlight = floorId ? { repo, floorId } : null;
    },
    onFly(repo, floorId) {
      const f = city.floorFrame(repo, floorId);
      if (f) city.flyTo(f.center, Math.max(90, f.width * 4.4));
    },
    onClose() {
      city.highlightFloor('', null);
      debug.highlight = null;
      city.setInset(0);
    },
  });

  // ---------------------------------------------------------------- the market's names
  /** Agent and firm names for the earned floors, and each scar's inspection report, read from the engine. */
  let names: MarketNames = { agents: new Map(), firms: new Map(), inspections: new Map() };
  const readNames = coalesced(async () => {
    try {
      const firms = await api.firms();
      const agents = new Map<string, string>();
      for (const f of firms) for (const a of f.agents) agents.set(a.id, a.name);
      // A scar links to its inspection report: read the run once for each scar not yet known.
      const scars = served.flatMap((d) => d.tower.floors.filter((f) => f.earned?.state === 'scar').map((f) => f.earned!.runId));
      const inspections = new Map(names.inspections);
      await Promise.all(
        scars
          .filter((id) => !inspections.has(id))
          .map((id) =>
            api.run(id).then(
              (r) => {
                if (r.inspectionId) inspections.set(id, r.inspectionId);
              },
              () => {},
            ),
          ),
      );
      names = { agents, firms: new Map(firms.map((f) => [f.id, f.name])), inspections };
      inspector.setNames(names);
    } catch {
      /* the rows show ids until the names can be read */
    }
  });

  function inspect(repo: string, floorId: string | null): void {
    const d = byRepo(repo);
    if (!d) return;
    inspector.open(d, floorId);
    city.setInset(inspector.width);
    // From afar, approach the tower so it stands whole beside the panel; up close, the view stays where it is.
    const t = city.towerFrame(repo);
    if (t && city.camera.position.distanceTo(t.center) > Math.max(420, t.height * 3.5)) {
      city.flyTo(t.center, Math.max(160, t.height * 2.3));
    }
  }

  // The panel's width follows the window, and so does the view's offset.
  addEventListener('resize', () => {
    if (inspector.repo) city.setInset(inspector.width);
  });

  city.onPick((hit) => {
    debug.lastPick = hit;
    inspect(hit.repo, hit.floorId);
  });

  // ---------------------------------------------------------------- districts, sites and plates
  /**
   * Places everything from the one occupied set: towers, scaffolds, the
   * plazas and the blocks round them, and the plates. A repo that is not
   * connected (off, disconnected, or a connect stopped before any tower)
   * gives its plot back to the ambient city; its slot stays its own.
   */
  function place(): void {
    const restyledServed = served.map((d) => {
      const at = restyled.get(d.repo)?.datumIndex;
      return at === undefined ? d : { ...d, tower: { ...d.tower, datumIndex: at } };
    });
    const occ = occupancy(known.values(), restyledServed);
    const sites = new Map<string, number>();
    for (const d of served) sites.set(d.repo, d.index);
    for (const r of known.values()) sites.set(r.fullName, r.slot);
    looks = pickLooks([...sites].map(([repo, slot]) => ({ repo, slot })));
    districts = occ.districts;
    debug.builds += city.setPlots(occ);
    debug.districts = occ.districts.length;
    debug.sites = occ.sites.length;

    const plates: Plate[] = occ.districts.map((d) => {
      const [owner, name] = d.repo.split('/');
      const n = d.tower.floors.length;
      return {
        key: d.repo,
        origin: d.origin,
        name: name ?? d.repo,
        sub: `${owner}, ${n === 0 ? 'root only' : plural(n, 'floor')}`,
        onActivate: () => inspect(d.repo, null),
      };
    });
    for (const s of occ.sites) {
      const [, name] = s.repo.split('/');
      plates.push({ key: s.repo, origin: s.origin, name: name ?? s.repo, sub: STEP_TEXT[analyzingStep(s.repo)] ?? 'Surveying the site' });
    }
    city.setPlates(plates);

    const open = inspector.repo ? byRepo(inspector.repo) : undefined;
    if (inspector.repo && !open) inspector.close();
    else if (open) inspector.update(open);
  }

  const show = (next: District[]): void => {
    served = next;
    // A finished first analysis stops holding its scaffold once the refresh after it lands, tower or not.
    for (const r of known.values()) {
      if (r.done) {
        r.status = 'ready';
        r.done = false;
      }
    }
    place();
    // New scars may need their reports, and new floors their builders' names.
    readNames();
  };

  const countConnected = (): void => runhead.setConnected([...known.values()].filter((r) => r.connected).length);

  /** Takes a repo as stored now, keeping the step its analysis reached. */
  const takeRepo = (r: Repo, step?: string): void => {
    const was = known.get(r.fullName);
    known.set(r.fullName, {
      fullName: r.fullName,
      slot: r.slot,
      connected: r.connected,
      status: r.status,
      step: step ?? (r.status === 'analyzing' ? (was?.step ?? '') : ''),
    });
  };

  /** Takes the stored repos as they are now: which are connected, and which are analyzing. */
  const takeRepos = (list: Repo[]): void => {
    const steps = new Map([...known].map(([repo, k]) => [repo, k.step]));
    known.clear();
    for (const r of list) takeRepo(r, r.status === 'analyzing' ? steps.get(r.fullName) : undefined);
    countConnected();
  };

  try {
    const [loaded, repos] = await Promise.all([api.city(), api.repos().catch(() => [] as Repo[])]);
    takeRepos(repos);
    show(loaded);
  } catch (err) {
    console.warn('could not load the city from the engine', err);
    show([]);
  }

  // Events that land while a refresh is in flight are not dropped: one more refresh follows it.
  const refresh = coalesced(() =>
    api.city().then(show, (err) => {
      console.warn('city refresh failed', err);
    }),
  );
  api.events((e) => {
    if (e.type === 'engine.reconnected') {
      // Events sent while the stream was down are lost: read the repos, the city and the kill switch afresh.
      void api.repos().then((list) => {
        takeRepos(list);
        place();
      }, () => {});
      void api.health().then((h) => runhead.setStopped(h.stopped), () => {});
      refresh();
      for (const fn of listeners) fn(e);
      return;
    }
    // Every repo event carries the repo as stored when it was sent, toggles included: a step reported by an
    // analysis that runs on after its repo was turned off says connected: false, and so raises nothing.
    const repo = (e.data as { repo?: Repo } | null)?.repo;
    if (repo?.fullName && typeof repo.connected === 'boolean') {
      const step = e.type === 'repo.analyzing' ? ((e.data as { step?: string }).step ?? '') : undefined;
      takeRepo(repo, step);
      const k = known.get(repo.fullName);
      // The scaffold stays until the refresh below brings the tower, so the site is never briefly empty.
      if (k && e.type === 'repo.analyzed' && k.connected) {
        k.status = 'analyzing';
        k.done = true;
      }
      countConnected();
      place();
    }
    if (e.type === 'engine.stopped' || e.type === 'engine.resumed') runhead.setStopped(e.type === 'engine.stopped');
    if (REFRESH_ON.has(e.type)) refresh();
    if (NAMES_ON.has(e.type)) readNames();
    for (const fn of listeners) fn(e);
  });

  // Stepped down to medium by itself: every tower rebuilds at medium, and the notice says why.
  city.onQualityDrop(() => {
    quality = 'medium';
    place();
    notice.add('The city stepped down to medium quality to hold its frame rate. Settings can set it back to high for the next time it opens.');
  });

  // Escape on a sheet returns to the city, unless a field used it first (clearing a search, undoing a cap).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && document.body.dataset.route !== 'city') {
      e.preventDefault();
      toCity();
    }
    // H (or Home) in the city glides back to the home framing, which grows with the city.
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if ((e.key === 'h' || e.key === 'H' || e.key === 'Home') && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && !e.defaultPrevented && document.body.dataset.route === 'city') {
      e.preventDefault();
      city.home();
    }
  });

  // Repos and Settings draw over the city, which keeps running beside them.
  let lastRoute = 'city';
  onRoute((route) => {
    document.body.dataset.route = route;
    runhead.setRoute(route);
    if (route !== 'city') inspector.close();
    if (route === 'repos') repos.show();
    else repos.hide();
    if (route === 'settings') settings.show();
    else settings.hide();
    // Back in the city, focus returns to it rather than to a sheet that has gone.
    if (route === 'city' && lastRoute !== 'city') document.querySelector<HTMLElement>('#city canvas')?.focus({ preventScroll: true });
    lastRoute = route;
  });

  await city.ready;
  debug.ready = true;
  veil?.classList.add('gone');
  setTimeout(() => veil?.remove(), 1400);
}

void main();
