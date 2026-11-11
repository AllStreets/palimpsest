/**
 * The app's screens. The city is always rendered; other routes draw over it.
 * A route with an id (a job, a firm, an agent, a run, an inspection, a repo)
 * carries it in the address: `#/jobs/<id>`, `#/repos/<owner>/<name>`.
 */
export type Route = 'city' | 'repos' | 'settings' | 'jobs' | 'job' | 'firms' | 'firm' | 'agent' | 'run' | 'inspection' | 'treasury' | 'repo';

/** Where the app is: a route, and the id it opens on (null for a list or the city). */
export interface Place {
  route: Route;
  id: string | null;
}

/** Routes without an id, by their one path segment. */
const LISTS: Record<string, Route> = {
  repos: 'repos',
  settings: 'settings',
  jobs: 'jobs',
  firms: 'firms',
  treasury: 'treasury',
};

/** Routes with one id segment, by the list they sit under. */
const ONE: Record<string, Route> = {
  jobs: 'job',
  firms: 'firm',
  agents: 'agent',
  runs: 'run',
  inspections: 'inspection',
};

const PATH_OF: Record<Route, string> = {
  city: '',
  repos: 'repos',
  settings: 'settings',
  jobs: 'jobs',
  job: 'jobs',
  firms: 'firms',
  firm: 'firms',
  agent: 'agents',
  run: 'runs',
  inspection: 'inspections',
  treasury: 'treasury',
  repo: 'repos',
};

const CITY: Place = { route: 'city', id: null };

/** One decoded path segment, or null when it is empty, undecodable, or would read as a path. */
function segment(raw: string): string | null {
  let s: string;
  try {
    s = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!s || s === '.' || s === '..' || s.includes('/')) return null;
  return s;
}

/** The place a location hash names; anything it does not know is the city. */
export function parseHash(hash: string): Place {
  if (hash === '' || hash === '#' || hash === '#/') return CITY;
  if (!hash.startsWith('#/')) return CITY;
  const parts = hash.slice(2).split('/');
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  const [head, ...rest] = parts;
  if (rest.length === 0) return LISTS[head] ? { route: LISTS[head], id: null } : CITY;
  if (head === 'repos') {
    if (rest.length !== 2) return CITY;
    const owner = segment(rest[0]);
    const name = segment(rest[1]);
    return owner && name ? { route: 'repo', id: `${owner}/${name}` } : CITY;
  }
  if (rest.length !== 1 || !ONE[head]) return CITY;
  const id = segment(rest[0]);
  return id ? { route: ONE[head], id } : CITY;
}

/** The hash for a place, for links and for navigate(). */
export function placeHref(route: Route, id: string | null = null): string {
  if (route === 'city') return '#/';
  const base = `#/${PATH_OF[route]}`;
  if (id === null) return base;
  if (route === 'repo') {
    const [owner, name] = id.split('/');
    return `${base}/${encodeURIComponent(owner)}/${encodeURIComponent(name ?? '')}`;
  }
  return `${base}/${encodeURIComponent(id)}`;
}

/** The place for the current location hash. */
export function currentPlace(): Place {
  return parseHash(location.hash);
}

/** The route for the current location hash; unknown hashes fall back to the city. */
export function currentRoute(): Route {
  return currentPlace().route;
}

/** The hash for a route, for links and for navigate(). */
export function routeHref(route: Route): string {
  return placeHref(route);
}

export function navigate(route: Route, id: string | null = null): void {
  location.hash = placeHref(route, id);
}

/** Calls `fn` now and on every route change. Returns a function that stops listening. */
export function onRoute(fn: (route: Route, place: Place) => void): () => void {
  const handler = (): void => {
    const p = currentPlace();
    fn(p.route, p);
  };
  addEventListener('hashchange', handler);
  handler();
  return () => removeEventListener('hashchange', handler);
}
