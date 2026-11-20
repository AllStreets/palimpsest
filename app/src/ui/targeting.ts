/**
 * Targeting (redesign direction C, a throwaway prototype): the HUD the Brief lays over the live city. Each item
 * with a district gets a readout pinned over its tower; the active item (hovered, focused, or else the first
 * that waits) gets a lock-on round its tower and a leader line from its row. A scan sweeps the city pane, and a
 * stream of the brief's own figures runs behind the list. Everything moves by transform or by an SVG path's
 * points, written once a frame from the city's own frame hook, and only while the Brief is open.
 */
import * as THREE from 'three';

import { projectToView } from '../city/labels.js';
import { el } from './controls.js';

/** The city under the HUD: its camera, where a tower stands, and a hook run every frame after the plates. */
export interface HudCity {
  camera: THREE.Camera;
  towerFrame(repo: string): { center: THREE.Vector3; width: number; height: number } | null;
  onFrame(fn: () => void): () => void;
  /** Every repo's district now standing: the ones with nothing waiting get a quiet pin while the Brief is open. */
  districts(): string[];
}

/** One item the HUD tracks: its number in the list, its district, and the figure its pinned readout shows. */
export interface Target {
  id: string;
  n: number;
  repo: string;
  /** The district's short name. */
  name: string;
  figure: string;
  tone: string;
  grant: boolean;
}

export interface Hud {
  show(): void;
  hide(): void;
  setTargets(targets: Target[]): void;
  /** The item locked on, and its row (the leader line leaves from the row's middle). */
  setActive(id: string | null, row: HTMLElement | null): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const pad2 = (n: number): string => String(n).padStart(2, '0');

interface Pin {
  repo: string;
  targets: Target[];
  /** A district with nothing waiting: its name only, dim, and it gives way to any target it would cover. */
  quiet: boolean;
  el: HTMLElement;
  tag: HTMLElement | null;
  /** The tag's size, read once it has laid out (0 until then): the leader's router keeps clear of it. */
  w: number;
  h: number;
  frame: { center: THREE.Vector3; width: number; height: number } | null;
  shown: boolean;
  /** How far its tag stands lifted to clear a pin placed before it, in pixels. */
  lift: number;
}

/** A pin's tag's reach to the right of its mark, for the collision test. */
const PIN_W = 170;
/** The lock's tag's width: past the window's right edge it stands left of the brackets instead. */
const LOCK_TAG_W = 200;

/** A box on screen the leader must not cross, in pixels. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** How far the leader keeps from anything it passes, in pixels. */
const CLEAR = 7;

const crossesH = (y: number, xa: number, xb: number, b: Box, gap: number): boolean =>
  y > b.y0 - gap && y < b.y1 + gap && Math.max(xa, xb) > b.x0 - gap && Math.min(xa, xb) < b.x1 + gap;
const crossesV = (x: number, ya: number, yb: number, b: Box, gap: number): boolean =>
  x > b.x0 - gap && x < b.x1 + gap && Math.max(ya, yb) > b.y0 - gap && Math.min(ya, yb) < b.y1 + gap;

/**
 * The leader's route from the row's rail to the ring at the target's head, as right-angled runs that cross no pin:
 * out of the rail level for a stub, up or down the stub's column to a clear channel, along the channel to the
 * tower's line, then straight down onto the ring. Every channel between `top` and `bottom` is tried; the clear one
 * with the shortest run and the fewest turns wins, arriving from above before level and level before from below. Where no channel is clear (a wall of pins), the
 * one crossing fewest wins, and the pins' own ground covers the line where it passes under them.
 */
export function routeLeader(from: { x: number; y: number }, to: { x: number; y: number; r: number }, avoid: Box[], top: number, bottom: number): Array<[number, number]> {
  let best: Array<[number, number]> = [];
  let bestHits = Infinity;
  let bestCost = Infinity;
  const tryRoute = (xa: number, c: number): void => {
    const above = c < to.y;
    const level = Math.abs(c - to.y) < 0.5;
    // A channel just above or below the ring would arrive at its side, too close to read: only exactly level does.
    if (!level && Math.abs(c - to.y) < to.r + 14) return;
    const end: [number, number] = level ? [to.x - to.r, c] : [to.x, above ? to.y - to.r : to.y + to.r];
    const pts: Array<[number, number]> = [[from.x, from.y]];
    if (Math.abs(c - from.y) > 0.5) pts.push([xa, from.y], [xa, c]);
    if (level) pts.push(end);
    else pts.push([to.x, c], end);
    let hits = 0;
    for (const b of avoid) {
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        if (ay === by ? crossesH(ay, ax, bx, b, CLEAR) : crossesV(ax, ay, by, b, CLEAR)) {
          hits++;
          break;
        }
      }
    }
    const turns = pts.length - 2;
    // Onto the ring from above, through the sky, reads as a lock coming down on its target; from below the line
    // would climb the tower's own face, and level it would cut across the skyline: both cost more.
    const way = level ? 260 : above ? 0 : 520;
    const cost = Math.abs(c - from.y) + Math.abs(end[1] - c) + turns * 36 + (xa - from.x) + way;
    if (hits < bestHits || (hits === bestHits && cost < bestCost)) {
      best = pts;
      bestHits = hits;
      bestCost = cost;
    }
  };
  for (const xa of [from.x + 44, from.x + 76]) {
    tryRoute(xa, from.y);
    tryRoute(xa, to.y);
    for (let c = Math.ceil(top / 4) * 4; c <= bottom; c += 4) tryRoute(xa, c);
    if (bestHits === 0 && best.length <= 3) break;
  }
  return best;
}

