import * as THREE from 'three';

import './ui/style.css';
import './ui/screens.css';

import { districtOrigin } from '../../shared/district-layout';
import type { District, Repo } from '../../shared/types';
import { api } from './api';
import { coalesced } from './coalesce';
import type { Plate } from './city/labels';
import { createCity, type PickHit, type Site } from './city/scene';
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
  precompile(): Promise<void>;
  stats(): { calls: number; triangles: number };
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
    precompile: () => city.precompile(),
    stats: () => city.stats(),
  };
  window.__palimpsest = debug;

  let districts: District[] = [];
  /** Repos whose first analysis is running, with the step it reached. */
  const analyzing = new Map<string, { slot: number; step: string; done?: boolean }>();
  const byRepo = (repo: string): District | undefined => districts.find((d) => d.repo === repo);

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
  function showPlates(): void {
    const plates: Plate[] = districts.map((d) => {
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
    for (const s of sitesNow()) {
      const [, name] = s.repo.split('/');
      plates.push({ key: s.repo, origin: s.origin, name: name ?? s.repo, sub: STEP_TEXT[analyzing.get(s.repo)?.step ?? ''] ?? 'Surveying the site' });
    }
    city.setPlates(plates);
  }

  /** A scaffold stands only where a repo is analyzing for the first time: a district that already has a tower keeps it. */
  function sitesNow(): Site[] {
    return [...analyzing]
      .filter(([repo]) => !byRepo(repo))
      .map(([repo, a]) => ({ repo, origin: districtOrigin(a.slot) }));
  }

  function showSites(): void {
    const sites = sitesNow();
    city.setSites(sites);
    debug.sites = sites.length;
    showPlates();
  }

  const show = (next: District[]): void => {
    districts = next;
    debug.builds += city.setDistricts(next);
    debug.districts = next.length;
    // A repo whose tower has arrived is no longer a site, however its events were ordered.
    for (const d of next) analyzing.delete(d.repo);
    runhead.setConnected(next.length);
    // A finished analysis whose repo has no district (disconnected meanwhile) leaves no scaffold behind.
    for (const [repo, a] of analyzing) if (a.done) analyzing.delete(repo);
    showSites();
    const open = inspector.repo ? byRepo(inspector.repo) : undefined;
    if (inspector.repo && !open) inspector.close();
    else if (open) inspector.update(open);
  };

  try {
    const [loaded, repos] = await Promise.all([api.city(), api.repos().catch(() => [] as Repo[])]);
    for (const r of repos) if (r.connected && r.status === 'analyzing') analyzing.set(r.fullName, { slot: r.slot, step: '' });
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
    const repo = (e.data as { repo?: Repo } | null)?.repo;
    if (e.type === 'repo.analyzing' && repo?.fullName) {
      analyzing.set(repo.fullName, { slot: repo.slot, step: (e.data as { step?: string }).step ?? '' });
      showSites();
    } else if ((e.type === 'repo.error' || e.type === 'repo.disconnected') && repo?.fullName) {
      // An error shows nothing new in the city: the scaffold comes down, the Repos screen carries the message.
      analyzing.delete(repo.fullName);
      showSites();
    } else if (e.type === 'repo.analyzed' && repo?.fullName) {
      // The scaffold stays until the refresh below brings the tower, so the site is never briefly empty.
      const a = analyzing.get(repo.fullName);
      if (a) a.done = true;
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
