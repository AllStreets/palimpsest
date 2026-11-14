/**
 * His autonomy where he already looks (Phase 4 Task 31): one ruled row per
 * (kind, repo) pair with its state in a few words and its one move, set
 * the same in Settings, which lists every pair and grants a revoked one
 * again, and on a district page, which lists its own. Every move goes
 * through the Task 28 client (x-palimpsest, own page); a row offers only
 * what the engine accepts (brief-words `grantMoves`), and when the engine
 * refuses anyway its own sentence stands under the row.
 */
import type { Agreement, Grant } from '../../../shared/types';
import { api } from '../api';
import { placeHref } from '../router';
import { cleanText } from './board';
import { grantMoves, grantState, MOVE_LABEL, type GrantMove } from './brief-words';
import { el, plural, textButton } from './controls';
import { refusal } from './pages';
import { fixed, kindLabel } from './school-words';

/** A pair's key: its kind and its repo. */
export const pairKey = (g: Pick<Grant, 'kind' | 'repo'>): string => `${g.kind} ${g.repo}`;

export interface GrantsOptions {
  /** On a district page: only this repo's pairs, the repo not named again on each row. */
  repo?: string;
  onGrant(g: Grant): void;
  onDecline(g: Grant): void;
  onRevoke(g: Grant): void;
  /** Settings alone grants a revoked pair again (ruling 17); without it a revoked row offers nothing. */
  onRegrant?(g: Grant): void;
  /** Pairs with a move in flight, and the engine's refusal of the last move on a pair. */
  busy?: ReadonlySet<string>;
  errors?: ReadonlyMap<string, string>;
  now?: number;
}

/** The kind's agreement over its window, as a figure and its count, or nothing to show. */
function agreementOf(g: Grant, agreements: Agreement[]): { rate: string; of: string } | null {
  const a = agreements.find((x) => x.kind === g.kind && x.repo === null) ?? agreements.find((x) => x.kind === g.kind);
  if (!a || a.skewed || a.rows === 0 || !a.rate) return null;
  return { rate: fixed(a.rate.value), of: `${a.agreed} of ${a.rows}` };
}

/**
 * The pairs as a ledger: kind (and repo, in Settings), the state ("granted
 * 3 November, 6 merges since"), the master's agreement on the kind, and the
 * move. Null when there is no pair to list.
 */
export function renderGrants(grants: Grant[], agreements: Agreement[], opts: GrantsOptions): HTMLElement | null {
  const where = opts.onRegrant ? 'settings' : 'district';
  const mine = opts.repo ? grants.filter((g) => g.repo === opts.repo) : grants;
  if (!mine.length) return null;
  const now = opts.now ?? Date.now();
  const list = el('ol', 'grant-book');
  list.setAttribute('aria-label', opts.repo ? `Autonomy on ${opts.repo}` : 'Autonomy by kind and repo');
  for (const g of mine) {
    const key = pairKey(g);
    const busy = opts.busy?.has(key) ?? false;
    const li = el('li', 'grant-entry');
    li.dataset.kind = g.kind;
    li.dataset.repo = g.repo;
    li.dataset.state = g.state;
    li.dataset.pair = key;
    if (busy) li.setAttribute('aria-busy', 'true');

    const name = el('div', 'grant-entry-name');
    name.append(el('span', 'grant-entry-kind', kindLabel(g.kind)));
    if (!opts.repo) {
      const repo = el('a', 'grant-entry-repo', cleanText(g.repo, 80));
      repo.href = placeHref('repo', g.repo);
      name.append(repo);
    }

    const state = el('p', `grant-entry-state g-${g.state}`, grantState(g, now));
    state.tabIndex = -1;
    const figure = el('div', 'grant-entry-fig');
    const agree = g.state === 'declined' ? null : agreementOf(g, agreements);
    if (agree) {
      figure.append(el('span', 'grant-entry-rate', agree.rate), el('span', 'grant-entry-of', agree.of));
      figure.setAttribute('aria-label', `The master agreed with you on ${agree.of} ${kindLabel(g.kind).toLowerCase()}: ${agree.rate}`);
    }

    const acts = el('div', 'grant-entry-acts');
    const handler: Record<GrantMove, ((x: Grant) => void) | undefined> = { grant: opts.onGrant, decline: opts.onDecline, revoke: opts.onRevoke, regrant: opts.onRegrant };
    for (const m of grantMoves(g, where)) {
      const fn = handler[m];
      if (!fn) continue;
      const b = textButton('grant-move', MOVE_LABEL[m], () => fn(g));
      b.dataset.move = m;
      b.setAttribute('aria-label', `${MOVE_LABEL[m]}: ${kindLabel(g.kind)} on ${g.repo}`);
      b.disabled = busy;
      acts.append(b);
    }
    // On a district page a revoked pair is granted again only from Settings: say where.
    if (g.state === 'revoked' && where === 'district') {
      const to = el('a', 'grant-entry-to', 'Grant it again in Settings');
      to.href = placeHref('settings');
      acts.append(to);
    }

    li.append(name, state, figure, acts);
    const err = opts.errors?.get(key);
    if (err) {
      const p = el('p', 'grant-entry-error', err);
      p.setAttribute('role', 'alert');
      li.append(p);
    }
    list.append(li);
  }
  return list;
}

