import type { Route } from '../router';
import { currentSection, routeHref, SCREENS } from '../router';
import { el } from './controls';
import { repoCount } from './repos-words';
import { createPalette, shortcutLabel } from './palette';
import { guardPlates } from './plate-guard';
import { weighKey } from './os/control';

export interface Runhead {
  /** The head itself, for the city's one-line notices to stand in. */
  el: HTMLElement;
  setRoute(route: Route): void;
  setConnected(n: number): void;
  setStopped(stopped: boolean): void;
}

/**
 * The running head, top left, on every screen, in the screens' language
 * (os/topbar.css): the mark and the name as one plate, then the places, the
 * current one held in amber corner ticks. Plain links, so Tab and Enter reach
 * them, each with the os focus ring. After them, Find: a cold look key for the
 * command palette (Phase 5), which the head mounts.
 */
export function createRunhead(parent: HTMLElement): Runhead {
  const nav = el('nav', 'runhead');
  nav.setAttribute('aria-label', 'Palimpsest');
  // The small mark, the P carved in stone, at 18 px before the name (its @2x for Retina).
  const icon = el('img', 'runhead-icon');
  icon.src = '/brand/mark-18.png';
  icon.srcset = '/brand/mark-18.png 1x, /brand/mark-18@2x.png 2x';
  icon.width = 18;
  icon.height = 18;
  icon.alt = '';
  const mark = el('span', 'runhead-mark', 'Palimpsest');
  const links = new Map<Route, HTMLAnchorElement>();
  // Held unseen until the first count comes, so the head is laid out once (repoCount).
  const count = el('span', 'runhead-count', '0');
  count.style.visibility = 'hidden';
  count.setAttribute('aria-hidden', 'true');
  // The stone mark and the name as one plate.
  const brand = el('span', 'runhead-brand');
  brand.append(icon, mark);
  nav.append(brand);
  for (const { route, name: text } of SCREENS) {
    const a = el('a', 'runhead-link os-focus', text);
    a.href = routeHref(route);
    a.dataset.route = route;
    if (route === 'repos') a.append(count);
    links.set(route, a);
    nav.append(a);
  }
  // Find anything in the city (Phase 5): the palette, opened by Cmd+K or from here.
  const palette = createPalette(parent);
  const findBtn = el('button', 'runhead-find');
  findBtn.type = 'button';
  findBtn.append(el('span', 'runhead-find-word', 'Find'), el('span', 'runhead-find-key', shortcutLabel(navigator.platform)));
  findBtn.setAttribute('aria-label', 'Find anything in the city');
  findBtn.setAttribute('aria-keyshortcuts', 'Meta+K Control+K');
  findBtn.addEventListener('click', () => palette.open());
  // Finding is looking: the lightest of the four weights.
  weighKey(findBtn, 'look');
  nav.append(findBtn);
  const stopped = el('a', 'runhead-stopped os-focus', 'Stopped');
  stopped.href = routeHref('settings');
  stopped.title = 'The kill switch is on. Open Settings to turn it off.';
  stopped.hidden = true;
  nav.append(stopped);
  parent.append(nav);
  // No name plate shows half past an open sheet's edge (plate-guard.ts).
  guardPlates(parent.ownerDocument);

  return {
    el: nav,
    setRoute(route) {
      const section = currentSection(route);
      for (const [r, a] of links) {
        if (r === section) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
    },
    setConnected(n) {
      const c = repoCount(n);
      count.textContent = c.text;
      count.style.visibility = c.shown ? '' : 'hidden';
      if (c.shown) count.removeAttribute('aria-hidden');
      else count.setAttribute('aria-hidden', 'true');
    },
    setStopped(on) {
      stopped.hidden = !on;
    },
  };
}
