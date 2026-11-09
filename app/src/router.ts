/** The app's screens. The city is always rendered; other routes draw over it. */
export type Route = 'city' | 'repos' | 'settings';

const ROUTES: Record<string, Route> = {
  '': 'city',
  '#/': 'city',
  '#/repos': 'repos',
  '#/settings': 'settings',
};

/** The route for the current location hash; unknown hashes fall back to the city. */
export function currentRoute(): Route {
  return ROUTES[location.hash] ?? 'city';
}

/** The hash for a route, for links and for navigate(). */
export function routeHref(route: Route): string {
  return route === 'city' ? '#/' : `#/${route}`;
}

export function navigate(route: Route): void {
  location.hash = routeHref(route);
}

/** Calls `fn` now and on every route change. Returns a function that stops listening. */
export function onRoute(fn: (route: Route) => void): () => void {
  const handler = (): void => fn(currentRoute());
  addEventListener('hashchange', handler);
  handler();
  return () => removeEventListener('hashchange', handler);
}