/** What a block of grants shows: the pairs and the kinds' agreements, from the school view. */
export interface GrantsData {
  grants: Grant[];
  agreements: Agreement[];
  /** On a district page, its repo: only its pairs, the repo not named on each row. */
  repo?: string;
}

export interface GrantsBlock {
  el: HTMLElement;
  /** Draws the pairs as the engine has them, or the empty sentence. */
  set(data: GrantsData | null, empty: string): void;
}

/**
 * A live block of pairs that moves them through the client: each move
 * marks its row busy, takes the engine's answer in place, keeps a refusal
 * under the row in the engine's words, and puts focus back on the row.
 * `changed` asks the page to read the school again.
 */
export function grantsBlock(o: { where: 'settings' | 'district'; changed(): void }): GrantsBlock {
  const root = el('div', 'grants-block');
  let data: GrantsData | null = null;
  let emptyText = '';
  let drawn = '';
  const busy = new Set<string>();
  const errors = new Map<string, string>();
  let focusNext: { key: string; move: GrantMove | null } | null = null;

  async function move(g: Grant, m: GrantMove): Promise<void> {
    const key = pairKey(g);
    if (busy.has(key)) return;
    busy.add(key);
    errors.delete(key);
    draw();
    try {
      const next = m === 'grant' ? await api.grant(g.kind, g.repo) : m === 'regrant' ? await api.grant(g.kind, g.repo, { fromSettings: true }) : m === 'decline' ? await api.decline(g.kind, g.repo) : await api.revoke(g.kind, g.repo);
      if (data) data = { ...data, grants: data.grants.map((x) => (pairKey(x) === key ? next : x)) };
      focusNext = { key, move: null };
    } catch (err) {
      errors.set(key, refusal(MOVE_LABEL[m], err));
      focusNext = { key, move: m };
    } finally {
      busy.delete(key);
      draw();
      o.changed();
    }
  }

  function draw(): void {
    const sig = JSON.stringify([data, emptyText, [...busy], [...errors], new Date().getDate()]);
    if (sig === drawn) return settle();
    drawn = sig;
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const was = focused ? { key: focused.closest<HTMLElement>('[data-pair]')?.dataset.pair ?? '', move: (focused.dataset.move as GrantMove | undefined) ?? null } : null;
    const list = data
      ? renderGrants(data.grants, data.agreements, {
          repo: data.repo,
          onGrant: (g) => void move(g, 'grant'),
          onDecline: (g) => void move(g, 'decline'),
          onRevoke: (g) => void move(g, 'revoke'),
          ...(o.where === 'settings' ? { onRegrant: (g: Grant) => void move(g, 'regrant') } : {}),
          busy,
          errors,
        })
      : null;
    root.replaceChildren(list ?? el('p', 'grants-empty', emptyText));
    if (!focusNext && was?.key) focusNext = was;
    settle();
  }

  /** Focus to where it was or where the move left it: the same move, else the row's first move, else its state. */
  function settle(): void {
    if (!focusNext) return;
    const f = focusNext;
    focusNext = null;
    const row = [...root.querySelectorAll<HTMLElement>('[data-pair]')].find((r) => r.dataset.pair === f.key);
    if (!row) return;
    const target = (f.move ? row.querySelector<HTMLElement>(`[data-move="${f.move}"]:not(:disabled)`) : null) ?? row.querySelector<HTMLElement>('.grant-move:not(:disabled), .grant-entry-to') ?? row.querySelector<HTMLElement>('.grant-entry-state');
    target?.focus({ preventScroll: true });
  }

  return {
    el: root,
    set(d, empty) {
      data = d;
      emptyText = empty;
      draw();
    },
  };
}

/** "2 granted, 1 asked", for a section's aside. */
export function grantsAside(grants: Grant[]): string {
  const count = (s: Grant['state']) => grants.filter((g) => g.state === s).length;
  const parts: string[] = [];
  if (count('asked')) parts.push(`${count('asked')} asked`);
  if (count('granted')) parts.push(`${count('granted')} granted`);
  if (count('suspended')) parts.push(`${count('suspended')} suspended`);
  if (count('revoked')) parts.push(`${count('revoked')} taken back`);
  if (count('declined')) parts.push(`${count('declined')} declined`);
  return parts.join(', ') || (grants.length ? plural(grants.length, 'pair') : 'none asked');
}
