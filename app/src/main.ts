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
import type { EngineEvent } from './api';
import { navigate, onRoute } from './router';
import { createInspector } from './ui/inspector';
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
  /** Plazas paved (the civic plaza included) and ambient buildings standing. */
  plots(): { plazas: number; buildings: number };
}

declare global {
  interface Window {
    __palimpsest?: DebugHandle;
  }
}

/** Events that change what stands in the city: a new tower, a failed one, a restyle, or a district leaving. */
const REFRESH_ON = new Set(['repo.connected', 'repo.analyzed', 'repo.error', 'repo.patched', 'repo.disconnected']);

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

  const quality = await api.settings().then(
    (s) => s.quality,
    () => 'high' as const,
  );
  const city = createCity(host, { quality, makeDistrictCenterpiece: (d) => towerCenterpiece(d, quality) });

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
    plots: () => city.plots(),
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
    const occ = occupancy(known.values(), served);
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
    for (const fn of listeners) fn(e);
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
