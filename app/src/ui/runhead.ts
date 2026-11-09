import type { Route } from '../router';
import { routeHref } from '../router';
import { el } from './controls';

export interface Runhead {
  setRoute(route: Route): void;
  setConnected(n: number): void;
  setStopped(stopped: boolean): void;
}

/**
 * The running head, top left, as a book prints its title above the page:
 * the name in italic, then the three places, the current one ruled in
 * bronze beneath. Plain links, so Tab and Enter reach them.
 */
export function createRunhead(parent: HTMLElement): Runhead {
  const nav = el('nav', 'runhead');
  nav.setAttribute('aria-label', 'Palimpsest');
  const mark = el('span', 'runhead-mark', 'Palimpsest');
  const links = new Map<Route, HTMLAnchorElement>();
  const count = el('span', 'runhead-count');
  nav.append(mark);
  for (const [route, text] of [
    ['city', 'City'],
    ['repos', 'Repos'],
    ['settings', 'Settings'],
  ] as Array<[Route, string]>) {
    const a = el('a', 'runhead-link', text);
    a.href = routeHref(route);
    a.dataset.route = route;
    if (route === 'repos') a.append(count);
    links.set(route, a);
    nav.append(a);
  }
  const stopped = el('a', 'runhead-stopped', 'Stopped');
  stopped.href = routeHref('settings');
  stopped.title = 'The kill switch is on. Open Settings to turn it off.';
  stopped.hidden = true;
  nav.append(stopped);
  parent.append(nav);

  return {
    setRoute(route) {
      for (const [r, a] of links) {
        if (r === route) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
    },
    setConnected(n) {
      count.textContent = n > 0 ? String(n) : '';
    },
    setStopped(on) {
      stopped.hidden = !on;
    },
  };
}
