import type { District, Era, Floor, FloorSize, RootStyle } from '../../../shared/types.js';

export const ROOT_NAMES: Record<RootStyle, string> = {
  beauxarts: 'Beaux-Arts',
  roman: 'Roman',
  gothic: 'Gothic',
  pagoda: 'Pagoda',
  chicago: 'Chicago school',
};

export const ERA_NAMES: Record<Era, string> = {
  stone: 'Stone',
  brick: 'Brick',
  glass: 'Glass',
  titanium: 'Titanium',
  scifi: 'Sci-fi',
};

const SIZE_NAMES: Record<FloorSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

/** Where a floor's first ref lives on GitHub, the text to show for it, and how many more refs were merged into the floor. */
export interface FloorLink {
  text: string;
  href: string | null;
  more: number;
}

/**
 * A PR ref `#42` links to the PR (the floor's own url when it is that PR);
 * a commit `abc1234` links to the commit; a range `abc1234..def5678` links
 * to the compare view. A floor made of several merged changes links its
 * first ref and counts the rest.
 */
export function floorLink(floor: Floor): FloorLink {
  const ref = floor.refs[0] ?? '';
  const base = `https://github.com/${floor.repo}`;
  const more = Math.max(0, floor.refs.length - 1);
  let href: string | null = null;
  const pr = /^#(\d+)$/.exec(ref);
  const range = /^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/i.exec(ref);
  if (pr) {
    // The floor's own url is used only when it is this PR on this repo's GitHub page.
    const own = floor.url && floor.url.startsWith(`${base}/`) && floor.url.endsWith(`/pull/${pr[1]}`);
    href = own ? floor.url : `${base}/pull/${pr[1]}`;
  } else if (range) {
    href = `${base}/compare/${range[1]}...${range[2]}`;
  } else if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    href = `${base}/commit/${ref}`;
  }
  return { text: ref, href, more };
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function floorDate(at: string): string {
  const t = Date.parse(at);
  return Number.isFinite(t) ? dateFormat.format(t) : '';
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export interface InspectorHandlers {
  /** The selected floor changed (null: none). */
  onSelect(repo: string, floorId: string | null): void;
  /** Fly the camera to this floor. */
  onFly(repo: string, floorId: string): void;
  onClose(): void;
}

export interface Inspector {
  open(d: District, floorId?: string | null): void;
  /** Re-reads a district that was rebuilt, keeping the selection when its floor still exists. */
  update(d: District): void;
  close(): void;
  readonly repo: string | null;
  readonly width: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CLOSE_ICON =
  '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>';

/**
 * The tower inspector: a printed index beside the city. The repo's name
 * set in Newsreader, its root and founding floor count, then every floor
 * from the top down in hairline rows grouped under their era, ending at the
 * root. Clicking a row (or Enter on it) flies to that floor; arrow keys move
 * between floors; Escape closes.
 */
export function createInspector(parent: HTMLElement, h: InspectorHandlers): Inspector {
  const panel = el('aside', 'inspector');
  panel.setAttribute('aria-label', 'Tower inspector');
  panel.hidden = true;
  parent.appendChild(panel);

  let district: District | null = null;
  let selected: string | null = null;
  let rows: HTMLElement[] = [];
  let opener: HTMLElement | null = null;

  const rowFor = (id: string | null): HTMLElement | undefined => rows.find((r) => r.dataset.floor === (id ? encodeURIComponent(id) : ''));

  function select(id: string | null, opts: { focus?: boolean; scroll?: boolean; center?: boolean } = {}): void {
    selected = id;
    for (const r of rows) {
      const on = id !== null && r.dataset.floor === encodeURIComponent(id);
      r.classList.toggle('selected', on);
      r.setAttribute('aria-selected', String(on));
      r.tabIndex = on ? 0 : -1;
    }
    const row = rowFor(id);
    if (!id && rows[0]) rows[0].tabIndex = 0;
    if (row && opts.scroll) row.scrollIntoView({ block: opts.center ? 'center' : 'nearest' });
    if (row && opts.focus) row.focus({ preventScroll: !opts.scroll });
    if (district) h.onSelect(district.repo, id);
  }

  function render(d: District): void {
    panel.replaceChildren();
    const [owner, name] = d.repo.split('/');
    const floors = d.tower.floors;

    const head = el('header', 'insp-head');
    const close = el('button', 'insp-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the inspector');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => api.close());
    const title = el('h2', 'insp-name', name ?? d.repo);
    title.id = 'insp-name';
    panel.setAttribute('aria-labelledby', title.id);
    const facts =
      floors.length === 0
        ? `${ROOT_NAMES[d.tower.root]} root, no floors yet`
        : `${ROOT_NAMES[d.tower.root]} root, ${plural(d.tower.datumIndex, 'founding floor')}`;
    head.append(close, el('p', 'insp-owner', owner ?? ''), title, el('p', 'insp-facts', facts));

    const list = el('ol', 'insp-floors');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', `Floors of ${name ?? d.repo}, top to bottom`);
    rows = [];

    if (floors.length > 0 && d.tower.datumIndex === floors.length) {
      const datum = el('li', 'insp-datum');
      datum.setAttribute('role', 'presentation');
      datum.append(el('span', 'insp-datum-name', 'Datum line'), el('span', 'insp-datum-note', 'where the repo joined the city'));
      list.append(datum);
    }

    // Top to bottom: newest floor first, a heading where each era begins.
    let era: Era | null = null;
    for (let i = floors.length - 1; i >= 0; i--) {
      const f = floors[i];
      if (f.era !== era) {
        era = f.era;
        let n = 0;
        for (let j = i; j >= 0 && floors[j].era === era; j--) n++;
        const eh = el('li', 'insp-era');
        eh.setAttribute('role', 'presentation');
        eh.append(el('span', 'insp-era-name', `${ERA_NAMES[era]} era`), el('span', 'insp-era-count', plural(n, 'floor')));
        list.append(eh);
      }
      list.append(row(f, i + 1));
    }

    const root = el('li', 'insp-era insp-root');
    root.setAttribute('role', 'presentation');
    root.append(el('span', 'insp-era-name', `${ROOT_NAMES[d.tower.root]} root`), el('span', 'insp-era-count', 'inherited'));
    list.append(root);
    if (floors.length === 0) {
      const empty = el('li', 'insp-empty', 'No merged changes yet. The tower is its root until the first one lands.');
      empty.setAttribute('role', 'presentation');
      list.append(empty);
    }

    panel.append(head, list);
  }

  function row(f: Floor, n: number): HTMLElement {
    const r = el('li', 'insp-floor');
    r.dataset.floor = encodeURIComponent(f.id);
    r.setAttribute('role', 'option');
    r.tabIndex = -1;
    if (f.claude) r.classList.add('claude');

    const num = el('span', 'insp-n', String(n));
    const title = el('span', 'insp-title', f.title);
    title.title = f.title;

    const link = floorLink(f);
    const ref = el('span', 'insp-ref');
    if (link.href) {
      const a = el('a', undefined, link.text);
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = `Open ${link.text} on GitHub`;
      a.tabIndex = -1;
      a.addEventListener('click', (e) => e.stopPropagation());
      ref.append(a);
    } else {
      ref.textContent = link.text;
    }
    if (link.more > 0) {
      const more = el('span', 'insp-more', `+${link.more}`);
      more.title = `${plural(link.more, 'more change')} merged into this floor`;
      ref.append(more);
    }

    const meta = el('span', 'insp-meta');
    meta.append(el('span', 'insp-size', `${SIZE_NAMES[f.size]}, ${plural(f.lines, 'line')}`));
    if (f.claude) meta.append(el('span', 'insp-claude', 'with Claude'));
    const date = el('span', 'insp-date', floorDate(f.at));

    r.append(num, title, ref, meta, date);
    const label = `Floor ${n}, ${f.title}, ${ERA_NAMES[f.era]} era, ${SIZE_NAMES[f.size].toLowerCase()} change, ${floorDate(f.at)}${f.claude ? ', with Claude' : ''}`;
    r.setAttribute('aria-label', label);
    r.addEventListener('click', () => {
      select(f.id, { focus: true });
      if (district) h.onFly(district.repo, f.id);
    });
    rows.push(r);
    return r;
  }

  panel.addEventListener('keydown', (e) => {
    if (!district) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      api.close();
      return;
    }
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r.dataset.floor === (selected ? encodeURIComponent(selected) : ''));
    const go = (i: number): void => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
      select(decodeURIComponent(next.dataset.floor ?? ''), { focus: true, scroll: true });
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(at < 0 ? 0 : at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(at < 0 ? 0 : at - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(rows.length - 1);
        break;
      case 'Enter':
        if (selected && (e.target as HTMLElement).classList.contains('insp-floor')) {
          e.preventDefault();
          h.onFly(district.repo, selected);
        }
        break;
    }
  });

  // Escape closes from anywhere while the inspector is open, unless the user is typing in a field.
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !district || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    api.close();
  };
  document.addEventListener('keydown', onDocKey);

  const api: Inspector = {
    open(d, floorId = null) {
      const reopening = district?.repo === d.repo;
      // Remember where focus came from (a plate, say), unless it is already inside the panel.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && !panel.contains(active)) opener = active;
      else if (!district) opener = null;
      district = d;
      render(d);
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('open'));
      const known = floorId && d.tower.floors.some((f) => f.id === floorId) ? floorId : null;
      select(known, { scroll: true, center: true });
      if (!known && !reopening) panel.querySelector<HTMLElement>('.insp-floors')?.scrollTo({ top: 0 });
      const target = rowFor(known) ?? rows[0];
      (target ?? panel.querySelector<HTMLElement>('.insp-close'))?.focus({ preventScroll: true });
    },
    update(d) {
      if (!district || district.repo !== d.repo) return;
      // A refresh for another repo hands back the same district: leave the list (and the focus in it) alone.
      if (JSON.stringify(d) === JSON.stringify(district)) return;
      const keep = selected && d.tower.floors.some((f) => f.id === selected) ? selected : null;
      const scroll = panel.querySelector('.insp-floors')?.scrollTop ?? 0;
      const hadFocus = panel.contains(document.activeElement);
      district = d;
      render(d);
      panel.querySelector('.insp-floors')?.scrollTo({ top: scroll });
      select(keep, { focus: hadFocus && keep !== null });
      if (hadFocus && !panel.contains(document.activeElement)) {
        (rows[0] ?? panel.querySelector<HTMLElement>('.insp-close'))?.focus({ preventScroll: true });
      }
    },
    close() {
      if (!district) return;
      district = null;
      selected = null;
      rows = [];
      const hadFocus = panel.contains(document.activeElement);
      panel.classList.remove('open');
      panel.hidden = true;
      h.onClose();
      // Focus goes back to what opened the inspector, or to the city.
      if (hadFocus || document.activeElement === document.body) {
        const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>('#city canvas');
        back?.focus({ preventScroll: true });
      }
      opener = null;
    },
    get repo() {
      return district?.repo ?? null;
    },
    get width() {
      return district ? panel.getBoundingClientRect().width : 0;
    },
  };
  return api;
}