/** An SVG path through the route's points, each corner cut at 45 degrees as an instrument's leader is drawn. */
export function routePath(pts: Array<[number, number]>, cut = 6): string {
  if (pts.length === 0) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i < pts.length - 1) {
      const [px, py] = pts[i - 1];
      const [nx, ny] = pts[i + 1];
      const r = Math.min(cut, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
      const ux = Math.sign(x - px);
      const uy = Math.sign(y - py);
      const vx = Math.sign(nx - x);
      const vy = Math.sign(ny - y);
      d += ` L${(x - ux * r).toFixed(1)},${(y - uy * r).toFixed(1)} L${(x + vx * r).toFixed(1)},${(y + vy * r).toFixed(1)}`;
    } else d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

/** A column of the stream: the brief's own names and figures read downward, a dot between, twice over so the loop is seamless. */
function streamColumn(words: string[], i: number): HTMLElement {
  const col = el('div', 'tg-stream-col');
  let s = '';
  for (let k = 0; s.length < 128; k++) {
    const w = words[(i * 5 + k * 3) % words.length].replace(/\s+/g, '').toUpperCase().slice(0, 14);
    s += `${w}\u00b7`;
  }
  const lines = [...s.slice(0, 64)].join('\n');
  col.textContent = `${lines}\n${lines}\n`;
  col.style.setProperty('--x', `${(i * 37) % 100}%`);
  col.style.setProperty('--t', `${38 + ((i * 17) % 29)}s`);
  col.style.setProperty('--d', `${-((i * 11) % 30)}s`);
  col.style.setProperty('--o', `${0.32 + ((i * 29) % 50) / 100}`);
  return col;
}

/** The stream behind the item list: a few columns, built once per open from the brief's own words. */
export function createStream(host: HTMLElement): { fill(seed: string[]): void } {
  const box = el('div', 'tg-stream');
  box.setAttribute('aria-hidden', 'true');
  host.prepend(box);
  let key = '';
  return {
    fill(seed) {
      const k = seed.join('|');
      if (k === key) return;
      key = k;
      const words = seed.length ? seed : ['0'];
      const cols: HTMLElement[] = [];
      for (let i = 0; i < 18; i++) cols.push(streamColumn(words, i));
      box.replaceChildren(...cols);
    },
  };
}

export function createHud(parent: HTMLElement, sheet: HTMLElement, scroller: HTMLElement, city: HudCity | undefined): Hud {
  const root = el('div', 'tg-hud');
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;
  // The pane's frame: four brackets at its corners, a heading tape along its top, the sweep, and the telemetry.
  const frame = el('div', 'tg-frame');
  for (const c of ['tl', 'tr', 'bl', 'br']) frame.append(el('span', `tg-corner ${c}`));
  const tape = el('div', 'tg-tape');
  const sweep = el('div', 'tg-sweep');
  const tele = el('div', 'tg-tele');
  const teleTrack = el('span', 'tg-tele-row');
  tele.append(teleTrack);
  frame.append(tape, sweep, tele);
  const pins = el('div', 'tg-pins');
  const lines = document.createElementNS(SVG, 'svg');
  lines.classList.add('tg-lines');
  const glow = document.createElementNS(SVG, 'path');
  glow.classList.add('tg-leader-glow');
  const leader = document.createElementNS(SVG, 'path');
  leader.classList.add('tg-leader');
  const leaderDot = document.createElementNS(SVG, 'circle');
  leaderDot.classList.add('tg-leader-dot');
  leaderDot.setAttribute('r', '2.5');
  lines.append(glow, leader, leaderDot);
  // The lock: four brackets that close on the tower, a turning ring at its head, and its readout.
  const lock = el('div', 'tg-lock');
  for (const c of ['tl', 'tr', 'bl', 'br']) lock.append(el('span', `tg-lock-c ${c}`));
  const ring = el('div', 'tg-lock-ring');
  const lockTag = el('div', 'tg-lock-tag');
  const lockN = el('span', 'tg-lock-n');
  const lockName = el('span', 'tg-lock-name');
  const lockFig = el('span', 'tg-lock-fig');
  lockTag.append(lockN, lockName, lockFig);
  lock.append(ring, lockTag);
  root.append(frame, lines, pins, lock);
  parent.append(root);

  let shown = false;
  let unhook: (() => void) | null = null;
  let live: Pin[] = [];
  let active: Target | null = null;
  let activeRow: HTMLElement | null = null;
  let paneLeft = 0;
  let frames = 0;
  let lockKey = '';
  let lockFlipped = false;
  let routeKey = '';
  /** The active row's middle, read only when the list scrolls or the lock moves, never in a frame that wrote. */
  let rowY: number | null = null;
  let rowDirty = true;
  scroller.addEventListener('scroll', () => {
    rowDirty = true;
  }, { passive: true });
  const p = { x: 0, y: 0, behind: false };
  const q = { x: 0, y: 0, behind: false };
  const at = new THREE.Vector3();
  const scratch = new THREE.Vector3();

  const measure = (): void => {
    paneLeft = Math.round(sheet.getBoundingClientRect().right);
    root.style.setProperty('--pane-left', `${paneLeft}px`);
  };

  function pinFor(repo: string, targets: Target[], quiet: boolean): Pin {
    const box = el('div', 'tg-pin');
    return { repo, targets, quiet, el: box, tag: null, w: 0, h: 0, frame: null, shown: false, lift: 0 };
  }

  function drawPin(pin: Pin): void {
    pin.w = 0;
    pin.h = 0;
    pin.el.classList.toggle('quiet', pin.quiet);
    if (pin.quiet) {
      // A district with nothing waiting: a small mark and its name, the city's own plate said in the HUD's voice.
      const tag = el('span', 'tg-pin-tag');
      tag.append(el('span', 'tg-pin-name', pin.repo.split('/').pop() ?? pin.repo));
      pin.tag = tag;
      delete pin.el.dataset.tone;
      pin.el.classList.remove('grant');
      pin.el.replaceChildren(el('span', 'tg-pin-mark'), tag);
      return;
    }
    const lead = pin.targets[0];
    pin.el.dataset.tone = lead.tone;
    pin.el.classList.toggle('grant', pin.targets.some((t) => t.grant));
    const tag = el('span', 'tg-pin-tag');
    tag.append(el('span', 'tg-pin-n', pin.targets.map((t) => pad2(t.n)).join(' ')), el('span', 'tg-pin-name', lead.name), el('span', 'tg-pin-fig', lead.figure));
    pin.tag = tag;
    pin.el.replaceChildren(el('span', 'tg-pin-mark'), tag);
  }

  /** The districts the quiet pins were drawn for, so a district built or pulled down redraws them. */
  let districtsKey = '';
  let targetsNow: Target[] = [];

  function refreshFrames(): void {
    if (!city) return;
    const key = city.districts().join('|');
    if (key !== districtsKey) placePins(targetsNow);
    for (const pin of live) {
      pin.frame = city.towerFrame(pin.repo);
      // Read here, every 90 frames before this frame's writes: a tag's size for the leader's router.
      if (!pin.w && pin.tag && shown) {
        pin.w = pin.tag.offsetWidth;
        pin.h = pin.tag.offsetHeight;
      }
    }
  }

  /** One pin per district with something waiting, then a quiet pin for each other district. */
  function placePins(targets: Target[]): void {
    targetsNow = targets;
    const byRepo = new Map<string, Target[]>();
    for (const t of targets) byRepo.set(t.repo, [...(byRepo.get(t.repo) ?? []), t]);
    const repos = city?.districts() ?? [];
    districtsKey = repos.join('|');
    const old = new Map(live.map((l) => [l.repo, l]));
    const next: Pin[] = [];
    const take = (repo: string, ts: Target[], quiet: boolean): void => {
      let pin = old.get(repo);
      old.delete(repo);
      if (!pin) pin = pinFor(repo, ts, quiet);
      const was = `${pin.quiet}|${JSON.stringify(pin.targets)}`;
      pin.targets = ts;
      pin.quiet = quiet;
      if (!pin.tag || was !== `${quiet}|${JSON.stringify(ts)}`) drawPin(pin);
      next.push(pin);
    };
    for (const [repo, ts] of byRepo) take(repo, ts, false);
    for (const repo of repos) if (!byRepo.has(repo)) take(repo, [], true);
    for (const gone of old.values()) gone.el.remove();
    pins.replaceChildren(...next.map((x) => x.el));
    live = next;
  }

  /** Places the pins, the lock and the leader for this frame: every read first, then every write. */
  function tick(): void {
    if (!city || !shown) return;
    if (frames++ % 90 === 0) refreshFrames();
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (rowDirty) {
      rowDirty = false;
      const r = activeRow?.isConnected ? activeRow.getBoundingClientRect() : null;
      const view = scroller.getBoundingClientRect();
      const y = r ? r.top + Math.min(r.height / 2, 34) : null;
      // A row scrolled out of the list has no leader: the lock stays, the line waits for the row.
      rowY = y !== null && y > view.top + 8 && y < view.bottom - 8 ? y : null;
    }
    const left = paneLeft + 18;
    let lockAt: { x: number; top: number; base: number; half: number } | null = null;
    /** The tags placed so far this frame: a tag that would overlap one is lifted above it. */
    const placed: Box[] = [];
    /** What the leader must keep clear of: every pin standing this frame but the locked one, mark, stem and tag. */
    const avoid: Box[] = [];
    // The lock first, so the pins stand clear of its tag (and the leader of the lock's tag as of any pin's).
    // The telemetry at the frame's foot (tg-tele) is a word the line must not run through either.
    avoid.push({ x0: paneLeft + 36, x1: paneLeft + 130, y0: h - 22 - 34, y1: h - 22 - 12 });
    const target = active ? live.find((l) => !l.quiet && l.repo === active!.repo) : undefined;
    if (target?.frame) {
      const f = target.frame;
      at.set(f.center.x, f.center.y + f.height / 2, f.center.z);
      projectToView(at, city.camera, w, h, p, scratch);
      at.set(f.center.x, f.center.y - f.height / 2, f.center.z);
      projectToView(at, city.camera, w, h, q, scratch);
      if (!p.behind && !q.behind && p.x > left && p.x < w - 24) {
        const tall = Math.max(24, q.y - p.y);
        const half = Math.max(16, Math.min(70, (tall * f.width) / Math.max(1, f.height) / 2 + 10));
        lockAt = { x: p.x, top: Math.max(78, p.y - 14), base: Math.min(h - 30, q.y + 6), half };
      }
    }
    const flip = lockAt ? lockAt.x + lockAt.half + 12 + LOCK_TAG_W > w - 28 : false;
    if (lockAt) {
      // The lock's own tag: right of its brackets, or up and to the left of the ring when flipped.
      const tagBox = flip
        ? { x0: lockAt.x - 14 - LOCK_TAG_W, x1: lockAt.x - 14, y0: lockAt.top - 80, y1: lockAt.top - 26 }
        : { x0: lockAt.x + lockAt.half + 12, x1: lockAt.x + lockAt.half + 12 + LOCK_TAG_W, y0: lockAt.top - 4, y1: lockAt.top + 52 };
      placed.push(tagBox, { x0: lockAt.x - 22, x1: lockAt.x + 22, y0: lockAt.top - 22, y1: lockAt.top + 22 });
      avoid.push(tagBox);
    }
    for (const pin of live) {
      const f = pin.frame;
      let show = false;
      if (f) {
        at.set(f.center.x, f.center.y + f.height / 2, f.center.z);
        projectToView(at, city.camera, w, h, p, scratch);
        at.set(f.center.x, f.center.y - f.height / 2, f.center.z);
        projectToView(at, city.camera, w, h, q, scratch);
        show = !p.behind && p.x > left && p.x < w - 24 && p.y > 84 && p.y < h - 40;
        if (show) {
          const tw = pin.w || (pin.quiet ? 90 : PIN_W - 10);
          const th = pin.h || (pin.quiet ? 18 : 36);
          const box = { x0: p.x - 7, x1: p.x + 10 + tw, y0: p.y - 12 - th, y1: p.y + 7 };
          const hit = (lift: number): boolean => placed.some((o) => box.x0 < o.x1 && o.x0 < box.x1 && box.y0 - lift < o.y1 && o.y0 < box.y1 - lift);
          let lift = 0;
          if (pin === target && lockAt) {
            // The locked pin gives way to the lock, which names its tower: it holds no room of its own.
          } else if (pin.quiet) {
            // A quiet pin never lifts: where it would cover a target's tag (or another quiet one), it waits.
            show = !hit(0);
          } else for (let k = 0; k < 4 && hit(lift); k++) lift += th + 14;
          if (show) {
            pin.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
            const b = { x0: box.x0, x1: box.x1, y0: box.y0 - lift, y1: box.y1 };
            if (pin !== target || !lockAt) {
              placed.push({ ...b, y1: box.y1 - lift });
              avoid.push(b);
            }
            if (pin.lift !== lift) {
              pin.lift = lift;
              pin.el.style.setProperty('--lift', `${lift}px`);
            }
          }
        }
      }
      if (show !== pin.shown) {
        pin.shown = show;
        pin.el.classList.toggle('on', show);
      }
    }
    if (lockAt) {
      lock.classList.add('on');
      lock.style.transform = `translate3d(${(lockAt.x - lockAt.half).toFixed(1)}px, ${lockAt.top.toFixed(1)}px, 0)`;
      lock.style.width = `${(lockAt.half * 2).toFixed(0)}px`;
      lock.style.height = `${(lockAt.base - lockAt.top).toFixed(0)}px`;
      if (flip !== lockFlipped) {
        lockFlipped = flip;
        lock.classList.toggle('flip', flip);
      }
      if (rowY !== null) {
        const y0 = Math.round(Math.min(Math.max(rowY, 90), h - 30));
        const x0 = paneLeft + 2;
        // Out of the rail level, then right-angled runs through clear channels to the ring: the line names the target
        // and crosses no other pin. Routed again only when something it avoids has moved by a pixel.
        const key = `${x0}|${y0}|${Math.round(lockAt.x)}|${Math.round(lockAt.top)}|${avoid.map((b) => `${Math.round(b.x0)},${Math.round(b.y0)},${Math.round(b.x1)},${Math.round(b.y1)}`).join(';')}`;
        if (key !== routeKey) {
          routeKey = key;
          const pts = routeLeader({ x: x0, y: y0 }, { x: Math.round(lockAt.x), y: Math.round(lockAt.top), r: 21 }, avoid, 88, h - 30);
          const d = routePath(pts);
          leader.setAttribute('d', d);
          glow.setAttribute('d', d);
          const end = pts[pts.length - 1];
          leaderDot.setAttribute('cx', end[0].toFixed(1));
          leaderDot.setAttribute('cy', end[1].toFixed(1));
        }
        lines.classList.add('on');
      } else lines.classList.remove('on');
    } else {
      lock.classList.remove('on');
      lines.classList.remove('on');
    }
  }

  function drawActive(): void {
    const k = active ? `${active.id}|${active.figure}` : '';
    if (k === lockKey) return;
    lockKey = k;
    lock.classList.toggle('grant', !!active?.grant);
    lines.classList.toggle('grant', !!active?.grant);
    lockN.textContent = active ? pad2(active.n) : '';
    lockName.textContent = active?.name ?? '';
    lockFig.textContent = active?.figure ?? '';
    // The brackets close in again on each new lock.
    lock.classList.remove('acquire');
    void lock.offsetWidth;
    lock.classList.add('acquire');
    for (const pin of live) pin.el.classList.toggle('locked', !!active && pin.repo === active.repo);
  }

  const onResize = (): void => {
    measure();
    rowDirty = true;
  };

  return {
    show() {
      if (shown) return;
      shown = true;
      root.hidden = false;
      // One set of labels: the city's own plates fade while the HUD names the towers, and come back when it closes.
      document.documentElement.dataset.tgHud = 'on';
      measure();
      requestAnimationFrame(() => {
        measure();
        root.classList.add('open');
      });
      window.addEventListener('resize', onResize);
      if (city) unhook = city.onFrame(tick);
    },
    hide() {
      if (!shown) return;
      shown = false;
      root.classList.remove('open');
      root.hidden = true;
      delete document.documentElement.dataset.tgHud;
      routeKey = '';
      window.removeEventListener('resize', onResize);
      unhook?.();
      unhook = null;
      active = null;
      activeRow = null;
      lockKey = '';
    },
    setTargets(targets) {
      placePins(targets);
      teleTrack.textContent = `track ${pad2(targets.length)}`;
      refreshFrames();
      lockKey = '';
      drawActive();
    },
    setActive(id, row) {
      const t = id ? live.flatMap((l) => l.targets).find((x) => x.id === id) ?? null : null;
      active = t;
      activeRow = t ? row : null;
      rowDirty = true;
      drawActive();
    },
  };
}
