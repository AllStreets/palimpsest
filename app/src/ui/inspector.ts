import type { LifeGraduate, LifeNet, LifeVoyage } from '../city/campus/life.js';
import type { District, Era, Floor, FloorSize, Milestone, RootStyle, TowerSpec } from '../../../shared/types.js';
import { milestoneNote } from '../city/milestones.js';

export const ROOT_NAMES: Record<RootStyle, string> = {
  beauxarts: 'Beaux-Arts',
  roman: 'Roman',
  gothic: 'Gothic',
  pagoda: 'Pagoda',
  chicago: 'Chicago school',
  collegiate: 'Collegiate',
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

/** Who the market's floors belong to, by id: agent and firm names, and each failed run's inspection. */
export interface MarketNames {
  agents: Map<string, string>;
  firms: Map<string, string>;
  /** Run id to the id of its inspection report. */
  inspections: Map<string, string>;
  /** The milestones standing on floors, by floor id (GET /api/milestones?active=1). */
  milestones?: Map<string, Milestone>;
}

export const NO_NAMES: MarketNames = { agents: new Map(), firms: new Map(), inspections: new Map() };

/** What an earned floor's row says: who built it, for which job, where its PR or its inspection report is. */
export interface EarnedRow {
  agent: string;
  firm: string;
  /** The job's title, without the engine's "Failed inspection: " prefix. */
  job: string;
  pr: { text: string; href: string } | null;
  failed: boolean;
  /** A word on how the floor stands, when it is not simply merged. */
  state: string | null;
  /** A scar's inspection report (its run while the report id is not known yet). */
  report: string | null;
}

const SCAR_PREFIX = /^Failed inspection:\s*/;

export function earnedRow(f: Floor, names: MarketNames): EarnedRow {
  const e = f.earned;
  const failed = e?.state === 'scar';
  const link = failed ? null : floorLink(f);
  let state: string | null = null;
  if (failed) state = 'Failed inspection';
  else if (e?.reverted) state = 'Reverted';
  else if (e?.state === 'waiting') state = 'Waiting on your review';
  else if (e?.note && /^merged with his changes/i.test(e.note)) state = 'Merged with your changes';
  const inspection = e ? names.inspections.get(e.runId) : undefined;
  return {
    agent: e ? (names.agents.get(e.agentId) ?? e.agentId) : '',
    firm: e ? (names.firms.get(e.firmId) ?? e.firmId) : '',
    job: f.title.replace(SCAR_PREFIX, ''),
    pr: link?.href ? { text: link.text, href: link.href } : null,
    failed,
    state,
    report: failed && e ? (inspection ? `#/inspections/${encodeURIComponent(inspection)}` : `#/runs/${encodeURIComponent(e.runId)}`) : null,
  };
}

/**
 * Under the market's heading, what its bands mean on the tower outside, for
 * the kinds of floor this tower holds: lit floors merged, dark bands scars,
 * unlit ones waiting on his review. Empty when it holds none.
 */
export function marketKey(floors: readonly Floor[]): string {
  const states = new Set(floors.map((f) => f.earned?.state).filter(Boolean));
  if (!states.size) return '';
  const parts: string[] = [];
  if (states.has('lit')) parts.push('A lit floor is a change a firm built here that you merged');
  if (states.has('scar')) parts.push(`${parts.length ? 'a' : 'A'} dark band is a scar, work that failed inspection, kept where it failed`);
  if (states.has('waiting')) parts.push(`${parts.length ? 'a' : 'A'} floor still unlit waits on your review`);
  return `${parts.join('; ')}.`;
}

/** One line of the inspector's list, top to bottom. */
export type InspectorEntry =
  | { type: 'heading'; text: string; count: number; market: boolean }
  | { type: 'floor'; floor: Floor; n: number }
  | { type: 'datum' }
  | { type: 'root' };

/**
 * The inspector's list, top to bottom: the floors earned in the market
 * (newest first) under their own heading, the datum line, then the founding
 * floors grouped under the era each run began in, and the root.
 */
export function inspectorEntries(t: TowerSpec): InspectorEntry[] {
  const floors = t.floors;
  const out: InspectorEntry[] = [];
  const above = floors.length - t.datumIndex;
  if (above > 0) {
    out.push({ type: 'heading', text: 'Built in the market', count: above, market: true });
    for (let i = floors.length - 1; i >= t.datumIndex; i--) out.push({ type: 'floor', floor: floors[i], n: i + 1 });
  }
  if (floors.length > 0) out.push({ type: 'datum' });
  let era: Era | null = null;
  for (let i = Math.min(t.datumIndex, floors.length) - 1; i >= 0; i--) {
    const f = floors[i];
    if (f.era !== era) {
      era = f.era;
      let n = 0;
      for (let j = i; j >= 0 && floors[j].era === era; j--) n++;
      out.push({ type: 'heading', text: `${ERA_NAMES[era]} era`, count: n, market: false });
    }
    out.push({ type: 'floor', floor: f, n: i + 1 });
  }
  out.push({ type: 'root' });
  return out;
}

export interface InspectorHandlers {
  /** The selected floor changed (null: none). */
  onSelect(repo: string, floorId: string | null): void;
  /** Fly the camera to this floor. */
  onFly(repo: string, floorId: string): void;
  /** Ride the lift up the outside of this tower (Task 35; R does the same). */
  onRide?(repo: string): void;
  onClose(): void;
}

/** What the campus's panel lists: the live voyage, the nets' newest versions, the graduates, and the reading room's bays. */
export interface CampusInspectorView {
  voyage: LifeVoyage | null;
  nets: LifeNet[];
  graduates: LifeGraduate[];
  bays: number;
}

export interface CampusRow {
  title: string;
  meta: string;
  state: string | null;
  /** Where the row leads (a voyage's or an agent's page), or null. */
  href: string | null;
}

export interface CampusSection {
  key: 'voyage' | 'nets' | 'graduates';
  heading: string;
  count: string;
  rows: CampusRow[];
  /** What to say when there are no rows: the honest empty, in words. */
  empty: string | null;
}

const NET_NAMES: Record<string, string> = { appraiser: 'Appraiser', router: 'Router', durability: 'Durability', triage: 'Triage', taste: 'Taste', master: 'Master' };
const netName = (net: string): string => NET_NAMES[net] ?? net.charAt(0).toUpperCase() + net.slice(1);
const signed = (v: number): string => `${v < 0 ? '-' : ''}${Math.abs(v).toFixed(2)}`;

/**
 * The campus's inspector in words (Task 37): a voyage sailing (or paused for
 * the night) with its generation, runs and the bays it lights; each net's
 * newest version and whether it is trusted; each graduate, named by the
 * agent it became when hired, with its sealed difference against its base.
 * Every section says plainly when there is nothing yet.
 */
export function campusSections(v: CampusInspectorView, names: MarketNames): CampusSection[] {
  const voyage: CampusRow[] = [];
  if (v.voyage) {
    const w = v.voyage;
    const where = w.repo ? (w.repo.split('/')[1] ?? w.repo) : w.arena;
    const litBays = w.status === 'sailing' ? Math.min(v.bays, w.racing) : 0;
    const by = w.commissionedBy ? ` Commissioned by ${names.firms.get(w.commissionedBy) ?? w.commissionedBy}.` : '';
    const state = w.status === 'sailing' ? `${plural(w.racing, 'genome')} racing, ${litBays} of ${v.bays} reading-room bays lit.${by}` : `Paused for the night, the reading room dark.${by}`;
    voyage.push({ title: `A voyage on ${where}`, meta: `generation ${w.generation} of ${w.of}, ${w.runs.done} of ${w.runs.of} runs`, state, href: `#/school/voyages/${encodeURIComponent(w.id)}` });
  }
  const nets: CampusRow[] = v.nets.map((n) => ({ title: netName(n.net), meta: `version ${n.version}, ${n.trusted ? 'trusted' : 'trained but not yet trusted'}`, state: n.at ? floorDate(n.at) : null, href: null }));
  const graduates: CampusRow[] = v.graduates.map((g) => ({
    title: g.agentId ? (names.agents.get(g.agentId) ?? g.agentId) : g.model,
    meta: `${g.model} on ${g.base}, ${plural(g.examples, 'example')}`,
    state: `Beat its base by ${signed(g.vsBase.diff)} [${signed(g.vsBase.lo)}, ${signed(g.vsBase.hi)}] on the sealed race.`,
    href: g.agentId ? `#/agents/${encodeURIComponent(g.agentId)}` : null,
  }));
  return [
    { key: 'voyage', heading: 'Sailing now', count: voyage.length ? '1' : '', rows: voyage, empty: voyage.length ? null : 'No voyage sails tonight. The reading room is dark.' },
    { key: 'nets', heading: 'Trained nets', count: nets.length ? String(nets.length) : '', rows: nets, empty: nets.length ? null : 'No net has trained yet.' },
    { key: 'graduates', heading: 'Graduates', count: graduates.length ? String(graduates.length) : '', rows: graduates, empty: graduates.length ? null : 'No graduate yet. An adapter graduates only when it beats its base on a sealed race.' },
  ];
}

export interface Inspector {
  open(d: District, floorId?: string | null): void;
  /** Opens the panel on the university: the live voyage, the trained nets and the graduates (Task 37). */
  openCampus(v: CampusInspectorView): void;
  /** Re-draws the campus panel when it is open; nothing otherwise. */
  updateCampus(v: CampusInspectorView): void;
  /** Whether the campus panel is open. */
  readonly campus: boolean;
  /** Re-reads a district that was rebuilt, keeping the selection when its floor still exists. */
  update(d: District): void;
  /** Takes the market's names (agents, firms, inspection reports) and redraws the open tower's earned floors with them. */
  setNames(names: MarketNames): void;
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

export interface FloorListOptions {
  names: MarketNames;
  /** The list's accessible name. */
  label: string;
  /** A row was clicked: the inspector selects it and flies to it. Without it the rows only read. */
  onPick?(floorId: string): void;
  /** Builders' names link to their agent's page (the agent page itself leaves them plain). */
  linkAgents?: boolean;
}

/** A link that opens beside the city, never selecting the row it sits in. */
function link(text: string, href: string, title: string, external: boolean, className?: string, tabbable = false): HTMLAnchorElement {
  const a = el('a', className, text);
  a.href = href;
  if (external) {
    a.target = '_blank';
    a.rel = 'noopener';
  }
  a.title = title;
  // In a listbox the row is the tab stop and its links are reached by pointer; in a plain list they are tab stops of their own.
  if (!tabbable) a.tabIndex = -1;
  a.addEventListener('click', (ev) => ev.stopPropagation());
  return a;
}

/**
 * A tower floor by floor, as the inspector lists it: the market's floors
 * newest first under their heading, the datum line, the founding floors
 * under their eras, and the root. The inspector and the agent page (Task
 * 38) both draw it; the rows it returns are the floors, top to bottom.
 */
export function floorList(tower: TowerSpec, opts: FloorListOptions): { list: HTMLOListElement; rows: HTMLElement[] } {
  const rows: HTMLElement[] = [];
  const names = opts.names;
  // With nothing to pick, the list is a plain ordered list: no listbox, no options, every link a tab stop.
  const picking = !!opts.onPick;
  const list = el('ol', 'insp-floors');
  if (picking) list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', opts.label);
  const role = (e: HTMLElement, r: 'option' | 'presentation'): void => {
    if (picking) e.setAttribute('role', r);
  };
  const tab = !picking;
  const pickable = (r: HTMLElement, id: string): void => {
    if (!picking) {
      r.classList.add('still');
      r.removeAttribute('tabindex');
      return;
    }
    r.addEventListener('click', () => opts.onPick!(id));
  };

  /** An earned floor: its job, who built it for which firm, its PR (or its inspection report), how it stands. */
  function earnedFloorRow(f: Floor, n: number): HTMLElement {
    const e = earnedRow(f, names);
    const r = el('li', 'insp-floor insp-earned');
    r.dataset.floor = encodeURIComponent(f.id);
    role(r, 'option');
    r.tabIndex = -1;
    if (e.failed) r.classList.add('scar');
    if (f.earned?.state === 'waiting') r.classList.add('waiting');
    if (f.claude) r.classList.add('claude');

    const title = el('span', 'insp-title', e.job);
    title.title = e.job;
    const ref = el('span', 'insp-ref');
    if (e.pr) ref.append(link(e.pr.text, e.pr.href, `Open ${e.pr.text} on GitHub`, true, undefined, tab));
    else if (e.report) ref.append(link('Report', e.report, 'Open the inspection report', false, undefined, tab));

    const meta = el('span', 'insp-meta');
    const who = el('span', 'insp-who');
    // An agent's tower is its own page's: the builder's name opens it (Task 38).
    const agentHref = f.earned && opts.linkAgents !== false ? `#/agents/${encodeURIComponent(f.earned.agentId)}` : null;
    if (agentHref) who.append(link(e.agent, agentHref, `Open ${e.agent}’s page (Shift+Enter on the row)`, false, 'insp-agent', tab), document.createTextNode(`, ${e.firm}`));
    else who.textContent = `${e.agent}, ${e.firm}`;
    meta.append(who);
    if (f.claude) meta.append(el('span', 'insp-claude', 'with Claude'));

    r.append(el('span', 'insp-n', String(n)), title, ref, meta, el('span', 'insp-date', floorDate(f.at)));
    // How it stands, on a line of its own so the builder's name never gives way to it.
    if (e.state) r.append(el('span', e.failed ? 'insp-state insp-failed' : 'insp-state', e.state));
    const held = names.milestones?.get(f.id);
    const mark = held ? milestoneNote(held) : null;
    if (mark) {
      r.classList.add('marked');
      r.append(el('span', 'insp-mark', mark));
    }
    r.setAttribute('aria-label', `Floor ${n}, ${e.job}, built by ${e.agent} of ${e.firm}${e.state ? `, ${e.state.toLowerCase()}` : ''}${mark ? `, ${mark}` : ''}, ${floorDate(f.at)}${agentHref && picking ? `. Shift+Enter opens ${e.agent}’s page` : ''}`);
    if (agentHref && picking) {
      // The builder's link is not a tab stop inside the listbox: Shift+Enter on the row reaches it.
      r.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || !ev.shiftKey) return;
        ev.preventDefault();
        location.hash = agentHref;
      });
    }
    pickable(r, f.id);
    rows.push(r);
    return r;
  }

  function row(f: Floor, n: number): HTMLElement {
    const r = el('li', 'insp-floor');
    r.dataset.floor = encodeURIComponent(f.id);
    role(r, 'option');
    r.tabIndex = -1;
    if (f.claude) r.classList.add('claude');

    const num = el('span', 'insp-n', String(n));
    const title = el('span', 'insp-title', f.title);
    title.title = f.title;

    const fl = floorLink(f);
    const ref = el('span', 'insp-ref');
    if (fl.href) ref.append(link(fl.text, fl.href, `Open ${fl.text} on GitHub`, true, undefined, tab));
    else ref.textContent = fl.text;
    if (fl.more > 0) {
      const more = el('span', 'insp-more', `+${fl.more}`);
      more.title = `${plural(fl.more, 'more change')} merged into this floor`;
      ref.append(more);
    }

    const meta = el('span', 'insp-meta');
    meta.append(el('span', 'insp-size', `${SIZE_NAMES[f.size]}, ${plural(f.lines, 'line')}`));
    if (f.claude) meta.append(el('span', 'insp-claude', 'with Claude'));
    const date = el('span', 'insp-date', floorDate(f.at));

    r.append(num, title, ref, meta, date);
    const label = `Floor ${n}, ${f.title}, ${ERA_NAMES[f.era]} era, ${SIZE_NAMES[f.size].toLowerCase()} change, ${floorDate(f.at)}${f.claude ? ', with Claude' : ''}`;
    r.setAttribute('aria-label', label);
    pickable(r, f.id);
    rows.push(r);
    return r;
  }

  for (const e of inspectorEntries(tower)) {
    if (e.type === 'datum') {
      const datum = el('li', 'insp-datum');
      role(datum, 'presentation');
      datum.append(el('span', 'insp-datum-name', 'Datum line'), el('span', 'insp-datum-note', tower.kind === 'agent' ? 'where the agent joined the city' : 'where the repo joined the city'));
      list.append(datum);
    } else if (e.type === 'heading') {
      const eh = el('li', e.market ? 'insp-era insp-market' : 'insp-era');
      role(eh, 'presentation');
      eh.append(el('span', 'insp-era-name', e.text), el('span', 'insp-era-count', plural(e.count, 'floor')));
      list.append(eh);
      // What the lit and dark bands mean on the tower outside, said once under the market's heading.
      const key = e.market ? marketKey(tower.floors.slice(tower.datumIndex)) : '';
      if (key) {
        const k = el('li', 'insp-market-key', key);
        role(k, 'presentation');
        list.append(k);
      }
    } else if (e.type === 'floor') {
      list.append(e.floor.founding ? row(e.floor, e.n) : earnedFloorRow(e.floor, e.n));
    }
  }

  const root = el('li', 'insp-era insp-root');
  role(root, 'presentation');
  root.append(el('span', 'insp-era-name', `${ROOT_NAMES[tower.root]} root`), el('span', 'insp-era-count', 'inherited'));
  list.append(root);
  if (tower.floors.length === 0) {
    const empty = el('li', 'insp-empty', tower.kind === 'agent' ? 'No floors yet. The tower is its root until its first job merges.' : 'No merged changes yet. The tower is its root until the first one lands.');
    role(empty, 'presentation');
    list.append(empty);
  }
  return { list, rows };
}

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
  let campusView: CampusInspectorView | null = null;
  let selected: string | null = null;
  let rows: HTMLElement[] = [];
  let opener: HTMLElement | null = null;
  let names: MarketNames = NO_NAMES;

  /** The campus's panel: a head for the university and a list of the three sections (campusSections). */
  function renderCampus(v: CampusInspectorView): void {
    panel.replaceChildren();
    panel.classList.add('insp-campus');
    const head = el('header', 'insp-head');
    const close = el('button', 'insp-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the inspector');
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => api.close());
    const title = el('h2', 'insp-name', 'The University');
    title.id = 'insp-name';
    panel.setAttribute('aria-labelledby', title.id);
    const sections = campusSections(v, names);
    const facts = v.voyage ? (v.voyage.status === 'sailing' ? 'A voyage sails tonight' : 'A voyage, paused for the night') : 'Nothing sails tonight';
    head.append(close, el('p', 'insp-owner', 'The school'), title, el('p', 'insp-facts', `${facts}; ${plural(v.nets.length, 'net')} trained, ${plural(v.graduates.length, 'graduate')}`));
    const list = el('ol', 'insp-floors');
    list.setAttribute('aria-label', 'The university: its voyage, nets and graduates');
    for (const sec of sections) {
      const h = el('li', `insp-era insp-${sec.key}`);
      h.append(el('span', 'insp-era-name', sec.heading), el('span', 'insp-era-count', sec.count));
      list.append(h);
      if (sec.empty) {
        list.append(el('li', 'insp-empty', sec.empty));
        continue;
      }
      for (const r of sec.rows) {
        const li = el('li', 'insp-floor insp-earned insp-campus-row');
        const t = r.href ? link(r.title, r.href, r.title, false, 'insp-title') : el('span', 'insp-title', r.title);
        if (r.href) (t as HTMLAnchorElement).tabIndex = 0;
        li.append(t, el('span', 'insp-meta', r.meta));
        if (r.state) li.append(el('span', 'insp-state', r.state));
        list.append(li);
      }
    }
    panel.append(head, list);
  }

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
    panel.classList.remove('insp-campus');
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
        : `${ROOT_NAMES[d.tower.root]} root, ${plural(d.tower.datumIndex, 'founding floor')}${floors.length > d.tower.datumIndex ? `, ${floors.length - d.tower.datumIndex} earned` : ''}`;
    head.append(close, el('p', 'insp-owner', owner ?? ''), title, el('p', 'insp-facts', facts));
    if (h.onRide) {
      const ride = el('button', 'insp-ride');
      ride.type = 'button';
      ride.append(el('span', 'insp-ride-word', 'Ride up'), el('kbd', 'insp-ride-key', 'R'));
      ride.setAttribute('aria-label', `Ride the lift up the outside of ${name ?? d.repo}`);
      ride.setAttribute('aria-keyshortcuts', 'R');
      ride.addEventListener('click', () => h.onRide?.(d.repo));
      head.append(ride);
    }

    const built = floorList(d.tower, {
      names,
      label: `Floors of ${name ?? d.repo}, top to bottom`,
      onPick(id) {
        select(id, { focus: true });
        if (district) h.onFly(district.repo, id);
      },
    });
    const list = built.list;
    rows = built.rows;

    panel.append(head, list);
  }

  panel.addEventListener('keydown', (e) => {
    if (!district && !campusView) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      api.close();
      return;
    }
    if (!district || rows.length === 0) return;
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
        // Shift+Enter belongs to the row: it opens the builder's page.
        if (e.shiftKey || e.defaultPrevented) break;
        if (selected && (e.target as HTMLElement).classList.contains('insp-floor')) {
          e.preventDefault();
          h.onFly(district.repo, selected);
        }
        break;
    }
  });

  // Escape closes from anywhere while the inspector is open, unless the user is typing in a field.
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || (!district && !campusView) || e.defaultPrevented) return;
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
      else if (!district && !campusView) opener = null;
      campusView = null;
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
    openCampus(v) {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && !panel.contains(active)) opener = active;
      else if (!district && !campusView) opener = null;
      district = null;
      selected = null;
      rows = [];
      campusView = v;
      renderCampus(v);
      panel.hidden = false;
      requestAnimationFrame(() => panel.classList.add('open'));
      panel.querySelector<HTMLElement>('.insp-floors')?.scrollTo({ top: 0 });
      panel.querySelector<HTMLElement>('.insp-close')?.focus({ preventScroll: true });
    },
    updateCampus(v) {
      if (!campusView) return;
      if (JSON.stringify(v) === JSON.stringify(campusView)) return;
      const scroll = panel.querySelector('.insp-floors')?.scrollTop ?? 0;
      const hadFocus = panel.contains(document.activeElement);
      campusView = v;
      renderCampus(v);
      panel.querySelector('.insp-floors')?.scrollTo({ top: scroll });
      if (hadFocus) panel.querySelector<HTMLElement>('.insp-close')?.focus({ preventScroll: true });
    },
    get campus() {
      return campusView !== null;
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
    setNames(next) {
      names = next;
      if (campusView) {
        renderCampus(campusView);
        return;
      }
      if (!district) return;
      const keep = selected;
      const scroll = panel.querySelector('.insp-floors')?.scrollTop ?? 0;
      const hadFocus = panel.contains(document.activeElement);
      render(district);
      panel.querySelector('.insp-floors')?.scrollTo({ top: scroll });
      select(keep, { focus: hadFocus && keep !== null });
    },
    close() {
      if (!district && !campusView) return;
      district = null;
      campusView = null;
      panel.classList.remove('insp-campus');
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
      return district || campusView ? panel.getBoundingClientRect().width : 0;
    },
  };
  return api;
}
